import type { OnChainTally, ReferendumDetail } from '../types'

// Which tally a referendum page can show, and where the numbers came from.
//
// 'chain' is the pallet's own FINAL figure, lifted off a concluding lifecycle event:
// already conviction-weighted and already inclusive of delegated power. Only OpenGov
// emits one, and only once the referendum has closed.
//
// 'attributed' is the sum of the per-account votes we indexed. It is the chain's DIRECT
// tally and nothing more — delegated power casts no Voted event, so it is missing from
// this number and cannot be recovered from the events either. The two are NOT
// interchangeable, so the source travels with the numbers and the caller labels it.
//
// Two different referenda land on 'attributed', and `snapshot` tells them apart:
//   - every Democracy referendum, which has no snapshot, because that pallet publishes
//     its Tally only in storage while the referendum is Ongoing and drops it at the close;
//   - every RUNNING OpenGov referendum, which carries the superseded decision-start
//     snapshot. That figure was true when the decision period opened and every vote since
//     has left it behind.
// Only the first is a permanent gap worth explaining to a reader, so the presence of a
// snapshot is what suppresses that explanation.
export interface DisplayTally {
  ayes: string
  nays: string
  support: string | null
  source: 'chain' | 'attributed'
  // A 'chain' tally read from live storage while the referendum runs, as
  // opposed to one lifted off its concluding event. Same authority (the
  // pallet's own conviction-weighted figure, delegation included) — it just
  // isn't the last word yet.
  live?: boolean
  // The chain figure this reconstruction replaced, when there was one.
  snapshot?: OnChainTally
}

export function selectTally(data: Pick<ReferendumDetail, 'onChainTally' | 'directTally' | 'liveTally'>): DisplayTally {
  const chain = data.onChainTally
  if (chain?.final) return { ayes: chain.ayes, nays: chain.nays, support: chain.support, source: 'chain' }
  // A running referendum with a reachable node shows the pallet's live tally —
  // current AND complete, where the attributed sum misses delegated power.
  const live = data.liveTally ?? null
  if (live) return { ayes: live.ayes, nays: live.nays, support: live.support, source: 'chain', live: true }
  return {
    ayes: data.directTally.ayes,
    nays: data.directTally.nays,
    support: data.directTally.support,
    source: 'attributed',
    ...(chain ? { snapshot: chain } : {}),
  }
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
