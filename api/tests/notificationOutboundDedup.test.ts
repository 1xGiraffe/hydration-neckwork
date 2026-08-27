import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  evaluatorCounters, initEvaluator, outboundIdentity, resetEvaluatorForTests,
  runEvaluatorTick, stopNotificationEvaluator,
} from '../src/notifications/evaluator.ts'
import {
  createRule, initNotifications, loadNotifications, upsertTelegramChannel,
} from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { renderNotification, text } from '../src/notifications/render.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// Several rules routinely describe ONE on-chain event — a large-trade floor and
// an account-activity rule on a tag the trader belongs to both match the same
// swap — and the reader's phone then buzzes once per rule with the same words.
// The inbox stays a complete per-rule ledger (a reader has to be able to see
// which of their alerts fired); only the outbound copy collapses.

const OWNER = '0x' + 'aa'.repeat(32)

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

// Two DIFFERENT subscriptions (distinct canonical params, so both are created)
// that the same event satisfies: the whole pallet, and one method of it.
async function twoOverlappingRules(): Promise<void> {
  await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
  await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool', method: 'SellExecuted' } })
}

describe('one event matched by several rules', () => {
  it('is delivered once but recorded once per rule', async () => {
    await twoOverlappingRules()
    await runEvaluatorTick() // seeds the cursor at the head
    tables.raw_events = [swapAt(1_001)]
    setHead(1_001)

    await runEvaluatorTick()
    await flush()

    expect(sends).toHaveLength(1)
    // The ledger is untouched: both rules still show what they matched.
    const rows = inbox()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.rule_id)).size).toBe(2)
    expect(evaluatorCounters().outboundDuplicates).toBe(1)
  })

  it('still delivers the next, genuinely different event', async () => {
    await twoOverlappingRules()
    await runEvaluatorTick()
    tables.raw_events = [swapAt(1_001)]
    setHead(1_001)
    await runEvaluatorTick()
    await flush()

    tables.raw_events = [swapAt(1_001), swapAt(1_002)]
    setHead(1_002)
    await runEvaluatorTick()
    await flush()

    // One per event, not one per (event × rule) and not one in total.
    expect(sends).toHaveLength(2)
    expect(sends[0]).not.toBe(sends[1])
  })

  it('leaves a single rule alone', async () => {
    await createRule(OWNER, { kind: 'event', params: { section: 'Omnipool' } })
    await runEvaluatorTick()
    tables.raw_events = [swapAt(1_001)]
    setHead(1_001)

    await runEvaluatorTick()
    await flush()

    expect(sends).toHaveLength(1)
    expect(evaluatorCounters().outboundDuplicates).toBe(0)
  })
})

// The key is the identity of the MESSAGE at a block, not of the event: two
// rules whose wording differs are telling the reader different things, and
// suppressing one of those would lose information rather than noise.
describe('outbound identity', () => {
  const message = (title: string, path = '/swap/1-e1') =>
    renderNotification({ title: [text(title)], body: [[text('500k HDX → 4.95k USDT')]], path })

  it('matches an identical message for the same reader', () => {
    expect(outboundIdentity(OWNER, 1, message('Swap'))).toBe(outboundIdentity(OWNER, 1, message('Swap')))
  })

  it('separates different wording about one event', () => {
    expect(outboundIdentity(OWNER, 1, message('Swap'))).not.toBe(outboundIdentity(OWNER, 1, message('Large trade')))
  })

  it('separates the same wording about different events', () => {
    expect(outboundIdentity(OWNER, 1, message('Swap', '/swap/1-e1')))
      .not.toBe(outboundIdentity(OWNER, 1, message('Swap', '/swap/2-e1')))
  })

  // A catch-up window renders a rule's own per-block digests identically
  // ("2 × Event matcher", block after block); those are separate events.
  it('separates identical wording at different blocks', () => {
    expect(outboundIdentity(OWNER, 1, message('Swap'))).not.toBe(outboundIdentity(OWNER, 2, message('Swap')))
  })

  it('never collapses across readers', () => {
    expect(outboundIdentity(OWNER, 1, message('Swap')))
      .not.toBe(outboundIdentity('0x' + 'bb'.repeat(32), 1, message('Swap')))
  })
})
