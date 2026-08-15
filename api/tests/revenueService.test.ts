import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Dashboard/flow composition tests: the cold arm (revenue_events) and the raw
// tail must combine without double counting at the per-stream marks, explorer
// surfaces must show protocol revenue only, and the flow cursor must be
// strictly monotonic. All ClickHouse traffic goes through a marker-dispatching
// fake; time is frozen so the in-process caches behave deterministically.

vi.mock('../src/services/blockTime.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/blockTime.ts')>()),
  measuredParaBlockMs: vi.fn(async () => 6_000),
}))

type Row = Record<string, unknown>

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

const NOW = Date.parse('2026-08-14T12:00:00Z')
const ACCOUNT_A = `0x${'aa'.repeat(32)}`
const ACCOUNT_B = `0x${'bb'.repeat(32)}`

interface Seen { query: string; params: Record<string, unknown> }

function tailRow(over: Partial<Row>): Row {
  return {
    stream: 'network_fee', block_height: 100, block_timestamp: '2026-08-14 11:30:00',
    event_index: 1, leg_index: 0, dest: '', account: ACCOUNT_A, asset_id: 0,
    amount: '1000000000000', amount_usd: '0.500000000000',
    ...over,
  }
}

function fakeClient(byMarker: Record<string, Row[]>): { seen: Seen[]; client: never } {
  const seen: Seen[] = []
  const client = {
    query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return { json: async () => rows }
      }
      return { json: async () => [] }
    }),
  }
  return { seen, client: client as never }
}

let stopAssets: () => void
beforeAll(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const { client } = fakeClient({ 'FROM price_data.assets FINAL': ASSET_ROWS })
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../src/services/explorerAssets.ts')
  await loadExplorerAssets(client)
  stopAssets = stopExplorerAssetsRefresh
})
afterAll(() => {
  stopAssets?.()
  vi.useRealTimers()
})

async function service() {
  return import('../src/services/revenueService.ts')
}

describe('getRevenueDashboard', () => {
  it('combines cold history and the raw tail without double counting at the marks', async () => {
    const { initRevenueService, getRevenueDashboard } = await service()
    // Each test advances time past every in-process cache TTL of the previous one.
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'network_fee', mark: '2026-08-14 10:00:00' }],
      '-- rev:dashboard:totals': [{ stream: 'network_fee', day: '1.5', week: '1.5', month: '1.5', all_time: '1.5' }],
      '-- rev:dashboard:buckets': [{ stream: 'network_fee', t: Math.floor(NOW / 1000 / 86_400) * 86_400, usd: '1.5' }],
      '-- rev:dashboard:top-accounts': [{ account: ACCOUNT_A, usd: '1.5' }],
      '-- rev:network_fee': [
        tailRow({}),
        // An lp-destination asset-fee leg in the tail: NOT protocol revenue.
        tailRow({ stream: 'omnipool_asset_fee', dest: 'lp', event_index: 2, amount_usd: '9.999000000000' }),
      ],
    })
    initRevenueService(client)
    const dash = await getRevenueDashboard('30d')

    expect(dash.totals.day).toBeCloseTo(2.0, 9)      // 1.5 cold + 0.5 tail, lp leg excluded
    expect(dash.totals.allTime).toBeCloseTo(2.0, 9)
    expect(dash.breakdown).toHaveLength(1)
    expect(dash.breakdown[0]).toMatchObject({ stream: 'network_fee' })
    expect(dash.breakdown[0].share).toBeCloseTo(1, 6)
    expect(dash.topAccounts[0].usd).toBeCloseTo(2.0, 9)
    expect(dash.topAccounts[0].account.accountId).toBe(ACCOUNT_A)

    // The cold arm must be capped at the same literal marks the tail was built
    // from — that is what makes the two arms disjoint under a concurrent
    // REPLACE PARTITION.
    const totalsQuery = seen.find(s => s.query.includes('-- rev:dashboard:totals'))!.query
    expect(totalsQuery).toContain("(stream = 'network_fee' AND block_timestamp <= toDateTime('2026-08-14 10:00:00'))")
    expect(totalsQuery).toContain("stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned')")
    const tailQuery = seen.find(s => s.query.includes('-- rev:network_fee'))!.query
    expect(tailQuery).toContain("block_timestamp > toDateTime('2026-08-14 10:00:00')")
  })

  it('answers an empty model with zeros and no synthetic points', async () => {
    vi.setSystemTime(NOW + 120_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    const { client } = fakeClient({})
    initRevenueService(client)
    const dash = await getRevenueDashboard('1y')
    expect(dash.totals).toEqual({ day: 0, week: 0, month: 0, allTime: 0 })
    expect(dash.history.series).toEqual([])
    expect(dash.breakdown).toEqual([])
    expect(dash.topAccounts).toEqual([])
  })
})

describe('getRevenueFlow', () => {
  it('serves items strictly after the cursor, ascending, and echoes the new cursor', async () => {
    vi.setSystemTime(NOW + 240_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:network_fee': [
        tailRow({ block_height: 101, event_index: 7, account: ACCOUNT_B }),
        tailRow({ block_height: 100, event_index: 5 }),
        tailRow({ block_height: 101, event_index: 3 }),
        // MintedToTreasury settles interest no drip streams — it flows as an item.
        tailRow({ stream: 'asset_reserve', block_height: 101, event_index: 9 }),
        // Valueless rows carry nothing the river can show.
        tailRow({ block_height: 101, event_index: 11, amount_usd: '0.000000000000' }),
      ],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow('100-5-0')
    expect(flow.items.map(i => `${i.block}-${i.eventIndex}`)).toEqual(['101-3', '101-7', '101-9'])
    expect(flow.cursor).toBe('101-9-0')
    expect(flow.head).toBe(13_600_000)
    expect(flow.blockSeconds).toBe(6)
    expect(flow.items[1].account?.accountId).toBe(ACCOUNT_B)
    expect(flow.items[2].stream).toBe('asset_reserve')
  })

  it('seeds a cursorless first call with only the most recent minute', async () => {
    vi.setSystemTime(NOW + 360_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 360_000) / 1000)
    const recent = new Date((nowSec - 30) * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:network_fee': [
        tailRow({ block_height: 90, event_index: 1, block_timestamp: '2026-08-14 11:00:00' }),
        tailRow({ block_height: 200, event_index: 1, block_timestamp: recent }),
      ],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    expect(flow.items.map(i => i.block)).toEqual([200])
  })

  it('derives the borrow drip from the last observed hourly accrual', async () => {
    vi.setSystemTime(NOW + 480_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 480_000) / 1000)
    const hour = Math.floor(nowSec / 3_600) * 3_600
    const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      money_market_reserve_state_history: [
        { bucket: ch(hour - 3_600), pool_address: '0xpool', debt_scaled: '3600000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(hour), pool_address: '0xpool', debt_scaled: '3600000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      ohlc_1h: [{ bucket: ch(hour - 3_600), close: '1' }],
      atoken_reserve_map: [{ pool: '0xpool', market: 'core' }],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    // 3600 scaled × 0.001 index growth = 3.6 HOLLAR/h at $1 → $0.006/block at 6s.
    expect(flow.drips).toHaveLength(1)
    expect(flow.drips[0]).toMatchObject({ stream: 'hollar_borrow', key: '0xpool' })
    expect(flow.drips[0].label).toContain('core')
    expect(flow.drips[0].usdPerBlock).toBeCloseTo(0.006, 9)
  })

  it('pins the cursor grammar', async () => {
    const { FLOW_CURSOR_RE } = await service()
    expect(FLOW_CURSOR_RE.test('123-45-0')).toBe(true)
    expect(FLOW_CURSOR_RE.test('123-45')).toBe(false)
    expect(FLOW_CURSOR_RE.test('abc')).toBe(false)
  })
})
