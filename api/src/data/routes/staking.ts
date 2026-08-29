import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, csv, feedPage, requirePositionCursor,
  zBlock, zCursor, zError, zFeedPage, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag } from '../services/head.ts'
import { STAKING_EVENT_NAMES, stakingFeed } from '../services/stakingFeed.ts'
import { zStakingEvent } from './stakingShared.ts'

const KNOWN_NAMES = new Set<string>(STAKING_EVENT_NAMES)

export const stakingRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/staking/events', {
    schema: {
      tags: ['staking'],
      summary: 'The global staking event stream, newest first',
      description: [
        `Every event of the three staking-family pallets — classic HDX staking (Staking.*), GIGAHDX (GigaHdx.* / GigaHdxRewards.*) and collator rewards (CollatorRewards.CollatorRewarded) — from a staking-only projection, so a \`type=\` filter needs no bounded window. Vocabulary: ${STAKING_EVENT_NAMES.join(', ')}.`,
        'The two markets are separate systems: classic Staking positions and GIGAHDX stakes never blend. Per-account staking history lives under /v1/accounts/{address}/staking.',
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        type: z.string().max(600).optional().describe('Comma-separated event names from the vocabulary above; unknown names are a 400.'),
        fromBlock: zBlock.optional(),
        toBlock: zBlock.optional(),
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: zFeedPage(zStakingEvent), 400: zError },
    },
  }, async request => {
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const names = csv(request.query.type)
    const unknown = names.filter(name => !KNOWN_NAMES.has(name))
    if (unknown.length) throw badRequest(`unknown staking event type(s): ${unknown.join(', ')}. Known: ${STAKING_EVENT_NAMES.join(', ')}`)
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:staking:events:${order}:${[...names].sort().join(',')}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 10_000, () => stakingFeed(opts.client, {
      limit, order, cursor,
      names: names.length ? names : undefined,
      fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
