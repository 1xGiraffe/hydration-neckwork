import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The lanes' own wiring: which source each kind reads, how many times it reads
// it, and what its cursor is allowed to do afterwards. The two shared sources
// (the security dashboard, the activity feed) are replaced by controllable stubs,
// because both invariants under test are about the SOURCE's behaviour rather
// than the chain's — a cached snapshot that lags the head, and a query count
// that must not scale with the number of rules.

const timeline: { kind: string; label: string; detail: string; blockHeight: number; blockTimestamp: string; extrinsicIndex: number | null; asset: null }[] = []
vi.mock('../src/services/securityService.ts', () => ({
  getSecurityDashboard: async () => ({ timeline: [...timeline] }),
}))

interface ActivityCall { kind: 'address' | 'recent'; address?: string; type?: string; action?: string; filters?: Record<string, unknown> }
const activityCalls: ActivityCall[] = []
let activityRows: Record<string, unknown>[] = []
vi.mock('../src/services/explorerService.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/explorerService.ts')>()
  return {
    ...actual,
    getAddressActivity: async (address: string, type: string, _limit: number, _offset: number, action?: string, filters?: Record<string, unknown>) => {
      activityCalls.push({ kind: 'address', address, type, action, filters })
      return activityRows
    },
    getRecentActivity: async (_limit: number, _from?: string, _to?: string, _offset = 0, type = 'all', filters: Record<string, unknown> = {}) => {
      activityCalls.push({ kind: 'recent', type, filters })
      return activityRows
    },
    getPrimaryHealthFactor: async (address: string) => {
      healthFactorCalls.push(address)
      return healthFactors.get(address) ?? null
    },
  }
})
const healthFactorCalls: string[] = []
const healthFactors = new Map<string, number | null>()

import {
  cursorKey, evaluatorCounters, evaluatorCursors, initEvaluator, resetEvaluatorForTests, runEvaluatorTick,
  stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, initNotifications, loadNotifications, setNotificationState,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

const OWNER = '0x' + 'aa'.repeat(32)
const ADDRESSES = [
  '15DajYeqgb4ADkb8scVCcNaXjfM1SV9PLvqjNDkpH6kBDRLZ',
  '13QPUtNGb84S8QTs5CjRfHNGjxeuPFyfXBFcYaHqweUmzHZJ',
  '165HvUcgi1uSzhkiMSb63LCcy5oNP4a8JbeqAKgKxxWLcJXH',
]

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[]; raw_events: never[]; raw_extrinsics: never[]; referendum_lifecycle_events: never[] }

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }

const safetyEvent = (blockHeight: number) => ({
  kind: 'freeze', label: `Tradability set at ${blockHeight}`, detail: '2-Pool → Frozen',
  blockHeight, blockTimestamp: '2026-08-18 10:00:00', extrinsicIndex: 1, asset: null,
})

const trade = (blockHeight: number, eventIndex: number, valueUsd: number, assetId = 0): Record<string, unknown> => ({
  type: 'trade', blockHeight, timestamp: '2026-08-18 10:00:00', eventIndex, extrinsicIndex: 1,
  who: null, to: null, asset: null,
  assetIn: { assetId, iconAssetId: assetId, symbol: 'HDX', name: 'HDX', decimals: 12, parachainId: null, origin: null },
  assetOut: { assetId: 10, iconAssetId: 10, symbol: 'USDT', name: 'USDT', decimals: 6, parachainId: null, origin: null },
  amount: null, amountIn: '1000000000000000', amountOut: '25000000', valueUsd,
} satisfies Partial<ActivityRow> as unknown as Record<string, unknown>)

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  timeline.length = 0
  activityCalls.length = 0
  activityRows = []
  healthFactorCalls.length = 0
  healthFactors.clear()
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
})

afterEach(async () => { await stopNotificationEvaluator() })

/* ============ safety: a cursor anchored on what the snapshot showed ============ */

describe('safety lane cursor', () => {
  const watchSafety = () => createRule(OWNER, { kind: 'safety', params: {} })

  it('seeds at the newest action the timeline holds, not at the live head', async () => {
    await watchSafety()
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()
    expect(evaluatorCursors().safety).toBe(900)
    expect(inbox()).toHaveLength(0)
  })

  // The regression this lane exists for: getSecurityDashboard is cached 20s
  // fresh / 120s stale on a key with no head in it, so several ticks in a row
  // see the SAME snapshot while the chain head runs ahead. A head-anchored
  // cursor stepped over every action that appeared in between — the lane could
  // never fire once it was warm.
  it('fires exactly once when a stale snapshot finally reveals a new action', async () => {
    await watchSafety()
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()                       // seeds at 900

    // Two ticks of the same cached snapshot while the head advances.
    for (const head of [1_050, 1_100]) { setHead(head); await runEvaluatorTick() }
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().safety).toBe(900)

    // The cache refreshes and the action is finally visible.
    timeline.push(safetyEvent(1_020))
    setHead(1_150)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].block_height).toBe(1_020)
    expect(evaluatorCursors().safety).toBe(1_020)

    // The same snapshot on later ticks is not news.
    for (const head of [1_200, 1_250]) { setHead(head); await runEvaluatorTick() }
    expect(inbox()).toHaveLength(1)
  })

  it('keeps the blind spot below the cursor, so a backfilled action stays silent', async () => {
    await watchSafety()
    timeline.push(safetyEvent(1_000))
    await runEvaluatorTick()                       // seeds at 1000
    // A repair INSERT surfaces an action from last year.
    timeline.unshift(safetyEvent(12))
    setHead(1_100)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().safety).toBe(1_000)
  })

  it('adopts the legacy single cursor on an upgrade in place', async () => {
    await watchSafety()
    // The legacy cursor sat at the head, so everything the timeline already held
    // is history under it — which is what a seed means either way.
    await setNotificationState('cursor:raw-live', '1000')
    timeline.push(safetyEvent(900))
    setHead(1_000)
    await runEvaluatorTick()
    expect(evaluatorCursors().safety).toBe(1_000)
    expect(inbox()).toHaveLength(0)
  })
})

/* ============ activity sources: one fetch per address, one per asset ============ */

describe('activity source fan-out', () => {
  it('fetches once per watched ADDRESS however many rules watch it', async () => {
    // Nine rules, three addresses, every filter combination: three fetches.
    for (const address of ADDRESSES) {
      await createRule(OWNER, { kind: 'account-activity', params: { address } })
      await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade' } })
      await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade', minUsd: 10_000 } })
    }
    await runEvaluatorTick()                       // seeds
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(3)
    expect(new Set(activityCalls.map(c => c.address))).toEqual(new Set(ADDRESSES))
    // The group asks the widest question; each rule's own filter is re-applied
    // by the matcher over the shared page.
    expect(activityCalls.every(c => c.type === 'all' && c.action === undefined)).toBe(true)
    expect(activityCalls.every(c => Object.keys(c.filters ?? {}).length === 0)).toBe(true)
  })

  // A floor the whole group shares can be pushed into the query without hiding a
  // match, which keeps a busy address from saturating the page.
  it('fetches at the group\'s lowest floor when every rule has one', async () => {
    const address = ADDRESSES[0]
    await createRule(OWNER, { kind: 'account-activity', params: { address, minUsd: 50_000 } })
    await createRule(OWNER, { kind: 'account-activity', params: { address, type: 'trade', minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(1)
    expect(activityCalls[0].filters).toEqual({ min: 1_000, unit: 'usd' })
  })

  it('re-applies each rule\'s own filters to the shared page', async () => {
    const address = ADDRESSES[0]
    const everything = await createRule(OWNER, { kind: 'account-activity', params: { address } })
    const big = await createRule(OWNER, { kind: 'account-activity', params: { address, minUsd: 10_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityRows = [trade(1_005, 1, 25), trade(1_006, 2, 50_000)]
    await runEvaluatorTick()
    const byRule = new Map<string, number>()
    for (const row of inbox()) byRule.set(String(row.rule_id), (byRule.get(String(row.rule_id)) ?? 0) + 1)
    expect(byRule.get(everything.ruleId)).toBe(2)
    expect(byRule.get(big.ruleId)).toBe(1)
  })

  it('fetches once per ASSET at the lowest floor, plus one chain-wide group', async () => {
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 5_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 100_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 250, assetId: 10 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 9_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(3)
    expect(activityCalls.map(c => c.filters).sort((a, b) => Number(a?.min) - Number(b?.min))).toEqual([
      { min: 250, unit: 'usd', token: '10' },
      { min: 1_000, unit: 'usd' },
      { min: 5_000, unit: 'usd', token: '0' },
    ])
  })

  // The cap bounds one tick; the rotation is what keeps the groups it skipped
  // from starving, and the held cursor is what keeps them from losing rows.
  it('caps fetches per tick, rotates over the rest, and holds the cursor until every group is seen', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`)
    for (const address of many) await createRule(OWNER, { kind: 'account-activity', params: { address } })
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_010)

    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(25)
    expect(evaluatorCounters().deferredGroups).toBe(5)
    // Five groups have not seen (1000, 1010] yet, so the cursor waits for them.
    expect(evaluatorCursors()['account-activity']).toBe(1_000)

    const firstPass = new Set(activityCalls.map(c => c.address))
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls).toHaveLength(25)
    // The rotation resumed where it stopped, so the deferred five came first.
    const secondPass = activityCalls.slice(0, 5).map(c => String(c.address))
    expect(secondPass.some(a => firstPass.has(a))).toBe(false)
    expect(new Set([...firstPass, ...secondPass]).size).toBe(30)
  })

  // The two value-floor kinds read the SAME feed under different types, so a
  // shared group key would have handed transfer rules a page of trades. Each
  // kind groups, rotates and spends its budget on its own.
  it('keeps the trade and transfer feeds on separate fetches', async () => {
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 5_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 100_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 20_000, assetId: 0 } })
    await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    // One trade fetch, and two transfer fetches (one asset group at the lower of
    // its two floors, one chain-wide) — never a shared one.
    expect(activityCalls).toHaveLength(3)
    expect(activityCalls.map(c => c.type).sort()).toEqual(['trade', 'transfer', 'transfer'])
    expect(activityCalls.filter(c => c.type === 'transfer').map(c => c.filters)
      .sort((a, b) => Number(a?.min) - Number(b?.min))).toEqual([
      { min: 1_000, unit: 'usd' },
      { min: 20_000, unit: 'usd', token: '0' },
    ])
  })

  it('fires each kind from its own feed and holds its own cursor', async () => {
    const trades = await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    const transfers = await createRule(OWNER, { kind: 'large-transfer', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityRows = [trade(1_005, 1, 25_000)]
    await runEvaluatorTick()
    // The stub answers both feeds with the same rows, so both rules match once —
    // which is exactly what proves each kind ran its own lane.
    expect(new Set(inbox().map(r => String(r.rule_id)))).toEqual(new Set([trades.ruleId, transfers.ruleId]))
    expect(evaluatorCursors()['large-transfer']).toBe(1_010)
    expect(evaluatorCursors()['large-trade']).toBe(1_010)
  })

  // The cap is per kind: the row lane visits the kinds in a fixed order, and a
  // budget the first one could exhaust would starve the second forever.
  it('does not let a saturated kind starve the next one', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`)
    for (const address of many) await createRule(OWNER, { kind: 'account-activity', params: { address } })
    await createRule(OWNER, { kind: 'large-trade', params: { minUsd: 1_000 } })
    await runEvaluatorTick()
    setHead(1_010)
    activityCalls.length = 0
    await runEvaluatorTick()
    expect(activityCalls.filter(c => c.kind === 'address')).toHaveLength(25)
    expect(activityCalls.filter(c => c.kind === 'recent')).toHaveLength(1)
  })
})

/* ============ health factor: one lookup per address ============ */

describe('health-factor lane', () => {
  it('reads one health factor per address, not one per rule', async () => {
    healthFactors.set(ADDRESSES[0], 2)
    healthFactors.set(ADDRESSES[1], 3)
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.1 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.5 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[1], threshold: 1.1 } })
    await runEvaluatorTick()
    expect(healthFactorCalls.sort()).toEqual([ADDRESSES[0], ADDRESSES[1]].sort())
  })

  it('fires every rule whose threshold the shared value crossed', async () => {
    healthFactors.set(ADDRESSES[0], 2)
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.1 } })
    await createRule(OWNER, { kind: 'health-factor', params: { address: ADDRESSES[0], threshold: 1.5 } })
    await runEvaluatorTick()                       // arms both
    healthFactors.set(ADDRESSES[0], 1.2)
    setHead(1_030)
    for (let i = 0; i < 5; i++) await runEvaluatorTick()
    // Only the 1.5 rule crossed; the 1.1 one is still armed.
    expect(inbox()).toHaveLength(1)
    expect(String(inbox()[0].title)).toContain('Health factor 1.2')
  })
})

// The cursor key is per kind; nothing may share one, or one lane's progress
// would silence another's window.
describe('cursor keys', () => {
  it('names one state key per row-lane kind', () => {
    expect(cursorKey('event')).toBe('cursor:event')
    expect(cursorKey('safety')).toBe('cursor:safety')
    expect(cursorKey('account-activity')).toBe('cursor:account-activity')
  })
})
