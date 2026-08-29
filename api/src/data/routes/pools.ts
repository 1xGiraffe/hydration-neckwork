import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, errorEnvelope, feedPage, requireCursor, requirePositionCursor,
  zAccountRef, zAssetId, zBlock, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import {
  omnipoolHistory, omnipoolState, poolVolumes, stableswapHistory, stableswapState, xykHistory, xykState,
  type HistoryPageOptions,
} from '../services/poolsData.ts'
import { fillsPage } from '../services/swapFills.ts'
import { ADDRESS_FORMATS_HINT, accountRefFor, parseAddress } from '../services/address.ts'
import { zSwapFill, zVenue, type Venue } from './tradesShared.ts'

const zOmnipoolAsset = z.object({
  assetId: zAssetId,
  reserve: z.string(),
  hubReserve: z.string().describe('H2O (the hub asset) backing this position.'),
  shares: z.string(),
  protocolShares: z.string(),
  blockHeight: z.number().int(),
})

const zStableswapPool = z.object({
  poolId: z.string(),
  assetIds: z.array(zAssetId),
  reserves: z.array(z.string()).describe('Raw reserves, index-aligned with assetIds.'),
  amplification: z.number().int(),
  feePermill: z.number().int(),
  totalIssuance: z.string(),
  blockHeight: z.number().int(),
})

const zXykPool = z.object({
  poolAccount: zAccountRef,
  lpAssetId: zAssetId.nullable(),
  assetA: zAssetId,
  assetB: zAssetId,
  reserveA: z.string(),
  reserveB: z.string(),
  blockHeight: z.number().int(),
})

const zHistoryQuery = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  fromBlock: zBlock.optional(),
  toBlock: zBlock.optional(),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

const zVolumeBucket = z.object({
  bucket: zIsoTimestamp,
  assetId: zAssetId,
  side: z.enum(['in', 'out']),
  amount: z.string().describe('Raw integer sum of the bucket\'s deduplicated legs on this side.'),
  legCount: z.number().int(),
})

const MAX_VOLUME_WINDOW_DAYS = 90

// The stored pool_key per venue: 'omnipool' for the omnipool (one pool),
// the numeric pool/order id for stableswap and OTC, the pool's account for
// XYK and AAVE (0x-64-hex), and '' for the dead LBP pallet — which recorded no
// per-pool key, so its fills are reached venue-wide under the literal 'lbp'.
function normalizePoolKey(venue: Venue, raw: string): string {
  if (venue === 'omnipool') {
    if (raw !== 'omnipool') throw badRequest("the omnipool is one pool: its poolKey is literally 'omnipool'")
    return raw
  }
  if (venue === 'stableswap' || venue === 'otc') {
    if (!/^\d{1,10}$/.test(raw)) throw badRequest(`a ${venue} poolKey is the numeric ${venue === 'otc' ? 'order' : 'pool'} id`)
    return String(Number(raw))
  }
  if (venue === 'lbp') {
    if (raw !== 'lbp') throw badRequest("the LBP pallet recorded no per-pool key: its fills are addressed venue-wide as poolKey 'lbp'")
    return ''
  }
  const parsed = parseAddress(raw)
  if (!parsed) throw badRequest(`a ${venue} poolKey is the pool's account; ${ADDRESS_FORMATS_HINT}`)
  return parsed.accountId
}

async function poolHistoryPage<T>(
  request: { query: z.infer<typeof zHistoryQuery> },
  load: (options: HistoryPageOptions) => Promise<{ items: T[]; hasMore: boolean }>,
  cacheKey: string,
  blockOf: (item: T) => number,
): Promise<{ items: T[]; hasMore: boolean; nextCursor?: string }> {
  const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
  const cursorBlock = requireCursor(request.query.cursor, ['b'])?.b ?? null
  const { items, hasMore } = await cached(
    `${cacheKey}:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursorBlock ?? ''}:${limit}`,
    10_000,
    () => load({ limit, order, cursorBlock, fromBlock, toBlock, fromTime, toTime }),
  )
  return feedPage(items, hasMore, last => ({ b: blockOf(last) }))
}

export const poolsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/pools', {
    schema: {
      tags: ['pools'],
      summary: 'Every pool with its current state',
      description: [
        'The three AMM venues in one snapshot: Omnipool per-asset positions, Stableswap pools, XYK pairs. Reserves are raw integers; resolve decimals via /v1/assets.',
        'State is read from the per-block pool snapshot at the indexed head (`blockHeight` on every entry), so it lists exactly the pools live at that block — a delisted Omnipool asset or a dead pool is absent here and keeps its final rows in the /history routes.',
      ].join('\n\n'),
      response: {
        200: z.object({
          omnipool: z.array(zOmnipoolAsset),
          stableswap: z.array(zStableswapPool),
          xyk: z.array(zXykPool),
        }),
      },
    },
  }, async () => {
    const [omnipool, stableswap, xyk] = await Promise.all([
      omnipoolState(opts.client),
      stableswapState(opts.client),
      xykState(opts.client),
    ])
    return {
      omnipool,
      stableswap,
      xyk: xyk.map(pool => ({
        poolAccount: accountRefFor(pool.poolAccountId),
        lpAssetId: pool.lpAssetId,
        assetA: pool.assetA,
        assetB: pool.assetB,
        reserveA: pool.reserveA,
        reserveB: pool.reserveB,
        blockHeight: pool.blockHeight,
      })),
    }
  })

  app.get('/v1/pools/omnipool/:assetId/history', {
    schema: {
      tags: ['pools'],
      summary: 'Omnipool per-asset state history',
      description: 'One asset\'s Omnipool position over time on the 600-block sampling grid, newest first. A delisted asset\'s history simply ends; its last row is its final state (the asset is then absent from /v1/pools).',
      params: z.object({ assetId: zAssetId }),
      querystring: zHistoryQuery,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        timestamp: zIsoTimestamp,
        reserve: z.string(),
        hubReserve: z.string(),
        shares: z.string(),
        protocolShares: z.string(),
        specVersion: z.number().int(),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const assetId = Number(request.params.assetId)
    const page = await poolHistoryPage(request, options => omnipoolHistory(opts.client, assetId, options), `data:pools:omni-history:${assetId}`, item => item.blockHeight)
    if (page.items.length === 0 && !request.query.cursor && request.query.fromBlock == null && request.query.fromTime == null) {
      // No history at all: the asset was never in the Omnipool.
      const known = await omnipoolState(opts.client)
      if (!known.some(state => state.assetId === String(assetId))) {
        return reply.code(404).send(errorEnvelope('not_found', `asset ${assetId} has no Omnipool state history`,
          await notFoundContext(opts.client, { hint: 'list Omnipool assets via /v1/pools' })))
      }
    }
    return page
  })

  app.get('/v1/pools/stableswap/:poolId/history', {
    schema: {
      tags: ['pools'],
      summary: 'Stableswap pool state history',
      description: 'One pool\'s reserves, amplification (with its ramp bounds), fee and share issuance over time on the 600-block grid, newest first. `pegNum`/`pegDen` are the per-asset peg ratios (e.g. pool 690 prices vDOT off its Bifrost peg).',
      params: z.object({ poolId: zAssetId }),
      querystring: zHistoryQuery,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        timestamp: zIsoTimestamp,
        assetIds: z.array(zAssetId),
        reserves: z.array(z.string()),
        amplification: z.number().int(),
        initialAmplification: z.number().int(),
        finalAmplification: z.number().int(),
        initialBlock: z.number().int(),
        finalBlock: z.number().int(),
        feePermill: z.number().int(),
        totalIssuance: z.string(),
        pegNum: z.array(z.string()),
        pegDen: z.array(z.string()),
        specVersion: z.number().int(),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const poolId = Number(request.params.poolId)
    const page = await poolHistoryPage(request, options => stableswapHistory(opts.client, poolId, options), `data:pools:ss-history:${poolId}`, item => item.blockHeight)
    if (page.items.length === 0 && !request.query.cursor && request.query.fromBlock == null && request.query.fromTime == null) {
      const known = await stableswapState(opts.client)
      if (!known.some(state => state.poolId === String(poolId))) {
        return reply.code(404).send(errorEnvelope('not_found', `no stableswap pool ${poolId}`,
          await notFoundContext(opts.client, { hint: 'list stableswap pools via /v1/pools' })))
      }
    }
    return page
  })

  app.get('/v1/pools/xyk/:poolAccount/history', {
    schema: {
      tags: ['pools'],
      summary: 'XYK pool reserve history',
      description: 'One XYK pair\'s reserves over time on the 600-block grid, newest first. The pool is addressed by its account (SS58, H160, or 0x-64-hex).',
      params: z.object({ poolAccount: z.string().min(3).max(128) }),
      querystring: zHistoryQuery,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        timestamp: zIsoTimestamp,
        assetA: zAssetId,
        assetB: zAssetId,
        reserveA: z.string(),
        reserveB: z.string(),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const parsed = parseAddress(request.params.poolAccount)
    if (!parsed) throw badRequest(`unparseable pool account; ${ADDRESS_FORMATS_HINT}`)
    const page = await poolHistoryPage(request, options => xykHistory(opts.client, parsed.accountId, options), `data:pools:xyk-history:${parsed.accountId}`, item => item.blockHeight)
    if (page.items.length === 0 && !request.query.cursor && request.query.fromBlock == null && request.query.fromTime == null) {
      const known = await xykState(opts.client)
      if (!known.some(state => state.poolAccountId === parsed.accountId)) {
        return reply.code(404).send(errorEnvelope('not_found', `no XYK pool at ${parsed.address}`,
          await notFoundContext(opts.client, { hint: 'list XYK pools via /v1/pools' })))
      }
    }
    return page
  })

  app.get('/v1/pools/:venue/:poolKey/trades', {
    schema: {
      tags: ['pools'],
      summary: 'One pool\'s swap fills, newest first',
      description: [
        'Fills from the leg projection, venue+pool key-pruned, cursor-paginated. Each fill groups its in/out/fee legs; `fees` RESTATE value the in/out legs already carry — never add them to trade flow, they are a revenue breakdown.',
        'Pool keys per venue: `omnipool` → literally `omnipool` (one pool); `stableswap`/`otc` → the numeric pool/order id; `xyk`/`aave` → the pool or contract account; `lbp` → literally `lbp` (the dead LBP pallet recorded no per-pool key, so its fills are reached venue-wide).',
        'Era split at block 6,837,788 (the first Broadcast.Swapped): a modern Omnipool route reports its hub hops as separate fills, a legacy fill is the whole A→B swap with no hub leg and no `opKey`. A legacy fee leg\'s `feeDest: null` is genuinely unknowable, not unset. Fills with no local actor (XCM-originated placeholders) report `swapper: null`.',
      ].join('\n\n'),
      params: z.object({ venue: zVenue, poolKey: z.string().min(1).max(128) }),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        fromBlock: zBlock.optional(),
        toBlock: zBlock.optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: zFeedPage(zSwapFill), 400: zError },
    },
  }, async request => {
    const { venue } = request.params
    const poolKey = normalizePoolKey(venue, request.params.poolKey)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:pool:trades:${venue}:${poolKey}:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => fillsPage(opts.client, { venue, poolKey }, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/pools/:venue/:poolKey/volumes', {
    schema: {
      tags: ['pools'],
      summary: 'One pool\'s volume, bucketed',
      description: [
        'Hourly or daily sums of the pool\'s deduplicated in/out legs, per asset and side, from the pre-aggregated hourly fold. Amounts are raw integers of each asset — value them with /v1/assets/{id}/price if USD is needed.',
        'The fold holds CLOSED hours only (the aggregation job never writes the hour in progress), so this endpoint runs up to ~1-2 hours behind the head by construction. Fee legs are excluded: they restate in/out value.',
      ].join('\n\n'),
      params: z.object({ venue: zVenue, poolKey: z.string().min(1).max(128) }),
      querystring: z.object({
        bucket: z.enum(['hour', 'day']).default('day'),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: z.object({ items: z.array(zVolumeBucket) }), 400: zError },
    },
  }, async request => {
    const { venue, poolKey: rawKey } = request.params
    const poolKey = normalizePoolKey(venue, rawKey)
    const { bucket } = request.query
    const toTime = request.query.toTime ?? Math.floor(Date.now() / 1000)
    const fromTime = request.query.fromTime ?? toTime - 7 * 86_400
    if (toTime <= fromTime) throw badRequest('toTime must be after fromTime')
    if (toTime - fromTime > MAX_VOLUME_WINDOW_DAYS * 86_400) {
      throw Object.assign(badRequest(`the volume window is bounded at ${MAX_VOLUME_WINDOW_DAYS} days`), { context: { maxWindowDays: MAX_VOLUME_WINDOW_DAYS } })
    }
    const key = `data:pool:volumes:${venue}:${poolKey}:${bucket}:${Math.floor(fromTime / 3600)}:${Math.floor(toTime / 3600)}`
    return { items: await cached(key, 60_000, () => poolVolumes(opts.client, venue, poolKey, bucket, fromTime, toTime)) }
  })
}
