import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { badRequest, cursorUint, decodeCursor, encodeCursor, zAccountRef, zIsoTimestamp } from '../schemas/common.ts'
import { attachExtrinsicHashes } from '../services/extrinsicHashes.ts'
import { orderVotes, voteCursorPosition, type KeyedVote, type VoteKey } from '../services/governance.ts'
import type { Order } from '../services/feed.ts'

// The raw vote-call item and its in-memory page, shared by the three vote
// feeds (per referendum, per voter, and under /v1/accounts/{address}/votes) so
// one vote is the same object wherever it is reached.

export const zPallet = z.enum(['opengov', 'democracy'])

export const zVoteItem = z.object({
  voter: zAccountRef.nullable(),
  pallet: zPallet,
  refIndex: z.number().int(),
  callName: z.string().describe('The raw call: ConvictionVoting.vote / Democracy.vote, or one of the remove_vote family — a later remove cancels an earlier vote.'),
  voteKind: z.string().nullable().describe('Standard | Split | SplitAbstain on vote calls; null on removals.'),
  voteByte: z.number().int().describe('The raw vote byte of a Standard vote: bit 7 is the aye flag, the low 7 bits the conviction.'),
  aye: z.boolean().nullable().describe('Standard votes only.'),
  conviction: z.number().int().nullable().describe('Standard votes only: 0 (0.1x) … 6 (6x).'),
  balance: z.string().nullable().describe('Standard votes: the locked balance, raw integer.'),
  ayeAmount: z.string().nullable().describe('Split/SplitAbstain votes: the aye-side balance.'),
  nayAmount: z.string().nullable(),
  abstainAmount: z.string().nullable(),
  success: z.boolean(),
  blockHeight: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
})

export const VOTES_DESCRIPTION = [
  'The RAW vote-call history, newest first (`order=asc` replays it from the first call): every ConvictionVoting/Democracy vote and remove_vote call, including failed calls (`success: false`) and votes later removed. A consumer reconstructing the standing votes must apply removals over earlier votes per voter — this surface deliberately does not, so nothing is hidden.',
  'For a `Standard` vote the raw `voteByte` decodes as: aye = bit 7 (`voteByte >= 128`), conviction = the low 7 bits (0 = 0.1x … 6 = 6x), with `balance` the locked amount. `Split`/`SplitAbstain` votes carry their side balances in `ayeAmount`/`nayAmount`/`abstainAmount` instead.',
].join('\n\n')

function decodeVoteCursor(raw: string): VoteKey {
  const decoded = decodeCursor(raw)
  const b = cursorUint(decoded, 'b')
  const x = cursorUint(decoded, 'x')
  const c = typeof decoded?.c === 'string' ? decoded.c : null
  if (b == null || x == null || c == null) throw badRequest('unreadable cursor: pass back a nextCursor exactly as it was received')
  return { b, x, c }
}

// A vote set is bounded per referendum and per voter (live maxima: 1,179 and
// 990 calls), so it is read whole and paged here; the cursor is the identity
// of the last item served, which stays stable while new calls land.
export async function voteCursorPage(client: ClickHouseClient, votes: KeyedVote[], cursorRaw: string | undefined, limit: number, order: Order) {
  const ordered = orderVotes(votes, order)
  let start = 0
  if (cursorRaw) {
    start = voteCursorPosition(ordered, decodeVoteCursor(cursorRaw), order) + 1
  }
  const page = ordered.slice(start, start + limit)
  const hasMore = start + limit < ordered.length
  const last = page[page.length - 1]
  return {
    items: await attachExtrinsicHashes(client, page.map(v => v.item)),
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeCursor({ b: last.key.b, x: last.key.x, c: last.key.c }) } : {}),
  }
}
