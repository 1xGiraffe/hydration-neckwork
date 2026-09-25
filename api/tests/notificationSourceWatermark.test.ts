import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evaluatorCursors, groupsCoveredTo, initEvaluator, resetEvaluatorForTests, resolveWindow, runEvaluatorTick,
  stopNotificationEvaluator, windowCoveredTo,
} from '../src/notifications/evaluator.ts'
import { createRule, initNotifications, loadNotifications } from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// The cursor is anchored on the raw ingestion head, but the activity feed a lane
// reads is keyed and built on its own head — `indexedRawHead` (all pipelines, a
// 1.5s cache, plus an SSE-published floor) rather than the evaluator's own
// `queryLiveHead` (raw-live, uncached). ClickHouse has no cross-insert ordering
// either, so `raw_ingestion_state` can name a block whose event rows are not yet
// visible.
//
// Advancing the cursor to a block the source could not have shown is a permanent
// loss: the window only moves forward. Measured live 2026-08-20 — the lane
// evaluated (13706246, 13706261], the page's newest qualifying row was still
// 13706219, and the $1,091.96 swap in block 13706258 was never seen again.
//
// So a lane advances only as far as its SOURCE has demonstrably reached.
describe('the cursor a feed-backed lane may advance to', () => {
  const window = { from: 100, to: 200 }

  it('is the whole window when the source has reached past it', () => {
    expect(windowCoveredTo(window, 250)).toBe(200)
  })

  it('stops at the source when the source lags inside the window', () => {
    // Blocks 151..200 are not visible yet: hold the cursor so they are re-read.
    expect(windowCoveredTo(window, 150)).toBe(150)
  })

  it('never regresses below the window it started from', () => {
    expect(windowCoveredTo(window, 50)).toBe(100)
    expect(windowCoveredTo(window, 0)).toBe(100)
  })

  it('leaves the clamped remainder for the next window to re-read', () => {
    const covered = windowCoveredTo(window, 150)
    const next = resolveWindow(covered, 260)

    // The blocks the source had not revealed are still above the new cursor.
    expect(next.window.from).toBe(150)
    expect(next.skipped).toBe(0)
  })
})

// A lane that rotates over source groups under a per-tick fetch cap asks only
// some of them each tick. Holding the lane while ANY group was deferred froze
// the account-activity cursor for nine days once the watched targets outnumbered
// the cap (every tick deferred one). The lane instead stands at the oldest block
// any of its current groups has been read up to.
describe('the cursor a lane rotating over source groups may advance to', () => {
  const groups = (all: string[], visited: string[]) => ({ all, visited })

  it('holds where it was while any group has never been read', () => {
    const seen = new Map<string, number>()
    expect(groupsCoveredTo(seen, groups(['a', 'b'], ['a']), 200, 100)).toBe(100)
    // The group that was read is vouched for, so the next rotation can release.
    expect(seen.get('a')).toBe(200)
  })

  it('stands at the oldest block any group was read up to once all have been', () => {
    const seen = new Map([['a', 200]])
    expect(groupsCoveredTo(seen, groups(['a', 'b'], ['b']), 250, 100)).toBe(200)
    // The rotation comes back to a; the floor moves with the slowest group.
    expect(groupsCoveredTo(seen, groups(['a', 'b'], ['a']), 300, 200)).toBe(250)
    expect(groupsCoveredTo(seen, groups(['a', 'b'], ['b']), 320, 250)).toBe(300)
  })

  it('stops waiting for a group whose rules are gone', () => {
    // c was deferred on every tick so far; its last rule is deleted.
    const seen = new Map([['a', 200], ['c', 150]])
    expect(groupsCoveredTo(seen, groups(['a'], []), 250, 100)).toBe(200)
    expect(seen.has('c')).toBe(false)
  })

  it('advances no further than this tick’s window vouches for, and never regresses', () => {
    // An earlier tick read a to 300; this one's watermark only vouches for 250.
    const seen = new Map([['a', 300]])
    expect(groupsCoveredTo(seen, groups(['a'], ['a']), 250, 250)).toBe(250)
    expect(seen.get('a')).toBe(300)
    // No groups at all: the window itself.
    expect(groupsCoveredTo(new Map(), groups([], []), 250, 100)).toBe(250)
  })
})

// The clamp only protects a lane that applies it, and the loss it prevents is
// silent — no error, no log line, an advancing cursor. Every lane re-typing the
// same line is what let six of the seven read the watermark AFTER their own
// source query, which is not a clamp at all: the blocks that land while a lane
// spends seconds in its source then count as covered by a page that could not
// have held them. So no lane names its own cursor any more — it returns the
// window it matched and the tick derives the cursor once.
describe('the clamp lives in exactly one place', () => {
  const evaluator = readFileSync(new URL('../src/notifications/evaluator.ts', import.meta.url), 'utf8')
  const laneBody = evaluator.slice(
    evaluator.indexOf('async function runKindLane'),
    evaluator.indexOf('async function safetyLane'))
  const tickBody = evaluator.slice(
    evaluator.indexOf('export async function runEvaluatorTick'),
    evaluator.indexOf('async function guard('))

  it('is the function under test', () => {
    expect(laneBody).toContain('switch (kind)')
    // Every row-window kind resolves here, so a new one cannot dodge the rule.
    for (const kind of ['account-activity', 'large-trade', 'protocol-revenue', 'referendum', 'tc-motion', 'event']) {
      expect(laneBody, kind).toContain(`case '${kind}'`)
    }
  })

  it('lets no lane name the cursor it advances to', () => {
    expect(laneBody).not.toContain('nextCursor')
  })

  it('keeps the watermark read out of the lanes entirely', () => {
    // Inside a lane the read is worthless: it happens after the source query.
    expect(laneBody).not.toContain('visibleSourceHead')
    expect(evaluator.match(/await visibleSourceHead\(\)/g) ?? []).toHaveLength(1)
  })

  it('reads the watermark once per tick, before the lanes run', () => {
    expect(tickBody).toContain('const sourceHead = await visibleSourceHead()')
    expect(tickBody.indexOf('visibleSourceHead')).toBeLessThan(tickBody.indexOf('runKindLane'))
  })
})

/* ============ the same invariant, driven through a tick ============ */

const OWNER = '0x' + 'cc'.repeat(32)
const swapAt = (block: number) =>
  ({ block_height: block, event_index: 1, extrinsic_index: 0, event_name: 'Omnipool.SellExecuted' })

let client: FakeClient
let tables: { raw_ingestion_state: { head: number }[]; raw_events: Record<string, unknown>[] }
let queries: string[]

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }
const isWatermark = (q: string) => q.trim() === 'SELECT max(block_height) AS head FROM price_data.raw_events'
const isLaneRead = (q: string) => q.includes('event_name')

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  queries = []
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  // Every query the evaluator makes, in order.
  initEvaluator({
    ...client,
    query: async (args: { query: string }) => { queries.push(args.query); return client.query(args as never) },
  } as unknown as FakeClient)
  await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
})

afterEach(async () => { await stopNotificationEvaluator() })

describe('a tick’s source watermark', () => {
  it('is read exactly once, and before the lane reads its source', async () => {
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_010)
    tables.raw_events = [swapAt(1_010)]
    queries = []
    await runEvaluatorTick()

    expect(queries.filter(isWatermark)).toHaveLength(1)
    expect(queries.findIndex(isWatermark)).toBeLessThan(queries.findIndex(isLaneRead))
  })

  it('holds the cursor at the blocks it cannot vouch for', async () => {
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_010)
    // The ingestion head names 1010, but only 1005's rows have landed.
    client.sourceHead = 1_005
    tables.raw_events = [swapAt(1_002)]
    await runEvaluatorTick()

    expect(inbox().map(r => r.block_height)).toEqual([1_002])
    expect(evaluatorCursors().event).toBe(1_005)
  })

  // An unreadable watermark is not permission to advance to the ingestion head:
  // that is precisely the step that loses rows, and holding costs a re-read.
  it('holds the cursor when the watermark cannot be read at all', async () => {
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_010)
    client.sourceHead = null
    await runEvaluatorTick()
    expect(evaluatorCursors().event).toBe(1_000)

    client.sourceHead = undefined
    await runEvaluatorTick()
    expect(evaluatorCursors().event).toBe(1_010)
  })
})
