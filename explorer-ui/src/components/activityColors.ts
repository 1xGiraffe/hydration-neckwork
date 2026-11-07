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
// (Borrow / Withdraw / Supply / Repay / Claim) and any pair sharing a variant reads
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
  // A bond sale's offer opened or closed: the OTC place/pull shade with a bond accent.
  bondOffer: 'var(--cat-bond-offer)',
  // Juicer — citrus lime (the strategy vaults: a deposit, the way out, a claim, the keepers' upkeep)
  juicer: 'var(--cat-juicer)',
  juicerExit: 'var(--cat-juicer-exit)',
  juicerClaim: 'var(--cat-juicer-claim)',
  juicerKeeper: 'var(--cat-juicer-keeper)',
  // BIL — bandeira green (Brazilian Invoice Loans: a deposit, the way out, a claim, the
  // vault's and Decentral's own cash flows, and the interest they pay in gold)
  bil: 'var(--cat-bil)',
  bilExit: 'var(--cat-bil-exit)',
  bilClaim: 'var(--cat-bil-claim)',
  bilKeeper: 'var(--cat-bil-keeper)',
  bilYield: 'var(--cat-bil-yield)',
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
  juicer: CAT.juicer,
  bil: CAT.bil,
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
  Supply: 'Supply',
  ClaimRewards: 'Claim supply rewards',
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
// separate is what the act does: enter, exit, collect (a reward, a payout, a
// realized GIGAHDX yield), migrate, or call off a pending exit. Cancel is tested before exit because a cancelled unstake names both.
function stakingColor(action: string): string {
  if (/migrat/i.test(action)) return CAT.stakeMigrate
  if (/cancel/i.test(action)) return CAT.stakeCancel
  if (/reward|payout|yield/i.test(action)) return CAT.stakeReward
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
// claim like the LM rewards, and so is Compound (a vault's keeper collecting its
// positions' fees to reinvest them); Rebalance (a vault operator re-ranging its
// positions) is pool lifecycle, so it wears Create's shade.
const LIQ_COLORS: Record<string, string> = {
  Add: CAT.liquidity, Remove: CAT.liquidityRemove, Create: CAT.liquidityCreate, Destroy: CAT.liquidityCreate, Claim: CAT.liquidityClaim, ClaimReferral: CAT.liquidityClaim,
  CollectFees: CAT.liquidityClaim, Rebalance: CAT.liquidityCreate, Compound: CAT.liquidityClaim,
}
export const LIQ_LABELS: Record<string, string> = {
  Add: 'Add liquidity', Remove: 'Remove liquidity', Create: 'Create pool', Destroy: 'Destroy pool', Claim: 'Claim LP rewards', ClaimReferral: 'Claim referral rewards',
  CollectFees: 'Collect fees', Rebalance: 'Rebalance vault', Compound: 'Compound',
}
// A bond's two acts are its lifecycle bookends — the issue that mints it against the
// underlying, the redemption that burns it for the underlying — so each gets its own
// shade of the family's teal.
export const BOND_LABELS: Record<string, string> = {
  Issue: 'Bond issued', Redeem: 'Bond redeemed',
  // A primary-sale act (an OTC row that is also a bond row), by its bond action.
  Purchase: 'Bond purchase', Rollover: 'Bond rollover', SaleOpen: 'Bond sale opened', SaleClose: 'Bond sale closed',
}
const BOND_COLORS: Record<string, string> = {
  Issue: CAT.bond, Redeem: CAT.bondRedeem,
}
// A bond's PRIMARY SALE runs through a venue — the OTC orders governance placed selling
// the bond (for money, or for an older bond: a rollover). Its rows stay the venue's rows
// (OTC, under Trade) and are bond rows too (the Bond filter admits them); the badge names
// what they are: the purchase or rollover in the bond family's teal, the offer opened or
// closed in the OTC place/pull shade with a bond accent.
export const BOND_SALE_LABELS: Record<'sale' | 'rollover', Record<string, string>> = {
  sale: { Place: 'Bond sale opened', Pull: 'Bond sale closed', Fill: 'Bond purchase' },
  rollover: { Place: 'Bond rollover opened', Pull: 'Bond rollover closed', Fill: 'Bond rollover' },
}
const BOND_SALE_COLORS: Record<string, string> = { Place: CAT.bondOffer, Pull: CAT.bondOffer, Fill: CAT.bond }
/** A bond-sale row's label (Bond purchase, Bond sale closed, …); null for any other row. */
export function bondSaleLabel(r: Pick<ActivityRow, 'bondSale' | 'otcAction'>): string | null {
  return r.bondSale ? BOND_SALE_LABELS[r.bondSale.kind][r.otcAction ?? ''] ?? 'Bond sale' : null
}
// A Juicer row reads as the official app names the act. The way out is three acts on
// chain — the request (shares into escrow, the cooldown starts), the unwind's start
// and each settled part — then the claim; they share the exit shade and the claim
// takes its own, as does the keepers' upkeep (harvest, rebalance, de-lever).
export const JUICER_LABELS: Record<string, string> = {
  Deposit: 'Juicer deposit', Withdraw: 'Withdrawal requested', Unwind: 'Withdrawal unwinding', Settle: 'Withdrawal settled',
  Claim: 'Withdrawal claimed', ClaimSurplus: 'Surplus claimed', Harvest: 'Juicer harvest', Rebalance: 'Juicer rebalance', Delever: 'Juicer de-lever',
  Lever: 'Loop levered', Unlever: 'Loop unlevered',
}
const JUICER_COLORS: Record<string, string> = {
  Deposit: CAT.juicer, Withdraw: CAT.juicerExit, Unwind: CAT.juicerExit, Settle: CAT.juicerExit,
  Claim: CAT.juicerClaim, ClaimSurplus: CAT.juicerClaim, Harvest: CAT.juicerKeeper, Rebalance: CAT.juicerKeeper, Delever: CAT.juicerKeeper,
  Lever: CAT.juicerKeeper, Unlever: CAT.juicerKeeper,
}
// A BIL row reads as the official app words the act: the way out is a redemption
// request into the queue, its settlements and the claim; the vault's reinvestments and
// the Decentral pool's cash flows (interest, principal, the borrower's draws and
// repayments) are the strategy's own upkeep.
export const BIL_LABELS: Record<string, string> = {
  Deposit: 'BIL deposit', Redeem: 'Redemption requested', Cancel: 'Redemption cancelled', Settle: 'Redemption settled',
  Claim: 'Redemption claimed', Reinvest: 'BIL reinvested', Interest: 'Decentral interest', Principal: 'Decentral principal',
  Draw: 'Decentral draw', Repay: 'Decentral repayment',
}
// The bil-* action slugs the feeds filter on, labelled as the badges (the activity
// chips and the BIL page's own feed read one list).
export const BIL_ACTION_FILTERS: { v: string; label: string }[] = [
  { v: 'bil-deposit', label: BIL_LABELS.Deposit }, { v: 'bil-redeem', label: BIL_LABELS.Redeem }, { v: 'bil-cancel', label: BIL_LABELS.Cancel },
  { v: 'bil-settle', label: BIL_LABELS.Settle }, { v: 'bil-claim', label: BIL_LABELS.Claim }, { v: 'bil-reinvest', label: BIL_LABELS.Reinvest },
  { v: 'bil-interest', label: BIL_LABELS.Interest }, { v: 'bil-principal', label: BIL_LABELS.Principal },
  { v: 'bil-draw', label: BIL_LABELS.Draw }, { v: 'bil-repay', label: BIL_LABELS.Repay },
]
const BIL_COLORS: Record<string, string> = {
  Deposit: CAT.bil, Redeem: CAT.bilExit, Cancel: CAT.bilExit, Settle: CAT.bilExit, Claim: CAT.bilClaim,
  Reinvest: CAT.bilKeeper, Interest: CAT.bilYield, Principal: CAT.bilKeeper, Draw: CAT.bilKeeper, Repay: CAT.bilKeeper,
}
// The product's words: a swap intent is a limit order, a dca intent is a DCA intent.
// One function names every intent row — the badge, the Trade filter list, the slug
// labels and the detail page all read from it, so no surface can say it differently.
const INTENT_KIND_WORD: Record<string, string> = { swap: 'Limit order', dca: 'DCA intent' }
const INTENT_ACTION_WORD: Record<string, string> = { Place: 'placed', Fill: 'filled', PartialFill: 'partially filled', DcaTrade: 'trade', Cancel: 'cancelled', Expire: 'expired' }
export function intentLabel(kind: string | undefined, action: string | undefined): string {
  return `${INTENT_KIND_WORD[kind ?? ''] ?? 'Intent'} ${INTENT_ACTION_WORD[action ?? ''] ?? ''}`.trim()
}
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
// An OTC order's acts read as its lifecycle, the way an intent's do; a cancellation
// is a Pull in product copy.
export const OTC_LABELS: Record<string, string> = {
  Place: 'OTC order placed', Pull: 'OTC order pulled', Fill: 'OTC order filled',
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
  if (r.type === 'juicer') {
    const a = r.juicerAction ?? ''
    return { label: JUICER_LABELS[a] ?? 'Juicer', col: JUICER_COLORS[a] ?? CAT.juicer }
  }
  if (r.type === 'bil') {
    const a = r.bilAction ?? ''
    return { label: a === 'Settle' && r.bilPartial ? 'Redemption partly settled' : BIL_LABELS[a] ?? 'BIL', col: BIL_COLORS[a] ?? CAT.bil }
  }
  if (r.type === 'intent') return { label: intentLabel(r.intentKind, r.intentAction), col: INTENT_COLORS[r.intentAction ?? ''] ?? CAT.intent }
  // A cross-chain swap is a SWAP, in every state. The badge used to say `Sent`
  // in the cross-chain colour until the destination resolved, on the reasoning
  // that the on-chain half says nothing about delivery — but that named the
  // wrong thing: it read as a transfer of the input asset to the destination
  // chain, which is never what happens. The action is what the badge names; the
  // delivery is a state the row shows beside it.
  if (r.type === 'xcswap') {
    const status = r.xcswapStatus
    if (status === 'REFUNDED') return { label: 'Refunded', col: CAT.intentCancel }
    if (status === 'FAILED') return { label: 'Failed', col: 'var(--red)' }
    return { label: 'Cross-chain swap', col: CAT.trade }
  }
  if (r.type === 'vote') return { label: voteLabel(r.voteAction), col: voteColor(r.voteAction) }
  if (r.type === 'liquidity') {
    const a = r.liqAction ?? ''
    return { label: LIQ_LABELS[a] ?? 'Liquidity', col: LIQ_COLORS[a] ?? CAT.liquidity }
  }
  if (r.type === 'trade' || r.type === 'dca') {
    // A failed execution is a failure before it is a trade.
    if (r.type === 'dca' || r.dca) {
      if (r.dcaStatus === 'scheduled') return { label: 'DCA scheduled', col: CAT.tradeDca }
      return r.dcaStatus === 'failed'
        ? { label: 'DCA failed', col: CAT.bad }
        : { label: 'DCA', col: CAT.tradeDca }
    }
    return { label: 'Swap', col: CAT.trade }
  }
  if (r.type === 'otc' && r.bondSale) return { label: bondSaleLabel(r)!, col: BOND_SALE_COLORS[r.otcAction ?? ''] ?? CAT.bond }
  if (r.type === 'otc') {
    const a = r.otcAction
    return { label: OTC_LABELS[a ?? ''] ?? 'OTC order', col: OTC_COLORS[a ?? ''] ?? CAT.tradePlace }
  }
  if (r.type === 'transfer') return { label: 'Transfer', col: CAT.transfer }
  // A cross-chain row that knows its bridge names it — "Wormhole" or "Snowbridge"
  // says how the transfer crossed, which "Cross-chain" only implies. Same family,
  // colour and filters either way.
  if (r.type === 'xcm') return { label: r.bridge ?? 'Cross-chain', col: CAT.xcm }
  return { label: 'Activity', col: 'var(--text-medium)' }
}
