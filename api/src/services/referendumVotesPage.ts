import type { ReferendumVoter } from './governanceService.ts'

// A referendum's voters, one page at a time: sorted by conviction-weighted power or by
// time, filtered by side and by an account search, with exact totals. The voter list
// is the same one the referendum page reads (getReferendum, every voter), so a page
// here never disagrees with the tally or the bubble map.

export type VoterSort = 'power' | 'time'
export type VoterSide = 'all' | 'aye' | 'nay' | 'abstain'

/** `accountId`: the search normalized to an AccountId32 when it is an address in any spelling (SS58 under any prefix, hex, H160). */
export interface VotersPageQuery { sort: VoterSort; side: VoterSide; q: string; accountId?: string | null; offset: number; limit: number }
export interface VotersPage { total: number; totalAll: number; offset: number; limit: number; rows: ReferendumVoter[] }

const big = (s: string): bigint => (/^-?\d+$/.test(s) ? BigInt(s) : 0n)

function matches(v: ReferendumVoter, q: string): boolean {
  const a = v.account
  if (!a) return false
  const hay = [a.address, a.accountId, a.identity?.display, a.profile?.name, a.tag?.name]
  return hay.some(h => typeof h === 'string' && h.toLowerCase().includes(q))
}

function onSide(v: ReferendumVoter, side: VoterSide): boolean {
  if (side === 'all') return true
  if (side === 'abstain') return big(v.abstainBalance) > 0n
  return side === 'aye' ? big(v.weightedAye) > 0n : big(v.weightedNay) > 0n
}

/** Pure: filter, order and slice. A Split vote backs both sides, so it is in either side's filter; abstain is a SplitAbstain vote's abstain part. */
export function pageVoters(voters: ReferendumVoter[], query: VotersPageQuery): VotersPage {
  const q = query.q.trim().toLowerCase()
  const kept = voters.filter(v =>
    onSide(v, query.side)
    && (!q || (query.accountId ? v.account?.accountId.toLowerCase() === query.accountId.toLowerCase() : matches(v, q))))
  const sorted = [...kept].sort(query.sort === 'power'
    ? (a, b) => { const d = big(b.weighted) - big(a.weighted); return d > 0n ? 1 : d < 0n ? -1 : b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex }
    : (a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
  return { total: sorted.length, totalAll: voters.length, offset: query.offset, limit: query.limit, rows: sorted.slice(query.offset, query.offset + query.limit) }
}
