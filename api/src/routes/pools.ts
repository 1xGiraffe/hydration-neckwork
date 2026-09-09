import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getAssetLiquidity, getOmnipoolAssetLps, getOmnipoolDetail, getPoolDetail, getPoolLps, getPoolsIndex, getUniswapV3PoolDetail, getUniswapV3PoolHistory, getUniswapV3PoolLiquidity } from '../services/poolService.ts'
import { getAssetActivity, getPoolSwaps, getV3PoolActivity } from '../services/explorerService.ts'
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

  // A concentrated-liquidity (Uniswap v3) pool, addressed by its contract. Declared
  // before the share-token route: `v3` is a static segment, so the router prefers it.
  const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  fastify.get('/explorer/pool/v3/:address', async (req, reply) => {
    const address = evmAddress.safeParse((req.params as { address: string }).address)
    if (!address.success) return reply.status(400).send({ error: 'Invalid pool address' })
    const detail = await getUniswapV3PoolDetail(address.data)
    if (!detail) return reply.status(404).send({ error: 'Pool not found' })
    return detail
  })
  // The pool's time series (price OHLC, volume, fees, liquidity, holdings): the whole
  // life at the coarsest grain that fits `points`, or a `fromTs`/`toTs` window refined
  // down the ladder — and, for a short window with few swaps, swap by swap.
  fastify.get('/explorer/pool/v3/:address/history', async (req, reply) => {
    const address = evmAddress.safeParse((req.params as { address: string }).address)
    if (!address.success) return reply.status(400).send({ error: 'Invalid pool address' })
    const q = windowSchema.safeParse(req.query)
    const win = q.success && q.data.toTs > q.data.fromTs ? { fromSec: q.data.fromTs, toSec: q.data.toTs } : undefined
    const points = q.success ? (q.data.points ?? 180) : 180
    const history = await getUniswapV3PoolHistory(address.data, win, points)
    if (!history) return reply.status(404).send({ error: 'Pool not found' })
    return history
  })
  // The pool's liquidity distribution now: initialised ticks, the liquidity between
  // them and the open ranges by owner, valued at the current tick.
  fastify.get('/explorer/pool/v3/:address/liquidity', async (req, reply) => {
    const address = evmAddress.safeParse((req.params as { address: string }).address)
    if (!address.success) return reply.status(400).send({ error: 'Invalid pool address' })
    const dist = await getUniswapV3PoolLiquidity(address.data)
    if (!dist) return reply.status(404).send({ error: 'Pool not found' })
    return dist
  })
  fastify.get('/explorer/pool/v3/:address/activity', async (req, reply) => {
    const address = evmAddress.safeParse((req.params as { address: string }).address)
    if (!address.success) return reply.status(400).send({ error: 'Invalid pool address' })
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 25) || 25))
    return getV3PoolActivity(address.data, limit)
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
