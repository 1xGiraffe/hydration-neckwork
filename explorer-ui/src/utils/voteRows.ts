import type { ActivityRow, AssetRef, VoteRow } from '../types'

// How this app writes a vote side, whatever token the source used for it. A side
// reaches the UI as the chain's own AccountVote wording — 'Aye'/'Nay' for a Standard
// vote, the variant name for the others ('Split', 'SplitAbstain'), 'Vote' when no side
// could be decoded — and every surface that shows one goes through here, so the badge,
// the bubble hover cards, the vote detail header and the filter chips cannot drift apart
// or leak a raw enum name.
//
// Sides are written in caps and terse. SPLIT and SPLIT ABSTAIN stay apart because they
// are not the same vote: a Split backs aye and nay, a SplitAbstain also parks capital on
// neither side, and most of the SplitAbstain votes indexed are abstain-only — collapsing
// them to SPLIT would read as if they had taken sides.
export type VoteSideLabel = 'AYE' | 'NAY' | 'SPLIT' | 'SPLIT ABSTAIN' | 'VOTE'
export function voteSideLabel(side: string | null | undefined): VoteSideLabel {
  switch ((side ?? '').replace(/[\s_-]/g, '').toLowerCase()) {
    case 'aye': return 'AYE'
    case 'nay': return 'NAY'
    case 'split': return 'SPLIT'
    case 'splitabstain': return 'SPLIT ABSTAIN'
    default: return 'VOTE'
  }
}

// A vote as the activity feed renders it. This tab used to draw its own table —
// Referendum / Type / Side / Conviction / Amount / Value / Time, linking to the generic
// activity-detail page — which looked nothing like the same vote on /activity and drifted
// further from it with every change there. Mapping to ActivityRow instead means one
// renderer: the same asset chip and amount, the muted #index ahead of a linked referendum
// title, the AYE/NAY badge, the conviction, the hover cards and the row navigation.
export function voteToActivityRow(vote: VoteRow): ActivityRow {
  return {
    type: 'vote',
    blockHeight: vote.blockHeight,
    timestamp: vote.timestamp,
    eventIndex: vote.eventIndex,
    extrinsicIndex: vote.extrinsicIndex,
    who: vote.account,
    to: null,
    asset: vote.asset,
    assetIn: null,
    assetOut: null,
    amount: vote.amount,
    amountIn: null,
    amountOut: null,
    valueUsd: vote.valueUsd,
    votePallet: vote.pallet,
    voteAction: vote.action,
    voteRef: vote.referendum,
    voteSide: vote.side,
    voteConviction: vote.conviction,
    voteRefPallet: vote.voteRefPallet ?? null,
    voteRefTitle: vote.voteRefTitle ?? null,
    linkBlock: vote.blockHeight,
    linkIndex: vote.extrinsicIndex,
  }
}


// What a vote was ABOUT, in one phrase, wherever a vote row shows its subject.
//
// A conviction/Democracy vote names a numbered referendum with a page of its own;
// a collective (Council / Technical Committee) vote names a proposal HASH and has
// none. Calling that hash "Referendum #0x0529aa…664b5b" states two wrong things at
// once — it is a motion, and the hash is not an index — so a subject with no
// referendum pallet reads as the motion it is. The off-chain title, when one is
// known, always wins: it is what the vote was actually about.
export function voteSubjectLabel(
  referendum: string | null | undefined,
  referendumPallet: 'opengov' | 'democracy' | null | undefined,
  referendumTitle: string | null | undefined,
): string {
  if (referendumTitle) return referendumTitle
  if (!referendum) return 'Referendum'
  return referendumPallet ? `Referendum #${referendum}` : `Motion ${referendum}`
}

// Governance locks are denominated in HDX (asset 0, 12 decimals). Only used to render an
// empty/loading votes table, before any row's own asset is available.
export const assetDescriptorFallback = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 } as AssetRef

// The capital-weighted average conviction of a combined vote, derived from the
// two integer sums the aggregate carries: weighted = Σ(capital × conviction),
// so weighted/capital IS the mean multiple, recovered in tenths with integer
// arithmetic (conviction is defined in tenths on-chain: None = 0.1x … 6x).
// Null when there is no capital to weigh — a collective vote has neither.
// Shared by the referendum bubble chart's tag bubbles and the tag votes tab's
// grouped rows, so one vote can never read two different averages.
// A single vote's conviction, as a reader knows it. The chain names it with a
// runtime enum — `Locked6x`, and `None` for the no-lock case — which reads as
// neither a multiplier nor, in the `None` case, as a value at all: it looks
// like missing data next to the votes that show one. Conviction is defined in
// tenths on-chain (None = 0.1x … 6x), so the no-lock vote genuinely carries
// 0.1x of its capital, and saying so keeps it in the same vocabulary the
// grouped rows already use ("1.2x avg", see avgConvictionLabel below).
// Anything unrecognised passes through untouched — a conviction the runtime
// grows later is still a fact, and hiding it would be worse than printing it.
export function convictionLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (raw === 'None') return '0.1x'
  const locked = /^Locked([1-6])x$/.exec(raw)
  return locked ? `${locked[1]}x` : raw
}

export function avgConvictionLabel(weighted: string | null, capital: string | null): string | null {
  if (weighted == null || capital == null) return null
  const w = BigInt(weighted), c = BigInt(capital)
  if (c <= 0n) return null
  const tenths = (w * 10n + c / 2n) / c   // round half up, still integer maths
  return `${tenths / 10n}.${tenths % 10n}x avg`
}
