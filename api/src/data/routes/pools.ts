import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { assetDescriptor } from '../../services/explorerAssets.ts'
import { v3PoolLiquidity } from '../../services/uniswapV3Ranges.ts'
import {
  badRequest, errorEnvelope, feedPage, requireCursor, requirePositionCursor,
  zAccountRef, zAssetId, zBlock, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import {
  omnipoolHistory, omnipoolState, poolVolumes, stableswapHistory, stableswapState, uniswapV3History, uniswapV3State, xykHistory, xykState,
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

// A concentrated-liquidity pool: its contract, tokens (EVM addresses and, where the
// registry knows the contract, the asset ids), fee tier, and the price/liquidity its
// last Swap or Initialize log reported. No reserves: a v3 pool's holdings are not its
// price, see /v1/pools/uniswapv3/{pool}/volumes for what trades through it.
const zUniswapV3Pool = z.object({
  pool: z.string().describe('Pool contract address (0x + 40 hex, lowercase); the poolKey of the uniswapv3 venue.'),
  token0: z.string(),
  token1: z.string(),
  asset0: zAssetId.nullable(),
  asset1: zAssetId.nullable(),
  fee: z.number().int().describe('Fee tier in hundredths of a bip: 3000 = 0.3%.'),
  tickSpacing: z.number().int(),
  sqrtPriceX96: z.string().nullable().describe('Q64.96 sqrt(token1/token0) after the last swap, raw units.'),
  tick: z.number().int().nullable(),
  liquidity: z.string().nullable().describe("Active liquidity: the pool's open ranges (Mints net of Burns) straddling `tick` — what its `liquidity()` returns. Null before the pool is initialised. The distribution behind it is /v1/pools/uniswapv3/{pool}/liquidity."),
  createdBlock: z.number().int(),
  blockHeight: z.number().int().describe('Block of the last pool event this state reflects.'),
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
  if (venue === 'uniswapv3') {
    // A concentrated-liquidity pool is its EVM contract (lowercase 0x + 40 hex).
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw badRequest('a uniswapv3 poolKey is the pool contract address: 0x followed by 40 hex characters')
    return raw.toLowerCase()
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
        'The AMM venues in one snapshot: Omnipool per-asset positions, Stableswap pools, XYK pairs, and the concentrated-liquidity (Uniswap v3) pools on Hydration\'s EVM. Reserves are raw integers; resolve decimals via /v1/assets.',
        'State is read from the per-block pool snapshot at the indexed head (`blockHeight` on every entry), so it lists exactly the pools live at that block — a delisted Omnipool asset or a dead pool is absent here and keeps its final rows in the /history routes.',
      ].join('\n\n'),
      response: {
        200: z.object({
          omnipool: z.array(zOmnipoolAsset),
          stableswap: z.array(zStableswapPool),
          xyk: z.array(zXykPool),
          uniswapV3: z.array(zUniswapV3Pool),
        }),
      },
    },
  }, async () => {
    const [omnipool, stableswap, xyk, uniswapV3] = await Promise.all([
      omnipoolState(opts.client),
      stableswapState(opts.client),
      xykState(opts.client),
      uniswapV3State(opts.client),
    ])
    return {
      omnipool,
      stableswap,
      uniswapV3,
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

  app.get('/v1/pools/uniswapv3/:pool/history', {
    schema: {
      tags: ['pools'],
      summary: 'Uniswap v3 pool price and liquidity history, per swap',
      description: [
        'One concentrated-liquidity pool\'s state over time, newest first: one row per `Swap` log (and the pool\'s `Initialize`), carrying the `sqrtPriceX96`, `tick` and in-range `liquidity` the pool reported AFTER that swap, plus the swap\'s signed `amount0`/`amount1` (positive = paid into the pool, raw units of token0/token1 — resolve them via /v1/pools `uniswapV3[].asset0/asset1`). Unlike the pallet venues there is no per-block state sample: a v3 pool\'s price is the last swap\'s, so the history is per event and pages on the `{b, i}` position cursor. Price in token1 per token0 = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 − decimals1).',
        '`liquidity` is the liquidity active at the post-swap tick as of that swap; a Mint or Burn in range since then is not reflected until the next swap. Fills themselves are /v1/pools/uniswapv3/{pool}/trades.',
      ].join('\n\n'),
      params: z.object({ pool: z.string().min(3).max(64).describe('The pool contract address (0x + 40 hex).') }),
      querystring: zHistoryQuery,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        eventIndex: z.number().int(),
        timestamp: zIsoTimestamp,
        eventName: z.enum(['Swap', 'Initialize']),
        sqrtPriceX96: z.string().describe('Q64.96 sqrt(token1/token0) after the event, raw units.'),
        tick: z.number().int(),
        liquidity: z.string().nullable().describe('In-range liquidity after the swap; null on Initialize.'),
        amount0: z.string().nullable().describe('Signed token0 delta of the swap (positive = into the pool); null on Initialize.'),
        amount1: z.string().nullable(),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const pool = normalizePoolKey('uniswapv3', request.params.pool)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const key = `data:pools:v3-history:${pool}:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}`
    const page = await cached(key, 10_000, () => uniswapV3History(opts.client, pool, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    if (page.items.length === 0 && !cursor && fromBlock == null && fromTime == null) {
      const known = await uniswapV3State(opts.client)
      if (!known.some(state => state.pool === pool)) {
        return reply.code(404).send(errorEnvelope('not_found', `no Uniswap v3 pool at ${pool}`,
          await notFoundContext(opts.client, { hint: 'list the concentrated-liquidity pools via /v1/pools (uniswapV3)' })))
      }
    }
    return feedPage(page.items, page.hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/pools/uniswapv3/:pool/liquidity', {
    schema: {
      tags: ['pools'],
      summary: 'Uniswap v3 pool liquidity distribution',
      description: [
        'Where one concentrated-liquidity pool\'s liquidity sits at the indexed head: its open positions (every `Mint` net of the `Burn`s against the same owner and tick range) as the initialised-tick table (`ticks`, ascending: liquidityNet is added when the price crosses the tick upwards), as the liquidity standing between consecutive initialised ticks (`segments`, with the token0/token1 each holds at the current price) and as the ranges themselves (`ranges`, deepest first, by the H160 that minted them — a Gamma vault, the NonfungiblePositionManager or a contract of its own).',
        '`liquidity` is the sum of the ranges straddling `tick`: the figure the pool\'s `liquidity()` returns, and the one /v1/pools reports. It is the pool\'s own logs replayed, so it moves with a Mint or Burn rather than only at the next swap. Amounts are raw integer units (floored); prices are token1 per token0 in whole tokens and are null when either token has no registry asset to take decimals from. A burn(0) poke changes nothing and is not an event here.',
      ].join('\n\n'),
      params: z.object({ pool: z.string().min(3).max(64).describe('The pool contract address (0x + 40 hex).') }),
      response: {
        200: z.object({
          pool: z.string(),
          token0: z.string(), token1: z.string(),
          asset0: zAssetId.nullable(), asset1: zAssetId.nullable(),
          fee: z.number().int(), tickSpacing: z.number().int(),
          blockHeight: z.number().int().nullable().describe("The pool's last event this state includes."),
          tick: z.number().int().nullable(), sqrtPriceX96: z.string().nullable(),
          price: z.string().nullable().describe('token1 per token0 in whole tokens at the current sqrt price; null without registry decimals.'),
          liquidity: z.string().nullable(),
          ticks: z.array(z.object({ tick: z.number().int(), price: z.string().nullable(), liquidityNet: z.string(), liquidityGross: z.string() })),
          segments: z.array(z.object({ tickLower: z.number().int(), tickUpper: z.number().int(), priceLower: z.string().nullable(), priceUpper: z.string().nullable(), liquidity: z.string(), amount0: z.string(), amount1: z.string() })),
          ranges: z.array(z.object({ owner: z.string(), tickLower: z.number().int(), tickUpper: z.number().int(), priceLower: z.string().nullable(), priceUpper: z.string().nullable(), liquidity: z.string(), amount0: z.string(), amount1: z.string(), positions: z.number().int(), inRange: z.boolean() })),
        }),
        400: zError, 404: zError,
      },
    },
  }, async (request, reply) => {
    const pool = normalizePoolKey('uniswapv3', request.params.pool)
    const known = (await uniswapV3State(opts.client)).find(state => state.pool === pool)
    if (!known) {
      return reply.code(404).send(errorEnvelope('not_found', `no Uniswap v3 pool at ${pool}`,
        await notFoundContext(opts.client, { hint: 'list the concentrated-liquidity pools via /v1/pools (uniswapV3)' })))
    }
    // Decimals only scale the PRICES; the tick table and the token amounts are exact
    // without them, so a pool whose token is off the registry still answers in full.
    const priced = known.asset0 != null && known.asset1 != null
    const decimals0 = known.asset0 != null ? assetDescriptor(Number(known.asset0)).decimals : 0
    const decimals1 = known.asset1 != null ? assetDescriptor(Number(known.asset1)).decimals : 0
    const dist = await cached(`data:pools:v3-liquidity:${pool}`, 10_000, () => v3PoolLiquidity(opts.client, { address: pool, decimals0, decimals1 }))
    const price = (v: number | null): string | null => (!priced || v == null ? null : Number(v.toPrecision(12)).toString())
    return {
      pool: dist.pool, token0: known.token0, token1: known.token1, asset0: known.asset0, asset1: known.asset1,
      fee: known.fee, tickSpacing: known.tickSpacing,
      blockHeight: dist.blockHeight, tick: dist.tick, sqrtPriceX96: dist.sqrtPriceX96,
      price: price(dist.price), liquidity: dist.liquidity,
      ticks: dist.ticks.map(t => ({ tick: t.tick, price: price(t.price), liquidityNet: t.liquidityNet, liquidityGross: t.liquidityGross })),
      segments: dist.segments.map(x => ({ tickLower: x.tickLower, tickUpper: x.tickUpper, priceLower: price(x.priceLower), priceUpper: price(x.priceUpper), liquidity: x.liquidity, amount0: x.amount0, amount1: x.amount1 })),
      ranges: dist.ranges.map(r => ({ owner: r.owner, tickLower: r.tickLower, tickUpper: r.tickUpper, priceLower: price(r.priceLower), priceUpper: price(r.priceUpper), liquidity: r.liquidity, amount0: r.amount0, amount1: r.amount1, positions: r.positions, inRange: r.inRange })),
    }
  })

  app.get('/v1/pools/:venue/:poolKey/trades', {
    schema: {
      tags: ['pools'],
      summary: 'One pool\'s swap fills, newest first',
      description: [
        'Fills from the leg projection, venue+pool key-pruned, cursor-paginated. Each fill groups its in/out/fee legs; `fees` RESTATE value the in/out legs already carry — never add them to trade flow, they are a revenue breakdown.',
        'Pool keys per venue: `omnipool` → literally `omnipool` (one pool); `stableswap`/`otc` → the numeric pool/order id; `xyk`/`aave` → the pool or contract account; `lbp` → literally `lbp` (the dead LBP pallet recorded no per-pool key, so its fills are reached venue-wide); `uniswapv3` → the pool CONTRACT address (0x + 40 hex; the concentrated-liquidity pools on Hydration\'s EVM, listed under /v1/pools `uniswapV3`).',
        'A `uniswapv3` fill is either a Router-routed hop (its Broadcast fill, netted with its siblings by `opKey`) or a direct EVM swap against the pool, booked from the pool\'s own Swap log with `opKey` `evm:<block>:<event>` and the swap\'s recipient as `swapper`; the direct ones reach this feed a few minutes behind the head (the uniswap_v3_legs derivation). Its fee leg is the pool fee the swap paid its liquidity providers (amount in × fee tier).',
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
        'Hourly or daily sums of the pool\'s deduplicated in/out legs, per asset and side: the pre-aggregated hourly fold below its cut, the pool\'s raw legs above it, so the series reaches the indexed head. Amounts are raw integers of each asset — value them with /v1/assets/{id}/price if USD is needed.',
        'The fold holds CLOSED hours only and a live month is republished about once a day; the raw tail covers that gap, so a leg is counted once and the last buckets are as fresh as the leg model (a direct Uniswap v3 swap reaches it a few minutes behind the head). Legs backfilled BELOW the cut into an already-folded month under-report until the next derivations cycle re-folds that month. Fee legs are excluded: they restate in/out value.',
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
