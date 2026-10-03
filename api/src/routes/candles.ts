import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'
import { INTERVAL_VIEW_MAP, queryOHLCV, candleToResponse } from '../services/ohlcvService.ts'
import type { OHLCVInterval } from '../services/ohlcvService.ts'
import { getAssetById } from '../services/assetsService.ts'
import { queryPairCandles } from '../services/crossPair.ts'
import type { CrossCandle } from '../services/crossPair.ts'
import { pairPriceSource, PAIR_PRICE_SOURCES, pricePipelineHead, resolvePairPriceSource, type Sourced } from '../services/pairPriceSource.ts'
import { AMOUNT_SCALE, queryPairVolume, reachesPairVolumeTail, scaledText, type PairVolumeBucket } from '../services/pairVolume.ts'
import { queryTradeVolumeDetails, queryTradeVolumeSummaries } from '../services/tradeVolumeService.ts'
import type { ApiCandle } from '../types.ts'
import { PAIR_CHART_INTERVALS, PAIR_CHART_MAX_CANDLES, pairChart } from '../services/pairChartService.ts'
import { ensurePriceState } from '../services/explorerService.ts'

const intervalsArray = Object.keys(INTERVAL_VIEW_MAP) as [OHLCVInterval, ...OHLCVInterval[]]
const uint32 = z.coerce.number().int().min(0).max(0xffff_ffff)
const unixTime = z.coerce.number().int().min(1).max(0xffff_ffff)
const MAX_CANDLES_PER_REQUEST = 5_000
const MAX_INTERVAL_SECONDS: Record<OHLCVInterval, number> = {
  '5min': 5 * 60,
  '15min': 15 * 60,
  '30min': 30 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
  // Use the longest calendar month so valid month-aligned requests are not
  // rejected at a 31-day boundary.
  '1M': 31 * 24 * 60 * 60,
}

const querySchema = z.object({
  baseId:   uint32,
  quoteId:  uint32,
  interval: z.enum(intervalsArray),
  from:     unixTime,
  to:       unixTime,
  // `1`: price a USD-pegged quote as the token itself (PRIME/USDC, not PRIME/USD).
  // Honoured only while pairs are route-priced; otherwise a USD-pegged quote is the
  // base asset's USD series, as it always was.
  quoteAsset: z.enum(['1']).optional(),
  // Compare the two pair price sources without switching the deployment.
  source: z.enum(PAIR_PRICE_SOURCES as unknown as ['usd-ratio', 'route']).optional(),
}).superRefine(({ interval, from, to }, ctx) => {
  if (to <= from) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must be later than `from`' })
    return
  }
  if (to - from > MAX_INTERVAL_SECONDS[interval] * MAX_CANDLES_PER_REQUEST) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: `Range exceeds ${MAX_CANDLES_PER_REQUEST} candles` })
  }
})

const detailQuerySchema = z.object({
  baseId:   uint32,
  quoteId:  uint32,
  interval: z.enum(intervalsArray),
  time:     unixTime,
  limit:    z.coerce.number().int().min(1).max(500).optional(),
  offset:   z.coerce.number().int().min(0).max(100_000).optional(),
})

/**
 * The chart wire has always carried candles as numbers, while the shared cross
 * module carries the exact decimal text it computed. Narrowing happens here, at
 * this surface's own edge, so the precise value stays available to the public API.
 */
function crossCandlesToApi(rows: Array<Sourced<CrossCandle>>): ApiCandle[] {
  return rows.map(r => {
    const candle: Sourced<ApiCandle> = {
      intervalStart: r.intervalStart,
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volumeBuy: parseFloat(r.volumeBuy),
      volumeSell: parseFloat(r.volumeSell),
      volumeTotal: parseFloat(r.volumeTotal),
    }
    if (r.priceSource) candle.priceSource = r.priceSource
    return candle
  })
}

/** The pair volume onto each candle, additively; a bucket the pair did not trade in reads 0. */
function withPairVolume(candles: ApiCandle[], volume: ReadonlyMap<number, PairVolumeBucket>): ApiCandle[] {
  return candles.map(c => {
    const v = volume.get(c.intervalStart)
    return {
      ...c,
      pairVolumeUsd: v ? parseFloat(scaledText(v.usd, 12)) : 0,
      pairVolumeBase: v ? parseFloat(scaledText(v.base, AMOUNT_SCALE)) : 0,
      pairVolumeQuote: v ? parseFloat(scaledText(v.quote, AMOUNT_SCALE)) : 0,
    }
  })
}

function attachOmniwatchSummaries(
  candles: ApiCandle[],
  summaries: Awaited<ReturnType<typeof queryTradeVolumeSummaries>>
): ApiCandle[] {
  return candles.map(candle => {
    const omniwatch = summaries.get(candle.intervalStart)
    return omniwatch ? { ...candle, omniwatch } : candle
  })
}

const pairChartQuery = z.object({
  base: uint32,
  quote: uint32,
  interval: z.enum(PAIR_CHART_INTERVALS),
  count: z.coerce.number().int().min(10).max(PAIR_CHART_MAX_CANDLES).default(120),
  // Compare the two pair price sources without switching the deployment.
  source: z.enum(PAIR_PRICE_SOURCES as unknown as ['usd-ratio', 'route']).optional(),
})

export async function candlesRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  // The explorer's pair chart (the intent page draws a limit order against its
  // market): any registry asset, aliases resolved to the series that prices them.
  fastify.get('/explorer/pair-chart', async (request, reply) => {
    const parsed = pairChartQuery.safeParse(request.query)
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues })
    const { base, quote, interval, count, source } = parsed.data
    if (base === quote) return reply.status(400).send({ error: 'base and quote must be different assets' })
    // Keyed on the price head the current price generation was composed at — the
    // SSE poller recomposes it before it pushes, so a refetch on the pushed `price`
    // (stamped `pg=` past the micro-cache) is built at the pushed head.
    const priceHead = (await ensurePriceState()).head
    return pairChart(opts.client, base, quote, interval, count, undefined, resolvePairPriceSource(source), priceHead)
  })

  // The pair price source this deployment serves, for clients that offer
  // route-only choices (the preis app's stablecoin-quoted pairs).
  fastify.get('/candles/price-source', async () => ({ priceSource: pairPriceSource() }))

  fastify.get('/candles', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues })
    }

    const { baseId, quoteId, interval, from, to, quoteAsset: quoteAssetFlag } = parsed.data
    const source = resolvePairPriceSource(parsed.data.source)
    const startTime = new Date(from * 1000)
    const endTime = new Date(to * 1000)

    const baseAsset = getAssetById(baseId)
    if (!baseAsset) {
      return reply.status(404).send({ error: `Asset not found: ${baseId}` })
    }

    const quoteAsset = getAssetById(quoteId)
    if (!quoteAsset) {
      return reply.status(404).send({ error: `Asset not found: ${quoteId}` })
    }

    // A USD-pegged quote is the dollar unless the caller asked for the token itself
    // and pairs are route-priced.
    if (quoteAsset.isUsdPegged && !(source === 'route' && quoteAssetFlag === '1')) {
      // USD-denominated pair — direct query (prices are stored in USD terms)
      const [candles, summaries] = await Promise.all([
        queryOHLCV(opts.client, {
          assetId: baseAsset.assetId,
          startTime,
          endTime,
          interval: interval as OHLCVInterval,
        }),
        queryTradeVolumeSummaries(opts.client, {
          assetId: baseAsset.assetId,
          startTime,
          endTime,
          interval: interval as OHLCVInterval,
        }),
      ])
      return attachOmniwatchSummaries(candles.map(candleToResponse), summaries)
    } else {
      // route mode or not, this is the shared pair module: the per-block cross
      // rate, with route-priced buckets substituted when the source is 'route'.
      // Cross-pair — compute ratio per block, then aggregate into OHLCV
      const head = await pricePipelineHead(opts.client)
      const [candles, summaries, pairVolume] = await Promise.all([
        queryPairCandles(opts.client, {
          baseId: baseAsset.assetId,
          quoteId: quoteAsset.assetId,
          startTime,
          endTime,
          interval: interval as OHLCVInterval,
        }, source).then(crossCandlesToApi),
        queryTradeVolumeSummaries(opts.client, {
          assetId: baseAsset.assetId,
          startTime,
          endTime,
          interval: interval as OHLCVInterval,
        }),
        // The pair's own volume, built to the price head for the bucket in
        // progress (the tail is shared per head; a past window never reads it).
        queryPairVolume(opts.client, {
          baseId: baseAsset.assetId,
          quoteId: quoteAsset.assetId,
          interval: interval as OHLCVInterval,
          fromSec: from,
          toSec: to,
          ...(reachesPairVolumeTail(to + MAX_INTERVAL_SECONDS[interval as OHLCVInterval], head.time) ? { head } : {}),
        }),
      ])
      return attachOmniwatchSummaries(withPairVolume(candles, pairVolume), summaries)
    }
  })

  fastify.get('/candles/volume-details', async (request, reply) => {
    const parsed = detailQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues })
    }

    const { baseId, quoteId, interval, time, limit = 200, offset = 0 } = parsed.data
    const baseAsset = getAssetById(baseId)
    if (!baseAsset) {
      return reply.status(404).send({ error: `Asset not found: ${baseId}` })
    }

    const quoteAsset = getAssetById(quoteId)
    if (!quoteAsset) {
      return reply.status(404).send({ error: `Asset not found: ${quoteId}` })
    }

    return queryTradeVolumeDetails(opts.client, {
      assetId: baseAsset.assetId,
      intervalStart: new Date(time * 1000),
      interval: interval as OHLCVInterval,
      limit,
      offset,
    })
  })
}
