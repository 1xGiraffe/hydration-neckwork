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
  // bonds — teal
  bond: 'var(--cat-bond)',
  bondRedeem: 'var(--cat-bond-redeem)',
  // intents — violet (limit orders and DCA intents)
  intent: 'var(--cat-intent)',
  intentFill: 'var(--cat-intent-fill)',
  intentCancel: 'var(--cat-intent-cancel)',
  intentDca: 'var(--cat-intent-dca)',
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
  bond: CAT.bond,
  intent: CAT.intent,
  // A cross-chain swap is a swap, so it reads in the trade family's colour.
  xcswap: CAT.trade,
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
// CollectFees (a concentrated-liquidity position collecting its earned fees) is a
// claim like the LM rewards; Rebalance (a vault operator re-ranging its positions)
// is pool lifecycle, so it wears Create's shade.
const LIQ_COLORS: Record<string, string> = {
  Add: CAT.liquidity, Remove: CAT.liquidityRemove, Create: CAT.liquidityCreate, Destroy: CAT.liquidityCreate, Claim: CAT.liquidityClaim, ClaimReferral: CAT.liquidityClaim,
  CollectFees: CAT.liquidityClaim, Rebalance: CAT.liquidityCreate,
}
export const LIQ_LABELS: Record<string, string> = {
  Add: 'Add liquidity', Remove: 'Remove liquidity', Create: 'Create pool', Destroy: 'Destroy pool', Claim: 'Claim LP Rewards', ClaimReferral: 'Claim Referral Rewards',
  CollectFees: 'Collect fees', Rebalance: 'Rebalance vault',
}
// A bond's two acts are its lifecycle bookends — the issue that mints it against the
// underlying, the redemption that burns it for the underlying — so each gets its own
// shade of the family's teal.
export const BOND_LABELS: Record<string, string> = {
  Issue: 'Bond issue', Redeem: 'Bond redeem',
}
const BOND_COLORS: Record<string, string> = {
  Issue: CAT.bond, Redeem: CAT.bondRedeem,
}
// The product's words: a swap intent is a limit order, a dca intent is a DCA intent.
// One function names every intent row — the badge, the Trade filter list, the slug
// labels and the detail page all read from it, so no surface can say it differently.
const INTENT_KIND_WORD: Record<string, string> = { swap: 'Limit order', dca: 'DCA intent' }
const INTENT_ACTION_WORD: Record<string, string> = { Place: 'placed', Fill: 'filled', PartialFill: 'partially filled', DcaTrade: 'trade', Cancel: 'cancelled', Expire: 'expired' }
export function intentLabel(kind: string | undefined, action: string | undefined): string {
  return `${INTENT_KIND_WORD[kind ?? ''] ?? 'Intent'} ${INTENT_ACTION_WORD[action ?? ''] ?? ''}`.trim()
}
// The same words as a table, keyed `${kind}:${action}`, for a surface that wants a
// lookup rather than a call. Derived, so it cannot drift from intentLabel.
export const INTENT_LABELS: Record<string, string> = Object.fromEntries(
  Object.keys(INTENT_KIND_WORD).flatMap(kind => Object.keys(INTENT_ACTION_WORD).map(action => [`${kind}:${action}`, intentLabel(kind, action)])))
// Placing an order, filling it, leaving it (cancelled or expired) and a DCA intent's
// trade are the four acts a reader tells apart; a partial fill IS a fill and an
// expiry IS the order leaving, so each shares its sibling's shade.
const INTENT_COLORS: Record<string, string> = {
  Place: CAT.intent, Fill: CAT.intentFill, PartialFill: CAT.intentFill, DcaTrade: CAT.intentDca, Cancel: CAT.intentCancel, Expire: CAT.intentCancel,
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
  if (r.type === 'bond') {
    const a = r.bondAction ?? ''
    return { label: BOND_LABELS[a] ?? 'Bond', col: BOND_COLORS[a] ?? CAT.bond }
  }
  if (r.type === 'intent') return { label: intentLabel(r.intentKind, r.intentAction), col: INTENT_COLORS[r.intentAction ?? ''] ?? CAT.intent }
  // A cross-chain swap's badge names its OUTCOME, because the on-chain half always
  // succeeds and says nothing about whether the swap landed: the order is placed
  // here and settled on another chain minutes later. `Sent` is the honest label
  // while that is unknown — not `Swapped`, which would claim delivery.
  if (r.type === 'xcswap') {
    const status = r.xcswapStatus
    if (status === 'SUCCESS') return { label: 'Cross-chain swap', col: CAT.trade }
    if (status === 'REFUNDED') return { label: 'Refunded', col: CAT.intentCancel }
    if (status === 'FAILED') return { label: 'Failed', col: 'var(--red)' }
    return { label: 'Sent', col: CAT.xcm }
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
