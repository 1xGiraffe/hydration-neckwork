import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  badRequest, cursorUint, decodeCursor, encodeCursor, errorEnvelope,
  zAccountRef, zCursor, zError, zFeedPage, zFeedQuery, zIsoTimestamp, zLimit, zWindowQuartet, zWindowedFeedQuery,
} from '../schemas/common.ts'
import { dataStatus, liveHeadTag, notFoundContext } from '../services/head.ts'
import { inWindow, requireParsedAddress } from './accountsShared.ts'
import { REFERENDUM_STATUSES, loadReferenda, loadReferendum, loadTreasurySpends, votesForReferendum, votesForVoter, type ReferendumPallet } from '../services/governance.ts'
import { accountRefOrNull } from '../services/address.ts'
import { VOTES_DESCRIPTION, voteCursorPage, zPallet, zVoteItem } from './votesShared.ts'
import { forumSnapshotReady, referendumTitle, resolveThreadKey, subjectDescription } from '../services/forum.ts'
import { COMMENT_FEED_RULES, FORUM_RULES, commentCursor, commentFeed, forumUnavailable, zCommentFeedPage, zSubjectDescription } from './forumShared.ts'

const zRefIndex = z.coerce.number().int().min(0).max(4_294_967_295)

const zTally = z.object({
  ayes: z.string().describe('Conviction-weighted aye capital, raw integer.'),
  nays: z.string(),
  support: z.string().describe('OpenGov support: the aye + abstain capital backing the referendum, raw integer.'),
})

const zReferendumSummary = z.object({
  pallet: zPallet.describe('`opengov` (pallet-referenda, the current system) or `democracy` (the retired legacy pallet).'),
  refIndex: z.number().int(),
  title: z.string().nullable().describe('The title of the referendum\'s governance-forum description (imported or written natively; untrusted text), when one exists and is not hidden; the chain itself has none. Null too while the forum snapshot is loading after a restart.'),
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
  description: zSubjectDescription.nullable().describe('The referendum\'s description on the governance forum (imported or written natively), with its thread\'s comment count; a stub when hidden; null when `descriptionStatus` is `none` or `unavailable`. Forum text is untrusted — see the route description.'),
  descriptionStatus: z.enum(['ok', 'hidden', 'none', 'unavailable']).describe('`ok`: `description` is shown; `hidden`: it is a stub; `none`: the forum holds no record for this referendum; `unavailable`: the forum snapshot is not loaded yet (after a restart) — the referendum itself is complete, retry for its description.'),
})

const SPEND_STATES = ['pending', 'claimable', 'paid', 'failed', 'expired', 'voided'] as const

const zTreasurySpend = z.object({
  index: z.number().int().describe('The spend index (Treasury.SpendCount order).'),
  amount: z.string().describe('HDX, raw integer (12 decimals). The treasury pays HDX only (its AssetKind is the unit type).'),
  beneficiary: zAccountRef.nullable(),
  state: z.enum(SPEND_STATES).describe('`pending` before validFrom; `claimable` inside its window (anyone may call payout); `paid`; `failed` (a failed payment can be paid out again); `expired` unclaimed past expireAt; `voided` by the reject origin.'),
  validFrom: z.number().int().nullable().describe('First block payout may run in.'),
  expireAt: z.number().int().nullable().describe('As approved; a payout re-dates it in storage, which this field does not follow.'),
  approvedAt: zIsoTimestamp,
  approvedAtBlock: z.number().int(),
  paidAt: zIsoTimestamp.nullable(),
  paidAtBlock: z.number().int().nullable(),
  processedAtBlock: z.number().int().nullable().describe('When check_status removed it from storage (after a payment, or after it expired unpaid); null while it is still in storage.'),
  canPayout: z.boolean().describe('`payout(index)` would be accepted in the next block (anyone may sign it).'),
  canCheckStatus: z.boolean().describe('`check_status(index)` would clear it in the next block (anyone may sign it; the fee is refunded).'),
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
    await forumSnapshotReady()
    const page = filtered.slice(start, start + limit).map(ref => ({ ...ref, title: referendumTitle(ref.pallet, ref.refIndex) }))
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
      summary: 'One referendum: folded state, lifecycle history, decoded proposal, forum description',
      description: [
        'The same fold as the directory for one referendum, plus its full lifecycle event list (oldest first, args decoded) and the decoded proposal call when the preimage decoder has resolved the hash.',
        '`description` is the referendum\'s description post on the governance forum: title, tldr, excerpt and body, the author it was written under, `authority`, revision and edit time, the comment count of its thread (the comments themselves are /v1/governance/referenda/{pallet}/{index}/comments). It is null when the forum holds no record for the referendum; a record without text yet (a thread opened before any description) has null text fields.',
        FORUM_RULES,
      ].join('\n\n'),
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
    const { status, description } = await subjectDescription(opts.client, `${pallet}:${index}`)
    return { ...detail, title: referendumTitle(pallet, index), description, descriptionStatus: status }
  })

  app.get('/v1/governance/referenda/:pallet/:index/comments', {
    schema: {
      tags: ['governance'],
      summary: 'One referendum\'s governance forum comments, oldest first',
      description: [
        'The comment thread of a referendum\'s description: its own, or — for a legacy democracy referendum whose discussion happened on a linked council or technical-committee motion — that subject\'s merged thread. A known referendum with no comments answers 200 with empty items; an unknown one 404.',
        COMMENT_FEED_RULES,
        FORUM_RULES,
      ].join('\n\n'),
      params: z.object({ pallet: zPallet, index: zRefIndex }),
      querystring: z.object({ limit: zLimit, cursor: zCursor }),
      response: { 200: zCommentFeedPage, 400: zError, 404: zError, 503: zError },
    },
  }, async (request, reply) => {
    const { pallet, index } = request.params
    const after = commentCursor(request.query.cursor)
    if (!(await forumSnapshotReady())) return forumUnavailable(reply)
    const all = await referendaFold()
    if (!all.some(ref => ref.pallet === pallet && ref.refIndex === index)) {
      return reply.code(404).send(errorEnvelope('not_found', `no ${pallet} referendum ${index} indexed`,
        await notFoundContext(opts.client, { hint: 'list referenda via /v1/governance/referenda' })))
    }
    return commentFeed(opts.client, resolveThreadKey(`${pallet}:${index}`), after, request.query.limit)
  })

  app.get('/v1/governance/referenda/:pallet/:index/votes', {
    schema: {
      tags: ['governance'],
      summary: 'One referendum\'s raw vote-call history',
      description: VOTES_DESCRIPTION,
      params: z.object({ pallet: zPallet, index: zRefIndex }),
      querystring: zWindowedFeedQuery,
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
      summary: 'One voter\'s raw vote-call history across all referenda',
      description: `${VOTES_DESCRIPTION}\n\nServed from a voter-first projection, so any voter's full history is one key-range read. \`voter\` is required; an account that never voted answers 200 with empty items. The same feed is addressable as /v1/accounts/{address}/votes.`,
      querystring: zFeedQuery.extend({
        voter: z.string().min(3).max(128).describe('The voter, as SS58 (any prefix), H160, or 0x-prefixed public-key hex.'),
        ...zWindowQuartet,
      }),
      response: { 200: zFeedPage(zVoteItem), 400: zError },
    },
  }, async request => {
    const voter = requireParsedAddress(request.query.voter, 'voter')
    const head = await liveHeadTag(opts.client)
    const votes = await cached(`data:governance:voter:${voter.accountId}:${head}`, 10_000,
      () => votesForVoter(opts.client, voter.accountId))
    const windowed = votes.filter(vote => inWindow(vote.item, request.query))
    return voteCursorPage(opts.client, windowed, request.query.cursor, request.query.limit, request.query.order)
  })

  app.get('/v1/governance/treasury/spends', {
    schema: {
      tags: ['governance'],
      summary: 'Treasury spends with their payout state, newest first',
      description: [
        'Every spend OpenGov approved through `treasury.spend` (Treasury.AssetSpendApproved), folded from the Treasury\'s own events at the indexed head: Paid, PaymentFailed, SpendProcessed and AssetSpendVoided. Payout needs validFrom ≤ the next block < expireAt; check_status clears a paid spend, or an unpaid one once expired. Both are permissionless and pay the beneficiary.',
        'Older `spend_local` approvals and pre-OpenGov treasury proposals are paid by the treasury itself at its spend period and are not listed here. The cursor continues from the last item\'s index.',
      ].join('\n\n'),
      querystring: z.object({ limit: zLimit, cursor: zCursor, state: z.enum(SPEND_STATES).optional() }),
      response: { 200: zFeedPage(zTreasurySpend), 400: zError },
    },
  }, async request => {
    const { indexedHead } = await dataStatus(opts.client)
    const spends = await cached(`data:governance:treasury-spends:h${indexedHead}`, 10_000, () => loadTreasurySpends(opts.client, indexedHead))
    const filtered = spends.filter(sp => !request.query.state || sp.state === request.query.state)
    let start = 0
    if (request.query.cursor) {
      const i = cursorUint(decodeCursor(request.query.cursor), 'i')
      if (i == null) throw badRequest('unreadable cursor: pass back a nextCursor exactly as it was received')
      start = filtered.findIndex(sp => sp.index < i)
      if (start < 0) start = filtered.length
    }
    const page = filtered.slice(start, start + request.query.limit).map(sp => ({
      index: sp.index, amount: sp.amount, beneficiary: accountRefOrNull(sp.beneficiary), state: sp.state,
      validFrom: sp.validFrom, expireAt: sp.expireAt,
      approvedAt: sp.approvedAt.timestamp, approvedAtBlock: sp.approvedAt.blockHeight,
      paidAt: sp.paidAt?.timestamp ?? null, paidAtBlock: sp.paidAt?.blockHeight ?? null,
      processedAtBlock: sp.processedAt?.blockHeight ?? null,
      canPayout: sp.canPayout, canCheckStatus: sp.canCheckStatus,
    }))
    const hasMore = start + request.query.limit < filtered.length
    const last = page[page.length - 1]
    return { items: page, hasMore, ...(hasMore && last ? { nextCursor: encodeCursor({ i: last.index }) } : {}) }
  })
}
