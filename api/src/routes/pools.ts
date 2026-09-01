import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAssetLiquidity, getOmnipoolAssetLps, getOmnipoolDetail, getPoolDetail, getPoolLps, getPoolsIndex } from '../services/poolService.ts'
import { getAssetActivity, getPoolSwaps } from '../services/explorerService.ts'
import { DAILY_GRAIN, grainForWindow } from '../services/historyGrain.ts'

// Liquidity-pool endpoints: the asset Liquidity tab, stableswap/XYK pool detail
// pages (keyed by the share/LP asset id) and the Omnipool page. All models are
// SWR-cached in poolService; routes stay thin.
const uint32Schema = z.coerce.number().int().min(0).max(4_294_967_295)

// Chart-zoom refinement, shared by the three history-bearing pool endpoints:
// with a window the history is rebuilt on the finest ladder grain that fits the
// point budget (never below an hour) instead of the daily default, so zooming
// reveals detail the daily series cannot express. `fromTs`/`toTs`, not
// `from`/`to`: the plugin-wide filter guard reserves those as calendar-day
// params. Without a window every response is byte-for-byte what it was.
const windowSchema = z.object({
  fromTs: z.coerce.number().int().min(0).max(0xffff_ffff),
  toTs: z.coerce.number().int().min(0).max(0xffff_ffff),
  points: z.coerce.number().int().min(10).max(400).optional(),
})

function historyWindow(query: unknown): { grain: typeof DAILY_GRAIN; win?: { fromSec: number; toSec: number } } {
  const q = windowSchema.safeParse(query)
  if (!q.success || q.data.toTs <= q.data.fromTs) return { grain: DAILY_GRAIN }
  const win = { fromSec: q.data.fromTs, toSec: q.data.toTs }
  return { grain: grainForWindow(win.fromSec, win.toSec, q.data.points ?? 180), win }
}

export async function poolsRoutes(fastify: FastifyInstance) {
  fastify.get('/explorer/omnipool', async req => {
    const { grain, win } = historyWindow(req.query)
    return getOmnipoolDetail(grain, win)
  })

  // Every pool on the chain, largest first — the /liquidity index.
  fastify.get('/explorer/pools', async () => {
    return getPoolsIndex()
  })

  fastify.get('/explorer/pool/:poolId', async (req, reply) => {
    const poolId = uint32Schema.safeParse((req.params as { poolId: string }).poolId)
    if (!poolId.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const { grain, win } = historyWindow(req.query)
    const detail = await getPoolDetail(poolId.data, grain, win)
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
    const { grain, win } = historyWindow(req.query)
    return getAssetLiquidity(assetId.data, grain, win)
  })

  // A pool's liquidity providers: holders of its share token, largest first,
  // with XYK farm-deposited principal attributed to its economic owners.
  fastify.get('/explorer/pool/:poolId/lps', async (req, reply) => {
    const poolId = uint32Schema.safeParse((req.params as { poolId: string }).poolId)
    if (!poolId.success) return reply.status(400).send({ error: 'Invalid pool id' })
    const { limit, offset } = pageParams(req.query as Record<string, string | undefined>)
    const lps = await getPoolLps(poolId.data, limit, offset)
    if (!lps) return reply.status(404).send({ error: 'Pool not found' })
    return lps
  })

  // One omnipool asset's LP ranking: economic owners of its position NFTs
  // (bare and farmed), plus the protocol's own accountless shares.
  fastify.get('/explorer/omnipool/:assetId/lps', async (req, reply) => {
    const assetId = uint32Schema.safeParse((req.params as { assetId: string }).assetId)
    if (!assetId.success) return reply.status(400).send({ error: 'Invalid asset id' })
    const { limit, offset } = pageParams(req.query as Record<string, string | undefined>)
    const lps = await getOmnipoolAssetLps(assetId.data, limit, offset)
    if (!lps) return reply.status(404).send({ error: 'Asset not in the Omnipool' })
    return lps
  })
}

// Shared limit/offset clamping for the LP lists (default one 10-row page).
function pageParams(q: { limit?: string; offset?: string }): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 10) || 10))
  const offset = Math.max(0, Number(q.offset ?? 0) || 0)
  return { limit, offset }
}
