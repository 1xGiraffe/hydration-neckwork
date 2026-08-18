import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  cursorKey, evaluatorCounters, evaluatorCursors, initEvaluator, notificationIdFor,
  resetEvaluatorForTests, runEvaluatorTick, startNotificationEvaluator, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, getNotificationState, initNotifications, loadNotifications,
  setNotificationState, updateRule, upsertTelegramChannel,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// The loop around the pure matchers: where the cursor comes from, when it moves,
// and what one tick is allowed to send. Every source is a fake table, so these
// are the wiring invariants — no chain, no network.

const OWNER = '0x' + 'aa'.repeat(32)
// Cursors are per kind; these tests drive the `event` lane.
const CURSOR = cursorKey('event')
const LEGACY_CURSOR = 'cursor:raw-live'

interface EventRow { block_height: number; event_index: number; extrinsic_index: number | null; event_name: string }
interface Tables { raw_ingestion_state: { head: number }[]; raw_events: EventRow[]; raw_extrinsics: never[]; referendum_lifecycle_events: never[] }

const swapAt = (block: number, index = 1): EventRow =>
  ({ block_height: block, event_index: index, extrinsic_index: 0, event_name: 'Omnipool.SellExecuted' })

let client: FakeClient
let tables: Tables
let sends: string[]

const inbox = () => insertedRows(client, 'user_notification_inbox')
const setHead = (head: number) => { tables.raw_ingestion_state[0].head = head }
// Sends are fire-and-forget by design, so a tick returns before they land.
const flush = () => new Promise(resolve => setTimeout(resolve, 5))

beforeEach(async () => {
  resetEvaluatorForTests()
  resetDeliveryStateForTests()
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  sends = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
    sends.push(String(JSON.parse(init?.body ?? '{}').text ?? ''))
    return { ok: true, status: 200 } as Response
  }))
  tables = { raw_ingestion_state: [{ head: 1_000 }], raw_events: [], raw_extrinsics: [], referendum_lifecycle_events: [] }
  client = fakeClient(tables as unknown as Record<string, Record<string, unknown>[]>)
  initNotifications(client)
  await loadNotifications()
  initEvaluator(client)
  await upsertTelegramChannel(OWNER, { chatId: '99', username: 'maf' })
})

afterEach(() => {
  void stopNotificationEvaluator()
  vi.unstubAllGlobals()
  delete process.env.TELEGRAM_BOT_TOKEN
})

async function watchOmnipool(over: { cooldownS?: number } = {}) {
  return createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' }, ...over })
}

describe('evaluator cursor', () => {
  it('seeds at the live head on the first run and evaluates nothing', async () => {
    await watchOmnipool()
    tables.raw_events = [swapAt(999)]
    await runEvaluatorTick()
    expect(getNotificationState(CURSOR)).toBe('1000')
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCounters().seeded).toBe(1)
  })

  it('never fires on a row inserted below the cursor — the backfill scenario', async () => {
    await watchOmnipool()
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_001)
    // A backfill worker filling 2024 and one genuinely new block, in one table.
    tables.raw_events = [swapAt(12), swapAt(500), swapAt(1_000), swapAt(1_001)]
    await runEvaluatorTick()
    expect(inbox().map(r => r.block_height)).toEqual([1_001])
  })

  it('advances the cursor to the head it evaluated', async () => {
    await watchOmnipool()
    await runEvaluatorTick()
    setHead(1_042)
    await runEvaluatorTick()
    expect(evaluatorCursors().event).toBe(1_042)
  })

  // The cursor is authoritative in memory; a row per tick would write ~14k rows
  // a day for a value nothing reads between restarts.
  it('does not write the cursor row on every quiet tick, and flushes it on stop', async () => {
    await watchOmnipool()
    await runEvaluatorTick()                       // seeds at 1000, writes once
    const persisted = () => insertedRows(client, 'user_notification_state').filter(r => r.key === CURSOR)
    expect(persisted().at(-1)?.value).toBe('1000')
    for (const head of [1_001, 1_002, 1_003]) { setHead(head); await runEvaluatorTick() }
    expect(persisted()).toHaveLength(1)
    expect(evaluatorCursors().event).toBe(1_003)

    await stopNotificationEvaluator()
    expect(persisted().at(-1)?.value).toBe('1003')
  })

  // A tick that delivered something persists at once, so a crash cannot replay
  // the window it just paged somebody about.
  it('persists the cursor as soon as a lane fires', async () => {
    await watchOmnipool()
    await runEvaluatorTick()
    setHead(1_001)
    tables.raw_events = [swapAt(1_001)]
    await runEvaluatorTick()
    expect(insertedRows(client, 'user_notification_state').filter(r => r.key === CURSOR).at(-1)?.value).toBe('1001')
  })

  // An existing deployment stores one cursor for every kind; each kind adopts it
  // once and moves on from there.
  it('migrates a kind cursor from the legacy single cursor', async () => {
    await watchOmnipool()
    await setNotificationState(LEGACY_CURSOR, '1000')
    setHead(1_001)
    tables.raw_events = [swapAt(999), swapAt(1_001)]
    await runEvaluatorTick()
    expect(evaluatorCounters().seeded).toBe(0)
    expect(inbox().map(r => r.block_height)).toEqual([1_001])
    expect(getNotificationState(CURSOR)).toBe('1001')
  })

  it('clamps a 1000-block gap to the newest 600 and counts what it skipped', async () => {
    await watchOmnipool()
    await setNotificationState(CURSOR, '1000')
    setHead(2_000)
    tables.raw_events = [swapAt(1_300), swapAt(1_500)]
    await runEvaluatorTick()
    expect(inbox().map(r => r.block_height)).toEqual([1_500])
    expect(evaluatorCounters().skippedBlocks).toBe(400)
    expect(getNotificationState(CURSOR)).toBe('2000')
  })

  it('keeps ticking after a source failure instead of throwing out of the loop', async () => {
    await watchOmnipool()
    await setNotificationState(CURSOR, '1000')
    setHead(1_010)
    const broken = { ...client, query: async () => { throw new Error('clickhouse is down') } }
    initEvaluator(broken as unknown as FakeClient)
    await expect(runEvaluatorTick()).resolves.toBeUndefined()
    expect(evaluatorCounters().errors).toBeGreaterThan(0)
  })

  // Delivery is at-least-once within the clamp: a lane that threw has not seen
  // its window, so its cursor stays put and the next tick evaluates it again.
  it('holds the cursor when a lane throws, and delivers on the next tick', async () => {
    await watchOmnipool()
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_001)
    tables.raw_events = [swapAt(1_001)]
    let failNext = true
    const flaky = {
      ...client,
      query: async (args: { query: string }) => {
        if (failNext && args.query.includes('raw_events')) { failNext = false; throw new Error('raw_events unavailable') }
        return client.query(args as never)
      },
    }
    initEvaluator(flaky as unknown as FakeClient)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().event).toBe(1_000)

    await runEvaluatorTick()
    expect(inbox().map(r => r.block_height)).toEqual([1_001])
    expect(evaluatorCursors().event).toBe(1_001)
  })

  // The inbox write is what makes a match durable, so a failed write must not
  // move the cursor past the rows it was meant to record.
  it('holds the cursor when the inbox write fails', async () => {
    let failInbox = false
    const gated = {
      ...client,
      insert: async (args: { table: string; values: Record<string, unknown>[] }) => {
        if (failInbox && args.table.endsWith('user_notification_inbox')) throw new Error('inbox is read-only')
        return client.insert(args as never)
      },
    } as unknown as FakeClient
    initNotifications(gated)
    await loadNotifications()
    initEvaluator(gated)
    await watchOmnipool()
    await runEvaluatorTick()                       // seeds at 1000
    setHead(1_001)
    tables.raw_events = [swapAt(1_001)]

    failInbox = true
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(0)
    expect(evaluatorCursors().event).toBe(1_000)

    failInbox = false
    await runEvaluatorTick()
    expect(inbox().map(r => r.block_height)).toEqual([1_001])
    expect(evaluatorCursors().event).toBe(1_001)
  })
})

describe('evaluator delivery', () => {
  it('gives every match its own inbox row but sends one digest per rule per tick', async () => {
    await watchOmnipool()
    await runEvaluatorTick()
    setHead(1_006)
    tables.raw_events = [1_001, 1_002, 1_003, 1_004, 1_005, 1_006].map(b => swapAt(b))
    await runEvaluatorTick()
    await flush()
    expect(inbox()).toHaveLength(6)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain('6 × Event matcher')
    expect(sends[0]).toContain('and 1 more')
    expect(evaluatorCounters().coalesced).toBe(1)
  })

  it('suppresses the outbound message inside a cooldown without losing the inbox row', async () => {
    await watchOmnipool({ cooldownS: 600 })
    await runEvaluatorTick()
    setHead(1_001)
    tables.raw_events = [swapAt(1_001)]
    await runEvaluatorTick()
    await flush()
    expect(sends).toHaveLength(1)

    setHead(1_002)
    tables.raw_events = [swapAt(1_002)]
    await runEvaluatorTick()
    await flush()
    expect(inbox()).toHaveLength(2)
    expect(sends).toHaveLength(1)
    expect(evaluatorCounters().cooldownSuppressed).toBe(1)
  })

  it('writes the deterministic notification id and never writes it twice', async () => {
    const rule = await watchOmnipool()
    await runEvaluatorTick()
    setHead(1_001)
    tables.raw_events = [swapAt(1_001, 4)]
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0].notification_id).toBe(notificationIdFor(rule.ruleId, '1001-e4'))

    // The same row inside a later window (a replay, an overlapping tick) is the
    // same notification and is dropped, not re-delivered.
    await setNotificationState(CURSOR, '1000')
    setHead(1_001)
    await runEvaluatorTick()
    expect(inbox()).toHaveLength(1)
  })

  // A rule on a busy pallet used to cost one single-row insert per match. The
  // cap and the batch are what keep a wide window a bounded write.
  it('caps the inbox rows one rule writes in a tick and batches them into one insert', async () => {
    await watchOmnipool()
    await runEvaluatorTick()
    setHead(1_100)
    tables.raw_events = Array.from({ length: 100 }, (_, i) => swapAt(1_001 + Math.floor(i / 2), i % 2))
    const before = client.inserts.filter(i => i.table.endsWith('user_notification_inbox')).length
    await runEvaluatorTick()
    await flush()

    const rows = inbox()
    expect(rows).toHaveLength(21)                  // 20 detail rows plus one digest
    expect(client.inserts.filter(i => i.table.endsWith('user_notification_inbox'))).toHaveLength(before + 1)
    expect(rows.at(-1)?.title).toBe('80 × Event matcher')
    // One outbound message for the whole tick, naming the total.
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain('100 × Event matcher')
    expect(sends[0]).toContain('and 95 more')
  })

  it('stays silent for a muted rule', async () => {
    const rule = await watchOmnipool()
    await updateRule(OWNER, rule.ruleId, { muted: true })
    await runEvaluatorTick()
    setHead(1_001)
    tables.raw_events = [swapAt(1_001)]
    await runEvaluatorTick()
    await flush()
    expect(inbox()).toHaveLength(0)
    expect(sends).toHaveLength(0)
  })
})

describe('evaluator lifecycle', () => {
  it('runs on an unreferenced timer so it can never hold the process open', () => {
    startNotificationEvaluator(60_000)
    startNotificationEvaluator(60_000)   // idempotent
    stopNotificationEvaluator()
    expect(evaluatorCounters().ticks).toBe(0)
  })
})
