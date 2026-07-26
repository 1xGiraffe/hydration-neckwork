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


// Governance locks are denominated in HDX (asset 0, 12 decimals). Only used to render an
// empty/loading votes table, before any row's own asset is available.
export const assetDescriptorFallback = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 } as AssetRef
