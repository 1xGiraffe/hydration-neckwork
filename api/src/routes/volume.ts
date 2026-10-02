import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getAssetVolume, getPlatformVolume, getPlatformVolumeWindow, getPoolVolume, VOLUME_RANGES } from '../services/volumeHistory.ts'
import type { ChartWindowRequest } from '../services/chartWindow.ts'
import { DEFAULT_WINDOW_POINTS, windowSchema } from './windowQuery.ts'

// Trading volume on the explorer (services/volumeHistory.ts states the three
// definitions and the window rules). Every route answers its whole payload
// without window params, and only the chart, `{ stepSec, buckets, series }`
// (chartWindow.ts), with `fromTs`/`toTs` (+ `points`): the zoom refine, rebuilt on
// the finest ladder grain that fits, never past the models' published cut.

const uint32 = z.coerce.number().int().min(0).max(4_294_967_295)

/** The zoom window when the query carries one; `'bad'` when it carries a malformed one. */
function zoomWindow(query: unknown): ChartWindowRequest | undefined | 'bad' {
  const q = query as Record<string, unknown> | undefined
  if (q?.fromTs == null && q?.toTs == null) return undefined
  const w = windowSchema.safeParse(query)
  if (!w.success || w.data.toTs <= w.data.fromTs) return 'bad'
  return { fromSec: w.data.fromTs, toSec: w.data.toTs, points: w.data.points ?? DEFAULT_WINDOW_POINTS }
}

const BAD_WINDOW = 'Invalid window: fromTs < toTs in unix seconds, points 10–400'

function notFound(reply: FastifyReply, what: string) {
  return reply.status(404).send({ error: `${what} not found` })
}

export async function volumeRoutes(fastify: FastifyInstance) {
  // The platform: routed volume (every trade once) and venue volume (every fill
  // once in its pool) per window and per bucket, the venue split, and the 7 days'
  // top pools, assets and traders. `range` picks the chart's span and grain:
  // 30d daily, 1y weekly, all fortnightly.
  fastify.get('/explorer/volume', async (req, reply) => {
    const win = zoomWindow(req.query)
    if (win === 'bad') return reply.status(400).send({ error: BAD_WINDOW })
    if (win) return getPlatformVolumeWindow(win)
    const q = z.object({ range: z.enum(VOLUME_RANGES).default('30d') }).safeParse(req.query)
    if (!q.success) return reply.status(400).send({ error: `Invalid range: one of ${VOLUME_RANGES.join(', ')}` })
    return (await getPlatformVolume(q.data.range)) ?? reply.status(503).send({ error: 'Volume models are empty' })
  })

  // One asset's volume (its own legs, sold plus bought) by venue, with its
  // money-market aToken and the pool shares displayed under it folded in.
  fastify.get('/explorer/asset/:assetId/volume', async (req, reply) => {
    const id = uint32.safeParse((req.params as { assetId: string }).assetId)
    if (!id.success) return reply.status(400).send({ error: 'Invalid asset id' })
    const win = zoomWindow(req.query)
    if (win === 'bad') return reply.status(400).send({ error: BAD_WINDOW })
    return getAssetVolume(id.data, win)
  })

  // The Omnipool's venue volume (each user swap once), fees, fills and TVL per
  // bucket, the bars split by asset.
  fastify.get('/explorer/omnipool/volume', async (req, reply) => {
    const win = zoomWindow(req.query)
    if (win === 'bad') return reply.status(400).send({ error: BAD_WINDOW })
    return (await getPoolVolume('omnipool', 'omnipool', win)) ?? reply.status(503).send({ error: 'Volume models are empty' })
  })

  // A concentrated-liquidity pool's window figures (its chart is the pool
  // history route's). Declared before the share-id route, like the pool detail.
  fastify.get('/explorer/pool/v3/:address/volume', async (req, reply) => {
    const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).safeParse((req.params as { address: string }).address)
    if (!address.success) return reply.status(400).send({ error: 'Invalid pool address' })
    const win = zoomWindow(req.query)
    if (win === 'bad') return reply.status(400).send({ error: BAD_WINDOW })
    return (await getPoolVolume('v3', address.data, win)) ?? notFound(reply, 'Pool')
  })

  // A stableswap or XYK pool, addressed by its share/LP token id like its detail page.
  fastify.get('/explorer/pool/:poolId/volume', async (req, reply) => {
    const id = uint32.safeParse((req.params as { poolId: string }).poolId)
    if (!id.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const win = zoomWindow(req.query)
    if (win === 'bad') return reply.status(400).send({ error: BAD_WINDOW })
    return (await getPoolVolume('pool', String(id.data), win)) ?? notFound(reply, 'Pool')
  })
}
