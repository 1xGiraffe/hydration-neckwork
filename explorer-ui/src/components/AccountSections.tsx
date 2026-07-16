/* eslint-disable react-refresh/only-export-components -- shared account-section components + their count helper */
import { F, AssetIcon, AssetAmount, AreaChart, ChartSkeleton, healthFactorDisplay, AddrPill, rowNav, Dash } from './ui'
import { Link, paths } from '../router'
import { BalanceHistory } from './BalanceHistory'
import { performancePoints } from './performance'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import type { MoneyMarketPosition, LpPosition, ActiveDca, AssetBalanceHistory, AccountProxyInfo, MultisigInfo, MultisigMembership, ProxyRelation } from '../types'
import type { ReactNode } from 'react'

// Render helpers shared by the Account and Tag detail pages so both surface the
// same on-chain data (balances, money-market card, DCA orders, LP positions,
// portfolio chart, balance history) with identical markup.

// Live "next execution" cell for an Active DCA order. Hydration blocks are ~6s,
// so the countdown to the next execution block is (nextBlock - head) * 6 seconds.
// Re-renders on the shared 1s clock (`now`) so the countdown ticks; the title
// carries the estimated wall-clock time. Once the block is at/under the head it's
// either due (waiting for the next plan) or pending.
export function DcaNextExec({ nextBlock, headBlock, headTime, now }: { nextBlock: number | null; headBlock: number; headTime?: string; now: number }) {
  if (nextBlock == null) return <Dash />
  // The block links even when not yet produced — the block page renders a live
  // countdown for future heights.
  const blockLink = <Link to={paths.block(nextBlock)} className="hash">{F.int(nextBlock)}</Link>
  const blocksAway = nextBlock - headBlock
  if (blocksAway <= 0 || !headBlock) {
    return <span title="Next execution is at or before the current head — awaiting its turn">{blockLink} · due</span>
  }
  const timing = estimateBlockCountdown(nextBlock, headBlock, headTime, now)
  const secondsUntil = timing?.secondsUntil ?? blocksAway * 6
  const est = timing ? new Date(timing.etaMs) : null
  return (
    <span title={est ? `Est. ${est.toLocaleString()}` : `Approximately ${blocksAway} blocks away`}>{blockLink} · in {fmtCountdown(secondsUntil)}</span>
  )
}
function fmtCountdown(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// Portfolio value area chart. `netUsd` is the value shown at the top of the
// card (portfolio minus any borrowed debt); the series carries no dates of its
// own, so we borrow the first asset's balance-history point timestamps when the
// lengths line up (else a value-only tooltip).
export function PortfolioChart({ title, netUsd, series, dates: datesProp, balanceHistory, loading }: {
  title: string; netUsd: number; series: number[]; dates?: string[]; balanceHistory?: AssetBalanceHistory[]; loading?: boolean
}) {
  if (!series || series.length <= 1) {
    return loading ? (
      <>
        <div className="sec-title">{title}</div>
        <ChartSkeleton h={260} />
      </>
    ) : null
  }
  // Prefer the portfolio's own per-bucket dates; fall back to a same-length asset
  // history if that's all that lines up. Either way the AreaChart shows the date
  // on hover (no static x-axis labels).
  const bp = balanceHistory?.[0]?.points
  const dates = datesProp && datesProp.length === series.length ? datesProp
    : bp && bp.length === series.length ? bp.map(p => p.ts) : undefined
  const perf = (label: string, val: number) => (
    <span key={label} className="perf"><span className="pk">{label}</span><span className="pv" style={{ color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span></span>
  )
  // Suppress windows whose baseline is dust or that span the account's initial
  // funding (>20× growth) — "+1859057.1%" carries no information.
  const perfItems = performancePoints(series, dates, [
    { label: '24H', days: 1 },
    { label: '1W', days: 7 },
    { label: '1M', days: 30 },
    { label: '1Y', days: 365 },
  ], { minBase: 1, maxRatio: 20 })
  return (
    <>
      <div className="sec-title">{title}</div>
      <div className="pf-card">
        <div className="pf-head"><div className="pf-now">{F.usd(netUsd)}</div>{perfItems.length > 0 && <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>}</div>
        <AreaChart data={series} h={180} dates={dates} />
      </div>
    </>
  )
}

// Money markets are one position family in the account navigation. Isolated
// markets remain separate inside that family, without making the tab count look
// like the account has several unrelated supply/borrow products.
export function mmPositionCount(markets: MoneyMarketPosition[]): number {
  return markets.length > 0 ? 1 : 0
}

export function moneyMarketDebtUsd(markets: MoneyMarketPosition[]): number {
  return markets.reduce((total, market) => total + Number(market.totalDebtBase) / 1e8, 0)
}

export function profileTabs(
  balanceCount: number,
  markets: MoneyMarketPosition[],
  dcaCount: number,
  liquidityPositionCount: number,
  activityCount?: number,
): { key: string; label: string; count?: number }[] {
  const positionCount = mmPositionCount(markets) + dcaCount + liquidityPositionCount
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'balances', label: 'Balances', count: balanceCount },
    ...(positionCount > 0 ? [{ key: 'positions', label: 'Positions', count: positionCount }] : []),
    { key: 'activity', label: 'Activity', ...(activityCount == null ? {} : { count: activityCount }) },
  ]
}

export function ProfileStats({ tradingVolumeUsd, liquidationVolumeUsd, valueUsd, valueHint }: {
  tradingVolumeUsd?: number | null
  liquidationVolumeUsd?: number | null
  valueUsd: number
  valueHint?: ReactNode
}) {
  const trading = tradingVolumeUsd ?? 0
  const liquidation = liquidationVolumeUsd ?? 0
  return (
    <div className="acct-stats">
      {trading > 0 && <div className="acct-bal subtle">
        <div className="lab">Trading</div>
        <div className="amt">{F.usd(trading)}</div>
      </div>}
      {liquidation > 0 && <div className="acct-bal subtle">
        <div className="lab">Liquidation</div>
        <div className="amt">{F.usd(liquidation)}</div>
      </div>}
      <div className="acct-bal">
        <div className="lab">Value</div>
        <div className="amt">{F.usd(valueUsd)}</div>
        {valueHint}
      </div>
    </div>
  )
}

function currentLtvPct(mm: MoneyMarketPosition): number {
  const collateral = Number(mm.totalCollateralBase)
  const debt = Number(mm.totalDebtBase)
  return collateral > 0 && debt > 0 ? debt / collateral * 100 : 0
}

function MoneyMarketRiskBar({ mm }: { mm: MoneyMarketPosition }) {
  const debtUsd = Number(mm.totalDebtBase) / 1e8
  if (debtUsd <= 0 || mm.healthFactor === 'unknown' || Number(mm.liquidationThreshold) <= 0) return null
  const ltvPct = currentLtvPct(mm)
  const liqPct = Number(mm.liquidationThreshold) / 100
  const fillPct = liqPct > 0 ? Math.min(100, ltvPct / liqPct * 100) : 0
  return (
    <div className="mm-bar">
      <div
        className="mm-bar-track"
        role="meter"
        aria-label={`${mm.market} current loan-to-value`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, ltvPct)}
        aria-valuetext={`${ltvPct.toFixed(1)}% current loan-to-value; liquidation threshold ${liqPct.toFixed(0)}%`}
      >
        <div className="mm-bar-fill" style={{ width: `${fillPct.toFixed(1)}%` }} />
        <div className="mm-bar-liq" />
      </div>
      <div className="mm-bar-lab"><span>Current LTV {ltvPct.toFixed(1)}%</span><span className="muted">liquidation @ {liqPct.toFixed(0)}%</span></div>
    </div>
  )
}

function MoneyMarketReserveColumns({ mm }: { mm: MoneyMarketPosition }) {
  if (!mm.reserves?.length) return null
  const supplied = mm.reserves.filter(r => r.supplied !== '0')
  const borrowed = mm.reserves.filter(r => r.debt !== '0')
  return (
    <div className="mm-cols">
      <div>
        <div className="mm-col-head">Supplied</div>
        {supplied.map(r => (
          <div className="mm-row" key={`s${r.assetId}`}>
            <span className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></span>
            <span className="mono">{F.amount(r.supplied, r.decimals)}</span>
            <span className="mono muted">{F.usd(r.suppliedUsd)}</span>
            {r.collateral ? <span className="badge ok mm-collateral-badge">collateral</span> : null}
          </div>
        ))}
        {!supplied.length && <div className="mm-empty">None</div>}
      </div>
      <div>
        <div className="mm-col-head">Borrowed</div>
        {borrowed.map(r => (
          <div className="mm-row" key={`d${r.assetId}`}>
            <span className="trade-leg"><AssetIcon assetId={r.assetId} iconAssetId={r.iconAssetId} symbol={r.symbol} size={18} parachainId={r.parachainId} origin={r.origin} /> <span className="mono">{r.symbol}</span></span>
            <span className="mono">{F.amount(r.debt, r.decimals)}</span>
            <span className="mono muted">{F.usd(r.debtUsd)}</span>
          </div>
        ))}
        {!borrowed.length && <div className="mm-empty">No outstanding debt</div>}
      </div>
    </div>
  )
}

// Non-primary market labels that map to a registered asset get its CDN icon
// next to the label (GIGAHDX → asset 67, the token the market is named after).
const MARKET_ICON_ASSET: Record<string, number> = { gigahdx: 67 }

// Every market gets the full position treatment; only the primary market is
// allowed to deep-link into DefiSim.
function MoneyMarketCard({ mm, defisimAddress }: { mm: MoneyMarketPosition; defisimAddress?: string }) {
  const hf = healthFactorDisplay(mm.healthFactor)
  const supplyUsd = Number(mm.totalSuppliedBase ?? mm.totalCollateralBase) / 1e8
  const debtUsd = Number(mm.totalDebtBase) / 1e8
  const headingId = `money-market-${mm.marketKey.replace(/[^a-z0-9_-]/gi, '-')}`
  const isPrimary = mm.role === 'primary'
  const iconAsset = MARKET_ICON_ASSET[mm.marketKey]
  return (
    <section className="mm-market-section" aria-labelledby={headingId} data-market-key={mm.marketKey}>
      <header className="sec-title mm-title-row">
        <h2 id={headingId} className="mm-title">{isPrimary ? mm.market : 'Money Market'}</h2>
        <span className="mm-title-note">
          {isPrimary ? 'primary' : <>{iconAsset != null && <AssetIcon assetId={iconAsset} symbol={mm.market} size={14} />} {mm.market}</>} · supply &amp; borrow
        </span>
        {mm.stakingBacked && <span className="mm-title-note">collateral is staked HDX — counted once in the wallet balance</span>}
        {defisimAddress && <a className="ext-link mm-defisim-link" href={`https://defisim.neckwork.net/?address=${encodeURIComponent(defisimAddress)}`} target="_blank" rel="noopener noreferrer">Open in DefiSim ↗</a>}
      </header>
      <div className="mm-card">
        <div className="mm-summary">
          <div className="mm-stat"><span className="k">Supplied</span><span className="v">{F.usd(supplyUsd)}</span></div>
          <div className="mm-stat"><span className="k">Borrowed</span><span className="v">{debtUsd > 0 ? F.usd(debtUsd) : '—'}</span></div>
          <div className="mm-stat"><span className="k">Net worth</span><span className="v">{F.usd(supplyUsd - debtUsd)}</span></div>
          <div className="mm-stat"><span className="k">Available to borrow</span><span className="v">{F.usd(Number(mm.availableBorrowsBase) / 1e8)}</span></div>
          <div className="mm-stat"><span className="k">{mm.simAccount ? 'Lowest member health' : 'Health factor'}</span><span className={`v hf ${hf.cls}`}>{hf.label}</span></div>
        </div>
        <MoneyMarketRiskBar mm={mm} />
        <MoneyMarketReserveColumns mm={mm} />
      </div>
    </section>
  )
}

// Shared account/tag renderer. The role comes from the API so presentation does
// not depend on risk order or on a magic market label. Every market renders as
// the same full card — primary first, DefiSim scoped to it.
export function MoneyMarketPositions({ markets, defisimAddress }: { markets: MoneyMarketPosition[]; defisimAddress?: string }) {
  const primary = markets.find(m => m.role === 'primary') ?? markets.find(m => m.marketKey === 'core')
  const others = markets.filter(m => m !== primary)
  const primaryDefisim = primary?.defiSimSupported ? (primary.simAccount ?? defisimAddress) : undefined
  return (
    <>
      {primary && <MoneyMarketCard mm={primary} defisimAddress={primaryDefisim} />}
      {others.map(mm => <MoneyMarketCard key={mm.marketKey} mm={mm} />)}
    </>
  )
}

export function ActiveDcaTable({ dcas, headBlock, headTime, now }: { dcas: ActiveDca[]; headBlock: number; headTime?: string; now: number }) {
  if (!dcas.length) return null
  return (
    <>
      <div className="sec-title">Active DCA orders · {dcas.length}</div>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Selling → Buying</th><th className="r">Per trade</th><th className="r">Budget</th><th className="r">Filled</th><th className="r">Every</th><th className="r">Next exec.</th></tr></thead>
        <tbody>
          {dcas.map(d => {
            // Buy orders specify the output per trade ("buy 80 USDC"); sell orders the input.
            const isBuy = d.direction === 'Buy'
            const perAsset = isBuy ? d.assetOut : d.assetIn
            const total = d.totalAmount === '0' ? null : Number(d.totalAmount) / 10 ** d.assetIn.decimals
            const filled = Number(d.filledAmount) / 10 ** d.assetIn.decimals
            const pct = total && total > 0 ? Math.min(100, filled / total * 100) : null
            return (
              <tr key={d.id} {...rowNav(paths.dcaSchedule(d.id))} data-dca-schedule={d.id}>
                <td data-label="Selling → Buying">
                  <span className="asset-flow">
                    <span className="trade-leg"><AssetIcon assetId={d.assetIn.assetId} iconAssetId={d.assetIn.iconAssetId} symbol={d.assetIn.symbol} size={20} parachainId={d.assetIn.parachainId} origin={d.assetIn.origin} /> <span className="mono">{d.assetIn.symbol}</span></span>
                    {' → '}
                    <span className="trade-leg"><AssetIcon assetId={d.assetOut.assetId} iconAssetId={d.assetOut.iconAssetId} symbol={d.assetOut.symbol} size={20} parachainId={d.assetOut.parachainId} origin={d.assetOut.origin} /> <span className="mono">{d.assetOut.symbol}</span></span>
                  </span>
                </td>
                <td data-label="Per trade" className="r"><AssetAmount asset={perAsset} raw={d.amountPerTrade} />{isBuy ? ' (buy)' : ''}</td>
                <td data-label="Budget" className="r">{total != null ? <AssetAmount asset={d.assetIn} raw={d.totalAmount} /> : <span className="mono muted">open-ended</span>}</td>
                <td data-label="Filled" className="r mono muted">{pct != null ? `${pct.toFixed(0)}% · ${d.executionsDone}×` : `${d.executionsDone}× · open-ended`}</td>
                <td data-label="Every" className="r mono muted">{d.period} blocks</td>
                <td data-label="Next exec." className="r mono muted"><DcaNextExec nextBlock={d.nextExecutionBlock} headBlock={headBlock} headTime={headTime} now={now} /></td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

// Venue → badge colour, so the LP products read apart at a glance: NFT-held
// Omnipool positions (bare / farmed) vs wallet-held stableswap pool shares.
const LP_VENUE_COLORS: Record<string, string> = { Omnipool: 'var(--sky)', 'Omnipool Farm': 'var(--green)', Stablepool: 'var(--lavender)' }

export function LiquidityPositionsTable({ positions }: { positions: LpPosition[] }) {
  if (!positions.length) return null
  return (
    <>
      <div className="sec-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>Liquidity positions · {positions.length}
        <span className="muted" style={{ fontFamily: 'GeistMono', fontSize: 11, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>provided to pools & farms</span>
      </div>
      <div className="panel"><table className="tbl assets-tbl">
        <thead><tr><th>Pool asset</th><th>Venue</th><th className="r">Amount</th><th className="r">Value</th></tr></thead>
        <tbody>
          {positions.map(p => {
            const col = LP_VENUE_COLORS[p.venue] ?? 'var(--sky)'
            return (
              <tr key={p.positionId} {...rowNav(paths.asset(p.asset.assetId))}>
                <td data-label="Pool asset">
                  <div className="asset-row">
                    <AssetIcon assetId={p.asset.assetId} iconAssetId={p.asset.iconAssetId} symbol={p.asset.symbol} size={30} parachainId={p.asset.parachainId} origin={p.asset.origin} />
                    <div className="ar-meta"><span className="ar-sym">{p.asset.symbol}</span><span className="ar-name">{p.venue === 'Stablepool' ? 'Pool shares' : `Position #${p.positionId}`}</span></div>
                  </div>
                </td>
                <td data-label="Venue"><span className="badge" style={{ background: `color-mix(in srgb, ${col} 14%, transparent)`, color: col }}>{p.venue}</span></td>
                <td data-label="Amount" className="r mono">
                  {F.amount(p.amount, p.asset.decimals)} {p.asset.symbol}
                  {p.hubAmount && <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>+ {F.amount(p.hubAmount, 12)} H2O</div>}
                </td>
                <td data-label="Value" className="r mono">{F.usd(p.valueUsd)}</td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </>
  )
}

// Balance-history section (per-asset). Thin wrapper so detail pages import all
// account sections from one place.
export function BalanceHistorySection({ history }: { history?: AssetBalanceHistory[] }) {
  if (!history || history.length === 0) return null
  return <BalanceHistory history={history} />
}

/* ============ proxy & multisig ============ */
const PROXY_TYPE_COLORS: Record<string, string> = {
  Any: 'var(--red)', CancelProxy: 'var(--text-low)', Governance: 'var(--sky)',
  Transfer: 'var(--accent)', Liquidity: 'var(--green)', LiquidityMining: 'var(--green)',
}
function ProxyTypeBadge({ type }: { type: string }) {
  const col = PROXY_TYPE_COLORS[type] ?? 'var(--text-medium)'
  return <span className="pill-badge" title={`Proxy type: ${type}`} style={{ color: col, background: `color-mix(in srgb, ${col} 14%, transparent)` }}>{type}</span>
}
// Delay in blocks rendered with its rough wall-clock equivalent (6s blocks).
function proxyDelay(delay: number): string | null {
  if (delay <= 0) return null
  const s = delay * 6
  const human = s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return `${F.int(delay)} blocks (~${human})`
}
function ProxyRelationRow({ rel }: { rel: ProxyRelation }) {
  const delay = proxyDelay(rel.delay)
  return (
    <span className="proxy-rel">
      <AddrPill account={rel.account} />
      <ProxyTypeBadge type={rel.proxyType} />
      {delay && <span className="muted mono" style={{ fontSize: 11 }} title="Announcement delay before the proxy call executes">delay {delay}</span>}
    </span>
  )
}

// Proxy & multisig relations for the Overview tab. Three cards, each rendered
// only when the account actually has such a relation: who can act for this
// account (its proxies) / whom it can act for, the multisig composition with
// pending operations, and multisig memberships on signer pages.
export function ProxyMultisigSection({ proxy, multisig, memberships }: {
  proxy?: AccountProxyInfo | null
  multisig?: MultisigInfo | null
  memberships?: MultisigMembership[]
}) {
  if (!proxy && !multisig && !memberships?.length) return null
  return (
    <>
      {proxy && (
        <div className="id-card">
          <div className="id-card-head">Proxy</div>
          <div className="dl">
            {proxy.isPure && (
              <>
                <div className="dt">Pure proxy</div>
                <div className="dd proxy-dd">
                  <span className="muted">Keyless account created by</span>
                  <AddrPill account={proxy.isPure.creator} />
                  <span className="muted">at</span>
                  <Link className="hash" to={paths.block(proxy.isPure.blockHeight)} title={F.datetime(proxy.isPure.timestamp)}>#{F.int(proxy.isPure.blockHeight)}</Link>
                </div>
              </>
            )}
            {proxy.delegates.length > 0 && (
              <>
                <div className="dt" title="Accounts allowed to submit calls on behalf of this account">Controlled by</div>
                <div className="dd proxy-dd">{proxy.delegates.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} />)}</div>
              </>
            )}
            {proxy.delegatorOf.length > 0 && (
              <>
                <div className="dt" title="Accounts this account may submit calls for">Proxy for</div>
                <div className="dd proxy-dd">{proxy.delegatorOf.map((r, i) => <ProxyRelationRow key={`${r.account.accountId}-${r.proxyType}-${i}`} rel={r} />)}</div>
              </>
            )}
          </div>
        </div>
      )}

      {multisig && (
        <div className="id-card">
          <div className="id-card-head">Multisig · {multisig.threshold} of {multisig.signatories.length}</div>
          <div className="dl">
            <div className="dt" title={`Any ${multisig.threshold} of these ${multisig.signatories.length} accounts can act as this account`}>Signatories</div>
            <div className="dd proxy-dd">{multisig.signatories.map(s => <AddrPill key={s.accountId} account={s} />)}</div>
            {multisig.pending.length > 0 && (
              <>
                <div className="dt">Pending calls</div>
                <div className="dd proxy-dd" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                  {multisig.pending.map(p => (
                    <span key={p.callHash} className="proxy-rel">
                      <span className="mono" title={p.callHash}>{F.shortHash(p.callHash)}</span>
                      <span className="pill-badge" style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 14%, transparent)' }}>{p.approvals.length}/{multisig.threshold} approved</span>
                      {p.approvals.map(a => <AddrPill key={a.accountId} account={a} noCopy />)}
                      <span className="muted mono" style={{ fontSize: 11 }}>since <Link className="hash" to={paths.block(p.sinceBlock)}>#{F.int(p.sinceBlock)}</Link></span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!!memberships?.length && (
        <div className="id-card">
          <div className="id-card-head">Multisig member</div>
          <div className="dl">
            <div className="dt" title="Multisig accounts this account is a signatory of">Signatory of</div>
            <div className="dd proxy-dd">
              {memberships.map(m => (
                <span key={m.account.accountId} className="proxy-rel">
                  <AddrPill account={m.account} />
                  <span className="pill-badge" style={{ color: 'var(--sky)', background: 'color-mix(in srgb, var(--sky) 14%, transparent)' }}>{m.threshold} of {m.signatories}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
