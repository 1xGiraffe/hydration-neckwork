// The pinned OpenGov track table and governance constants — a pure leaf (no
// imports), so the notification rule registry, which must stay dependency-free, names
// the tracks from the same table the governance reads fall back to
// (referendaTracks.ts reads the live values from runtime metadata first).

// All curve parameters are the runtime's own resolved values: Perbill parts
// (1e9 = 100%) for the linear curves, FixedI64 inner values (1e9 = 1.0) for the
// reciprocal ones. Using the resolved form sidesteps reimplementing
// `Curve::make_reciprocal`'s const-eval binary search.
export type TrackCurve =
  | { linearDecreasing: { length: number; floor: number; ceil: number } }
  | { reciprocal: { factor: number; xOffset: number; yOffset: number } }

export interface TrackDef {
  id: number
  name: string
  maxDeciding: number
  decisionDeposit: string
  preparePeriod: number
  decisionPeriod: number
  confirmPeriod: number
  minEnactmentPeriod: number
  minApproval: TrackCurve
  minSupport: TrackCurve
}

export const PERBILL = 1_000_000_000

const APP_RECIP: TrackCurve = { reciprocal: { factor: 222222224, xOffset: 333333335, yOffset: 333333332 } }
const APP_LINEAR: TrackCurve = { linearDecreasing: { length: 1000000000, floor: 500000000, ceil: 1000000000 } }
const APP_LINEAR_FLAT: TrackCurve = { linearDecreasing: { length: 571428571, floor: 500000000, ceil: 1000000000 } }
const SUP_LINEAR: TrackCurve = { linearDecreasing: { length: 1000000000, floor: 0, ceil: 360000000 } }
const SUP_FAST_LINEAR: TrackCurve = { linearDecreasing: { length: 1000000000, floor: 0, ceil: 180000000 } }
const SUP_RECIP: TrackCurve = { reciprocal: { factor: 29822488, xOffset: 76923083, yOffset: -27692310 } }
const SUP_FAST_RECIP: TrackCurve = { reciprocal: { factor: 8055837, xOffset: 21897810, yOffset: -7883212 } }
const SUP_WHITELISTED: TrackCurve = { reciprocal: { factor: 378847, xOffset: 788642, yOffset: 19621452 } }

export const PINNED_TRACKS: TrackDef[] = [
  { id: 0, name: 'root', maxDeciding: 3, decisionDeposit: '1000000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 21600, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_LINEAR },
  { id: 1, name: 'whitelisted_caller', maxDeciding: 3, decisionDeposit: '50000000000000000', preparePeriod: 300, decisionPeriod: 129600, confirmPeriod: 7200, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_WHITELISTED },
  { id: 2, name: 'referendum_canceller', maxDeciding: 3, decisionDeposit: '250000000000000000', preparePeriod: 1800, decisionPeriod: 129600, confirmPeriod: 1800, minEnactmentPeriod: 300, minApproval: APP_LINEAR_FLAT, minSupport: SUP_FAST_RECIP },
  { id: 3, name: 'referendum_killer', maxDeciding: 3, decisionDeposit: '750000000000000000', preparePeriod: 1800, decisionPeriod: 129600, confirmPeriod: 1800, minEnactmentPeriod: 300, minApproval: APP_LINEAR_FLAT, minSupport: SUP_FAST_RECIP },
  { id: 4, name: 'general_admin', maxDeciding: 3, decisionDeposit: '250000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 5400, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_RECIP },
  { id: 5, name: 'treasurer', maxDeciding: 3, decisionDeposit: '750000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 21600, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_FAST_LINEAR },
  { id: 6, name: 'spender', maxDeciding: 3, decisionDeposit: '100000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 5400, minEnactmentPeriod: 300, minApproval: APP_LINEAR, minSupport: SUP_RECIP },
  { id: 7, name: 'tipper', maxDeciding: 3, decisionDeposit: '10000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 5400, minEnactmentPeriod: 300, minApproval: APP_LINEAR_FLAT, minSupport: SUP_FAST_RECIP },
  { id: 8, name: 'omnipool_admin', maxDeciding: 3, decisionDeposit: '250000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 5400, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_RECIP },
  { id: 9, name: 'economic_parameters', maxDeciding: 3, decisionDeposit: '750000000000000000', preparePeriod: 1800, decisionPeriod: 302400, confirmPeriod: 21600, minEnactmentPeriod: 300, minApproval: APP_RECIP, minSupport: SUP_FAST_LINEAR },
]

// `Referenda::UndecidingTimeout` — how long a referendum may sit without its
// decision deposit before the pallet times it out (2 days of 2s blocks, spec 458).
export const PINNED_UNDECIDING_TIMEOUT = 86_400

// `ConvictionVoting::VoteLockingPeriod` — one conviction lock period: a Locked{n}x
// vote on the winning side stays locked 2^(n-1) of these after its poll ends (7 days
// of 2s blocks, spec 458). The pallet constant is read from metadata like the tracks.
export const PINNED_VOTE_LOCKING_PERIOD = 302_400


// Slot-time eras: every period constant (the tracks' prepare/decision/confirm/
// enactment periods) is a block count compiled from the runtime's slot time, so a
// period the pallet applied in an earlier era was a fraction of today's count. Read
// off the chain's own metadata at each boundary (`api.at(block).consts.referenda.
// tracks`, every track): 12 s slots until spec 313 — all periods a sixth of today's —
// whose constants are in force from block 7,582,525; 6 s slots until spec 440 — a
// third — in force from block 13,762,621; 2 s since. (raw_blocks' spec_version flips
// one block earlier, at 7,582,524 and 13,762,620: it reports the block's post-state.)
// The pallet reads its track at each evaluation, so a referendum's thresholds are the
// runtime's at its conclusion (or now, while it runs); one whose decision period spans
// a boundary was judged under two and is only approximately one curve.
export const SLOT_ERAS: readonly { fromBlock: number; periodDivisor: number }[] = [
  { fromBlock: 0, periodDivisor: 6 },
  { fromBlock: 7_582_525, periodDivisor: 3 },
  { fromBlock: 13_762_621, periodDivisor: 1 },
]

/** The divisor that turns today's period block counts into those in force at `block`. */
export function periodDivisorAt(block: number): number {
  let d = SLOT_ERAS[0].periodDivisor
  for (const era of SLOT_ERAS) if (block >= era.fromBlock) d = era.periodDivisor
  return d
}
