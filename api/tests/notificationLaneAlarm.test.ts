import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Two operator-facing guarantees of the evaluator loop:
//   * a failure is logged by error CLASS and CODE plus a group digest — never the
//     exception's message, which can quote a query carrying rule parameters;
//   * a lane that keeps failing, or whose cursor falls far behind its anchor,
//     raises one alarm (one log line, a status flag) and clears it once.

const SECRET = 'secret-param=hunter2'
let failAddress: string | null = null
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return {
    ...actual,
    getAddressActivity: async (address: string) => {
      if (failAddress != null && address === failAddress) {
        const err = new Error(`Code: 131. DB::Exception: Field value too long: SELECT … WHERE account = '${address}' AND ${SECRET}`) as Error & { code: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return []
    },
  }
})

import {
  cursorKey, describeError, evaluatorCounters, evaluatorStatus, initEvaluator, LANE_ALARM_BEHIND_BLOCKS,
  LANE_ALARM_FAILURES, laneAlarmStatus, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import { createRule, initNotifications, loadNotifications, setNotificationState } from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { fakeClient, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const WATCHED = '0x' + '01'.repeat(20)

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[]; raw_events: never[]; raw_extrinsics: never[]; referendum_lifecycle_events: never[] }
let errorLog: ReturnType<typeof vi.spyOn>

const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }
const logged = (): string[] => errorLog.mock.calls.map((args: unknown[]) => args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '))
const alarmLines = () => logged().filter(l => l.includes('lane alarm'))

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  failAddress = null
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await stopNotificationEvaluator()
  errorLog.mockRestore()
})

describe('describeError', () => {
  it('names the class and machine codes, never the message', () => {
    const err = Object.assign(new Error(`SELECT * WHERE who = '${WATCHED}' ${SECRET}`), { code: 'ECONNRESET' })
    expect(describeError(err)).toBe('Error code=ECONNRESET')
    class ClickHouseError extends Error { code = '60'; type = 'UNKNOWN_TABLE' }
    expect(describeError(new ClickHouseError(SECRET))).toBe('ClickHouseError code=60 type=UNKNOWN_TABLE')
    expect(describeError(new TypeError(SECRET))).toBe('TypeError')
  })

  it('drops a code field that could carry a value', () => {
    expect(describeError(Object.assign(new Error('x'), { code: WATCHED }))).toBe('Error')
    expect(describeError(Object.assign(new Error('x'), { code: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }))).toBe('Error')
    expect(describeError(Object.assign(new Error('x'), { type: SECRET }))).toBe('Error')
    expect(describeError(SECRET)).toBe('string')
    expect(describeError(null)).toBe('object')
  })
})

describe('source-group failure log', () => {
  it('logs class, code and a group digest — not the message, the target or the params — and counts each failure as an error', async () => {
    await createRule(OWNER, { kind: 'account-activity', params: { address: WATCHED } })
    await runEvaluatorTick()                       // seeds at 1000
    failAddress = WATCHED
    setHead(1_010)
    const before = evaluatorCounters().errors
    await runEvaluatorTick()
    expect(evaluatorCounters().errors).toBe(before + 1)
    expect(evaluatorCounters().failedGroups).toBe(1)

    const lines = logged()
    const failure = lines.find(l => l.includes('source groups failed'))
    expect(failure).toMatch(/^\[notifications\] account-activity: 1 of 1 source groups failed this tick and stay unvisited \(first group #[0-9a-f]{12}\): Error code=ECONNRESET$/)
    for (const line of lines) {
      expect(line).not.toContain('hunter2')
      expect(line).not.toContain(WATCHED)
      expect(line.toLowerCase()).not.toContain(WATCHED.slice(2, 12))
      expect(line).not.toContain('DB::Exception')
    }
  })

  it('logs a thrown lane by class only', async () => {
    await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await setNotificationState(cursorKey('event'), '1000')
    setHead(1_010)
    initEvaluator({ ...client, query: async (q: { query: string }) => {
      if (q.query.includes('event_name')) throw new Error(`Unknown identifier in SELECT … '${SECRET}'`)
      return client.query(q as never)
    } } as unknown as FakeClient)
    await runEvaluatorTick()
    expect(logged()).toContain('[notifications] event lane failed: Error')
    expect(logged().join('\n')).not.toContain('hunter2')
  })
})

describe('lane alarm', () => {
  // The event lane's own read fails; the head and the watermark still answer.
  const breakEventSource = () => initEvaluator({ ...client, query: async (q: { query: string }) => {
    if (q.query.includes('event_name')) throw new Error(SECRET)
    return client.query(q as never)
  } } as unknown as FakeClient)

  it('raises once after N consecutive failed ticks, holds without repeating, and clears once', async () => {
    await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await setNotificationState(cursorKey('event'), '1000')
    breakEventSource()
    for (let i = 1; i < LANE_ALARM_FAILURES; i++) { setHead(1_000 + i); await runEvaluatorTick() }
    expect(laneAlarmStatus().active).toBe(false)
    expect(alarmLines()).toHaveLength(0)

    setHead(1_000 + LANE_ALARM_FAILURES)
    await runEvaluatorTick()
    const status = evaluatorStatus().laneAlarm
    expect(status).toEqual({
      active: true,
      failureThreshold: LANE_ALARM_FAILURES,
      behindThresholdBlocks: LANE_ALARM_BEHIND_BLOCKS,
      lanes: [{ lane: 'cursor:event', consecutiveFailures: LANE_ALARM_FAILURES, behind: LANE_ALARM_FAILURES, since: expect.any(String) }],
    })
    expect(Object.keys(status.lanes[0]).sort()).toEqual(['behind', 'consecutiveFailures', 'lane', 'since'])
    expect(Number.isNaN(Date.parse(status.lanes[0].since))).toBe(false)
    expect(alarmLines()).toEqual([
      `[notifications] lane alarm raised: cursor:event consecutiveFailures=${LANE_ALARM_FAILURES} behind=${LANE_ALARM_FAILURES} (thresholds: ${LANE_ALARM_FAILURES} failures, ${LANE_ALARM_BEHIND_BLOCKS} blocks)`,
    ])

    // Still failing: the streak grows, the since-time and the log stay put.
    setHead(1_010)
    await runEvaluatorTick()
    expect(laneAlarmStatus().lanes[0].consecutiveFailures).toBe(LANE_ALARM_FAILURES + 1)
    expect(laneAlarmStatus().lanes[0].since).toBe(status.lanes[0].since)
    expect(alarmLines()).toHaveLength(1)

    // Recovered: one clear line, flag down.
    initEvaluator(client)
    setHead(1_011)
    await runEvaluatorTick()
    expect(evaluatorStatus().laneAlarm).toEqual({ active: false, failureThreshold: LANE_ALARM_FAILURES, behindThresholdBlocks: LANE_ALARM_BEHIND_BLOCKS, lanes: [] })
    expect(alarmLines()).toHaveLength(2)
    expect(alarmLines()[1]).toMatch(/^\[notifications\] lane alarm cleared: cursor:event consecutiveFailures=0 behind=0 \(alarmed \d+s\)$/)
    setHead(1_012)
    await runEvaluatorTick()
    expect(alarmLines()).toHaveLength(2)
  })

  it('counts a tick with an unreadable head as a failure for every active lane', async () => {
    await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await setNotificationState(cursorKey('event'), '1000')
    initEvaluator({ ...client, query: async () => { throw new Error(SECRET) } } as unknown as FakeClient)
    for (let i = 0; i < LANE_ALARM_FAILURES; i++) await runEvaluatorTick()
    expect(laneAlarmStatus().lanes.map(l => [l.lane, l.consecutiveFailures])).toEqual([['cursor:event', LANE_ALARM_FAILURES]])
    expect(logged().join('\n')).not.toContain('hunter2')
  })

  it('raises on a cursor held far behind the head with no failure, and clears only well inside the threshold', async () => {
    await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await setNotificationState(cursorKey('event'), '1000')
    // The watermark lags: the lane may not advance past what its source holds.
    client.sourceHead = 1_000
    setHead(1_000 + LANE_ALARM_BEHIND_BLOCKS)
    await runEvaluatorTick()
    expect(laneAlarmStatus().active).toBe(false)
    setHead(1_001 + LANE_ALARM_BEHIND_BLOCKS)
    await runEvaluatorTick()
    expect(laneAlarmStatus().lanes).toEqual([{ lane: 'cursor:event', consecutiveFailures: 0, behind: LANE_ALARM_BEHIND_BLOCKS + 1, since: expect.any(String) }])

    // Back under the threshold but not under half of it: still alarmed (hysteresis).
    client.sourceHead = 1_001 + Math.floor(LANE_ALARM_BEHIND_BLOCKS / 4)
    await runEvaluatorTick()
    expect(laneAlarmStatus().active).toBe(true)
    expect(alarmLines()).toHaveLength(1)

    client.sourceHead = undefined
    await runEvaluatorTick()
    expect(laneAlarmStatus().active).toBe(false)
    expect(alarmLines()).toHaveLength(2)
  })

  it('does not watch an idle lane, and clears an alarm when its last rule goes', async () => {
    const rule = await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await setNotificationState(cursorKey('event'), '1000')
    breakEventSource()
    for (let i = 0; i < LANE_ALARM_FAILURES; i++) { setHead(1_001 + i); await runEvaluatorTick() }
    expect(laneAlarmStatus().active).toBe(true)
    const { deleteRule } = await import('../src/notifications/notificationStore.ts')
    await deleteRule(OWNER, rule.ruleId)
    await runEvaluatorTick()
    expect(laneAlarmStatus().active).toBe(false)
    expect(alarmLines().at(-1)).toMatch(/^\[notifications\] lane alarm cleared: cursor:event has no active rules/)
  })
})

// A source-group key is a rule parameter from a small public set (accounts, asset
// ids): an unkeyed hash of it is reversed by hashing every candidate, so the logged
// digest is an HMAC under a key the log does not carry.
describe('logged group digest', () => {
  it('is keyed: not the plain sha256 of the key, stable within a process', async () => {
    const { createHash } = await import('node:crypto')
    const { groupDigest } = await import('../src/notifications/evaluator.ts')
    const key = '0x' + 'ab'.repeat(32)
    const plain = createHash('sha256').update(`account-activity:${key}`).digest('hex').slice(0, 12)
    expect(groupDigest('account-activity', key)).not.toBe(plain)
    expect(groupDigest('account-activity', key)).toBe(groupDigest('account-activity', key))
    expect(groupDigest('account-activity', key)).toMatch(/^[0-9a-f]{12}$/)
  })
})
