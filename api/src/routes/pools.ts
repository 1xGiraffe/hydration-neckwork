import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAssetLiquidity, getOmnipoolDetail, getPoolDetail } from '../services/poolService.ts'

// Liquidity-pool endpoints: the asset Liquidity tab, stableswap/XYK pool detail
// pages (keyed by the share/LP asset id) and the Omnipool page. All models are
// SWR-cached in poolService; routes stay thin.
const uint32Schema = z.coerce.number().int().min(0).max(4_294_967_295)

export async function poolsRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/omnipool', async () => {
    return getOmnipoolDetail()
  })

  fastify.get('/explorer/pool/:poolId', async (req, reply) => {
    const poolId = uint32Schema.safeParse((req.params as { poolId: string }).poolId)
    if (!poolId.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const detail = await getPoolDetail(poolId.data)
    if (!detail) return reply.status(404).send({ error: 'Pool not found' })
    return detail
  })

  fastify.get('/explorer/asset/:assetId/liquidity', async (req, reply) => {
    const assetId = uint32Schema.safeParse((req.params as { assetId: string }).assetId)
    if (!assetId.success) return reply.status(400).send({ error: 'Invalid asset id' })
    return getAssetLiquidity(assetId.data)
  })
}
