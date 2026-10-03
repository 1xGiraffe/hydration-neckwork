import { describe, expect, it, vi } from 'vitest'
import {
  bestRoutes,
  buildRouteGraph,
  emptyRouteState,
  FLOOR_FEES,
  hopSpot,
  isPureOmnipool,
  parseAtokenValue,
  parseStableValue,
  routeFinder,
  routeLabel,
  routeEraAt,
  formatV3Value,
  parseRouteLabel,
  omniSlipFee,
  OMNI_SLIP_KEY,
  applyStateChange,
  parseV3Value,
  type Hop,
  type RouteState,
  type V3PoolState,
} from '../src/services/pairRoutes.ts'
import { getSqrtRatioAtTick, getTickAtSqrtRatio, tickTableFromRanges, v3QuoteExactIn } from '../src/services/uniswapV3Math.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { pairRouteHeldSql, pairRouteStaleHoursSql } from '../src/derivations/jobs.ts'
import { foldHour, pairRouteDailyRowsSql, pairRouteFeesSql, pairRouteLatestSql, ratioProduct, scaledToText, slipFeeChanges, v3RouteChanges, type StateChange, type V3EventRow } from '../src/services/pairRouteFold.ts'
import {
  groupRouteRows,
  mergeCoverage,
  mergeTailRows,
  overlayRouteCandles,
  pairPriceSource,
  queryRouteCandles,
  resolvePairPriceSource,
} from '../src/services/pairPriceSource.ts'
import { queryPairCandles } from '../src/services/crossPair.ts'

// Route-priced pair candles: the route search (services/pairRoutes.ts), the fold
// that turns per-block pool state into candles (services/pairRouteFold.ts) and the
// switch every pair reader goes through (services/pairPriceSource.ts).

const DECIMALS: Record<number, number> = {
  0: 12, 1: 12, 5: 10, 10: 6, 15: 10, 18: 18, 21: 6, 22: 6, 23: 6, 43: 6, 100: 18, 105: 18, 143: 18,
  222: 18, 690: 18, 1001: 10, 1002: 6, 1003: 6, 7000: 12, 7001: 12, 7002: 12,
}
const dec = (id: number) => DECIMALS[id] ?? 12
const W = 10n ** 18n

// Pool snapshots exactly as raw_block_snapshots stores them, at block 15,315,002.
const POOL_100 = '{"pool_id":100,"assets":"0x0a121517","reserves":["172780845","260724824308861569736","163881705","199760788"],"amplification":"320","fee":200,"total_issuance":"413548267230179471837","initial_amplification":320,"final_amplification":320,"initial_block":3640110,"final_block":3640110}'
const POOL_105 = '{"pool_id":105,"assets":"0x1517de","reserves":["164976984224","172810790445","265798109072773963232926"],"amplification":"222","fee":200,"total_issuance":"600000000000000000000000","initial_amplification":222,"final_amplification":222,"initial_block":9846902,"final_block":9846902}'
const POOL_143 = '{"pool_id":143,"assets":"0x2bde","reserves":["496174863268","543010732133374340273155"],"amplification":"100","fee":400,"total_issuance":"1047478053609110871642810","peg_multipliers":[["223946206836674346996321736404953349976","210776628074838468904614074450270372289"],["1","1"]],"initial_amplification":100,"final_amplification":100,"initial_block":11434337,"final_block":11434337}'

function stateWith(...pools: string[]): RouteState {
  const st = emptyRouteState()
  for (const json of pools) {
    const p = parseStableValue(json)!
    st.stable.set(p.poolId, p)
  }
  return st
}
const ss = (pool: number, from: number, to: number): Hop => ({ kind: 'ss', pool: `s:${pool}`, from, to })
const per18 = (r: { num: bigint; den: bigint } | null) => (r ? (r.num * W) / r.den : null)

describe('stableswap spot', () => {
  it('matches the Hydration SDK quote to the last digit on an unpegged pool', () => {
    // The SDK's TradeRouter.getBestSell(10, 222, 1 USDT) at block 15,315,002 routed
    // 10 →(4-Pool 100)→ 23 →(3-Pool-MRL 105)→ 222 and stated these hop spots.
    const st = stateWith(POOL_100, POOL_105)
    expect(per18(hopSpot(st, ss(100, 10, 23), dec))).toBe(1000518798753729729n)
    expect(per18(hopSpot(st, ss(105, 23, 222), dec))).toBe(1001963772977626284n)
  })

  it('applies the pool\'s stored peg multipliers (PRIME/HOLLAR, pool 143)', () => {
    const st = stateWith(POOL_143)
    const pegged = Number(per18(hopSpot(st, ss(143, 222, 43), dec))) / 1e18
    // The SDK's quote at the same block (0.940920740221844186) recomputes the peg
    // from its oracle at quote time; the stored peg trails it by ~4e-6.
    expect(Math.abs(pegged / 0.940920740221844186 - 1)).toBeLessThan(1e-5)
    // Without the multipliers the curve would price PRIME at ~par with HOLLAR.
    const unpegged = stateWith(POOL_143.replace(/"peg_multipliers":\[\[[^\]]*\],\["1","1"\]\],/, ''))
    const flat = Number(per18(hopSpot(unpegged, ss(143, 222, 43), dec))) / 1e18
    expect(Math.abs(flat - 1)).toBeLessThan(0.01)
    expect(Math.abs(pegged - flat)).toBeGreaterThan(0.05)
  })

  it('states a share-token leg per whole unit, the reciprocal of the opposite leg', () => {
    const st = stateWith(POOL_100)
    const out = Number(per18(hopSpot(st, ss(100, 100, 10), dec))) / 1e18
    const back = Number(per18(hopSpot(st, ss(100, 10, 100), dec))) / 1e18
    // 4-Pool's NAV is ~1.9266 dollars per share (796 USD over 413.5 shares).
    expect(out).toBeGreaterThan(1.9)
    expect(out).toBeLessThan(1.95)
    expect(Math.abs(out * back - 1)).toBeLessThan(1e-6)
  })
})

/* ───────────── synthetic route graphs ───────────── */

/** A v3 pool holding `liquidity` in one range of ±`width` spacings around its price. */
function v3Pool(t0: number, t1: number, sqrtP: bigint, liquidity: bigint, feePpm: number, width = 10, spacing = 60): V3PoolState {
  const tick = getTickAtSqrtRatio(sqrtP)
  const lower = (Math.floor(tick / spacing) - width) * spacing, upper = (Math.floor(tick / spacing) + width + 1) * spacing
  return { t0, t1, sqrtP, tick, liquidity, feePpm, tickSpacing: spacing, ticks: tickTableFromRanges([{ tickLower: lower, tickUpper: upper, net: liquidity }]) }
}

const omni = (st: RouteState, id: number, reserve: bigint, hub: bigint, tradable = 15) =>
  st.omni.set(id, { reserve, hub, tradable })
const ONE = 10n ** 12n

describe('route search', () => {
  it('prices a single Omnipool crossing as the ratio of the two hub prices, and never buys the hub', () => {
    const st = emptyRouteState()
    omni(st, 7000, 1_000n * ONE, 500n * ONE)
    omni(st, 7001, 2_000n * ONE, 250n * ONE)
    const r = hopSpot(st, { kind: 'omni', pool: 'omni', from: 7000, to: 7001 }, dec)!
    // (500/1000) / (250/2000) = 4
    expect(ratioProduct([r])).toBe(4n * 10n ** 30n)
    const graph = buildRouteGraph(st, dec, FLOOR_FEES)
    expect((graph.trusted.get(7000) ?? []).some(e => e.to === 1)).toBe(false)
    expect((graph.trusted.get(1) ?? []).map(e => e.to).sort()).toEqual([7000, 7001])
    const route = routeFinder(graph)(7000, 7001)!
    expect(isPureOmnipool(route.hops)).toBe(true)
  })

  it('respects the Omnipool tradability bits', () => {
    const st = emptyRouteState()
    omni(st, 7000, 1_000n * ONE, 500n * ONE, 1) // sell only
    omni(st, 7001, 2_000n * ONE, 250n * ONE)
    const find = routeFinder(buildRouteGraph(st, dec, FLOOR_FEES))
    expect(find(7000, 7001)).toBeDefined()
    expect(find(7001, 7000)).toBeUndefined()
  })

  it('prefers a cheaper stableswap path to the Omnipool at the same spot, and crosses each pool once', () => {
    const st = stateWith(POOL_100)
    // USDT (10) and USDC (21) both listed in the Omnipool at ~the 4-Pool's spot.
    omni(st, 10, 100_000n * 10n ** 6n, 50_000n * ONE)
    omni(st, 21, 100_000n * 10n ** 6n, 50_000n * ONE)
    const usd = new Map([[10, 1], [21, 1], [18, 1], [23, 1]])
    const route = routeFinder(buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1, usd }))(10, 21)!
    expect(routeLabel(route.hops)).toBe('ss:100:10>21')
    const omniHops = route.hops.filter(h => h.kind === 'omni').length
    expect(omniHops).toBeLessThanOrEqual(1)
  })

  it('rates routes by the round trip, so an off-market spot wins nothing and a dust pool is no venue', () => {
    const st = emptyRouteState()
    omni(st, 7000, 1_000_000n * ONE, 1_000_000n * ONE)
    omni(st, 7001, 1_000_000n * ONE, 1_000_000n * ONE)
    // An XYK pair between two Omnipool assets is never used (both endpoints are
    // trusted); a v3 pool is, so make the dust venue a v3 pool 5 % off market.
    st.v3.set('0xdust', v3Pool(7000, 7001, (105n * 2n ** 96n) / 100n, 1000n, 3000))
    const usd = new Map([[7000, 1], [7001, 1]])
    // Unsized, a round trip cancels the spot: only the fees both ways remain, so a
    // 5 % better price buys the dust pool nothing (both venues charge 0.3 % a way).
    const spotOnly = routeFinder(buildRouteGraph(st, dec, FLOOR_FEES))(7000, 7001)!
    expect(spotOnly.rate).toBeCloseTo(0.997 * 0.997, 12)
    // Sized, the dust pool cannot carry the floor trade within its depth: no venue at all.
    const graph = buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1_000, usd })
    expect((graph.trusted.get(7000) ?? []).some(e => e.hop.kind === 'v3')).toBe(false)
    expect(routeFinder(graph)(7000, 7001)!.hops[0]!.kind).toBe('omni')
    // The route is the same read either way: one route per pair.
    expect(routeLabel(routeFinder(graph)(7001, 7000)!.hops)).toBe('omni:7001>7000')
  })

  it('rates a share leg by the pool\'s own remove-liquidity math, so a drained pool carries no route', () => {
    // A two-asset pool down to dust (pool 101's real reserves in 2024), whose share
    // still sits in the Omnipool at a healthy hub price.
    const st = stateWith('{"pool_id":7101,"assets":[7001,7002],"reserves":["3971507","104388"],"amplification":"5","fee":200,"total_issuance":"28254203045956876"}')
    omni(st, 7000, 1_000_000n * ONE, 1_000_000n * ONE)
    omni(st, 7101, 1_000n * 10n ** 18n, 1_000_000n * ONE)
    DECIMALS[7101] = 18; DECIMALS[7001] = 8; DECIMALS[7002] = 8
    const usd = new Map([[7000, 1]])
    expect(routeFinder(buildRouteGraph(st, dec, FLOOR_FEES))(7000, 7002)).toBeDefined()
    expect(routeFinder(buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1_000, usd }))(7000, 7002)).toBeUndefined()
    // Nor the other way: the pool still takes a deposit, but a share it mints
    // could never be redeemed, so the pair is not routed through it either way.
    expect(routeFinder(buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1_000, usd: new Map([[7000, 1], [7002, 60_000]]) }))(7002, 7000)).toBeUndefined()
  })

  it('reaches an XYK-only asset through its own pool, and ignores XYK between trusted endpoints', () => {
    const st = emptyRouteState()
    omni(st, 7000, 1_000n * ONE, 1_000n * ONE)
    omni(st, 7001, 1_000n * ONE, 1_000n * ONE)
    st.xyk.set('acct1', { a: 7002, b: 7000, ra: 1_000n * ONE, rb: 1_000n * ONE })
    // A far better XYK price between the two trusted assets must not be used.
    st.xyk.set('acct2', { a: 7000, b: 7001, ra: 1n * ONE, rb: 100n * ONE })
    const routes = bestRoutes(buildRouteGraph(st, dec, FLOOR_FEES), [7000, 7001, 7002])
    expect(routeLabel(routes.get('7000:7001')!.hops)).toBe('omni:7000>7001')
    expect(routeLabel(routes.get('7001:7002')!.hops)).toBe('omni:7001>7000|xyk:acct1:7000>7002')
    expect(routeLabel(routes.get('7000:7002')!.hops)).toBe('xyk:acct1:7000>7002')
  })

  it('routes through stableswap and money-market wraps only in the eras the router could', () => {
    const st = stateWith(POOL_100)
    omni(st, 10, 100_000n * 10n ** 6n, 50_000n * ONE)
    omni(st, 5, 100_000n * 10n ** 10n, 50_000n * ONE)
    st.atokens = [[5, 1001]]
    const usd = new Map([[10, 1], [21, 1], [18, 1], [23, 1], [5, 1]])
    const at = (block: number) => routeFinder(buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1, usd }, routeEraAt(block)))
    // Before runtime 207: USDC (21) reaches USDT (10) only by a direct pool swap, never onward.
    expect(routeLabel(at(4_000_000)(21, 10)!.hops)).toBe('ss:100:21>10')
    expect(at(4_000_000)(21, 5)).toBeUndefined()
    expect(at(4_600_000)(21, 5)!.hops.map(h => h.kind)).toEqual(['ss', 'omni'])
    // aDOT (1001) is a wrap of DOT the router could take only from runtime 305.
    expect(at(7_000_000)(1001, 5)).toBeUndefined()
    expect(routeLabel(at(7_400_000)(1001, 5)!.hops)).toBe('aave:5:1001:1001>5')
  })

  it('reads the snapshot\'s equivalence lists in both encodings', () => {
    expect(parseAtokenValue('[[5,1001],[10,1002]]')).toEqual([[5, 1001], [10, 1002]])
    expect(parseAtokenValue('["0x6804",[110,1110]]')).toEqual([[110, 1110], [104, 4]])
  })
})

describe('uniswap v3 state', () => {
  const ev = (b: number, name: string, extra: Partial<V3EventRow>): V3EventRow => ({
    pool: '0xpool', b, ei: 0, name, sp: '0', tick: 0, tl: 0, tu: 0, liq: '0', t0: 1001, t1: 222, fee: 3000, spacing: 60, ...extra,
  })
  const SP = (2n ** 96n).toString()

  it('reads active liquidity from the range book at the swap tick, never the Swap log field, and carries the tick table', () => {
    const changes = v3RouteChanges([
      ev(10, 'Initialize', { sp: SP, tick: 0 }),
      ev(11, 'Mint', { tl: -60, tu: 60, liq: '1000' }),
      // A swap that left the only range: the log says 5000, the book says 0.
      ev(20, 'Swap', { sp: SP, tick: 100, liq: '5000' }),
      ev(30, 'Mint', { tl: 60, tu: 120, liq: '700' }),
      ev(40, 'Swap', { sp: SP, tick: 10, liq: '0' }),
    ], 15)
    const states = changes.map(c => [c.b, parseV3Value(c.v)!] as const)
    // The baseline at the range's first block (15), then one change per log block.
    expect(states.map(([b, p]) => [b, p.liquidity])).toEqual([[15, 1000n], [20, 0n], [30, 700n], [40, 1000n]])
    expect(states.map(([, p]) => p.tick)).toEqual([0, 100, 100, 10])
    expect(states[3]![1].ticks).toEqual([{ tick: -60, liquidityNet: 1000n }, { tick: 60, liquidityNet: -300n }, { tick: 120, liquidityNet: -700n }])
    expect(states[3]![1].tickSpacing).toBe(60)
    expect(formatV3Value(states[3]![1])).toBe(changes[3]!.v)
    // A pool holding no liquidity in any range is no venue; one whose active
    // liquidity is 0 between ranges still is (a trade crosses into the next range).
    const st = emptyRouteState()
    st.v3.set('0xpool', { ...states[1]![1], ticks: [] })
    expect(buildRouteGraph(st, dec, FLOOR_FEES).trusted.size).toBe(0)
    st.v3.set('0xpool', states[1]![1])
    expect(buildRouteGraph(st, dec, FLOOR_FEES).trusted.size).toBe(2)
  })

  it('makes a pool a candidate only from its own first price-bearing log', () => {
    expect(v3RouteChanges([ev(50, 'Mint', { tl: -60, tu: 60, liq: '1000' })], 10)).toEqual([])
  })

  it('rates a v3 hop by the pool\'s exact swap, across ranges beyond the active one', () => {
    // The live USDT→DOT shape: a thin range around the price and the depth just
    // beside it. Rated within the active range only, the hop would return almost
    // nothing for a $1,000 trade; the pool's swap crosses into the deep range.
    const sqrtP = getSqrtRatioAtTick(30)
    const thin = 10n ** 9n, deep = 10n ** 18n
    const pool: V3PoolState = {
      t0: 7300, t1: 7301, sqrtP, tick: 30, liquidity: thin, feePpm: 500, tickSpacing: 10,
      ticks: tickTableFromRanges([{ tickLower: 20, tickUpper: 40, net: thin }, { tickLower: -6000, tickUpper: 20, net: deep }, { tickLower: 40, tickUpper: 6000, net: deep }]),
    }
    const st = emptyRouteState()
    omni(st, 7300, 1_000_000n * ONE, 1_000_000n * ONE)
    omni(st, 7301, 1_000_000n * ONE, 1_000_000n * ONE)
    st.v3.set('0xv3', pool)
    const usd = new Map([[7300, 1], [7301, 1]])
    const graph = buildRouteGraph(st, dec, FLOOR_FEES, { refUsd: 1_000, usd })
    const edge = graph.trusted.get(7300)!.find(e => e.hop.kind === 'v3')!
    const swapPool = { sqrtPriceX96: sqrtP, tick: 30, liquidity: thin, fee: 500, tickSpacing: 10, ticks: pool.ticks }
    const exact = v3QuoteExactIn(swapPool, true, 1_000n * ONE)!
    expect(exact.after.crossed).toBeGreaterThan(0)
    // Rated at the full $1,000 (the pool is deep), as a round trip: the exact
    // swap out, and its proceeds swapped straight back at the same state (the
    // spread at size: fees, impact and the thin range's gap, both ways).
    expect(graph.ladder[edge.cap]).toBe(1_000)
    const back = v3QuoteExactIn(swapPool, false, exact.amountOut)!
    expect(edge.rt(edge.cap)).toBeCloseTo((Number(exact.amountOut) / Number(1_000n * ONE)) * (Number(back.amountOut) / Number(exact.amountOut)), 9)
    // The deep ranges carry it: a within-range-only rating would have returned ~0.
    expect(edge.rt(edge.cap)).toBeGreaterThan(0.99)
    expect(routeFinder(graph)(7300, 7301)!.hops[0]!.kind).toBe('v3')
  })
})

describe('the route in force', () => {
  // Two stableswap pools on the same pair at different prices: the deeper one rates
  // better, until the other grows at block 9,000,103 (inside the first bucket).
  const HOUR = 1_790_000_000 - (1_790_000_000 % 3600)
  const E = '000000000000'
  const pool = (id: number, a: string, b: string) => `{"pool_id":${id},"assets":[7600,7601],"reserves":["${a}${E}","${b}${E}"],"amplification":"2","fee":200,"total_issuance":"1000000000000000000000"}`
  const blocks = [9_000_100, 9_000_101, 9_000_103, 9_000_104, 9_000_105].map((b, i) => ({ b, t: HOUR + [10, 100, 200, 400, 500][i]! }))
  const changes: StateChange[] = [
    { k: 's:7610', b: 9_000_100, v: pool(7610, '5000', '5000'), lastb: 9_000_105 },
    { k: 's:7611', b: 9_000_100, v: pool(7611, '1000', '1300'), lastb: 9_000_105 },
    { k: 's:7611', b: 9_000_103, v: pool(7611, '200000', '260000'), lastb: 9_000_105 },
  ]
  const run = (switchMargin?: number) => foldHour({
    hour: HOUR, blocks, changes, priced: [7600, 7601], usd: new Map([[7600, 1], [7601, 1]]), fees: FLOOR_FEES,
    decimals: () => 12, reservePairs: new Set(), computedAt: '2026-01-01 00:00:00', switchMargin,
  }).rows

  it('switches at the block the challenger wins: an intra-candle move, and the next candle opens at the close', () => {
    const [b0, b1, hour] = run()
    expect([b0!.route, b0!.routes, b0!.open, b0!.close]).toEqual(['ss:7611:7600>7601', 2, b0!.low, b0!.high])
    expect(Number(b0!.close) / Number(b0!.open)).toBeGreaterThan(1.05)
    expect(b1!.open).toBe(b0!.close)
    expect([hour!.iv, hour!.routes]).toEqual(['1h', 2])
  })

  it('re-rates without failing when a candidate pool leaves the state mid-bucket', () => {
    // Pool 7611 last appears at 9,000,101: removed at the next block, inside the bucket.
    const gone = changes.filter(c => c.b === 9_000_100).map(c => (c.k === 's:7611' ? { ...c, lastb: 9_000_101 } : c))
    const rows = foldHour({
      hour: HOUR, blocks, changes: gone, priced: [7600, 7601], usd: new Map([[7600, 1], [7601, 1]]), fees: FLOOR_FEES,
      decimals: () => 12, reservePairs: new Set(), computedAt: '2026-01-01 00:00:00',
    }).rows
    expect(rows.filter(r => r.iv === '5min').every(r => r.route === 'ss:7610:7600>7601')).toBe(true)
  })

  it('keeps the route in force unless a candidate beats it by the margin', () => {
    const rows = run(1)
    expect(rows.every(r => r.route === 'ss:7610:7600>7601' && r.routes === 1)).toBe(true)
    expect(rows[1]!.open).toBe(rows[0]!.close)
  })
})

describe('route validity, the Omnipool candidate and the hour seed', () => {
  const HOUR = 1_790_000_000 - (1_790_000_000 % 3600)
  const E = '000000000000'
  const pool = (id: number, a: string, b: string) => `{"pool_id":${id},"assets":[7600,7601],"reserves":["${a}${E}","${b}${E}"],"amplification":"2","fee":200,"total_issuance":"1000000000000000000000"}`
  const blocks = [9_000_100, 9_000_101, 9_000_103, 9_000_104, 9_000_105].map((b, i) => ({ b, t: HOUR + [10, 100, 200, 400, 500][i]! }))
  const fold = (changes: StateChange[], seed?: Map<string, string>) => foldHour({
    hour: HOUR, blocks, changes, priced: [7600, 7601], usd: new Map([[7600, 1], [7601, 1]]), fees: FLOOR_FEES,
    decimals: () => 12, reservePairs: new Set(), computedAt: '2026-01-01 00:00:00', seed,
  }).rows

  it('never publishes a stale close as complete: a route that loses its only pool leaves the bucket incomplete', () => {
    const rows = fold([{ k: 's:7610', b: 9_000_100, v: pool(7610, '5000', '5000'), lastb: 9_000_101 }])
    const five = rows.filter(r => r.iv === '5min')
    expect(five[0]!.complete).toBe(0)
    expect(rows.find(r => r.iv === '1h')!.complete).toBe(0)
  })

  it('keeps the Omnipool crossing as a candidate: a bucket it prices throughout has no row, and a switch to it is priced by it', () => {
    const omniV = `${100_000n * 10n ** 12n},${100_000n * 10n ** 12n},15`
    const base: StateChange[] = [
      { k: 'o:7600', b: 9_000_100, v: omniV, lastb: 9_000_105 },
      { k: 'o:7601', b: 9_000_100, v: omniV, lastb: 9_000_105 },
    ]
    // No stableswap: the Omnipool alone, never stored.
    expect(fold(base).filter(r => r.iv === '5min')).toEqual([])
    // A deep cheap stableswap wins at first, then is drained to dust at 9,000,103:
    // the price moves to the Omnipool crossing inside the candle.
    const rows = fold([...base,
      { k: 's:7610', b: 9_000_100, v: pool(7610, '2000000', '2000000'), lastb: 9_000_105 },
      { k: 's:7610', b: 9_000_103, v: pool(7610, '20', '30'), lastb: 9_000_105 },
    ]).filter(r => r.iv === '5min')
    expect(rows[0]!.routes).toBe(2)
    expect(rows[0]!.route).toBe('omni:7600>7601')
    expect(rows[0]!.close).toBe('1.000000000000000000000000000000')
    expect(rows[0]!.complete).toBe(1)
  })

  it('starts the hour on the previous hour\'s closing route unless a candidate beats it by the margin', () => {
    const two: StateChange[] = [
      { k: 's:7610', b: 9_000_100, v: pool(7610, '5000', '5000'), lastb: 9_000_105 },
      { k: 's:7611', b: 9_000_100, v: pool(7611, '4990', '5000'), lastb: 9_000_105 },
    ]
    const fresh = fold(two).filter(r => r.iv === '5min')
    expect(fresh[0]!.route).toBe('ss:7610:7600>7601')
    const seeded = fold(two, new Map([['7600:7601', 'ss:7611:7600>7601']])).filter(r => r.iv === '5min')
    expect(seeded[0]!.route).toBe('ss:7611:7600>7601')
    expect(seeded[0]!.routes).toBe(1)
    // The hourly row names the route in force at the close: the next hour's seed.
    expect(fold(two).find(r => r.iv === '1h')!.route).toBe('ss:7610:7600>7601')
  })

  it('reads a route label back into its hops', () => {
    for (const label of ['omni:5>10', 'aave:5:1001:5>1001|v3:0xabc:1001>222|ss:111:222>1002', 'xyk:0xdeadbeef:25>5']) {
      expect(routeLabel(parseRouteLabel(label)!)).toBe(label)
    }
    expect(parseRouteLabel('nonsense')).toBeNull()
  })
})

describe('a new v3 pool', () => {
  // Hour of 5-minute buckets; the pool is created, initialised and minted into at
  // block 103 (the second bucket), at the Omnipool's price, with a lower fee.
  const HOUR = 1_790_000_000 - (1_790_000_000 % 3600)
  const blocks = [{ b: 100, t: HOUR + 10 }, { b: 101, t: HOUR + 100 }, { b: 103, t: HOUR + 310 }, { b: 104, t: HOUR + 400 }, { b: 105, t: HOUR + 700 }]
  const omniState: StateChange[] = [
    { k: 'o:7300', b: 100, v: `${1_000_000n * ONE},${1_000_000n * ONE},15`, lastb: 105 },
    { k: 'o:7301', b: 100, v: `${1_000_000n * ONE},${1_000_000n * ONE},15`, lastb: 105 },
  ]
  const log = (b: number, ei: number, name: string, extra: Partial<V3EventRow>): V3EventRow => ({
    pool: '0xnew', b, ei, name, sp: '0', tick: 0, tl: 0, tu: 0, liq: '0', t0: 7300, t1: 7301, fee: 500, spacing: 10, ...extra,
  })
  const logs = [
    log(103, 1, 'Initialize', { sp: (2n ** 96n).toString(), tick: 0 }),
    log(103, 2, 'Mint', { tl: -1000, tu: 1000, liq: (10n ** 20n).toString() }),
  ]
  const fold = (b0: number, rows: V3EventRow[]) => foldHour({
    hour: HOUR, blocks: blocks.filter(b => b.b >= b0), changes: [...omniState.map(c => ({ ...c, b: Math.max(c.b, b0) })), ...v3RouteChanges(rows, b0)],
    priced: [7300, 7301], usd: new Map([[7300, 1], [7301, 1]]), fees: FLOOR_FEES, decimals: dec, reservePairs: new Set(), computedAt: '2026-01-01 00:00:00',
  }).rows.filter(r => r.iv === '5min')

  it('enters the routes from the bucket it was created in, and not before', () => {
    const rows = fold(100, logs)
    // Bucket 0: only the Omnipool (pure-Omnipool, so no stored row). From bucket 1 on: the new pool.
    const at = (sec: number) => new Date((HOUR + sec) * 1000).toISOString().slice(0, 19).replace('T', ' ')
    expect(rows.map(r => [r.interval_start, r.route])).toEqual([[at(300), 'v3:0xnew:7300>7301'], [at(600), 'v3:0xnew:7300>7301']])
    expect(rows[0]!.first_block).toBe(103)
    expect(rows[0]!.open).toBe('1.000000000000000000000000000000')
  })

  it('is in the baseline of every later hour, from the logs before the hour', () => {
    // A later hour starting at block 104 sees the pool from its first block on.
    const rows = fold(104, logs)
    expect(rows[0]!.first_block).toBe(104)
    expect(rows.every(r => r.route === 'v3:0xnew:7300>7301')).toBe(true)
  })
})

describe('round-trip, depth-adaptive route choice', () => {
  // Two USD stables in a small stableswap pool ($800 a side) and in the Omnipool,
  // plus a third reachable only through that pool.
  const small = (r: string) => `{"pool_id":7510,"assets":[7501,7502],"reserves":["${r}","${r}"],"amplification":"100","fee":200,"total_issuance":"${r}000000000000"}`
  const build = (reserve: string, refUsd = 1_000) => {
    const st = stateWith(small(reserve))
    omni(st, 7500, 1_000_000n * ONE, 1_000_000n * ONE)
    omni(st, 7501, 1_000_000n * 10n ** 6n, 1_000_000n * ONE)
    return buildRouteGraph(st, dec, FLOOR_FEES, { refUsd, usd: new Map([[7500, 1], [7501, 1], [7502, 1]]) })
  }
  DECIMALS[7501] = 6; DECIMALS[7502] = 6; DECIMALS[7510] = 18

  it('routes a thin pair through its real market at a trade that market can carry', () => {
    const graph = build('800000000') // $800 a side
    const route = routeFinder(graph)(7500, 7502)!
    expect(routeLabel(route.hops)).toBe('omni:7500>7501|ss:7510:7501>7502')
    // 1 % of $800 is $8: rated at the $10 floor, not at $1,000 (which the pool cannot carry).
    expect(graph.ladder[route.level]).toBe(10)
    expect(route.rate).toBeGreaterThan(0.99)
  })

  it('keeps a pool whose thinner side holds less than the floor trade out', () => {
    expect(routeFinder(build('8000000'))(7500, 7502)).toBeUndefined() // $8 a side
    expect(routeFinder(build('12000000'))(7500, 7502)).toBeDefined() // $12 a side
  })

  it('chooses one route per pair: the route found either way is the same, reversed', () => {
    const graph = build('5000000000')
    const find = routeFinder(graph)
    const ids = [7500, 7501, 7502, 7510]
    for (const a of ids) for (const b of ids) {
      if (a === b) continue
      const there = find(a, b)!, back = find(b, a)!
      expect(routeLabel(back.hops)).toBe(routeLabel([...there.hops].reverse().map(h => ({ ...h, from: h.to, to: h.from }))))
      // Rated from either end the round trip differs only by the curve's asymmetry at size.
      expect(back.rate).toBeCloseTo(there.rate, 6)
    }
  })
})

describe('the Omnipool slip fee', () => {
  it('is the runtime\'s first-trade slip: |Δ| / (Q₀ ± Δ) of the hub amount, capped at the maximum', () => {
    const Q = 1e17, d = 1e14
    // Sold side: hub leaves the pool (Δ < 0), denominator Q₀ − Δ.
    expect(omniSlipFee(Q, -d, 0.25)).toBeCloseTo((d / (Q - d)) * d, 0)
    // Bought side: hub enters the pool, denominator Q₀ + Δ.
    expect(omniSlipFee(Q, d, 0.25)).toBeCloseTo((d / (Q + d)) * d, 0)
    // The cap binds for a trade the size of the pool side.
    expect(omniSlipFee(Q, Q, 0.25)).toBe(0.25 * Q)
    // Unset (0): no slip.
    expect(omniSlipFee(Q, d, 0)).toBe(0)
  })

  it('makes a larger trade through the Omnipool pay a larger fee, and is read from the indexed SlipFeeSet', () => {
    const st = emptyRouteState()
    omni(st, 7400, 1_000n * ONE, 1_000n * ONE)
    omni(st, 7401, 1_000n * ONE, 1_000n * ONE)
    const rate = (refUsd: number) => buildRouteGraph(st, dec, FLOOR_FEES, { refUsd, usd: new Map([[7400, 1], [7401, 1]]) })
      .trusted.get(7400)!.find(e => e.to === 7401)!.rt(0)!
    const noSlip = rate(1)
    for (const c of slipFeeChanges([{ b: 5, permill: 250000 }], 10)) applyStateChange(st, c.k, c.v)
    expect(st.omniMaxSlipFee).toBe(0.25)
    // A 1-unit trade in a 1,000-unit pool: ~0.1 % slip per side on top of the fees.
    expect(rate(1)).toBeLessThan(noSlip * (1 - 0.0015))
    expect(rate(10)).toBeLessThan(rate(1))
    applyStateChange(st, OMNI_SLIP_KEY, '0')
    expect(rate(1)).toBe(noSlip)
  })
})

describe('the fold\'s staleness', () => {
  const sql = pairRouteStaleHoursSql()
  it('re-marks every hour after a v3 log, not only its own (a pool\'s state replays all its logs)', () => {
    expect(sql).toMatch(/max\(max\(v3_ingest\)\) OVER \(ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\)/)
    expect(sql).toMatch(/greatest\(snap_ingest, v3_cum, price_ing\) AS src_ingest/)
  })
  it('re-marks an hour on a price row written for it, and on a decimals change of an asset it prices', () => {
    expect(sql).toContain('max(price_ingest) AS price_ing')
    expect(sql).toMatch(/dec_assets AS \(/)
    expect(sql).toContain('if(tupleElement(p, 1) <= toUnixTimestamp(bucket), tupleElement(p, 2), toUInt64(0)), dec_pairs')
    // Each list one array of pairs: two groupArray scalars over one CTE can list rows in different orders.
    expect(sql).not.toMatch(/groupArray\((created|b|first_t|h)\) FROM/)
    const schema = readFileSync(new URL('../../clickhouse/schema/014_pair_routes.sql', import.meta.url), 'utf8')
    expect(schema).toMatch(/pair_route_hour_watermarks_prices_mv .* FROM price_data\.prices GROUP BY hour;/)
  })
  it('reads the publication\'s time-only windows through the time-first projection, never FINAL', () => {
    const latest = pairRouteLatestSql('price_data.pair_route_ohlc_1h', ['route'])
    expect(latest).not.toContain('FINAL')
    expect(latest).toContain('HAVING argMax(is_deleted, computed_at) = 0')
    expect(pairRouteDailyRowsSql()).not.toContain('FINAL')
    const schema = readFileSync(new URL('../../clickhouse/schema/014_pair_routes.sql', import.meta.url), 'utf8')
    for (const t of ['5min', '1h', '1d']) expect(schema).toMatch(new RegExp(`pair_route_ohlc_${t} ADD PROJECTION IF NOT EXISTS p_time`))
  })
  it('reads the hourly route back with the held keys: it is the next hour\'s seed', () => {
    // The outer SELECT must carry the route the inner one aggregates; reading the
    // keys alone left every seed empty, so every hour started unseeded.
    expect(pairRouteHeldSql('1h')).toMatch(/SELECT asset_lo, asset_hi, toUnixTimestamp\(t_start\) AS t, v_route\s+FROM \(SELECT[\s\S]*argMax\(route, computed_at\) AS v_route/)
    expect(pairRouteHeldSql('5min')).toContain("'' AS v_route")
    expect(pairRouteHeldSql('5min')).not.toContain('argMax(route')
  })
  it('binds every placeholder the daily re-aggregation reads', () => {
    const names = [...new Set([...pairRouteDailyRowsSql().matchAll(/\{(\w+):/g)].map(m => m[1]))].sort()
    expect(names).toEqual(['from', 'hours', 'to'])
    const jobs = readFileSync(new URL('../src/derivations/jobs.ts', import.meta.url), 'utf8')
    expect(jobs).toMatch(/query: pairRouteDailyRowsSql\(\), query_params: \{ from: [^}]*, to: [^}]*, hours: dayHours \}/)
  })

  it('deduplicates replayed fee legs before estimating the Omnipool fees', () => {
    expect(pairRouteFeesSql()).toMatch(/argMax\(amount, ingested_at\) AS amount[\s\S]*GROUP BY pool_key, block_height, event_index, leg_kind, leg_index/)
  })
  it('compares each hour\'s stored rule fingerprint with the rule in force for it, scoped by venue', () => {
    expect(sql).toMatch(/der\.fp_min != fp\.fp OR der\.fp_max != fp\.fp/)
    expect(sql).toMatch(/tupleElement\(max\(der_rule\), 2\) AS fp_min/)
    expect(sql).toContain(`cityHash64('pair-route:v3', toUInt64(1))`)
    expect(sql).toContain(`cityHash64('pair-route:omni-slip', toUInt64(1))`)
    expect(sql).toContain(`cityHash64('pair-route:base', toUInt64(2))`)
  })
})

describe('v3 discovery is by topic, never by address', () => {
  const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/
  it('names no pool, factory or token address in the route code', () => {
    const files = ['src/services/pairRoutes.ts', 'src/services/pairRouteFold.ts', 'src/services/pairPriceSource.ts', 'src/services/uniswapV3Math.ts', 'src/services/uniswapV3Ranges.ts']
    for (const f of files) expect(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), f).not.toMatch(ADDRESS)
    const jobs = readFileSync(new URL('../src/derivations/jobs.ts', import.meta.url), 'utf8')
    const section = jobs.slice(jobs.indexOf('// ───────────────────────── pair_route_ohlc'))
    expect(section).not.toMatch(ADDRESS)
    const schema = readFileSync(new URL('../../clickhouse/schema/014_pair_routes.sql', import.meta.url), 'utf8')
    expect(schema).not.toMatch(ADDRESS)
  })

  it('re-marks hours on every log a pool\'s route state reads: PoolCreated, Initialize, Swap, Mint, Burn', () => {
    const dir = new URL('../../clickhouse/schema/', import.meta.url)
    const v3 = readFileSync(new URL('010_uniswap_v3.sql', dir), 'utf8')
    const topic = (name: string) => v3.match(new RegExp(`topic0 = '(0x[0-9a-f]{64})', '${name}'`))![1]!
    const created = v3.match(/uniswap_v3_pools_mv[\s\S]*?topic0 = '(0x[0-9a-f]{64})'/)![1]!
    const wm = readFileSync(new URL('014_pair_routes.sql', dir), 'utf8')
    const mv = wm.slice(wm.indexOf('pair_route_hour_watermarks_v3_mv'))
    const listed = [...mv.slice(mv.indexOf('topic0 IN')).matchAll(/'(0x[0-9a-f]{64})'/g)].map(m => m[1]).sort()
    expect(listed).toEqual([created, topic('Initialize'), topic('Swap'), topic('Mint'), topic('Burn')].sort())
    expect(readdirSync(dir).filter(f => f.endsWith('.sql')).length).toBeGreaterThan(10)
  })
})

/* ───────────── the fold ───────────── */

describe('the hourly fold', () => {
  const HOUR = 1_790_000_000 - (1_790_000_000 % 3600)
  const pool = (r0: string, r1: string) => `{"pool_id":102,"assets":"0x0a16","reserves":["${r0}","${r1}"],"amplification":"100","fee":200,"total_issuance":"1000000000000000000000","initial_amplification":100,"final_amplification":100,"initial_block":1,"final_block":1}`
  const blocks = [
    { b: 100, t: HOUR + 10 }, { b: 101, t: HOUR + 100 }, { b: 102, t: HOUR + 200 },
    { b: 103, t: HOUR + 310 }, { b: 104, t: HOUR + 400 },
  ]
  const changes: StateChange[] = [
    { k: 's:102', b: 100, v: pool('1000000000', '1000000000'), lastb: 104 },
    { k: 's:102', b: 101, v: pool('900000000', '1100000000'), lastb: 104 },
    { k: 's:102', b: 102, v: pool('1100000000', '900000000'), lastb: 104 },
    { k: 'o:0', b: 100, v: `${1000n * ONE},${100n * ONE},15`, lastb: 104 },
    { k: 'o:5', b: 100, v: `${1000n * 10n ** 10n},${100n * ONE},15`, lastb: 104 },
  ]
  const run = () => foldHour({
    hour: HOUR, blocks, changes, priced: [0, 5, 10, 22], usd: new Map([[10, 1], [22, 1], [0, 0.01], [5, 4]]), fees: FLOOR_FEES,
    decimals: dec, reservePairs: new Set(), computedAt: '2026-01-01 00:00:00',
  })

  it('writes 5-minute and hourly rows for route-priced pairs only, and states how far it folded', () => {
    const { rows, bucketsWithBlocks, lastBlock, lastTs } = run()
    expect([lastBlock, lastTs]).toEqual([104, HOUR + 400])
    expect(bucketsWithBlocks).toBe(2)
    // HDX/DOT is one Omnipool crossing: priced by the USD ratio, never stored.
    expect(rows.some(r => r.asset_lo === 0 && r.asset_hi === 5)).toBe(false)
    const five = rows.filter(r => r.iv === '5min' && r.asset_lo === 10 && r.asset_hi === 22)
    expect(five.map(r => r.interval_start)).toHaveLength(2)
    const [b0, b1] = five
    // Bucket 0 saw three states: balanced, USDT-heavy (USDT cheap), USDC-heavy.
    expect(Number(b0!.high)).toBeGreaterThan(Number(b0!.open))
    expect(Number(b0!.low)).toBeLessThan(Number(b0!.open))
    expect(b0!.close).toBe(b1!.open)
    expect(b0!.first_block).toBe(100)
    expect(b0!.last_block).toBe(102)
    const hour = rows.find(r => r.iv === '1h' && r.asset_lo === 10 && r.asset_hi === 22)!
    expect(hour.complete).toBe(1)
    expect(hour.open).toBe(b0!.open)
    expect(hour.close).toBe(b1!.close)
    expect(rows.some(r => r.asset_lo === 0 && r.asset_hi === 0)).toBe(false)
  })

  it('renders exact decimal text at 30 digits', () => {
    expect(scaledToText(10n ** 30n)).toBe('1.000000000000000000000000000000')
    expect(scaledToText(5n)).toBe('0.000000000000000000000000000005')
  })
})

/* ───────────── the reader and the switch ───────────── */

describe('the pair price source', () => {
  it('defaults to usd-ratio, and only the exact word switches it', () => {
    expect(pairPriceSource(undefined)).toBe('usd-ratio')
    expect(pairPriceSource('')).toBe('usd-ratio')
    expect(pairPriceSource('routes')).toBe('usd-ratio')
    expect(pairPriceSource(' Route ')).toBe('route')
    expect(resolvePairPriceSource('route')).toBe('route')
    expect(resolvePairPriceSource('nonsense')).toBe(pairPriceSource())
  })

  const T0 = 1_790_000_000 - (1_790_000_000 % 86_400)
  const S30 = (x: string) => {
    const [w, f = ''] = x.split('.')
    return `${w}.${f.padEnd(30, '0')}`
  }
  const row = (lo: number, hi: number, t: number, o: string, h: string, l: string, c: string, complete = 1) =>
    ({ lo, hi, t, open: S30(o), high: S30(h), low: S30(l), close: S30(c), complete })
  // Coverage: each folded hour → the timestamp of the newest block folded in it.
  const covered = (...hours: Array<[number, number, boolean?]>) => new Map(hours.map(([h, lt, full]) => [h, { lt, full: full ?? false }]))
  const fullHour = (h: number): [number, number, boolean] => [h, h + 3_570, true]

  it('names the window buckets the fold could not state: uncovered ones and ones whose row is incomplete', () => {
    const rows = [row(10, 22, T0, '1', '1', '1', '1'), row(10, 22, T0 + 300, '1', '1', '1', '1', 0)]
    const cov = covered(fullHour(T0))
    const out = groupRouteRows('5min', rows, true, cov, { start: T0, end: T0 + 3_600 + 600 })
    expect([...out.keys()]).toEqual([T0])
    // T0+300 incomplete; T0+600.. covered with no row (the Omnipool crossing); the next hour uncovered.
    expect([...out.fallback!].sort((a, b) => a - b)).toEqual([T0 + 300, T0 + 3_600, T0 + 3_900])
  })

  it('inverts a pair read the other way round, swapping high and low', () => {
    const rows = [row(10, 22, T0, '2', '4', '1', '2.5')]
    const cov = covered(fullHour(T0))
    const lo = groupRouteRows('5min', rows, true, cov).get(T0)!
    expect([lo.open, lo.high, lo.low, lo.close]).toEqual(['2.000000000000000000', '4.000000000000000000', '1.000000000000000000', '2.500000000000000000'])
    const hi = groupRouteRows('5min', rows, false, cov).get(T0)!
    expect([hi.open, hi.high, hi.low, hi.close]).toEqual(['0.500000000000000000', '1.000000000000000000', '0.250000000000000000', '0.400000000000000000'])
  })

  it('serves a coarse bucket only when every covered sub-bucket is route-priced', () => {
    // 15 minutes from three 5-minute rows; the second bucket misses one (a pure-Omnipool bucket).
    const rows = [
      row(10, 22, T0, '1', '1.2', '0.9', '1.1'),
      row(10, 22, T0 + 300, '1.1', '1.5', '1', '1.4'),
      row(10, 22, T0 + 600, '1.4', '1.4', '0.8', '1'),
      row(10, 22, T0 + 900, '1', '1', '1', '1'),
      row(10, 22, T0 + 1500, '1', '1', '1', '1'),
    ]
    const out = groupRouteRows('15min', rows, true, covered(fullHour(T0)))
    expect([...out.keys()]).toEqual([T0])
    const c = out.get(T0)!
    expect([c.open, c.high, c.low, c.close]).toEqual(['1.000000000000000000', '1.500000000000000000', '0.800000000000000000', '1.000000000000000000'])
    // An hour the fold has not covered is a hole, never a still-filling bucket.
    expect(groupRouteRows('15min', rows, true, covered()).size).toBe(0)
  })

  it('serves the still-filling bucket through the fold\'s coverage, and skips holes and incomplete hours', () => {
    const rows = [row(10, 22, T0, '1', '2', '1', '2'), row(10, 22, T0 + 3600, '2', '3', '2', '3'), row(10, 22, T0 + 7200, '3', '3', '3', '3')]
    // The fold covered 00:00–01:59 fully and stops 20 minutes into 02:00.
    const out = groupRouteRows('4h', rows, true, covered(fullHour(T0), fullHour(T0 + 3600), [T0 + 7200, T0 + 7200 + 1200]))
    expect(out.get(T0)?.close).toBe('3.000000000000000000')
    // The still-filling 15-minute bucket the coverage ends inside (02:15–02:30, folded to 02:20).
    const live = groupRouteRows('15min', [row(10, 22, T0 + 8100, '1', '1', '1', '1'), row(10, 22, T0 + 8400, '2', '2', '2', '2')], true,
      covered(fullHour(T0), fullHour(T0 + 3600), [T0 + 7200, T0 + 8400 + 120]))
    expect(live.get(T0 + 8100)?.close).toBe('2.000000000000000000')
    // 01:00 not folded while 02:00 is: a hole, the 4h bucket falls back.
    expect(groupRouteRows('4h', rows, true, covered(fullHour(T0), [T0 + 7200, T0 + 7200 + 1200])).size).toBe(0)
    expect(groupRouteRows('1h', [row(10, 22, T0, '1', '2', '1', '2', 0)], true, covered(fullHour(T0))).size).toBe(0)
  })

  it('extends the folded rows with the unfolded tail up to the head', () => {
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const tr = (t: number, o: string, h: string, l: string, c: string) => ({
      iv: '5min' as const, asset_lo: 10, asset_hi: 22, interval_start: iso(t), open: S30(o), high: S30(h), low: S30(l), close: S30(c),
      route: '', routes: 1, fee_ppm: 0, buckets: 1, complete: 1, first_block: 0, last_block: 0, computed_at: '',
    })
    // The fold reached 00:07 (into the 00:05 bucket); the tail finishes it and opens 00:10.
    const foldCov = covered([T0, T0 + 420])
    const stored = [row(10, 22, T0, '1', '1', '1', '1'), row(10, 22, T0 + 300, '1', '1.2', '1', '1.1')]
    const tail = { rows: [tr(T0 + 300, '1.1', '1.3', '0.9', '1.25'), tr(T0 + 600, '1.25', '1.25', '1.2', '1.2')], coverage: covered([T0, T0 + 700]), buckets: [T0 + 300, T0 + 600] }
    const cov = mergeCoverage(foldCov, tail.coverage)
    const five = groupRouteRows('5min', mergeTailRows(stored, tail, '5min'), true, cov)
    expect([...five.keys()]).toEqual([T0, T0 + 300, T0 + 600])
    const b = five.get(T0 + 300)!
    expect([b.open, b.high, b.low, b.close]).toEqual(['1.000000000000000000', '1.300000000000000000', '0.900000000000000000', '1.250000000000000000'])
    // At the hour grain the head hour is open, so it is served through the coverage's end.
    const hour = groupRouteRows('1h', mergeTailRows([row(10, 22, T0, '1', '1.2', '1', '1.1')], tail, '1h'), true, cov).get(T0)!
    expect([hour.open, hour.high, hour.close]).toEqual(['1.000000000000000000', '1.300000000000000000', '1.200000000000000000'])
    // A tail bucket whose route is one Omnipool crossing leaves the hour to the USD ratio.
    const omniTail = { rows: [], coverage: covered([T0, T0 + 400]), buckets: [T0 + 300] }
    expect(groupRouteRows('1h', mergeTailRows([row(10, 22, T0, '1', '1.2', '1', '1.1')], omniTail, '1h'), true, cov).size).toBe(0)
  })

  it('substitutes route-priced buckets and keeps every other candle as it was', () => {
    const cross = [{ intervalStart: 0, open: 'a' }, { intervalStart: 60, open: 'b' }]
    const route = new Map([[60, { intervalStart: 60, open: 'R', high: 'R', low: 'R', close: 'R' }], [120, { intervalStart: 120, open: 'S', high: 'S', low: 'S', close: 'S' }]])
    const out = overlayRouteCandles(cross, route, c => c.intervalStart, (rc, ex) => ({ intervalStart: rc.intervalStart, open: rc.open + (ex ? '+' : '') }))
    expect(out).toEqual([
      { intervalStart: 0, open: 'a', priceSource: 'usd-ratio' },
      { intervalStart: 60, open: 'R+', priceSource: 'route' },
      { intervalStart: 120, open: 'S', priceSource: 'route' },
    ])
  })

  function fakeClient() {
    const seen: string[] = []
    return {
      seen,
      query: vi.fn(async ({ query }: { query: string }) => {
        seen.push(query)
        if (query.includes('min(block_height) AS from_block')) return { json: async () => [{ from_block: 1, to_block: 1000 }] }
        if (query.includes('-- pair-route:candles')) return { json: async () => [row(10, 22, T0, '2', '2', '2', '2')] }
        if (query.includes('-- pair-route:coverage')) return { json: async () => [{ h: T0, lt: T0 + 3_598, full: 1 }] }
        return { json: async () => [{ interval_start: new Date(T0 * 1000).toISOString().slice(0, 19).replace('T', ' '), open: '1.0', high: '1.0', low: '1.0', close: '1.0', volume_buy: '5', volume_sell: '6', volume_total: '11' }] }
      }),
    }
  }
  const WINDOW = { baseId: 10, quoteId: 22, startTime: new Date(T0 * 1000), endTime: new Date((T0 + 3600) * 1000), interval: '5min' as const }

  it('in usd-ratio mode is the cross module candle for candle and never reads route candles', async () => {
    const client = fakeClient()
    const out = await queryPairCandles(client as never, WINDOW, 'usd-ratio')
    expect(out).toEqual([{ intervalStart: T0, open: '1.0', high: '1.0', low: '1.0', close: '1.0', volumeBuy: '5', volumeSell: '6', volumeTotal: '11' }])
    expect(client.seen.some(q => q.includes('pair_route_ohlc'))).toBe(false)
  })

  it('in route mode takes the route price and keeps the cross candle\'s volume', async () => {
    const client = fakeClient()
    const out = await queryPairCandles(client as never, WINDOW, 'route')
    expect(out).toEqual([{ intervalStart: T0, open: '2.000000000000000000', high: '2.000000000000000000', low: '2.000000000000000000', close: '2.000000000000000000', volumeBuy: '5', volumeSell: '6', volumeTotal: '11', priceSource: 'route' }])
  })

  it('reads the coverage from the hour a mid-hour window starts in', async () => {
    const client = fakeClient()
    await queryRouteCandles(client as never, { ...WINDOW, startTime: new Date((T0 + 1500) * 1000), interval: '5min' })
    const call = client.query.mock.calls.find(c => (c[0] as { query: string }).query.includes('-- pair-route:coverage'))!
    expect((call[0] as unknown as { query_params: { start: string } }).query_params.start).toBe(new Date(T0 * 1000).toISOString().slice(0, 19).replace('T', ' '))
  })

  it('reads one pair and the sentinels by primary-key prefix, for the interval it derives from', async () => {
    const client = fakeClient()
    await queryRouteCandles(client as never, { ...WINDOW, interval: '4h' })
    const q = client.seen.find(s => s.includes('-- pair-route:candles'))!
    // The pair's own primary-key prefix in the interval's own table, FINAL over that range only.
    expect(q).toContain('FROM price_data.pair_route_ohlc_1h FINAL')
    expect(q).toContain('asset_lo = {lo:UInt32} AND asset_hi = {hi:UInt32}')
  })
})
