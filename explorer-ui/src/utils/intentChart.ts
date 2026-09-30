import type { ActivityRow, AssetRef, IntentOrderDetail } from '../types'

// The pure half of the intent page's price chart: which way round the pair reads,
// how zoomed in the chart starts, and where the order and its fills sit on it.

export type ChartInterval = '15min' | '1h' | '4h' | '1d' | '1w'
export const CHART_INTERVALS: readonly ChartInterval[] = ['15min', '1h', '4h', '1d', '1w']
export const INTERVAL_LABEL: Record<ChartInterval, string> = { '15min': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' }
export const INTERVAL_SECONDS: Record<ChartInterval, number> = { '15min': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800 }

// Legs a price is quoted IN, most money-like first: the dollar tokens, Hydration's
// own stablecoin, then the other dollar and euro stables. An aToken or a Hydrated
// wrapper over one quotes like it (aUSDT, HUSDC).
const QUOTE_RANK = ['USDT', 'USDC', 'HOLLAR', 'DAI', 'USDS', 'SUSDS', 'USDE', 'EURC']
function quoteRank(asset: AssetRef): number {
  const symbol = asset.symbol.toUpperCase().replace(/\.[A-Z]+$/, '')
  for (const candidate of [symbol, symbol.replace(/^A(?=[A-Z])/, ''), symbol.replace(/^H(?=[A-Z])/, '')]) {
    const i = QUOTE_RANK.indexOf(candidate)
    if (i >= 0) return i
  }
  return QUOTE_RANK.length
}

export interface ChartOrientation {
  base: AssetRef
  quote: AssetRef
  /** The order's limit as quote per base. */
  limit: number | null
  /**
   * Which side of the line fills. Every intent SELLS assetIn and demands at least its
   * limit of assetOut per unit, so it fills when assetIn is dear enough: at or above
   * the line when assetIn is the base, at or below it when the chart is the other way
   * round (the order is then buying the base, at no more than the line).
   */
  fillsWhen: 'above' | 'below'
  /** Whether the base is the leg the order sells. */
  sellsBase: boolean
}

/**
 * The pair as a reader would quote it. A money-like leg (USDT, HOLLAR…) is the quote
 * whenever exactly one leg — or the more money-like of two — is one; otherwise the
 * leg worth more per unit is the base, so the price reads above 1 (163 HDX per DOT,
 * not 0.0061 DOT per HDX). The limit's own ratio stands in for the market there:
 * it is known without a price feed, and it only decides the reading direction.
 */
export function chartOrientation(data: Pick<IntentOrderDetail, 'assetIn' | 'assetOut' | 'limitPriceOutPerIn' | 'limitPriceInPerOut'>): ChartOrientation {
  const outPerIn = toPositive(data.limitPriceOutPerIn)
  const inPerOut = toPositive(data.limitPriceInPerOut)
  const rankIn = quoteRank(data.assetIn), rankOut = quoteRank(data.assetOut)
  const sellsBase = rankOut !== rankIn
    ? rankOut < rankIn                     // assetOut is the money: price assetIn in it
    : outPerIn == null || outPerIn >= 1    // assetIn worth more per unit: it is the base
  return sellsBase
    ? { base: data.assetIn, quote: data.assetOut, limit: outPerIn, fillsWhen: 'above', sellsBase }
    : { base: data.assetOut, quote: data.assetIn, limit: inPerOut, fillsWhen: 'below', sellsBase }
}

/**
 * How zoomed in the chart starts: the finer the grid, the closer the limit sits to
 * the market, so the line lands inside the recent range with room to read the
 * candles around it. The distance is the log ratio, the same either way round.
 * An unpriced pair (no ratio) starts hourly.
 */
export function chartTimeframe(limitMarketRatio: number | null | undefined): { interval: ChartInterval; count: number } {
  if (limitMarketRatio == null || !Number.isFinite(limitMarketRatio) || limitMarketRatio <= 0) return { interval: '1h', count: 168 }
  const d = Math.abs(Math.log(limitMarketRatio))
  if (d < 0.015) return { interval: '15min', count: 144 }   // within ~1.5 %: 36 hours
  if (d < 0.05) return { interval: '1h', count: 168 }       // within ~5 %: a week
  if (d < 0.15) return { interval: '4h', count: 180 }       // within ~16 %: a month
  if (d < 0.5) return { interval: '1d', count: 180 }        // within ~65 %: six months
  return { interval: '1w', count: 156 }                     // further: three years
}

/** How many candles a timeframe picked by hand shows — the auto pick's own span per grid. */
export const INTERVAL_COUNT: Record<ChartInterval, number> = { '15min': 144, '1h': 168, '4h': 180, '1d': 180, '1w': 156 }

export interface FillPoint { t: number; price: number; href: string | null }

/** Each fill's execution price in the chart's orientation, at its block time. */
export function fillPoints(fills: readonly ActivityRow[], o: ChartOrientation, hrefOf: (row: ActivityRow) => string | null = () => null): FillPoint[] {
  const out: FillPoint[] = []
  for (const f of fills) {
    const inAmt = human(f.amountIn, f.assetIn?.decimals), outAmt = human(f.amountOut, f.assetOut?.decimals)
    const t = Date.parse(`${f.timestamp.replace(' ', 'T')}${/[Zz]|[+-]\d\d:?\d\d$/.test(f.timestamp) ? '' : 'Z'}`) / 1000
    if (inAmt == null || outAmt == null || inAmt <= 0 || outAmt <= 0 || !Number.isFinite(t)) continue
    out.push({ t, price: o.sellsBase ? outAmt / inAmt : inAmt / outAmt, href: hrefOf(f) })
  }
  return out
}

/**
 * The price range the chart spans: the candles' own, stretched to take in the limit
 * when it sits near enough to share the scale. A limit far off market (a ceiling at
 * 700× the price) would flatten every candle into one line; it is then reported
 * outside the plot instead (`limitOffscale`) and the candles keep their scale.
 */
export function priceRange(lows: number[], highs: number[], limit: number | null): { lo: number; hi: number; limitOffscale: 'above' | 'below' | null } {
  let lo = Math.min(...lows), hi = Math.max(...highs)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, limitOffscale: null }
  let limitOffscale: 'above' | 'below' | null = null
  if (limit != null && Number.isFinite(limit) && limit > 0) {
    const span = Math.max(hi - lo, hi * 0.002)
    if (limit > hi + span * 2.5) limitOffscale = 'above'
    else if (limit < lo - span * 2.5) limitOffscale = 'below'
    else { lo = Math.min(lo, limit); hi = Math.max(hi, limit) }
  }
  const pad = Math.max((hi - lo) * 0.08, hi * 0.001)
  return { lo: Math.max(0, lo - pad), hi: hi + pad, limitOffscale }
}

function toPositive(v: string | null | undefined): number | null {
  const n = Number(v)
  return v != null && Number.isFinite(n) && n > 0 ? n : null
}
function human(raw: string | null | undefined, decimals: number | undefined): number | null {
  if (raw == null || decimals == null || !/^\d+$/.test(raw)) return null
  const n = Number(raw) / 10 ** decimals
  return Number.isFinite(n) ? n : null
}

export interface PlacementRead {
  /** The limit was already met at the market price when the order was placed. */
  marketable: boolean
  /** How far the limit sat from the price at placement, % (negative = under it); null when unknown. */
  distancePct: number | null
}

/**
 * Whether an order was placed with its limit already met at the market price — a swap
 * with a minimum received, which the app sets from its slippage tolerance and a solver
 * fills at market right away — rather than a limit resting for the price to come to
 * it. Read from the candle the placement fell in when the chart covers it; otherwise,
 * an order whose first fill came within a minute of its placement was one too.
 */
export function placementRead(
  o: ChartOrientation,
  candles: readonly { t: number; o: number; c: number }[],
  stepSec: number,
  placedSec: number,
  firstFillSec: number | null,
): PlacementRead {
  if (o.limit == null) return { marketable: false, distancePct: null }
  const at = candles.find(c => placedSec >= c.t && placedSec < c.t + stepSec)
  if (at) {
    const market = at.o
    const met = o.fillsWhen === 'above' ? market >= o.limit : market <= o.limit
    return { marketable: met, distancePct: (o.limit / market - 1) * 100 }
  }
  const quick = firstFillSec != null && firstFillSec - placedSec >= 0 && firstFillSec - placedSec <= 60
  return { marketable: quick, distancePct: null }
}
