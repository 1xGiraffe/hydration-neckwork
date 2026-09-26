import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import type { AccountRef, AddressDetail, AssetRef, MmReserve, MoneyMarketDashboard, MoneyMarketPosition } from '../types.ts'
import {
  DASH, formatAmount, formatBase1e8, formatBasisPoints, formatCount, formatHealthFactor, formatNumber, formatPercent, formatUsd,
} from '../format/units.ts'
import { formatTime, relativeAge } from '../format/time.ts'
import { accountLabel, accountUrl, assetLabelWithId, assetUrl, explorerLink } from '../format/refs.ts'
import { bullets, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { failure, fit, output, parseInput } from './shared.ts'

/* ============ shapes this surface carries that types.ts does not mirror ============ */

/**
 * `/explorer/security` → `risk.markets`. One row per ISOLATED lending market —
 * the primary ("core") market and each supplemental one — and the only place on
 * this surface that sizes them separately. The explorer's own money-market page
 * is the Security page's money-market section, and it reads exactly this.
 */
interface MarketSolvency {
  key: string
  label: string
  role: 'primary' | 'supplemental'
  borrowers: number
  debtUsd: number
  collateralUsd: number
  underwaterCount: number
  underwaterDebtUsd: number
  underwaterCollateralUsd: number
  badDebtCount: number
  badDebtUsd: number
  liquidatableCount: number
  liquidatableDebtUsd: number
  nearLiquidationCount: number | null
  nearLiquidationDebtUsd: number | null
}

interface SecurityRisk {
  /** The index head the solvency figures were computed at. */
  head?: { blockHeight: number; blockTimestamp: string }
  risk?: {
    windowDays: number
    markets?: MarketSolvency[]
    liquidations?: { day: number; week: number; month: number; total: number; lastTimestamp: string | null }
  }
}

/** `/explorer/hdx` → `gigaMarket`: the GIGAHDX market's reserves, already scaled. */
interface GigaReserve {
  asset: AssetRef
  supplied: number
  suppliedUsd: number
  debt: number
  debtUsd: number
  suppliers: number
  borrowers: number
}
interface HdxGigaMarket {
  gigaMarket?: GigaReserve[] | null
}

const INPUT_SHAPE = {
  account: z.string().trim().min(1).max(128).optional().describe("One account's lending position, per isolated market. Accepts an SS58 address of any prefix, a raw AccountId32, or a bound EVM H160."),
  market: z.string().trim().min(1).max(48).optional().describe("Narrow to one ISOLATED market by key or label: 'core' (or 'primary') for the primary Money Market, 'gigahdx', 'bil'. Omit for every market, rendered separately."),
  format: formatParam,
}

/* ============ description ============ */

const DESCRIPTION = `What is lent, what is borrowed, and at what risk — across Hydration's lending markets, and for one account inside them.

With no arguments it returns the market picture: the primary market's pledged collateral and its debt (the route publishes no supply figure, so neither does this tool, and there is therefore no utilisation to report — utilisation is borrowed over supplied per reserve and is not on this surface), then one block PER ISOLATED MARKET — the primary market (key 'core', labelled "Money Market"), GIGAHDX, and BIL — each with its borrower count, collateral, debt, positions under water, unrecoverable bad debt and positions within 5% of their liquidation threshold; the GIGAHDX reserve table (supplied, borrowed, suppliers, borrowers per asset); 30-day liquidation counts; and the riskiest primary-market borrowers by health factor, lowest first.

With 'account' set it adds that account's position, again one block per market: health factor, collateral, debt, remaining borrowing headroom, loan-to-value, liquidation threshold, and every reserve the account supplies or owes in that market, with the collateral flag.

THE RULE THAT GOVERNS EVERY NUMBER HERE: these markets are ISOLATED. A position in GIGAHDX is not backed by collateral in the primary market and cannot be liquidated by it, so their health factors, collateral and debt are never blended, never averaged and never summed into one risk figure. Each block names its market explicitly. An account healthy in one market can be under water in another; the account's risk is the LOWEST real health factor among its markets, and this tool states which market that is rather than leaving it to be inferred. 'market' narrows the answer to one of them ('core'/'primary', 'gigahdx', 'bil') and then the primary market's totals and borrower list are omitted rather than leading with another market's numbers. Every reading states the snapshot it was taken from.

Encodings, which differ inside one object and are easy to misread by four orders of magnitude: health factors are 1e18-scaled and carry two string sentinels — 'inf' means no debt at all (printed as "∞ (no debt)"), 'unknown' means the position could be priced but not risk-rated; collateral, debt and borrowing-headroom figures are 1e8-scaled USD; loan-to-value and liquidation threshold are BASIS POINTS (8500 = 85.00%). All of that is decoded before it is printed here.

Not on this surface: per-reserve interest rates, supply caps and borrow caps are not published by the explorer API, so this tool does not show them rather than inventing them. For an account's whole balance sheet including non-lending holdings use get_account; for liquidation events as they happen use get_activity with type 'mm'.`

/* ============ market-level rendering ============ */

/** Case-insensitive match of the `market` filter against a market's key or label. */
function marketMatches(filter: string | undefined, key: string, label: string): boolean {
  if (!filter) return true
  const f = filter.trim().toLowerCase()
  if (f === 'primary') return key.toLowerCase() === 'core'
  return key.toLowerCase() === f || label.toLowerCase() === f
}

function renderMarkets(markets: MarketSolvency[]): string {
  const rows = markets.map(m => [
    `${m.label} (\`${m.key}\`)`,
    m.role,
    formatCount(m.borrowers),
    formatUsd(m.collateralUsd),
    formatUsd(m.debtUsd),
    m.underwaterCount > 0 ? `${formatCount(m.underwaterCount)} · ${formatUsd(m.underwaterDebtUsd)}` : 'none',
    m.badDebtCount > 0 ? `${formatCount(m.badDebtCount)} · ${formatUsd(m.badDebtUsd)}` : 'none',
    m.nearLiquidationCount == null ? DASH : m.nearLiquidationCount > 0 ? `${formatCount(m.nearLiquidationCount)} · ${formatUsd(m.nearLiquidationDebtUsd)}` : 'none',
  ])
  return table(
    ['Market', 'Role', 'Borrowers', "Borrowers' collateral", 'Debt', 'Under water', 'Bad debt', 'Within 5%'],
    rows,
    'no market solvency rows in this response',
  )
}

function renderGigaReserves(reserves: GigaReserve[]): string {
  const rows = reserves.map(r => [
    assetLabelWithId(r.asset),
    `${formatNumber(r.supplied)} (${formatUsd(r.suppliedUsd)})`,
    `${formatNumber(r.debt)} (${formatUsd(r.debtUsd)})`,
    formatCount(r.suppliers),
    formatCount(r.borrowers),
  ])
  return table(['Reserve', 'Supplied', 'Borrowed', 'Suppliers', 'Borrowers'], rows, 'the GIGAHDX market lists no reserves')
}

/* ============ account-level rendering ============ */

function reserveTable(reserves: MmReserve[] | undefined, ctx: ToolContext): string {
  const rows = (reserves ?? [])
    .filter(r => r.supplied !== '0' || r.debt !== '0')
    .sort((a, b) => ((b.suppliedUsd ?? 0) + (b.debtUsd ?? 0)) - ((a.suppliedUsd ?? 0) + (a.debtUsd ?? 0)))
    .map(r => [
      explorerLink(`${r.symbol} (#${r.assetId})`, assetUrl(ctx.explorerBaseUrl, r.assetId)),
      r.supplied === '0' ? DASH : `${formatAmount(r.supplied, r.decimals)} (${formatUsd(r.suppliedUsd)})`,
      r.debt === '0' ? DASH : `${formatAmount(r.debt, r.decimals)} (${formatUsd(r.debtUsd)})`,
      r.collateral ? 'yes' : 'no',
    ])
  return table(['Reserve', 'Supplied', 'Borrowed', 'Collateral'], rows, 'this position holds no reserve with a balance')
}

/** "Money Market market" reads badly; the word is only added when it is missing. */
const marketName = (label: string): string => (/market$/i.test(label.trim()) ? label : `${label} market`)

function renderPosition(p: MoneyMarketPosition, ctx: ToolContext): string {
  return joinBlocks(
    h3(`${marketName(p.market)} (\`${p.marketKey}\`, ${p.role})`),
    kv([
      ['Health factor', `${formatHealthFactor(p.healthFactor)} — in the ${marketName(p.market)} only`],
      ['Collateral', formatBase1e8(p.totalCollateralBase)],
      ['Supplied', p.totalSuppliedBase == null ? null : formatBase1e8(p.totalSuppliedBase)],
      ['Debt', formatBase1e8(p.totalDebtBase)],
      ['Borrowing headroom', formatBase1e8(p.availableBorrowsBase)],
      ['Max LTV', formatBasisPoints(p.ltv)],
      ['Liquidation threshold', formatBasisPoints(p.liquidationThreshold)],
      ['Staking-backed', p.stakingBacked ? 'yes' : null],
      ['Collateral not stated per reserve', p.unstatedCollateral?.length ? `${p.unstatedCollateral.map(a => a.symbol).join(', ')} — reached the holder outside the market's logs or has no price here; the market's own collateral figure stands in for it in Supplied and the account value` : null],
      // A zero blockHeight is "this was read live, not from an indexed
      // position"; printed as "block 0" it reads as a genesis-era snapshot.
      ['As of', `${formatTime(p.timestamp)}${p.blockHeight > 0 ? ` · block ${formatCount(p.blockHeight)}` : ' · read live from chain state, not from an indexed block'}`],
    ]),
    reserveTable(p.reserves, ctx),
  )
}

/**
 * The account's risk, said once and correctly: the LOWEST real health factor
 * among its isolated markets, named with the market it belongs to. Positions
 * with no debt ('inf') and unrated ones ('unknown') are not candidates — they
 * are not numbers on the same scale, and letting either win would report an
 * account as safe because one of its markets is empty.
 */
function riskiestMarket(positions: MoneyMarketPosition[]): MoneyMarketPosition | null {
  let worst: MoneyMarketPosition | null = null
  let worstValue = Infinity
  for (const p of positions) {
    const raw = String(p.healthFactor ?? '').trim().toLowerCase()
    if (!raw || raw === 'inf' || raw === 'unknown') continue
    const value = Number(formatHealthFactor(p.healthFactor))
    if (!Number.isFinite(value)) continue
    if (value < worstValue) { worstValue = value; worst = p }
  }
  return worst
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) return failure(parsed.error)
  const { account, market } = parsed.value
  const errors: ToolError[] = []

  const wantsGiga = marketMatches(market, 'gigahdx', 'GIGAHDX')

  const [mmRes, secRes, hdxRes, addrRes] = await Promise.allSettled([
    ctx.upstream.get<MoneyMarketDashboard>('/explorer/money-market', { limit: 50 }, { ttlMs: 10_000 }),
    ctx.upstream.get<SecurityRisk>('/explorer/security', undefined, { ttlMs: 30_000 }),
    wantsGiga ? ctx.upstream.get<HdxGigaMarket>('/explorer/hdx', undefined, { ttlMs: 60_000 }) : Promise.resolve(null),
    account ? ctx.upstream.get<AddressDetail>(`/explorer/address/${encodeURIComponent(account)}`, undefined, { ttlMs: 10_000, timeoutMs: 60_000 }) : Promise.resolve(null),
  ])

  if (mmRes.status === 'rejected') errors.push(toolErrorFromUpstream(mmRes.reason, 'The money-market totals'))
  if (secRes.status === 'rejected') errors.push(toolErrorFromUpstream(secRes.reason, 'Per-market solvency'))
  if (hdxRes.status === 'rejected') errors.push(toolErrorFromUpstream(hdxRes.reason, 'The GIGAHDX reserves'))
  if (addrRes.status === 'rejected') errors.push(toolErrorFromUpstream(addrRes.reason, `The money-market position of ${account}`))

  const dash = mmRes.status === 'fulfilled' ? mmRes.value : null
  const security = secRes.status === 'fulfilled' ? secRes.value : null
  const hdx = hdxRes.status === 'fulfilled' ? hdxRes.value : null
  const addr = addrRes.status === 'fulfilled' ? addrRes.value : null

  const allMarkets = security?.risk?.markets ?? []
  const markets = allMarkets.filter(m => marketMatches(market, m.key, m.label))
  const liq = security?.risk?.liquidations ?? null

  if (market && allMarkets.length > 0 && markets.length === 0) {
    return failure(invalidArgument(`There is no market called "${market}". The isolated markets are: ${allMarkets.map(m => `${m.label} (\`${m.key}\`)`).join(', ')}.`))
  }

  const primary = allMarkets.find(m => m.role === 'primary') ?? null
  // A filtered request must not lead with another market's numbers: the totals
  // route is primary-only, so it is rendered only when the primary market is
  // actually in scope.
  const primaryInScope = !market || (primary != null && marketMatches(market, primary.key, primary.label)) || marketMatches(market, 'core', 'Money Market')

  // When the figures were taken. The per-account view has always said this and
  // the protocol view must too — a solvency number with no timestamp reads as
  // "now", and these come from a snapshot that can be hours old.
  const snapshotBlock = (dash?.positions ?? []).reduce((max, p) => Math.max(max, p.blockHeight ?? 0), 0)
  const asOf = [
    snapshotBlock > 0 ? `the money-market snapshot at block ${formatCount(snapshotBlock)}` : null,
    security?.head?.blockTimestamp ? `solvency at the indexed head ${formatCount(security.head.blockHeight)} · ${formatTime(security.head.blockTimestamp)} (${relativeAge(security.head.blockTimestamp)})` : null,
  ].filter(Boolean).join('; ') || null

  /* --- protocol view ---
   *
   * `/explorer/money-market` answers `sum(total_collateral_base)` over every
   * primary-market position and `sum(total_debt_base)` over the same set —
   * COLLATERAL and DEBT, not supply. Two consequences this rendering has to
   * respect. Calling the first "total supplied" overstates it: an account can
   * supply an asset without enabling it as collateral, and that deposit is not
   * in this number. And debt divided by collateral is NOT utilisation —
   * utilisation is borrowed over supplied, per reserve, which this API does not
   * publish at all — so the ratio is named for what it is or it is not shown.
   */
  const totals = dash
    ? kv([
      ['Collateral pledged', formatUsd(dash.totalSupplyUsd)],
      ['Borrowed', formatUsd(dash.totalDebtUsd)],
      ['Borrowed against that collateral', dash.totalSupplyUsd > 0
        ? `${formatPercent((dash.totalDebtUsd / dash.totalSupplyUsd) * 100)} — this is debt over COLLATERAL, not utilisation. Utilisation is borrowed over supplied per reserve, and the explorer API publishes no per-reserve supply, so it cannot be computed here.`
        : DASH],
    ])
    : null

  const gigaReserves = wantsGiga && Array.isArray(hdx?.gigaMarket) ? hdx!.gigaMarket! : null

  // `MoneyMarketRow.supplyUsd` is `total_collateral_base / 1e8` — the position's
  // pledged COLLATERAL, exactly like the total above it, and `netWorthUsd` is
  // that minus the debt rather than the account's net worth. Naming the column
  // "Supplied" would reintroduce, per row, the misreading the totals block goes
  // out of its way to prevent.
  const borrowerRows = (dash?.positions ?? []).slice(0, 15).map(p => [
    explorerLink(accountLabel(p.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, p.account.address)),
    formatHealthFactor(p.healthFactor),
    formatUsd(p.supplyUsd),
    formatUsd(p.debtUsd),
    formatUsd(p.netWorthUsd),
  ])

  // A chain-wide `Liquidation.Liquidated` count with no market dimension. Under
  // a `market` filter it is the one figure on this surface that is NOT that
  // market's, so it says so rather than inheriting the heading's scope.
  const liquidationBlock = liq
    ? kv([
      ['Liquidations', `${formatCount(liq.day)} today · ${formatCount(liq.week)} this week · ${formatCount(liq.month)} in 30 days · ${formatCount(liq.total)} ever`],
      ['Last liquidation', liq.lastTimestamp ? `${formatTime(liq.lastTimestamp)} · ${relativeAge(liq.lastTimestamp)}` : null],
      ['Scope', market
        ? `CHAIN-WIDE, across every isolated market — these are NOT the ${market} market's liquidations, which the explorer does not count separately`
        : 'chain-wide, across every isolated market together — the explorer counts no per-market split'],
    ])
    : null

  /* --- account view --- */
  let accountBlock: string | null = null
  let accountPositions: MoneyMarketPosition[] = []
  if (addr) {
    accountPositions = (addr.moneyMarket ?? []).filter(p => marketMatches(market, p.marketKey, p.market))
    // The canonical display form is the EVM address when the account is bound,
    // otherwise the prefix-0 SS58 — the same choice `accountRef` makes for every
    // other account on this surface, so one account reads identically wherever
    // it appears. `ss58` is the prefix-63 Hydration form and is NOT that.
    const display = addr.evmAddress ?? addr.ss58Polkadot ?? addr.ss58
    const ref: AccountRef | null = display
      ? { accountId: addr.accountId, address: display, emoji: addr.emoji, tag: addr.tag, identity: addr.identity, profile: addr.profile }
      : null
    const who = ref
      ? explorerLink(accountLabel(ref, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, ref.address))
      : account!
    if (!accountPositions.length) {
      accountBlock = joinBlocks(
        h2(`Position of ${who}`),
        note(market
          ? `This account has no position in the ${market} market.`
          : 'This account has no money-market position in any market.'),
      )
    } else {
      const worst = riskiestMarket(accountPositions)
      const hidden = market ? (addr.moneyMarket ?? []).length - accountPositions.length : 0
      // "No health factor to rank" has two causes and they are different claims:
      // every position is debt-free ('inf'), or a position carries debt the
      // service could not rate ('unknown'). Saying "no debt" for the second
      // would report an indebted account as clear.
      const unrated = accountPositions.filter(p => String(p.healthFactor ?? '').trim().toLowerCase() === 'unknown')
      accountBlock = joinBlocks(
        h2(`Position of ${who}`),
        bullets([
          `${accountPositions.length} isolated market${accountPositions.length === 1 ? '' : 's'}${market ? ' in scope' : ''}: ${accountPositions.map(p => `${p.market} (\`${p.marketKey}\`)`).join(', ')}. Each is collateralised and liquidated on its own; the figures below are never combined.`,
          hidden > 0
            ? `\`market\` narrows this to ${market}: the account also holds ${formatCount(hidden)} position${hidden === 1 ? '' : 's'} in other isolated market${hidden === 1 ? '' : 's'}, which ${hidden === 1 ? 'is' : 'are'} not shown and ${hidden === 1 ? 'is' : 'are'} not ranked below. Drop \`market\` for the account's whole lending risk.`
            : null,
          worst
            ? `${market ? 'Among the markets shown, the' : 'For this account, the'} LOWEST real health factor is **${formatHealthFactor(worst.healthFactor)}**, in the ${marketName(worst.market)}. A liquidation there is not affected by the other markets' collateral.${hidden > 0 ? ' This is NOT necessarily the account\'s overall risk — a market left out by the filter may be worse.' : ''}`
            : unrated.length
              ? `No health factor here can be ranked: ${unrated.map(p => marketName(p.market)).join(', ')} read **unknown** — the position could be priced but not risk-rated, which is NOT the same as carrying no debt. Check the Debt line in each block below before treating this account as clear.`
              : 'No market here carries debt, so there is no health factor to rank — every position reads ∞ (no debt).',
        ]),
        ...accountPositions.map(p => renderPosition(p, ctx)),
      )
    }
  }

  const markdown = joinBlocks(
    h2(market ? `Money market — ${market}` : 'Money market'),
    asOf ? note(`As of ${asOf}.`) : null,
    market && !primaryInScope ? note(`Narrowed to ${market}: the primary market's totals and its riskiest-borrower list are left out, because they are another market's numbers.`) : null,
    note('Hydration runs SEVERAL ISOLATED lending markets. A health factor, a collateral figure and a debt figure belong to exactly one of them; they are never blended across markets, and neither is an account\'s risk.'),
    totals && primaryInScope ? joinBlocks(h3('Primary market totals'), totals, note(`Primary market only — the supplemental markets are sized separately below. The collateral figure sums every primary-market position; the "Collateral" column in the table below sums only the positions that are BORROWING, which is why the two differ.${asOf ? ` As of ${asOf}.` : ''}`)) : null,
    markets.length ? joinBlocks(h3('Markets, side by side'), renderMarkets(markets), note('"Under water" means collateral no longer covers debt at the liquidation threshold — transient by design, since anyone may then close the position for a fee. "Bad debt" is the part no liquidation can recover. "Within 5%" excludes positions whose proximity is structural (e-mode loops, isolation-mode collateral).')) : null,
    gigaReserves ? joinBlocks(h3('GIGAHDX market reserves'), renderGigaReserves(gigaReserves), note('These reserves belong to the GIGAHDX market alone. The explorer API publishes no per-reserve table for the primary market, and no interest rates or supply/borrow caps for any market, so none are shown here.')) : null,
    // Without this, a market narrowed to one that has no reserve route reads as
    // though it simply holds none.
    !gigaReserves && markets.length
      ? note('Only the GIGAHDX market publishes a per-reserve table on this surface; for every other market the explorer API exposes reserve-level rows only inside an account or tag position, so pass `account` to see them. Interest rates and supply/borrow caps are published for no market at all.')
      : null,
    liquidationBlock ? joinBlocks(h3('Liquidations'), liquidationBlock) : null,
    borrowerRows.length && primaryInScope
      ? joinBlocks(
        h3('Riskiest borrowers (primary market)'),
        table(['Account', 'Health factor', 'Collateral', 'Borrowed', 'Collateral − debt'], borrowerRows),
        note('The Collateral column is the position\'s PLEDGED collateral (`total_collateral_base`), not everything the account supplied — a deposit left un-enabled as collateral is not in it — and the last column is simply collateral minus debt, not the account\'s net worth. Ordered by health factor, lowest first, which is how the explorer orders it, so dust positions owing a fraction of a cent lead the list; read the Borrowed column before calling any of them a risk. Every figure here is the PRIMARY market\'s; a borrower may also hold an unrelated position in GIGAHDX or BIL.'),
      )
      : null,
    accountBlock,
  )

  return output(ctx, fit(markdown, ctx, 'Narrow with `market`, or ask for one `account`.'), {
    asOfBlock: snapshotBlock > 0 ? snapshotBlock : null,
    // Named for what the upstream actually sums, so no caller can read
    // `totalSupplyUsd` as supply: it is collateral over the primary market's
    // positions, and the debt is over the same set.
    primaryMarketTotals: dash && primaryInScope
      ? { collateralPledgedUsd: dash.totalSupplyUsd, borrowedUsd: dash.totalDebtUsd }
      : null,
    markets,
    gigaReserves,
    liquidations: liq,
    // Same renaming per row as for the totals: `supplyUsd` upstream is the
    // position's pledged collateral, and `netWorthUsd` is collateral − debt.
    riskiestBorrowers: primaryInScope
      ? (dash?.positions ?? []).slice(0, 15).map(p => ({
        account: p.account,
        healthFactor: p.healthFactor,
        collateralPledgedUsd: p.supplyUsd,
        borrowedUsd: p.debtUsd,
        collateralMinusDebtUsd: p.netWorthUsd,
        blockHeight: p.blockHeight,
      }))
      : [],
    account: account ? { address: account, positions: accountPositions } : null,
  }, errors)
}

export const moneyMarketTools: ToolDefinition[] = [{
  name: 'get_money_market',
  title: 'Lending markets, isolated',
  description: DESCRIPTION,
  inputSchema: INPUT_SHAPE,
  handler,
}]
