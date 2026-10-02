import { beforeEach, describe, expect, it, vi } from 'vitest'

// The oracle service's ledgers against a fake ClickHouse: the EMA load pages a pair by a
// keyset however many rows it holds, a load that fails half way leaves nothing behind
// for its retry to count twice, and a row inserted below a settled floor is picked up by
// a reload. Plus the two pure pieces the review fixed: which consumer the market overlay
// follows, and when an EMA adapter's label may state an orientation.
const HEAD = 1_000_000
vi.mock('../src/services/explorerService.ts', () => ({
  accountRef: (id: string) => ({ accountId: id, address: id }),
  cutoffHeightForWindow: async () => 0,
  ensurePrices: async () => new Map(),
  indexedRawHead: async () => HEAD,
  priceIsOracleFallback: () => false,
}))
vi.mock('../src/services/poolService.ts', () => ({ decodePegSource: () => null }))

const svc = await import('../src/services/oracleService.ts')
const { __testing, ensureEmaLedger, feedSubjects, adapterEmaLabel, EMA_PAGE_ROWS } = svc

const BIG = { source: '0x6f6d6e69706f6f6c', asset_a: 0, asset_b: 1, n: Math.floor(EMA_PAGE_ROWS * 2.4) }
const SMALL = { source: '0x626966726f73746f', asset_a: 5, asset_b: 15, n: 30 }
const rowsOf = (p: typeof BIG) => Array.from({ length: p.n }, (_, i) => ({
  source: p.source, asset_a: p.asset_a, asset_b: p.asset_b, block_height: 10 + Math.floor((i * (HEAD - 20)) / p.n), event_index: i % 7,
  t: 1_800_000_000 - (p.n - i) * 10, short_ratio: 1.5, day_ratio: 1.4,
}))
const ALL = new Map([BIG, SMALL].map(p => [p.source, rowsOf(p)]))

interface Call { tag: string; params: Record<string, unknown> }
let calls: Call[] = []
let failOnce: ((c: Call) => boolean) | null = null
let probeMax = 100
const fake = {
  query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
    const tag = /--\s*(oracles:[a-z-]+)/.exec(query)?.[1] ?? 'untagged'
    const call = { tag, params: query_params ?? {} }
    calls.push(call)
    if (failOnce?.(call)) { failOnce = null; throw new Error('boom') }
    let out: unknown[] = []
    if (tag === 'oracles:ema-pairs') out = [BIG, SMALL].map(({ source, asset_a, asset_b }) => ({ source, asset_a, asset_b }))
    else if (tag === 'oracles:ema') {
      const q = call.params as { src: string; cb: number; ce: number; hi: number; floor: number; lim: number }
      out = (ALL.get(q.src) ?? [])
        .filter(r => r.block_height > q.floor && r.block_height <= q.hi && (r.block_height > q.cb || (r.block_height === q.cb && r.event_index > q.ce)))
        .sort((x, y) => x.block_height - y.block_height || x.event_index - y.event_index)
        .slice(0, q.lim)
    } else if (tag === 'oracles:floor-probe') out = [{ m: probeMax }]
    return { json: async () => out }
  },
}

beforeEach(() => {
  __testing.reset()
  __testing.setClient(fake as never)
  calls = []; failOnce = null; probeMax = 100
  vi.useRealTimers()
})

const pairTimes = () => [...__testing.emaPairs().values()].map(p => [p.source, p.times.length])

describe('EMA ledger load', () => {
  it('pages a pair past the row guard by keyset and keeps every row once', async () => {
    await ensureEmaLedger()
    await __testing.emaInit()
    expect(pairTimes()).toEqual([['omnipool', BIG.n], ['bifrosto', SMALL.n]])
    const pages = calls.filter(c => c.tag === 'oracles:ema' && c.params.src === BIG.source)
    expect(pages).toHaveLength(Math.ceil(BIG.n / EMA_PAGE_ROWS) + (BIG.n % EMA_PAGE_ROWS === 0 ? 1 : 0))
    for (const p of pages) expect(p.params.lim).toBe(EMA_PAGE_ROWS)
  })

  it('leaves the served ledger untouched when a load fails, and its retry counts nothing twice', async () => {
    failOnce = c => c.tag === 'oracles:ema' && c.params.src === SMALL.source
    await ensureEmaLedger()
    await expect(__testing.emaInit()).rejects.toThrow('boom')
    expect(__testing.emaPairs().size).toBe(0)
    expect(__testing.emaComplete()).toBe(false)
    await new Promise(r => setTimeout(r, 0))
    expect(__testing.emaInit()).toBeNull()
    await ensureEmaLedger()
    await __testing.emaInit()
    expect(pairTimes()).toEqual([['omnipool', BIG.n], ['bifrosto', SMALL.n]])
  })

  it('reloads when a row lands below the tail’s floor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    await ensureEmaLedger(); await __testing.emaInit()
    const loads = () => calls.filter(c => c.tag === 'oracles:ema-pairs').length
    expect(loads()).toBe(1)
    vi.setSystemTime(1_800_000_400_000) // tail due; the first probe sets the baseline
    await ensureEmaLedger()
    expect(calls.filter(c => c.tag === 'oracles:floor-probe')).toHaveLength(1)
    expect(loads()).toBe(1)
    probeMax = 200 // a backfilled row below the floor
    vi.setSystemTime(1_800_000_800_000)
    await ensureEmaLedger()
    await __testing.emaInit()
    expect(loads()).toBe(2)
    expect(pairTimes()).toEqual([['omnipool', BIG.n], ['bifrosto', SMALL.n]])
  })

  it('keys the long-chart buckets on the range, so a 12M chart is cached across seconds', async () => {
    const pair = { sourceHex: SMALL.source, source: 'bifrosto', a: 5, b: 15, times: [], timesSorted: true, hourly: new Map(), recent: [] }
    await __testing.emaBuckets(pair as never, '12m', 1_000, 86_400)
    await __testing.emaBuckets(pair as never, '12m', 1_001, 86_400)
    expect(calls.filter(c => c.tag === 'oracles:ema-long')).toHaveLength(1)
  })
})

const asset = (assetId: number) => ({ assetId, iconAssetId: assetId, symbol: `#${assetId}`, name: null, decimals: 12, parachainId: null })

describe('market overlay subject', () => {
  it('follows the consumer that reads the feed directly before one that reads it as an input', () => {
    const subjects = feedSubjects([
      { kind: 'reserve', market: 'core', marketLabel: 'Money Market', asset: asset(4200) as never, via: '0xgeth', depth: 1 },
      { kind: 'reserve', market: 'core', marketLabel: 'Money Market', asset: asset(34) as never, via: '0xethadapter', depth: 0 },
    ], new Map())
    expect(subjects.map(s => s.asset.assetId)).toEqual([34, 4200])
  })
  it('prices a peg in its pool’s other leg, an aToken leg through its underlying, a HOLLAR leg as USD', () => {
    const pools = new Map([[90001, { assetIds: [40, 1001] }], [143, { assetIds: [43, 222] }]])
    const [peg] = feedSubjects([{ kind: 'peg', poolId: 90001, pool: asset(90001) as never, asset: asset(40) as never, via: null, depth: 0 }], pools)
    expect(peg.quote?.assetId).toBe(5) // aDOT 1001 → DOT 5 (currentPriceAssetId)
    const [usd] = feedSubjects([{ kind: 'peg', poolId: 143, pool: asset(143) as never, asset: asset(43) as never, via: null, depth: 0 }], pools)
    expect(usd.quote).toBeNull()
  })
})

describe('EMA adapter labels', () => {
  const info = (a: number, b: number, source = 'bifrosto') => ({ period: 'TenMinutes' as const, source, assetA: a, assetB: b })
  it('states an orientation only when the adapter’s answer verifies it one way', () => {
    // The event's ratio is the max-id asset priced in the min-id one: 1 #15 = 1.6625 #5.
    expect(adapterEmaLabel(info(5, 15), '1.6625', { short: 1.6625 })).toMatch(/ #15\/#5 · TenMinutes$/)
    // The same pair answered the other way round.
    expect(adapterEmaLabel(info(5, 15), String(1 / 1.6625), { short: 1.6625 })).toMatch(/ #5\/#15 · TenMinutes$/)
  })
  it('names the pair without an orientation when nothing verifies it', () => {
    expect(adapterEmaLabel(info(670, 0, 'gigahdxs'), '1.0115', null)).toMatch(/ #670–#0 · TenMinutes$/)
    // A ratio within 1 % of 1 matches both ways round: no orientation.
    expect(adapterEmaLabel(info(5, 15), '1.004', { short: 1.004 })).toMatch(/ #5–#15 · TenMinutes$/)
  })
  it('names the all-zero source by its id', () => {
    expect(svc.emaSourceLabel('')).toBe('Source 0x0000000000000000')
    expect(adapterEmaLabel(info(10, 0, ''), '0.0073', null)).toBe('Source 0x0000000000000000 #10–#0 · TenMinutes')
  })
})
