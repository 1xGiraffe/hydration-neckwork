import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, errorEnvelope, feedPage, requirePositionCursor,
  zAccountRef, zAssetId, zBlock, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import {
  CANDLE_BUCKETS, HOLDERS_RANK_DEPTH, assetCandles, assetHolders, currentPrice, getAsset, listAssets, priceAtBlock, priceAtTime,
  type CandleBucket,
} from '../services/assetsData.ts'
import { assetSwaps, assetTransfers } from '../services/assetFeeds.ts'
import { accountRefFor } from '../services/address.ts'

const zAssetItem = z.object({
  assetId: zAssetId,
  symbol: z.string(),
  name: z.string().nullable(),
  decimals: z.number().int(),
  parachainId: z.number().int().nullable(),
  origin: z.object({ ecosystem: z.string(), chainId: z.string(), assetId: z.string().nullable() }).nullable()
    .describe('Where a bridged asset originates; null for native assets.'),
  priceUsd: z.string().nullable()
    .describe('Current USD price as a decimal string; null when the asset has no price fresher than 30 days (an asset whose feed died is unpriced, never priced at its final close).'),
  priceUpdatedAt: zIsoTimestamp.nullable(),
})

const zPriceAt = z.object({
  assetId: zAssetId,
  priceUsd: z.string().nullable(),
  atBlock: z.number().int().nullable().describe('The block the reported price actually comes from — the newest price row at or before the requested point.'),
  atTime: zIsoTimestamp.nullable(),
})

const zCandle = z.object({
  time: zIsoTimestamp,
  open: z.string(), high: z.string(), low: z.string(), close: z.string(),
  volumeBuy: z.string(), volumeSell: z.string(), volumeTotal: z.string(),
}).describe('All values are USD decimal strings at full precision.')

const zHolder = z.object({
  account: zAccountRef,
  amount: z.string().describe('Current balance, raw integer units of the asset.'),
  lastBlock: z.number().int().nullable().describe('The block of the newest balance observation; null for ERC-20-snapshot holders.'),
})

const zBucketParam = z.enum(Object.keys(CANDLE_BUCKETS) as [CandleBucket, ...CandleBucket[]])

const zFeedWithWindow = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  fromBlock: zBlock.optional(),
  toBlock: zBlock.optional(),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

const NOT_FOUND_HINT = 'list ids via /v1/assets'

function parseAssetId(raw: string): number {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id < 0 || id > 4_294_967_295) throw badRequest('expected a decimal asset id')
  return id
}

export const assetsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/assets', {
    schema: {
      tags: ['assets'],
      summary: 'The full asset registry with current prices',
      description: 'Every registered asset (native, bridged, aToken forms), with decimals and symbols — the lookup table for every `assetId` and raw amount on this surface. The registry is an in-memory snapshot refreshed every 5 minutes; prices refresh every 5 minutes. The Omnipool hub asset (id 1) is named H2O.',
      response: { 200: z.object({ items: z.array(zAssetItem) }) },
    },
  }, async () => ({ items: await listAssets(opts.client) }))

  app.get('/v1/assets/:id', {
    schema: {
      tags: ['assets'],
      summary: 'One asset by registry id',
      params: z.object({ id: zAssetId }),
      response: { 200: zAssetItem, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    const asset = await getAsset(opts.client, id)
    if (!asset) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    return asset
  })

  app.get('/v1/assets/:id/price', {
    schema: {
      tags: ['assets'],
      summary: 'USD price, current or at a block/time',
      description: [
        'Without `at=`: the current price, subject to the 30-day freshness bound (a stale feed reports null).',
        'With `at=` (a block height, or an ISO-8601 time): the LAST price known at that point — an as-of read with NO staleness bound, deliberately: historical valuation uses the latest price known at the event. For an asset whose feed died this is its final close however old, so always read `atBlock`/`atTime` to see where the price actually comes from.',
      ].join('\n\n'),
      params: z.object({ id: zAssetId }),
      querystring: z.object({
        at: z.string().max(40).optional().describe('A block height in decimal, or an ISO-8601 UTC timestamp.'),
      }),
      response: { 200: zPriceAt, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    if (!(await getAsset(opts.client, id))) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const at = request.query.at?.trim()
    if (!at) return currentPrice(opts.client, id)
    if (/^\d+$/.test(at)) {
      const block = Number(at)
      if (!Number.isSafeInteger(block) || block > 4_294_967_295) throw badRequest('at= block height out of range')
      return cached(`data:asset:price-at:${id}:${block}`, 60_000, () => priceAtBlock(opts.client, id, block))
    }
    const parsed = Date.parse(at)
    if (Number.isNaN(parsed)) throw badRequest('at= must be a block height or an ISO-8601 timestamp')
    const epoch = Math.floor(parsed / 1000)
    return cached(`data:asset:price-at-t:${id}:${epoch}`, 60_000, () => priceAtTime(opts.client, id, epoch))
  })

  app.get('/v1/assets/:id/candles', {
    schema: {
      tags: ['assets'],
      summary: 'OHLCV candles',
      description: [
        'USD candles from the pre-aggregated OHLC tables, oldest first. `volume*` are USD sums of the bucket\'s trades.',
        'Buckets: 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1M (calendar month). There are NO 1-minute candles — the finest stored bucket is 5 minutes.',
        'The window (`fromTime`/`toTime`, both required) is bounded per bucket so a request cannot ask for millions of rows: 5m ≤ 14 days, 15m ≤ 30, 30m ≤ 60, 1h ≤ 120, 4h ≤ 366, 1d/1w/1M ≤ 10 years.',
      ].join('\n\n'),
      params: z.object({ id: zAssetId }),
      querystring: z.object({
        bucket: zBucketParam,
        fromTime: zTimeParam,
        toTime: zTimeParam,
      }),
      response: { 200: z.object({ items: z.array(zCandle) }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    const { bucket, fromTime, toTime } = request.query
    if (toTime <= fromTime) throw badRequest('toTime must be after fromTime')
    const maxSpan = CANDLE_BUCKETS[bucket].maxSpanDays * 86_400
    if (toTime - fromTime > maxSpan) {
      throw Object.assign(badRequest(`the ${bucket} bucket allows a window of at most ${CANDLE_BUCKETS[bucket].maxSpanDays} days; narrow the window or use a coarser bucket`),
        { context: { maxWindowDays: CANDLE_BUCKETS[bucket].maxSpanDays } })
    }
    if (!(await getAsset(opts.client, id))) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const key = `data:asset:candles:${id}:${bucket}:${fromTime}:${toTime}`
    return { items: await cached(key, 10_000, () => assetCandles(opts.client, id, bucket, fromTime, toTime)) }
  })

  app.get('/v1/assets/:id/transfers', {
    schema: {
      tags: ['assets'],
      summary: 'Transfers of one asset, newest first',
      description: 'Asset-first projection (transfer_activity), cursor-paginated: any depth of one asset\'s transfer history is a key-range read. HDX is asset 0. `from`/`to` may name module (pallet) accounts.',
      params: z.object({ id: zAssetId }),
      querystring: zFeedWithWindow,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        eventIndex: z.number().int(),
        extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
        timestamp: zIsoTimestamp,
        eventName: z.string(),
        from: zAccountRef.nullable(),
        to: zAccountRef.nullable(),
        amount: z.string(),
        valueUsd: z.string().nullable().describe('EVENT-TIME USD (the last closed hourly candle before the transfer, ≤30 days stale); null when the asset had no usable price then.'),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    if (!(await getAsset(opts.client, id))) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:asset:transfers:${id}:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => assetTransfers(opts.client, id, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/assets/:id/swaps', {
    schema: {
      tags: ['assets'],
      summary: 'Swaps touching one asset, newest first',
      description: 'Asset-first projection (asset_swap_activity): every swap event naming the asset on either side, including the legacy per-pallet events and Router.Executed rows (which carry no actor — `who` is null there; Broadcast-era actor attribution lives on /v1/trades).',
      params: z.object({ id: zAssetId }),
      querystring: zFeedWithWindow,
      response: { 200: zFeedPage(z.object({
        blockHeight: z.number().int(),
        eventIndex: z.number().int(),
        extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
        timestamp: zIsoTimestamp,
        eventName: z.string(),
        who: zAccountRef.nullable(),
        assetIn: zAssetId,
        assetOut: zAssetId,
        amountIn: z.string(),
        amountOut: z.string(),
      })), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    if (!(await getAsset(opts.client, id))) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:asset:swaps:${id}:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => assetSwaps(opts.client, id, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/assets/:id/holders', {
    schema: {
      tags: ['assets'],
      summary: 'Top holders by current balance',
      description: [
        'Top-N only (limit 1-100, no cursor): the list answers "who holds this asset", not "enumerate every holder"; `holderCount` is the exact number of accounts with a nonzero balance. Substrate balances come from the asset-first latest-balance projection; assets whose balances live only in ERC-20 form (some aToken/HOLLAR-family ids) fall back to the ERC-20 wallet snapshot, whose rows carry no observation block (`lastBlock: null`).',
        'Balances are CURRENT holdings in raw integer units; zero balances are excluded.',
      ].join('\n\n'),
      params: z.object({ id: zAssetId }),
      querystring: z.object({ limit: zLimit }),
      response: { 200: z.object({ items: z.array(zHolder), holderCount: z.number().int() }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseAssetId(request.params.id)
    if (!(await getAsset(opts.client, id))) {
      return reply.code(404).send(errorEnvelope('not_found', `no asset ${id} in the registry`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const { limit } = request.query
    const ranked = await cached(`data:asset:holders:${id}`, 60_000, () => assetHolders(opts.client, id, HOLDERS_RANK_DEPTH))
    return {
      items: ranked.rows.slice(0, limit).map(row => ({ account: accountRefFor(row.accountId), amount: row.amount, lastBlock: row.lastBlock })),
      holderCount: ranked.holderCount,
    }
  })
}
