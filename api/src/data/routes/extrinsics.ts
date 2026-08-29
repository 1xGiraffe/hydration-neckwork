import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, errorEnvelope, feedPage, requirePositionCursor,
  zBlock, zCursor, zError, zFeedPage, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { extrinsicAt, extrinsicEvents, extrinsicPositionByHash, extrinsicsFeed } from '../services/chainCore.ts'
import { MAX_FILTER_WINDOW_DAYS } from '../services/feed.ts'
import { ADDRESS_FORMATS_HINT, parseAddress } from '../services/address.ts'
import { zEventItem, zExtrinsicDetail, zExtrinsicItem } from './extrinsicsShared.ts'

// An extrinsic is addressed by ONE path segment: either its transaction hash
// (0x + 64 hex) or its canonical position `{height}-{index}`. The two forms
// cannot collide, so the route sniffs the shape and 400s anything else naming
// both forms.
const EXTRINSIC_HASH_RE = /^0x[0-9a-f]{64}$/
const POSITION_RE = /^(\d{1,10})-(\d{1,10})$/

const zExtrinsicId = z.string().max(80)
  .describe('A 0x-prefixed 32-byte transaction hash, or the canonical position `{blockHeight}-{extrinsicIndex}`.')

function parseExtrinsicId(raw: string): { hash: string } | { blockHeight: number; extrinsicIndex: number } {
  const id = raw.toLowerCase()
  if (EXTRINSIC_HASH_RE.test(id)) return { hash: id }
  const position = POSITION_RE.exec(id)
  if (position) {
    const blockHeight = Number(position[1])
    const extrinsicIndex = Number(position[2])
    if (blockHeight <= 4_294_967_295 && extrinsicIndex <= 4_294_967_295) return { blockHeight, extrinsicIndex }
  }
  throw badRequest('expected a 0x-prefixed 32-byte extrinsic hash or a `{blockHeight}-{extrinsicIndex}` position')
}

const zExtrinsicsQuery = z.object({
  limit: zLimit,
  cursor: zCursor,
  order: zOrder,
  signer: z.string().min(3).max(128).optional()
    .describe('Filter to one signer (SS58, H160, or 0x-64-hex). Signer-scoped pages read an account-first projection, so no window is needed.'),
  success: z.enum(['true', 'false']).optional(),
  call: z.string().max(80).optional()
    .describe(`Filter by \`Pallet.call\`. Without \`signer\`, this cannot prune the primary key and therefore requires a bounded window (fromTime+toTime ≤ ${MAX_FILTER_WINDOW_DAYS} days, or fromBlock+toBlock).`),
  fromBlock: zBlock.optional(),
  toBlock: zBlock.optional(),
  fromTime: zTimeParam.optional(),
  toTime: zTimeParam.optional(),
})

export const extrinsicsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/extrinsics', {
    schema: {
      tags: ['chain'],
      summary: 'Extrinsics feed, newest first',
      description: 'Cursor-paginated over the primary key. With `signer=`, pages come from the account-first projection and are O(1) at any depth of one account\'s history; with `call=` and no signer, a bounded window is required (see the parameter note).',
      querystring: zExtrinsicsQuery,
      response: { 200: zFeedPage(zExtrinsicItem), 400: zError },
    },
  }, async request => {
    const { limit, order, success, call, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const signer = request.query.signer ? parseAddress(request.query.signer) : null
    if (request.query.signer && !signer) throw badRequest(`unparseable signer; ${ADDRESS_FORMATS_HINT}`)
    const head = await liveHeadTag(opts.client)
    const key = `data:extrinsics:${order}:${signer?.accountId ?? ''}:${success ?? ''}:${call ?? ''}:${fromBlock ?? ''}:${toBlock ?? ''}:${fromTime ?? ''}:${toTime ?? ''}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 3_000, () => extrinsicsFeed(opts.client, {
      limit, order, signer, cursor,
      success: success == null ? undefined : success === 'true',
      call: call || undefined,
      fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.extrinsicIndex }))
  })

  app.get('/v1/extrinsics/:id', {
    schema: {
      tags: ['chain'],
      summary: 'One extrinsic by hash or position',
      description: 'The hash form resolves through a full-history hash index with NO time bound, which is the deposit-detection case this surface exists for. `{height}-{index}` is the canonical identity and a primary-key read. A Module error is named from the runtime metadata active at that block; an unknown triple keeps `kind` and `raw` with null names rather than a guess.',
      params: z.object({ id: zExtrinsicId }),
      response: { 200: zExtrinsicDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseExtrinsicId(request.params.id)
    const position = 'hash' in id
      ? await cached(`data:extrinsic:pos:${id.hash}`, 10_000, () => extrinsicPositionByHash(opts.client, id.hash))
      : id
    const found = position
      ? await cached(`data:extrinsic:at:${position.blockHeight}:${position.extrinsicIndex}`, 10_000, () => extrinsicAt(opts.client, position.blockHeight, position.extrinsicIndex))
      : null
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no extrinsic ${request.params.id} indexed`,
        await notFoundContext(opts.client, {
          requestedHeight: 'hash' in id ? undefined : id.blockHeight,
          hint: 'the hash index covers the full chain history; if this extrinsic is newer than indexedHead it has not been ingested yet',
        })))
    }
    return found
  })

  app.get('/v1/extrinsics/:id/events', {
    schema: {
      tags: ['chain'],
      summary: 'All events one extrinsic emitted',
      description: 'Addressed like the extrinsic itself (hash or `{height}-{index}`); a point range on the events table. 404 when the extrinsic is not indexed.',
      params: z.object({ id: zExtrinsicId }),
      response: { 200: z.object({ items: z.array(zEventItem) }), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const id = parseExtrinsicId(request.params.id)
    const position = 'hash' in id
      ? await cached(`data:extrinsic:pos:${id.hash}`, 10_000, () => extrinsicPositionByHash(opts.client, id.hash))
      : id
    const found = position
      ? await cached(`data:extrinsic:at:${position.blockHeight}:${position.extrinsicIndex}`, 10_000, () => extrinsicAt(opts.client, position.blockHeight, position.extrinsicIndex))
      : null
    if (!position || !found) {
      return reply.code(404).send(errorEnvelope('not_found', `no extrinsic ${request.params.id} indexed`,
        await notFoundContext(opts.client, { requestedHeight: 'hash' in id ? undefined : id.blockHeight })))
    }
    return { items: await cached(`data:extrinsic:events:${position.blockHeight}:${position.extrinsicIndex}`, 10_000, () => extrinsicEvents(opts.client, position.blockHeight, position.extrinsicIndex)) }
  })
}
