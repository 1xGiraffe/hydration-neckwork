import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  MAX_BLOCK, badRequest, errorEnvelope, feedPage, requireCursor,
  zAccountRef, zBlock, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { dataStatus, notFoundContext } from '../services/head.ts'
import { blockByHash, blockByHeight, blockCounts, blockEvents, blockExtrinsics, blocksFeed } from '../services/chainCore.ts'
import { zEventItem, zExtrinsicItem } from './extrinsicsShared.ts'

const BLOCK_HASH_RE = /^0x[0-9a-f]{64}$/

const zBlockHeader = z.object({
  height: z.number().int(),
  hash: z.string(),
  parentHash: z.string(),
  timestamp: zIsoTimestamp,
  specVersion: z.number().int(),
  author: zAccountRef.nullable().describe('The collator that authored the block, when the indexer recorded one.'),
})

const zBlockDetail = zBlockHeader.extend({
  extrinsicCount: z.number().int(),
  eventCount: z.number().int(),
})

const zBlocksQuery = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  fromBlock: zBlock.optional(),
  toBlock: zBlock.optional(),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

export const blocksRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/blocks', {
    schema: {
      tags: ['chain'],
      summary: 'Block headers, newest first',
      description: 'Cursor-paginated over the primary key, so any depth of history costs one key-range read. `fromBlock`/`toBlock`/`fromTime`/`toTime` bound the window; `order=asc` walks forward.',
      querystring: zBlocksQuery,
      response: { 200: zFeedPage(zBlockHeader), 400: zError },
    },
  }, async request => {
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursorHeight = requireCursor(request.query.cursor, ['b'])?.b ?? null
    const { indexedHead } = await dataStatus(opts.client)
    const key = `data:blocks:${order}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursorHeight ?? ''}:${limit}:h${indexedHead}`
    const { items, hasMore } = await cached(key, 3_000, () => blocksFeed(opts.client, { limit, order, cursorHeight, fromBlock, toBlock, fromTime, toTime, head: indexedHead }))
    return feedPage(items, hasMore, last => ({ b: last.height }))
  })

  app.get('/v1/blocks/:heightOrHash', {
    schema: {
      tags: ['chain'],
      summary: 'One block by height or hash',
      description: 'A decimal height is a primary-key read; a 0x-prefixed 32-byte hash resolves through the full-history hash index. The 404 context carries the indexed head (and `aheadBy` when the height is above it), so a consumer can tell an unknown block from one not yet ingested.',
      params: z.object({ heightOrHash: z.string().max(80).describe('A block height in decimal, or a 0x-prefixed 32-byte block hash.') }),
      response: { 200: zBlockDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const raw = request.params.heightOrHash.toLowerCase()
    let header
    let requestedHeight: number | undefined
    if (/^\d+$/.test(raw)) {
      const height = Number(raw)
      if (!Number.isSafeInteger(height) || height > MAX_BLOCK) throw badRequest(`block height must be at most ${MAX_BLOCK}`)
      requestedHeight = height
      header = await cached(`data:block:h:${height}`, 10_000, () => blockByHeight(opts.client, height))
    } else if (BLOCK_HASH_RE.test(raw)) {
      header = await cached(`data:block:hash:${raw}`, 10_000, () => blockByHash(opts.client, raw))
    } else {
      throw badRequest('expected a decimal block height or a 0x-prefixed 32-byte block hash')
    }
    if (!header) {
      return reply.code(404).send(errorEnvelope('not_found', `no block ${raw} indexed`,
        await notFoundContext(opts.client, { requestedHeight, hint: 'the hash index covers the full chain history; a block above indexedHead has not been ingested yet' })))
    }
    const counts = await cached(`data:block:counts:${header.height}`, 10_000, () => blockCounts(opts.client, header.height))
    return { ...header, ...counts }
  })

  app.get('/v1/blocks/:height/extrinsics', {
    schema: {
      tags: ['chain'],
      summary: 'All extrinsics of one block',
      description: 'A point range on the extrinsics table\'s primary key, un-paginated: a block\'s contents are bounded by block weight. 404 when the block itself is not indexed.',
      params: z.object({ height: zBlock }),
      response: { 200: z.object({ items: z.array(zExtrinsicItem) }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { height } = request.params
    const header = await cached(`data:block:h:${height}`, 10_000, () => blockByHeight(opts.client, height))
    if (!header) {
      return reply.code(404).send(errorEnvelope('not_found', `no block ${height} indexed`,
        await notFoundContext(opts.client, { requestedHeight: height })))
    }
    return { items: await cached(`data:block:extrinsics:${height}`, 10_000, () => blockExtrinsics(opts.client, height)) }
  })

  app.get('/v1/blocks/:height/events', {
    schema: {
      tags: ['chain'],
      summary: 'All events of one block',
      description: 'A point range on the events table\'s primary key, with `args` decoded. 404 when the block itself is not indexed.',
      params: z.object({ height: zBlock }),
      response: { 200: z.object({ items: z.array(zEventItem) }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { height } = request.params
    const header = await cached(`data:block:h:${height}`, 10_000, () => blockByHeight(opts.client, height))
    if (!header) {
      return reply.code(404).send(errorEnvelope('not_found', `no block ${height} indexed`,
        await notFoundContext(opts.client, { requestedHeight: height })))
    }
    return { items: await cached(`data:block:events:${height}`, 10_000, () => blockEvents(opts.client, height)) }
  })
}
