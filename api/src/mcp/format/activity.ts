/**
 * The activity feed, rendered.
 *
 * This is the module the product is for. The explorer has already done the hard
 * part — classifying each extrinsic into the user's highest-level economic
 * action and suppressing its plumbing legs — and what is left is to say that
 * action in words, with every amount scaled by its OWN leg's decimals, its USD
 * value, and the canonical page it lives on.
 *
 * Three things the rendering never does, because each would make a model state
 * something false:
 *  - print a raw integer amount (an unscaled `"284302451217553232"` reads as a
 *    quantity of tokens);
 *  - print a raw AccountId32 as if it were an address;
 *  - print an unconfirmed row's placeholder block height as a real one, or let
 *    a pending row pass as something that happened.
 */

import type { ActivityRow, ActivityRowType, AssetRef } from '../types.ts'
import { formatAmount, formatUsd, DASH } from './units.ts'
import { relativeAge, formatTime } from './time.ts'
import {
  accountLabel, assetLabel, shortForeignAddress, shortHash,
  activityUrl, blockUrl, dcaScheduleUrl, extrinsicAtUrl, extrinsicUrl, intentUrl,
  poolUrl, referendumUrl, v3PoolUrl, explorerLink,
} from './refs.ts'
import { bullets, kv, note } from './md.ts'

/* ============ the vocabulary, as data ============ */

/**
 * The 13 values `type=` accepts. Exported as data so a tool's description, its
 * zod schema and this renderer cannot drift apart.
 */
export const ACTIVITY_TYPES = [
  'all', 'transfer', 'trade', 'dca', 'liquidity', 'mm', 'xcm',
  'stake', 'vote', 'otc', 'bond', 'intent', 'xcswap',
] as const
export type ActivityType = typeof ACTIVITY_TYPES[number]

/**
 * The 12 values a ROW's own `type` can carry. Note it is not the same list:
 * `all` is a query word, `stake` arrives as `staking`, and `dca` executions
 * arrive typed `trade`.
 */
export const ACTIVITY_ROW_TYPES: readonly ActivityRowType[] = [
  'transfer', 'trade', 'xcm', 'liquidity', 'mm', 'dca',
  'staking', 'vote', 'otc', 'bond', 'intent', 'xcswap',
]

/**
 * The `action=` sub-filter vocabulary, per query type. Values are matched
 * server-side as free text: an unknown one is NOT an error upstream — scoped it
 * returns an empty page, and on the global feed it spends ~45 s before
 * answering 503 — so callers validate against this list before the call.
 */
export const ACTIVITY_ACTIONS: Record<string, string[]> = {
  trade: [
    'swap', 'dca', 'dca-failed',
    'otc-place', 'otc-pull', 'otc-fill',
    'intent-place', 'intent-fill', 'intent-cancel', 'intent-expire', 'intent-dca-trade',
    'xcswap',
  ],
  xcm: ['out', 'in'],
  liquidity: ['Add', 'Remove', 'Create', 'Destroy', 'Claim', 'ClaimReferral', 'CollectFees', 'Rebalance'],
  mm: ['Supply', 'Withdraw', 'Borrow', 'Repay', 'LiquidationCall', 'ClaimRewards'],
  stake: [
    'Stake', 'Add stake', 'Unstake', 'Force unstake', 'Staking reward',
    'GIGAHDX Stake', 'GIGAHDX Unstake', 'GIGAHDX Cancel Unstake', 'GIGAHDX Unlock',
    'GIGAHDX Migrate', 'GIGAHDX Reward', 'Collator payout',
  ],
  bond: ['Issue', 'Redeem'],
  vote: ['Aye', 'Nay'],
}

/**
 * `type=dca` takes the TRADE vocabulary: it selects the trade family rather
 * than a family of its own, and measured `type=dca&action=dca` answers rows
 * typed `trade` carrying `dca: true`.
 */
const ACTION_TYPE_ALIASES: Record<string, string> = { dca: 'trade' }

/**
 * The action vocabulary for a query type, or null when that type takes no
 * `action` at all. Callers validate against this before the call, because
 * upstream an unknown value is not an error.
 */
export function actionsForType(type: string | null | undefined): string[] | null {
  const key = ACTION_TYPE_ALIASES[type ?? ''] ?? type ?? ''
  return ACTIVITY_ACTIONS[key] ?? null
}

/** The query types that accept an `action`, in description order. */
export const TYPES_WITH_ACTIONS: readonly string[] =
  [...Object.keys(ACTIVITY_ACTIONS), ...Object.keys(ACTION_TYPE_ALIASES)]

/**
 * The three things about this feed an agent cannot discover by calling it, and
 * would otherwise state wrongly. Meant to be pasted into a tool description.
 */
export const ACTIVITY_TYPE_NOTES =
  'Three traps: type=dca returns rows whose own type is "trade" and does NOT narrow to DCA at ' +
  'all — it selects the whole trade family, so ordinary swaps arrive alongside the DCA fills ' +
  '(a fill IS a trade, flagged dca:true, and labelled "Swap" unless it carries that flag — ' +
  '`dcaScheduleId` names the schedule on the account- and tag-scoped feeds only, the GLOBAL feed ' +
  'omits it, so `dca` is the flag to read); ' +
  'type=trade is a FAMILY and also returns otc, intent and xcswap rows, while ' +
  'type=otc|intent|xcswap narrow to their own; and an unknown `token` is not an error upstream — ' +
  'it silently returns an empty page, so this tool names it as a candidate cause whenever a ' +
  'filtered page comes back empty. (`action` is checked against the per-type list below BEFORE ' +
  'the call, because upstream an unknown one costs ~45 s and a 503 on the global feed.)'

/* ============ per-family wording ============ */

const LIQ_LABELS: Record<string, string> = {
  Add: 'Add liquidity', Remove: 'Remove liquidity', Create: 'Create pool', Destroy: 'Destroy pool',
  Claim: 'Claim LP rewards', ClaimReferral: 'Claim referral rewards',
  CollectFees: 'Collect fees', Rebalance: 'Rebalance vault',
}
const MM_LABELS: Record<string, string> = {
  Supply: 'Lend', ClaimRewards: 'Claim lend rewards',
  LiquidationCall: 'Liquidate', Liquidate: 'Liquidate',
}
const BOND_LABELS: Record<string, string> = { Issue: 'Bond issue', Redeem: 'Bond redeem' }
const INTENT_KIND_WORD: Record<string, string> = { swap: 'Limit order', dca: 'DCA intent' }
const INTENT_ACTION_WORD: Record<string, string> = {
  Place: 'placed', Fill: 'filled', PartialFill: 'partially filled',
  DcaTrade: 'trade', Cancel: 'cancelled', Expire: 'expired',
}
const intentLabel = (kind?: string, action?: string): string =>
  `${INTENT_KIND_WORD[kind ?? ''] ?? 'Intent'} ${INTENT_ACTION_WORD[action ?? ''] ?? ''}`.trim()

/**
 * What the row IS, in words — the same label the explorer's badge shows, so a
 * filter, a page and this line all name the action identically.
 */
export function activityKind(r: ActivityRow): string {
  switch (r.type) {
    case 'mm': return MM_LABELS[r.mmAction ?? ''] ?? r.mmAction ?? 'Money market'
    case 'staking': return r.stakingAction || 'Staking'
    case 'bond': return BOND_LABELS[r.bondAction ?? ''] ?? 'Bond'
    case 'intent': return intentLabel(r.intentKind, r.intentAction)
    case 'xcswap':
      return r.xcswapStatus === 'SUCCESS' ? 'Cross-chain swap'
        : r.xcswapStatus === 'REFUNDED' ? 'Cross-chain swap refunded'
        : r.xcswapStatus === 'FAILED' ? 'Cross-chain swap failed'
        // The on-chain half always succeeds and says nothing about delivery, so
        // an unsettled order is "sent", never "swapped".
        : 'Cross-chain swap sent'
    case 'vote':
      return !r.voteAction || /^voted$/i.test(r.voteAction) ? 'Vote' : r.voteAction
    case 'liquidity': return LIQ_LABELS[r.liqAction ?? ''] ?? 'Liquidity'
    case 'trade':
    case 'dca':
      if (r.type === 'dca' || r.dca) return r.dcaStatus === 'failed' ? 'DCA execution failed' : 'DCA execution'
      return 'Swap'
    // Product copy calls an OTC cancellation a Pull.
    case 'otc': return `OTC ${(r.otcAction ?? 'order').toLowerCase()}`
    case 'transfer': return 'Transfer'
    case 'xcm': return r.bridge ?? 'Cross-chain'
    default: return 'Activity'
  }
}

/* ============ links ============ */

const MM_SLUG: Record<string, string> = {
  Supply: 'lend', Withdraw: 'withdraw', Borrow: 'borrow', Repay: 'repay',
  LiquidationCall: 'liquidate', Liquidate: 'liquidate', ClaimRewards: 'claim-rewards',
}

/** The URL segment the row's detail page lives under — the explorer's own slug set. */
export function activitySlug(r: ActivityRow): string {
  switch (r.type) {
    case 'trade': return r.dca ? 'dca' : 'swap'
    case 'dca': return 'dca'
    case 'xcm': return 'cross-chain'
    case 'liquidity':
      return r.liqAction === 'Remove' ? 'remove-liquidity'
        : r.liqAction === 'Create' ? 'create-pool'
        : r.liqAction === 'Destroy' ? 'destroy-pool'
        : r.liqAction === 'Claim' ? 'claim-rewards'
        : r.liqAction === 'ClaimReferral' ? 'claim-referral-rewards'
        : r.liqAction === 'CollectFees' ? 'collect-fees'
        : r.liqAction === 'Rebalance' ? 'rebalance'
        : 'add-liquidity'
    case 'mm': return MM_SLUG[r.mmAction ?? ''] ?? 'lend'
    case 'staking': return 'staking'
    case 'bond': return r.bondAction === 'Redeem' ? 'bond-redeem' : 'bond-issue'
    case 'intent':
      // A partial fill IS a fill: one slug covers both.
      return r.intentAction === 'Place' ? 'intent-place'
        : r.intentAction === 'Cancel' ? 'intent-cancel'
        : r.intentAction === 'Expire' ? 'intent-expire'
        : r.intentAction === 'DcaTrade' ? 'intent-dca-trade'
        : 'intent-fill'
    case 'vote': return 'vote'
    case 'otc': return r.otcAction === 'Pull' ? 'otc-pull' : r.otcAction === 'Fill' ? 'otc-fill' : 'otc-place'
    default: return 'transfer'
  }
}

/** A row is not yet a fact while it sits in the pool or above the finalized head. */
export const isUnconfirmed = (r: ActivityRow): boolean => r.finalized === false || r.mempool === true

/** In the transaction pool: no block at all, and `blockHeight` is a 0 placeholder. */
export const isMempool = (r: ActivityRow): boolean => r.mempool === true

/** In a REAL block that is above the finalized head — the height is genuine. */
export const isAboveFinalized = (r: ActivityRow): boolean => r.mempool !== true && r.finalized === false

/**
 * What to say about the unconfirmed rows of a page, or null when there are none.
 *
 * The two unconfirmed states are not the same claim and must not share one
 * sentence. A MEMPOOL row has no block: its `blockHeight` is a zero placeholder
 * and its amounts are a dry-run projection. A row ABOVE THE FINALIZED HEAD is
 * already in a block with a real, quotable height — what is provisional is
 * whether that block survives, not where the row is.
 */
export function unconfirmedNote(rows: readonly ActivityRow[]): string | null {
  const pooled = rows.filter(isMempool).length
  const ahead = rows.filter(isAboveFinalized).length
  if (!pooled && !ahead) return null
  const parts = [
    pooled ? `${pooled} ${pooled === 1 ? 'row is' : 'rows are'} still in the TRANSACTION POOL: no block yet, so the block height is a zero placeholder (never shown here) and the amounts are a dry-run projection` : null,
    ahead ? `${ahead} ${ahead === 1 ? 'row sits' : 'rows sit'} in a REAL block ABOVE the finalized head: the block height shown is genuine, but the block can still reorg away` : null,
  ].filter(Boolean)
  return `${parts.join('; ')}. Neither is a fact yet — do not report one as something that happened.`
}

/** True when the row's block coordinates are the mempool's `0` placeholders. */
const hasRealBlock = (r: ActivityRow): boolean => r.mempool !== true && r.blockHeight > 0

/** `<height>-e<eventIndex>` for an event-indexed row, `<height>-<index>` otherwise. */
function coordinateId(r: ActivityRow): string | null {
  if (!hasRealBlock(r)) return null
  if (r.eventIndex != null) return `${r.blockHeight}-e${r.eventIndex}`
  if (r.extrinsicIndex != null) return `${r.blockHeight}-${r.extrinsicIndex}`
  return null
}

/**
 * The canonical Explorer URL for one row, or null when the row has no page yet.
 *
 * Precedence follows the explorer's own rule, because "canonical" means the page
 * a human would reach by clicking the row:
 *  1. a pool transaction has no block, so it is addressed by its hash;
 *  2. a DCA execution links to its SCHEDULE — the standing order, not one fill;
 *  3. an ICE intent links to its ORDER — every event of its life;
 *  4. a cross-chain swap has no detail page of its own: what there is to see is
 *     the extrinsic that placed it;
 *  5. otherwise the row's slug over its coordinates in the block.
 *
 * `linkBlock`/`linkIndex` are the fallback the upstream provides for a row whose
 * own coordinates are absent — they name the extrinsic the row belongs to — and
 * when those are null too the contract is to link the block.
 */
export function activityUrlFor(r: ActivityRow, base: string): string | null {
  if (r.mempool) return r.hash ? extrinsicUrl(base, r.hash) : null
  if ((r.type === 'dca' || r.dca) && r.dcaScheduleId != null) return dcaScheduleUrl(base, r.dcaScheduleId)
  if (r.type === 'intent' && r.intentId) return intentUrl(base, r.intentId)
  if (r.type === 'xcswap') {
    if (r.extrinsicIndex != null && hasRealBlock(r)) return extrinsicAtUrl(base, r.blockHeight, r.extrinsicIndex)
    if (r.linkBlock != null && r.linkIndex != null) return extrinsicAtUrl(base, r.linkBlock, r.linkIndex)
  }
  const id = coordinateId(r)
  if (id) return activityUrl(base, activitySlug(r), id)
  if (r.linkBlock != null && r.linkIndex != null) return extrinsicAtUrl(base, r.linkBlock, r.linkIndex)
  const height = r.linkBlock ?? (hasRealBlock(r) ? r.blockHeight : null)
  return height != null ? blockUrl(base, height) : null
}

/* ============ amounts ============ */

const leg = (asset: AssetRef | null | undefined, amount: string | null | undefined): string | null => {
  if (!asset || amount == null) return null
  // Decimals come from the row's OWN asset ref — HOLLAR 18, DOT 10, USDC 6 and
  // HDX 12 all appear on one page of this feed.
  return formatAmount(amount, asset.decimals, assetLabel(asset))
}

/** The value that moved, in tokens: `1.67k DOT → 166 EURC` or `44k DOT`. */
export function activityAmounts(r: ActivityRow): string | null {
  const inLeg = leg(r.assetIn, r.amountIn)
  const outLeg = leg(r.assetOut, r.amountOut)
  if (r.type === 'xcswap') {
    // Three legs: sold, bridged, delivered. The middle one is the whole reason a
    // reader does not mistake this for the input asset being sent to the
    // destination chain — it is sold on Hydration for the WETH that bridges.
    // The destination is not a registry asset, so it travels as its own fields.
    const dest = r.xcswapDestAmount != null && r.xcswapDestDecimals != null
      ? formatAmount(r.xcswapDestAmount, r.xcswapDestDecimals, r.xcswapDestSymbol ?? undefined)
      : r.xcswapDestSymbol ?? null
    return [inLeg, outLeg, dest].filter(Boolean).join(' → ') || null
  }
  if (inLeg && outLeg) return `${inLeg} → ${outLeg}`
  return inLeg ?? outLeg ?? leg(r.asset, r.amount)
}

/* ============ the one-line form ============ */

const actors = (r: ActivityRow): string | null => {
  const who = r.who ? accountLabel(r.who) : null
  if (r.type === 'xcm') {
    const far = r.xcmDir === 'in' ? r.fromAccount : r.destAccount
    const farLabel = far ? accountLabel(far) : null
    if (!who && !farLabel) return null
    return r.xcmDir === 'in' ? `${farLabel ?? DASH} → ${who ?? DASH}` : `${who ?? DASH} → ${farLabel ?? DASH}`
  }
  if (r.type === 'xcswap' && r.xcswapRecipient) {
    return `${who ?? DASH} → ${shortForeignAddress(r.xcswapRecipient)}`
  }
  if (r.to) return `${who ?? DASH} → ${accountLabel(r.to)}`
  return who
}

/** The per-family detail that changes what the line MEANS, not just decorates it. */
function qualifiers(r: ActivityRow): string[] {
  const out: string[] = []
  switch (r.type) {
    case 'trade':
    case 'dca':
      if ((r.type === 'dca' || r.dca) && r.dcaScheduleId != null) out.push(`schedule #${r.dcaScheduleId}`)
      if (r.dcaError) out.push(`error: ${r.dcaError}`)
      break
    case 'otc':
      if (r.otcOrderId != null) out.push(`order #${r.otcOrderId}`)
      if (r.otcPartial) out.push('partial fill')
      break
    case 'intent':
      out.push(r.intentSeq != null ? `intent #${r.intentSeq}` : r.intentId ? `intent ${r.intentId}` : 'intent')
      // `intentPartial` is a property of the ORDER — partial fills are ALLOWED — and
      // rides along on every event of its life, so a complete `Fill` carries it too.
      // Saying "partial" there would claim this event filled only part of the order;
      // whether it did is `intentAction`, which `activityKind` already spells out
      // ("partially filled" vs "filled").
      if (r.intentPartial) out.push('partial fills allowed')
      break
    case 'xcm': {
      const chain = r.xcmDir === 'in' ? r.fromChain : r.destChain
      out.push(`${r.xcmDir === 'in' ? 'in from' : 'out to'} ${chain ?? 'unknown chain'}`)
      if (r.xcmExecuted === false) out.push('not executed at destination')
      break
    }
    case 'xcswap':
      if (r.xcswapDestChain) out.push(`to ${r.xcswapDestChain}`)
      // The status is the SOLVER's, reported by the off-chain sweep, and it is
      // stored uncoerced. On its own it misreads: the Hydration half has already
      // settled and bridged by the time a row exists, so a bare "PENDING_DEPOSIT"
      // sounds like the caller has not paid when what is pending is the delivery.
      // Name whose half it describes, and keep the upstream token beside it.
      if (r.xcswapStatus) {
        out.push(r.xcswapStatus === 'SUCCESS' || r.xcswapStatus === 'REFUNDED' || r.xcswapStatus === 'FAILED'
          ? `destination ${r.xcswapStatus.toLowerCase()}`
          : `Hydration leg settled, destination not yet delivered (solver status ${r.xcswapStatus})`)
      }
      break
    case 'vote': {
      const ref = r.voteRef != null ? `${r.voteRefPallet ?? 'opengov'} #${r.voteRef}` : 'referendum'
      out.push(`${r.voteSide ?? 'vote'} on ${ref}`)
      if (r.voteConviction && r.voteConviction !== 'None') out.push(r.voteConviction)
      if (r.voteRefTitle) out.push(`"${r.voteRefTitle}"`)
      break
    }
    case 'mm':
      if (r.mmMarket) out.push(r.mmMarket)
      break
    case 'liquidity':
      if (r.poolAddress) out.push(`pool ${shortHash(r.poolAddress)}`)
      else if (r.asset) out.push(`pool ${assetLabel(r.asset)}`)
      if (r.v3TokenId) out.push(`position #${r.v3TokenId}`)
      break
    case 'bond':
      if (r.bondUnderlying) out.push(`underlying ${assetLabel(r.bondUnderlying)}`)
      break
    case 'staking':
    case 'transfer':
      break
  }
  return out
}

/**
 * One row, one line:
 * `3m ago · Swap · 🐕 15YGfc…vu5ue · 1.67k DOT → 166 EURC · $193 · [link]`
 *
 * An unconfirmed row leads with **unconfirmed** and never shows a placeholder
 * block height — a pool transaction's `blockHeight` is `0`, and stating it would
 * read as block zero.
 */
export function activityLine(r: ActivityRow, base: string, now?: Date | number): string {
  const parts: string[] = []
  parts.push(relativeAge(r.timestamp, now))
  const kind = [activityKind(r), ...qualifiers(r)].join(' · ')
  parts.push(isUnconfirmed(r) ? `**unconfirmed** ${kind}` : kind)
  const who = actors(r)
  if (who) parts.push(who)
  const amounts = activityAmounts(r)
  if (amounts) parts.push(amounts)
  if (r.valueUsd != null) parts.push(formatUsd(r.valueUsd))
  const href = activityUrlFor(r, base)
  if (href) parts.push(explorerLink('open', href))
  return parts.join(' · ')
}

/* ============ the detail form ============ */

/** Every revenue stream one row's extrinsic produced. */
function revenueLines(r: ActivityRow): string | null {
  if (!r.revenue) return null
  const streams = r.revenue.streams?.length
    ? r.revenue.streams.map(s => `${s.stream} ${formatUsd(s.usd)}`).join(', ')
    : null
  return kv([
    ['Protocol revenue', formatUsd(r.revenue.protocolUsd)],
    ['LP revenue', formatUsd(r.revenue.lpUsd)],
    ['Streams', streams],
  ])
}

export interface ActivityDetailOptions {
  now?: Date | number
  /**
   * Every classified row the same extrinsic produced, when the caller has them.
   * Without it the revenue line cannot tell the two absences apart — see
   * `revenueSection`.
   */
  extrinsicRows?: readonly ActivityRow[]
}

/** Two rows of the same extrinsic, which is what revenue is attributed across. */
function sameExtrinsic(a: ActivityRow, b: ActivityRow): boolean {
  return a.extrinsicIndex != null
    && a.blockHeight === b.blockHeight
    && a.extrinsicIndex === b.extrinsicIndex
}

/**
 * What an absent `revenue` on this row means — and the two meanings are
 * different claims.
 *
 * The explorer attaches an extrinsic's revenue to exactly ONE of its rows, the
 * earliest (`attachRevenue` in explorerService: a liquidation that seizes
 * collateral AND swaps it would otherwise report the same figure twice). So a
 * sibling row of a multi-row extrinsic legitimately carries none while sitting
 * well inside the booked range. Separately, every row above the revenue
 * watermark carries none because the model trails the head.
 *
 * Given the extrinsic's other rows, the two are distinguishable: if any sibling
 * carries an attribution, the block IS booked and this row simply is not the one
 * it was booked on. Without them, neither claim can be made and the line says so
 * rather than picking the more alarming one.
 */
function revenueSection(r: ActivityRow, opts: ActivityDetailOptions): string {
  const own = revenueLines(r)
  if (own) return `**Revenue**\n${own}`
  const siblings = opts.extrinsicRows
  if (siblings?.length) {
    const owner = siblings.find(other => other !== r && sameExtrinsic(other, r) && other.revenue != null)
    if (owner) {
      const where = owner.eventIndex != null ? ` (event ${owner.eventIndex}, the ${activityKind(owner)} row)` : ''
      return note(`Revenue: booked on ANOTHER row of extrinsic ${r.blockHeight}-${r.extrinsicIndex}${where}, not on this one. The explorer attributes an extrinsic's revenue to a single row — its earliest — so this row carrying none is attribution, not absence, and adding the two would double-count.`)
    }
    return note('Revenue: not booked for this block yet — the revenue model trails the head, and no row of this extrinsic carries an attribution. This is not a claim that the extrinsic earned nothing.')
  }
  return note(`Revenue: not shown. It is either unbooked (the revenue model trails the head) or booked on another row of this extrinsic — the explorer attributes an extrinsic's revenue to exactly one row. This reading did not load the extrinsic's other rows, so it cannot say which.`)
}

/**
 * The multi-line form for a single row. Same facts as `activityLine`, spread out,
 * plus the revenue attribution — see `revenueSection` for why an absent figure
 * is never rendered as "earned nothing".
 */
export function activityDetail(r: ActivityRow, base: string, opts: ActivityDetailOptions = {}): string {
  const now = opts.now
  const href = activityUrlFor(r, base)
  const pool = r.poolAddress
    ? explorerLink(shortHash(r.poolAddress), v3PoolUrl(base, r.poolAddress))
    : r.type === 'liquidity' && r.asset && r.asset.assetId > 0
      ? explorerLink(assetLabel(r.asset), poolUrl(base, r.asset.assetId))
      : null
  const referendum = r.voteRef != null
    ? explorerLink(r.voteRefTitle ?? `${r.voteRefPallet ?? 'opengov'} #${r.voteRef}`, referendumUrl(base, r.voteRefPallet ?? 'opengov', r.voteRef))
    : null
  const head = kv([
    ['Action', [activityKind(r), ...qualifiers(r)].join(' · ')],
    ['Status', isUnconfirmed(r)
      ? (r.mempool ? 'unconfirmed — still in the transaction pool, values are a dry-run projection' : 'unconfirmed — above the finalized head, may reorg away')
      : 'finalized'],
    ['Time', `${formatTime(r.timestamp)} (${relativeAge(r.timestamp, now)})`],
    // A mempool row's height is a 0 placeholder; say the hash instead.
    ['Block', hasRealBlock(r) ? r.blockHeight.toLocaleString('en-US') : null],
    ['Transaction', r.mempool && r.hash ? shortHash(r.hash) : null],
    ['Actor', r.who ? accountLabel(r.who, { withAddress: true }) : null],
    ['Counterparty', r.to ? accountLabel(r.to, { withAddress: true }) : null],
    ['Amounts', activityAmounts(r)],
    ['Value', r.valueUsd != null ? formatUsd(r.valueUsd) : null],
    ['Market', r.mmMarket ?? null],
    ['Pool', pool],
    ['Referendum', referendum],
    ['Schedule', r.dcaScheduleId != null ? explorerLink(`#${r.dcaScheduleId}`, dcaScheduleUrl(base, r.dcaScheduleId)) : null],
    ['Intent', r.intentId ? explorerLink(r.intentSeq != null ? `#${r.intentSeq}` : r.intentId, intentUrl(base, r.intentId)) : null],
    ['Explorer', href],
  ])
  // `settlement` and `purchase` change what the leg COSTS the sender, so they ride
  // with it exactly as they do on the explorer's own page: a destination-settled fee
  // comes out of the bridged amount rather than being paid on top, and a purchased
  // one was bought in the same extrinsic (that swap is folded into this leg and is
  // deliberately not a row of its own, so its amount appears nowhere else).
  const feeLeg = (f: NonNullable<ActivityRow['xcmFees']>[number]): string => {
    const parts = [`${f.kind} fee ${formatAmount(f.amount, f.asset.decimals, assetLabel(f.asset))} (${formatUsd(f.valueUsd)})`]
    if (f.settlement === 'destination') parts.push('deducted from the bridged amount at the destination')
    if (f.purchase) parts.push(`bought with ${formatAmount(f.purchase.amount, f.purchase.asset.decimals, assetLabel(f.purchase.asset))}${f.purchase.valueUsd != null ? ` (${formatUsd(f.purchase.valueUsd)})` : ''}`)
    return parts.join(' — ')
  }
  const fees = r.xcmFees?.length ? bullets(r.xcmFees.map(feeLeg)) : null
  return [
    head,
    fees ? `**Cross-chain costs**\n${fees}` : '',
    revenueSection(r, opts),
  ].filter(Boolean).join('\n\n')
}

/* ============ filter echo ============ */

/** Exactly what a `get_activity` call asked the upstream for. */
export interface ActivityFilters {
  scope?: string
  account?: string | null
  tag?: string | null
  asset?: string | number | null
  block?: number | null
  extrinsic?: string | null
  type?: string | null
  action?: string | null
  token?: string | null
  from?: string | null
  to?: string | null
  minUsd?: number | null
  minRevenueUsd?: number | null
  unit?: string | null
  identity?: string | null
  limit?: number | null
  offset?: number | null
}

/**
 * One line echoing what was ACTUALLY applied.
 *
 * Two things this must never do. It must not echo a filter the upstream
 * ignored: with no `type`, `action` is dropped server-side, and a page of
 * ordinary transfers printed under `action=…` reads as three rows that matched
 * it. And it must not leave `token` unqualified: an unknown token returns an
 * empty page rather than a 400, so an empty result may be the filter rather
 * than the chain.
 */
export function describeActivityFilters(f: ActivityFilters): string {
  const parts: string[] = []
  const scope = f.account ? `account ${f.account}`
    : f.tag ? `tag ${f.tag}`
    : f.asset != null ? `asset ${f.asset}`
    : f.block != null ? `block ${f.block}`
    : f.extrinsic ? `extrinsic ${f.extrinsic}`
    : f.scope ?? 'global'
  parts.push(`scope ${scope}`)
  const typed = f.type != null && f.type !== 'all'
  // The upstream applies `action` only inside a `type`; without one it is not a
  // filter at all, so it is reported as ignored rather than echoed as applied.
  const actionApplied = f.action != null && f.action !== '' && typed
  if (typed) parts.push(`type=${f.type}`)
  if (actionApplied) parts.push(`action=${f.action}`)
  if (f.token) parts.push(`token=${f.token}`)
  if (f.from) parts.push(`from ${f.from}`)
  if (f.to) parts.push(`to ${f.to}`)
  if (f.minUsd != null) parts.push(`min ${f.minUsd} ${f.unit === 'token' ? 'tokens' : 'USD'}`)
  // The argument as given, not on the display scale: this line exists so a
  // caller can match the answer to the call they made.
  if (f.minRevenueUsd != null) parts.push(`min revenue ${f.minRevenueUsd} USD`)
  if (f.identity) parts.push(`identity=${f.identity}`)
  if (f.limit != null) parts.push(`limit ${f.limit}`)
  if (f.offset) parts.push(`offset ${f.offset}`)
  const caveats = [
    f.action && !actionApplied
      ? `\`action=${f.action}\` was NOT APPLIED: the upstream ignores \`action\` unless a \`type\` is set, so the rows below are unfiltered by it. Re-run with a \`type\` to filter on it.`
      : null,
    f.token
      ? 'An unrecognised `token` matches nothing upstream rather than erroring, so an empty result may be the filter rather than the chain.'
      : null,
    // The most dangerous of the three traps, repeated where the rows are, not
    // only in the tool description an agent read once.
    f.type === 'dca'
      ? '`type=dca` selects the whole TRADE family, so ordinary swaps appear beside DCA fills and both render from the same rows — only the lines labelled "DCA execution" (`dca: true`) are DCA — the global feed carries no `dcaScheduleId`, so the flag is the only marker. For DCA fills alone, pass `type=trade, action=dca`.'
      : null,
  ].filter(Boolean)
  return `Filtered: ${parts.join(', ')}.${caveats.length ? ` ${caveats.join(' ')}` : ''}`
}
