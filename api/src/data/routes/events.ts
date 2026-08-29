import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, csv, errorEnvelope, feedPage, requirePositionCursor,
  zBlock, zCursor, zError, zFeedPage, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { eventAt, eventsFeed } from '../services/chainCore.ts'
import { MAX_FILTER_WINDOW_DAYS } from '../services/feed.ts'
import { zEventItem } from './extrinsicsShared.ts'

const EVENT_ID_RE = /^(\d{1,10})-(\d{1,10})$/

const zEventsQuery = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  name: z.string().max(400).optional()
    .describe(`Comma-separated \`Pallet.Event\` names. A name predicate cannot prune the primary key, so it requires a bounded window (fromTime+toTime ≤ ${MAX_FILTER_WINDOW_DAYS} days, or fromBlock+toBlock).`),
  fromBlock: zBlock.optional(),
  toBlock: zBlock.optional(),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

export const eventsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/events', {
    schema: {
      tags: ['chain'],
      summary: 'Events feed, newest first',
      description: 'Cursor-paginated over the primary key, with `args` decoded. Filtering by `name=` requires a bounded window (see the parameter note); block/time filters prune partitions on their own.',
      querystring: zEventsQuery,
      response: { 200: zFeedPage(zEventItem), 400: zError },
    },
  }, async request => {
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const names = csv(request.query.name)
    const head = await liveHeadTag(opts.client)
    const key = `data:events:${order}:${[...names].sort().join(',')}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => eventsFeed(opts.client, {
      limit, order, cursor,
      names: names.length ? names : undefined,
      fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/events/:id', {
    schema: {
      tags: ['chain'],
      summary: 'One event by `{blockHeight}-{eventIndex}`',
      description: 'The event\'s canonical identity — a primary-key read at any depth of history, with `args` decoded.',
      params: z.object({ id: z.string().max(30).describe('`{blockHeight}-{eventIndex}`.') }),
      response: { 200: zEventItem, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const match = EVENT_ID_RE.exec(request.params.id)
    const blockHeight = match ? Number(match[1]) : NaN
    const eventIndex = match ? Number(match[2]) : NaN
    if (!match || blockHeight > 4_294_967_295 || eventIndex > 4_294_967_295) {
      throw badRequest('expected an event id of the form `{blockHeight}-{eventIndex}`')
    }
    const found = await cached(`data:event:at:${blockHeight}:${eventIndex}`, 10_000, () => eventAt(opts.client, blockHeight, eventIndex))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no event ${request.params.id} indexed`,
        await notFoundContext(opts.client, { requestedHeight: blockHeight })))
    }
    return found
  })
}
