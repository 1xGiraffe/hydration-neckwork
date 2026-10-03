import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { assetDescriptor, priceAssetId } from './explorerAssets.ts'
import { getAssetById } from './assetsService.ts'
import { queryOHLCV, type OHLCVInterval } from './ohlcvService.ts'
import { queryPairCandles } from './crossPair.ts'
import { overlayRouteCandles, pairPriceSource, queryRouteCandles, type CandlePriceSource, type PairPriceSource } from './pairPriceSource.ts'
import { AMOUNT_SCALE, queryPairVolume, scaledText } from './pairVolume.ts'

// Candles for one pair on an explorer chart — the intent page draws a limit order
// against its market with them. The same two leaves the preis chart route and the
// public /v1/prices/pair read: a USD-pegged quote is the base asset's own USD candles,
// anything else the exact per-block cross rate (services/crossPair.ts), never the
// ratio of two stored candles. Each leg is first resolved to the series that prices
// its history (priceAssetId), because an intent trades aTokens and pool shares the
// candle model records under their reserve or wrapper (aUSDC is USDC).

export const PAIR_CHART_INTERVALS = ['15min', '1h', '4h', '1d', '1w'] as const
export type PairChartInterval = typeof PAIR_CHART_INTERVALS[number]
const INTERVAL_SECONDS: Record<PairChartInterval, number> = { '15min': 900, '1h': 3_600, '4h': 14_400, '1d': 86_400, '1w': 604_800 }
// The weekly grid is Monday-anchored like the candle model's (1970-01-05).
const INTERVAL_ANCHOR: Record<PairChartInterval, number> = { '15min': 0, '1h': 0, '4h': 0, '1d': 0, '1w': 345_600 }
export const PAIR_CHART_MAX_CANDLES = 500

/** One candle as the chart draws it: the bucket's open time (unix seconds) and its prices. */
export interface PairChartCandle {
  t: number; o: number; h: number; l: number; c: number; priceSource?: CandlePriceSource
  /** The pair's own volume (trades between the two assets, services/pairVolume.ts): USD, and whole units of base and quote. */
  v?: number; vb?: number; vq?: number
}
export interface PairChart {
  /** The series each leg was read from — differs from the id asked for when it is an alias. */
  baseSeries: number
  quoteSeries: number
  interval: PairChartInterval
  candles: PairChartCandle[]
  /**
   * The fee a trade of this pair pays over the price before fees, measured from the
   * pair's own recent trades (see pairTradeFee) — what a chart needs to draw an
   * order's limit where the market must be for it to fill. Null when too few trades,
   * and while the chart draws route-priced candles (the fee is measured against the
   * USD ratio, which those candles are not).
   */
  tradeFee: { fee: number; trades: number } | null
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value))

/**
 * The newest `count` buckets of `base` quoted in `quote`, ending with the bucket in
 * progress — a price chart shows where the price is now, which is the point of
 * drawing a resting order against it. Two ids reading one series (aUSDC and USDC)
 * have no pair to draw and answer empty.
 */
export function pairChart(client: ClickHouseClient, baseId: number, quoteId: number, interval: PairChartInterval, count: number, nowSec = Math.floor(Date.now() / 1000), source: PairPriceSource = pairPriceSource(), priceHead = 0): Promise<PairChart> {
  const baseSeries = priceAssetId(baseId)
  const quoteSeries = priceAssetId(quoteId)
  const seconds = INTERVAL_SECONDS[interval]
  const anchor = INTERVAL_ANCHOR[interval]
  const n = Math.max(1, Math.min(PAIR_CHART_MAX_CANDLES, Math.floor(count)))
  // Floored onto the grid so every request inside one bucket shares a key, and keyed
  // on the price pipeline's head (`priceHead`, the block the explorer's price
  // generation was composed at): the bucket in progress moves exactly when a new
  // block is priced, so a chart refetched on a pushed price generation is rebuilt
  // for it, and every request at one head shares one build. The TTL only bounds
  // memory (and a caller without a head).
  const currentStart = Math.floor((nowSec - anchor) / seconds) * seconds + anchor
  const fromSec = currentStart - (n - 1) * seconds
  return cached(`explorer:pair-chart:${baseSeries}:${quoteSeries}:${interval}:${n}:${currentStart}:h${priceHead}${source === 'route' ? ':route' : ''}`, 30_000, async (): Promise<PairChart> => {
    if (baseSeries === quoteSeries) return { baseSeries, quoteSeries, interval, candles: [], tradeFee: null }
    const startTime = new Date(fromSec * 1000)
    const endTime = new Date(nowSec * 1000)
    const window = { baseId: baseSeries, quoteId: quoteSeries, startTime, endTime, interval: interval as OHLCVInterval, headFloor: priceHead }
    let candles: PairChartCandle[] = getAssetById(quoteSeries)?.isUsdPegged
      ? (await queryOHLCV(client, { assetId: baseSeries, startTime, endTime, interval: interval as OHLCVInterval }))
        .map(c => ({ t: Math.floor(Date.parse(`${c.interval_start.replace(' ', 'T')}Z`) / 1000), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) }))
      : (await queryPairCandles(client, window, source))
        .map(c => {
          const candle: PairChartCandle = { t: c.intervalStart, o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) }
          if (c.priceSource) candle.priceSource = c.priceSource
          return candle
        })
    // Route mode prices a USD-pegged quote as the token itself wherever the pair's
    // route does, like every other quote.
    if (source === 'route' && getAssetById(quoteSeries)?.isUsdPegged) {
      const route = await queryRouteCandles(client, window)
      candles = overlayRouteCandles(candles, route, c => c.t, rc => ({ t: rc.intervalStart, o: num(rc.open), h: num(rc.high), l: num(rc.low), c: num(rc.close) }))
    }
    // The pair's own volume per bucket, the bucket in progress built to the head.
    const volume = await queryPairVolume(client, {
      baseId: baseSeries, quoteId: quoteSeries, interval, fromSec, toSec: currentStart,
      // The tail is shared per head block; the legs it reads are written with the
      // prices, so reading them to the wall clock stops at that head anyway.
      ...(priceHead > 0 ? { head: { block: priceHead, time: nowSec } } : {}),
    })
    candles = candles.map(c => {
      const pv = volume.get(c.t)
      return { ...c, v: pv ? Number(scaledText(pv.usd, 12)) : 0, vb: pv ? Number(scaledText(pv.base, AMOUNT_SCALE)) : 0, vq: pv ? Number(scaledText(pv.quote, AMOUNT_SCALE)) : 0 }
    })
    // The fee is measured against the USD ratio at each trade's prior block. Where
    // the chart draws route prices that is not the price the candles show, and the
    // route price at an arbitrary block is not stored (only per 5-minute candle), so
    // the fee is left unset rather than measured against the wrong price.
    const routed = source === 'route' && candles.some(c => c.priceSource === 'route')
    const tradeFee = routed ? null : await pairTradeFee(client, baseId, quoteId).catch(() => null)
    return {
      baseSeries, quoteSeries, interval, tradeFee,
      candles: candles.filter(c => c.t >= fromSec && [c.o, c.h, c.l, c.c].every(v => Number.isFinite(v) && v > 0)).sort((a, b) => a.t - b.t),
    }
  })
}

/* ============ the pair's trade fee ============ */

// How far back, and how many, of the pair's own trades measure its fee. A week at
// ~2 s blocks; the newest trades within it.
const FEE_LOOKBACK_BLOCKS = 300_000
const FEE_MAX_TRADES = 300
const FEE_MIN_TRADES = 5
const MAX_PLAUSIBLE_FEE = 0.05

/**
 * The median fee the pair's recent direct trades paid: each trade's execution price
 * against the price BEFORE it (the block ahead of it, so the trade's own impact is not
 * counted), in the direction a fee pushes — a buyer of the base paid more, a seller
 * received less. The same measure the intent chart applies to an order's own fills,
 * for an order that has none yet. Every venue and route counts (a router summary is
 * the fee the whole route paid), since a solver fills an intent the same way.
 */
export function pairTradeFee(client: ClickHouseClient, baseId: number, quoteId: number): Promise<{ fee: number; trades: number } | null> {
  const baseSeries = priceAssetId(baseId), quoteSeries = priceAssetId(quoteId)
  return cached(`explorer:pair-trade-fee:${baseId}:${quoteId}`, 600_000, async () => {
    const baseIds = [...new Set([baseId, baseSeries])], quoteIds = [...new Set([quoteId, quoteSeries])]
    const res = await client.query({
      query: `
        WITH (SELECT max(block_height) FROM price_data.blocks) AS head
        SELECT s.block_height AS block_height, s.asset_in AS asset_in, s.amount_in AS amount_in, s.amount_out AS amount_out,
               toString(pb.usd_price) AS base_usd, toString(pq.usd_price) AS quote_usd
        FROM (
          SELECT block_height, asset_in, asset_out, amount_in, amount_out,
                 toUInt32({baseSeries:UInt32}) AS kb, toUInt32({quoteSeries:UInt32}) AS kq
          FROM price_data.swap_activity
          WHERE block_height > head - {lookback:UInt32}
            AND ((asset_in IN {base:Array(UInt32)} AND asset_out IN {quote:Array(UInt32)})
              OR (asset_in IN {quote:Array(UInt32)} AND asset_out IN {base:Array(UInt32)}))
          ORDER BY block_height DESC LIMIT {n:UInt32}
        ) AS s
        ASOF INNER JOIN (
          SELECT toUInt32(asset_id) AS k, block_height, usd_price FROM price_data.prices
          WHERE asset_id = {baseSeries:UInt32} AND block_height > head - {lookback:UInt32} - 1000
        ) AS pb ON pb.k = s.kb AND s.block_height > pb.block_height
        ASOF INNER JOIN (
          SELECT toUInt32(asset_id) AS k, block_height, usd_price FROM price_data.prices
          WHERE asset_id = {quoteSeries:UInt32} AND block_height > head - {lookback:UInt32} - 1000
        ) AS pq ON pq.k = s.kq AND s.block_height > pq.block_height`,
      query_params: { base: baseIds, quote: quoteIds, baseSeries, quoteSeries, lookback: FEE_LOOKBACK_BLOCKS, n: FEE_MAX_TRADES },
      format: 'JSONEachRow',
      clickhouse_settings: { max_threads: 4 },
    })
    const rows = await res.json<{ block_height: number; asset_in: number; amount_in: string; amount_out: string; base_usd: string; quote_usd: string }>()
    const decB = assetDescriptor(baseId).decimals, decQ = assetDescriptor(quoteId).decimals
    const premiums: number[] = []
    for (const r of rows) {
      const mid = Number(r.base_usd) / Number(r.quote_usd)
      const sellsBase = baseIds.includes(Number(r.asset_in))
      const inAmt = Number(r.amount_in) / 10 ** (sellsBase ? decB : decQ)
      const outAmt = Number(r.amount_out) / 10 ** (sellsBase ? decQ : decB)
      if (!(mid > 0) || !(inAmt > 0) || !(outAmt > 0)) continue
      premiums.push(sellsBase ? 1 - (outAmt / inAmt) / mid : (inAmt / outAmt) / mid - 1)
    }
    if (premiums.length < FEE_MIN_TRADES) return null
    premiums.sort((a, b) => a - b)
    const m = premiums.length / 2
    const median = premiums.length % 2 ? premiums[Math.floor(m)] : (premiums[m - 1] + premiums[m]) / 2
    return median > 0 && median < MAX_PLAUSIBLE_FEE ? { fee: median, trades: premiums.length } : null
  })
}
