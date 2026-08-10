import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAssetLiquidity, getOmnipoolDetail, getPoolDetail, getPoolsIndex } from '../services/poolService.ts'
import { getAssetActivity, getPoolSwaps } from '../services/explorerService.ts'

// Liquidity-pool endpoints: the asset Liquidity tab, stableswap/XYK pool detail
// pages (keyed by the share/LP asset id) and the Omnipool page. All models are
// SWR-cached in poolService; routes stay thin.
const uint32Schema = z.coerce.number().int().min(0).max(4_294_967_295)

export async function poolsRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/omnipool', async () => {
    return getOmnipoolDetail()
  })

  // Every pool on the chain, largest first — the /liquidity index.
  fastify.get('/explorer/pools', async () => {
    return getPoolsIndex()
  })

  fastify.get('/explorer/pool/:poolId', async (req, reply) => {
    const poolId = uint32Schema.safeParse((req.params as { poolId: string }).poolId)
    if (!poolId.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const detail = await getPoolDetail(poolId.data)
    if (!detail) return reply.status(404).send({ error: 'Pool not found' })
    return detail
  })

  // A pool's recent activity: the swaps that happened IN it, merged with what
  // its share token did (liquidity added and removed, and trades of the share
  // itself). The swaps are the half no other feed can show — see getPoolSwaps —
  // and without them a busy pool's page looked idle for days at a time.
  fastify.get('/explorer/pool/:poolId/activity', async (req, reply) => {
    const poolId = uint32Schema.safeParse((req.params as { poolId: string }).poolId)
    if (!poolId.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 25) || 25))
    const detail = await getPoolDetail(poolId.data)
    if (!detail) return reply.status(404).send({ error: 'Pool not found' })
    const members = detail.assets.map(a => a.asset.assetId)
    const [swaps, shareActivity] = await Promise.all([
      getPoolSwaps(poolId.data, members, detail.kind, limit),
      getAssetActivity(poolId.data, 'all', limit),
    ])
    // One ordering for both halves: newest block first, later event first.
    return [...swaps, ...shareActivity]
      .sort((a, b) => b.blockHeight - a.blockHeight || (b.eventIndex ?? -1) - (a.eventIndex ?? -1))
      .slice(0, limit)
  })

  fastify.get('/explorer/asset/:assetId/liquidity', async (req, reply) => {
    const assetId = uint32Schema.safeParse((req.params as { assetId: string }).assetId)
    if (!assetId.success) return reply.status(400).send({ error: 'Invalid asset id' })
    return getAssetLiquidity(assetId.data)
  })
}
