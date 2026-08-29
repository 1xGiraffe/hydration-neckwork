import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, errorEnvelope, feedPage, requireCursor, requirePositionCursor,
  zCursor, zError, zFeedPage, zLimit, zOrder,
} from '../schemas/common.ts'
import { windowKey, zWindowQuartet } from './accountsShared.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { dcaScheduleAggregates, dcaScheduleById, dcaScheduleExecutions, dcaSchedules } from '../services/dcaData.ts'
import { ADDRESS_FORMATS_HINT, parseAddress } from '../services/address.ts'
import { PRE_ROUTER_NOTE, zExecution, zSchedule, zScheduleDetail } from './dcaShared.ts'

const zScheduleId = z.string().regex(/^\d{1,18}$/, 'expected a decimal schedule id')

const NOT_FOUND_HINT = 'list ids via /v1/dca/schedules'

export const dcaRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/dca/schedules', {
    schema: {
      tags: ['dca'],
      summary: 'DCA schedules as placed, newest first',
      description: [
        'Schedule facts exactly as the chain recorded them at placement — this surface does not restate lifecycle status (fold one schedule\'s status from /v1/dca/schedules/{id}, which carries the terminal flags). Cursor pages over the schedule id.',
        PRE_ROUTER_NOTE,
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        owner: z.string().min(3).max(128).optional(),
      }),
      response: { 200: zFeedPage(zSchedule), 400: zError },
    },
  }, async request => {
    const { limit, order } = request.query
    const owner = request.query.owner ? parseAddress(request.query.owner) : null
    if (request.query.owner && !owner) throw badRequest(`unparseable owner; ${ADDRESS_FORMATS_HINT}`)
    const cursorId = requireCursor(request.query.cursor, ['i'], Number.MAX_SAFE_INTEGER)?.i ?? null
    const head = await liveHeadTag(opts.client)
    const key = `data:dca:schedules:${order}:${owner?.accountId ?? ''}:${cursorId ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => dcaSchedules(opts.client, { limit, order, cursorId, ownerAccountId: owner?.accountId }))
    return feedPage(items, hasMore, last => ({ i: last.scheduleId }))
  })

  app.get('/v1/dca/schedules/:id', {
    schema: {
      tags: ['dca'],
      summary: 'One schedule with its execution aggregates',
      description: [
        'The schedule as placed, plus exact integer sums and counts folded by the database over its own event history (reached owner-first, so the fold is key-pruned however long the schedule has run — the treasury buyback holds 370k+ events). `completed`/`terminated` are the terminal flags; a schedule with neither is live or waiting.',
        PRE_ROUTER_NOTE,
      ].join('\n\n'),
      params: z.object({ id: zScheduleId }),
      response: { 200: zScheduleDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id)
    const schedule = await cached(`data:dca:schedule:${id}`, 5_000, () => dcaScheduleById(opts.client, id))
    if (!schedule) {
      return reply.code(404).send(errorEnvelope('not_found', `no DCA schedule ${id}`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const aggregates = await cached(`data:dca:aggregates:${id}:${await liveHeadTag(opts.client)}`, 5_000,
      () => dcaScheduleAggregates(opts.client, schedule.owner.accountIdHex, id))
    return { ...schedule, ...aggregates }
  })

  app.get('/v1/dca/schedules/:id/executions', {
    schema: {
      tags: ['dca'],
      summary: 'One schedule\'s execution history, newest first',
      description: 'Every DCA event of the schedule — executions, failures (with the raw DispatchError), plans, and the terminal event — cursor-paginated over the owner-first projection, so any depth of a long-running schedule costs one key-range read. The window quartet bounds the feed; `order=asc` replays it from the start.',
      params: z.object({ id: zScheduleId }),
      querystring: z.object({ limit: zLimit, cursor: zCursor, order: zOrder, ...zWindowQuartet }),
      response: { 200: zFeedPage(zExecution), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = Number(request.params.id)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const schedule = await cached(`data:dca:schedule:${id}`, 5_000, () => dcaScheduleById(opts.client, id))
    if (!schedule) {
      return reply.code(404).send(errorEnvelope('not_found', `no DCA schedule ${id}`,
        await notFoundContext(opts.client, { hint: NOT_FOUND_HINT })))
    }
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:dca:executions:${id}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000,
      () => dcaScheduleExecutions(opts.client, schedule.owner.accountIdHex, id, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
