import { describe, expect, it } from 'vitest'
import { addChartOmnipoolValue, addChartV3Value, addChartXykValue } from '../src/services/explorerService.ts'
import { assembleLpHistory, bucketPricerFrom, xykLegsByBucket, type CandleClose, type OmnipoolPrincipalHistory, type V3PrincipalHistory, type XykPrincipalHistory } from '../src/services/lpHistory.ts'
import { renderUsd } from '../src/services/valuation.ts'

// The value-history chart (float, getAccountHistory's addChart* helpers) and the
// LP-history surfaces (integer, assembleLpHistory) value the SAME loader output.
// Where every leg has a closed price at every bucket — so the chart's back-fill
// never engages — the two must agree per bucket to the cent. A drift here means
// the chart line and /liquidity-history disagree about one position.

const D = 86_400
const N = 3
const t0 = 300 * D
const bk = { N, endSec: (b: number) => t0 + (b + 1) * D }
const DEC = 12 // the synthetic decimals every asset has under an empty registry

// Per-asset closes per bucket (dollars, exact binary-safe decimals).
const PX: Record<number, number[]> = { 1: [10, 11, 12, 13], 10: [2, 2.5, 3, 3.25], 20: [1, 1, 0.5, 0.75], 0: [0.01, 0.0125, 0.015, 0.02] }
const closes = new Map<number, CandleClose[]>(Object.entries(PX).map(([id, series]) => [
  Number(id),
  series.map((px, b) => ({ closedAt: bk.endSec(b), close: BigInt(Math.round(px * 1e6)) * 10n ** 6n })),
]))
const chartPrice = (priceId: string, b: number) => PX[Number(priceId)]?.[b] ?? 0

const omnipool: OmnipoolPrincipalHistory = {
  legsByBucket: [
    [{ positionId: '1', assetId: 10, liquidity: 123_456_789_012_345n, hub: 0n, shares: 1n, farmed: false, depositId: null }],
    [{ positionId: '1', assetId: 10, liquidity: 123_456_789_012_345n, hub: 7_654_321_098n, shares: 1n, farmed: false, depositId: null },
     { positionId: '2', assetId: 0, liquidity: 98_765_432_109_876_543n, hub: 0n, shares: 1n, farmed: true, depositId: '5' }],
    [{ positionId: '2', assetId: 0, liquidity: 98_765_432_109_876_543n, hub: 1_000_000_000n, shares: 1n, farmed: true, depositId: '5' }],
    [],
  ],
  assetIds: [10, 0], fromBucket: 0, spans: new Map(),
}
const xyk: XykPrincipalHistory = {
  lpAssetIds: new Set([42]), underlyingAssetIds: [10, 20],
  stateByLp: new Map([[42, Array.from({ length: N + 1 }, (_, b) => ({ assetA: 10, assetB: 20, reserveA: 5_000_000_000_000_000n + BigInt(b), reserveB: 7_000_000_000_000_000n, totalShares: 999_999n }))]]),
  farmSharesByLp: new Map([[42, [0n, 3_333n, 3_333n, 0n]]]),
  poolByLp: new Map([[42, '0xpool']]), farmSpansByLp: new Map(),
}
// The chart sums direct + farmed before redeeming; with shares only on one side
// per bucket the floor is identical, which is the case the parity asserts.
const directSharesByLp = new Map([[42, [1_111n, 0n, 0n, 2_222n]]])
const v3: V3PrincipalHistory = {
  legsByBucket: [[], [{ kind: 'position', key: 'm:1', tokenId: '1', manager: 'm', pool: 'p', vault: null, shares: 1n, asset0: 10, asset1: 20, amount0: 4_000_000_000_001n, amount1: 9_999_999_999_999n }], [], []],
  assetIds: [10, 20], spans: new Map(),
}

describe('chart LP value ≡ assembleLpHistory where both are priced', () => {
  it('agrees per bucket within one cent across Omnipool, XYK and v3', () => {
    const chart = new Array(N + 1).fill(0)
    const exHdx = new Array(N + 1).fill(0)
    addChartXykValue(chart, exHdx, xykLegsByBucket(xyk, directSharesByLp, N), chartPrice, () => DEC)
    addChartOmnipoolValue(chart, exHdx, omnipool, chartPrice, () => DEC)
    addChartV3Value(chart, exHdx, v3, chartPrice, () => DEC)

    const lp = assembleLpHistory({ omnipool, xyk: { hist: xyk, directSharesByLp }, v3 }, bucketPricerFrom(closes, bk), bk)
    expect(lp.points.every(p => p.unpriced === 0)).toBe(true)
    for (let b = 0; b <= N; b++) {
      expect(Math.abs(Number(renderUsd(lp.points[b].usd)) - chart[b]), `bucket ${b}`).toBeLessThanOrEqual(0.01)
    }
    // And the fixture is not trivially zero anywhere it holds something.
    expect(chart.every(v => v > 0)).toBe(true)
  })

  it('takes the HDX position out of the ex-HDX curve whole, hub leg included', () => {
    const chart = new Array(N + 1).fill(0)
    const exHdx = new Array(N + 1).fill(0)
    addChartOmnipoolValue(chart, exHdx, omnipool, chartPrice, () => DEC)
    // Bucket 2 holds only the HDX (asset 0) position.
    expect(chart[2]).toBeGreaterThan(0)
    expect(exHdx[2]).toBe(0)
  })
})

// The explorer's /liquidity-history sits on the value chart's grid and must price
// it with the chart's candles. getAccountHistory reads ohlc_1d at every zoom, so a
// sub-day step priced on ohlc_1h would state the same bucket at a different price
// than the chart's LP line — the parity above would hold per grain and still miss
// it. Drive the real explorer path and read which candle table it asked for.
describe('explorer liquidity history prices on the chart\'s grain', async () => {
  const { buildLiquidityHistory, CHART_PRICE_GRAIN, initExplorerService } = await import('../src/services/explorerService.ts')
  const H = 3_600
  const T0 = Date.UTC(2026, 8, 1) / 1000
  const HOURS = 72
  const ACC = `0x${'5a'.repeat(32)}`
  const heightAt = (sec: number) => 1000 + Math.floor((sec - T0) / 6)
  const seen: string[] = []
  const rows = (query: string): Array<Record<string, unknown>> => {
    if (query.includes('max(block_height) AS top')) {
      return Array.from({ length: HOURS }, (_, i) => ({ h: T0 + i * H, top: heightAt(T0 + i * H) + 599, at_mark: heightAt(T0 + i * H), top_ts: T0 + i * H + 3_594 }))
    }
    if (query.includes('min(block_height) AS minb')) return [{ minb: 1000, maxb: heightAt(T0 + HOURS * H) - 1, mint: T0, maxt: T0 + HOURS * H - 6 }]
    if (query.includes('AS h, toUnixTimestamp(block_timestamp) AS t')) {
      return [...query.matchAll(/\d{4,}/g)].map(m => Number(m[0])).map(h => ({ h, t: T0 + (h - 1000) * 6 }))
    }
    if (query.includes('-- lp:omnipool-owner-intervals')) return [{ position_id: '9', ownership_kind: 'bare', deposit_id: '', valid_from_block: 900, from_ts: T0 - 600, valid_to_block: 0 }]
    if (query.includes('-- lp:omnipool-position-states')) return [{ position_id: '9', block_height: 900, event_kind: 'created', asset_id: 5, amount_raw: '1000000000000', shares_raw: '1000000000000', price_raw: String(10n ** 18n), active: 1 }]
    if (query.includes('-- lp:omnipool-pool-states')) return [{ asset_id: 5, b: -1, reserve: '1000000000000000', hub_reserve: '1000000000000000', shares: '1000000000000000' }]
    if (query.includes('-- lp:bucket-closes')) return [{ asset_id: 5, closed_at: T0, px: '2' }]
    return []
  }
  initExplorerService({
    query: async (o: { query: string }) => { seen.push(o.query); return { json: async () => rows(o.query) } },
  } as never)

  it('reads ohlc_1d on a sub-day zoom step and says so', async () => {
    seen.length = 0
    const zoom = await buildLiquidityHistory([ACC], { fromBlock: heightAt(T0 + 24 * H), toBlock: heightAt(T0 + 30 * H) })
    expect(zoom.stepSec).toBeLessThan(86_400)
    expect(CHART_PRICE_GRAIN).toBe('1d')
    expect(zoom.priceGrain).toBe('1d')
    const closes = seen.filter(q => q.includes('-- lp:bucket-closes'))
    expect(closes).toHaveLength(1)
    expect(closes[0]).toContain('price_data.ohlc_1d')
    expect(closes[0]).not.toContain('ohlc_1h')
    // A zoom keeps every bucket, as the chart's windowed series does.
    expect(zoom.dates.length).toBeGreaterThan(3)
    expect(zoom.positions[0].points.map(p => p.i)).toEqual(zoom.dates.map((_, i) => i))
  })

  it('collapses the un-windowed grid to the last bucket of each day, like the chart', async () => {
    const full = await buildLiquidityHistory([ACC])
    expect(full.stepSec).toBeLessThan(86_400)
    const days = full.dates.map(d => d.slice(0, 10))
    expect(new Set(days).size).toBe(days.length)
    // The range runs to the clock's newest block (2026-09-03 23:59:54), and a
    // bucket is dated by its end, the chart's downsampleDaily key.
    expect(days).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(full.dates.at(-1)).toBe('2026-09-03 23:59:54')
    expect([full.valueUsd.length, full.unpriced.length, full.blocks.length]).toEqual([3, 3, 3])
    // Positions index the collapsed arrays.
    expect(full.positions[0].points.map(p => p.i)).toEqual([0, 1, 2])
  })
})
