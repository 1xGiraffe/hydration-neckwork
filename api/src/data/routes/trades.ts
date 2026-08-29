import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, feedPage, requirePositionCursor,
  zAssetId, zCursor, zError, zFeedPage, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag } from '../services/head.ts'
import { fillsPage } from '../services/swapFills.ts'
import { ADDRESS_FORMATS_HINT, parseAddress } from '../services/address.ts'
import { zSwapFill, zVenue } from './tradesShared.ts'

// The global feed is time-windowed because the leg table is venue-first: the
// window is what keeps a cross-venue read partition-pruned. Measured live, a
// 24 h page reads ~9 MiB in ~7 ms; 7 days is the documented cap.
const DEFAULT_WINDOW_SECONDS = 86_400
const MAX_WINDOW_SECONDS = 7 * 86_400

const zTradesQuery = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  venue: zVenue.optional(),
  asset: zAssetId.optional().describe('Fills touching this asset on ANY leg (in, out, or fee).'),
  account: z.string().min(3).max(128).optional().describe('Fills made for this account (SS58, H160, or 0x-64-hex).'),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

export const tradesRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/trades', {
    schema: {
      tags: ['trades'],
      summary: 'Recent swap fills across every venue, newest first',
      description: [
        'The cross-venue fill feed, cursor-paginated inside a bounded time window: default the last 24 hours, at most 7 days between `fromTime` and `toTime` (the leg projection is venue-first, so the window is what keeps a cross-venue read cheap). Deeper history is addressable per pool via /v1/pools/{venue}/{poolKey}/trades, or per account via /v1/accounts/{address}/trades.',
        'Fill semantics are identical to the per-pool feed: fee legs restate in/out value; a modern multi-hop route is one fill per hop sharing an `opKey`; legacy fills (below block 6,837,788) carry no `opKey`; placeholder swappers report null.',
      ].join('\n\n'),
      querystring: zTradesQuery,
      response: { 200: zFeedPage(zSwapFill), 400: zError },
    },
  }, async request => {
    const { limit, order, venue, asset } = request.query
    // The default window is anchored to a minute boundary so the cache key is
    // stable inside a minute rather than unique per request.
    const nowMinute = Math.floor(Date.now() / 60_000) * 60
    const toTime = request.query.toTime ?? nowMinute
    const fromTime = request.query.fromTime ?? toTime - DEFAULT_WINDOW_SECONDS
    if (toTime <= fromTime) throw badRequest('toTime must be after fromTime')
    if (toTime - fromTime > MAX_WINDOW_SECONDS) {
      throw Object.assign(
        badRequest('the global trades window is bounded at 7 days; narrow the window, or use /v1/pools/{venue}/{poolKey}/trades or /v1/accounts/{address}/trades for deep history'),
        { context: { maxWindowDays: 7 } },
      )
    }
    const account = request.query.account ? parseAddress(request.query.account) : null
    if (request.query.account && !account) throw badRequest(`unparseable account; ${ADDRESS_FORMATS_HINT}`)
    const cursor = requirePositionCursor(request.query.cursor)

    const head = await liveHeadTag(opts.client)
    const key = `data:trades:${order}:${venue ?? ''}:${asset ?? ''}:${account?.accountId ?? ''}:${fromTime}:${toTime}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => fillsPage(opts.client, venue ? { venue } : {}, {
      limit,
      order,
      cursor,
      assetId: asset == null ? undefined : Number(asset),
      swapperAccountId: account?.accountId,
      fromTime,
      toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
