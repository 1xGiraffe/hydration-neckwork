import { describe, expect, it, vi } from 'vitest'

// Regression cover for the ICE intents service behind /v1/intents. The page is
// read per OWNER, so everything here is about what one owner's order set can do
// to it: the table it reads, the size it can reach, and the one caller-chosen
// integer on the surface that nothing at the edge bounds.
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
