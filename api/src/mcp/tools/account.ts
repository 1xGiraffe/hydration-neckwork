import { z } from 'zod'
import { userLine } from '../format/untrusted.ts'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import type {
  AccountRef,
  AccountHistory,
  AccountVolumeHistory,
  AddressBalance,
  AddressDetail,
  ActiveDca,
  AccountsPage,
  AssetRef,
  ExplorerStats,
  LiquidityHistory,
  LiquidityHistoryPosition,
  LiquidityHistorySpan,
  LpPosition,
  MoneyMarketHistory,
  MoneyMarketHistoryMarket,
  MoneyMarketPosition,
  OpenLimitOrder,
  RevenueBreakdown,
  TabCounts,
  TopAccountRow,
  ValueEvent,
} from '../types.ts'
import {
  DASH,
  formatAmount,
  formatBase1e8,
  formatBasisPoints,
  formatCount,
  formatHealthFactor,
  formatNumber,
  formatPercent,
  formatPercentChange,
  formatUsd,
  scaleAmount,
  scaleBase1e8,
  formatUserRevenue,
} from '../format/units.ts'
import { bilWaitText, blocksToDuration, formatDuration, formatTime, relativeAge, type BilWait } from '../format/time.ts'
import {
  accountLabel,
  accountUrl,
  assetLabel,
  assetLabelWithId,
  assetPairLabels,
  blockUrl,
  dcaScheduleUrl,
  explorerLink,
  intentUrl,
  moduleName,
  shortAddress,
  shortHash,
  tagUrl,
} from '../format/refs.ts'
import { bullets, escapeCell, h3, joinBlocks, kv, note, section, table } from '../format/md.ts'
import {
  addressNotFound, compactAsset, failure, fit, HUB_SYMBOL, output, PRICE_BEARING_TTL_MS,
  parseInput, portfolioValue, tagIcon, valueReconciliation,
} from './shared.ts'

/* ============ shared shape ============ */

const addressParam = z.string().min(1).max(128).describe(
  'Any form: SS58 of any prefix, AccountId32 (0x + 64 hex), or H160 (re-anchored to its bound substrate owner).',
)

const settledValue = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null)

/**
 * The EVM address inside a runtime-truncated AccountId32.
 *
 * An H160 with no substrate owner is padded to 32 bytes as
 * `0x45544800` ("ETH\0") + the 20-byte address + 8 zero bytes. Read back, the
 * related-account set names a usable address instead of a public key nobody can
 * act on (AGENTS.md § Explorer semantics: never display raw public-key hex).
 */
function evmFromTruncatedAccountId(accountId: string): string | null {
  if (!/^0x45544800[0-9a-fA-F]{40}0{16}$/.test(accountId)) return null
  return `0x${accountId.slice(10, 50)}`.toLowerCase()
}

/* ---- section 'juicer' ---- */

interface AccountJuicer {
  asOfBlock: number | null
  positions: Array<{
    vault: AccountRef; name: string; shareAsset: AssetRef; collateral: AssetRef; apyPct: number | null; runRateApyPct: number | null
    totalShares: string; totalAssets: string | null; totalUsd: number | null; shares: string; inWithdrawal: string
    withdrawals: Array<{ requestId: number; shares: string; status: string; eligibleAt: string | null; assets: string | null; valueUsd: number | null }>
  }>
}
function juicerBlock(j: AccountJuicer, base: string): string {
  if (j.asOfBlock == null) return note('The Juicer state is unavailable right now (no fresh read); positions are unknown, not empty.')
  if (!j.positions.length) return note(`No Juicer position or open withdrawal request (as of block ${formatCount(j.asOfBlock)}).`)
  return joinBlocks(
    table(['Vault', 'Shares (total)', 'Worth now', 'USD', 'Est. APY · run-rate', 'In withdrawal'], j.positions.map(p => [
      explorerLink(p.name, accountUrl(base, p.vault.address)),
      formatAmount(p.totalShares, p.shareAsset.decimals, assetLabel(p.shareAsset)),
      p.totalAssets == null ? DASH : formatAmount(p.totalAssets, p.collateral.decimals, assetLabel(p.collateral)),
      formatUsd(p.totalUsd),
      `${p.apyPct == null ? DASH : formatPercent(p.apyPct)} · ${p.runRateApyPct == null ? DASH : formatPercent(p.runRateApyPct)}`,
      p.inWithdrawal === '0' ? DASH : formatAmount(p.inWithdrawal, p.shareAsset.decimals, assetLabel(p.shareAsset)),
    ])),
    ...j.positions.filter(p => p.withdrawals.length).map(p => table(['Request', 'Shares', 'State', 'Unwind from', 'Worth'], p.withdrawals.map(w => [
      `#${w.requestId}`, formatAmount(w.shares, p.shareAsset.decimals, assetLabel(p.shareAsset)), w.status,
      w.eligibleAt ? formatTime(w.eligibleAt) : DASH, w.assets == null ? DASH : formatAmount(w.assets, p.collateral.decimals, assetLabel(p.collateral)),
    ]))),
    note(`Read at block ${formatCount(j.asOfBlock)}. Total shares are held shares (funded earnings included) plus those in withdrawal; "worth now" is what they convert to in the vault's collateral today. Est. APY is the official estimate at target leverage, run-rate what the position accrues at the loop's live leverage. Withdrawal requests cannot be cancelled.`),
  )
}

/* ---- section 'bil' ---- */

interface AccountBil {
  asOfBlock: number | null
  complete: boolean
  position: {
    bil: string; ubil: string; queuedShares: string; claimableHollar: string
    totalHollar: string | null; totalUsd: number | null; share: number | null
    bilAsset: AssetRef; ubilAsset: AssetRef; hollarAsset: AssetRef; exchangeRate: string; apyPct: number | null
    requests: Array<{ requestId: number; shares: string; status: string; requestedAt: string; pendingShares: string; claimableHollar: string | null; worthHollar: string | null; wait: BilWait | null; paidFromIdle: boolean }>
  } | null
}
function bilBlock(b: AccountBil): string {
  if (b.asOfBlock == null) return note('The BIL vault state is unavailable right now (no fresh read); the position is unknown, not empty.')
  const p = b.position
  if (!p) return note(`No BIL position or open redemption request (as of block ${formatCount(b.asOfBlock)}).${b.complete ? '' : ' The open redemption requests could not be read, so a queued or claimable part may be missing.'}`)
  const u = (raw: string) => formatAmount(raw, p.ubilAsset.decimals, assetLabel(p.ubilAsset))
  const h = (raw: string | null) => raw == null ? DASH : formatAmount(raw, p.hollarAsset.decimals, assetLabel(p.hollarAsset))
  return joinBlocks(
    kv([
      ['Worth', `${h(p.totalHollar)} · ${formatUsd(p.totalUsd)}`],
      ['Held as BIL', p.bil === '0' ? DASH : formatAmount(p.bil, p.bilAsset.decimals, assetLabel(p.bilAsset))],
      ['Held as uBIL', p.ubil === '0' ? DASH : u(p.ubil)],
      ['Queued for redemption (still accruing)', p.queuedShares === '0' ? DASH : u(p.queuedShares)],
      ['Settled, claimable (fixed HOLLAR)', p.claimableHollar === '0' ? DASH : h(p.claimableHollar)],
      ['Vault share', p.share == null ? null : formatPercent(p.share * 100)],
      ['Stated APY', p.apyPct == null ? null : formatPercent(p.apyPct)],
    ]),
    p.requests.length ? table(['Request', 'uBIL', 'State', 'Worth', 'Paid'], p.requests.map(r => [
      `#${r.requestId}`, u(r.shares), r.status, h(r.worthHollar), r.pendingShares === '0' ? (r.claimableHollar && r.claimableHollar !== '0' ? 'claimable now' : DASH) : bilWaitText(r.wait, r.paidFromIdle),
    ])) : null,
    b.complete ? null : note('The open redemption requests could not be read at this block: a queued or claimable part may be missing above.'),
    note(`Read at block ${formatCount(b.asOfBlock)}. BIL is the BIL money market's aToken over uBIL (1:1); BIL, uBIL and queued uBIL accrue at the vault's NAV (HOLLAR per uBIL), a settled part is a fixed HOLLAR amount until claimed. That value is already in the account's balances — this section restates it, it is not additional.`),
  )
}

/* ---- section 'bonds' ---- */

interface AccountBonds {
  asOfBlock: number | null
  positions: Array<{
    familyTitle: string; round: number; bondId: number; asset: AssetRef; underlying: AssetRef; balance: string; maturityAt: string
    status: string; redeemable: boolean; valueUsd: number | null; faceUsd: number | null; valueFactor: number | null
    bought: { bonds: string; paid: Array<{ asset: AssetRef; raw: string }>; aprPct: number | null; fills: number } | null
  }>
}
function bondsBlock(b: AccountBonds, base: string): string {
  if (b.asOfBlock == null) return note('The bond state is unavailable right now (no fresh read); the account\'s bonds are unknown, not empty.')
  if (!b.positions.length) return note(`No bonds held (as of block ${formatCount(b.asOfBlock)}).`)
  return joinBlocks(
    table(['Bond', 'Held (face)', 'Matures', 'State', 'Worth now', 'Bought in the sale'], b.positions.map(p => [
      `${explorerLink(`${p.familyTitle} round ${p.round}`, `${base.replace(/\/+$/, '')}/asset/${p.bondId}`)}`,
      formatAmount(p.balance, p.asset.decimals, `${userLine(p.underlying.symbol, 32)} face`),
      `${formatTime(p.maturityAt)}${p.redeemable ? ' — redeemable now' : ''}`, p.status,
      `${formatUsd(p.valueUsd)}${p.valueFactor != null && p.valueFactor < 1 ? ` (${p.valueFactor.toFixed(4)} of face ${formatUsd(p.faceUsd)})` : ''}`,
      p.bought ? `${formatAmount(p.bought.bonds, p.asset.decimals, 'bonds')} for ${p.bought.paid.map(x => formatAmount(x.raw, x.asset.decimals, assetLabel(x.asset))).join(' + ')}${p.bought.aprPct != null ? ` at ${formatPercent(p.bought.aprPct)} APR` : ''}` : DASH,
    ])),
    note(`Read at block ${formatCount(b.asOfBlock)}. A bond redeems 1:1 for its underlying from maturity; before it, it is valued at face discounted at its own issue yield. Bonds are wallet balances — already in the account's Value; this section restates them, it is not additional.`),
  )
}

/* ============ get_account ============ */

const ACCOUNT_SECTIONS = ['balances', 'positions', 'moneymarket', 'dca', 'orders', 'related', 'counts', 'revenue', 'juicer', 'bil', 'bonds'] as const
type AccountSection = typeof ACCOUNT_SECTIONS[number]
const DEFAULT_ACCOUNT_SECTIONS: AccountSection[] = ['balances', 'positions', 'moneymarket', 'dca', 'orders', 'related']

/**
 * Which sections the hover-card build (`summary=1`) cannot answer.
 *
 * Measured against the live api rather than taken from the route catalogue:
 * `summary=1` empties `activeDcas` and `openLimitOrders`, nulls `proxy`/
 * `multisig`, and drops each balance's `frozen`/`breakdown`/`timeline` — but it
 * still carries `liquidityPositions` and `moneyMarket` in full. `positions` is
 * listed here anyway: the cheap build is an optimization, and buying it by
 * depending on a field the upstream is free to drop from a summary is not worth
 * a silently empty LP section.
 */
const SECTIONS_NEEDING_FULL_BUILD: ReadonlySet<AccountSection> = new Set<AccountSection>(['balances', 'positions', 'dca', 'orders', 'related'])

const MAX_BALANCE_ROWS = 15
const MAX_LP_ROWS = 12
// The rendered answer groups LP positions by venue and caps each group; the
// structured record has no grouping to spend its budget on, so it takes one
// flat, value-ordered cap. Both are stated in the payload rather than silent.
const MAX_JSON_LP_ROWS = 20
const MAX_DCA_ROWS = 8
const MAX_ORDER_ROWS = 8
const MAX_RESERVE_ROWS = 8
const MAX_RELATED_ROWS = 10
const MAX_REVENUE_STREAMS = 8
const MAX_REVENUE_ASSETS = 4

const accountInputShape = {
  address: addressParam,
  include: z.array(z.enum(ACCOUNT_SECTIONS)).optional().describe(
    `Sections. Default: ${DEFAULT_ACCOUNT_SECTIONS.join(', ')}. 'counts', 'revenue', 'juicer', 'bil', 'bonds' cost one read each and are off by default. 'juicer': vault shares, worth now, open withdrawals (jETH is NOT in Value). 'bil': BIL/uBIL held and queued at NAV, HOLLAR to claim, when the queue pays (in Value). 'bonds': held, maturity, worth (in Value).`,
  ),
  format: formatParam,
}

/** The AccountRef an AddressDetail describes, so the shared label rules apply. */
function detailAsRef(d: AddressDetail): AccountRef {
  return {
    accountId: d.accountId,
    address: d.evmAddress ?? d.ss58Polkadot,
    emoji: d.emoji,
    emojiName: d.emojiName,
    tag: d.tag,
    identity: d.identity,
    profile: d.profile ?? null,
  }
}

/**
 * The heading. `accountLabel` falls back to the shortened address when nothing
 * names the account, so appending the address unconditionally would print it
 * twice; the address is only added when the label is a NAME.
 */
function accountHeading(d: AddressDetail): string {
  const shown = d.evmAddress ?? d.ss58Polkadot
  const label = accountLabel(detailAsRef(d))
  const short = shortAddress(shown)
  return `## ${label.includes(short) ? label : `${label} — ${short}`}`
}

function identityLine(d: AddressDetail): string | null {
  if (!d.identity) return null
  const judged = d.identity.verified ? 'registrar-judged' : 'set but not judged by a registrar'
  // Every identity field is text the account holder typed: one safe line each.
  const extras = [
    d.identity.twitter ? `twitter ${userLine(d.identity.twitter, 64)}` : null,
    d.identity.web ? `web ${userLine(d.identity.web, 96)}` : null,
    d.identity.email ? `email ${userLine(d.identity.email, 96)}` : null,
  ].filter(Boolean).join(' · ')
  return `${userLine(d.identity.display, 64)} (${judged}; user-set text)${extras ? ` — ${extras}` : ''}`
}

function contractBlock(d: AddressDetail): string {
  const c = d.contract as Record<string, unknown> | null | undefined
  if (!c || typeof c !== 'object') return ''
  const verified = c.verification as Record<string, unknown> | null | undefined
  const creation = c.creation as Record<string, unknown> | null | undefined
  const deployer = creation?.deployer as AccountRef | undefined
  return joinBlocks(h3('Contract'), kv([
    ['Name', typeof verified?.name === 'string' ? verified.name : null],
    ['Verification', typeof verified?.status === 'string' ? `${verified.status}${typeof verified.compilerVersion === 'string' ? ` · ${verified.compilerVersion}` : ''}${typeof verified.matchType === 'string' ? ` · ${verified.matchType}` : ''}` : 'unverified'],
    ['Code size', typeof c.codeSize === 'number' ? `${formatCount(c.codeSize)} bytes` : null],
    ['Transactions', typeof c.txCount === 'number' ? formatCount(c.txCount) : null],
    ['Logs', typeof c.logCount === 'number' ? formatCount(c.logCount) : null],
    ['Deployed by', deployer ? accountLabel(deployer, { withAddress: true }) : null],
    ['Deployed at', typeof creation?.timestamp === 'string' ? `${formatTime(creation.timestamp)}${typeof creation.blockHeight === 'number' ? ` (block ${formatCount(creation.blockHeight)})` : ''}` : null],
    ['Destroyed', c.destroyed === true ? 'yes — this contract has been self-destructed' : null],
  ]))
}

function identityBlock(d: AddressDetail, base: string): string {
  const pallet = moduleName(d.accountId)
  const emoji = d.emoji ? `${d.emoji}${d.emojiName ? ` (${d.emojiName})` : ''}` : null
  return kv([
    ['Kind', d.kind === 'evm' ? 'EVM account (H160)' : 'substrate account'],
    ['Hydration SS58 (prefix 63)', d.ss58],
    ['Polkadot SS58 (prefix 0)', d.ss58Polkadot],
    ['EVM address', d.evmAddress],
    // Not an address — it is the public key every form above encodes. Labelled
    // as such so it is never copied into a wallet or a transfer call.
    ['AccountId32 (public key, not an address)', d.accountId],
    ['Queried as', d.input !== d.ss58 && d.input !== d.ss58Polkadot && d.input !== d.evmAddress ? d.input : null],
    ['Pallet account', pallet ? `${pallet} — a runtime-owned pot, not a user wallet` : null],
    ['Emoji', emoji],
    ['System tag', d.tag ? `${tagIcon(d.tag.icon)}${userLine(d.tag.name, 64)}` : null],
    ['On-chain identity', identityLine(d)],
    ['Profile name', d.profile?.name ? `${userLine(d.profile.name, 64)} (self-set, not on-chain)` : null],
    ['Explorer', accountUrl(base, d.evmAddress ?? d.ss58Polkadot)],
  ])
}

/**
 * What the account is worth, in the order the question is usually asked.
 *
 * **Value** leads because it is the figure the Explorer account page prints and
 * the figure `get_account_history`'s series ends on. **Holdings** is the gross
 * upstream `portfolioUsd` and is stated beside it rather than instead of it —
 * the two differ by the money-market debt, which for a leveraged account is
 * most of the balance sheet. The top-holding shares are of holdings, because
 * that is the total they are parts of.
 */
function portfolioBlock(d: AddressDetail, value: ReturnType<typeof portfolioValue>): string {
  const top = (d.topAssets ?? []).map(t => `${assetLabel(t.asset)} ${formatUsd(t.valueUsd)}${value.holdingsUsd > 0 ? ` (${formatPercent((t.valueUsd / value.holdingsUsd) * 100, 1)})` : ''}`)
  const hasDebt = value.moneyMarketDebtUsd > 0
  const rewards = farmRewardsLine(d)
  const incentives = moneyMarketRewardsLine(d)
  const programme = rewardsProgramLine(d)
  return kv([
    ['Value', `${formatUsd(value.valueUsd)}${hasDebt ? ' — holdings minus money-market debt, the figure the Explorer account page shows' : ''}`],
    ['Holdings (gross: balances + LP positions + claimable farm rewards and lending incentives)', formatUsd(value.holdingsUsd)],
    ['Unclaimed farm rewards (inside holdings)', rewards],
    ['Unclaimed lending incentives (inside holdings)', incentives],
    ['PRIME rewards programme (earned, not claimable yet — in no total)', programme],
    ['Money-market debt (netted out above)', hasDebt ? formatUsd(value.moneyMarketDebtUsd) : null],
    ['Holdings excluding HDX', d.portfolioExHdxUsd != null ? formatUsd(d.portfolioExHdxUsd) : null],
    ['Value excluding HDX', d.portfolioExHdxUsd != null && hasDebt ? formatUsd(d.portfolioExHdxUsd - value.moneyMarketDebtUsd) : null],
    ['Top holdings (share of holdings)', top.length ? top.join(' · ') : null],
    ['Trading volume (lifetime)', d.tradingVolumeUsd != null ? formatUsd(d.tradingVolumeUsd) : null],
    ['Liquidation volume', d.liquidationVolumeUsd ? formatUsd(d.liquidationVolumeUsd) : null],
    ['Protocol Revenue', d.revenueUsd != null ? formatUsd(d.revenueUsd) : null],
    ['User Revenue (net)', formatUserRevenue(d.userRevenueUsd, d.holderClass)],
  ])
}

/**
 * The account's claimable farm rewards, as the upstream counts them inside
 * `portfolioUsd`: priced entries only, with the unpriced ones named rather
 * than folded in at zero. Null when there is none (or no fresh snapshot).
 */
function farmRewardsLine(d: AddressDetail): string | null {
  const fr = d.farmRewards
  if (!fr) return null
  const unpriced = farmRewardsUnpriced(d)
  const unpayable = fr.items.filter(i => i.claimable !== '0' && i.payable === false).length
  if (fr.totalUsd <= 0 && unpriced === 0 && unpayable === 0) return null
  return `${formatUsd(fr.totalUsd)}${unpriced ? ` plus ${unpriced} entr${unpriced === 1 ? 'y' : 'ies'} the index cannot price (not counted)` : ''} — what claiming every farm entry now would pay (loyalty applied, already-claimed subtracted), as of block ${formatCount(fr.asOfBlock)}${unpayable ? `; ${unpayable} entr${unpayable === 1 ? 'y is' : 'ies are'} below the reward asset's existential deposit while the account holds less than it, so the runtime would pay ${unpayable === 1 ? 'it' : 'them'} to the treasury — not counted` : ''}`
}

/** Farm entries with something claimable that the index cannot price (outside every total). */
const farmRewardsUnpriced = (d: AddressDetail): number =>
  (d.farmRewards?.items ?? []).filter(i => i.claimable !== '0' && i.claimableUsd == null).length

/** Money-market incentives with something claimable that the index cannot price (outside every total). */
const moneyMarketRewardsUnpriced = (d: AddressDetail): number =>
  (d.moneyMarketRewards?.items ?? []).filter(i => i.claimable !== '0' && i.claimableUsd == null).length

/**
 * The account's claimable money-market incentives, as the upstream counts them
 * inside `portfolioUsd`: the chain's own getAllUserRewards, and for the main
 * market's off-chain PRIME programme the rewards distributor's live-root amount
 * less what it has paid; priced items only, unpriced ones named. Null when there
 * is none (or no fresh snapshot).
 */
function moneyMarketRewardsLine(d: AddressDetail): string | null {
  const mr = d.moneyMarketRewards
  if (!mr) return null
  const unpriced = moneyMarketRewardsUnpriced(d)
  const dust = mr.items.filter(i => i.belowExistentialDeposit).length
  if (mr.totalUsd <= 0 && unpriced === 0) return null
  return `${formatUsd(mr.totalUsd)}${unpriced ? ` plus ${unpriced} reward${unpriced === 1 ? '' : 's'} the index cannot price (not counted)` : ''} — what claiming would pay now (the chain's own RewardsController.getAllUserRewards${mr.items.some(i => i.source === 'distributor') ? ', and the PRIME programme\'s rewards distributor: its live root\'s cumulative amount less what it has paid' : ''}), as of block ${formatCount(mr.asOfBlock)}${dust ? `; ${dust} amount${dust === 1 ? ' is' : 's are'} below the reward asset's existential deposit, so a claim including ${dust === 1 ? 'it' : 'them'} reverts until the account holds that deposit — owed, not forfeited, and counted` : ''}`
}

/** One market's claimable incentives as a short line; null when it has none. */
function marketRewardsLine(p: MoneyMarketPosition): string | null {
  const items = (p.unclaimedRewards ?? []).filter(i => i.claimable !== '0')
  if (!items.length) return null
  return items.map(i => `${formatAmount(i.claimable, i.asset.decimals, i.asset.symbol)}${i.claimableUsd != null ? ` (${formatUsd(i.claimableUsd)})` : ' (unpriced)'}${i.source === 'distributor' ? ' from the PRIME programme\'s rewards distributor' : ''}${i.belowExistentialDeposit ? ' — below the existential deposit' : ''}`).join(' · ')
}

const PROGRAMME_STAGE: Record<'pending' | 'closed' | 'accruing', string> = {
  pending: 'under a root in its timelock',
  closed: 'under the closed epoch\'s root, not yet submitted',
  accruing: 'estimated for the open epoch',
}

/**
 * The off-chain PRIME programme (main market, HUSDC/HUSDT suppliers): each EVM
 * holder's eligibility and what it has earned that is NOT claimable yet. Never in
 * a total — a stage becomes claimable (and part of the value) once its root is
 * accepted on the distributor. Null when the upstream states nothing.
 */
function rewardsProgramLine(d: AddressDetail): string | null {
  const rp = d.rewardsProgram
  if (!rp?.accounts.length) return null
  const sym = rp.rewardAsset.symbol
  const parts = rp.accounts.map(a => {
    const why = a.reason === 'hollar_debt'
      ? ` (HOLLAR debt ${a.hollarDebtUsd != null ? `$${a.hollarDebtUsd}` : DASH} above the $${rp.maxHollarDebtUsd} limit)`
      : a.reason ? ` (${a.reason})` : ''
    const status = a.status === 'earning' ? 'earning' : a.status === 'not-earning' ? `NOT earning${why}` : 'not in the programme\'s snapshot'
    const stages = a.stages.map(st => `${formatAmount(st.amount, rp.rewardAsset.decimals, sym)}${st.amountUsd != null ? ` (${formatUsd(st.amountUsd)})` : ''} ${PROGRAMME_STAGE[st.stage]}${st.claimableAt ? `, claimable from ${st.claimableAt}` : ''}`)
    return `${a.holder}: ${status}${stages.length ? ` — ${stages.join('; ')}` : ''}`
  })
  return `${parts.join(' · ')} — "${rp.name}", paid by the rewards distributor ${rp.distributor} in daily epochs${rp.endsAt ? `, ends ${rp.endsAt}` : ''}; snapshot of ${rp.asOf}`
}

const balanceValue = (b: AddressBalance): number => b.valueUsd ?? -1

function balancesBlock(d: AddressDetail, summarized: boolean): string {
  const rows = [...(d.balances ?? [])].sort((a, b) => balanceValue(b) - balanceValue(a))
  const shown = rows.slice(0, MAX_BALANCE_ROWS)
  const anyLocked = rows.some(b => b.frozen != null && b.frozen !== '0')
  const anyReserved = rows.some(b => b.reserved && b.reserved !== '0')
  const headers = ['Asset', 'Balance', 'USD', ...(anyLocked ? ['Locked'] : []), ...(anyReserved ? ['Reserved'] : []), 'As of block']
  const body = shown.map(b => [
    assetLabelWithId(b.asset),
    formatAmount(b.total, b.asset.decimals),
    b.valueUsd == null ? DASH : formatUsd(b.valueUsd),
    ...(anyLocked ? [b.frozen == null ? DASH : formatAmount(b.frozen, b.asset.decimals)] : []),
    ...(anyReserved ? [formatAmount(b.reserved, b.asset.decimals)] : []),
    b.lastBlock ? formatCount(b.lastBlock) : DASH,
  ])
  const tail = rows.slice(MAX_BALANCE_ROWS)
  const tailUsd = tail.reduce((sum, b) => sum + (b.valueUsd ?? 0), 0)
  // An unpriced holding is not a worthless one. Summing `valueUsd ?? 0` and
  // calling the result what the tail is "worth" would state that a token the
  // index cannot price is worth nothing, which for a pallet pot's long tail of
  // unpriced assets is most of the line. The unpriced rows are counted out of
  // the total instead of folded into it at zero.
  const tailUnpriced = tail.filter(b => b.valueUsd == null).length
  const tailWorth = tailUnpriced === tail.length
    ? 'none of them priced by the index'
    : `worth ${formatUsd(tailUsd)} in total${tailUnpriced ? `, plus ${tailUnpriced} the index cannot price` : ''}`
  // A balance the explorer shows but values at nothing (the Omnipool's own H2O
  // reserve): its USD cell is the counted part, so the amount left out is named
  // here rather than left to read as a worthless holding.
  const uncounted = rows.filter(b => b.uncounted)
  return joinBlocks(
    table(headers, body, 'this account holds no balance the index has seen'),
    uncounted.length ? note(`${uncounted.map(b => formatAmount(b.uncounted!.amount, b.asset.decimals, assetLabel(b.asset))).join(', ')} ${uncounted.length === 1 ? 'is' : 'are'} the pool's own hub reserve — H2O is priced off the assets the pool holds, which the value already counts — so it is shown as a balance and counted in no value.`) : '',
    tail.length ? note(`${tail.length} smaller holding${tail.length === 1 ? '' : 's'} not shown, ${tailWorth}: ${tail.slice(0, 12).map(b => assetLabel(b.asset)).join(', ')}${tail.length > 12 ? ' and more' : ''}.`) : '',
    summarized ? note('Locks and reserves are not in this reading: it used the cheap summary build. Ask for `include: ["balances"]` to get the lock snapshot.') : '',
  )
}

function positionsBlock(positions: LpPosition[]): string {
  if (!positions.length) return table(['Venue', 'Position'], [], 'this account holds no liquidity position')
  const byVenue = new Map<string, LpPosition[]>()
  for (const p of positions) {
    const list = byVenue.get(p.venue) ?? []
    list.push(p)
    byVenue.set(p.venue, list)
  }
  const blocks: string[] = []
  let anyRewards = false
  for (const [venue, list] of [...byVenue.entries()].sort((a, b) => sumUsd(b[1]) - sumUsd(a[1]))) {
    const sorted = [...list].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    const shown = sorted.slice(0, MAX_LP_ROWS)
    const withRewards = shown.some(p => (p.unclaimedRewards ?? []).some(r => r.amount !== '0'))
    anyRewards ||= withRewards
    const rows = shown.map(p => [
      p.assetB ? `${assetLabel(p.asset)} / ${assetLabel(p.assetB)}` : assetLabelWithId(p.asset),
      p.assetB && p.amountB != null
        ? `${formatAmount(p.amount, p.asset.decimals, p.asset.symbol)} + ${formatAmount(p.amountB, p.assetB.decimals, p.assetB.symbol)}`
        : formatAmount(p.amount, p.asset.decimals, p.asset.symbol),
      p.valueUsd == null ? DASH : formatUsd(p.valueUsd),
      ...(withRewards ? [unclaimedRewardsCell(p.unclaimedRewards ?? [])] : []),
      p.positionId,
    ])
    blocks.push(joinBlocks(
      `**${escapeCell(venue)}** — ${list.length} position${list.length === 1 ? '' : 's'}, ${formatUsd(sumUsd(list))}`,
      table(['Asset(s)', 'Amount', 'USD', ...(withRewards ? ['Unclaimed rewards'] : []), 'Position'], rows),
      sorted.length > shown.length ? note(`${sorted.length - shown.length} smaller ${venue} position(s) not shown.`) : '',
    ))
  }
  if (anyRewards) blocks.push(note('`USD` is the position\'s principal. `Unclaimed rewards` are what claiming its farm entries now would pay — a separate claim in the reward asset, beside the position rather than in it, and counted in the account\'s Holdings and Value above.'))
  return blocks.join('\n\n')
}

/** A farmed row's claimable rewards: the priced sum, else the amounts. */
function unclaimedRewardsCell(rewards: NonNullable<LpPosition['unclaimedRewards']>): string {
  const live = rewards.filter(r => r.amount !== '0')
  if (!live.length) return DASH
  const priced = live.filter(r => r.valueUsd != null)
  const unpriced = live.filter(r => r.valueUsd == null)
  return [
    priced.length ? formatUsd(priced.reduce((s, r) => s + (r.valueUsd ?? 0), 0)) : '',
    ...unpriced.map(r => formatAmount(r.amount, r.asset.decimals, r.asset.symbol) + ' (unpriced)'),
  ].filter(Boolean).join(' + ')
}

const sumUsd = (list: { valueUsd: number | null }[]): number => list.reduce((s, p) => s + (p.valueUsd ?? 0), 0)

/**
 * One isolated market's position. The markets never blend: a health factor
 * belongs to exactly one of them (AGENTS.md § Explorer semantics), so each is
 * rendered under its own heading with its own figures and no total is taken
 * across them.
 */
/**
 * The market whose health factor IS the account's risk.
 *
 * With several isolated markets in the answer, the one number that describes the
 * account is the LOWEST real health factor, named with the market it came from
 * (AGENTS.md § Explorer semantics — the same rule the tag surface follows).
 * Leaving the comparison to the reader is how an agent ends up averaging three
 * figures or quoting whichever market it read last. `'inf'` (no debt) and
 * `'unknown'` are not ratios and take no part in the comparison; a real 0 does.
 */
function lowestRealHealthFactor(positions: MoneyMarketPosition[]): MoneyMarketPosition | null {
  let best: { p: MoneyMarketPosition; hf: number } | null = null
  for (const p of positions) {
    if (!/^\d+$/.test(String(p.healthFactor ?? ''))) continue
    const hf = Number(p.healthFactor) / 1e18
    if (!Number.isFinite(hf)) continue
    if (best == null || hf < best.hf) best = { p, hf }
  }
  return best?.p ?? null
}

function riskLine(positions: MoneyMarketPosition[]): string {
  const riskiest = lowestRealHealthFactor(positions)
  if (!riskiest) return note(`No market in this answer carries a real health factor: ${positions.map(p => `${p.market} is ${formatHealthFactor(p.healthFactor)}`).join(', ')}. The account has no measurable liquidation risk here.`)
  const others = positions.filter(p => p !== riskiest)
  return note(`**This account's risk is ${formatHealthFactor(riskiest.healthFactor)}, in ${riskiest.market} (\`${riskiest.marketKey}\`)** — the lowest real health factor among its markets, and the one that liquidates first. It is that market's figure alone: ${others.map(p => `${p.market} stands at ${formatHealthFactor(p.healthFactor)}`).join(', ')}, and nothing in one market cures a shortfall in another.`)
}

function moneyMarketBlock(positions: MoneyMarketPosition[], base: string, now: Date): string {
  if (!positions.length) return note('This account has no money-market position in any market.')
  const blocks = positions.map(p => {
    const reserves = [...(p.reserves ?? [])].sort((a, b) => ((b.suppliedUsd ?? 0) + (b.debtUsd ?? 0)) - ((a.suppliedUsd ?? 0) + (a.debtUsd ?? 0)))
    const shown = reserves.slice(0, MAX_RESERVE_ROWS)
    return joinBlocks(
      h3(`${p.market} (${p.marketKey}, ${p.role} market) — health factor ${formatHealthFactor(p.healthFactor)}`),
      kv([
        ['Collateral', formatBase1e8(p.totalCollateralBase)],
        ['Supplied', p.totalSuppliedBase == null ? null : formatBase1e8(p.totalSuppliedBase)],
        ['Debt', formatBase1e8(p.totalDebtBase)],
        ['Available to borrow', formatBase1e8(p.availableBorrowsBase)],
        ['Max LTV', formatBasisPoints(p.ltv)],
        ['Liquidation threshold', formatBasisPoints(p.liquidationThreshold)],
        ['Staking-backed collateral', p.stakingBacked ? 'yes' : null],
        ['Collateral not stated per reserve', p.unstatedCollateral?.length ? `${p.unstatedCollateral.map(a => userLine(a.symbol, 32)).join(', ')} — the market's own collateral figure stands in for it` : null],
        ['Unclaimed incentives (in the account value, not in this market\'s collateral)', marketRewardsLine(p)],
        ['Priced at', `block ${explorerLink(formatCount(p.blockHeight), blockUrl(base, p.blockHeight))} · ${formatTime(p.timestamp)} (${relativeAge(p.timestamp, now)})`],
      ]),
      table(
        ['Reserve', 'Supplied', 'Supplied USD', 'Debt', 'Debt USD', 'Collateral'],
        shown.map(r => [
          `${userLine(r.symbol, 32)} (#${r.assetId})`,
          r.supplied === '0' ? '0' : formatAmount(r.supplied, r.decimals),
          r.suppliedUsd ? formatUsd(r.suppliedUsd) : DASH,
          r.debt === '0' ? '0' : formatAmount(r.debt, r.decimals),
          r.debtUsd ? formatUsd(r.debtUsd) : DASH,
          r.collateral ? 'yes' : 'no',
        ]),
      ),
      reserves.length > shown.length ? note(`${reserves.length - shown.length} further reserve(s) not shown.`) : '',
    )
  })
  const isolation = positions.length > 1
    ? joinBlocks(
      riskLine(positions),
      note('These markets are ISOLATED. Each health factor, collateral figure and threshold applies only to its own market — never average them, never add the collateral, and never read one market\'s health factor as the account\'s risk. A liquidation in one market does not touch the other.'),
    )
    : note('Health factors are per market. Hydration runs several isolated money markets — the primary market, GIGAHDX and BIL today, and the set grows — so this figure is this market\'s alone and says nothing about a position in any other.')
  return joinBlocks(...blocks, isolation)
}

/**
 * Active DCA schedules.
 *
 * `nominalBlockSec` comes from `/explorer/stats` and is not optional: a
 * schedule's `period` is a BLOCK COUNT defined at the runtime's nominal slot
 * time, so converting it with a literal would restate a protocol parameter as
 * something the chain never promised the moment the cadence changes. When the
 * stats read failed there is no honest conversion, and the block count is shown
 * as a block count instead of being turned into a wrong duration.
 */
function dcaBlock(dcas: ActiveDca[], base: string, nominalBlockSec: number | null): string {
  if (!dcas.length) return table(['Schedule', 'Sell', 'Buy'], [], 'this account has no active DCA schedule')
  const shown = [...dcas].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, MAX_DCA_ROWS)
  const rows = shown.map(d => {
    const label = d.intentId ? `#${d.id} (intent)` : String(d.id)
    const href = d.intentId ? intentUrl(base, d.intentId) : dcaScheduleUrl(base, d.id)
    const period = d.periodSeconds != null
      ? formatDuration(d.periodSeconds)
      : nominalBlockSec != null
        ? blocksToDuration(d.period, nominalBlockSec)
        : `${formatCount(d.period)} blocks`
    return [
      explorerLink(label, href),
      `${d.direction} ${assetLabel(d.assetIn)} → ${assetLabel(d.assetOut)}`,
      formatAmount(d.amountPerTrade, d.assetIn.decimals, d.assetIn.symbol),
      period,
      `${formatNumber(d.executionsDone)}`,
      formatAmount(d.filledAmount, d.assetIn.decimals, d.assetIn.symbol),
      d.remainingAmount == null ? openEndedRemaining(d) : formatAmount(d.remainingAmount, d.assetIn.decimals, d.assetIn.symbol),
      d.nextExecutionBlock == null ? DASH : formatCount(d.nextExecutionBlock),
      d.valueUsd == null ? DASH : formatUsd(d.valueUsd),
    ]
  })
  return joinBlocks(
    table(['Schedule', 'Trade', 'Per trade', 'Period', 'Fills', 'Filled', 'Remaining', 'Next block', 'USD/trade'], rows),
    dcas.length > shown.length ? note(`${dcas.length - shown.length} further schedule(s) not shown.`) : '',
    note(`\`Period\` is the observed spacing between fills where two fills exist, otherwise the scheduled block period converted at ${nominalBlockSec != null ? `this runtime's nominal ${nominalBlockSec}s slot time` : 'the nominal slot time — which could not be read, so those rows show the raw block count instead'}. \`Remaining\` for a schedule with no total budget is its projected share of the owner's balance of the sold asset: open-ended schedules selling one asset from one wallet spend it together and run out together, so each states its slice, never the whole balance.`),
  )
}

// An open-ended schedule's remaining: its slice of the wallet it shares, and when
// that wallet runs dry at the combined rate of every order spending it.
function openEndedRemaining(d: ActiveDca): string {
  const amount = d.fundingShare ?? d.fundingBalance
  if (amount == null) return 'open-ended'
  const pool = d.fundingPool
  const shared = pool && pool.orders > 1 ? `, shared by ${pool.orders} orders` : ''
  const end = pool?.runsOutSeconds != null ? `, ~${formatDuration(pool.runsOutSeconds)} left` : ''
  return `open-ended · ~${formatAmount(amount, d.assetIn.decimals, d.assetIn.symbol)}${shared}${end}`
}

function ordersBlock(orders: OpenLimitOrder[], base: string): string {
  if (!orders.length) return table(['Order', 'Sell', 'Buy'], [], 'this account has no open limit order')
  const shown = [...orders].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, MAX_ORDER_ROWS)
  const rows = shown.map(o => [
    explorerLink(`#${o.seq}`, intentUrl(base, o.intentId)),
    `${formatAmount(o.remainingIn, o.assetIn.decimals, o.assetIn.symbol)} → ${formatAmount(o.remainingOut, o.assetOut.decimals, o.assetOut.symbol)}`,
    o.limitPrice == null ? DASH : `${formatNumber(o.limitPrice)} ${userLine(o.assetOut.symbol, 32)}/${userLine(o.assetIn.symbol, 32)}`,
    o.valueUsd == null ? DASH : formatUsd(o.valueUsd),
    o.fills > 0 ? `${formatNumber(o.fills)}${o.partial ? ' (partial)' : ''}` : 'none',
    formatTime(o.timestamp),
    o.deadline ? formatTime(o.deadline) : 'none',
  ])
  return joinBlocks(
    table(['Order', 'Remaining', 'Limit price', 'USD', 'Fills', 'Placed', 'Deadline'], rows),
    orders.length > shown.length ? note(`${orders.length - shown.length} further open order(s) not shown.`) : '',
  )
}

function relationshipsBlock(d: AddressDetail, base: string, summarized: boolean): string {
  const evmByAccountId = new Map<string, string>()
  for (const alias of d.aliases ?? []) {
    if (alias.accountId && alias.evmAddress) evmByAccountId.set(alias.accountId, alias.evmAddress)
  }
  const relationshipOf = new Map<string, string>()
  for (const alias of d.aliases ?? []) {
    if (alias.accountId && !relationshipOf.has(alias.accountId)) relationshipOf.set(alias.accountId, `${alias.relationship} (confidence ${alias.confidence})`)
  }
  const related = (d.relatedAccountIds ?? []).slice(0, MAX_RELATED_ROWS).map(id => {
    if (id === d.accountId) {
      const self = d.evmAddress ?? d.ss58Polkadot
      // Same rule as `accountHeading`: `accountLabel` already falls back to the
      // shortened address, so appending it unconditionally prints it twice.
      const label = accountLabel(detailAsRef(d))
      const short = shortAddress(self)
      return `${explorerLink(label.includes(short) ? label : `${label} — ${short}`, accountUrl(base, self))} · the queried account`
    }
    const evm = evmByAccountId.get(id) ?? evmFromTruncatedAccountId(id)
    const how = relationshipOf.get(id)
    // A truncated `0x45544800…` id IS an EVM account; show the H160 rather than
    // the public key, which is not an address anyone can use. The explorer's
    // address route resolves either form, so the link works for both.
    const shown = evm ? `${evm} (EVM)` : accountLabel(id)
    // An entry with no alias row was DERIVED from this account's public key by
    // the runtime's address rules, not observed acting together with it. Every
    // real binding upstream carries a relationship and a confidence, so a row
    // without one must not borrow their authority.
    const provenance = how ?? 'derived from this account\'s public key by the runtime address rules — no binding has been observed on chain'
    return `${explorerLink(shown, accountUrl(base, evm ?? id))} — ${provenance}`
  })
  const proxy = d.proxy
  const proxyLines = proxy
    ? [
      proxy.isPure ? `Pure proxy created by ${accountLabel(proxy.isPure.creator, { withAddress: true })} (${proxy.isPure.proxyType}) at block ${formatCount(proxy.isPure.blockHeight)}` : null,
      ...(proxy.delegates ?? []).slice(0, 6).map(p => `Delegates ${p.proxyType} to ${accountLabel(p.account, { withAddress: true })}${p.delay ? ` (delay ${formatNumber(p.delay)} blocks)` : ''}`),
      ...(proxy.delegatorOf ?? []).slice(0, 6).map(p => `Acts as ${p.proxyType} proxy FOR ${accountLabel(p.account, { withAddress: true })}${p.delay ? ` (delay ${formatNumber(p.delay)} blocks)` : ''}`),
    ].filter(Boolean) as string[]
    : []
  const ms = d.multisig
  const msLines = ms
    ? [
      `Multisig ${ms.threshold}-of-${ms.signatories.length}: ${ms.signatories.map(s => accountLabel(s)).join(', ')}`,
      ...(ms.pending ?? []).slice(0, 4).map(p => `Pending call ${shortHash(p.callHash)} since block ${formatCount(p.sinceBlock)}, ${p.approvals.length}/${ms.threshold} approvals (depositor ${accountLabel(p.depositor)})`),
    ]
    : []
  const memberships = (d.multisigMemberships ?? []).slice(0, 6).map(m => `Signatory of ${accountLabel(m.account, { withAddress: true })} (${m.threshold}-of-${m.signatories})`)

  return joinBlocks(
    bullets(related),
    (d.relatedAccountIds?.length ?? 0) > MAX_RELATED_ROWS ? note(`${(d.relatedAccountIds?.length ?? 0) - MAX_RELATED_ROWS} further related account(s) not shown.`) : '',
    proxyLines.length || msLines.length || memberships.length ? joinBlocks(h3('Proxy and multisig'), bullets([...proxyLines, ...msLines, ...memberships])) : '',
    summarized ? note('Proxy and multisig relationships are not in this reading: they are live node reads the cheap summary build skips. Ask for `include: ["related"]` to get them.') : '',
    note(scopeSentence(d)),
  )
}

/* ---- the structured record ----
 *
 * `format: "json"` is answered with the INTERPRETED record, not an echo of the
 * upstream body: amounts arrive scaled out of their raw units, USD arrives as
 * USD rather than 1e8 fixed point, and nested asset refs collapse to
 * `{assetId, symbol, decimals}`. That is the product (spec § 1) and it also
 * keeps the reply inside the text budget — the raw echo of a large account
 * exceeds it on its own, and a truncated JSON document parses as nothing.
 */

function compactBalance(b: AddressBalance) {
  return {
    asset: compactAsset(b.asset),
    total: scaleAmount(b.total, b.asset.decimals),
    free: scaleAmount(b.free, b.asset.decimals),
    reserved: scaleAmount(b.reserved, b.asset.decimals),
    locked: b.frozen == null ? null : scaleAmount(b.frozen, b.asset.decimals),
    totalRaw: b.total,
    valueUsd: b.valueUsd,
    lastBlock: b.lastBlock || null,
  }
}

function compactLp(p: LpPosition) {
  return {
    positionId: p.positionId,
    venue: p.venue,
    asset: compactAsset(p.asset),
    amount: scaleAmount(p.amount, p.asset.decimals),
    assetB: p.assetB ? compactAsset(p.assetB) : null,
    amountB: p.assetB && p.amountB != null ? scaleAmount(p.amountB, p.assetB.decimals) : null,
    valueUsd: p.valueUsd,
    ...(p.unclaimedRewards?.length ? {
      unclaimedRewards: p.unclaimedRewards.map(r => ({
        asset: compactAsset(r.asset), amount: scaleAmount(r.amount, r.asset.decimals), valueUsd: r.valueUsd, projected: r.projected,
        ...(r.belowExistentialDeposit ? { belowExistentialDeposit: true } : {}),
        ...(r.payable === false ? { payable: false } : {}),
      })),
    } : {}),
  }
}

/** One isolated market, with its `*Base` fixed point resolved into USD. */
function compactMarket(p: MoneyMarketPosition, maxReserves: number) {
  const reserves = [...(p.reserves ?? [])].sort((a, b) => ((b.suppliedUsd ?? 0) + (b.debtUsd ?? 0)) - ((a.suppliedUsd ?? 0) + (a.debtUsd ?? 0)))
  return {
    marketKey: p.marketKey,
    market: p.market,
    role: p.role,
    // The 1e18 string is kept beside the ratio: 'inf' (no debt) and 'unknown'
    // are real values in this encoding and a number cannot carry them.
    healthFactor: p.healthFactor,
    healthFactorRatio: /^\d+$/.test(p.healthFactor) ? scaleAmount(p.healthFactor, 18) : null,
    collateralUsd: scaleBase1e8(p.totalCollateralBase),
    suppliedUsd: p.totalSuppliedBase != null ? scaleBase1e8(p.totalSuppliedBase) : null,
    debtUsd: scaleBase1e8(p.totalDebtBase),
    availableBorrowsUsd: scaleBase1e8(p.availableBorrowsBase),
    ltvPct: Number(p.ltv) / 100,
    liquidationThresholdPct: Number(p.liquidationThreshold) / 100,
    stakingBacked: p.stakingBacked ?? null,
    blockHeight: p.blockHeight,
    timestamp: p.timestamp,
    reserves: reserves.slice(0, maxReserves).map(r => ({
      assetId: r.assetId,
      symbol: r.symbol,
      decimals: r.decimals,
      supplied: scaleAmount(r.supplied, r.decimals),
      debt: scaleAmount(r.debt, r.decimals),
      suppliedUsd: r.suppliedUsd,
      debtUsd: r.debtUsd,
      collateral: r.collateral,
    })),
    reservesOmitted: Math.max(0, reserves.length - maxReserves),
  }
}

function compactDca(d: ActiveDca, nominalBlockSec: number | null) {
  return {
    id: d.id,
    intentId: d.intentId ?? null,
    direction: d.direction,
    assetIn: compactAsset(d.assetIn),
    assetOut: compactAsset(d.assetOut),
    amountPerTrade: scaleAmount(d.amountPerTrade, d.assetIn.decimals),
    filled: scaleAmount(d.filledAmount, d.assetIn.decimals),
    remaining: d.remainingAmount == null ? null : scaleAmount(d.remainingAmount, d.assetIn.decimals),
    // Open-ended only: its projected slice of the shared wallet, and the pool.
    fundingShare: d.fundingShare != null ? scaleAmount(d.fundingShare, d.assetIn.decimals) : null,
    fundingPool: d.fundingPool ? {
      balance: scaleAmount(d.fundingPool.balance, d.assetIn.decimals),
      orders: d.fundingPool.orders,
      perDayUsd: d.fundingPool.perDayUsd,
      runsOutSeconds: d.fundingPool.runsOutSeconds,
    } : null,
    executionsDone: d.executionsDone,
    // Null rather than a guess: the block period is only a duration once the
    // runtime's nominal slot time is known.
    periodSeconds: d.periodSeconds ?? (nominalBlockSec != null ? d.period * nominalBlockSec : null),
    periodBlocks: d.period,
    nextExecutionBlock: d.nextExecutionBlock,
    valueUsdPerTrade: d.valueUsd,
  }
}

function compactOrder(o: OpenLimitOrder) {
  return {
    intentId: o.intentId,
    seq: o.seq,
    assetIn: compactAsset(o.assetIn),
    assetOut: compactAsset(o.assetOut),
    remainingIn: scaleAmount(o.remainingIn, o.assetIn.decimals),
    remainingOut: scaleAmount(o.remainingOut, o.assetOut.decimals),
    limitPrice: o.limitPrice,
    valueUsd: o.valueUsd,
    fills: o.fills,
    partial: o.partial,
    timestamp: o.timestamp,
    deadline: o.deadline,
  }
}

/** A counterparty account as one line: the address to act on and the name to read. */
const compactRef = (a: AccountRef) => ({ address: a.address, label: accountLabel(a), accountId: a.accountId })

function compactRelationships(d: AddressDetail) {
  return {
    proxy: d.proxy
      ? {
        isPure: d.proxy.isPure ? { creator: compactRef(d.proxy.isPure.creator), proxyType: d.proxy.isPure.proxyType, blockHeight: d.proxy.isPure.blockHeight } : null,
        delegates: (d.proxy.delegates ?? []).map(p => ({ account: compactRef(p.account), proxyType: p.proxyType, delay: p.delay })),
        delegatorOf: (d.proxy.delegatorOf ?? []).map(p => ({ account: compactRef(p.account), proxyType: p.proxyType, delay: p.delay })),
      }
      : null,
    multisig: d.multisig
      ? {
        threshold: d.multisig.threshold,
        signatories: (d.multisig.signatories ?? []).map(compactRef),
        pending: (d.multisig.pending ?? []).map(op => ({ callHash: op.callHash, sinceBlock: op.sinceBlock, approvals: op.approvals.length })),
      }
      : null,
    multisigMemberships: (d.multisigMemberships ?? []).map(m => ({ account: compactRef(m.account), threshold: m.threshold, signatories: m.signatories })),
  }
}

/**
 * The sentence that keeps an agent from attributing a set-scoped number to one
 * address. Every figure in an AddressDetail covers the whole related set, and
 * that is invisible in the numbers themselves.
 */
function scopeSentence(d: AddressDetail): string {
  const n = d.relatedAccountIds?.length ?? 1
  if (n <= 1) return 'Every figure in this answer covers this one address: nothing else is folded into it (no bound EVM address, no alias).'
  // "The same wallet" is a claim, and it is only supported where the upstream
  // observed a binding. With no alias rows the set is just the address FORMS of
  // one public key, which is a weaker and different statement.
  const observed = (d.aliases ?? []).some(a => a.relationship)
  const why = observed
    ? 'The set is one operator\'s substrate account together with the EVM address(es) bound to it — each member below carries the relationship and confidence the explorer observed.'
    : 'The members are alternative ADDRESS FORMS derived from this account\'s public key by the runtime address rules. Nothing on chain has been observed binding them, so treat the set as the same key rather than as demonstrated common control.'
  return `Every figure in this answer — value, balances, volumes, positions, money market — is scoped to this account's RELATED SET of ${n} addresses, not to ${shortAddress(d.input)} alone. ${why} Do not attribute a number here to a single address.`
}

function countsBlock(counts: TabCounts): string {
  return kv([
    ['Extrinsics signed', formatCount(counts.extrinsics)],
    ['Extrinsics on behalf (proxy/multisig/batch)', formatCount(counts.extrinsicsOnBehalf)],
    ['Events referencing this account', formatCount(counts.events)],
    ['Governance votes', formatCount(counts.votes)],
  ])
}

function revenueBlock(revenue: RevenueBreakdown): string {
  const streams = [...revenue.streams].sort((a, b) => b.usd - a.usd).slice(0, MAX_REVENUE_STREAMS)
  const rows = streams.map(s => [
    s.stream,
    formatUsd(s.usd),
    s.assets.slice(0, MAX_REVENUE_ASSETS).map(a => `${assetLabel(a.asset)} ${formatUsd(a.usd)}`).join(' · ') + (s.otherCount ? ` · +${s.otherCount} more ${formatUsd(s.otherUsd ?? 0)}` : ''),
  ])
  return joinBlocks(
    kv([['Total Protocol Revenue', formatUsd(revenue.totalUsd)]]),
    table(['Stream', 'USD', 'Top assets'], rows, 'this account has generated no protocol revenue'),
    revenue.streams.length > streams.length ? note(`${revenue.streams.length - streams.length} smaller stream(s) not shown.`) : '',
  )
}

const GET_ACCOUNT_DESCRIPTION = `The full interpreted reading of one Hydration account: who it is, what it holds, what it owes, what it has standing open.

Answers "what does this address hold and owe?", "wallet, pallet pot, contract or multisig?", "close to liquidation?", "what is it accumulating with DCA?". \`inspect_entity\` is the quick identification; \`get_activity\` with \`account\` is what it DID — this is what it IS.

\`address\` takes any form: SS58 of any prefix (63, 0, 2, 42 decode to one account), AccountId32 (0x + 64 hex), or EVM H160 (re-anchored to its bound substrate owner). The answer echoes every form.

\`include\` selects sections (default balances, positions, moneymarket, dca, orders, related); narrow it for a big account. 'counts' (lifetime extrinsic/event/vote counts) and 'revenue' (Protocol Revenue from it, by stream) each cost one more read and are off by default.

Two figures; quoting the wrong one contradicts the linked page. **Value** = holdings minus money-market debt: the account page's figure, \`get_account_history\`'s last point, the directory's ranking — quote it for "what is it worth". **Holdings** is gross: every balance, LP position, claimable farm reward (what claiming now pays, stated on its own line, never inside a position's USD) and claimable lending incentive (getAllUserRewards now, plus what the main market's off-chain PRIME programme's rewards distributor owes under its accepted root — counted even below the reward asset's existential deposit, though such a claim reverts until the account holds it; per market, never inside collateral). Money-market collateral is inside Holdings (an aToken is a balance) — never subtract it again. For a leveraged account the two differ by more than half.

Traps handled here; do not undo them when quoting:
- EVERY FIGURE COVERS THE RELATED SET (substrate account plus its bound EVM address — one wallet), not the address asked about. Attribute numbers to the set.
- Hydration runs SEVERAL ISOLATED money markets (\`core\`, \`gigahdx\`, \`bil\`, and more to come), each with its own health factor, collateral and threshold. Never average them, add their collateral, or quote one as "the account's health factor": the risk is the LOWEST among markets it is in, named with its market.
- Health factors are real ratios (1.60 = 1.60); '∞ (no debt)' means it owes nothing.
- Amounts are scaled by each asset's own decimals and named; do not rescale.
- A never-used address resolves with an empty portfolio; NOT_FOUND means the string is not an address.`


const getAccount: ToolDefinition = {
  name: 'get_account',
  title: 'Account holdings, positions and risk',
  description: GET_ACCOUNT_DESCRIPTION,
  inputSchema: accountInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(accountInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const { address } = parsed.value
    const sections = new Set<AccountSection>(parsed.value.include?.length ? parsed.value.include : DEFAULT_ACCOUNT_SECTIONS)
    const summarized = ![...sections].some(s => SECTIONS_NEEDING_FULL_BUILD.has(s))
    const encoded = encodeURIComponent(address)

    const [detailResult, countsResult, revenueResult, statsResult, juicerResult, bilResult, bondsResult] = await Promise.allSettled([
      ctx.upstream.get<AddressDetail>(`/explorer/address/${encoded}`, summarized ? { summary: 1 } : undefined, { ttlMs: PRICE_BEARING_TTL_MS }),
      sections.has('counts') ? ctx.upstream.get<TabCounts>(`/explorer/address/${encoded}/counts`, undefined, { ttlMs: 60_000 }) : Promise.resolve(null),
      sections.has('revenue') ? ctx.upstream.get<RevenueBreakdown>(`/explorer/address/${encoded}/revenue-breakdown`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      // The runtime's nominal slot time, for the DCA block periods. Cheap, and
      // the alternative is a literal that goes silently wrong after a cadence
      // change (see `dcaBlock`).
      sections.has('dca') ? ctx.upstream.get<ExplorerStats>('/explorer/stats', undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      sections.has('juicer') ? ctx.upstream.get<AccountJuicer>(`/explorer/address/${encoded}/juicer`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      sections.has('bil') ? ctx.upstream.get<AccountBil>(`/explorer/address/${encoded}/bil`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      sections.has('bonds') ? ctx.upstream.get<AccountBonds>(`/explorer/address/${encoded}/bonds`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
    ])

    if (detailResult.status === 'rejected') return failure(addressNotFound(detailResult.reason, address))
    const detail = detailResult.value
    const errs: ToolError[] = []
    const failedSections: string[] = []
    if (countsResult.status === 'rejected') {
      errs.push(toolErrorFromUpstream(countsResult.reason, `The activity counts for ${address}`))
      failedSections.push('counts')
    }
    if (revenueResult.status === 'rejected') {
      errs.push(toolErrorFromUpstream(revenueResult.reason, `The revenue breakdown for ${address}`))
      failedSections.push('revenue')
    }
    if (juicerResult.status === 'rejected') {
      errs.push(toolErrorFromUpstream(juicerResult.reason, `The Juicer positions of ${address}`))
      failedSections.push('juicer')
    }
    const juicer = settledValue(juicerResult)
    if (bilResult.status === 'rejected') {
      errs.push(toolErrorFromUpstream(bilResult.reason, `The BIL position of ${address}`))
      failedSections.push('bil')
    }
    const bil = settledValue(bilResult)
    if (bondsResult.status === 'rejected') {
      errs.push(toolErrorFromUpstream(bondsResult.reason, `The bonds of ${address}`))
      failedSections.push('bonds')
    }
    const bonds = settledValue(bondsResult)
    const counts = settledValue(countsResult)
    const revenue = settledValue(revenueResult)
    const stats = settledValue(statsResult)
    const nominalBlockSec = stats?.nominalBlockSec && stats.nominalBlockSec > 0 ? stats.nominalBlockSec : null

    const base = ctx.explorerBaseUrl
    const now = new Date()
    const value = portfolioValue(detail.portfolioUsd, detail.moneyMarket)
    const markdown = fit(joinBlocks(
      accountHeading(detail),
      identityBlock(detail, base),
      contractBlock(detail),
      section('Value', joinBlocks(portfolioBlock(detail, value), valueReconciliation(value) ?? '')),
      sections.has('balances') ? section('Balances', balancesBlock(detail, summarized)) : '',
      sections.has('positions') ? section('Liquidity positions', positionsBlock(detail.liquidityPositions ?? [])) : '',
      sections.has('moneymarket') ? section('Money market', moneyMarketBlock(detail.moneyMarket ?? [], base, now)) : '',
      sections.has('dca') ? section('Active DCA schedules', dcaBlock(detail.activeDcas ?? [], base, nominalBlockSec)) : '',
      sections.has('orders') ? section('Open limit orders', ordersBlock(detail.openLimitOrders ?? [], base)) : '',
      sections.has('related') ? section('Related accounts', relationshipsBlock(detail, base, summarized)) : '',
      counts ? section('Lifetime counts', countsBlock(counts)) : '',
      revenue ? section('Protocol Revenue', revenueBlock(revenue)) : '',
      juicer ? section('Juicer positions', juicerBlock(juicer, base)) : '',
      bil ? section('Brazilian Invoice Loans', bilBlock(bil)) : '',
      bonds ? section('Bonds', bondsBlock(bonds, base)) : '',
      // A section that failed is simply missing, which an agent could read as
      // "there is none". Name it instead.
      failedSections.length
        ? note(`These requested sections are MISSING because their read failed, not because there is nothing there: ${failedSections.join(', ')} (see Errors below). Retrying is reasonable.`)
        : '',
      !sections.has('related') ? note(`${scopeSentence(detail)} Add \`include: ["related"]\` to see the set.`) : '',
    ), ctx, 'Ask for fewer `include` sections.')

    return output(ctx, markdown, {
        address: {
          input: detail.input,
          kind: detail.kind,
          accountId: detail.accountId,
          ss58Hydration: detail.ss58,
          ss58Polkadot: detail.ss58Polkadot,
          evmAddress: detail.evmAddress,
          emoji: detail.emoji,
          tag: detail.tag,
          identity: detail.identity,
          profile: detail.profile ?? null,
          palletAccount: moduleName(detail.accountId),
          url: accountUrl(base, detail.evmAddress ?? detail.ss58Polkadot),
        },
        scopedToRelatedAccountIds: detail.relatedAccountIds ?? [],
        aliases: detail.aliases ?? [],
        // `valueUsd` is the figure the Explorer account page prints and the one
        // get_account_history's series ends on; `holdingsUsd` is the gross
        // upstream total that still contains the money-market collateral.
        valueUsd: value.valueUsd,
        holdingsUsd: value.holdingsUsd,
        moneyMarketDebtUsd: value.moneyMarketDebtUsd,
        // Inside holdingsUsd/valueUsd already; stated so a reader can take it back out.
        farmRewardsUsd: detail.farmRewards?.totalUsd ?? null,
        farmRewardsAsOfBlock: detail.farmRewards?.asOfBlock ?? null,
        // Claimable entries the index cannot price: in no total above, counted here.
        farmRewardsUnpriced: farmRewardsUnpriced(detail),
        moneyMarketRewardsUsd: detail.moneyMarketRewards?.totalUsd ?? null,
        moneyMarketRewardsAsOfBlock: detail.moneyMarketRewards?.asOfBlock ?? null,
        moneyMarketRewardsUnpriced: moneyMarketRewardsUnpriced(detail),
        holdingsExHdxUsd: detail.portfolioExHdxUsd ?? null,
        valueExHdxUsd: detail.portfolioExHdxUsd == null ? null : detail.portfolioExHdxUsd - value.moneyMarketDebtUsd,
        tradingVolumeUsd: detail.tradingVolumeUsd ?? null,
        liquidationVolumeUsd: detail.liquidationVolumeUsd ?? null,
        revenueUsd: detail.revenueUsd ?? null,
        // Net User Revenue; null = not yet published (never 0 then).
        userRevenueUsd: detail.userRevenueUsd ?? null,
        summaryBuild: summarized,
        balances: sections.has('balances')
          ? [...(detail.balances ?? [])].sort((a, b) => balanceValue(b) - balanceValue(a)).slice(0, MAX_BALANCE_ROWS).map(compactBalance)
          : undefined,
        balancesOmitted: sections.has('balances') ? Math.max(0, (detail.balances?.length ?? 0) - MAX_BALANCE_ROWS) : undefined,
        liquidityPositions: sections.has('positions')
          ? [...(detail.liquidityPositions ?? [])].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, MAX_JSON_LP_ROWS).map(compactLp)
          : undefined,
        liquidityPositionsOmitted: sections.has('positions') ? Math.max(0, (detail.liquidityPositions?.length ?? 0) - MAX_JSON_LP_ROWS) : undefined,
        // Every isolated market is kept — dropping one would hide a position,
        // and merging them would produce a health factor that is not any
        // market's. Only each market's reserve TAIL is trimmed.
        moneyMarketByIsolatedMarket: sections.has('moneymarket')
          ? (detail.moneyMarket ?? []).map(p => compactMarket(p, MAX_RESERVE_ROWS))
          : undefined,
        // The one risk figure for the whole account: the lowest REAL health
        // factor, carrying the market it belongs to so it can never be restated
        // as a blended or market-less number.
        riskiestMarket: sections.has('moneymarket')
          ? (() => {
            const r = lowestRealHealthFactor(detail.moneyMarket ?? [])
            return r ? { marketKey: r.marketKey, market: r.market, healthFactor: r.healthFactor, healthFactorRatio: Number(r.healthFactor) / 1e18 } : null
          })()
          : undefined,
        activeDcas: sections.has('dca') ? (detail.activeDcas ?? []).slice(0, MAX_DCA_ROWS).map(d => compactDca(d, nominalBlockSec)) : undefined,
        openLimitOrders: sections.has('orders') ? (detail.openLimitOrders ?? []).slice(0, MAX_ORDER_ROWS).map(compactOrder) : undefined,
        ...(sections.has('related') ? compactRelationships(detail) : {}),
        counts: counts ?? undefined,
        revenue: revenue ?? undefined,
        juicer: juicer ?? undefined,
        bil: bil ?? undefined,
        bonds: bonds ?? undefined,
    }, errs)
  },
}

/* ============ get_account_history ============ */

const HISTORY_KINDS = ['portfolio', 'balances', 'value-events', 'liquidity', 'money-market', 'volume'] as const
const MAX_SERIES_POINTS = 12
const MAX_VALUE_EVENT_ROWS = 12

const historyInputShape = {
  address: addressParam.optional(),
  tag: z.string().min(1).max(64).optional().describe("Kind 'volume' only, instead of `address`: a system tag id (e.g. `treasury`)."),
  kind: z.enum(HISTORY_KINDS).optional().describe("Default 'portfolio'."),
  fromBlock: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('Window start, a BLOCK NUMBER; with toBlock.'),
  toBlock: z.coerce.number().int().min(1).max(0xffff_ffff).optional().describe('Window end, a BLOCK NUMBER above fromBlock.'),
  limit: z.coerce.number().int().min(1).max(50).optional().describe('Rows per table (default 12); the sampled path stays at most 12 points.'),
  format: formatParam,
}

interface SeriesStat {
  first: { value: number; date: string; block: number | null } | null
  last: { value: number; date: string; block: number | null } | null
  min: { value: number; date: string } | null
  max: { value: number; date: string } | null
}

function seriesStats(series: number[], dates: string[], blocks: number[] | undefined): SeriesStat {
  if (!series.length) return { first: null, last: null, min: null, max: null }
  let minI = 0
  let maxI = 0
  for (let i = 1; i < series.length; i += 1) {
    if (series[i] < series[minI]) minI = i
    if (series[i] > series[maxI]) maxI = i
  }
  const at = (i: number) => ({ value: series[i], date: dates[i] ?? '', block: blocks?.[i] ?? null })
  return {
    first: at(0),
    last: at(series.length - 1),
    min: { value: series[minI], date: dates[minI] ?? '' },
    max: { value: series[maxI], date: dates[maxI] ?? '' },
  }
}

/**
 * The change as a fraction of the window's opening value, or null when that
 * opening cannot support a ratio.
 *
 * A percentage is only information when it has a baseline to be a percentage
 * OF. The first bucket of an account's whole history is usually its funding
 * transaction, so the ratio against it is arbitrarily large — "+5358293.20%"
 * says nothing except that the account started near zero. The Explorer's own
 * chart suppresses exactly these windows (see `performancePoints`, minBase 1,
 * maxRatio 20) and so does this.
 */
function meaningfulChangeFraction(stats: SeriesStat): number | null {
  const MIN_PCT_BASE_USD = 1
  const MAX_PCT_RATIO = 20
  if (stats.first == null || stats.last == null) return null
  const baseline = stats.first.value
  if (Math.abs(baseline) < MIN_PCT_BASE_USD || Math.abs(stats.last.value) > Math.abs(baseline) * MAX_PCT_RATIO) return null
  return (stats.last.value - baseline) / Math.abs(baseline)
}

/** First / Last / Change / Low / High of a USD series, as `kv` rows. */
function seriesStatsRows(stats: SeriesStat, pctSuppressedBecause?: string): [string, string | null][] {
  const change = stats.first && stats.last ? stats.last.value - stats.first.value : null
  const pct = pctSuppressedBecause ? null : meaningfulChangeFraction(stats)
  return [
    ['First', `${formatUsd(stats.first?.value)} on ${formatTime(stats.first?.date)}${stats.first?.block != null ? ` (block ${formatCount(stats.first.block)})` : ''}`],
    ['Last', `${formatUsd(stats.last?.value)} on ${formatTime(stats.last?.date)}${stats.last?.block != null ? ` (block ${formatCount(stats.last.block)})` : ''}`],
    ['Change', change == null
      ? null
      : `${change >= 0 ? '+' : '-'}${formatUsd(Math.abs(change))}`
        + (pct != null
          ? ` (${formatPercentChange(pct)})`
          : ` (no percentage: ${pctSuppressedBecause ?? `the window opens at ${formatUsd(stats.first!.value)}, so a ratio against it would say nothing about performance`})`)],
    ['Low', stats.min ? `${formatUsd(stats.min.value)} on ${formatTime(stats.min.date)}` : null],
    ['High', stats.max ? `${formatUsd(stats.max.value)} on ${formatTime(stats.max.date)}` : null],
  ]
}

/**
 * At most `max` points, evenly spaced, always including the first and the last.
 * Returns the stride so the caller can SAY what it sampled — a path whose
 * spacing is unstated invites a model to read it as the whole series.
 */
/** `13` → `13th`, `22` → `22nd`. The teens are the exception every naive map gets wrong. */
function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function samplePath<T>(points: T[], max: number): { sampled: T[]; stride: number } {
  if (points.length <= max) return { sampled: points, stride: 1 }
  const stride = Math.ceil(points.length / max)
  const sampled: T[] = []
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i])
  const last = points[points.length - 1]
  if (sampled[sampled.length - 1] !== last) sampled.push(last)
  return { sampled, stride }
}

function valueEventsTable(events: ValueEvent[], limit: number, base: string, now: Date, filteredOut = 0): string {
  const sorted = [...events].sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd))
  const shown = sorted.slice(0, limit)
  const rows = shown.map(e => [
    `${formatTime(e.timestamp)} (${relativeAge(e.timestamp, now)})`,
    e.kind,
    e.kind === 'dca' && e.assetIn && e.assetOut
      // `USDC → USDC` for two different registry assets reads as a no-op. The
      // pair renderer prints the ids exactly when the symbols collide.
      ? `${assetPairLabels(e.assetIn, e.assetOut).join(' → ')}${e.dcaTrades ? ` ×${e.dcaTrades}` : ''}`
      : e.asset ? assetLabel(e.asset) : DASH,
    `${e.valueUsd < 0 ? '-' : e.direction === 'out' ? '-' : ''}${formatUsd(Math.abs(e.valueUsd))}`,
    e.counterparty ? accountLabel(e.counterparty) : DASH,
    explorerLink(formatCount(e.blockHeight), blockUrl(base, e.blockHeight)),
  ])
  return joinBlocks(
    table(
      ['Time', 'Kind', 'Asset', 'USD', 'Counterparty', 'Block'],
      rows,
      filteredOut > 0
        // Saying only "none" here would read as "this account never moved",
        // which is a different claim from "not in the block range you asked for".
        ? `no value event falls inside the block window — ${filteredOut} exist outside it, so widen or drop fromBlock/toBlock`
        : 'no event has moved this account\'s value',
    ),
    sorted.length > shown.length ? note(`${sorted.length - shown.length} smaller value event(s) not shown; these are the largest by absolute USD.`) : '',
    events.some(e => e.kind === 'price') ? note("A 'price' row is not a transfer: it is the part of the value change that price movement alone explains, and its USD is signed.") : '',
  )
}

/* ---- kind 'liquidity' ---- */

const VENUE_LABEL: Record<LiquidityHistoryPosition['venue'], string> = {
  omnipool: 'Omnipool',
  stableswap: 'Stableswap',
  xyk: 'XYK',
  uniswapv3: 'Uniswap v3',
  gamma: 'Gamma vault',
}

const isHubLeg = (p: LiquidityHistoryPosition, assetId: number): boolean => p.venue === 'omnipool' && assetId === 1

const farmedEver = (p: LiquidityHistoryPosition): boolean => p.farmed || p.spans.some(s => s.kind === 'farmed')

/**
 * What the position IS, in the words the Explorer uses: an Omnipool position
 * is its asset and NFT id, a v3 position its pair and NFT id, a Gamma vault
 * its pair and vault address, a share-token pool its share asset.
 */
function lpPositionLabel(p: LiquidityHistoryPosition): string {
  const legs = p.points[p.points.length - 1]?.legs ?? []
  const pair = legs.filter(l => !isHubLeg(p, l.asset.assetId)).map(l => assetLabel(l.asset)).join(' / ') || DASH
  switch (p.venue) {
    case 'omnipool': return `${pair} #${p.positionId ?? DASH}`
    case 'uniswapv3': return `${pair} NFT #${p.positionId ?? DASH}`
    case 'gamma': return `${pair} vault ${shortAddress(p.poolKey)}`
    default: return p.shareAsset ? assetLabelWithId(p.shareAsset) : `${pair} pool ${shortAddress(p.poolKey)}`
  }
}

/** One end of a holding period, and whether it is an exact chain time or a bucket end. */
interface HeldMark { date: string | null; block: number | null; source: 'span' | 'bucket' }

interface LpPositionStat {
  p: LiquidityHistoryPosition
  first: number | null
  last: number | null
  low: number | null
  high: number | null
  /** Held at the reading's last bucket — "now" un-windowed, the window's end otherwise. */
  heldAtLastBucket: boolean
  heldFrom: HeldMark
  /** Null while the position is open (a span with no end, or held at the last bucket). */
  heldTo: HeldMark | null
}

/**
 * Where the index tracks a position's holding spans (Omnipool NFTs, XYK farm
 * entries, Uniswap v3 NFTs) the period is the exact on-chain open and close;
 * a span-less venue (stableswap and XYK share balances, Gamma vault shares) has
 * only the first and last bucket end it was held at.
 */
function lpPositionStat(p: LiquidityHistoryPosition, dates: string[], blocks: number[], lastBucket: number): LpPositionStat {
  const priced = p.points.map(pt => pt.valueUsd).filter((v): v is number => v != null)
  const fromIndex = p.points[0]?.i ?? 0
  const toIndex = p.points[p.points.length - 1]?.i ?? 0
  const heldAtLastBucket = toIndex === lastBucket
  const bucketMark = (i: number): HeldMark => ({ date: dates[i] ?? null, block: blocks[i] ?? null, source: 'bucket' })
  const firstSpan = p.spans[0]
  const lastSpan = p.spans[p.spans.length - 1]
  const heldFrom: HeldMark = firstSpan ? { date: firstSpan.fromTime, block: firstSpan.fromBlock, source: 'span' } : bucketMark(fromIndex)
  const heldTo: HeldMark | null = lastSpan
    ? (lastSpan.toBlock == null ? null : { date: lastSpan.toTime, block: lastSpan.toBlock, source: 'span' })
    : (heldAtLastBucket ? null : bucketMark(toIndex))
  return {
    p,
    first: p.points[0]?.valueUsd ?? null,
    last: p.points[p.points.length - 1]?.valueUsd ?? null,
    low: priced.length ? Math.min(...priced) : null,
    high: priced.length ? Math.max(...priced) : null,
    heldAtLastBucket,
    heldFrom,
    heldTo,
  }
}

/**
 * Positions held at the last point first, then closed ones; within each group
 * the largest last-held value first and unpriced last. The route ranks (and
 * caps) by last-held value alone, which on a long-lived account puts positions
 * closed years ago above everything it holds now.
 */
const byLastValue = (a: LpPositionStat, b: LpPositionStat): number => {
  if (a.heldAtLastBucket !== b.heldAtLastBucket) return a.heldAtLastBucket ? -1 : 1
  if ((a.last == null) !== (b.last == null)) return a.last == null ? 1 : -1
  return (b.last ?? 0) - (a.last ?? 0)
}

/** The legs at the last held bucket; the Omnipool hub leg reads `+ x H2O`. */
function lastLegsText(p: LiquidityHistoryPosition): string {
  const legs = p.points[p.points.length - 1]?.legs ?? []
  if (!legs.length) return DASH
  const main = legs.filter(l => !isHubLeg(p, l.asset.assetId))
  const hub = legs.filter(l => isHubLeg(p, l.asset.assetId))
  return [
    main.map(l => formatAmount(l.amount, l.asset.decimals, l.asset.symbol)).join(' + '),
    ...hub.map(l => `+ ${formatAmount(l.amount, l.asset.decimals, HUB_SYMBOL)}`),
  ].filter(Boolean).join(' ')
}

/** An exact span time to the minute; a bucket end to the day, marked `~`. */
const heldMarkText = (m: HeldMark): string => (m.date == null
  ? DASH
  : m.source === 'span' ? m.date.slice(0, 16) : `~${m.date.slice(0, 10)}`)

function heldText(s: LpPositionStat, windowed: boolean): string {
  const open = windowed ? 'held at window end' : 'still held'
  return `${heldMarkText(s.heldFrom)} → ${s.heldTo ? heldMarkText(s.heldTo) : open}`
}

function lpVenueCell(p: LiquidityHistoryPosition): string {
  const venue = VENUE_LABEL[p.venue] ?? p.venue
  return p.farmed ? `${venue} (farmed)` : farmedEver(p) ? `${venue} (farmed earlier)` : venue
}

const MAX_JSON_LP_SPANS = 10
const DAY_SEC = 86_400

/**
 * The spans the structured record keeps: the FIRST (when the position opened)
 * and the newest ones, so a long flip history is trimmed from the middle.
 */
function keptSpans(spans: LiquidityHistorySpan[]): { kept: LiquidityHistorySpan[]; omitted: number } {
  if (spans.length <= MAX_JSON_LP_SPANS) return { kept: spans, omitted: 0 }
  return { kept: [spans[0], ...spans.slice(-(MAX_JSON_LP_SPANS - 1))], omitted: spans.length - MAX_JSON_LP_SPANS }
}

/**
 * The 'liquidity' kind: `/explorer/address/:a/liquidity-history`, the
 * explorer's LP-history route — a definition shared with the Data API's
 * `/v1/accounts/{address}/liquidity/history`. It is a separate route from
 * `/history` (that one carries only the portfolio line), so this kind reads
 * nothing else.
 */
async function liquidityHistoryAnswer(
  address: string,
  window: { fromBlock: number; toBlock: number } | undefined,
  limit: number,
  ctx: ToolContext,
) {
  const encoded = encodeURIComponent(address)
  const base = ctx.explorerBaseUrl
  let lp: LiquidityHistory
  try {
    lp = await ctx.upstream.get<LiquidityHistory>(`/explorer/address/${encoded}/liquidity-history`, window, { ttlMs: 120_000, timeoutMs: 90_000 })
  } catch (err) {
    return failure(addressNotFound(err, address, `The liquidity history of ${address}`))
  }

  const dates = lp.dates ?? []
  const blocks = lp.blocks ?? []
  const series = lp.valueUsd ?? []
  const unpriced = lp.unpriced ?? []
  const lastBucket = dates.length - 1
  const windowed = window != null
  // The un-windowed route keeps only the last bucket of each calendar day, so
  // on a sub-day step its points are a day apart, not a step apart.
  const daily = !windowed && lp.stepSec > 0 && lp.stepSec < DAY_SEC
  const spacing = daily ? 'one day' : `one ${formatDuration(lp.stepSec)} bucket`

  // First/Last are the endpoints as they are; Low/High only range over buckets
  // with every held position priced — a trough that exists only because a
  // position dropped out of the sum is not a low the account ever had.
  const stats = seriesStats(series, dates, blocks)
  const fullIdx = series.map((_, i) => i).filter(i => (unpriced[i] ?? 0) === 0)
  const fullStats = seriesStats(fullIdx.map(i => series[i]), fullIdx.map(i => dates[i]), fullIdx.map(i => blocks[i]))
  const partialBuckets = series.length - fullIdx.length
  const unpricedFirst = unpriced[0] ?? 0
  const unpricedLast = unpriced[lastBucket] ?? 0
  const partialEndpoint = unpricedFirst > 0 || unpricedLast > 0
  const lineStats: SeriesStat = { first: stats.first, last: stats.last, min: fullStats.min, max: fullStats.max }
  const lineRows = seriesStatsRows(lineStats, partialEndpoint ? 'an endpoint leaves unpriced positions out of its total' : undefined)
    .map(([k, v]): [string, string | null] => {
      if (v == null) return [k, v]
      if (k === 'First' && unpricedFirst) return [k, `${v} — ${unpricedFirst} held position(s) unpriced there and left out`]
      if (k === 'Last' && unpricedLast) return [k, `${v} — ${unpricedLast} held position(s) unpriced there and left out`]
      if (k === 'Change') return [k, `${v} — includes deposits and withdrawals, so it is not a return`]
      if ((k === 'Low' || k === 'High') && partialBuckets) return [`${k} (fully priced buckets only)`, v]
      return [k, v]
    })

  const { sampled, stride } = samplePath(series.map((_, i) => i), MAX_SERIES_POINTS)
  const anyUnpriced = partialBuckets > 0
  const pathTable = table(
    ['Date', 'Block', 'LP USD', ...(anyUnpriced ? ['Unpriced'] : [])],
    sampled.map(i => [formatTime(dates[i]), formatCount(blocks[i]), formatUsd(series[i]), ...(anyUnpriced ? [unpriced[i] ? formatCount(unpriced[i]) : ''] : [])]),
  )

  const all = (lp.positions ?? []).map(p => lpPositionStat(p, dates, blocks, lastBucket)).sort(byLastValue)
  const shown = all.slice(0, limit)
  const routeOmitted = lp.positionsOmitted ?? 0
  const notShown = all.length - shown.length + routeOmitted
  const heldAtEnd = all.filter(s => s.heldAtLastBucket).length
  const anyFarmed = all.some(s => farmedEver(s.p))
  const anyBucketHeld = shown.some(s => s.heldFrom.source === 'bucket' || s.heldTo?.source === 'bucket')
  const grain = lp.priceGrain === '1h' ? 'hourly' : 'daily'
  const windowLine = windowed ? `blocks ${formatCount(window.fromBlock)} → ${formatCount(window.toBlock)}` : 'the account\'s whole indexed history'
  const pointsLine = !dates.length
    ? null
    : daily
      ? `${formatCount(dates.length)} daily points (the last ${formatDuration(lp.stepSec)} bucket of each day), ${formatTime(dates[0])} → ${formatTime(dates[lastBucket])}`
      : `${formatCount(dates.length)} buckets of ${formatDuration(lp.stepSec)}, ${formatTime(dates[0])} → ${formatTime(dates[lastBucket])}`

  const rows = shown.map(s => [
    lpVenueCell(s.p),
    lpPositionLabel(s.p),
    heldText(s, windowed),
    formatUsd(s.first),
    formatUsd(s.last),
    formatUsd(s.low),
    formatUsd(s.high),
    lastLegsText(s.p),
  ])

  // The route's reward figures ride beside the LP line (never in it).
  const rewardsSeries = lp.unclaimedRewardsUsd ?? []
  const rewardsLastUsd = rewardsSeries.length ? rewardsSeries[rewardsSeries.length - 1] ?? null : null
  const rewardsIncompleteLast = (lp.rewardsIncomplete ?? [])[lastBucket] ?? 0
  const markdown = fit(joinBlocks(
    `## LP history — ${shortAddress(address)}`,
    kv([
      ['Window', windowLine],
      ['Points', pointsLine],
      ['Priced at', `closed ${grain} candles (${lp.priceGrain})`],
      ['Positions', `${formatCount(all.length + routeOmitted)} held at some point in the reading, ${formatCount(heldAtEnd)}${routeOmitted ? '+' : ''} at the ${windowed ? 'window\'s last point' : 'last point'}`],
      ['Unpriced at the last point', unpricedLast ? `${formatCount(unpricedLast)} position(s), counted and left out of the line` : null],
      ['Unclaimed farm rewards at the last point', rewardsLastUsd != null && (rewardsLastUsd > 0 || rewardsIncompleteLast > 0)
        ? `${formatUsd(rewardsLastUsd)}${rewardsIncompleteLast ? ` (+ ${formatCount(rewardsIncompleteLast)} farm entr${rewardsIncompleteLast === 1 ? 'y' : 'ies'} not stated or unpriced, left out)` : ''} — settled, beside the LP line and not in it`
        : null],
      ['Account', accountUrl(base, address)],
    ]),
    series.length
      ? section('LP value line — the sum of every priced liquidity position (principal only)', joinBlocks(
        kv(lineRows),
        partialBuckets ? note(`Low and High range over the ${formatCount(fullIdx.length)} point(s) where every held position was priced; the ${formatCount(partialBuckets)} with an unpriced position are left out, because their total understates what was held.`) : '',
      ))
      : '',
    series.length
      ? joinBlocks(
        section(`Sampled path (${sampled.length} of ${formatCount(series.length)} points${stride > 1 ? `, every ${ordinal(stride)} point` : ''})`, pathTable),
        stride > 1 ? note('This is a SAMPLE, not the series — intermediate highs and lows between the shown points are in the Low/High figures above, not in this table.') : '',
      )
      : '',
    section(
      `Positions — ${windowed ? 'held at the window\'s end' : 'still held'} first, then closed; each by last-held value`,
      joinBlocks(
        table(
          ['Venue', 'Position', 'Held', 'First', 'Last', 'Low', 'High', 'Last legs'],
          rows,
          windowed ? 'this account held no liquidity position at any point in the window' : 'this account has held no liquidity position the index has seen',
        ),
        notShown > 0 ? note(`${formatCount(notShown)} more position(s) not shown${routeOmitted ? ` (${formatCount(routeOmitted)} of them beyond the explorer's own cap, so absent from the structured record too)` : ''}; ${all.length - shown.length > 0 ? 'raise `limit` to see more of the rest' : 'the explorer keeps the largest by last-held value, so these are smaller ones'}.`) : '',
        rows.length ? note(`\`Held\` is the exact on-chain open and close (UTC, to the minute) where the index tracks the position's holding spans — Omnipool and Uniswap v3 positions, XYK farm entries.${anyBucketHeld ? ' A `~date` is a point date instead: span-less venues (stableswap and XYK share balances, Gamma vault shares) only have the first and last point the position was held at.' : ''} First/Last/Low/High are the position's USD at the points it was held at, which are ${spacing} apart — a position opened and closed inside ${daily ? 'one day' : 'one bucket'} has no point. \`Last legs\` are what redeeming it would have returned at its last held point.`) : '',
      ),
    ),
    note(`Every point is valued at the ${grain} candle fully CLOSED by the bucket end and never back-filled from a later price. Substrate pools (Omnipool, stableswap, XYK) are stated on the pool state sampled at or before that end — a 600-block grid, so up to 600 blocks old; Uniswap v3 and Gamma legs are folded exactly at the bucket end. So the last point differs from \`get_account\`'s current Value and its liquidity-position USD, which price the live pool state at live prices${windowed ? ' — and this reading is WINDOWED, so it ends at the window, not now' : ''}.`),
    note('Values are LP principal: Uniswap v3 and Gamma uncollected fees are excluded, and so are unclaimed farm rewards — those are a separate claim, stated on their own (`Unclaimed farm rewards at the last point`, and per point in the structured record) and SETTLED as of each farm\'s last on-chain sync. The portfolio kind\'s value line and `get_account`\'s Value DO count them.'),
    anyFarmed ? note('`(farmed)` means the position sat in a liquidity-mining farm at its last held point, `(farmed earlier)` that it spent part of its life in one. Entering or leaving a farm does not change the position or its value — it stays one row.') : '',
    partialBuckets
      ? note(`At ${formatCount(partialBuckets)} point(s) — up to ${formatCount(Math.max(...unpriced))} position(s) at once — a held position could not be priced (a leg without a price, or no pool state yet). Those are COUNTED and left out of the line, not valued at zero, so the line understates the LP value there; a ${DASH} in the table is such a point.`)
      : '',
    note('Every figure is scoped to the account\'s related set (its substrate account plus any EVM address bound to it), not to one address.'),
  ), ctx, 'Narrow the block window or lower `limit`.')

  return output(ctx, markdown, {
    address,
    kind: 'liquidity',
    measure: 'LP principal USD — the legs a redemption would return, at closed candles',
    window: window ?? null,
    url: accountUrl(base, address),
    // The point every `heldAtLastBucket` refers to: now when un-windowed, the
    // window's end otherwise.
    asOf: dates.length ? { date: dates[lastBucket], block: blocks[lastBucket] ?? null } : null,
    stepSec: lp.stepSec,
    grid: daily ? 'daily' : 'step',
    pointSpacingSec: daily ? DAY_SEC : lp.stepSec,
    priceGrain: lp.priceGrain,
    series: {
      points: series.length,
      dates: dates.length ? [dates[0], dates[lastBucket]] : [],
      first: stats.first,
      last: stats.last,
      // Over fully priced points only (see `fullyPricedPoints`).
      min: fullStats.min,
      max: fullStats.max,
      fullyPricedPoints: fullIdx.length,
      // Includes deposits and withdrawals: a change in holdings, not a return.
      changeUsd: stats.first && stats.last ? stats.last.value - stats.first.value : null,
      changeFraction: partialEndpoint ? null : meaningfulChangeFraction(stats),
      unpricedAtFirst: unpricedFirst,
      unpricedAtLast: unpricedLast,
      pointsWithUnpriced: partialBuckets,
      sampleStride: stride,
      sampled: sampled.map(i => ({ date: dates[i] ?? null, block: blocks[i] ?? null, valueUsd: series[i], unpriced: unpriced[i] ?? 0, unclaimedRewardsUsd: rewardsSeries[i] ?? null })),
    },
    // Settled unclaimed farm rewards at the last point; NOT inside `series`.
    unclaimedRewardsUsdAtLast: rewardsLastUsd,
    rewardsIncompleteAtLast: rewardsIncompleteLast,
    positions: shown.map(s => {
      const last = s.p.points[s.p.points.length - 1]
      const { kept, omitted } = keptSpans(s.p.spans)
      return {
        venue: s.p.venue,
        farmed: s.p.farmed,
        farmedEver: farmedEver(s.p),
        positionId: s.p.positionId,
        poolKey: s.p.poolKey,
        shareAsset: s.p.shareAsset ? compactAsset(s.p.shareAsset) : null,
        label: lpPositionLabel(s.p),
        heldFrom: s.heldFrom,
        heldTo: s.heldTo,
        heldAtLastBucket: s.heldAtLastBucket,
        points: s.p.points.length,
        firstUsd: s.first,
        lastUsd: s.last,
        lowUsd: s.low,
        highUsd: s.high,
        ...(s.p.shareAsset
          ? { lastShares: last ? scaleAmount(last.shares, s.p.shareAsset.decimals) : null }
          : { lastSharesRaw: last?.shares ?? null }),
        lastLegs: (last?.legs ?? []).map(l => ({
          asset: compactAsset(l.asset),
          amount: scaleAmount(l.amount, l.asset.decimals),
          valueUsd: l.valueUsd,
        })),
        spans: kept.map(sp => ({ fromBlock: sp.fromBlock, fromTime: sp.fromTime, toBlock: sp.toBlock, toTime: sp.toTime, kind: sp.kind })),
        spansOmitted: omitted,
      }
    }),
    // Everything held in the reading but not in `positions`: the rows past
    // `limit` plus the ones the explorer's own cap never returned.
    positionsNotShown: notShown,
    positionsBeyondExplorerCap: routeOmitted,
  })
}

/* ---- kind 'money-market' ---- */

const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

/** An observation's health factor as the shared formatter reads it: `inf` when the account owes nothing there. */
const observedHf = (o: { healthFactor: string; totalDebtBase: string }): string =>
  o.healthFactor === MAX_UINT256 || o.totalDebtBase === '0' ? 'inf' : o.healthFactor

const hfRatio = (hf: string): number | null => (/^\d+$/.test(hf) ? Number(hf) / 1e18 : null)

interface ObservedHfPoint { hf: string; ratio: number | null; block: number; time: string | null }

/**
 * One market's health-factor path from the observations its points carry, each
 * counted once (a carried-forward observation repeats across buckets). Low is the
 * lowest REAL ratio — `inf` (no debt) takes no part — and every figure names the
 * block the chain was read at.
 */
function marketHfPath(m: MoneyMarketHistoryMarket): { first: ObservedHfPoint | null; last: ObservedHfPoint | null; low: ObservedHfPoint | null; distinct: number } {
  const seen = new Map<number, ObservedHfPoint>()
  for (const p of m.points) {
    const o = p.observation
    if (!o || seen.has(o.observedAtBlock)) continue
    const hf = observedHf(o)
    seen.set(o.observedAtBlock, { hf, ratio: hfRatio(hf), block: o.observedAtBlock, time: o.timestamp })
  }
  const list = [...seen.values()]
  let low: ObservedHfPoint | null = null
  for (const x of list) if (x.ratio != null && (low == null || x.ratio < (low.ratio ?? Infinity))) low = x
  return { first: list[0] ?? null, last: list[list.length - 1] ?? null, low, distinct: list.length }
}

/** A market point's settled unclaimed incentives, per reward asset; null when none. */
function rewardPointLine(rewards: Array<{ asset: AssetRef; amount: string; valueUsd: number | null; settledAtBlock: number | null }> | undefined): string | null {
  if (!rewards?.length) return null
  return rewards.map(r => `${formatAmount(r.amount, r.asset.decimals, r.asset.symbol)} ${r.valueUsd == null ? '(unpriced, counted)' : `(${formatUsd(r.valueUsd)})`}${r.settledAtBlock != null ? ` settled at block ${formatCount(r.settledAtBlock)}` : ''}`).join(' · ')
}

const hfText = (x: ObservedHfPoint | null): string | null =>
  x == null ? null : `${formatHealthFactor(x.hf)} (observed at block ${formatCount(x.block)}${x.time ? `, ${formatTime(x.time)}` : ''})`

/**
 * The 'money-market' kind: `/explorer/address/:a/money-market-history`, the
 * explorer's money-market history route — a definition shared with the Data
 * API's `/v1/accounts/{address}/money-market/history`. It reads nothing else.
 */
async function moneyMarketHistoryAnswer(
  address: string,
  window: { fromBlock: number; toBlock: number } | undefined,
  limit: number,
  ctx: ToolContext,
) {
  const encoded = encodeURIComponent(address)
  const base = ctx.explorerBaseUrl
  let mm: MoneyMarketHistory
  try {
    mm = await ctx.upstream.get<MoneyMarketHistory>(`/explorer/address/${encoded}/money-market-history`, window, { ttlMs: 120_000, timeoutMs: 90_000 })
  } catch (err) {
    return failure(addressNotFound(err, address, `The money-market history of ${address}`))
  }

  const dates = mm.dates ?? []
  const blocks = mm.blocks ?? []
  const supplied = mm.suppliedUsd ?? []
  const borrowed = mm.borrowedUsd ?? []
  const unpriced = mm.unpriced ?? []
  const rewardsUsd = mm.unclaimedRewardsUsd ?? []
  const rewardsIncomplete = mm.rewardsIncomplete ?? []
  const lastBucket = dates.length - 1
  const windowed = window != null
  const daily = !windowed && mm.stepSec > 0 && mm.stepSec < DAY_SEC
  const grain = mm.priceGrain === '1h' ? 'hourly' : 'daily'
  const windowLine = windowed ? `blocks ${formatCount(window.fromBlock)} → ${formatCount(window.toBlock)}` : 'the account\'s whole indexed history'
  const pointsLine = !dates.length
    ? null
    : daily
      ? `${formatCount(dates.length)} daily points (the last ${formatDuration(mm.stepSec)} bucket of each day), ${formatTime(dates[0])} → ${formatTime(dates[lastBucket])}`
      : `${formatCount(dates.length)} buckets of ${formatDuration(mm.stepSec)}, ${formatTime(dates[0])} → ${formatTime(dates[lastBucket])}`

  // Stats over the stated, fully priced points only: a bucket before the coverage
  // floor has no reserve figures, and one with an unpriced leg understates.
  const stated = supplied.map((_, i) => i).filter(i => supplied[i] != null && borrowed[i] != null)
  const full = stated.filter(i => (unpriced[i] ?? 0) === 0)
  const statsOf = (series: Array<number | null>, idx: number[]) => seriesStats(idx.map(i => series[i] as number), idx.map(i => dates[i]), idx.map(i => blocks[i]))
  const suppliedStats = statsOf(supplied, full)
  const borrowedStats = statsOf(borrowed, full)
  const statRows = (label: string, st: SeriesStat): [string, string | null][] => [
    [`${label} — first`, st.first ? `${formatUsd(st.first.value)} on ${formatTime(st.first.date)}` : null],
    [`${label} — last`, st.last ? `${formatUsd(st.last.value)} on ${formatTime(st.last.date)}` : null],
    [`${label} — low / high`, st.min && st.max ? `${formatUsd(st.min.value)} (${formatTime(st.min.date)}) / ${formatUsd(st.max.value)} (${formatTime(st.max.date)})` : null],
  ]

  const { sampled, stride } = samplePath(dates.map((_, i) => i), MAX_SERIES_POINTS)
  const anyUnpriced = unpriced.some(u => u > 0)
  const pathTable = table(
    ['Date', 'Block', 'Supplied USD', 'Borrowed USD', ...(anyUnpriced ? ['Unpriced'] : [])],
    sampled.map(i => [
      formatTime(dates[i]), formatCount(blocks[i]),
      supplied[i] == null ? DASH : formatUsd(supplied[i]), borrowed[i] == null ? DASH : formatUsd(borrowed[i]),
      ...(anyUnpriced ? [unpriced[i] ? formatCount(unpriced[i]) : ''] : []),
    ]),
  )

  const markets = mm.markets ?? []
  const marketBlocks = markets.map(m => {
    const hf = marketHfPath(m)
    const lastPoint = m.points[m.points.length - 1]
    const heldAtEnd = lastPoint?.i === lastBucket
    const reserves = m.reserves
      .map(r => ({ r, p: r.points.find(pt => pt.i === lastBucket) ?? null }))
    const atEnd = reserves.filter(x => x.p != null).sort((a, b) => ((b.p!.suppliedUsd ?? 0) + (b.p!.borrowedUsd ?? 0)) - ((a.p!.suppliedUsd ?? 0) + (a.p!.borrowedUsd ?? 0)))
    const shown = atEnd.slice(0, limit)
    const earlier = reserves.length - atEnd.length
    return {
      m, hf, lastPoint, heldAtEnd, atEnd, earlier,
      markdown: joinBlocks(
        h3(`${m.market} (${m.marketKey}, ${m.role} market)${m.stakingBacked ? ' — staking-backed collateral' : ''}`),
        kv([
          ['Observed health factor — last', hfText(hf.last)],
          ['Observed health factor — lowest', hf.low && hf.low !== hf.last ? hfText(hf.low) : null],
          ['Observed health factor — first', hf.first && hf.first !== hf.last ? hfText(hf.first) : null],
          ['Observations in the reading', hf.distinct ? formatCount(hf.distinct) : null],
          [`Supplied / borrowed at the ${heldAtEnd ? (windowed ? 'window\'s last point' : 'last point') : 'market\'s last held point'}`, lastPoint
            ? `${lastPoint.suppliedUsd == null ? DASH : formatUsd(lastPoint.suppliedUsd)} / ${lastPoint.borrowedUsd == null ? DASH : formatUsd(lastPoint.borrowedUsd)}${lastPoint.unpriced ? ` (+ ${formatCount(lastPoint.unpriced)} leg(s) unpriced, left out)` : ''}${heldAtEnd ? '' : ` on ${formatTime(dates[lastPoint.i])}`}`
            : null],
          ['E-mode category', lastPoint?.eModeCategoryId ? String(lastPoint.eModeCategoryId) : null],
          ['Unclaimed incentives at that point (settled; not in supplied)', rewardPointLine(lastPoint?.unclaimedRewards)],
        ]),
        atEnd.length
          ? table(
            ['Reserve', 'Supplied', 'Supplied USD', 'Borrowed', 'Borrowed USD', 'Collateral'],
            shown.map(({ r, p }) => [
              `${assetLabel(r.asset)} (#${r.asset.assetId})`,
              p!.supplied === '0' ? '0' : formatAmount(p!.supplied, r.asset.decimals),
              p!.supplied === '0' ? '' : p!.suppliedUsd == null ? DASH : formatUsd(p!.suppliedUsd),
              p!.borrowed === '0' ? '0' : formatAmount(p!.borrowed, r.asset.decimals),
              p!.borrowed === '0' ? '' : p!.borrowedUsd == null ? DASH : formatUsd(p!.borrowedUsd),
              p!.collateral == null ? 'unknown' : p!.collateral ? 'yes' : 'no',
            ]),
          )
          : note(heldAtEnd ? 'No reserve amount is stated at the last point (it predates the reserve coverage floor, or none could be priced).' : `Nothing held in this market at the ${windowed ? 'window\'s ' : ''}last point.`),
        atEnd.length > shown.length ? note(`${atEnd.length - shown.length} further reserve(s) held at the last point not shown; raise \`limit\`.`) : '',
        earlier > 0 ? note(`${formatCount(earlier)} reserve(s) held earlier in the reading and not at its last point.`) : '',
      ),
    }
  })

  const lastSupplied = supplied[lastBucket] ?? null
  const lastBorrowed = borrowed[lastBucket] ?? null
  const lastRewards = rewardsUsd[lastBucket] ?? null
  const lastRewardsIncomplete = rewardsIncomplete[lastBucket] ?? 0
  const markdown = fit(joinBlocks(
    `## Money-market history — ${shortAddress(address)}`,
    kv([
      ['Window', windowLine],
      ['Points', pointsLine],
      ['Priced at', `closed ${grain} candles (${mm.priceGrain})`],
      ['Reserve amounts from', mm.reserveHistoryFrom
        ? `block ${formatCount(mm.reserveHistoryFrom.blockHeight)}${mm.reserveHistoryFrom.time ? ` (${formatTime(mm.reserveHistoryFrom.time)})` : ''} — earlier points carry only the observed health factor`
        : 'no coverage floor published — no reserve amount is stated'],
      ['Markets', markets.length ? markets.map(m => `${m.market} (\`${m.marketKey}\`)`).join(', ') : null],
      ['Unclaimed lending incentives at the last point (settled)', lastRewards == null && !lastRewardsIncomplete ? null
        : `${lastRewards == null ? DASH : formatUsd(lastRewards)}${lastRewardsIncomplete ? ` (+ ${formatCount(lastRewardsIncomplete)} reward(s) not stated or not priced, left out)` : ''}`],
      ['Account', accountUrl(base, address)],
    ]),
    dates.length
      ? section('Supplied and borrowed across the isolated markets — priced legs only', joinBlocks(
        kv([...statRows('Supplied', suppliedStats), ...statRows('Borrowed', borrowedStats)]),
        stated.length !== full.length ? note(`First/last/low/high range over the ${formatCount(full.length)} point(s) where every held leg was priced; ${formatCount(stated.length - full.length)} point(s) with an unpriced leg are left out.`) : '',
        stated.length < dates.length ? note(`${formatCount(dates.length - stated.length)} point(s) end before the reserve coverage floor and state no amounts (${DASH} below) — not zero.`) : '',
      ))
      : '',
    dates.length
      ? joinBlocks(
        section(`Sampled path (${sampled.length} of ${formatCount(dates.length)} points${stride > 1 ? `, every ${ordinal(stride)} point` : ''})`, pathTable),
        stride > 1 ? note('This is a SAMPLE, not the series — intermediate highs and lows are in the figures above, not in this table.') : '',
      )
      : '',
    section('Per market', marketBlocks.length ? joinBlocks(...marketBlocks.map(b => b.markdown)) : note(windowed ? 'This account held no money-market position in the window.' : 'This account has held no money-market position the index has seen.')),
    note('The markets are ISOLATED pools. Each health factor, collateral figure and threshold applies only to its own market — never average them, never add the collateral, and never read one market\'s health factor as the account\'s risk. The supplied/borrowed sums above add priced legs ACROSS markets and carry no health factor.'),
    note('A health factor here is the chain\'s own getUserAccountData AS OBSERVED at the block it names (after each of the account\'s money-market events, and periodically for borrowers) — carried between reads, never recomputed or interpolated for a point. It uses the Aave oracle, not the candles the amounts are valued at. First/last/lowest range over the observations the reading\'s points carry (the newest one at each point), not over every read between them.'),
    note(`Reserve amounts are what balanceOf returned at each point's block (interest accrued to it), valued at the ${grain} candle fully CLOSED by the bucket end and never back-filled; an unpriced leg is counted and left out, never valued at zero. So the last point is NOT \`get_account\`'s current money-market figures${windowed ? ' — and this reading is WINDOWED, so it ends at the window, not now' : ''}.`),
    rewardsUsd.some(v => v != null && v > 0) || rewardsIncomplete.some(n => n > 0)
      ? note('Unclaimed lending incentives are SETTLED at each point: the RewardsController\'s stored accrual plus each aToken\'s pending accrual up to the programme\'s last on-chain index update at or before the point — an active programme\'s emission since then is not in it, so the last point can sit below `get_account`\'s claimable (the chain\'s own getAllUserRewards now). They are never inside supplied USD. A reward the index cannot state (or that does not reconcile with the chain now) is counted, never valued. The off-chain PRIME programme (paid by the rewards distributor since 2026-11-20) is not in these settled points: its amounts exist only per accepted root, and `get_account` states what it owes now.')
      : '',
    markets.some(m => m.stakingBacked) ? note('A staking-backed market (GIGAHDX) supplies stHDX backed by HDX that stays locked in the wallet: its supplied side restates that HDX, which is why the account\'s Value leaves it out.') : '',
    note('Every figure is scoped to the account\'s related set (its substrate account plus any EVM address bound to it), not to one address.'),
  ), ctx, 'Narrow the block window or lower `limit`.')

  return output(ctx, markdown, {
    address,
    kind: 'money-market',
    measure: 'money-market reserves at each bucket end (balanceOf at that block) valued at closed candles; health factors as observed',
    window: window ?? null,
    url: accountUrl(base, address),
    asOf: dates.length ? { date: dates[lastBucket], block: blocks[lastBucket] ?? null } : null,
    stepSec: mm.stepSec,
    grid: daily ? 'daily' : 'step',
    pointSpacingSec: daily ? DAY_SEC : mm.stepSec,
    priceGrain: mm.priceGrain,
    reserveHistoryFrom: mm.reserveHistoryFrom ?? null,
    series: {
      points: dates.length,
      statedPoints: stated.length,
      fullyPricedPoints: full.length,
      suppliedUsd: { first: suppliedStats.first, last: suppliedStats.last, min: suppliedStats.min, max: suppliedStats.max },
      borrowedUsd: { first: borrowedStats.first, last: borrowedStats.last, min: borrowedStats.min, max: borrowedStats.max },
      suppliedUsdAtLast: lastSupplied,
      borrowedUsdAtLast: lastBorrowed,
      unpricedAtLast: unpriced[lastBucket] ?? 0,
      unclaimedRewardsUsdAtLast: lastRewards,
      rewardsIncompleteAtLast: lastRewardsIncomplete,
      sampleStride: stride,
      sampled: sampled.map(i => ({ date: dates[i] ?? null, block: blocks[i] ?? null, suppliedUsd: supplied[i] ?? null, borrowedUsd: borrowed[i] ?? null, unpriced: unpriced[i] ?? 0, unclaimedRewardsUsd: rewardsUsd[i] ?? null })),
    },
    // One entry per ISOLATED market: never merge two into one health factor.
    markets: marketBlocks.map(({ m, hf, lastPoint, heldAtEnd, atEnd, earlier }) => ({
      marketKey: m.marketKey,
      market: m.market,
      role: m.role,
      stakingBacked: m.stakingBacked,
      observedHealthFactor: {
        last: hf.last ? { healthFactor: hf.last.hf, ratio: hf.last.ratio, observedAtBlock: hf.last.block, time: hf.last.time } : null,
        lowest: hf.low ? { healthFactor: hf.low.hf, ratio: hf.low.ratio, observedAtBlock: hf.low.block, time: hf.low.time } : null,
        observations: hf.distinct,
      },
      lastPoint: lastPoint
        ? {
            date: dates[lastPoint.i] ?? null, heldAtLastBucket: heldAtEnd, suppliedUsd: lastPoint.suppliedUsd, borrowedUsd: lastPoint.borrowedUsd, netUsd: lastPoint.netUsd, unpriced: lastPoint.unpriced, eModeCategoryId: lastPoint.eModeCategoryId,
            unclaimedRewards: (lastPoint.unclaimedRewards ?? []).map(r => ({ asset: compactAsset(r.asset), amount: scaleAmount(r.amount, r.asset.decimals), valueUsd: r.valueUsd, settledAtBlock: r.settledAtBlock })),
          }
        : null,
      reservesAtLast: atEnd.slice(0, limit).map(({ r, p }) => ({
        asset: compactAsset(r.asset),
        aToken: r.aToken ? compactAsset(r.aToken) : null,
        supplied: scaleAmount(p!.supplied, r.asset.decimals),
        suppliedUsd: p!.suppliedUsd,
        borrowed: scaleAmount(p!.borrowed, r.asset.decimals),
        borrowedUsd: p!.borrowedUsd,
        collateral: p!.collateral,
      })),
      reservesAtLastNotShown: Math.max(0, atEnd.length - limit),
      reservesHeldEarlierOnly: earlier,
    })),
  })
}

/* ---- kind 'volume' ---- */

const MAX_VOLUME_BUCKET_ROWS = 5

/**
 * The 'volume' kind: `/explorer/address/:a/volume-history` or
 * `/explorer/tag/:t/volume-history` — the account page's "Trading" figure (the
 * netted per-trade model) on the value chart's grid. It reads nothing else.
 * The answer is the totals and a bucket summary (first, last, peak and the
 * busiest few), never the series.
 */
async function volumeHistoryAnswer(
  target: { address: string } | { tag: string },
  window: { fromBlock: number; toBlock: number } | undefined,
  limit: number,
  ctx: ToolContext,
) {
  const base = ctx.explorerBaseUrl
  const isTag = 'tag' in target
  const path = isTag
    ? `/explorer/tag/${encodeURIComponent(target.tag)}/volume-history`
    : `/explorer/address/${encodeURIComponent(target.address)}/volume-history`
  const subject = isTag ? `tag \`${target.tag}\`` : shortAddress(target.address)
  const url = isTag ? tagUrl(base, target.tag) : accountUrl(base, target.address)
  let v: AccountVolumeHistory
  try {
    v = await ctx.upstream.get<AccountVolumeHistory>(path, window, { ttlMs: 120_000, timeoutMs: 90_000 })
  } catch (err) {
    if (isTag) return failure(toolErrorFromUpstream(err, `The trading volume of tag ${target.tag}`))
    return failure(addressNotFound(err, target.address, `The trading volume of ${target.address}`))
  }

  const buckets = v.buckets ?? []
  const traded = buckets.filter(b => b.trades > 0 || b.volumeUsd > 0)
  const firstTraded = traded[0] ?? null
  const lastTraded = traded[traded.length - 1] ?? null
  const last = buckets[buckets.length - 1] ?? null
  const busiest = [...traded].sort((a, b) => b.volumeUsd - a.volumeUsd).slice(0, Math.min(limit, MAX_VOLUME_BUCKET_ROWS))
  const peak = busiest[0] ?? null
  const inView = buckets.reduce((sum, b) => sum + b.volumeUsd, 0)
  const tradesInView = buckets.reduce((sum, b) => sum + b.trades, 0)
  const windowed = window != null
  const bucketLine = (b: AccountVolumeHistory['buckets'][number] | null): string | null =>
    b == null ? null : `${formatUsd(b.volumeUsd)} · ${formatCount(b.trades)} trade(s) in ${formatTime(b.ts)} → ${formatTime(b.endTs)} (to block ${formatCount(b.blockHeight)})`

  const markdown = fit(joinBlocks(
    `## Trading volume — ${subject}`,
    kv([
      ['Last 24H', formatUsd(v.totals?.d1)],
      ['Last 7D', formatUsd(v.totals?.d7)],
      ['Last 30D', formatUsd(v.totals?.d30)],
      ['All time', `${formatUsd(v.totals?.all)}${isTag ? '' : ' — the account page\'s "Trading" figure'}`],
      ['Model holds trades through', v.asOfBlock == null ? 'nothing yet' : `block ${formatCount(v.asOfBlock)}`],
      ['Window', windowed ? `blocks ${formatCount(window.fromBlock)} → ${formatCount(window.toBlock)}: ${formatUsd(inView)} over ${formatCount(tradesInView)} trade(s)` : null],
      ['Buckets', buckets.length ? `${formatCount(buckets.length)} of ${formatDuration(v.stepSec)}, ${formatTime(buckets[0].ts)} → ${formatTime(last!.endTs)}; ${formatCount(traded.length)} with trades` : null],
      ['First bucket with trades', bucketLine(firstTraded)],
      ['Last bucket with trades', bucketLine(lastTraded)],
      ['Peak bucket', bucketLine(peak)],
      [isTag ? 'Tag' : 'Account', url],
    ]),
    busiest.length > 1
      ? section(`Busiest buckets (${busiest.length} of ${formatCount(traded.length)})`, table(
        ['Bucket', 'Volume', 'Trades'],
        busiest.map(b => [`${formatTime(b.ts)} → ${formatTime(b.endTs)}`, formatUsd(b.volumeUsd), formatCount(b.trades)]),
      ))
      : '',
    !traded.length ? note(windowed ? 'No trade in the window.' : 'No trade the index has seen.') : '',
    note('Trading volume counts every trade ONCE at the larger of its netted in-side and out-side — a routed or DCA trade\'s intermediate hops cancel — valued at the hourly candle closed by the trade. aToken wraps and the ICE solver pot\'s routes are not trading and are excluded. It is not pool volume (get_pools), which counts each fill in each pool it touched.'),
    note(isTag
      ? 'A tag SUMS its members: an OTC fill between two members counts once for each side, so the figure can exceed what the tag traded with outsiders.'
      : 'The figure is the account\'s RELATED SET (its substrate account, its bound EVM address and their EVM-side forms) — the same set as the account page — not one address.'),
    note(`The 24H / 7D / 30D totals trail the newest indexed block and ignore any window; the buckets lie on the value chart's grid (one wall-clock step, ~180 buckets, the last one live and shorter). The model is republished every derivations cycle (about ten minutes), so the newest trades can be missing until then.`),
  ), ctx, 'Lower `limit`.')

  return output(ctx, markdown, {
    ...(isTag ? { tag: target.tag } : { address: target.address }),
    kind: 'volume',
    measure: 'netted per-trade trading volume (the account page "Trading" figure), event-time USD',
    window: window ?? null,
    url,
    totals: v.totals,
    asOfBlock: v.asOfBlock,
    stepSec: v.stepSec,
    buckets: buckets.length,
    bucketsWithTrades: traded.length,
    inView: { volumeUsd: inView, trades: tradesInView },
    first: buckets[0] ? { ts: buckets[0].ts } : null,
    last,
    firstTraded,
    lastTraded,
    peak,
    busiest,
  })
}

const GET_ACCOUNT_HISTORY_DESCRIPTION = `How one account's value moved over time — the Explorer account chart's portfolio line, the per-asset balances behind it, the events that moved it, its liquidity positions, or its money-market positions and health factors.

Answers "did this wallet grow or bleed?", "when did it build the position?", "biggest inflows and outflows?", "how much was price rather than trading?". \`get_account\` is the position NOW; \`get_activity\` every action.

\`kind\`:
- 'portfolio' (default) — total USD over time plus the largest value events.
- 'balances' — per-asset token amounts over time (first/last/min/max).
- 'value-events' — only the events that moved the line, largest first.
- 'liquidity' — the LP value line (every priced position summed) and a per-position table (at most the 50 largest by last-held value, \`limit\` trims further): venue, held from→to, first/last/low/high USD, legs at the last held point (an Omnipool H2O leg reads \`+ x H2O\`).
- 'volume' — trading volume (each trade once, netted across its route): 24H/7D/30D/all-time (all time = the account page's "Trading"), first, last and peak buckets. \`tag\` instead of \`address\` sums a tag's members (a trade between two members counts for both).
- 'money-market' — per ISOLATED market (\`core\`, \`gigahdx\`, \`bil\`, …): last and lowest observed health factor with their blocks, supplied/borrowed USD, reserves at the last point (\`limit\` rows per market), plus cross-market priced supplied/borrowed sums and settled unclaimed lending incentives.

\`fromBlock\`/\`toBlock\` are BLOCK NUMBERS, given together; omit both for the whole indexed history ('value-events' applies the window after reading).

The answer is not the raw series: first/last/min/max with dates, the change, and at most 12 sampled points (stride stated).

The series is VALUE — holdings (balances, LP, unclaimed farm rewards and lending incentives) net of money-market debt — so its last point equals \`get_account\`'s Value, not gross holdings. It covers the RELATED SET (substrate account plus bound EVM address). Buckets are one wall-clock step sized to ~180 points; the last is live and shorter. A 'price' value event is not a transfer: it is the signed part of a move price alone explains.

'liquidity' traps: points are valued at the candle CLOSED by each bucket end, never back-filled, so the last point is NOT \`get_account\`'s current Value or LP USD. LP principal only: v3/Gamma uncollected fees excluded, unclaimed farm rewards stated beside the line. An unpriced position is COUNTED and left out, never valued at zero; Low/High span fully priced points only. Change includes deposits and withdrawals — not a return. Un-windowed on a sub-day step, points are daily. "Held at window end" means the window's last point, not now.

'money-market' traps: markets are ISOLATED — never average, blend or sum two health factors; the cross-market sums carry none. A health factor is getUserAccountData AS OBSERVED at its block (never recomputed; Aave-oracle prices). Reserve amounts are balanceOf at each point, valued at the closed candle; before the coverage floor (\`Reserve amounts from\`) amounts are absent, not zero; an unpriced leg is counted, never zero. So the last point is NOT \`get_account\`'s current figures. Unclaimed incentives ride beside the amounts, settled at each programme's last on-chain index update.`


const getAccountHistory: ToolDefinition = {
  name: 'get_account_history',
  title: 'Account portfolio history',
  description: GET_ACCOUNT_HISTORY_DESCRIPTION,
  inputSchema: historyInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(historyInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const { tag } = parsed.value
    const kind = parsed.value.kind ?? 'portfolio'
    const limit = parsed.value.limit ?? MAX_VALUE_EVENT_ROWS
    const { fromBlock, toBlock } = parsed.value
    if (tag != null && parsed.value.address != null) return failure(invalidArgument('Give `address` or `tag`, not both.'))
    if (tag != null && kind !== 'volume') return failure(invalidArgument(`\`tag\` applies to kind 'volume' only; kind '${kind}' reads one account — pass \`address\`.`))
    if (tag == null && parsed.value.address == null) return failure(invalidArgument(kind === 'volume' ? 'kind \'volume\' needs `address` (an account) or `tag` (a system tag id).' : '`address` is required.'))
    const address = parsed.value.address ?? ''
    if ((fromBlock == null) !== (toBlock == null)) {
      return failure(invalidArgument('fromBlock and toBlock must be given together — the history window is a block range, not an open-ended bound. Omit both for the account\'s whole indexed history.'))
    }
    if (fromBlock != null && toBlock != null && toBlock <= fromBlock) {
      return failure(invalidArgument(`toBlock (${toBlock}) must exceed fromBlock (${fromBlock}).`))
    }
    const encoded = encodeURIComponent(address)
    const base = ctx.explorerBaseUrl
    const now = new Date()
    const window = fromBlock != null && toBlock != null ? { fromBlock, toBlock } : undefined
    if (kind === 'liquidity') return liquidityHistoryAnswer(address, window, limit, ctx)
    if (kind === 'money-market') return moneyMarketHistoryAnswer(address, window, limit, ctx)
    if (kind === 'volume') return volumeHistoryAnswer(tag != null ? { tag } : { address }, window, limit, ctx)

    const wantsSeries = kind !== 'value-events'
    const wantsEvents = kind !== 'balances'
    const [seriesResult, eventsResult] = await Promise.allSettled([
      wantsSeries
        // `series=1` skips the per-asset reconstruction, which is most of the
        // payload and is only read for kind 'balances'.
        ? ctx.upstream.get<AccountHistory>(`/explorer/address/${encoded}/history`, { ...window, ...(kind === 'portfolio' ? { series: 1 } : {}) }, { ttlMs: 120_000, timeoutMs: 90_000 })
        : Promise.resolve(null),
      wantsEvents
        ? ctx.upstream.get<ValueEvent[]>(`/explorer/address/${encoded}/value-events`, undefined, { ttlMs: 60_000, timeoutMs: 90_000 })
        : Promise.resolve(null),
    ])

    // The read this kind is named after must succeed; the companion read may fail
    // and still leave a usable answer.
    const primary = kind === 'value-events' ? eventsResult : seriesResult
    if (primary.status === 'rejected') {
      const what = kind === 'value-events' ? `The value events for ${address}` : `The value history of ${address}`
      return failure(addressNotFound(primary.reason, address, what))
    }

    const errs: ToolError[] = []
    if (seriesResult.status === 'rejected') errs.push(toolErrorFromUpstream(seriesResult.reason, `The portfolio series for ${address}`))
    if (eventsResult.status === 'rejected') errs.push(toolErrorFromUpstream(eventsResult.reason, `The value events for ${address}`))

    const history = settledValue(seriesResult)
    const allEvents = settledValue(eventsResult) ?? []
    const events = window
      ? allEvents.filter(e => e.blockHeight >= window.fromBlock && e.blockHeight <= window.toBlock)
      : allEvents

    const series = history?.portfolioSeries ?? []
    const dates = history?.portfolioDates ?? []
    const blocks = history?.portfolioBlocks
    const stats = seriesStats(series, dates, blocks)
    const change = stats.first && stats.last ? stats.last.value - stats.first.value : null
    const changePct = meaningfulChangeFraction(stats)

    const indices = series.map((_, i) => i)
    const { sampled, stride } = samplePath(indices, MAX_SERIES_POINTS)
    const pathTable = table(
      ['Date', 'Block', 'Value USD'],
      sampled.map(i => [formatTime(dates[i]), formatCount(blocks?.[i]), formatUsd(series[i])]),
      'this account has no reconstructed value history',
    )

    const balanceRows = kind === 'balances'
      ? ((history?.balanceHistory ?? []) as {
        asset: { assetId: number; symbol: string; decimals: number }
        current: number
        points: { ts: string; blockHeight: number; balance: number }[]
      }[])
      : []
    const balanceTable = (() => {
      if (kind !== 'balances') return ''
      const withStats = balanceRows.map(r => {
        const values = (r.points ?? []).map(p => p.balance)
        const s = seriesStats(values, (r.points ?? []).map(p => p.ts), undefined)
        return { row: r, s }
      }).sort((a, b) => (b.row.current ?? 0) - (a.row.current ?? 0))
      const shown = withStats.slice(0, limit)
      return joinBlocks(
        table(
          ['Asset', 'Now', 'First', 'Last', 'Min', 'Max', 'Points'],
          shown.map(({ row, s }) => [
            assetLabelWithId(row.asset as never),
            formatNumber(row.current),
            s.first ? formatNumber(s.first.value) : DASH,
            s.last ? formatNumber(s.last.value) : DASH,
            s.min ? formatNumber(s.min.value) : DASH,
            s.max ? formatNumber(s.max.value) : DASH,
            formatCount((row.points ?? []).length),
          ]),
          'this account has no per-asset history in the window',
        ),
        withStats.length > shown.length ? note(`${withStats.length - shown.length} further asset(s) not shown; raise \`limit\` to see more.`) : '',
        note('Amounts are TOKEN units, already scaled by each asset\'s decimals — not USD.'),
      )
    })()

    const windowLine = window
      ? `blocks ${formatCount(window.fromBlock)} → ${formatCount(window.toBlock)}`
      : 'the account\'s whole indexed history'

    const markdown = fit(joinBlocks(
      `## ${kind === 'value-events' ? 'Value events' : kind === 'balances' ? 'Balance history' : 'Value history'} — ${shortAddress(address)}`,
      kv([
        ['Window', windowLine],
        ['Points', series.length ? `${formatCount(series.length)} buckets, ${formatTime(dates[0])} → ${formatTime(dates[dates.length - 1])}` : null],
        ['Account', accountUrl(base, address)],
      ]),
      kind !== 'value-events' && series.length
        ? section('Value line — holdings minus money-market debt, the same measure `get_account` reports as Value', kv(seriesStatsRows(stats)))
        : '',
      kind === 'portfolio'
        ? joinBlocks(
          section(`Sampled path (${sampled.length} of ${formatCount(series.length)} points${stride > 1 ? `, every ${ordinal(stride)} bucket` : ''})`, pathTable),
          stride > 1 ? note('This is a SAMPLE, not the series — intermediate highs and lows between the shown points are in the Low/High figures above, not in this table.') : '',
        )
        : '',
      kind === 'balances' ? section('Per-asset balances', balanceTable) : '',
      wantsEvents
        ? section(
          kind === 'value-events' ? 'Value events, largest first' : 'Largest value events',
          // An empty table would claim "nothing ever moved this account's
          // value", which is a statement about the chain. A failed read is a
          // statement about this server, and the two must not look alike.
          eventsResult.status === 'fulfilled'
            ? valueEventsTable(events, limit, base, now, allEvents.length - events.length)
            : note('The value events could not be read (see Errors below). This says nothing about whether any exist — it is a failure of this lookup, not a finding about the account.'),
        )
        : '',
      // The equality only holds for the whole history: a windowed series ends at
      // `toBlock`, and claiming that point IS the account's current Value would
      // date-stamp a stale figure as today's.
      note(`This series measures VALUE: holdings net of money-market debt, with the claimable unclaimed farm rewards and lending incentives inside holdings — each past point carries them as SETTLED at its bucket end (each farm as of its last on-chain sync, each lending programme as of its last on-chain index update), the live last point as they stand now (farms projected to the snapshot block, incentives the chain's own claimable), so the final step also carries the accrual since those updates. It is the line the Explorer account page draws and the measure \`get_account\` reports as Value — neither is the gross holdings total. ${window ? 'This reading is WINDOWED, so its last point is the value at the end of the window, not the account\'s value now; drop fromBlock/toBlock to end on the live figure.' : 'The last point here and that tool\'s Value figure are the same number.'}`),
      note('Every figure is scoped to the account\'s related set (its substrate account plus any EVM address bound to it), not to one address.'),
    ), ctx, 'Narrow the block window or lower `limit`.')

    return output(ctx, markdown, {
        address,
        kind,
        // Named for what it measures rather than for the upstream field: the
        // series is net of money-market debt, the same figure get_account
        // reports as `valueUsd`.
        measure: 'valueUsd — holdings minus money-market debt',
        window: window ?? null,
        url: accountUrl(base, address),
        series: kind === 'value-events' ? undefined : {
          points: series.length,
          dates: dates.length ? [dates[0], dates[dates.length - 1]] : [],
          first: stats.first,
          last: stats.last,
          min: stats.min,
          max: stats.max,
          changeUsd: change,
          changeFraction: changePct,
          sampleStride: stride,
          sampled: sampled.map(i => ({ date: dates[i] ?? null, block: blocks?.[i] ?? null, valueUsd: series[i] })),
        },
        balances: kind === 'balances'
          ? balanceRows.slice(0, limit).map(r => ({ asset: r.asset, current: r.current, points: (r.points ?? []).length }))
          : undefined,
        valueEvents: wantsEvents
          ? [...events]
            .sort((a, b) => Math.abs(b.valueUsd) - Math.abs(a.valueUsd))
            .slice(0, limit)
            .map(e => ({
              blockHeight: e.blockHeight,
              timestamp: e.timestamp,
              kind: e.kind,
              valueUsd: e.valueUsd,
              direction: e.direction ?? null,
              asset: e.asset ? compactAsset(e.asset) : null,
              assetIn: e.assetIn ? compactAsset(e.assetIn) : null,
              assetOut: e.assetOut ? compactAsset(e.assetOut) : null,
              counterparty: e.counterparty ? e.counterparty.address : null,
              dcaScheduleId: e.dcaScheduleId ?? null,
              dcaTrades: e.dcaTrades ?? null,
            }))
          : undefined,
        valueEventsTotal: wantsEvents ? events.length : undefined,
    }, errs)
  },
}

/* ============ list_accounts ============ */

// The directory's real sort vocabulary (`accountSortSchema` in
// api/src/routes/explorer.ts). An unknown value falls back to `value` upstream
// WITHOUT an error, so the enum is pinned here instead: a silent fallback would
// otherwise let an agent believe it had sorted by something it had not.
const ACCOUNT_SORTS = ['value', 'supplied', 'borrowed', 'health', 'identity', 'activity', 'volume', 'liquidation', 'revenue'] as const
const RISK_SORTS: ReadonlySet<string> = new Set(['supplied', 'borrowed', 'health'])

/**
 * The row field each sort orders on, so the answer can say when the rows do not
 * carry it. A tag's member rows, for instance, come back without
 * `tradingVolumeUsd` or `activityCount` at all — the ordering is then the
 * upstream's word, unverifiable from the columns, and saying so is better than
 * presenting an order the figures do not support.
 */
const SORT_FIELD: Record<string, (r: TopAccountRow) => unknown> = {
  value: r => r.portfolioUsd,
  supplied: r => r.suppliedUsd,
  borrowed: r => r.borrowedUsd,
  health: r => r.healthFactor,
  identity: r => r.identity ?? r.account?.identity?.display,
  activity: r => r.activityCount,
  volume: r => r.tradingVolumeUsd,
  liquidation: r => r.liquidationVolumeUsd,
  revenue: r => r.revenueUsd,
}

const listAccountsInputShape = {
  sort: z.enum(ACCOUNT_SORTS).optional().describe(
    "Default 'value' (portfolio USD). 'supplied'/'borrowed': primary money market; 'activity': swept count; 'volume': lifetime trading; 'liquidation': volume liquidated; 'revenue': Protocol Revenue from it.",
  ),
  tag: z.string().min(1).max(64).optional().describe(
    "One system tag's members (e.g. 'treasury', 'omnipool'); `search` names tags.",
  ),
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Rows to return (default 25).'),
  offset: z.coerce.number().int().min(0).max(20_000_000).optional().describe('Rows to skip, for paging (default 0).'),
  format: formatParam,
}

function accountsTable(rows: TopAccountRow[], startRank: number, sort: string, base: string): string {
  const risk = RISK_SORTS.has(sort)
  const headers = ['#', 'Account', 'Value', 'Activity', 'Volume', ...(risk ? ['Supplied', 'Borrowed', 'Health'] : []), 'Last seen']
  const body = rows.map((r, i) => {
    const label = r.account
      ? accountLabel(r.account, { withAddress: true })
      : r.tag
        ? `${tagIcon(r.tag.icon)}${userLine(r.tag.name, 64)} — ${r.tag.memberCount} account${r.tag.memberCount === 1 ? '' : 's'} folded into one row`
        : DASH
    const href = r.account ? accountUrl(base, r.account.address) : null
    return [
      String(startRank + i),
      href ? explorerLink(label, href) : label,
      formatUsd(r.portfolioUsd),
      // Absent means "the sweep has not established a count", which is not zero.
      r.activityCount == null ? DASH : `${formatCount(r.activityCount)}${r.activityCountComplete === false ? '+' : ''}`,
      r.tradingVolumeUsd == null ? DASH : formatUsd(r.tradingVolumeUsd),
      ...(risk ? [
        r.suppliedUsd == null ? DASH : formatUsd(r.suppliedUsd),
        r.borrowedUsd == null ? DASH : formatUsd(r.borrowedUsd),
        r.healthFactor == null ? DASH : formatHealthFactor(r.healthFactor),
      ] : []),
      formatCount(r.lastBlock),
    ]
  })
  return table(headers, body, 'the directory returned no row for this query')
}

const LIST_ACCOUNTS_DESCRIPTION = `The account directory: who holds, trades or borrows the most, or sits closest to liquidation.

Use it to FIND accounts; \`get_account\` reads one, \`get_activity\` shows what they did, \`search\` finds a known name.

\`sort\`: value, supplied, borrowed, health, identity, activity, volume, liquidation, revenue — anything else is rejected rather than silently becoming 'value' as upstream would. 'health' ascends (riskiest first), 'identity' is alphabetical, the rest descend.

\`tag\` narrows to one system tag's members ('treasury', 'kraken', 'sovereigns', 'money-market', 'pallet-pots', …) — a fixed, code-defined set.

Reading the rows:
- A row with no address is a GROUP row: one system tag folded, its figures the members' total.
- An empty Activity cell means no count yet, NOT zero; a trailing '+' means the account runs deeper than the counted window.
- Supplied/Borrowed/Health (risk sorts only) are the PRIMARY money market only; the isolated markets (\`gigahdx\`, \`bil\`, …) are never comparable — read one account per market with \`get_account\`.
- A health factor of 0 is real: debt with no collateral left.
- Value is holdings NET of money-market debt (the account page's figure), negative when debt exceeds holdings.`


const listAccounts: ToolDefinition = {
  name: 'list_accounts',
  title: 'Account directory',
  description: LIST_ACCOUNTS_DESCRIPTION,
  inputSchema: listAccountsInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(listAccountsInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const sort = parsed.value.sort ?? 'value'
    const limit = parsed.value.limit ?? 25
    const offset = parsed.value.offset ?? 0
    const tag = parsed.value.tag
    const base = ctx.explorerBaseUrl

    let page: AccountsPage
    try {
      page = tag
        // The members route serves the same row shape and the same sort
        // vocabulary as the directory, but pages nothing: it returns the whole
        // member list, so the window is applied below.
        ? await ctx.upstream.get<AccountsPage>(`/explorer/tag/${encodeURIComponent(tag)}/members`, { sort }, { ttlMs: 30_000, timeoutMs: 90_000 })
        : await ctx.upstream.get<AccountsPage>('/explorer/accounts', { sort, limit, offset }, { ttlMs: 30_000, timeoutMs: 90_000 })
    } catch (err) {
      if (tag && err instanceof UpstreamError && err.status === 404) {
        return failure({ code: 'NOT_FOUND', message: `There is no system tag ${JSON.stringify(tag)} (a tag with no members reads the same way). Tags are a fixed code-defined set — 'treasury', 'money-market', 'omnipool', 'kraken', 'sovereigns', 'pallet-pots' and the like. Call \`search\` with the name to find the right id.` })
      }
      return failure(toolErrorFromUpstream(err, tag ? `The members of tag ${tag}` : 'The account directory'))
    }

    const allRows = page.rows ?? []
    const rows = tag ? allRows.slice(offset, offset + limit) : allRows.slice(0, limit)
    const total = page.total ?? allRows.length
    const shownFrom = offset + 1
    const shownTo = offset + rows.length

    const markdown = fit(joinBlocks(
      `## ${tag ? `Accounts tagged ${escapeCell(tag)}` : 'Account directory'} — by ${sort}`,
      kv([
        ['Showing', rows.length ? `rank ${formatCount(shownFrom)}–${formatCount(shownTo)} of ${formatCount(total)}` : `no rows at offset ${formatCount(offset)} (${formatCount(total)} in total)`],
        ['Ordering', sort === 'health' ? 'health factor ascending — the riskiest primary-market positions first' : sort === 'identity' ? 'on-chain identity, alphabetical' : `${sort} descending`],
      ]),
      accountsTable(rows, shownFrom, sort, base),
      note('`Value` is holdings minus money-market debt — the same measure the Explorer account page shows and `get_account` reports, so a row here and that account\'s own reading agree. It is not the gross holdings figure.'),
      page.rankedDepth != null && shownTo > page.rankedDepth
        ? note(`Only the first ${formatCount(page.rankedDepth)} rows are provably ordered; past that the ranking is indicative.`)
        : '',
      RISK_SORTS.has(sort)
        ? note('Supplied, Borrowed and Health are the PRIMARY money market only. Hydration runs several isolated markets besides it, each with its own health factor, and figures are never blended across them. Read one account\'s per-market position with `get_account`.')
        : '',
      allRows.some(r => r.account == null && r.tag != null)
        ? note('A row without an address folds a whole system tag\'s members into one line; its figures are the tag total.')
        : '',
      allRows.some(r => r.activityCount == null)
        ? note('An empty Activity cell means the count has not been established for that account — not that it is zero.')
        : '',
      rows.length > 0 && rows.every(r => SORT_FIELD[sort]?.(r) == null)
        ? note(`These rows carry no \`${sort}\` figure at all, so the ordering is the directory's own and cannot be checked against the columns shown.`)
        : '',
    ), ctx, 'Lower `limit`.')

    return output(ctx, markdown, {
      sort,
      tag: tag ?? null,
      limit,
      offset,
      total,
      rankedDepth: page.rankedDepth ?? null,
      rows: rows.map((r, i) => ({
        rank: shownFrom + i,
        address: r.account?.address ?? null,
        label: r.account ? accountLabel(r.account) : r.tag ? `${userLine(r.tag.name, 64)} (${r.tag.memberCount} accounts folded)` : null,
        // A group row has no address: its figures are one system tag's total.
        tagGroup: r.tag ? { tagId: r.tag.tagId, name: r.tag.name, memberCount: r.tag.memberCount } : null,
        // Net of money-market debt, exactly like get_account's `valueUsd` and
        // the Explorer account page's headline — the directory already computes
        // it that way, so the two surfaces state one measure.
        valueUsd: r.portfolioUsd,
        activityCount: r.activityCount ?? null,
        activityCountComplete: r.activityCountComplete ?? null,
        tradingVolumeUsd: r.tradingVolumeUsd ?? null,
        liquidationVolumeUsd: r.liquidationVolumeUsd ?? null,
        revenueUsd: r.revenueUsd ?? null,
        // Primary market only, and never merged with `supplementalMarket`:
        // the two are isolated markets with independent health factors.
        primaryMarket: { suppliedUsd: r.suppliedUsd, borrowedUsd: r.borrowedUsd, healthFactor: r.healthFactor ?? null },
        supplementalMarket: r.supplementalMarket ?? null,
        lastBlock: r.lastBlock,
        url: r.account ? accountUrl(base, r.account.address) : null,
      })),
    })
  },
}

export const accountTools: ToolDefinition[] = [getAccount, getAccountHistory, listAccounts]
