import type { ReferendumDetail, ReferendumVoter } from '../types'

export type VoteSort = 'time' | 'votes'
export type SideFilter = 'all' | 'aye' | 'nay'

// Which tally a referendum page can show, and where the numbers came from.
//
// 'chain' is the pallet's own figure, lifted off a lifecycle event: already
// conviction-weighted and already inclusive of delegated power. Only OpenGov emits one.
//
// 'attributed' is the sum of the per-account votes we indexed. It is the chain's DIRECT
// tally and nothing more — delegated power casts no Voted event, so it is missing from
// this number and cannot be recovered from the events either. Every Democracy referendum
// falls here, because the Democracy pallet publishes its Tally only in storage while the
// referendum is Ongoing and drops it at the close. The two are NOT interchangeable, so the
// source travels with the numbers and the caller labels it.
export interface DisplayTally {
  ayes: string
  nays: string
  support: string | null
  source: 'chain' | 'attributed'
}

export function selectTally(data: Pick<ReferendumDetail, 'onChainTally' | 'directTally'>): DisplayTally {
  if (data.onChainTally) return { ...data.onChainTally, source: 'chain' }
  return { ayes: data.directTally.ayes, nays: data.directTally.nays, support: null, source: 'attributed' }
}

// Share of the weighted tally, as a percentage of aye + nay. Computed in BigInt: these are
// 21-digit planck figures a double would round. Null when nothing has been counted.
export function ayeSharePct(ayes: string, nays: string): number | null {
  try {
    const aye = BigInt(ayes), nay = BigInt(nays)
    if (aye + nay === 0n) return null
    return Number((aye * 10_000n) / (aye + nay)) / 100
  } catch { return null }
}

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
