import { z } from 'zod'
import { formatParam, type ToolContext, type ToolDefinition, type ToolError, type ToolOutput } from '../toolTypes.ts'
import { invalidArgument, toolErrorFromUpstream } from '../errors.ts'
import type {
  AccountRef, AssetRef, PoolListEntry, PoolsIndex, RevenueDashboard, StakerDistributions,
} from '../types.ts'
import { DASH, formatAmount, formatCount, formatNumber, formatPercent, formatPercentChange, formatUsd, scaleAmount } from '../format/units.ts'
import { formatTime, formatUnixSeconds, relativeAge } from '../format/time.ts'
import { accountLabel, accountUrl, assetLabel, assetLabelWithId, assetUrl, explorerLink, poolUrl } from '../format/refs.ts'
import { bullets, h2, h3, joinBlocks, kv, note, table } from '../format/md.ts'
import { HUB_DECIMALS, HUB_SYMBOL, failure, fit, output, parseInput } from './shared.ts'
// One definition of "is this asset at or over its weight cap", shared with the
// pool tool so the two Omnipool tables cannot disagree.
import { capMarker } from './pools.ts'

/* ============ shapes types.ts does not mirror ============ */

interface RevenueFlowItem { stream: string; block: number; t: number; eventIndex: number; legIndex: number; account: AccountRef | null; assetId: number; usd: number }
interface RevenueFlow { items: RevenueFlowItem[]; drips: { key: string; label: string; stream: string; usdPerBlock: number }[]; cursor: string; head: number; blockSeconds: number }

interface HdxDashboard {
  price: number | null
  change24h: number | null
  supply: { totalHdx: number; protocolHdx: number; userHdx: number; holders: number }
  cohorts: { key: string; label: string; minPct: number; minHdx: number; accounts: number; totalHdx: number }[]
  locks: { types: { key: string; label: string; accounts: number; totalHdx: number }[]; totalLockedHdx: number; lockedPctOfUser: number; vestedUnclaimedHdx: number; snapshotAt: string }
  unlocks: {
    buckets: { label: string; fromTs: string; toTs: string; gigahdx: number; vesting: number; vote: number; other: number }[]
    laterHdx: Record<string, number>
    unlockableNowHdx: number
    nowHdx: Record<string, number>
    activeVoteHdx: number
    stakingAnytimeHdx: number
    gigaPending: { count: number; totalHdx: number; nextUnlockTs: string | null; maturedCount: number; maturedHdx: number } | null
  }
  flows: {
    daily: { date: string; buyHdx: number; sellHdx: number; buyers: number; sellers: number }[]
    dca: { buy: { orders: number; hdxPerDay: number }; sell: { orders: number; hdxPerDay: number } }
  }
  churn: { weekly: { weekStart: string; newHolders: number; exitedHolders: number }[] }
  topMovers: { accumulators: HdxMover[]; distributors: HdxMover[] }
  gigaMarket: { asset: AssetRef; supplied: number; suppliedUsd: number; debt: number; debtUsd: number; suppliers: number; borrowers: number }[] | null
}
interface HdxMover { account: AccountRef; balanceHdx: number; boughtHdx: number; soldHdx: number; netHdx: number }

interface HollarDashboard {
  price: number | null
  change24h: number | null
  pegDeviationBps: number | null
  peg: { within25bpsPct: number; maxDevBps: number; min30d: number; max30d: number; hourly: { ts: string; close: number }[] }
  supply: { total: number; holders: number; inStablepools: number; inOmnipool: number; other: number }
  hsm: {
    totalHoldingsUsd: number
    collaterals: {
      asset: AssetRef; poolId: number | null; holdings: string; holdingsUsd: number | null
      purchaseFeePct: number | null; buyBackFeePct: number | null; maxBuyPrice: number | null
      buybackRatePct: number | null; maxInHolding: string | null
      lastArbTs: string | null; lastArbDirection: string | null
    }[]
    lastArb: { ts: string; direction: string; asset: AssetRef; hollarAmount: number } | null
  }
  pools: { poolId: number; tvlUsd: number | null; hollar: { amount: number; usd: number }; partners: { asset: AssetRef; amount: number; usd: number }[]; hollarSharePct: number | null }[]
}

interface IceDashboard {
  status: { solverMode: string; protocolFeePpm: number | null; dcaMigrationEnabled: boolean; asOfBlock: number | null; uniswapV3?: Record<string, string> }
  openOrders: { total: number; limit: number; dca: number; byAsset: { asset: AssetRef; reserved: string; reservedUsd: number | null; orders: number }[] }
  fillsPerDay: { day: string; fills: number; solutions: number; usd: number; matchedUsd: number; routedUsd: number }[]
  quality: { medianTimeToFillSec: number | null; partialShare: number | null; cancelRate: number | null; expiryRate: number | null; priceVsLimitBp: { p10: number; p50: number; p90: number } | null }
  feeRevenue: { perDay: { day: string; usd: number }[]; potHoldings: { asset: AssetRef; amount: string; usd: number | null }[] }
  migration: { migrated: number; cancelled: number; remainingSchedules: number }
  topPairs: { assetIn: AssetRef; assetOut: AssetRef; fills: number; usd: number }[]
  generatedAt: string
}

interface SecurityFuse {
  asset: AssetRef; status: string; limit: string; used: string; limitUsd: number | null; usedUsd: number | null
  headroom: string; usagePct: number | null; untilBlock: number | null; periodEndBlock: number | null
  category: string; lockdownCount: number
}
interface SecurityPerBlockRow {
  asset: AssetRef; reserve: string; reserveUsd: number | null
  tradeLimitPct: number; addLimitPct: number; removeLimitPct: number
  peakPressurePct: number | null; peakBlockHeight: number | null; overridden: boolean; tradable: string[]
}
interface SecurityMarket { key: string; label: string; role: string; borrowers: number; debtUsd: number; collateralUsd: number; badDebtUsd: number; nearLiquidationDebtUsd: number | null }
interface SecurityDashboard {
  head: { blockHeight: number; blockTimestamp: string }
  chainBlock: number | null
  /**
   * The chain-wide egress accumulator. `limit` and `used` are **HDX**, not USD —
   * `WithdrawMeter` in explorer-ui/src/pages/Security.tsx prints them as
   * `used / limit HDX` — and every withdrawal is converted into HDX at its
   * ten-minute oracle price along its route, falling back to the fixed
   * fee-payment price where no route exists.
   */
  withdraw: {
    configured: boolean; limit: number | null; used: number | null; usagePct: number | null
    windowMs: number | null; lastCreditedMs?: number | null; lockdownUntilMs: number | null
    everTripped: boolean; externalAssetCount: number
  }
  fuses: { periodBlocks: number; rows: SecurityFuse[]; lockedCount: number; frozenCount: number; lockdownTotal: number; releaseTotal: number }
  perBlock: { defaultTradePct: number; defaultAddPct: number | null; defaultRemovePct: number | null; rows: SecurityPerBlockRow[]; peakWindowDays: number }
  trips: { total: number; enforcementTotal: number; directTotal: number; nestedTotal: number; byError: { name: string; count: number; enforcement: boolean }[] }
  freezes: { paused: { pallet: string; call: string; pausedAtTimestamp: string }[]; hubTradability: string[]; omnipool: unknown[]; omnipoolAssetCount: number; delisted: unknown[]; stableswap: unknown[] }
  risk: { windowDays: number; markets: SecurityMarket[]; liquidations: { day: number; week: number; month: number; total: number; lastTimestamp: string | null } }
  runtime: { specVersion: number; upgrades: number; lastUpgrade: { blockHeight: number; blockTimestamp: string } | null }
  timeline: { kind: string; label: string; detail: string | null; blockHeight: number; blockTimestamp: string; asset: AssetRef | null }[]
  guardians: { techCommittee: { size: number; majority: number; superMajority: number }; outstandingWhitelisted: { callHash: string; blockTimestamp: string }[] }
  wormhole: { assets: number; lockedUsd: number; issuanceUsd: number; inflightCount: number; queuedCount: number; worstStatus: string; deficitUsd: number; surplusUsd: number; asOf: string } | null
}

interface OmnipoolAsset { asset: AssetRef; reserve: string; reserveUsd: number | null; hubReserve: string; weightPct: number | null; capPct: number | null; tradable: string[] }
interface OmnipoolResponse { account: AccountRef; tvlUsd: number | null; assetCount: number; hubReserveTotal: string; lrnaPrice: number | null; assets: OmnipoolAsset[] }

/* ============ constants ============ */

const DASHBOARDS = ['revenue', 'hdx', 'hollar', 'ice', 'security', 'liquidity'] as const
type Dashboard = typeof DASHBOARDS[number]
const RANGES = ['30d', '1y', 'all'] as const


const hdx = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? DASH : `${formatNumber(n)} HDX`

const omnipoolPageUrl = (base: string): string => `${base.replace(/\/+$/, '')}/omnipool`
const liquidityPageUrl = (base: string): string => `${base.replace(/\/+$/, '')}/liquidity`

/* ============ description ============ */

const DESCRIPTION = `The protocol's own dashboards, each rendered as headline figures plus its top-N tables. One required argument, 'dashboard', picks which:

- 'revenue' — what the protocol earns. Totals for the day, week, month and all time; the split by stream (HOLLAR borrow interest, Omnipool asset and protocol fees, liquidation penalties, HSM revenue, network fees, XCM execution fees, Uniswap v3 fees, asset reserve); the accounts that generated the most; the live per-block accrual drips; and the HDX distributed to stakers from the three pots. 'range' (30d / 1y / all) applies HERE and only here.
- 'hdx' — the token. Price and 24-hour move, total/protocol/user supply, holder cohorts, every lock type with its total, the unlock schedule (what is unlockable NOW versus scheduled), buy/sell flow and standing DCA pressure, and the largest accumulators and distributors.
- 'hollar' — the stablecoin. Price, peg deviation in basis points, how much of the last 30 days sat within 25 bps, where the supply lives (stablepools, Omnipool, elsewhere), the HSM's collateral holdings with their purchase and buy-back parameters, and the pools that quote it.
- 'ice' — the intent/solver layer. Solver mode and protocol fee, open limit and DCA orders with the capital they reserve, fills per day, execution quality (time to fill, partial and cancel rates, price against limit in basis points), fee revenue, and the busiest pairs.
- 'security' — the safety posture. Cross-chain egress usage against its limit, per-asset deposit fuses and how close each is to lockdown, the Omnipool's per-block trade/add/remove allowances and the peak pressure seen against them, circuit-breaker trips by error, what is currently paused or restricted, lending-market solvency, runtime version, the Technical Committee, and the Wormhole backing summary.
- 'liquidity' — where TVL sits: the venue split across Omnipool, stableswaps, XYK and Uniswap v3, then the Omnipool itself asset by asset with each weight against its CAP.

Every one of these payloads is 10-280 KB upstream and carries long raw series (the Omnipool's TVL history alone is 1,351 daily points). None of that is returned: series are collapsed into first/last/high/low with their window, and tables are cut to the top rows. Timestamps inside the revenue payloads are UNIX SECONDS, unlike the ClickHouse timestamps everywhere else on this server; both are rendered as UTC here.

Prefer get_network_status for liveness, get_money_market for per-account lending risk ('security' sizes the markets, never an account), get_pools for one pool, and get_asset for one token.`

/* ============ revenue ============ */

function renderRevenue(d: RevenueDashboard, stakers: StakerDistributions | null, flow: RevenueFlow | null, ctx: ToolContext): string {
  const streamRows = (d.breakdown ?? []).map(b => [
    b.stream,
    formatUsd(b.usd),
    formatPercent(b.share * 100),
  ])
  const accountRows = (d.topAccounts ?? []).slice(0, 10).map(a => [
    explorerLink(accountLabel(a.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, a.account.address)),
    formatUsd(a.usd),
  ])

  const history = d.history
  const window = (() => {
    const points = (history?.series ?? []).flatMap(s => s.points ?? [])
    if (!points.length) return null
    const from = Math.min(...points.map(p => p.t))
    const to = Math.max(...points.map(p => p.t))
    return `${formatUnixSeconds(from)} → ${formatUnixSeconds(to)}, ${formatCount((history?.bucketSeconds ?? 0) / 3600)} h buckets`
  })()

  const stakerBlock = stakers
    ? joinBlocks(
      h3('Staker distributions'),
      kv([
        ['Range', stakers.range],
        ['Distributed in range', `${hdx(stakers.totals?.hdx)} (${formatUsd(stakers.totals?.usd)})`],
        ['Distributed all time', `${hdx(stakers.allTime?.hdx)} (${formatUsd(stakers.allTime?.usd)})`],
      ]),
      table(
        ['Pot', 'Buckets', 'Latest bucket', 'HDX in latest'],
        (stakers.series ?? []).map(s => {
          const last = s.points?.[s.points.length - 1]
          return [s.pot, formatCount(s.points?.length), last ? formatUnixSeconds(last.t) : DASH, last ? `${hdx(last.hdx)} (${formatUsd(last.usd)})` : DASH]
        }),
      ),
      note('Three separate pots: `staking` is the HDX staking reward pot, `gigahdx` and `gigarwd` are the GIGAHDX programme\'s. Bucket timestamps are unix seconds upstream.'),
    )
    : null

  const flowBlock = flow
    ? joinBlocks(
      h3('Live accrual'),
      table(
        ['Drip', 'Stream', 'Per block', 'Per day'],
        (flow.drips ?? []).map(dr => [
          dr.label,
          dr.stream,
          formatUsd(dr.usdPerBlock),
          flow.blockSeconds > 0 ? formatUsd((dr.usdPerBlock * 86_400) / flow.blockSeconds) : DASH,
        ]),
        'nothing is accruing continuously right now',
      ),
      (flow.items ?? []).length
        ? joinBlocks(
          note('The most recent discrete fee legs, newest first:'),
          bullets(flow.items.slice(0, 5).map(i => (
            `${formatUnixSeconds(i.t)} · ${i.stream} · ${formatUsd(i.usd)} · block ${formatCount(i.block)}${i.account ? ` · ${accountLabel(i.account)}` : ''}`
          ))),
        )
        : null,
      note(`Indexed to block ${formatCount(flow.head)}. A drip is a CONTINUOUS accrual (HOLLAR borrow interest, one per isolated market) rather than an event, so it never appears as a fee leg.`),
    )
    : null

  return joinBlocks(
    h2('Protocol revenue'),
    kv([
      ['Last 24 h', formatUsd(d.totals?.day)],
      ['Last 7 days', formatUsd(d.totals?.week)],
      ['Last 30 days', formatUsd(d.totals?.month)],
      ['All time', formatUsd(d.totals?.allTime)],
      ['As of', formatTime(d.asOf)],
    ]),
    h3(`By stream (${history?.range ?? 'window'})`),
    table(['Stream', 'USD', 'Share'], streamRows),
    window ? note(`History window: ${window}. The per-bucket points are not returned.`) : null,
    h3('Top earning accounts'),
    table(['Account', 'Revenue'], accountRows),
    stakerBlock,
    flowBlock,
  )
}

/* ============ hdx ============ */

function renderHdx(d: HdxDashboard, ctx: ToolContext): string {
  const s = d.supply
  const u = d.unlocks
  const lastFlow = d.flows?.daily?.[d.flows.daily.length - 1] ?? null
  const lastChurn = d.churn?.weekly?.[d.churn.weekly.length - 1] ?? null
  const nextBuckets = (u?.buckets ?? []).slice(0, 4)

  const moverRow = (m: HdxMover) => [
    explorerLink(accountLabel(m.account, { withAddress: true }), accountUrl(ctx.explorerBaseUrl, m.account.address)),
    hdx(m.balanceHdx),
    hdx(m.boughtHdx),
    hdx(m.soldHdx),
    hdx(m.netHdx),
  ]

  return joinBlocks(
    h2('HDX'),
    kv([
      ['Price', `${formatUsd(d.price)} (${formatPercentChange(d.change24h)} in 24 h)`],
      ['Total supply', hdx(s?.totalHdx)],
      ['Protocol-held', s ? `${hdx(s.protocolHdx)} (${formatPercent((s.protocolHdx / s.totalHdx) * 100)} of supply)` : null],
      ['User-held', hdx(s?.userHdx)],
      ['Holder addresses', s?.holders == null ? null : `${formatCount(s.holders)} — addresses with a positive balance, the same count \`list_assets\` shows. The asset page and \`get_asset\` report a smaller figure because they fold each system tag into one holder and re-anchor bound EVM addresses onto their substrate owner.`],
      // NOT "market cap": no explorer surface publishes one, and price × TOTAL
      // supply is the fully diluted figure, which differs from the circulating
      // market cap a listing site quotes by whatever the protocol holds (39% of
      // supply today). Named for the arithmetic it is.
      ['Price × total supply', d.price != null && s
        ? `${formatUsd(d.price * s.totalHdx)} — priced on TOTAL supply, so this is the fully diluted figure, not the circulating market cap a listing site quotes${s.userHdx ? ` (price × user-held is ${formatUsd(d.price * s.userHdx)})` : ''}`
        : null],
    ]),
    h3('Holder cohorts'),
    table(['Cohort', 'Accounts', 'Holds', 'Threshold'], (d.cohorts ?? []).map(c => [
      c.label, formatCount(c.accounts), hdx(c.totalHdx), c.minPct > 0 ? `> ${c.minPct}% of supply (${hdx(c.minHdx)})` : 'any',
    ])),
    note(`Cohorts cover USER-held HDX only — the protocol accounts (treasury, Omnipool, staking pot) holding ${hdx(s?.protocolHdx)} are excluded, so the column sums to user-held supply rather than to total supply.`),
    h3('Locks'),
    table(['Lock', 'Accounts', 'Locked'], (d.locks?.types ?? []).map(t => [t.label, formatCount(t.accounts), hdx(t.totalHdx)])),
    kv([
      ['Total locked', d.locks ? `${hdx(d.locks.totalLockedHdx)} (${formatPercent(d.locks.lockedPctOfUser)} of user-held HDX)` : null],
      // Outside the Vesting row above, not a part of it: that row counts only
      // HDX still on schedule, so the two figures are additive and the larger
      // one carries no lock at all.
      ['Vested but unclaimed', d.locks?.vestedUnclaimedHdx == null ? null
        : `${hdx(d.locks.vestedUnclaimedHdx)} — already vested and NOT counted in the Vesting row above, which holds only HDX still on schedule`],
      ['Lock snapshot', d.locks?.snapshotAt ? `${formatTime(d.locks.snapshotAt)} · ${relativeAge(d.locks.snapshotAt)}` : null],
    ]),
    note('A lock is not a stake: vote locks, the GIGAHDX 28-day lock, staking and vesting are separate mechanisms with separate release rules. Conviction locks take independent maxima rather than accumulating.'),
    h3('Unlocks'),
    kv([
      ['Unlockable now', hdx(u?.unlockableNowHdx)],
      ['Staking (withdrawable any time)', hdx(u?.stakingAnytimeHdx)],
      ['Locked by an ACTIVE vote', hdx(u?.activeVoteHdx)],
      ['GIGAHDX cooldowns pending', u?.gigaPending ? `${formatCount(u.gigaPending.count)} for ${hdx(u.gigaPending.totalHdx)}; ${formatCount(u.gigaPending.maturedCount)} matured (${hdx(u.gigaPending.maturedHdx)})${u.gigaPending.nextUnlockTs ? `, next ${relativeAge(u.gigaPending.nextUnlockTs)}` : ''}` : null],
    ]),
    // "wk 1" names nothing on its own; the bucket carries its own boundaries, so
    // the window is stated rather than left to be counted forward from today.
    table(['Window', 'GIGAHDX', 'Vesting', 'Vote', 'Other'], nextBuckets.map(b => [
      `${b.label}${b.fromTs && b.toTs ? ` (${formatTime(b.fromTs)} → ${formatTime(b.toTs)})` : ''}`,
      hdx(b.gigahdx), hdx(b.vesting), hdx(b.vote), hdx(b.other),
    ])),
    (u?.buckets ?? []).length > nextBuckets.length
      ? note(`The ${formatCount(nextBuckets.length)} nearest of ${formatCount((u?.buckets ?? []).length)} scheduled windows; "Unlockable now" above is the backlog that is already releasable and is NOT in any of them.`)
      : null,
    h3('Flow'),
    kv([
      ['Latest day', lastFlow ? `${lastFlow.date} · ${hdx(lastFlow.buyHdx)} bought by ${formatCount(lastFlow.buyers)}, ${hdx(lastFlow.sellHdx)} sold by ${formatCount(lastFlow.sellers)}` : null],
      ['Standing DCA buys', d.flows?.dca ? `${formatCount(d.flows.dca.buy.orders)} schedules · ${hdx(d.flows.dca.buy.hdxPerDay)}/day` : null],
      ['Standing DCA sells', d.flows?.dca ? `${formatCount(d.flows.dca.sell.orders)} schedules · ${hdx(d.flows.dca.sell.hdxPerDay)}/day` : null],
      ['Holder churn (latest week)', lastChurn ? `${lastChurn.weekStart} · +${formatCount(lastChurn.newHolders)} / −${formatCount(lastChurn.exitedHolders)}` : null],
    ]),
    h3('Largest accumulators'),
    table(['Account', 'Balance', 'Bought', 'Sold', 'Net'], (d.topMovers?.accumulators ?? []).slice(0, 5).map(moverRow)),
    h3('Largest distributors'),
    table(['Account', 'Balance', 'Bought', 'Sold', 'Net'], (d.topMovers?.distributors ?? []).slice(0, 5).map(moverRow)),
    d.gigaMarket?.length
      ? joinBlocks(
        h3('GIGAHDX market'),
        table(['Reserve', 'Supplied', 'Borrowed', 'Suppliers', 'Borrowers'], d.gigaMarket.map(g => [
          assetLabelWithId(g.asset),
          `${formatNumber(g.supplied)} (${formatUsd(g.suppliedUsd)})`,
          `${formatNumber(g.debt)} (${formatUsd(g.debtUsd)})`,
          formatCount(g.suppliers), formatCount(g.borrowers),
        ])),
        note('GIGAHDX is an ISOLATED lending market: its collateral and debt never mix with the primary money market\'s. Use get_money_market for health factors.'),
      )
      : null,
    note('Every HDX figure on this dashboard arrives already scaled — they are token units, not raw integers.'),
  )
}

/* ============ hollar ============ */

function renderHollar(d: HollarDashboard, ctx: ToolContext): string {
  const s = d.supply
  const collateralRows = (d.hsm?.collaterals ?? []).map(c => [
    assetLabelWithId(c.asset),
    `${formatAmount(c.holdings, c.asset.decimals)} (${formatUsd(c.holdingsUsd)})`,
    c.maxInHolding ? formatAmount(c.maxInHolding, c.asset.decimals) : DASH,
    c.purchaseFeePct == null ? DASH : formatPercent(c.purchaseFeePct, 3),
    c.buyBackFeePct == null ? DASH : formatPercent(c.buyBackFeePct, 3),
    // A USD price per unit of collateral, so it carries its currency — the bare
    // number reads as a ratio next to two percentages.
    c.maxBuyPrice == null ? DASH : formatUsd(c.maxBuyPrice),
    c.buybackRatePct == null ? DASH : formatPercent(c.buybackRatePct, 3),
    c.lastArbTs ? `${relativeAge(c.lastArbTs)} (${c.lastArbDirection ?? '?'})` : 'never',
  ])
  // The Explorer's own HOLLAR page names each of these pools by its composition
  // ("HOLLAR / USDC + USDT", `poolLabel` in explorer-ui/src/pages/Hollar.tsx).
  // "pool 111" names nothing a reader can recognise, and this payload already
  // carries the partner assets, so the same label is built here rather than
  // spending a registry read on it.
  const hollarPoolLabel = (p: HollarDashboard['pools'][number]): string =>
    `HOLLAR / ${(p.partners ?? []).map(x => assetLabel(x.asset)).join(' + ') || '—'} (#${p.poolId})`
  const poolRows = [...(d.pools ?? [])]
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
    .slice(0, 8)
    .map(p => [
      explorerLink(hollarPoolLabel(p), poolUrl(ctx.explorerBaseUrl, p.poolId)),
      formatUsd(p.tvlUsd),
      `${formatNumber(p.hollar?.amount)} HOLLAR (${formatUsd(p.hollar?.usd)})`,
      p.hollarSharePct == null ? DASH : formatPercent(p.hollarSharePct),
      (p.partners ?? []).map(x => assetLabelWithId(x.asset)).join(', '),
    ])

  return joinBlocks(
    h2('HOLLAR'),
    kv([
      ['Price', `${formatUsd(d.price)} (${formatPercentChange(d.change24h)} in 24 h)`],
      ['Peg deviation', d.pegDeviationBps == null ? DASH : `${d.pegDeviationBps >= 0 ? '+' : ''}${d.pegDeviationBps.toFixed(1)} bps from $1.00`],
      ['Within 25 bps (30 d)', d.peg ? formatPercent(d.peg.within25bpsPct) : null],
      ['Worst deviation (30 d)', d.peg ? `${d.peg.maxDevBps.toFixed(1)} bps · range ${formatUsd(d.peg.min30d)} – ${formatUsd(d.peg.max30d)}` : null],
    ]),
    h3('Supply'),
    kv([
      ['Total', s == null ? null : `${formatNumber(s.total)} HOLLAR`],
      ['Holders', formatCount(s?.holders)],
      ['In stablepools', s ? `${formatNumber(s.inStablepools)} HOLLAR (${formatPercent((s.inStablepools / s.total) * 100)})` : null],
      ['In the Omnipool', s ? `${formatNumber(s.inOmnipool)} HOLLAR (${formatPercent((s.inOmnipool / s.total) * 100)})` : null],
      ['Held elsewhere', s ? `${formatNumber(s.other)} HOLLAR (${formatPercent((s.other / s.total) * 100)})` : null],
    ]),
    h3('HSM (the peg stability module)'),
    kv([
      ['Collateral held', formatUsd(d.hsm?.totalHoldingsUsd)],
      ['Last arbitrage', d.hsm?.lastArb ? `${formatTime(d.hsm.lastArb.ts)} · ${relativeAge(d.hsm.lastArb.ts)} · ${d.hsm.lastArb.direction} · ${formatNumber(d.hsm.lastArb.hollarAmount)} HOLLAR against ${assetLabel(d.hsm.lastArb.asset)}` : null],
    ]),
    table(['Collateral', 'Held', 'Max holding', 'Purchase fee', 'Buy-back fee', 'Max buy price', 'Buy-back rate', 'Last arb'], collateralRows),
    h3('Pools quoting HOLLAR'),
    table(['Pool', 'TVL', 'HOLLAR side', 'HOLLAR share', 'Partners'], poolRows),
    note('HOLLAR is written in uppercase everywhere. A peg deviation is measured in basis points against $1.00; the HSM buys collateral below `maxBuyPrice` and sells it back at the buy-back fee, which is what pulls the price home.'),
  )
}

/* ============ ice ============ */

function renderIce(d: IceDashboard, ctx: ToolContext): string {
  const days = d.fillsPerDay ?? []
  const recent = days.slice(-7)
  const fills30 = days.reduce((a, b) => a + (b.fills ?? 0), 0)
  const usd30 = days.reduce((a, b) => a + (b.usd ?? 0), 0)
  const fees30 = (d.feeRevenue?.perDay ?? []).reduce((a, b) => a + (b.usd ?? 0), 0)
  const q = d.quality

  return joinBlocks(
    h2('ICE (intents and solving)'),
    kv([
      ['Solver mode', d.status?.solverMode],
      ['Protocol fee', d.status?.protocolFeePpm == null ? null : `${d.status.protocolFeePpm} ppm (${(d.status.protocolFeePpm / 10_000).toFixed(3)}%)`],
      ['DCA migration', d.status?.dcaMigrationEnabled ? 'enabled' : 'disabled'],
      ['Config as of block', formatCount(d.status?.asOfBlock)],
      ['Generated', d.generatedAt ? `${formatTime(d.generatedAt)} · ${relativeAge(d.generatedAt)}` : null],
    ]),
    h3('Open orders'),
    kv([
      ['Open', `${formatCount(d.openOrders?.total)} (${formatCount(d.openOrders?.limit)} limit, ${formatCount(d.openOrders?.dca)} DCA)`],
      ['Unmigrated DCA schedules', formatCount(d.migration?.remainingSchedules)],
    ]),
    table(['Asset', 'Reserved', 'USD', 'Orders'], (d.openOrders?.byAsset ?? []).slice(0, 8).map(a => [
      explorerLink(assetLabelWithId(a.asset), assetUrl(ctx.explorerBaseUrl, a.asset.assetId)),
      formatAmount(a.reserved, a.asset.decimals, assetLabel(a.asset)),
      formatUsd(a.reservedUsd),
      formatCount(a.orders),
    ])),
    h3(`Fills (${formatCount(days.length)} days)`),
    kv([
      ['Fills in window', `${formatCount(fills30)} · ${formatUsd(usd30)}`],
      ['Fee revenue in window', formatUsd(fees30)],
    ]),
    table(['Day', 'Fills', 'Solutions', 'USD', 'Matched', 'Routed'], recent.map(r => [
      r.day, formatCount(r.fills), formatCount(r.solutions), formatUsd(r.usd), formatUsd(r.matchedUsd), formatUsd(r.routedUsd),
    ])),
    // The table is the tail of the window, not the window: summing its rows and
    // calling the result the period total would undercount by the days above it.
    note(`The table is the LAST ${formatCount(recent.length)} of the ${formatCount(days.length)} days in the window; the "Fills in window" figure above covers all of them. "Matched" is filled against another intent; "routed" went out to a pool. A solution may carry several fills.`),
    h3('Execution quality'),
    kv([
      ['Median time to fill', q?.medianTimeToFillSec == null ? null : `${q.medianTimeToFillSec}s`],
      ['Partially filled', q?.partialShare == null ? null : formatPercent(q.partialShare * 100)],
      ['Cancelled', q?.cancelRate == null ? null : formatPercent(q.cancelRate * 100)],
      ['Expired', q?.expiryRate == null ? null : formatPercent(q.expiryRate * 100)],
      ['Price against limit', q?.priceVsLimitBp ? `p10 ${q.priceVsLimitBp.p10} bps · median ${q.priceVsLimitBp.p50} bps · p90 ${q.priceVsLimitBp.p90} bps (positive = better than the limit)` : null],
    ]),
    h3('Busiest pairs'),
    table(['Pair', 'Fills', 'USD'], (d.topPairs ?? []).slice(0, 8).map(p => [
      `${assetLabel(p.assetIn)} → ${assetLabel(p.assetOut)}`, formatCount(p.fills), formatUsd(p.usd),
    ])),
    (d.feeRevenue?.potHoldings ?? []).length
      ? joinBlocks(h3('Fee pot holdings'), table(['Asset', 'Amount', 'USD'], d.feeRevenue.potHoldings.map(h => [
        assetLabelWithId(h.asset), formatAmount(h.amount, h.asset.decimals), formatUsd(h.usd),
      ])))
      : null,
  )
}

/* ============ security ============ */

function renderSecurity(d: SecurityDashboard, ctx: ToolContext): string {
  const w = d.withdraw
  const fuses = [...(d.fuses?.rows ?? [])].sort((a, b) => (b.usagePct ?? 0) - (a.usagePct ?? 0)).slice(0, 8)
  const perBlock = [...(d.perBlock?.rows ?? [])].sort((a, b) => (b.peakPressurePct ?? 0) - (a.peakPressurePct ?? 0)).slice(0, 8)
  const wh = d.wormhole

  return joinBlocks(
    h2('Security posture'),
    kv([
      ['Indexed head', `${formatCount(d.head?.blockHeight)} · ${formatTime(d.head?.blockTimestamp)}`],
      ['Chain state as of', formatCount(d.chainBlock)],
      ['Runtime', `spec ${formatCount(d.runtime?.specVersion)} · ${formatCount(d.runtime?.upgrades)} upgrades${d.runtime?.lastUpgrade ? `, last ${relativeAge(d.runtime.lastUpgrade.blockTimestamp)}` : ''}`],
    ]),
    h3('Cross-chain egress'),
    // The accumulator is denominated in HDX. Reading it as dollars overstates it
    // by whatever HDX costs — at $0.0078 the 100M HDX limit is about $780k, not
    // $100M — so these figures go through the HDX renderer and say so.
    kv([
      ['Limit', w?.configured ? `${hdx(w.limit)} — the budget is denominated in HDX, not USD` : 'not configured'],
      ['Used', w?.configured ? `${hdx(w.used)}${w.usagePct == null ? '' : ` (${formatPercent(w.usagePct)})`} — NET of arrivals, not gross outflow` : null],
      ['Headroom', w?.configured && w.limit != null && w.used != null ? `${hdx(w.limit - w.used)} before the next withdrawal is refused` : null],
      ['Decay', w?.configured && w.windowMs
        ? `reaches zero ${Math.round(w.windowMs / 3_600_000)} h after the last charge IF nothing more is charged — every new charge restarts the decay from the reduced figure, so a chain under steady outflow carries a standing balance rather than emptying`
        : null],
      ['Last credited', w?.lastCreditedMs ? `${formatTime(new Date(w.lastCreditedMs).toISOString())} · ${relativeAge(new Date(w.lastCreditedMs).toISOString())}` : null],
      ['Lockdown', w?.configured ? (w.lockdownUntilMs ? `active until ${formatTime(new Date(w.lockdownUntilMs).toISOString())}` : 'not active — reaching the limit refuses the operation; only the Technical Committee or governance arms a lockdown') : null],
      ['Ever tripped', w?.configured ? (w.everTripped ? 'yes' : 'no') : null],
      ['Promoted by governance', w?.configured ? `${formatCount(w.externalAssetCount)} assets carry an External override` : null],
    ]),
    w?.configured
      ? note('Two cautions on this figure. The accounted set is NOT the override count above: the runtime also charges every registry External and Erc20 asset that carries no override at all, an order of magnitude more assets than governance has promoted, while local assets are charged only into a sink. And each withdrawal converts at its asset\'s ten-minute oracle price along its route to HDX — an asset with no such route falls back to the fixed price governance set for paying fees in it, which can sit far from the market and moves only when governance moves it.')
      : null,
    h3('Deposit fuses'),
    kv([
      ['Assets locked', formatCount(d.fuses?.lockedCount)],
      ['Assets frozen', formatCount(d.fuses?.frozenCount)],
      ['Lockdowns ever', `${formatCount(d.fuses?.lockdownTotal)} (${formatCount(d.fuses?.releaseTotal)} releases)`],
      ['Fuse period', `${formatCount(d.fuses?.periodBlocks)} blocks`],
    ]),
    table(['Asset', 'Status', 'Used', 'Limit', 'Usage', 'Lockdowns'], fuses.map(f => [
      explorerLink(assetLabelWithId(f.asset), assetUrl(ctx.explorerBaseUrl, f.asset.assetId)),
      f.status,
      `${formatAmount(f.used, f.asset.decimals)} (${formatUsd(f.usedUsd)})`,
      `${formatAmount(f.limit, f.asset.decimals)} (${formatUsd(f.limitUsd)})`,
      f.usagePct == null ? DASH : formatPercent(f.usagePct),
      formatCount(f.lockdownCount),
    ])),
    h3('Omnipool per-block allowances'),
    kv([
      // Two digits: the 2s runtime's defaults are 16.7% and 1.67%, which zero
      // digits would round to 17% and 2%.
      ['Defaults', d.perBlock ? `${formatPercent(d.perBlock.defaultTradePct)} trade · ${formatPercent(d.perBlock.defaultAddPct)} add · ${formatPercent(d.perBlock.defaultRemovePct)} remove, each of the asset's reserve` : null],
      ['Peak window', d.perBlock ? `${formatCount(d.perBlock.peakWindowDays)} days` : null],
    ]),
    table(['Asset', 'Reserve', 'Trade / add / remove', 'Peak pressure', 'Tradable'], perBlock.map(r => [
      explorerLink(assetLabelWithId(r.asset), assetUrl(ctx.explorerBaseUrl, r.asset.assetId)),
      formatUsd(r.reserveUsd),
      `${formatPercent(r.tradeLimitPct, 0)} / ${formatPercent(r.addLimitPct, 0)} / ${formatPercent(r.removeLimitPct, 0)}${r.overridden ? ' (overridden)' : ''}`,
      r.peakPressurePct == null ? DASH : `${formatPercent(r.peakPressurePct)}${r.peakBlockHeight ? ` at block ${formatCount(r.peakBlockHeight)}` : ''}`,
      (r.tradable ?? []).length >= 4 ? 'all' : (r.tradable ?? []).join(', ') || 'none',
    ])),
    h3('Circuit-breaker trips'),
    kv([
      ['Trips', `${formatCount(d.trips?.total)} total · ${formatCount(d.trips?.enforcementTotal)} real enforcements`],
      ['Direct / nested', `${formatCount(d.trips?.directTotal)} / ${formatCount(d.trips?.nestedTotal)}`],
    ]),
    table(['Error', 'Count', 'Enforcement'], (d.trips?.byError ?? []).slice(0, 6).map(e => [
      e.name, formatCount(e.count), e.enforcement ? 'yes' : 'no',
    ])),
    h3('What is switched off'),
    bullets([
      `${formatCount(d.freezes?.paused?.length)} call${d.freezes?.paused?.length === 1 ? '' : 's'} paused${(d.freezes?.paused ?? []).length ? `: ${(d.freezes!.paused).slice(0, 6).map(p => `${p.pallet}.${p.call}`).join(', ')}` : ''}`,
      // `hubTradability` is the ALLOWED set, not the blocked one. Printed bare,
      // "Hub asset tradability: Sell" reads as "selling is switched off" under a
      // heading called "What is switched off" — the exact opposite.
      (d.freezes?.hubTradability ?? []).length
        ? `Hub asset (H2O): the only PERMITTED operation${(d.freezes?.hubTradability ?? []).length === 1 ? ' is' : 's are'} ${(d.freezes?.hubTradability ?? []).join(' and ')} — that list is what is allowed, not what is blocked, and it is permanent by design: H2O is sold into the pool and never bought out of it`
        : 'Hub asset (H2O): no tradability restriction recorded',
      `${formatCount(d.freezes?.omnipool?.length)} of ${formatCount(d.freezes?.omnipoolAssetCount)} listed Omnipool assets carry a tradability restriction · ${formatCount(d.freezes?.stableswap?.length)} stableswap assets restricted · ${formatCount(d.freezes?.delisted?.length)} assets wound down (frozen and since removed from the pool, so they are no longer among the listed ones)`,
    ]),
    h3('Lending solvency'),
    table(['Market', 'Role', 'Borrowers', 'Collateral', 'Debt', 'Bad debt'], (d.risk?.markets ?? []).map(m => [
      `${m.label} (\`${m.key}\`)`, m.role, formatCount(m.borrowers), formatUsd(m.collateralUsd), formatUsd(m.debtUsd), m.badDebtUsd > 0 ? formatUsd(m.badDebtUsd) : 'none',
    ])),
    // A chain-wide `Liquidation.Liquidated` count with no market dimension, so it
    // sits BELOW the per-market table and names its own scope — printed beside
    // one market's row it would read as that market's.
    kv([['Liquidations', d.risk?.liquidations ? `${formatCount(d.risk.liquidations.day)} today · ${formatCount(d.risk.liquidations.month)} in 30 days · ${formatCount(d.risk.liquidations.total)} ever — chain-wide, ACROSS ALL the markets above, not the primary market's alone` : null]]),
    note('These markets are ISOLATED — their collateral and debt are never blended. get_money_market carries the per-market and per-account risk.'),
    h3('Guardians'),
    kv([
      ['Technical Committee', d.guardians?.techCommittee ? `${formatCount(d.guardians.techCommittee.size)} members · ${formatCount(d.guardians.techCommittee.majority)} for a majority · ${formatCount(d.guardians.techCommittee.superMajority)} for a super-majority` : null],
      ['Whitelisted calls outstanding', formatCount(d.guardians?.outstandingWhitelisted?.length)],
    ]),
    wh
      ? joinBlocks(h3('Wormhole backing'), kv([
        ['Assets', formatCount(wh.assets)],
        ['Locked vs issued', `${formatUsd(wh.lockedUsd)} custody against ${formatUsd(wh.issuanceUsd)} issued`],
        ['Worst status', wh.worstStatus],
        ['Deficit / surplus', `${formatUsd(wh.deficitUsd)} / ${formatUsd(wh.surplusUsd)}`],
        ['In flight / queued', `${formatCount(wh.inflightCount)} / ${formatCount(wh.queuedCount)}`],
        ['Snapshot', wh.asOf ? `${formatTime(wh.asOf)} · ${relativeAge(wh.asOf)}` : null],
      ]))
      : null,
    h3('Latest safety actions'),
    bullets((d.timeline ?? []).slice(0, 6).map(t => (
      `${formatTime(t.blockTimestamp)} · **${t.label}**${t.asset ? ` · ${assetLabel(t.asset)}` : ''}${t.detail ? ` — ${t.detail}` : ''} (block ${formatCount(t.blockHeight)})`
    ))),
  )
}

/**
 * The security dashboard, cut to the depth the rendering shows. The upstream
 * payload is 206 KB and nearly all of it is history an answer never quotes — a
 * 327-entry safety timeline, 60 fuse rows with their lockdown logs, every
 * liquidation and breaker trip on record, the full egress-account roster. Kept
 * whole it would overrun the text budget and hand back JSON that no longer
 * parses, so `format: "json"` gets exactly what `format: "markdown"` states.
 */
function securityJson(d: SecurityDashboard): unknown {
  const drop = <T extends object>(source: T | undefined, keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(source ?? {})) if (!keys.includes(k)) out[k] = v
    return out
  }
  const risk = d.risk as unknown as Record<string, unknown> | undefined
  return {
    ...d,
    withdraw: drop(d.withdraw, ['egressAccounts', 'localAssets']),
    fuses: {
      ...drop(d.fuses, ['rows', 'lockdowns']),
      rows: [...(d.fuses?.rows ?? [])].sort((a, b) => (b.usagePct ?? 0) - (a.usagePct ?? 0)).slice(0, 8),
    },
    perBlock: {
      ...drop(d.perBlock, ['rows']),
      rows: [...(d.perBlock?.rows ?? [])].sort((a, b) => (b.peakPressurePct ?? 0) - (a.peakPressurePct ?? 0)).slice(0, 8),
    },
    trips: { ...drop(d.trips, ['recent']), byError: (d.trips?.byError ?? []).slice(0, 6) },
    freezes: { ...drop(d.freezes, ['paused', 'delisted']), paused: (d.freezes?.paused ?? []).slice(0, 6), delistedCount: (d.freezes?.delisted ?? []).length },
    risk: {
      ...drop(risk, ['liquidations', 'largestMoves']),
      liquidations: drop(risk?.liquidations as object | undefined, ['recent']),
    },
    timeline: (d.timeline ?? []).slice(0, 6),
  }
}

/* ============ liquidity ============ */

function renderLiquidity(omni: OmnipoolResponse | null, pools: PoolsIndex | null, ctx: ToolContext): string {
  const byVenue = new Map<string, { count: number; tvl: number }>()
  for (const p of (pools?.pools ?? []) as PoolListEntry[]) {
    const slot = byVenue.get(p.kind) ?? { count: 0, tvl: 0 }
    slot.count += 1
    slot.tvl += p.tvlUsd ?? 0
    byVenue.set(p.kind, slot)
  }
  const label: Record<string, string> = { omnipool: 'Omnipool', stableswap: 'Stableswap', xyk: 'XYK', uniswapv3: 'Uniswap v3' }
  const hub = omni ? scaleAmount(omni.hubReserveTotal, HUB_DECIMALS) : null
  const assets = [...(omni?.assets ?? [])].sort((a, b) => (b.reserveUsd ?? 0) - (a.reserveUsd ?? 0))
  const overCap = assets.filter(a => a.weightPct != null && a.capPct != null && a.weightPct > a.capPct + 0.01)
  const atCap = assets.filter(a => !overCap.includes(a) && capMarker(a.weightPct, a.capPct) !== '')

  return joinBlocks(
    h2('Liquidity'),
    pools
      ? joinBlocks(
        kv([
          ['Total TVL', formatUsd(pools.totalTvlUsd)],
          ['Pools', `${formatCount((pools.pools ?? []).length)} (${formatCount((pools.pools ?? []).filter(p => (p.tvlUsd ?? 0) <= 0).length)} hold nothing)`],
          ['Directory', explorerLink('explorer', liquidityPageUrl(ctx.explorerBaseUrl))],
        ]),
        table(['Venue', 'Pools', 'TVL', 'Share'], [...byVenue.entries()].sort((a, b) => b[1].tvl - a[1].tvl).map(([kind, v]) => [
          label[kind] ?? kind,
          formatCount(v.count),
          formatUsd(v.tvl),
          pools.totalTvlUsd ? formatPercent((v.tvl / pools.totalTvlUsd) * 100) : DASH,
        ])),
      )
      : null,
    omni
      ? joinBlocks(
        h3('Omnipool'),
        kv([
          ['TVL', formatUsd(omni.tvlUsd)],
          ['Listed assets', formatCount(omni.assetCount)],
          ['Hub reserve', hub == null ? DASH : `${formatNumber(hub)} ${HUB_SYMBOL}${omni.lrnaPrice != null ? ` (${formatUsd(hub * omni.lrnaPrice)})` : ''}`],
          ['Hub price', formatUsd(omni.lrnaPrice)],
          ['Page', explorerLink('Omnipool', omnipoolPageUrl(ctx.explorerBaseUrl))],
        ]),
        table(['Asset', 'Reserve', 'USD', `Hub (${HUB_SYMBOL})`, 'Weight', 'Cap'], assets.map(a => [
          explorerLink(assetLabelWithId(a.asset), assetUrl(ctx.explorerBaseUrl, a.asset.assetId)),
          formatAmount(a.reserve, a.asset.decimals),
          formatUsd(a.reserveUsd),
          formatAmount(a.hubReserve, HUB_DECIMALS),
          a.weightPct == null ? DASH : formatPercent(a.weightPct),
          a.capPct == null ? DASH : `${formatPercent(a.capPct, 0)}${capMarker(a.weightPct, a.capPct)}`,
        ])),
        overCap.length || atCap.length
          ? note([
            overCap.length ? `Over the weight cap: ${overCap.map(a => assetLabel(a.asset)).join(', ')} — the cap bounds what may be ADDED, so an asset can sit above it without being forced down.` : null,
            atCap.length ? `At the cap: ${atCap.map(a => assetLabel(a.asset)).join(', ')}.` : null,
            'Either way, no further liquidity can be added to that asset until governance raises its cap.',
          ].filter(Boolean).join(' '))
          : note('No Omnipool asset is at or over its weight cap.'),
      )
      : null,
    note('Call get_pools for one pool\'s composition, providers and activity, or for the full directory with filters.'),
  )
}

const INPUT_SHAPE = {
  dashboard: z.enum(DASHBOARDS).describe("Which dashboard: 'revenue' (what the protocol earns, by stream and by account), 'hdx' (supply, locks, unlocks, flow), 'hollar' (peg, supply, the HSM), 'ice' (intents, solving, fills), 'security' (egress limits, fuses, breaker trips, freezes, solvency), 'liquidity' (TVL by venue and the Omnipool asset by asset)."),
  range: z.enum(RANGES).optional().describe("Window for the 'revenue' dashboard only: '30d' (default), '1y' or 'all'. Ignored, with a note, on every other dashboard."),
  format: formatParam,
}

/* ============ handler ============ */

async function handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(INPUT_SHAPE, input)
  if (!parsed.ok) {
    return failure(invalidArgument(`get_protocol_stats needs a \`dashboard\` of ${DASHBOARDS.join(', ')}${input.dashboard ? ` (got ${JSON.stringify(input.dashboard)})` : ''}. ${parsed.error.message}`))
  }
  const dashboard: Dashboard = parsed.value.dashboard
  // `/explorer/revenue` defaults to 30d and `/explorer/revenue/stakers` to all;
  // left implicit, one answer would carry two different windows.
  const range = parsed.value.range ?? '30d'
  const errors: ToolError[] = []
  // `range` exists only on the revenue routes; elsewhere it is said to be
  // ignored rather than silently dropped or turned into an upstream 400.
  const rangeNote = parsed.value.range && dashboard !== 'revenue'
    ? note(`\`range\` applies only to the revenue dashboard; the ${dashboard} dashboard has a fixed window, so "${parsed.value.range}" was ignored.`)
    : null

  try {
    if (dashboard === 'revenue') {
      const [revRes, stakersRes, flowRes] = await Promise.allSettled([
        ctx.upstream.get<RevenueDashboard>('/explorer/revenue', { range }, { ttlMs: 60_000, timeoutMs: 60_000 }),
        ctx.upstream.get<StakerDistributions>('/explorer/revenue/stakers', { range }, { ttlMs: 60_000, timeoutMs: 60_000 }),
        ctx.upstream.get<RevenueFlow>('/explorer/revenue/flow', undefined, { ttlMs: 5_000 }),
      ])
      if (revRes.status === 'rejected') return failure(toolErrorFromUpstream(revRes.reason, 'The revenue dashboard'))
      if (stakersRes.status === 'rejected') errors.push(toolErrorFromUpstream(stakersRes.reason, 'Staker distributions'))
      if (flowRes.status === 'rejected') errors.push(toolErrorFromUpstream(flowRes.reason, 'The live revenue flow'))
      const stakers = stakersRes.status === 'fulfilled' ? stakersRes.value : null
      const flow = flowRes.status === 'fulfilled' ? flowRes.value : null
      const markdown = renderRevenue(revRes.value, stakers, flow, ctx)
      return output(ctx, fit(markdown, ctx), {
        revenue: { ...revRes.value, history: revRes.value.history ? { range: revRes.value.history.range, bucketSeconds: revRes.value.history.bucketSeconds } : null },
        stakers: stakers ? { ...stakers, series: (stakers.series ?? []).map(s => ({ pot: s.pot, points: s.points?.length ?? 0 })) } : null,
        flow,
      }, errors)
    }

    if (dashboard === 'hdx') {
      const d = await ctx.upstream.get<HdxDashboard>('/explorer/hdx', undefined, { ttlMs: 60_000, timeoutMs: 60_000 })
      // `structure` carries a 200-week ownership matrix and `unlocks.buckets`
      // a full schedule; neither is an answer, so neither is returned raw.
      return output(ctx, fit(joinBlocks(rangeNote, renderHdx(d, ctx)), ctx), { ...d, structure: undefined, churn: undefined })
    }

    if (dashboard === 'hollar') {
      const d = await ctx.upstream.get<HollarDashboard>('/explorer/hollar', undefined, { ttlMs: 60_000, timeoutMs: 60_000 })
      return output(ctx, fit(joinBlocks(rangeNote, renderHollar(d, ctx)), ctx), {
        ...d,
        peg: d.peg ? { ...d.peg, hourly: undefined } : null,
        hsm: d.hsm ? { ...d.hsm, reserveHistory: undefined, arbitrageDaily: undefined, tradesDaily: undefined } : null,
        trends: undefined,
      })
    }

    if (dashboard === 'ice') {
      const d = await ctx.upstream.get<IceDashboard>('/explorer/ice', undefined, { ttlMs: 60_000, timeoutMs: 60_000 })
      return output(ctx, fit(joinBlocks(rangeNote, renderIce(d, ctx)), ctx), {
        ...d,
        migration: d.migration ? { migrated: d.migration.migrated, cancelled: d.migration.cancelled, remainingSchedules: d.migration.remainingSchedules } : null,
      })
    }

    if (dashboard === 'security') {
      const d = await ctx.upstream.get<SecurityDashboard>('/explorer/security', undefined, { ttlMs: 30_000, timeoutMs: 60_000 })
      // 206 KB upstream, and most of it is depth no answer uses: a 327-entry
      // timeline, 60 fuse rows, the full egress-account roster. The structured
      // record mirrors what was rendered so `format: "json"` stays parseable.
      return output(ctx, fit(joinBlocks(rangeNote, renderSecurity(d, ctx)), ctx), securityJson(d))
    }

    const [omniRes, poolsRes] = await Promise.allSettled([
      ctx.upstream.get<OmnipoolResponse>('/explorer/omnipool', undefined, { ttlMs: 30_000, timeoutMs: 60_000 }),
      ctx.upstream.get<PoolsIndex>('/explorer/pools', undefined, { ttlMs: 30_000, timeoutMs: 60_000 }),
    ])
    if (omniRes.status === 'rejected') errors.push(toolErrorFromUpstream(omniRes.reason, 'The Omnipool'))
    if (poolsRes.status === 'rejected') errors.push(toolErrorFromUpstream(poolsRes.reason, 'The liquidity directory'))
    const omni = omniRes.status === 'fulfilled' ? omniRes.value : null
    const pools = poolsRes.status === 'fulfilled' ? poolsRes.value : null
    if (!omni && !pools) return failure(errors)
    return output(ctx, fit(joinBlocks(rangeNote, renderLiquidity(omni, pools, ctx)), ctx), {
      omnipool: omni ? { ...omni, history: undefined } : null,
      venues: pools ? { totalTvlUsd: pools.totalTvlUsd, poolCount: (pools.pools ?? []).length } : null,
    }, errors)
  } catch (err) {
    return failure([...errors, toolErrorFromUpstream(err, `The ${dashboard} dashboard`)])
  }
}

export const protocolTools: ToolDefinition[] = [{
  name: 'get_protocol_stats',
  title: 'Protocol dashboards',
  description: DESCRIPTION,
  inputSchema: INPUT_SHAPE,
  handler,
}]
