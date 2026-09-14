import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  feedPage, requirePositionCursor,
  zAssetId, zCursor, zError, zFeedPage, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag } from '../services/head.ts'
import { resolveWindow } from '../services/statsData.ts'
import {
  XCM_DEFAULT_WINDOW_S, XCM_IN_EVENTS, XCM_MAX_WINDOW_S, XCM_OUT_EVENTS, xcmFeed,
} from '../services/xcmFeed.ts'
import { zXcmTransfer } from './xcmShared.ts'

const DESCRIPTION = [
  'Cross-chain flow events seen on Hydration, inside a BOUNDED window (default the last 24 hours, maximum 7 days — the backing table is keyed event-name-first, so the window is what prunes the read).',
  `Direction is a name-set classification. \`out\` is the explicit send events, which name the sender and assets: ${XCM_OUT_EVENTS.join(', ')}. \`in\` is the deposit-family events in block-hook context (${XCM_IN_EVENTS.join(', ')} with no extrinsic). That makes \`in\` a SUPERSET of true XCM arrivals: any block-hook credit (a scheduler payout, a fee sweep) lands in hook context too, and the per-block MessageQueue-barrier pairing that disambiguates them is context a flat feed cannot reproduce.`,
  'Deliberately absent: the queue barriers (MessageQueue.Processed and its pre-migration predecessors — bookkeeping, not flow) and Currencies.Withdrawn, which fires for every non-XCM withdrawal as well (measured live: ~9.7k/day against ~258 explicit sends) and would misstate the outbound feed roughly 40:1.',
  'Origins and destinations of the remote leg are NOT resolved here — cross-chain journey resolution is asynchronous and out of scope for this surface; unresolved stays explicit.',
].join('\n\n')

export const xcmRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/xcm/transfers', {
    schema: {
      tags: ['xcm'],
      summary: 'XCM flow events in a bounded window, newest first',
      description: DESCRIPTION,
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        direction: z.enum(['in', 'out']).optional(),
        asset: zAssetId.optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: zFeedPage(zXcmTransfer), 400: zError },
    },
  }, async request => {
    const { limit, order, direction } = request.query
    const window = resolveWindow(request.query.fromTime, request.query.toTime, XCM_DEFAULT_WINDOW_S, XCM_MAX_WINDOW_S, 'xcm transfers')
    const cursor = requirePositionCursor(request.query.cursor)
    const assetId = request.query.asset == null ? undefined : Number(request.query.asset)
    const head = await liveHeadTag(opts.client)
    const key = `data:xcm:transfers:${order}:${direction ?? ''}:${assetId ?? ''}:${window.from}:${window.to}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => xcmFeed(opts.client, {
      limit, order, direction, assetId, cursor,
      fromTime: window.from,
      toTime: window.to,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
