import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'
import { INTERVAL_VIEW_MAP, queryOHLCV, candleToResponse } from '../services/ohlcvService.ts'
import type { OHLCVInterval } from '../services/ohlcvService.ts'
import { getAssetById } from '../services/assetsService.ts'
import { queryCrossPairCandles } from '../services/crossPair.ts'
import { queryTradeVolumeDetails, queryTradeVolumeSummaries } from '../services/tradeVolumeService.ts'
import type { ApiCandle } from '../types.ts'

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

function attachOmniwatchSummaries(
  candles: ApiCandle[],
  summaries: Awaited<ReturnType<typeof queryTradeVolumeSummaries>>
): ApiCandle[] {
  return candles.map(candle => {
    const omniwatch = summaries.get(candle.intervalStart)
    return omniwatch ? { ...candle, omniwatch } : candle
  })
}

export async function candlesRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  fastify.get('/candles', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query parameters', details: parsed.error.issues })
    }

    const { baseId, quoteId, interval, from, to } = parsed.data
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

    if (quoteAsset.isStablecoin) {
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
      // Cross-pair — compute ratio per block, then aggregate into OHLCV
      const [candles, summaries] = await Promise.all([
        queryCrossPairCandles(opts.client, {
          baseId: baseAsset.assetId,
          quoteId: quoteAsset.assetId,
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
      return attachOmniwatchSummaries(candles, summaries)
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
