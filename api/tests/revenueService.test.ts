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
      '-- rev:protocol-revenue-windows': [{ stream: 'network_fee', day: '1.5', week: '1.5', month: '1.5', all_time: '1.5' }],
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
    const totalsQuery = seen.find(s => s.query.includes('-- rev:protocol-revenue-windows'))!.query
    expect(totalsQuery).toContain("(stream = 'network_fee' AND block_timestamp <= toDateTime('2026-08-14 10:00:00'))")
    expect(totalsQuery).toContain("stream != 'omnipool_asset_fee' OR dest IN ('protocol', 'burned', 'pol')")
    const tailQuery = seen.find(s => s.query.includes('-- rev:network_fee'))!.query
    expect(tailQuery).toContain("block_timestamp > toDateTime('2026-08-14 10:00:00')")
  })

  it('ranks HOLLAR borrowers among the top payers via range-exact weights', async () => {
    vi.setSystemTime(NOW + 600_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    const dayStart = Math.floor((NOW + 600_000) / 1000 / 86_400) * 86_400
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'hollar_borrow', mark: '2026-08-14 10:00:00' }],
      '-- rev:protocol-revenue-windows': [{ stream: 'hollar_borrow', day: '10', week: '10', month: '10', all_time: '10' }],
      '-- rev:dashboard:buckets': [{ stream: 'hollar_borrow', t: dayStart, usd: '10' }],
      '-- rev:dashboard:top-accounts': [{ account: ACCOUNT_A, usd: '4' }],
      '-- rev:borrow-weights': [
        { account: ACCOUNT_B, interest: '3000000000000000000' },
        { account: ACCOUNT_A, interest: '1000000000000000000' },
      ],
    })
    initRevenueService(client)
    const dash = await getRevenueDashboard('30d')
    // $10 of range HOLLAR interest splits 3:1 over the weights; ACCOUNT_A also
    // paid $4 of eventful revenue, so both rank with combined totals.
    const byId = new Map(dash.topAccounts.map(r => [r.account.accountId, r.usd]))
    expect(byId.get(ACCOUNT_B)).toBeCloseTo(7.5, 9)
    expect(byId.get(ACCOUNT_A)).toBeCloseTo(6.5, 9)
    // The weights window ends at the stream's cold mark — the distributed USD
    // is booked up to there, so a borrower who only opened debt later must not
    // take a share of it.
    const weightsCall = seen.find(x => x.query.includes('-- rev:borrow-weights'))!
    expect(weightsCall.params.reserve).toBe('0x531a654d1696ed52e7275a8cede955e82620f99a')
    expect(weightsCall.params.end).toBe('2026-08-14 10:00:00')
  })

  it('answers an empty model with zeros and no synthetic points', async () => {
    vi.setSystemTime(NOW + 900_000)
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
    vi.setSystemTime(NOW + 1_200_000)
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
    vi.setSystemTime(NOW + 1_500_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 1_500_000) / 1000)
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
    vi.setSystemTime(NOW + 1_800_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 1_800_000) / 1000)
    const hour = Math.floor(nowSec / 3_600) * 3_600
    const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      // The accrual seeds from the last observation BEFORE its window; these
      // fixtures put every observation inside it, so the seed read is empty.
      '-- rev:hollar-seed': [],
      '-- rev:hollar-internal-debt': [],
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

  it('divides a sparse pool\'s multi-hour lump by the hours it covers', async () => {
    // gigahdx is touched every few days: the index delta booked at one hour is
    // several hours of interest. Reading that lump AS an hourly rate overstates
    // the drip by the size of the gap.
    vi.setSystemTime(NOW + 1_980_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 1_980_000) / 1000)
    const hour = Math.floor(nowSec / 3_600) * 3_600
    const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      // The accrual seeds from the last observation BEFORE its window; these
      // fixtures put every observation inside it, so the seed read is empty.
      '-- rev:hollar-seed': [],
      '-- rev:hollar-internal-debt': [],
      money_market_reserve_state_history: [
        { bucket: ch(hour - 5 * 3_600), pool_address: '0xquiet', debt_scaled: '3600000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(hour), pool_address: '0xquiet', debt_scaled: '3600000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      ohlc_1h: [{ bucket: ch(hour - 5 * 3_600), close: '1' }],
      atoken_reserve_map: [{ pool: '0xquiet', market: 'gigahdx' }],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    // 3.6 HOLLAR accrued over FIVE hours = 0.72/h at $1 → $0.0012/block at 6s.
    expect(flow.drips).toHaveLength(1)
    expect(flow.drips[0].usdPerBlock).toBeCloseTo(0.0012, 9)
  })

  it('still drips a pool whose last observation is older than two days', async () => {
    // The lookback must span the sparsest market's touch interval, or a pool
    // quiet for longer than the window contributes no drip at all and the
    // river silently under-reports that market's whole share.
    vi.setSystemTime(NOW + 2_160_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 2_160_000) / 1000)
    const hour = Math.floor(nowSec / 3_600) * 3_600
    const stale = hour - 60 * 3_600
    const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      // The accrual seeds from the last observation BEFORE its window; these
      // fixtures put every observation inside it, so the seed read is empty.
      '-- rev:hollar-seed': [],
      '-- rev:hollar-internal-debt': [],
      money_market_reserve_state_history: [
        { bucket: ch(stale - 3_600), pool_address: '0xstale', debt_scaled: '3600000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(stale), pool_address: '0xstale', debt_scaled: '3600000000000000000000', borrow_index: '1001000000000000000000000000' },
      ],
      ohlc_1h: [{ bucket: ch(stale - 3_600), close: '1' }],
      atoken_reserve_map: [{ pool: '0xstale', market: 'gigahdx' }],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    expect(flow.drips).toHaveLength(1)
    expect(flow.drips[0].usdPerBlock).toBeCloseTo(0.006, 9)
  })

  it('emits no drip for a pool whose debt has gone to zero', async () => {
    // Carrying a rate forward from the last observation is only honest while
    // there is still debt to accrue on. A repaid-to-zero pool must not drip.
    vi.setSystemTime(NOW + 2_340_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 2_340_000) / 1000)
    const hour = Math.floor(nowSec / 3_600) * 3_600
    const ch = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      // The accrual seeds from the last observation BEFORE its window; these
      // fixtures put every observation inside it, so the seed read is empty.
      '-- rev:hollar-seed': [],
      '-- rev:hollar-internal-debt': [],
      money_market_reserve_state_history: [
        { bucket: ch(hour - 3_600), pool_address: '0xrepaid', debt_scaled: '3600000000000000000000', borrow_index: '1000000000000000000000000000' },
        { bucket: ch(hour), pool_address: '0xrepaid', debt_scaled: '0', borrow_index: '1001000000000000000000000000' },
      ],
      ohlc_1h: [{ bucket: ch(hour - 3_600), close: '1' }],
      atoken_reserve_map: [{ pool: '0xrepaid', market: 'core' }],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    expect(flow.drips).toEqual([])
  })

  it('pins the cursor grammar', async () => {
    const { FLOW_CURSOR_RE } = await service()
    expect(FLOW_CURSOR_RE.test('123-45-0')).toBe(true)
    expect(FLOW_CURSOR_RE.test('123-45')).toBe(false)
    expect(FLOW_CURSOR_RE.test('abc')).toBe(false)
  })
})

describe('top payer ranking completeness', () => {
  it('fetches the cold eventful sum for an account the LIMIT dropped before merging its adds', async () => {
    vi.setSystemTime(NOW + 2_400_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    const dayStart = Math.floor((NOW + 2_400_000) / 1000 / 86_400) * 86_400
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'hollar_borrow', mark: '2026-08-14 10:00:00' }],
      '-- rev:protocol-revenue-windows': [{ stream: 'hollar_borrow', day: '10', week: '10', month: '10', all_time: '10' }],
      '-- rev:dashboard:buckets': [{ stream: 'hollar_borrow', t: dayStart, usd: '10' }],
      '-- rev:dashboard:top-accounts': [{ account: ACCOUNT_A, usd: '4' }],
      '-- rev:borrow-weights': [{ account: ACCOUNT_B, interest: '1000000000000000000' }],
      // ACCOUNT_B's cold eventful revenue: real, but outside the cold top 10.
      '-- rev:dashboard:top-account-sums': [{ account: ACCOUNT_B, usd: '9' }],
    })
    initRevenueService(client)
    const dash = await getRevenueDashboard('30d')
    // B's combined total is its full cold sum plus the whole HOLLAR pot —
    // not just the add the merge happens to know about.
    const byId = new Map(dash.topAccounts.map(r => [r.account.accountId, r.usd]))
    expect(byId.get(ACCOUNT_B)).toBeCloseTo(19, 9)
    expect(byId.get(ACCOUNT_A)).toBeCloseTo(4, 9)
    expect(dash.topAccounts[0].account.accountId).toBe(ACCOUNT_B)
    const sumsCall = seen.find(x => x.query.includes('-- rev:dashboard:top-account-sums'))!
    expect(sumsCall.params.accounts).toEqual([ACCOUNT_B])
  })
})

describe('split marks under a mid-request refresh', () => {
  it('threads one marks read into both arms even when the marks cache expires mid-request', async () => {
    vi.setSystemTime(NOW + 2_760_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    let marksCalls = 0
    const seen: Seen[] = []
    const client = {
      query: vi.fn(async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
        seen.push({ query, params: query_params ?? {} })
        if (query.includes('toString(max(block_timestamp)) AS mark')) {
          marksCalls += 1
          // A REPLACE PARTITION between reads would advance the mark.
          const mark = marksCalls === 1 ? '2026-08-14 10:00:00' : '2026-08-14 11:00:00'
          return { json: async () => [{ stream: 'network_fee', mark }] }
        }
        if (query.includes('-- rev:protocol-revenue-windows')) {
          // Outlive the marks cache while the request is still composing.
          vi.setSystemTime(Date.now() + 16_000)
        }
        return { json: async () => [] }
      }),
    }
    initRevenueService(client as never)
    await getRevenueDashboard('30d')
    expect(marksCalls).toBe(1)
    const totalsQuery = seen.find(s => s.query.includes('-- rev:protocol-revenue-windows'))!.query
    const tailQuery = seen.find(s => s.query.includes('-- rev:network_fee'))!.query
    expect(totalsQuery).toContain("(stream = 'network_fee' AND block_timestamp <= toDateTime('2026-08-14 10:00:00'))")
    expect(tailQuery).toContain("block_timestamp > toDateTime('2026-08-14 10:00:00')")
  })
})

describe('getStakerDistributions', () => {
  const STAKING_POT = '0x6d6f646c7374616b696e67230000000000000000000000000000000000000000'
  const GIGAHDX_POT = '0x6d6f646c67696761686478210000000000000000000000000000000000000000'
  const GIGARWD_POT = '0x6d6f646c67696761727764210000000000000000000000000000000000000000'

  it('serves per-pot bucketed inflows with range totals and a separate all-time scan', async () => {
    vi.setSystemTime(NOW + 3_200_000)
    const { initRevenueService, getStakerDistributions } = await service()
    const dayStart = Math.floor((NOW + 3_200_000) / 1000 / 86_400) * 86_400
    const { seen, client } = fakeClient({
      '-- rev:dashboard:stakers-series': [
        { pot: STAKING_POT, t: dayStart, amount: '5000000000000', usd: '0.05' },
        { pot: GIGAHDX_POT, t: dayStart, amount: '15000000000000', usd: '0.15' },
        { pot: GIGARWD_POT, t: dayStart, amount: '25000000000000', usd: '0.25' },
        // An account outside the pot map must be ignored, not misfiled.
        { pot: `0x${'cc'.repeat(32)}`, t: dayStart, amount: '99000000000000', usd: '0.99' },
      ],
      '-- rev:dashboard:stakers-alltime': [
        { pot: STAKING_POT, amount: '200000000000000000000', usd: '2000' },
        { pot: GIGARWD_POT, amount: '3000000000000000000', usd: '30' },
      ],
    })
    initRevenueService(client)
    const dist = await getStakerDistributions('30d')

    expect(dist.range).toBe('30d')
    expect(dist.bucketSeconds).toBe(86_400)
    expect(dist.series.map(s => s.pot)).toEqual(['staking', 'gigahdx', 'gigarwd'])
    expect(dist.series[0].points).toEqual([{ t: dayStart, hdx: 5, usd: 0.05 }])
    expect(dist.totals.hdx).toBeCloseTo(45, 9)
    expect(dist.totals.usd).toBeCloseTo(0.45, 9)
    expect(dist.allTime.hdx).toBeCloseTo(203_000_000, 6)
    expect(dist.allTime.usd).toBeCloseTo(2_030, 9)

    // The from-account whitelist IS the revenue boundary: the fee converters
    // are in, the treasury (incentive drips) must never be.
    const seriesQuery = seen.find(s => s.query.includes('-- rev:dashboard:stakers-series'))!.query
    expect(seriesQuery).toContain("from_account IN ('0x6d6f646c66656570726f632f0000000000000000000000000000000000000000'")
    expect(seriesQuery).not.toContain('0x6d6f646c70792f7472737279')
    expect(seriesQuery).toContain('to_account = account AND asset_id = 0')
  })

  it('derives the all-time totals from the all-range series without a second scan', async () => {
    vi.setSystemTime(NOW + 3_600_000)
    const { initRevenueService, getStakerDistributions } = await service()
    const { seen, client } = fakeClient({
      '-- rev:dashboard:stakers-series': [
        { pot: GIGAHDX_POT, t: 1_700_000_000, amount: '7000000000000', usd: '0.07' },
      ],
    })
    initRevenueService(client)
    const dist = await getStakerDistributions('all')
    expect(dist.allTime).toEqual(dist.totals)
    expect(dist.allTime.hdx).toBeCloseTo(7, 9)
    expect(seen.filter(s => s.query.includes('-- rev:dashboard:stakers-alltime'))).toHaveLength(0)
  })

  it('answers an empty model with zeros and no synthetic points', async () => {
    vi.setSystemTime(NOW + 3_900_000)
    const { initRevenueService, getStakerDistributions } = await service()
    const { client } = fakeClient({})
    initRevenueService(client)
    const dist = await getStakerDistributions('1y')
    expect(dist.series).toEqual([])
    expect(dist.totals).toEqual({ hdx: 0, usd: 0 })
    expect(dist.allTime).toEqual({ hdx: 0, usd: 0 })
  })
})

describe('uniswap v3 realization shares in the payer ranking', () => {
  it('adds each swapper\'s share of the payer-less vault realizations', async () => {
    vi.setSystemTime(NOW + 4_500_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    const monthStart = Date.UTC(2026, 7, 1) / 1000
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'uniswap_v3_fee', mark: '2026-08-14 10:00:00' }],
      '-- rev:protocol-revenue-windows': [{ stream: 'uniswap_v3_fee', day: '5', week: '5', month: '5', all_time: '5' }],
      '-- rev:dashboard:buckets': [{ stream: 'uniswap_v3_fee', t: monthStart, usd: '5' }],
      // The accrued half names its swapper; the realization rows carry none.
      '-- rev:dashboard:top-accounts': [{ account: ACCOUNT_A, usd: '1' }],
      '-- rev:dashboard:v3-realization-payers': [
        { account: ACCOUNT_A, usd: '1.5' },
        { account: ACCOUNT_B, usd: '2.5' },
      ],
      '-- rev:dashboard:top-account-sums': [],
    })
    initRevenueService(client)
    const dash = await getRevenueDashboard('all')
    const byId = new Map(dash.topAccounts.map(r => [r.account.accountId, r.usd]))
    // The ranking now sums to the stream total: 1 accrued + 4 realized.
    expect(byId.get(ACCOUNT_A)).toBeCloseTo(2.5, 9)
    expect(byId.get(ACCOUNT_B)).toBeCloseTo(2.5, 9)
    const sql = seen.find(x => x.query.includes('-- rev:dashboard:v3-realization-payers'))!.query
    expect(sql).toContain('month >= 197001')
  })

  it('takes the share as account_revenue less the accrued half, from matching publications only', async () => {
    const { uniswapV3RealizationPayersSql, firstMonthInside } = await service()
    const sql = uniswapV3RealizationPayersSql(202609)
    expect(sql).toContain("FROM price_data.account_revenue\n  WHERE stream = 'uniswap_v3_fee' AND account != ''")
    expect(sql).toContain("SELECT account, -sum(amount_usd) AS part")
    expect(sql).toContain("stream = 'uniswap_v3_fee' AND dest = 'accrued'")
    expect(sql).toContain('WHERE a.built >= r.published')
    // Read through the per-hour computed_by_hour projection's shape.
    expect(sql).toContain('SELECT toStartOfHour(block_timestamp) AS hour, max(computed_at) AS hour_published\n      FROM price_data.revenue_events\n      GROUP BY hour')
    expect(sql).toContain('SELECT toYYYYMM(hour) AS p, max(hour_published) AS published')
    expect(sql).toContain('month >= 202609')
    // A month partly before the range stays out; one starting inside it counts.
    expect(firstMonthInside(Date.UTC(2026, 8, 1) / 1000)).toBe(202609)
    expect(firstMonthInside(Date.UTC(2026, 8, 1) / 1000 + 1)).toBe(202610)
    expect(firstMonthInside(0)).toBe(197001)
  })
})

describe('reserve mints in the payer ranking', () => {
  it('counts the live month\'s reserve payers, since the range ends now', async () => {
    vi.setSystemTime(NOW + 6_300_000)
    const { initRevenueService, getRevenueDashboard } = await service()
    const monthStart = Date.UTC(2026, 7, 1) / 1000
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'asset_reserve', mark: '2026-08-14 10:00:00' }],
      '-- rev:protocol-revenue-windows': [{ stream: 'asset_reserve', day: '3', week: '3', month: '3', all_time: '3' }],
      '-- rev:dashboard:buckets': [{ stream: 'asset_reserve', t: monthStart, usd: '3' }],
      '-- rev:dashboard:reserve-payers': [{ account: ACCOUNT_B, usd: '3' }],
    })
    initRevenueService(client)
    const dash = await getRevenueDashboard('all')
    expect(new Map(dash.topAccounts.map(r => [r.account.accountId, r.usd])).get(ACCOUNT_B)).toBeCloseTo(3, 9)
    const sql = seen.find(x => x.query.includes('-- rev:dashboard:reserve-payers'))!.query
    expect(sql).toContain('month >= 197001')
    // No upper month bound: the live month (202608 at the frozen clock) is inside the range.
    expect(sql).not.toContain('month <=')
  })
})

describe('top payer sums over many accounts', () => {
  it('reads the missing accounts in chunks the server\'s parameter cap admits', async () => {
    vi.setSystemTime(NOW + 5_400_000)
    const { initRevenueService, getRevenueDashboard, TOP_ACCOUNT_SUMS_CHUNK } = await service()
    const dayStart = Math.floor((NOW + 5_400_000) / 1000 / 86_400) * 86_400
    const borrowers = Array.from({ length: 1_201 }, (_, i) => ({ account: `0x${i.toString(16).padStart(64, '0')}`, interest: '1000000000000' }))
    const { seen, client } = fakeClient({
      'toString(max(block_timestamp)) AS mark': [{ stream: 'hollar_borrow', mark: '2026-08-14 10:00:00' }],
      '-- rev:protocol-revenue-windows': [{ stream: 'hollar_borrow', day: '10', week: '10', month: '10', all_time: '10' }],
      '-- rev:dashboard:buckets': [{ stream: 'hollar_borrow', t: dayStart, usd: '10' }],
      '-- rev:borrow-weights': borrowers,
    })
    initRevenueService(client)
    await getRevenueDashboard('30d')
    const calls = seen.filter(x => x.query.includes('-- rev:dashboard:top-account-sums'))
    // 1,201 ids × ~71 bytes quoted is past the 128 KiB field cap in one parameter.
    expect(calls).toHaveLength(Math.ceil(1_201 / TOP_ACCOUNT_SUMS_CHUNK))
    expect(calls.every(c => (c.params.accounts as string[]).length <= TOP_ACCOUNT_SUMS_CHUNK)).toBe(true)
    expect(calls.flatMap(c => c.params.accounts as string[]).sort()).toEqual(borrowers.map(b => b.account).sort())
  })
})

describe('getUserRevenueFlow', () => {
  it('states the newest folded hour from its MARKER even when that hour holds no user fact', async () => {
    vi.setSystemTime(NOW + 9_000_000)
    const { initRevenueService, getUserRevenueFlow } = await service()
    const hour = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow\n': [],
    })
    initRevenueService(client)
    const flow = await getUserRevenueFlow()
    expect(flow.hour).toBe('2026-08-14T13:00:00.000Z')
    expect(flow.publishedThrough).toBe('2026-08-14T14:00:00.000Z')
    expect(flow.drips).toEqual([])
    expect(flow.items).toEqual([])
    // Both positions just before the head block, so a head-block row at event 0 still streams.
    expect(flow.cursor).toBe('u1.13599999-4294967295-65535.13599999-4294967295-65535')
  })
})

describe('getUserRevenueFlow — revisable streams', () => {
  it('streams the revisable streams and legacy staking at their trailing-24h mean and the lending pots of the newest money-market hour', async () => {
    vi.setSystemTime(NOW + 9_100_000)
    const { initRevenueService, getUserRevenueFlow } = await service()
    const hour = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const { seen, client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow\n': [
        { mode: 'mean', stream: 'token_accrual', asset_id: '43', usd: '48.000000000000' },
        { mode: 'mean', stream: 'farm_rewards', asset_id: '0', usd: '24.000000000000' },
        { mode: 'live', stream: 'mm_supply_interest', asset_id: '5', usd: '3.000000000000' },
      ],
    })
    initRevenueService(client)
    const flow = await getUserRevenueFlow()
    expect(flow.revisableMeanHours).toBe(24)
    const per = new Map(flow.drips.map(d => [d.stream, d.usdPerBlock / (flow.blockSeconds / 3_600)]))
    expect(per.get('token_accrual')).toBeCloseTo(2, 9) // 48 / 24
    expect(per.get('farm_rewards')).toBeCloseTo(1, 9)
    expect(per.get('mm_supply_interest')).toBeCloseTo(3, 9) // an hourly amount, never divided
    expect(new Map(flow.drips.map(d => [d.stream, d.mode]))).toEqual(new Map([['token_accrual', 'mean'], ['farm_rewards', 'mean'], ['mm_supply_interest', 'live']]))
    // The mean arm is the revisable streams exactly; the rate arm the lending streams; no stream replays an hour.
    const call = seen.find(x => x.query.includes('-- rev:user-flow\n'))!
    expect([...(call.params.mean as string[])].sort()).toEqual(['farm_rewards', 'gigahdx_voting', 'staking_legacy', 'token_accrual', 'token_accrual_catchup'])
    expect(call.params.rate).toEqual(['mm_supply_interest', 'mm_incentives'])
    // Only the pots of the newest hour holding any measured money-market fact: no per-pot carry-forward.
    expect(call.query).toContain("startsWith(stream, 'mm_') AND NOT startsWith(via, 'unmeasured:'))")
    expect(call.query).not.toContain('LIMIT 1 BY')
  })
})

describe('getUserRevenueFlow — token accrual drips', () => {
  it('keys and labels a token\'s accrual by the token its pot names, not the asset it is valued in', async () => {
    vi.setSystemTime(NOW + 9_165_000)
    const { initRevenueService, getUserRevenueFlow } = await service()
    const hour = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const { seen, client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow\n': [{ mode: 'mean', stream: 'token_accrual', asset_id: '0', usd: '48.000000000000' }],
    })
    initRevenueService(client)
    const flow = await getUserRevenueFlow()
    const sql = seen.find(x => x.query.includes('-- rev:user-flow\n'))!.query
    expect(sql).toContain("if(startsWith(stream, 'token_accrual') AND startsWith(pot, 'token:'), toUInt32OrZero(substring(pot, 7)), asset_id) AS asset_id")
    expect(sql).toContain('GROUP BY stream, asset_id')
    expect(flow.drips[0]).toMatchObject({ key: 'token_accrual:0', assetId: 0 })
    expect(flow.drips[0].label).toBe('Yield-bearing token accrual · HDX')
  })
})

describe('getUserRevenueDashboard — top earners and payers in one pass', () => {
  it('reads one ranking (whole months by partition, the first month by day) and splits it by sign', async () => {
    vi.setSystemTime(NOW + 9_200_000)
    const { initRevenueService, getUserRevenueDashboard } = await service()
    const through = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const { seen, client } = fakeClient({
      '-- ur:account-coverage': [{ m: '202608', computed: String(through), through: String(through), expected_first: '202608' }],
      '-- rev:user:top': [
        { account: ACCOUNT_B, usd: '120.000000000000' },
        { account: `0x${'ee'.repeat(32)}`, usd: '-40.000000000000' },
      ],
    })
    initRevenueService(client)
    const dash = await getUserRevenueDashboard('30d')
    expect(dash.accountComplete).toBe(true)
    expect(dash.topEarners.map(r => r.usd)).toEqual([120])
    expect(dash.topPayers.map(r => r.usd)).toEqual([-40])
    const top = seen.filter(s => s.query.includes('-- rev:user:top'))
    expect(top).toHaveLength(1)
    expect(top[0].query).toContain('_partition_id > {fromMonth:String}')
    expect(top[0].query).toContain('LIMIT 10 BY sign(s)')
    expect(top[0].params.fromMonth).toBe(String(top[0].params.from).slice(0, 7).replace('-', ''))
  })
})

describe('getUserRevenueFlow — earnings only', () => {
  it('drips only what users earn: a pot whose user side netted to a cost is no drip and never offsets another pot', async () => {
    vi.setSystemTime(NOW + 9_300_000)
    const { initRevenueService, getUserRevenueFlow } = await service()
    const hour = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow\n': [
        { mode: 'live', stream: 'mm_incentives', asset_id: '5', usd: '-2.000000000000' },
        { mode: 'live', stream: 'mm_incentives', asset_id: '5', usd: '1.000000000000' },
        { mode: 'mean', stream: 'farm_rewards', asset_id: '9', usd: '-24.000000000000' },
        { mode: 'live', stream: 'mm_supply_interest', asset_id: '0', usd: '4.000000000000' },
      ],
    })
    initRevenueService(client)
    const flow = await getUserRevenueFlow()
    // Largest first; every drip positive.
    expect(flow.drips.map(d => d.key)).toEqual(['mm_supply_interest:0', 'mm_incentives:5'])
    expect(flow.drips[1].usdPerBlock / (flow.blockSeconds / 3_600)).toBeCloseTo(1, 9)
    expect(flow.drips.every(d => d.usdPerBlock > 0)).toBe(true)
  })
})

describe('User Revenue display streams — HOLLAR interest apart', () => {
  it('reads the dashboard\'s series and breakdown under the display streams, HOLLAR interest before the rest', async () => {
    vi.setSystemTime(NOW + 11_100_000) // past the previous dashboard's stale window
    const { initRevenueService, getUserRevenueDashboard } = await service()
    const through = Math.floor(Date.parse('2026-08-14T13:00:00Z') / 1000)
    const day = Math.floor(Date.parse('2026-08-13T00:00:00Z') / 1000)
    // A newer build than the previous test's (its publication generation), so the sections are read afresh.
    const { seen, client } = fakeClient({
      '-- ur:account-coverage': [{ m: '202608', computed: String(through + 60), through: String(through), expected_first: '202608' }],
      '-- ur:day-buckets': [
        { t: String(day), ds: 'mm_borrow_interest', holder_class: 'user', earned: '0', paid: '-0.671', net: '-0.671', unpriced: '0' },
        { t: String(day), ds: 'mm_borrow_interest_hollar', holder_class: 'user', earned: '0', paid: '-9.003', net: '-9.003', unpriced: '0' },
      ],
      '-- ur:stream-totals': [
        { ds: 'mm_borrow_interest', holder_class: 'user', earned: '0', paid: '-0.671', net: '-0.671', unpriced: '0' },
        { ds: 'mm_borrow_interest_hollar', holder_class: 'user', earned: '0', paid: '-9.003', net: '-9.003', unpriced: '0' },
      ],
    })
    initRevenueService(client)
    const dash = await getUserRevenueDashboard('30d')
    expect(dash.breakdown.map(b => [b.stream, b.label, b.paid])).toEqual([
      ['mm_borrow_interest_hollar', 'HOLLAR interest', -9.003],
      ['mm_borrow_interest', 'Borrow interest', -0.671],
    ])
    expect(dash.history.series.map(s => s.stream)).toEqual(['mm_borrow_interest_hollar', 'mm_borrow_interest'])
    // The total is the exact sum over both lines: the split moves no cent.
    expect(dash.breakdownTotal?.paid).toBeCloseTo(-9.674, 9)
    for (const marker of ['-- ur:day-buckets', '-- ur:stream-totals']) {
      const q = seen.find(s => s.query.includes(marker))!.query
      expect(q).toContain("if((stream = 'mm_borrow_interest' AND asset_id = 222), 'mm_borrow_interest_hollar', stream) AS ds")
      expect(q).toMatch(/GROUP BY (t, )?ds, holder_class/)
    }
  })
})

// ── the user river's live items ──────────────────────────────────────────────

function userTailRow(over: Partial<Row>): Row {
  return {
    stream: 'lp_fee_omnipool', pot: 'omnipool:5', block_height: 13_600_000, block_timestamp: '2026-08-14 15:30:30',
    event_index: 1, leg_index: 0, earner: '', asset_id: 5, amount_usd: '1.000000000000',
    ...over,
  }
}

describe('getUserRevenueFlow — live items', () => {
  const hour = Math.floor(Date.parse('2026-08-14T14:00:00Z') / 1000)
  const shares = [
    { stream: 'lp_fee_omnipool', pot: 'omnipool:5', h: String(hour), user_usd: '1.000000000000', total_usd: '4.000000000000' },
    // The HDX sub-pool: protocol-held, so its user side is 0.
    { stream: 'lp_fee_omnipool', pot: 'omnipool:0', h: String(hour), user_usd: '0', total_usd: '3.000000000000' },
  ]
  const PALLET = `0x6d6f646c${'00'.repeat(28)}`

  it('streams each event\'s user share of its pot, a referral claim by its earner\'s class, and seeds from the tail\'s newest minute', async () => {
    // The wall clock is 55 s past the newest row (rows land most of a minute after their block):
    // a wall-clock seed minute would hold almost nothing.
    vi.setSystemTime(Date.parse('2026-08-14T15:31:25Z'))
    const { initRevenueService, getUserRevenueFlow } = await service()
    const { seen, client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_010 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow-shares': shares,
      '-- rev:user-flow-tail': [
        userTailRow({ block_height: 13_599_000, block_timestamp: '2026-08-14 15:00:00' }), // older than the seed minute
        userTailRow({ block_height: 13_600_001, amount_usd: '2.000000000000' }),
        userTailRow({ block_height: 13_600_002, pot: 'omnipool:0', asset_id: 0 }), // protocol-held: nothing
        userTailRow({ block_height: 13_600_003, stream: 'lp_fee_xyk', pot: 'xyk:1000001' }), // no known share: skipped
        // A referral claim is its earner's: a user streams the whole claim, a pallet account nothing.
        userTailRow({ block_height: 13_600_004, stream: 'referral_commissions', pot: 'referrals', earner: ACCOUNT_A, asset_id: 0, amount_usd: '0.300000000000' }),
        userTailRow({ block_height: 13_600_005, stream: 'referral_commissions', pot: 'referrals', earner: PALLET, asset_id: 0, amount_usd: '0.700000000000' }),
      ],
    })
    initRevenueService(client)
    const flow = await getUserRevenueFlow()
    expect(flow.items.map(i => [i.stream, i.block, i.usd])).toEqual([
      ['lp_fee_omnipool', 13_600_001, 0.5], // 2 × 1 / 4
      ['referral_commissions', 13_600_004, 0.3],
    ])
    expect(flow.items[1].account?.accountId).toBe(ACCOUNT_A)
    expect(flow.items[0].account).toBeNull()
    expect(flow.items.every(i => i.usd > 0)).toBe(true)
    expect(flow.cursor).toBe('u1.13600004-1-0.13600000-4294967295-65535')
    expect(flow.liveStreams).toContain('lp_fee_uniswap_v3')
    expect(flow.liveStreams).not.toContain('staking_legacy')
    // Shares are read for the pot streams only (a referral claim is classed by its earner), as of the newest folded hour.
    const call = seen.find(x => x.query.includes('-- rev:user-flow-shares'))!
    expect(call.params.h).toBe(hour)
    expect(call.params.streams).not.toContain('referral_commissions')
    expect(call.query).toContain('LIMIT 1 BY stream, pot')
    expect(call.query).toContain('HAVING t > 0')
  })

  it('pages strictly after the cursor, with no overlap and no gap; an older plain cursor re-seeds instead of failing', async () => {
    vi.setSystemTime(Date.parse('2026-08-14T15:31:00Z') + 400_000)
    const { initRevenueService, getUserRevenueFlow } = await service()
    const tail = [
      userTailRow({ block_height: 13_600_100, event_index: 3, leg_index: 0 }),
      userTailRow({ block_height: 13_600_100, event_index: 3, leg_index: 1 }),
      userTailRow({ block_height: 13_600_100, event_index: 4, leg_index: 0 }),
      userTailRow({ block_height: 13_600_101, event_index: 0, leg_index: 0 }),
    ]
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_120 }],
      '-- rev:user-flow-hour': [{ h: String(hour), n: '1' }],
      '-- rev:user-flow-shares': shares,
      '-- rev:user-flow-tail': tail,
    })
    initRevenueService(client)
    const first = await getUserRevenueFlow('u1.13600100-3-0.13600100-3-0')
    expect(first.items.map(i => `${i.block}-${i.eventIndex}-${i.legIndex}`)).toEqual(['13600100-3-1', '13600100-4-0', '13600101-0-0'])
    expect(first.cursor).toBe('u1.13600101-0-0.13600100-3-0')
    const next = await getUserRevenueFlow(first.cursor)
    expect(next.items).toEqual([])
    // An empty page keeps the caller's cursor.
    expect(next.cursor).toBe(first.cursor)
    // An older client's cursor is not an error: it seeds afresh (the whole tail is inside the newest minute here).
    const old = await getUserRevenueFlow('13600100-3-0')
    expect(old.items).toHaveLength(4)
  })

  it('holds a Uniswap v3 leg until every resolvable v3 swap at or below it has its leg, then streams it once', async () => {
    const t0 = Date.parse('2026-08-14T15:45:00Z')
    vi.setSystemTime(t0)
    const { initRevenueService, getUserRevenueFlow } = await service()
    // Another folded hour than the tests above, so its shares are read afresh rather than from their cache.
    const h2 = hour + 3_600
    const v3Shares = [...shares, { stream: 'lp_fee_uniswap_v3', pot: 'v3:0xpool', h: String(h2), user_usd: '1.000000000000', total_usd: '1.000000000000' }]
    const omni = userTailRow({ block_height: 13_600_300, event_index: 2 })
    const v3 = userTailRow({ stream: 'lp_fee_uniswap_v3', pot: 'v3:0xpool', block_height: 13_600_250, event_index: 9, asset_id: 5, amount_usd: '0.400000000000' })
    const v3b = userTailRow({ stream: 'lp_fee_uniswap_v3', pot: 'v3:0xpool', block_height: 13_600_280, event_index: 4, asset_id: 5, amount_usd: '0.100000000000' })
    // Pull 1: the v3 legs are not written yet; the at-ingest source runs ahead.
    let fake = fakeClient({
      raw_ingestion_state: [{ head: 13_600_301 }],
      '-- rev:user-flow-hour': [{ h: String(h2), n: '1' }],
      '-- rev:user-flow-shares': v3Shares,
      '-- rev:user-flow-tail': [omni],
      '-- rev:user-flow-v3-ready': [{ pending: '13600250' }],
    })
    initRevenueService(fake.client)
    const p1 = await getUserRevenueFlow('u1.13600200-0-0.13600200-0-0')
    expect(p1.items.map(i => i.block)).toEqual([13_600_300])
    // Pull 2 (a later head): the first leg landed, the second swap's has not — only the first streams.
    vi.setSystemTime(t0 + 3_000)
    fake = fakeClient({
      raw_ingestion_state: [{ head: 13_600_302 }],
      '-- rev:user-flow-hour': [{ h: String(h2), n: '1' }],
      '-- rev:user-flow-shares': v3Shares,
      '-- rev:user-flow-tail': [v3, omni],
      '-- rev:user-flow-v3-ready': [{ pending: '13600280' }],
    })
    initRevenueService(fake.client)
    const p2 = await getUserRevenueFlow(p1.cursor)
    expect(p2.items.map(i => [i.stream, i.block])).toEqual([['lp_fee_uniswap_v3', 13_600_250]])
    // Pull 3: everything written — the second leg streams, nothing repeats.
    vi.setSystemTime(t0 + 6_000)
    fake = fakeClient({
      raw_ingestion_state: [{ head: 13_600_303 }],
      '-- rev:user-flow-hour': [{ h: String(h2), n: '1' }],
      '-- rev:user-flow-shares': v3Shares,
      '-- rev:user-flow-tail': [v3, v3b, omni],
    })
    initRevenueService(fake.client)
    const p3 = await getUserRevenueFlow(p2.cursor)
    expect(p3.items.map(i => [i.stream, i.block])).toEqual([['lp_fee_uniswap_v3', 13_600_280]])
    const p4 = await getUserRevenueFlow(p3.cursor)
    expect(p4.items).toEqual([])
  })
})

describe('user river SQL', () => {
  it('reads every venue\'s RETAINED fee legs, the v3 leg net of the protocol fee, and the pots\' inflows', async () => {
    const { userFlowTailSql } = await import('../src/services/userRevenueLive.ts')
    const sql = userFlowTailSql()
    expect(sql).toContain("venue IN ('omnipool', 'stableswap', 'xyk', 'uniswapv3') AND leg_kind = 'fee'")
    expect(sql).toContain("l.recipient = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'")
    expect(sql).toContain('l.gross - intDiv(l.gross, f.fp)')
    expect(sql).toContain("concat('omnipool:', toString(if(l.leg_asset = 1, 0, l.leg_asset)))")
    expect(sql).toContain("event_name = 'Referrals.Claimed'")
    expect(sql).toContain("to_account = account AND asset_id = 0")
    // Bounded: every arm reads the anchored window.
    expect(sql.match(/block_timestamp > \{anchor:DateTime\} - INTERVAL \{hours:UInt32\} HOUR/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps a stableswap leg only when it names that pool\'s own account (the fold\'s rule)', async () => {
    const { userFlowTailSql } = await import('../src/services/userRevenueLive.ts')
    const sql = userFlowTailSql()
    expect(sql).toContain("l.venue = 'stableswap', l.recipient = '' OR has({ssPoolAccounts:Array(String)}, concat(l.pool_key, ':', l.recipient))")
    expect(sql).not.toContain("l.recipient != ''")
  })

  it('values an asset with a fill series at the newer of its own close and the fill\'s (the fold\'s ETH ← WETH rule)', async () => {
    const { userFlowTailSql } = await import('../src/services/userRevenueLive.ts')
    const sql = userFlowTailSql()
    expect(sql).toMatch(/AS pf\s+ON pf\.asset_id = transform\(toUInt32\(.*\), \[34\], \[20\], toUInt32\(4294967295\)\)/)
    expect(sql).toContain('if(pf.close > 0 AND (p.close <= 0 OR pf.price_time > p.price_time), pf.close, p.close) AS px')
  })

  it('streams legacy staking at its mean, never from the staking pot\'s inflows', async () => {
    const { userFlowTailSql, USER_FLOW_MEAN_STREAMS, USER_FLOW_EVENT_STREAMS } = await import('../src/services/userRevenueLive.ts')
    const { STAKING_POT } = await import('../src/services/userRevenueLp.ts')
    expect(userFlowTailSql()).not.toContain(STAKING_POT)
    expect(USER_FLOW_MEAN_STREAMS).toContain('staking_legacy')
    expect(USER_FLOW_EVENT_STREAMS).not.toContain('staking_legacy' as never)
  })

  it('finds the oldest resolvable v3 swap whose fee leg is not written yet, inside the window', async () => {
    const { userFlowV3ReadySql } = await import('../src/services/userRevenueLive.ts')
    const sql = userFlowV3ReadySql()
    expect(sql).toContain('minOrNull(s.block_height) AS pending')
    expect(sql).toContain("kind = 'pool' AND event_name = 'Swap'")
    expect(sql).toContain("venue = 'uniswapv3' AND leg_kind = 'fee'")
    expect(sql).toContain('!= 4294967295')
    expect(sql.match(/block_timestamp > \{anchor:DateTime\} - INTERVAL \{hours:UInt32\} HOUR/g)?.length).toBe(2)
  })
})

// Last in the file: the clock only moves forward past every cache above.
describe('getRevenueFlow — seed and boundary', () => {
  it('anchors the cursorless seed on the tail\'s newest row, not the wall clock', async () => {
    vi.setSystemTime(NOW + 30_000_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const nowSec = Math.floor((NOW + 30_000_000) / 1000)
    const at = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const { client } = fakeClient({
      raw_ingestion_state: [{ head: 13_600_000 }],
      '-- rev:network_fee': [
        tailRow({ block_height: 300, event_index: 1, block_timestamp: at(nowSec - 200) }),
        // Landed ~50 s after their blocks: outside a wall-clock minute, inside the newest row's.
        tailRow({ block_height: 310, event_index: 1, block_timestamp: at(nowSec - 95) }),
        tailRow({ block_height: 311, event_index: 1, block_timestamp: at(nowSec - 50) }),
      ],
    })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    expect(flow.items.map(i => i.block)).toEqual([310, 311])
  })

  it('an empty cursorless page sets the cursor just before the head block, so its event 0 still streams', async () => {
    vi.setSystemTime(NOW + 30_120_000)
    const { initRevenueService, getRevenueFlow } = await service()
    const { client } = fakeClient({ raw_ingestion_state: [{ head: 13_600_000 }], '-- rev:network_fee': [] })
    initRevenueService(client)
    const flow = await getRevenueFlow(null)
    expect(flow.cursor).toBe('13599999-4294967295-65535')
    const { FLOW_CURSOR_RE } = await service()
    expect(FLOW_CURSOR_RE.test(flow.cursor)).toBe(true)
  })
})
