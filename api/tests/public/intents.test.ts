import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Regression cover for the ICE intents service behind /v1/intents. The page is
// read per OWNER, so everything here is about what one owner's order set can do
// to it: the table it reads, the size it can reach, and the one caller-chosen
// integer on the surface that nothing at the edge bounds.
//
// The per-id routes are covered below it: one order's folded progress, and its
// own lifecycle events — the two reads a progress UI needs and the only two that
// are NOT owner-scoped, because an intent id bounds them by itself.
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const OWNER = `0x${'77'.repeat(32)}`

interface Seen { query: string; params: Record<string, unknown> }

/** Answers the three reads the service makes: EVM bindings, orders, event aggregates. */
function fakeClient(orders: Row[], events: Row[] = []) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('price_data.account_alias_directory')) return queryResult([])
      if (query.includes('price_data.intent_orders')) return queryResult(orders)
      if (query.includes('price_data.intent_events')) return queryResult(events)
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

/** One placement row, as the by-account twin stores it. */
function order(overrides: Row = {}): Row {
  return {
    intent_id: '1',
    seq: '1',
    owner: OWNER,
    kind: 'swap',
    asset_in: 5,
    asset_out: 222,
    amount_in: '1000000000000',
    amount_out: '900000000000',
    partial: 0,
    slippage_ppm: 5000,
    budget: '',
    period: 0,
    deadline_ms: '1786000000000',
    block_height: 14400000,
    ts: '2026-09-01 00:00:00',
    ...overrides,
  }
}

const OPTIONS = { owner: OWNER, statuses: [], kinds: [], assets: [], limit: 25, offset: 0 }

describe('oldestOrderBlock', () => {
  it('folds instead of spreading, so a large order set cannot blow the stack', async () => {
    const { oldestOrderBlock } = await import('../../src/public/services/intentOrders.ts')
    // `Math.min(...rows.map(…))` throws RangeError well below this length, which
    // was a permanent 500 on one owner's page and nobody else's.
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ block_height: 14_000_000 - i }))
    expect(oldestOrderBlock(rows)).toBe(14_000_000 - 199_999)
    expect(oldestOrderBlock([{ block_height: '7' }, { block_height: 3 }])).toBe(3)
  })
})

describe('queryIntentOrders', () => {
  it('reads the owner-first twin rather than a whole-table FINAL pass', async () => {
    const { queryIntentOrders } = await import('../../src/public/services/intentOrders.ts')
    const client = fakeClient([order()])
    const out = await queryIntentOrders(client as never, OPTIONS)
    expect(out.totalCount).toBe(1)
    const read = client.seen.find(s => s.query.includes('price_data.intent_orders'))!
    // `owner` is not in intent_orders' key (it is ORDER BY intent_id alone), so
    // filtering it there costs one FINAL pass over every intent ever submitted.
    // The twin is ORDER BY (owner, block_height, event_index): one key range.
    expect(read.query).toContain('price_data.intent_orders_by_account FINAL')
    expect(read.query).not.toMatch(/price_data\.intent_orders FINAL/)
    expect(read.params.accounts).toContain(OWNER)
  })

  it('reports one row per intent id even if the twin carries a placement twice', async () => {
    const { queryIntentOrders } = await import('../../src/public/services/intentOrders.ts')
    // The twin replaces on (owner, block_height, event_index), so a row re-keyed
    // by a replay survives FINAL; intent_id is the identity the wire promises.
    const client = fakeClient([
      order({ intent_id: '9', block_height: 14400000 }),
      order({ intent_id: '9', block_height: 14400500 }),
    ])
    const out = await queryIntentOrders(client as never, OPTIONS)
    expect(out.totalCount).toBe(1)
    expect(out.items[0]!.createdAtBlock).toBe(14400500)
  })

  it('reports an out-of-range deadline as null instead of throwing on an Invalid Date', async () => {
    const { queryIntentOrders } = await import('../../src/public/services/intentOrders.ts')
    // deadline_ms is an unbounded UInt64 the submitter picks, and both ways past
    // the calendar take the WHOLE page down: past ±8.64e15 ms `new Date()` is
    // Invalid and iso() throws, and past year 9999 toISOString() renders
    // `+275760-09-13T…`, which zIsoTimestamp rejects at serialization.
    const client = fakeClient([
      order({ intent_id: '1', deadline_ms: '18446744073709551615' }),
      order({ intent_id: '2', deadline_ms: '8640000000000000' }),
      order({ intent_id: '3', deadline_ms: '253402300800000' }),
      order({ intent_id: '4', deadline_ms: '253402300799999' }),
      order({ intent_id: '5', deadline_ms: '0' }),
      order({ intent_id: '6', deadline_ms: '1786000000000' }),
    ])
    const out = await queryIntentOrders(client as never, OPTIONS)
    const byId = new Map(out.items.map(row => [row.intentId, row.deadline]))
    expect(byId.get('1')).toBeNull()
    expect(byId.get('2')).toBeNull()
    expect(byId.get('3')).toBeNull()
    expect(byId.get('4')).toBe('9999-12-31T23:59:59.999Z')
    // Zero is the pallet's "no deadline", which reports null the same way.
    expect(byId.get('5')).toBeNull()
    expect(byId.get('6')).toBe('2026-08-06T07:06:40.000Z')
    // Every one of them still renders as a timestamp the response schema takes.
    const { ISO_TIMESTAMP_RE } = await import('../../src/public/schemas/common.ts')
    for (const value of byId.values()) {
      if (value != null) expect(value).toMatch(ISO_TIMESTAMP_RE)
    }
  })

  it('windows the event aggregate at the oldest placement it found', async () => {
    const { queryIntentOrders } = await import('../../src/public/services/intentOrders.ts')
    const client = fakeClient([
      order({ intent_id: '1', block_height: 14400000 }),
      order({ intent_id: '2', block_height: 14380000 }),
    ])
    await queryIntentOrders(client as never, OPTIONS)
    const aggregate = client.seen.find(s => s.query.includes('price_data.intent_events'))!
    expect(aggregate.params.from).toBe(14380000)
  })
})

// ---------------------------------------------------------------------------
// The per-id surface: one order's progress, and its own events
// ---------------------------------------------------------------------------

// A real DCA intent, halfway through a 500 HOLLAR budget at 2.0833 per period.
const DCA_ID = '33005361867118405355392991232107'
const DCA_BLOCK = 14519481

function dcaOrder(overrides: Row = {}): Row {
  return order({
    intent_id: DCA_ID,
    seq: '107',
    kind: 'dca',
    asset_in: 1000765,
    asset_out: 0,
    amount_in: '2083333333333333333',
    amount_out: '0',
    budget: '500000000000000000000',
    period: 30,
    deadline_ms: '0',
    block_height: DCA_BLOCK,
    ts: '2026-09-13 06:00:00',
    ...overrides,
  })
}

/** The order's life, newest first — the order `intent_events` is read in. */
const DCA_EVENTS: Row[] = [
  { event_name: 'Intent.IntentCanceled', block_height: 14523390, event_index: 3, extrinsic_index: 2, ts: '2026-09-13 12:31:00', amount_in: '', amount_out: '', remaining_budget: '' },
  { event_name: 'Intent.DcaTradeExecuted', block_height: 14519541, event_index: 9, extrinsic_index: 1, ts: '2026-09-13 06:06:00', amount_in: '2083333333333333333', amount_out: '291000000000000', remaining_budget: '495833333333333333334' },
  { event_name: 'Intent.DcaTradeExecuted', block_height: 14519511, event_index: 7, extrinsic_index: 1, ts: '2026-09-13 06:03:00', amount_in: '2083333333333333333', amount_out: '291000000000000', remaining_budget: '497916666666666666667' },
  { event_name: 'Intent.IntentSubmitted', block_height: DCA_BLOCK, event_index: 5, extrinsic_index: 4, ts: '2026-09-13 06:00:00', amount_in: '', amount_out: '', remaining_budget: '' },
]

/** The fold `intentEventAggregates` returns over those four rows. */
const DCA_AGGREGATE: Row = {
  intent_id: DCA_ID,
  cancelled: 1,
  expired: 0,
  resolved: 0,
  partial: 0,
  dca_completed: 0,
  fills: 2,
  fill_in: '4166666666666666666',
  fill_out: '582000000000000',
  last_ts: '2026-09-13 12:31:00',
  last_rb: '495833333333333333334',
}

/**
 * Answers the per-id reads by their SQL comment tag, and the aggregate by its
 * shape — a fixture that dispatched on the table name alone could not tell the
 * event PAGE from the fold over the same table.
 */
function detailClient(overrides: { orders?: Row[]; events?: Row[]; aggregates?: Row[] } = {}) {
  const seen: Seen[] = []
  const events = overrides.events ?? DCA_EVENTS
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('price_data.account_alias_directory')) return queryResult([])
      if (query.includes('pub:intents:events-count')) return queryResult([{ total: String(events.length) }])
      if (query.includes('pub:intents:events')) {
        const offset = Number(params.offset ?? 0)
        return queryResult(events.slice(offset, offset + Number(params.limit ?? 20)))
      }
      if (query.includes('price_data.intent_events')) {
        const wanted = new Set(((params.ids as string[]) ?? []).map(String))
        return queryResult((overrides.aggregates ?? [DCA_AGGREGATE]).filter(row => wanted.has(String(row.intent_id))))
      }
      if (query.includes('price_data.intent_orders')) {
        const rows = overrides.orders ?? [dcaOrder()]
        return params.id == null ? queryResult(rows) : queryResult(rows.filter(row => String(row.intent_id) === String(params.id)))
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

describe('queryIntentOrderById', () => {
  it('publishes the identical row the listing publishes for the same order', async () => {
    const { queryIntentOrderById, queryIntentOrders } = await import('../../src/public/services/intentOrders.ts')
    // The two surfaces must not disagree about a status or a remaining amount:
    // a progress page reached from a list would contradict the list it came from.
    const listed = await queryIntentOrders(detailClient() as never, { ...OPTIONS, owner: OWNER })
    const one = await queryIntentOrderById(detailClient() as never, DCA_ID)
    expect(one).toEqual(listed.items[0])
  })

  it('folds the progress a DCA bar is drawn from', async () => {
    const { queryIntentOrderById } = await import('../../src/public/services/intentOrders.ts')
    const row = (await queryIntentOrderById(detailClient() as never, DCA_ID))!
    expect(row.kind).toBe('dca')
    expect(row.budget).toBe('500000000000000000000')
    // One period's trade, never the total — the field most often misread.
    expect(row.amountIn).toBe('2083333333333333333')
    expect(row.filledAmountIn).toBe('4166666666666666666')
    expect(row.fillCount).toBe(2)
    // budget - spent, exact integer arithmetic.
    expect(row.remainingAmountIn).toBe('495833333333333333334')
    expect(row.remainingBudget).toBe('495833333333333333334')
    // Pulled after two fills: partial progress does not make an order filled.
    expect(row.status).toBe('cancelled')
  })

  it('reads the id-keyed table and bounds the fold at the placement block', async () => {
    const { queryIntentOrderById } = await import('../../src/public/services/intentOrders.ts')
    const client = detailClient()
    await queryIntentOrderById(client as never, DCA_ID)
    const read = client.seen.find(s => s.query.includes('pub:intents:order-by-id'))!
    // intent_orders is ORDER BY intent_id, so a single order is a point read
    // there — the owner-first twin could not prune on an id at all.
    expect(read.query).toContain('price_data.intent_orders FINAL')
    expect(read.params.id).toBe(DCA_ID)
    const fold = client.seen.find(s => s.query.includes('GROUP BY intent_id'))!
    // intent_events is keyed (block_height, event_index) and cannot prune on an
    // id, so the placement block is what makes this a key range.
    expect(fold.params.from).toBe(DCA_BLOCK)
  })

  it('is null for an id that was never submitted', async () => {
    const { queryIntentOrderById } = await import('../../src/public/services/intentOrders.ts')
    expect(await queryIntentOrderById(detailClient() as never, '999')).toBeNull()
  })
})

describe('queryIntentEvents', () => {
  it('names every event of the order and labels the amounts with its pair', async () => {
    const { queryIntentEvents } = await import('../../src/public/services/intentOrders.ts')
    const page = (await queryIntentEvents(detailClient() as never, DCA_ID, { limit: 20, offset: 0 }))!
    expect(page.totalCount).toBe(4)
    // The pair lives on the envelope: only the submission names it, so without
    // it every amount below is an unlabelled integer.
    expect([page.assetIn, page.assetOut]).toEqual(['1000765', '0'])
    expect(page.items.map(item => item.kind)).toEqual(['cancelled', 'dca_trade', 'dca_trade', 'submitted'])
    expect(page.items[1]).toEqual({
      kind: 'dca_trade',
      eventName: 'Intent.DcaTradeExecuted',
      blockHeight: 14519541,
      eventIndex: 9,
      extrinsicIndex: 1,
      timestamp: '2026-09-13T06:06:00.000Z',
      amountIn: '2083333333333333333',
      amountOut: '291000000000000',
      remainingBudget: '495833333333333333334',
    })
  })

  it('reports null rather than 0 for an event that traded nothing', async () => {
    const { queryIntentEvents } = await import('../../src/public/services/intentOrders.ts')
    const page = (await queryIntentEvents(detailClient() as never, DCA_ID, { limit: 20, offset: 0 }))!
    const submitted = page.items.find(item => item.kind === 'submitted')!
    expect([submitted.amountIn, submitted.amountOut, submitted.remainingBudget]).toEqual([null, null, null])
    const cancelled = page.items.find(item => item.kind === 'cancelled')!
    expect([cancelled.amountIn, cancelled.amountOut, cancelled.remainingBudget]).toEqual([null, null, null])
  })

  it('states the zero a completion asserts, and carries no budget on a swap fill', async () => {
    const { queryIntentEvents } = await import('../../src/public/services/intentOrders.ts')
    const client = detailClient({
      events: [
        // The trade that exhausts a budget states its amounts only in the
        // solution's settlement transfers, so the event itself carries none.
        { event_name: 'Intent.DcaCompleted', block_height: 14523400, event_index: 2, extrinsic_index: 1, ts: '2026-09-13 13:00:00', amount_in: '', amount_out: '', remaining_budget: '' },
        { event_name: 'Intent.IntentResovedPartially', block_height: 14523000, event_index: 4, extrinsic_index: 1, ts: '2026-09-13 12:00:00', amount_in: '10', amount_out: '20', remaining_budget: '' },
      ],
    })
    const page = (await queryIntentEvents(client as never, DCA_ID, { limit: 20, offset: 0 }))!
    expect(page.items[0]!.remainingBudget).toBe('0')
    // A partial resolution is a fill, not a budget event.
    expect(page.items[1]!.kind).toBe('partially_resolved')
    expect(page.items[1]!.remainingBudget).toBeNull()
  })

  it('pages over the order\'s own window without overlap or gaps', async () => {
    const { queryIntentEvents } = await import('../../src/public/services/intentOrders.ts')
    const client = detailClient()
    const first = (await queryIntentEvents(client as never, DCA_ID, { limit: 2, offset: 0 }))!
    const second = (await queryIntentEvents(client as never, DCA_ID, { limit: 2, offset: 2 }))!
    const key = (item: { blockHeight: number; eventIndex: number }) => `${item.blockHeight}:${item.eventIndex}`
    expect(first.items.map(key)).toEqual(['14523390:3', '14519541:9'])
    expect(second.items.map(key)).toEqual(['14519511:7', `${DCA_BLOCK}:5`])
    expect(first.totalCount).toBe(4)
    // Both the page and its count start at the placement block, or the count
    // would answer for a window the page never read.
    for (const tag of ['pub:intents:events', 'pub:intents:events-count']) {
      expect(client.seen.find(s => s.query.includes(tag))!.params.from).toBe(DCA_BLOCK)
    }
  })

  it('is null for an id that was never submitted', async () => {
    const { queryIntentEvents } = await import('../../src/public/services/intentOrders.ts')
    expect(await queryIntentEvents(detailClient() as never, '999', { limit: 20, offset: 0 })).toBeNull()
  })
})

describe('the per-id intent routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    const { buildPublicApp } = await import('../../src/public/app.ts')
    app = await buildPublicApp({ client: detailClient() as never, logger: false })
  })

  afterAll(async () => {
    await app?.close()
  })

  it('answers GET /v1/intents/{id} with the order and its progress', async () => {
    const res = await app.inject(`/v1/intents/${DCA_ID}`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.intentId).toBe(DCA_ID)
    expect(body.status).toBe('cancelled')
    expect(body.filledAmountIn).toBe('4166666666666666666')
  })

  it('answers GET /v1/intents/{id}/events with the page and its pair', async () => {
    const res = await app.inject(`/v1/intents/${DCA_ID}/events?limit=2`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.totalCount).toBe(4)
    expect(body.items).toHaveLength(2)
    expect([body.assetIn, body.assetOut]).toEqual(['1000765', '0'])
  })

  it('keeps /v1/intents/count a count rather than an intent named "count"', async () => {
    // The static segment must win the match, or the listing's own counter reads
    // as a malformed id.
    const res = await app.inject(`/v1/intents/count?owner=${OWNER}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('totalCount')
  })

  it('separates an unknown order from a malformed id', async () => {
    expect((await app.inject('/v1/intents/999')).statusCode).toBe(404)
    expect((await app.inject('/v1/intents/999/events')).statusCode).toBe(404)
    // Not a decimal u128: a caller's typo is their error, not a ClickHouse parse
    // failure surfacing as a 500.
    expect((await app.inject('/v1/intents/0xdeadbeef')).statusCode).toBe(400)
    expect((await app.inject(`/v1/intents/${'9'.repeat(40)}`)).statusCode).toBe(400)
    expect((await app.inject('/v1/intents/340282366920938463463374607431768211456')).statusCode).toBe(400)
  })

  it('declares the same freshness the listing does, and hands none to a sibling', async () => {
    const { PUBLIC_CACHE_CONTROL } = await import('../../src/public/cacheControl.ts')
    const maxAge = (path: string): number | null =>
      PUBLIC_CACHE_CONTROL.find(([pattern]) => pattern.test(path))?.[1] ?? null
    for (const path of ['/v1/intents', '/v1/intents/count', `/v1/intents/${DCA_ID}`, `/v1/intents/${DCA_ID}/events`]) {
      expect([path, maxAge(path)]).toEqual([path, 3])
    }
    for (const path of ['/v1/intents-export', `/v1/intents/${DCA_ID}/events/7`, `/v1/intents/${DCA_ID}/fills`]) {
      expect([path, maxAge(path)]).toEqual([path, null])
    }
  })
})
