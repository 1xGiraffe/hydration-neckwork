import type { ReferendumVoter } from '../types'

export type VoteSort = 'time' | 'votes'
export type SideFilter = 'all' | 'aye' | 'nay'

// Sorted and filtered in the browser: a referendum's whole voter set is already in the
// page's payload, so paging it back through the API would only add latency.
export function orderVoters(voters: ReferendumVoter[], sort: VoteSort, side: SideFilter): ReferendumVoter[] {
  const kept = side === 'all'
    ? voters
    // A Split vote backs both sides at once, so it belongs to either filter.
    : voters.filter(voter => (side === 'aye' ? Number(voter.weightedAye) > 0 : Number(voter.weightedNay) > 0))
  // Weights are 21-digit planck values, so they are compared as BigInt rather than
  // subtracted as doubles.
  const byVotes = (a: ReferendumVoter, b: ReferendumVoter) => {
    const diff = BigInt(b.weighted) - BigInt(a.weighted)
    return diff > 0n ? 1 : diff < 0n ? -1 : 0
  }
  const byTime = (a: ReferendumVoter, b: ReferendumVoter) =>
    b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex
  return [...kept].sort(sort === 'votes' ? byVotes : byTime)
}
