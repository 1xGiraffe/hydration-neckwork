import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, cursorUint, decodeCursor, encodeCursor, errorEnvelope,
  zCursor, zError, zFeedPage, zIsoTimestamp, zLimit, zOrder,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { ADDRESS_FORMATS_HINT, parseAddress } from '../services/address.ts'
import { inWindow, zWindowQuartet } from './accountsShared.ts'
import { REFERENDUM_STATUSES, loadReferenda, loadReferendum, votesForReferendum, votesForVoter, type ReferendumPallet } from '../services/governance.ts'
import { VOTES_DESCRIPTION, voteCursorPage, zPallet, zVoteItem } from './votesShared.ts'

const zRefIndex = z.coerce.number().int().min(0).max(4_294_967_295)

const zTally = z.object({
  ayes: z.string().describe('Conviction-weighted aye capital, raw integer.'),
  nays: z.string(),
  support: z.string().describe('OpenGov support: the aye + abstain capital backing the referendum, raw integer.'),
})

const zReferendumSummary = z.object({
  pallet: zPallet.describe('`opengov` (pallet-referenda, the current system) or `democracy` (the retired legacy pallet).'),
  refIndex: z.number().int(),
  title: z.string().nullable().describe('Human title from SubSquare, when one exists; the chain itself has none.'),
  status: z.enum(REFERENDUM_STATUSES),
  track: z.number().int().nullable().describe('OpenGov track id; null for democracy referenda.'),
  proposalHash: z.string().nullable(),
  tally: zTally.nullable().describe('The newest tally any lifecycle event published; null when none did (democracy events carry no tally).'),
  submittedAt: zIsoTimestamp.nullable(),
  submittedAtBlock: z.number().int().nullable(),
  decidedAt: zIsoTimestamp.nullable().describe('When the first terminal event (confirmed/rejected/timed out/cancelled/passed/…) landed.'),
})

const zLifecycleEvent = z.object({
  eventName: z.string(),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  args: z.unknown(),
})

const zProposal = z.object({
  pallet: z.string().describe('The pallet of the decoded proposal call (e.g. Utility).'),
  callName: z.string(),
  args: z.unknown().describe('Decoded call arguments. Deeply nested XCM payloads may be elided by the decoder.'),
  byteLength: z.number().int(),
  decodeError: z.string().nullable(),
})

const zReferendumDetail = zReferendumSummary.extend({
  events: z.array(zLifecycleEvent).describe('The full lifecycle event history, oldest first, args decoded.'),
  proposal: zProposal.nullable().describe('The decoded preimage of the proposal hash, when the decoder has resolved it.'),
})

export const governanceRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  const referendaFold = async () => {
    const head = await liveHeadTag(opts.client)
    return cached(`data:governance:referenda:${head}`, 30_000, () => loadReferenda(opts.client))
  }

  app.get('/v1/governance/referenda', {
    schema: {
      tags: ['governance'],
      summary: 'All referenda with folded state, newest first',
      description: [
        'Every referendum either governance pallet has held, folded at read time from its full lifecycle event history: `status` is the newest STATUS-BEARING event (deposit bookkeeping is ignored — a deposit refund after Confirmed does not un-decide a referendum), `tally` the newest published tally, `track`/`proposalHash` from Submitted. OpenGov statuses: submitted, deciding, confirming, confirmed, rejected, timedOut, cancelled (approved/killed exist in the pallet but have never fired on Hydration); legacy democracy referenda report deciding, passed, notPassed, cancelled, executed and carry no track, hash or tally.',
        'The whole directory is one cached fold (the lifecycle table holds ~2.8k rows for ~600 referenda), so pages slice a consistent snapshot; the cursor continues from the (pallet, refIndex) identity of the last item.',
      ].join('\n\n'),
      querystring: z.object({
        limit: zLimit,
        cursor: zCursor,
        pallet: zPallet.optional(),
        status: z.enum(REFERENDUM_STATUSES).optional(),
      }),
      response: { 200: zFeedPage(zReferendumSummary), 400: zError },
    },
  }, async request => {
    const { limit, pallet, status } = request.query
    const all = await referendaFold()
    const filtered = all.filter(ref => (!pallet || ref.pallet === pallet) && (!status || ref.status === status))
    let start = 0
    if (request.query.cursor) {
      const decoded = decodeCursor(request.query.cursor)
      const r = cursorUint(decoded, 'r')
      const p = typeof decoded?.p === 'string' ? decoded.p : null
      if (r == null || (p !== 'opengov' && p !== 'democracy')) throw badRequest('unreadable cursor: pass back a nextCursor exactly as it was received')
      const at = filtered.findIndex(ref => ref.pallet === p && ref.refIndex === r)
      if (at < 0) throw badRequest('stale cursor: it does not name a referendum in this filter — restart without a cursor')
      start = at + 1
    }
    const page = filtered.slice(start, start + limit)
    const hasMore = start + limit < filtered.length
    const last = page[page.length - 1]
    return {
      items: page,
      hasMore,
      ...(hasMore && last ? { nextCursor: encodeCursor({ p: last.pallet, r: last.refIndex }) } : {}),
    }
  })

  app.get('/v1/governance/referenda/:pallet/:index', {
    schema: {
      tags: ['governance'],
      summary: 'One referendum: folded state, lifecycle history, decoded proposal',
      description: 'The same fold as the directory for one referendum, plus its full lifecycle event list (oldest first, args decoded) and the decoded proposal call when the preimage decoder has resolved the hash.',
      params: z.object({ pallet: zPallet, index: zRefIndex }),
      response: { 200: zReferendumDetail, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { pallet, index } = request.params
    const head = await liveHeadTag(opts.client)
    const detail = await cached(`data:governance:ref:${pallet}:${index}:${head}`, 10_000,
      () => loadReferendum(opts.client, pallet as ReferendumPallet, index))
    if (!detail) {
      return reply.code(404).send(errorEnvelope('not_found', `no ${pallet} referendum ${index} indexed`,
        await notFoundContext(opts.client, { hint: 'list referenda via /v1/governance/referenda' })))
    }
    return detail
  })

  app.get('/v1/governance/referenda/:pallet/:index/votes', {
    schema: {
      tags: ['governance'],
      summary: 'One referendum’s raw vote-call history',
      description: VOTES_DESCRIPTION,
      params: z.object({ pallet: zPallet, index: zRefIndex }),
      querystring: z.object({ limit: zLimit, cursor: zCursor, order: zOrder, ...zWindowQuartet }),
      response: { 200: zFeedPage(zVoteItem), 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { pallet, index } = request.params
    const head = await liveHeadTag(opts.client)
    const votes = await cached(`data:governance:votes:${pallet}:${index}:${head}`, 10_000,
      () => votesForReferendum(opts.client, pallet as ReferendumPallet, index))
    if (votes.length === 0) {
      // Distinguish "referendum unknown" (404) from "known, nobody voted" (200 []).
      const all = await referendaFold()
      if (!all.some(ref => ref.pallet === pallet && ref.refIndex === index)) {
        return reply.code(404).send(errorEnvelope('not_found', `no ${pallet} referendum ${index} indexed`,
          await notFoundContext(opts.client, { hint: 'list referenda via /v1/governance/referenda' })))
      }
    }
    const windowed = votes.filter(vote => inWindow(vote.item, request.query))
    return voteCursorPage(opts.client, windowed, request.query.cursor, request.query.limit, request.query.order)
  })

  app.get('/v1/governance/votes', {
    schema: {
      tags: ['governance'],
      summary: 'One voter’s raw vote-call history across all referenda',
      description: `${VOTES_DESCRIPTION}\n\nServed from a voter-first projection, so any voter's full history is one key-range read. \`voter\` is required; an account that never voted answers 200 with empty items. The same feed is addressable as /v1/accounts/{address}/votes.`,
      querystring: z.object({
        voter: z.string().min(3).max(128).describe('The voter, as SS58 (any prefix), H160, or 0x-prefixed public-key hex.'),
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        ...zWindowQuartet,
      }),
      response: { 200: zFeedPage(zVoteItem), 400: zError },
    },
  }, async request => {
    const voter = parseAddress(request.query.voter)
    if (!voter) throw badRequest(`unparseable voter; ${ADDRESS_FORMATS_HINT}`)
    const head = await liveHeadTag(opts.client)
    const votes = await cached(`data:governance:voter:${voter.accountId}:${head}`, 10_000,
      () => votesForVoter(opts.client, voter.accountId))
    const windowed = votes.filter(vote => inWindow(vote.item, request.query))
    return voteCursorPage(opts.client, windowed, request.query.cursor, request.query.limit, request.query.order)
  })
}
