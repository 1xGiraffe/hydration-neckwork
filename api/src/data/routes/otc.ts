import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  errorEnvelope, feedPage, requireCursor,
  zAssetId, zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder,
} from '../schemas/common.ts'
import { notFoundContext } from '../services/head.ts'
import { allOtcOrders, otcOrderById } from '../services/otcData.ts'
import { zOtcEvent } from './otcShared.ts'

const PLACED_ROW_NOTE = 'The pair, size and `partiallyFillable` are read ONLY from the order\'s Placed event: on every other OTC event an absent field defaults to 0, and 0 is HDX\'s real asset id, so reading them elsewhere would silently report HDX/HDX. An order has no owner on this surface — OTC.Placed does not carry one, and the placing signatory would be wrong for a proxied or batched placement.'

const zOtcOrder = z.object({
  orderId: z.number().int(),
  assetIn: zAssetId,
  assetOut: zAssetId,
  amountIn: z.string(),
  amountOut: z.string(),
  partiallyFillable: z.boolean(),
  status: z.enum(['open', 'filled', 'cancelled']),
  filledAmountIn: z.string().describe('Exact integer sum over every fill event.'),
  filledAmountOut: z.string(),
  placedAtBlock: z.number().int(),
  placedAt: zIsoTimestamp,
})

const zOtcOrderDetail = zOtcOrder.extend({ events: z.array(zOtcEvent) })

const zOrderId = z.string().regex(/^\d{1,10}$/, 'expected a decimal order id')

const NOT_FOUND_HINT = 'list ids via /v1/otc/orders'

export const otcRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/otc/orders', {
    schema: {
      tags: ['otc'],
      summary: 'OTC orders with folded state, newest first',
      description: [
        'Order state folds from the order\'s own events at read time: `open` until a terminal event, then `filled` or `cancelled` — partial fills never end an order (an order pulled after two partial fills is `cancelled`, with its progress in `filledAmountIn`/`filledAmountOut`). In product copy a cancellation is a **Pull**.',
        PLACED_ROW_NOTE,
        'Cursor pages over the order id; `status=` and `asset=` (either side of the placed pair) filter before pagination.',
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        status: z.enum(['open', 'filled', 'cancelled']).optional(),
        asset: zAssetId.optional(),
      }),
      response: { 200: zFeedPage(zOtcOrder), 400: zError },
    },
  }, async request => {
    const { limit, order, status, asset } = request.query
    const cursorId = requireCursor(request.query.cursor, ['o'])?.o ?? null
    let orders = await allOtcOrders(opts.client)
    if (status) orders = orders.filter(entry => entry.status === status)
    if (asset != null) orders = orders.filter(entry => entry.assetIn === asset || entry.assetOut === asset)
    if (order === 'asc') orders = [...orders].reverse()
    const start = cursorId == null
      ? 0
      : orders.findIndex(entry => (order === 'desc' ? entry.orderId < cursorId : entry.orderId > cursorId))
    const from = start === -1 ? orders.length : start
    const page = orders.slice(from, from + limit)
    const hasMore = from + limit < orders.length
    const items = page.map(({ events: _events, ...item }) => item)
    return feedPage(items, hasMore, last => ({ o: last.orderId }))
  })

  app.get('/v1/otc/orders/:id', {
    schema: {
      tags: ['otc'],
      summary: 'One OTC order with its full event history',
      description: [
        'The fold of one order\'s events, freshly read from the order\'s own key range (an order being watched for fills must not lag a shared cache).',
        PLACED_ROW_NOTE,
      ].join('\n\n'),
      params: z.object({ id: zOrderId }),
      response: { 200: zOtcOrderDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id)
    const found = await cached(`data:otc:order:${id}`, 3_000, () => otcOrderById(opts.client, id))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no OTC order ${id} (an order whose placement is not indexed has no knowable pair and is not served)`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    return found
  })

  app.get('/v1/otc/orders/:id/events', {
    schema: {
      tags: ['otc'],
      summary: 'One OTC order\'s events, oldest first',
      params: z.object({ id: zOrderId }),
      response: { 200: z.object({ items: z.array(zOtcEvent) }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id)
    const found = await cached(`data:otc:order:${id}`, 3_000, () => otcOrderById(opts.client, id))
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no OTC order ${id}`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    return { items: found.events }
  })
}
