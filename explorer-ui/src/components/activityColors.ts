import type { ActivityRow } from '../types'

// Activity color coding, across two layers that never compete:
//   CATEGORY  what kind of activity this is — orange trade, yellow money market,
//             blue liquidity, grey movement, purple staking/governance,
//   VALENCE   which way it went — green good, red bad.
// Valence WINS wherever a row has a side, so AYE/NAY, failed executions and
// liquidations read the same here as they do on every other surface. A
// liquidation is a category borrowing the valence red, which is right: it is the
// bad outcome.
//
// Every surface that colors by category reads from this module, so changing a
// shade is one edit here plus its token in global.css.
//
// A family is a RAMP with one shade per action, not one hue with a light and a
// dark variant. Two variants could not carry it — a family has up to five actions
// (Borrow / Withdraw / Lend / Repay / Claim) and any pair sharing a variant reads
// as the same badge. The shades move in lightness AND chroma; a pure lightness
// ramp inside a single hue leaves neighbouring steps indistinguishable at 10px.
export const CAT = {
  // trade — orange
  trade: 'var(--cat-trade)',
  tradeDca: 'var(--cat-trade-dca)',
  tradeFill: 'var(--cat-trade-fill)',
  tradePlace: 'var(--cat-trade-place)',
  // money market — yellow
  borrow: 'var(--cat-borrow)',
  borrowWithdraw: 'var(--cat-borrow-withdraw)',
  borrowLend: 'var(--cat-borrow-lend)',
  borrowRepay: 'var(--cat-borrow-repay)',
  borrowClaim: 'var(--cat-borrow-claim)',
  // liquidity — blue
  liquidity: 'var(--cat-liquidity)',
  liquidityRemove: 'var(--cat-liquidity-remove)',
  liquidityCreate: 'var(--cat-liquidity-create)',
  liquidityClaim: 'var(--cat-liquidity-claim)',
  // staking — purple
  stake: 'var(--cat-stake)',
  stakeExit: 'var(--cat-stake-exit)',
  stakeReward: 'var(--cat-stake-reward)',
  stakeMigrate: 'var(--cat-stake-migrate)',
  stakeCancel: 'var(--cat-stake-cancel)',
  // movement, governance, outcome
  transfer: 'var(--cat-transfer)',
  xcm: 'var(--cat-xcm)',
  vote: 'var(--cat-vote)',
  aye: 'var(--green)',
  nay: 'var(--red)',
  bad: 'var(--cat-bad)',
} as const

// The color a whole category answers to — for the filter chips, the activity
// histogram, and anything else naming a category rather than a single row. Each
// family is represented by its primary shade.
const CATEGORY_COLORS: Record<string, string> = {
  trade: CAT.trade, dca: CAT.trade, otc: CAT.trade,
  mm: CAT.borrow,
  liquidity: CAT.liquidity,
  transfer: CAT.transfer,
  xcm: CAT.xcm,
  stake: CAT.stake,
  vote: CAT.vote,
}
// Charts that are not scoped to a category — the unfiltered activity histogram,
// and the block/extrinsic/event counts, which are not activities at all — take a
// neutral slate, so they never claim a meaning the coding assigned elsewhere.
export const UNFILTERED_COLOR = 'var(--chart-neutral)'
export function categoryColor(type: string): string {
  return CATEGORY_COLORS[type] ?? UNFILTERED_COLOR
}

// The chain's money-market action names are not what this app calls them. The
// values stay as the runtime emits them (they are the filter and the indexed
// field); only the words a reader sees change here.
//
// Two unrelated acts are both a reward claim — a money-market lending incentive
// and a liquidity-mining payout — and they meet in the merged feed, so each names
// the position it pays out on rather than leaving a reader to guess which is which.
export const MM_LABELS: Record<string, string> = {
  Supply: 'Lend',
  ClaimRewards: 'Claim Lend Rewards',
  LiquidationCall: 'Liquidate',
  Liquidate: 'Liquidate',
}
// One shade per money-market action, ordered by how much of the position each
// moves. Liquidation leaves the family for red.
const MM_COLORS: Record<string, string> = {
  Borrow: CAT.borrow,
  Withdraw: CAT.borrowWithdraw,
  Supply: CAT.borrowLend,
  Repay: CAT.borrowRepay,
  ClaimRewards: CAT.borrowClaim,
  LiquidationCall: CAT.bad,
  Liquidate: CAT.bad,
}

// Staking has more actions than a ramp can hold apart, so the GIGAHDX/plain
// variants of one act share a shade — Stake and GIGAHDX Stake are the same act on
// different products, and telling THOSE apart is the label's job. What must stay
// separate is what the act does: enter, exit, collect, migrate, or call off a
// pending exit. Cancel is tested before exit because a cancelled unstake names both.
function stakingColor(action: string): string {
  if (/migrat/i.test(action)) return CAT.stakeMigrate
  if (/cancel/i.test(action)) return CAT.stakeCancel
  if (/reward|payout/i.test(action)) return CAT.stakeReward
  if (/unstake/i.test(action)) return CAT.stakeExit
  return CAT.stake
}

// A vote's side is valence, not category — AYE and NAY carry the same green and
// red here as in the votes table and the bubble map. Only a sideless vote (a
// collective vote, which has no aye/nay) falls back to the category's lavender.
function voteColor(action: string | null | undefined): string {
  if (/^aye$/i.test(action ?? '')) return CAT.aye
  if (/^nay$/i.test(action ?? '')) return CAT.nay
  return CAT.vote
}
// The feed reports a sideless vote as "Voted"; the badge names the act, like every
// other badge in the table does.
function voteLabel(action: string | null | undefined): string {
  return !action || /^voted$/i.test(action) ? 'Vote' : action
}

// Destroy (pool closure) shares Create's shade rather than a new token — the two
// are the pool's lifecycle bookends, distinct from an ordinary Add/Remove trade,
// and the family has no dedicated closure/negative variant to reach for instead.
const LIQ_COLORS: Record<string, string> = {
  Add: CAT.liquidity, Remove: CAT.liquidityRemove, Create: CAT.liquidityCreate, Destroy: CAT.liquidityCreate, Claim: CAT.liquidityClaim,
}
export const LIQ_LABELS: Record<string, string> = {
  Add: 'Add liquidity', Remove: 'Remove liquidity', Create: 'Create pool', Destroy: 'Destroy pool', Claim: 'Claim LP Rewards',
}
const OTC_COLORS: Record<string, string> = {
  // Placing and pulling an offer both only move an offer around — neither moves
  // value — so they share a shade; their labels differ.
  Fill: CAT.tradeFill, Place: CAT.tradePlace, Pull: CAT.tradePlace,
}

// Label + color for one activity row. Labels are the badges the rest of the app
// names its filters and detail routes after, so they stay in step with
// ACTIVITY_ACTIONS and activitySlug().
export function activityBadge(r: ActivityRow): { label: string; col: string } {
  if (r.type === 'mm') {
    const a = r.mmAction || 'Supply'
    return { label: MM_LABELS[a] ?? a, col: MM_COLORS[a] ?? CAT.borrowClaim }
  }
  if (r.type === 'staking') {
    const a = r.stakingAction || 'Staking'
    return { label: a, col: stakingColor(a) }
  }
  if (r.type === 'vote') return { label: voteLabel(r.voteAction), col: voteColor(r.voteAction) }
  if (r.type === 'liquidity') {
    const a = r.liqAction ?? ''
    return { label: LIQ_LABELS[a] ?? 'Liquidity', col: LIQ_COLORS[a] ?? CAT.liquidity }
  }
  if (r.type === 'trade' || r.type === 'dca') {
    // A failed execution is a failure before it is a trade.
    if (r.type === 'dca' || r.dca) {
      return r.dcaStatus === 'failed'
        ? { label: 'DCA failed', col: CAT.bad }
        : { label: 'DCA', col: CAT.tradeDca }
    }
    return { label: 'Swap', col: CAT.trade }
  }
  if (r.type === 'otc') {
    const a = r.otcAction
    return { label: 'OTC ' + (a ?? 'order').toLowerCase(), col: OTC_COLORS[a ?? ''] ?? CAT.tradePlace }
  }
  if (r.type === 'transfer') return { label: 'Transfer', col: CAT.transfer }
  // A cross-chain row that knows its bridge names it — "Wormhole" or "Snowbridge"
  // says how the transfer crossed, which "Cross-chain" only implies. Same family,
  // colour and filters either way.
  if (r.type === 'xcm') return { label: r.bridge ?? 'Cross-chain', col: CAT.xcm }
  return { label: 'Activity', col: 'var(--text-medium)' }
}
