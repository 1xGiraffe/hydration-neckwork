import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, errorEnvelope, feedPage, requirePositionCursor,
  zAssetId, zCursor, zError, zFeedPage, zLimit, zOrder,
} from '../schemas/common.ts'
import { windowKey, zWindowQuartet } from './accountsShared.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { intentEvents, intentOrderById, intentOrders } from '../services/intentData.ts'
import { ADDRESS_FORMATS_HINT, parseAddress } from '../services/address.ts'
import { INTENT_NOTE, INTENT_STATUS_NOTE, zIntent, zIntentDetail, zIntentEvent, zIntentKind } from './intentsShared.ts'

// A u128 in decimal is at most 39 digits.
const zIntentId = z.string().regex(/^\d{1,39}$/, 'expected a decimal intent id')
  .refine(id => BigInt(id) <= 2n ** 128n - 1n, 'intent id exceeds u128')

const NOT_FOUND_HINT = 'list ids via /v1/intents'

export const intentsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/intents', {
    schema: {
      tags: ['intents'],
      summary: 'ICE intents as submitted, newest first',
      description: [
        INTENT_NOTE,
        'Intent facts exactly as the chain recorded them at submission — this surface does not restate lifecycle status (fold one order\'s status from /v1/intents/{id}, which carries it). Cursor pages over (block, event index); `kind=` and `asset=` (either side of the pair) filter before pagination, and `owner=` reads the owner-first projection.',
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        owner: z.string().min(3).max(128).optional(),
        kind: zIntentKind.optional(),
        asset: zAssetId.optional().describe('Matches either side of the pair.'),
        ...zWindowQuartet,
      }),
      response: { 200: zFeedPage(zIntent), 400: zError },
    },
  }, async request => {
    const { limit, order, kind, asset, fromBlock, toBlock, fromTime, toTime } = request.query
    const owner = request.query.owner ? parseAddress(request.query.owner) : null
    if (request.query.owner && !owner) throw badRequest(`unparseable owner; ${ADDRESS_FORMATS_HINT}`)
    const cursor = requirePositionCursor(request.query.cursor)
    const window = { fromBlock, toBlock, fromTime, toTime }
    const head = await liveHeadTag(opts.client)
    const key = `data:intents:list:${order}:${owner?.accountId ?? ''}:${kind ?? ''}:${asset ?? ''}:${windowKey(window)}:${cursor ? `${cursor.b}-${cursor.i}` : ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => intentOrders(opts.client, {
      limit, order, cursor, ownerAccountId: owner?.accountId, kind, asset, ...window,
    }))
    return feedPage(items, hasMore, last => ({ b: last.createdAtBlock, i: last.createdAtEventIndex }))
  })

  app.get('/v1/intents/:id', {
    schema: {
      tags: ['intents'],
      summary: 'One intent with its folded status and fill totals',
      description: [
        INTENT_NOTE,
        INTENT_STATUS_NOTE,
        'The fill totals are exact integer sums folded by the database over the order\'s own stretch of the event table — bounded by the submission block, since no event of an order can precede it.',
      ].join('\n\n'),
      params: z.object({ id: zIntentId }),
      response: { 200: zIntentDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { id } = request.params
    // Freshly read from the order's own key range: an order being watched for
    // fills must not lag a shared cache.
    const found = await cached(`data:intents:order:${id}`, 3_000, () => intentOrderById(opts.client, id))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no intent ${id}`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    return found
  })

  app.get('/v1/intents/:id/events', {
    schema: {
      tags: ['intents'],
      summary: 'One intent\'s lifecycle events, newest first',
      description: [
        'Every event of the order\'s life: its submission, each full or partial resolution, each dca trade, its completion, cancellation or expiry, and a failed forward callback.',
        'Only the submission names the owner and the pair — every later event carries the id alone — so amounts here are the trade\'s, not the order\'s. Intent.DcaCompleted is the exception that carries neither: the trade that exhausts a dca budget states its amounts only in the solution\'s settlement transfers.',
      ].join('\n\n'),
      params: z.object({ id: zIntentId }),
      querystring: z.object({ limit: zLimit, cursor: zCursor, order: zOrder, ...zWindowQuartet }),
      response: { 200: zFeedPage(zIntentEvent), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    // The order's own submission block bounds every read of the event table,
    // which is keyed (block, event index) and cannot prune on an intent id.
    const found = await cached(`data:intents:order:${id}`, 3_000, () => intentOrderById(opts.client, id))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no intent ${id}`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const window = { fromBlock, toBlock, fromTime, toTime }
    const head = await liveHeadTag(opts.client)
    const key = `data:intents:events:${id}:${order}:${windowKey(window)}:${cursor ? `${cursor.b}-${cursor.i}` : ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => intentEvents(opts.client, id, found.createdAtBlock, { limit, order, cursor, ...window }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
