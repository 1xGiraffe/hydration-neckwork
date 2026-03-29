import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'
import { INTERVAL_VIEW_MAP, queryOHLCV, candleToResponse } from '../services/ohlcvService.ts'
import type { OHLCVInterval } from '../services/ohlcvService.ts'
import { getAssetById } from '../services/assetsService.ts'
import { queryCrossPairCandles } from '../services/crossPair.ts'

const intervalsArray = Object.keys(INTERVAL_VIEW_MAP) as [OHLCVInterval, ...OHLCVInterval[]]

const querySchema = z.object({
  baseId:   z.coerce.number().int().nonnegative(),
  quoteId:  z.coerce.number().int().nonnegative(),
  interval: z.enum(intervalsArray),
  from:     z.coerce.number().int().positive(),
  to:       z.coerce.number().int().positive(),
})

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
      const candles = await queryOHLCV(opts.client, {
        assetId: baseAsset.assetId,
        startTime,
        endTime,
        interval: interval as OHLCVInterval,
      })
      return candles.map(candleToResponse)
    } else {
      // Cross-pair — compute ratio per block, then aggregate into OHLCV
      return queryCrossPairCandles(opts.client, {
        baseId: baseAsset.assetId,
        quoteId: quoteAsset.assetId,
        startTime,
        endTime,
        interval: interval as OHLCVInterval,
      })
    }
  })
}
