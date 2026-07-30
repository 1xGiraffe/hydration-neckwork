// Conviction vote weighting.
//
// Its own module because both the referendum detail (governanceService) and the vote
// feeds (explorerService) need it, and governanceService already imports explorerService
// — putting it in either would make that a cycle.
//
// Multipliers are 0.1x for a lock-free vote and 1x..6x for the locked classes. 0.1 has no
// exact binary representation and vote weight is a financial quantity, so weights are
// carried in TENTHS as integers and divided once: None -> 1, Locked1x -> 10, ...
// Locked6x -> 60.
const CONVICTION_TENTHS = [1n, 10n, 20n, 30n, 40n, 50n, 60n]
export const CONVICTION_NAMES = ['None', 'Locked1x', 'Locked2x', 'Locked3x', 'Locked4x', 'Locked5x', 'Locked6x']

export function convictionTenths(convictionIndex: number): bigint {
  return CONVICTION_TENTHS[convictionIndex] ?? 1n
}

export function convictionName(convictionIndex: number): string {
  return CONVICTION_NAMES[convictionIndex] ?? `Conviction ${convictionIndex}`
}

// The class a conviction LABEL denotes, for callers that only have the decoded name.
// Returns null for a label that names no class (a Split vote has no conviction at all).
export function convictionIndexFromName(name: string | null | undefined): number | null {
  if (!name) return null
  const at = CONVICTION_NAMES.indexOf(name)
  return at >= 0 ? at : null
}

// A Standard AccountVote packs the side into the high bit and the conviction class into
// the low 7 bits of one byte: >= 128 is Aye.
export function decodeVoteByte(voteByte: number): { side: 'Aye' | 'Nay'; convictionIndex: number } {
  return { side: voteByte >= 128 ? 'Aye' : 'Nay', convictionIndex: voteByte & 0x7f }
}

// Conviction-weighted vote power, in the same planck units as the balance. Integer
// throughout: (balance * tenths) / 10, so a 0.1x vote of 1 planck floors to 0 rather than
// drifting through a float.
export function weightedVotePower(balancePlanck: bigint, convictionIndex: number): bigint {
  return (balancePlanck * convictionTenths(convictionIndex)) / 10n
}

// The weighted power a vote row carries, from its decoded amount and conviction LABEL.
// Null when either is missing — a collective (Council / Technical Committee) vote has no
// balance and no conviction, so it has no weight to report rather than a zero.
export function weightedFromLabels(amount: string | null | undefined, conviction: string | null | undefined): string | null {
  if (!amount || !/^\d+$/.test(amount)) return null
  const index = convictionIndexFromName(conviction)
  if (index == null) return null
  return weightedVotePower(BigInt(amount), index).toString()
}
