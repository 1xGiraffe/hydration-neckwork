import { z } from 'zod'
import { formatParam, type ToolDefinition, type ToolError } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import { UpstreamError } from '../upstream.ts'
import type {
  AccountRef,
  AccountHistory,
  AddressBalance,
  AddressDetail,
  ActiveDca,
  AccountsPage,
  ExplorerStats,
  LpPosition,
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
} from '../format/units.ts'
import { blocksToDuration, formatDuration, formatTime, relativeAge } from '../format/time.ts'
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
} from '../format/refs.ts'
import { bullets, escapeCell, h3, joinBlocks, kv, note, section, table } from '../format/md.ts'
import {
  addressNotFound, compactAsset, failure, fit, output,
  parseInput, portfolioValue, tagIcon, valueReconciliation,
} from './shared.ts'

/* ============ shared shape ============ */

const addressParam = z.string().min(1).max(128).describe(
  'The account, in any form the chain uses: SS58 of any prefix (Hydration 63, Polkadot 0, Kusama 2, generic 42), a raw AccountId32 (0x + 64 hex), or an EVM H160 (0x + 40 hex). An H160 bound to a substrate owner is re-anchored to that owner.',
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

/* ============ get_account ============ */

const ACCOUNT_SECTIONS = ['balances', 'positions', 'moneymarket', 'dca', 'orders', 'related', 'counts', 'revenue'] as const
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
    `Sections to build. Default: ${DEFAULT_ACCOUNT_SECTIONS.join(', ')}. 'counts' and 'revenue' each cost one extra upstream read and are off by default; an include set of only 'moneymarket', 'counts' and/or 'revenue' takes the cheap summary build of the account record.`,
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
  const extras = [
    d.identity.twitter ? `twitter ${d.identity.twitter}` : null,
    d.identity.web ? `web ${d.identity.web}` : null,
    d.identity.email ? `email ${d.identity.email}` : null,
  ].filter(Boolean).join(' · ')
  return `${d.identity.display} (${judged})${extras ? ` — ${extras}` : ''}`
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
    ['System tag', d.tag ? `${tagIcon(d.tag.icon)}${d.tag.name}` : null],
    ['On-chain identity', identityLine(d)],
    ['Profile name', d.profile?.name ? `${d.profile.name} (self-set, not on-chain)` : null],
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
  return kv([
    ['Value', `${formatUsd(value.valueUsd)}${hasDebt ? ' — holdings minus money-market debt, the figure the Explorer account page shows' : ''}`],
    ['Holdings (gross: balances + LP positions)', formatUsd(value.holdingsUsd)],
    ['Money-market debt (netted out above)', hasDebt ? formatUsd(value.moneyMarketDebtUsd) : null],
    ['Holdings excluding HDX', d.portfolioExHdxUsd != null ? formatUsd(d.portfolioExHdxUsd) : null],
    ['Value excluding HDX', d.portfolioExHdxUsd != null && hasDebt ? formatUsd(d.portfolioExHdxUsd - value.moneyMarketDebtUsd) : null],
    ['Top holdings (share of holdings)', top.length ? top.join(' · ') : null],
    ['Trading volume (lifetime)', d.tradingVolumeUsd != null ? formatUsd(d.tradingVolumeUsd) : null],
    ['Liquidation volume', d.liquidationVolumeUsd ? formatUsd(d.liquidationVolumeUsd) : null],
    ['Protocol revenue earned', d.revenueUsd != null ? formatUsd(d.revenueUsd) : null],
  ])
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
  return joinBlocks(
    table(headers, body, 'this account holds no balance the index has seen'),
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
  for (const [venue, list] of [...byVenue.entries()].sort((a, b) => sumUsd(b[1]) - sumUsd(a[1]))) {
    const sorted = [...list].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))
    const shown = sorted.slice(0, MAX_LP_ROWS)
    const rows = shown.map(p => [
      p.assetB ? `${assetLabel(p.asset)} / ${assetLabel(p.assetB)}` : assetLabelWithId(p.asset),
      p.assetB && p.amountB != null
        ? `${formatAmount(p.amount, p.asset.decimals, p.asset.symbol)} + ${formatAmount(p.amountB, p.assetB.decimals, p.assetB.symbol)}`
        : formatAmount(p.amount, p.asset.decimals, p.asset.symbol),
      p.valueUsd == null ? DASH : formatUsd(p.valueUsd),
      p.positionId,
    ])
    blocks.push(joinBlocks(
      `**${escapeCell(venue)}** — ${list.length} position${list.length === 1 ? '' : 's'}, ${formatUsd(sumUsd(list))}`,
      table(['Asset(s)', 'Amount', 'USD', 'Position'], rows),
      sorted.length > shown.length ? note(`${sorted.length - shown.length} smaller ${venue} position(s) not shown.`) : '',
    ))
  }
  return blocks.join('\n\n')
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
        ['Priced at', `block ${explorerLink(formatCount(p.blockHeight), blockUrl(base, p.blockHeight))} · ${formatTime(p.timestamp)} (${relativeAge(p.timestamp, now)})`],
      ]),
      table(
        ['Reserve', 'Supplied', 'Supplied USD', 'Debt', 'Debt USD', 'Collateral'],
        shown.map(r => [
          `${r.symbol} (#${r.assetId})`,
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
      d.remainingAmount == null ? 'open-ended' : formatAmount(d.remainingAmount, d.assetIn.decimals, d.assetIn.symbol),
      d.nextExecutionBlock == null ? DASH : formatCount(d.nextExecutionBlock),
      d.valueUsd == null ? DASH : formatUsd(d.valueUsd),
    ]
  })
  return joinBlocks(
    table(['Schedule', 'Trade', 'Per trade', 'Period', 'Fills', 'Filled', 'Remaining', 'Next block', 'USD/trade'], rows),
    dcas.length > shown.length ? note(`${dcas.length - shown.length} further schedule(s) not shown.`) : '',
    note(`\`Period\` is the observed spacing between fills where two fills exist, otherwise the scheduled block period converted at ${nominalBlockSec != null ? `this runtime's nominal ${nominalBlockSec}s slot time` : 'the nominal slot time — which could not be read, so those rows show the raw block count instead'}. \`Remaining\` is "open-ended" for a schedule with no total budget.`),
  )
}

function ordersBlock(orders: OpenLimitOrder[], base: string): string {
  if (!orders.length) return table(['Order', 'Sell', 'Buy'], [], 'this account has no open limit order')
  const shown = [...orders].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, MAX_ORDER_ROWS)
  const rows = shown.map(o => [
    explorerLink(`#${o.seq}`, intentUrl(base, o.intentId)),
    `${formatAmount(o.remainingIn, o.assetIn.decimals, o.assetIn.symbol)} → ${formatAmount(o.remainingOut, o.assetOut.decimals, o.assetOut.symbol)}`,
    o.limitPrice == null ? DASH : `${formatNumber(o.limitPrice)} ${o.assetOut.symbol}/${o.assetIn.symbol}`,
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
    kv([['Total revenue earned', formatUsd(revenue.totalUsd)]]),
    table(['Stream', 'USD', 'Top assets'], rows, 'this account has earned no protocol revenue'),
    revenue.streams.length > streams.length ? note(`${revenue.streams.length - streams.length} smaller stream(s) not shown.`) : '',
  )
}

const GET_ACCOUNT_DESCRIPTION = `The full interpreted reading of one Hydration account: who it is, what it holds, what it owes, and what it has standing open.

Answers "what does this address hold and owe?", "is this a wallet, a pallet pot, a contract or a multisig?", "is this position close to liquidation?", "what is it accumulating with DCA?". Prefer \`inspect_entity\` when you only need a quick identification of an address you are about to mention; use this when the holdings, the risk or the relationships are the answer. \`get_activity\` with an \`account\` gives what it DID; this gives what it IS.

\`address\` takes any form: SS58 of any prefix (Hydration 63, Polkadot 0, Kusama 2, generic 42 all decode to the same account), a raw AccountId32 (0x + 64 hex), or an EVM H160 (0x + 40 hex, re-anchored to its bound substrate owner). The answer echoes every form.

\`include\` selects sections; the default is balances, positions, moneymarket, dca, orders, related. Narrow it to spend fewer tokens on a big account. 'counts' (lifetime extrinsic/event/vote counts) and 'revenue' (protocol revenue earned, by stream) each add one upstream read and are off by default.

Two figures, and quoting the wrong one contradicts the page this answer links to. **Value** is holdings minus money-market debt: it is what the Explorer account page prints, what \`get_account_history\`'s series ends on, and what the account directory ranks by — quote it for "what is this account worth". **Holdings** is the gross total of every balance and LP position; assets pledged as money-market collateral are inside it, because an aToken is an ordinary balance, so never subtract the collateral from it a second time. For a leveraged account the two differ by more than half.

Traps this tool handles for you, which you must not undo when you quote its numbers:
- EVERY FIGURE IS SCOPED TO THE ACCOUNT'S RELATED SET, not to the address you asked about. Hydration folds a substrate account together with the EVM address bound to it, because they are one wallet. The answer states the set; attribute numbers to the set, not to one address.
- Hydration runs SEVERAL ISOLATED money markets — today the primary market (\`core\`), \`gigahdx\` and \`bil\`, and the set grows. Each has its own health factor, collateral and liquidation threshold, and a liquidation in one does not touch another. This tool prints them separately: never average them, never add their collateral, and never quote one as "the account's health factor" — the account's risk is the LOWEST health factor among the markets it is actually in, named with its market.
- Health factors here are real ratios (1.60 means 1.60); '∞ (no debt)' means the account owes nothing, which is not the same as a very large number.
- Amounts are scaled by each asset's own decimals (HOLLAR 18, USDC 6, DOT 10, HDX 12 all appear in one answer) and named with their symbol. Do not rescale them.
- An address that has never transacted still resolves, with an empty portfolio. A NOT_FOUND here means the string is not an address at all.`

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

    const [detailResult, countsResult, revenueResult, statsResult] = await Promise.allSettled([
      ctx.upstream.get<AddressDetail>(`/explorer/address/${encoded}`, summarized ? { summary: 1 } : undefined, { ttlMs: 8_000 }),
      sections.has('counts') ? ctx.upstream.get<TabCounts>(`/explorer/address/${encoded}/counts`, undefined, { ttlMs: 60_000 }) : Promise.resolve(null),
      sections.has('revenue') ? ctx.upstream.get<RevenueBreakdown>(`/explorer/address/${encoded}/revenue-breakdown`, undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
      // The runtime's nominal slot time, for the DCA block periods. Cheap, and
      // the alternative is a literal that goes silently wrong after a cadence
      // change (see `dcaBlock`).
      sections.has('dca') ? ctx.upstream.get<ExplorerStats>('/explorer/stats', undefined, { ttlMs: 30_000 }) : Promise.resolve(null),
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
      revenue ? section('Revenue earned', revenueBlock(revenue)) : '',
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
        holdingsExHdxUsd: detail.portfolioExHdxUsd ?? null,
        valueExHdxUsd: detail.portfolioExHdxUsd == null ? null : detail.portfolioExHdxUsd - value.moneyMarketDebtUsd,
        tradingVolumeUsd: detail.tradingVolumeUsd ?? null,
        liquidationVolumeUsd: detail.liquidationVolumeUsd ?? null,
        revenueUsd: detail.revenueUsd ?? null,
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
    }, errs)
  },
}

/* ============ get_account_history ============ */

const HISTORY_KINDS = ['portfolio', 'balances', 'value-events'] as const
const MAX_SERIES_POINTS = 12
const MAX_VALUE_EVENT_ROWS = 12

const historyInputShape = {
  address: addressParam,
  kind: z.enum(HISTORY_KINDS).optional().describe(
    "What to read. 'portfolio' (default) is the account's total USD value over time plus its largest value events; 'balances' is the per-asset token-amount reconstruction; 'value-events' is just the events that moved the value line.",
  ),
  fromBlock: z.coerce.number().int().min(0).max(0xffff_ffff).optional().describe('Start of the window as a BLOCK NUMBER, not a date. Must be given together with toBlock.'),
  toBlock: z.coerce.number().int().min(1).max(0xffff_ffff).optional().describe('End of the window as a BLOCK NUMBER, not a date. Must exceed fromBlock and be given together with it.'),
  limit: z.coerce.number().int().min(1).max(50).optional().describe('How many rows the value-event and per-asset tables may show (default 12). The sampled series path is always at most 12 points, whatever this says.'),
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

const GET_ACCOUNT_HISTORY_DESCRIPTION = `How one account's value moved over time — the portfolio line the Explorer's account chart draws, the per-asset balance reconstruction behind it, or the events that moved it.

Answers "did this wallet grow or bleed?", "when did it take its position on?", "what were its biggest inflows and outflows?", "how much of the change was price rather than trading?". Use \`get_account\` for the position as it stands NOW; use this for the path it took. Use \`get_activity\` scoped to the account when you want every action rather than the value line.

\`kind\`:
- 'portfolio' (default) — total USD over time, plus the largest value events in the window.
- 'balances' — per-asset token amounts over time (first/last/min/max per asset), for "when did it accumulate the DOT?".
- 'value-events' — only the events that moved the line, largest first.

\`fromBlock\`/\`toBlock\` are BLOCK NUMBERS, not dates, and must be given together — this route windows in block space because the series carries its end-of-bucket block heights. Leave both out for the account's whole indexed history. For 'value-events' the window is applied to the rows after they are read.

What you get back is deliberately NOT the raw series: a chart of a hundred-odd points spends a context window and tells a model nothing an aggregate does not. The answer is first/last/min/max with their dates, the change, and a sampled path of at most 12 points whose sampling stride is stated. If you need every point, ask the Explorer page the answer links to.

Notes: the series measures VALUE — holdings net of money-market debt — which is the line the Explorer account page draws and exactly what \`get_account\` reports as Value, so the last point of this series equals that figure rather than the gross holdings total. The series is the account's RELATED SET (substrate account plus its bound EVM address), same as \`get_account\`. Buckets are one wall-clock step wide, picked off a round-unit ladder (an hour up to months) so the whole span fits in about 180 points — hours on a short history, days on a multi-year one — and the final point is the live one, so the last interval is shorter than the rest. A 'price' value event is not a transfer — it is the portion of a move that price change alone explains, and its USD is signed.`

const getAccountHistory: ToolDefinition = {
  name: 'get_account_history',
  title: 'Account portfolio history',
  description: GET_ACCOUNT_HISTORY_DESCRIPTION,
  inputSchema: historyInputShape,
  async handler(input, ctx) {
    const parsed = parseInput(historyInputShape, input)
    if (!parsed.ok) return failure(parsed.error)
    const { address } = parsed.value
    const kind = parsed.value.kind ?? 'portfolio'
    const limit = parsed.value.limit ?? MAX_VALUE_EVENT_ROWS
    const { fromBlock, toBlock } = parsed.value
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
    // A percentage is only information when it has a baseline to be a
    // percentage OF. The first bucket of an account's whole history is usually
    // its funding transaction, so the ratio against it is arbitrarily large —
    // "+5358293.20%" says nothing except that the account started near zero.
    // The Explorer's own chart suppresses exactly these windows (see
    // `performancePoints`, minBase 1, maxRatio 20) and so does this.
    const MIN_PCT_BASE_USD = 1
    const MAX_PCT_RATIO = 20
    const baseline = stats.first?.value ?? 0
    const pctIsMeaningful = stats.first != null && stats.last != null
      && Math.abs(baseline) >= MIN_PCT_BASE_USD
      && Math.abs(stats.last.value) <= Math.abs(baseline) * MAX_PCT_RATIO
    const changePct = pctIsMeaningful ? (stats.last!.value - baseline) / Math.abs(baseline) : null

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
        ? section('Value line — holdings minus money-market debt, the same measure `get_account` reports as Value', kv([
          ['First', `${formatUsd(stats.first?.value)} on ${formatTime(stats.first?.date)}${stats.first?.block != null ? ` (block ${formatCount(stats.first.block)})` : ''}`],
          ['Last', `${formatUsd(stats.last?.value)} on ${formatTime(stats.last?.date)}${stats.last?.block != null ? ` (block ${formatCount(stats.last.block)})` : ''}`],
          ['Change', change == null
            ? null
            : `${change >= 0 ? '+' : '-'}${formatUsd(Math.abs(change))}`
              + (changePct != null
                ? ` (${formatPercentChange(changePct)})`
                : stats.first != null ? ` (no percentage: the window opens at ${formatUsd(baseline)}, so a ratio against it would say nothing about performance)` : '')],
          ['Low', stats.min ? `${formatUsd(stats.min.value)} on ${formatTime(stats.min.date)}` : null],
          ['High', stats.max ? `${formatUsd(stats.max.value)} on ${formatTime(stats.max.date)}` : null],
        ]))
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
      note(`This series measures VALUE: holdings net of money-market debt. It is the line the Explorer account page draws and the measure \`get_account\` reports as Value — neither is the gross holdings total. ${window ? 'This reading is WINDOWED, so its last point is the value at the end of the window, not the account\'s value now; drop fromBlock/toBlock to end on the live figure.' : 'The last point here and that tool\'s Value figure are the same number.'}`),
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
    "Ordering, all descending except 'health' and 'identity': 'value' (portfolio USD, the default), 'supplied'/'borrowed' (primary money market), 'health' (riskiest first — a health factor of 0 is an account with debt and no collateral left), 'identity' (alphabetical by on-chain identity, so it lists named accounts), 'activity' (swept activity count), 'volume' (lifetime trading volume), 'liquidation' (volume liquidated), 'revenue' (protocol revenue earned).",
  ),
  tag: z.string().min(1).max(64).optional().describe(
    "Restrict to the members of one system tag (e.g. 'treasury', 'kraken', 'sovereigns', 'money-market', 'omnipool', 'pallet-pots'). Tags are a fixed code-defined set; `search` or the tag directory names them. With a tag the upstream returns the whole member list at once, so `limit`/`offset` are applied here rather than by the server.",
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
        ? `${tagIcon(r.tag.icon)}${r.tag.name} — ${r.tag.memberCount} account${r.tag.memberCount === 1 ? '' : 's'} folded into one row`
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

const LIST_ACCOUNTS_DESCRIPTION = `The account directory: who holds the most, trades the most, borrows the most, or sits closest to liquidation.

Answers "who are the biggest holders?", "which accounts are most active?", "who is nearest liquidation?", "which accounts earn protocol revenue?". Use this to FIND accounts; use \`get_account\` to read one, and \`get_activity\` for what they did. \`search\` is the tool for a name you already know.

\`sort\` accepts exactly what the directory implements — value, supplied, borrowed, health, identity, activity, volume, liquidation, revenue — and nothing else; a value outside that list is rejected here rather than silently falling back to 'value' as the upstream would. 'health' ascends (riskiest first); everything else descends.

\`tag\` narrows to one system tag's members ('treasury', 'kraken', 'sovereigns', 'money-market', 'pallet-pots', …). Tags are a fixed, code-defined set — there are no user tags on this surface.

Reading the rows without misquoting them:
- A row with no address is a GROUP row: the directory folds a whole system tag into one line, and its portfolio is the tag's total across its members, not one account's.
- An empty Activity cell means the background sweep has not established a count for that account. It does NOT mean zero. A trailing '+' means the count is exact for the newest rows and the account runs deeper than the counted window.
- Supplied/Borrowed/Health are shown only for the risk sorts, and they are the PRIMARY money market only. Hydration runs several isolated markets (\`gigahdx\` and \`bil\` today, and the set grows), each with its own health factor; a position in one is never comparable with a position in another. Read one account's full, per-market position with \`get_account\`.
- A health factor of 0 is real: an account with debt and no remaining collateral value, not a missing figure.
- The Value column is holdings NET of money-market debt, the same figure the Explorer account page and \`get_account\` show; it is negative when debt exceeds holdings. It is not gross holdings.`

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
        label: r.account ? accountLabel(r.account) : r.tag ? `${r.tag.name} (${r.tag.memberCount} accounts folded)` : null,
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
