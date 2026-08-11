import { useState } from 'react'
import type { ReactNode } from 'react'
import { useSecurityDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { Link, paths, SECURITY_SECTIONS } from '../router'
import type { SecuritySection } from '../router'
import {
  AddrPill, Ago, AssetAmount, AssetChip, ChartSkeleton, Crumbs, Dash, EmptyRow, F, MomentLink, TableSkeleton,
} from '../components/ui'
import { DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { FuseGrid, LoadMeter, YearBars } from '../components/SecurityPanels'
import {
  AUDITS, CONTROL_ORIGINS, SECURITY_LINKS, UNPAUSABLE, fmtBlocks, fmtDuration, fmtPct, loadColor,
} from '../utils/security'
import type { SecurityDashboard, SecurityFuse, SecurityPerBlockRow, SecuritySafetyEvent } from '../types'

// Security: what stops value leaving the chain, what caps value arriving, what
// throttles the pool each block, what is switched off right now — and who holds
// each switch. Live chain state for the limits and their consumption, indexed
// history for every time a control fired or was changed.

const LEDGER_PAGE = 25
// The floor the hand-off links to the activity feed carry, so a reader arriving
// there sees movements on the scale this page is about rather than the whole feed.
const LARGE_MOVEMENT_USD = 100_000

// Each section is its own page under /security. Switching is a real navigation, so
// the reader lands at the top of what they asked for rather than at whatever scroll
// offset the tile they clicked happened to sit at.
const SECTION_LABELS: Record<SecuritySection, string> = {
  'cross-chain': 'Cross-chain',
  omnipool: 'Omnipool',
  'money-market': 'Money market',
  freezes: 'Freezes',
  ledger: 'Ledger',
  guardians: 'Guardians',
}
const SECTION_BLURB: Record<SecuritySection, string> = {
  'cross-chain': 'what caps value entering and leaving the chain',
  omnipool: 'what each block allows, and when it bit',
  'money-market': 'solvency, bad debt and liquidations',
  freezes: 'what is switched off right now',
  ledger: 'every safety action on the record',
  guardians: 'who holds each switch',
}

// The same row on every section page, so moving between them is still one click.
function SectionNav({ active }: { active: SecuritySection }) {
  return (
    <div className="sec-section-nav">
      <div className="tabs detail-tabs">
        <Link to={paths.security()} className="sec-nav-link">Overview</Link>
        {SECURITY_SECTIONS.map(s => (
          <Link key={s} to={paths.security(s)} className={`sec-nav-link${s === active ? ' active' : ''}`}>{SECTION_LABELS[s]}</Link>
        ))}
      </div>
    </div>
  )
}

// One dot colour per ledger entry kind: red when a control clamped down, green
// when one was released, sky for a configuration change.
const KIND_COLOR: Record<string, string> = {
  lockdown: 'var(--red)',
  freeze: 'var(--red)',
  pause: 'var(--amber)',
  'lockdown-lifted': 'var(--green)',
  unfreeze: 'var(--green)',
  unpause: 'var(--green)',
  limit: 'var(--sky)',
}

function Kind({ kind }: { kind: string }) {
  return <i className="sec-dot" style={{ background: KIND_COLOR[kind] ?? 'var(--text-low)' }} aria-hidden="true" />
}

// 0. overview — the whole posture on one screen: the two live instruments, then one
// card per area that says what it would take to look closer. Every card links to the
// section page that holds its detail, so the page reads top-down before sideways.
function OverviewCard({ section, label, value, sub, tone }: {
  section: SecuritySection; label: string; value: ReactNode; sub: ReactNode; tone?: string
}) {
  return (
    <Link to={paths.security(section)} className="hdx-card sec-ov-card" ariaLabel={`${label} — open ${SECTION_LABELS[section]}`}>
      <div className="hk">{label}</div>
      <div className="hv" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="hs">{sub}</div>
    </Link>
  )
}

function Overview({ d, now }: { d: SecurityDashboard; now: number }) {
  const primary = d.risk.markets.find(m => m.role === 'primary')
  const loadedFuses = d.fuses.rows.filter(r => r.status === 'active' && r.usagePct > 0)
  const hottest = loadedFuses[0]
  const peak = d.perBlock.rows.reduce((m, r) => Math.max(m, r.peakPressurePct ?? 0), 0)
  const restricted = d.freezes.omnipool.length + d.freezes.stableswap.length
  return (
    <>
      {d.withdraw.configured && (
        <>
          <SecTitle title="Value leaving the chain" subtitle={d.withdraw.windowMs != null ? `${fmtDuration(d.withdraw.windowMs)} window` : undefined} />
          <div className="pf-card">
            <WithdrawMeter d={d} />
            <div className="hdx-note" style={{ marginTop: 12 }}>
              One chain-wide budget in HDX, draining linearly back to zero. {d.withdraw.everTripped ? 'It has been tripped before.' : 'It has never been tripped.'}{' '}
              <Link className="sec-inline-link" to={paths.security('cross-chain')}>See the egress detail →</Link>
            </div>
          </div>
        </>
      )}

      <SecTitle title="Value arriving, per asset" subtitle={`${d.fuses.rows.length} rate-limited assets · ${fmtBlocks(d.fuses.periodBlocks)} window`} />
      <FuseBoard d={d} loadedOnly note={<>
        Each asset can only be minted so fast, and a deposit that overshoots is held in reserve until the lockdown lifts.{' '}
        <Link className="sec-inline-link" to={paths.security('cross-chain')}>See the ingress detail →</Link>
      </>} />

      <SecTitle title="Everything else" />
      <div className="hdx-cards sec-ov">
        <OverviewCard section="cross-chain" label="Deposit fuses"
          value={d.fuses.lockedCount ? `${F.int(d.fuses.lockedCount)} locked` : hottest ? fmtPct(hottest.usagePct) : 'idle'}
          tone={d.fuses.lockedCount ? 'var(--red)' : hottest ? loadColor(hottest.usagePct) : undefined}
          sub={d.fuses.lockedCount ? 'minting held in reserve' : hottest ? `${hottest.asset.symbol} is the fullest of ${F.int(loadedFuses.length)} carrying load` : 'no asset is minting against its limit'} />
        <OverviewCard section="omnipool" label="Per-block limits"
          value={fmtPct(peak)} tone={loadColor(peak)}
          sub={`busiest block in ${d.perBlock.peakWindowDays} days, against its allowance`} />
        <OverviewCard section="omnipool" label="Breaker trips"
          value={F.int(d.trips.enforcementTotal)}
          sub={`rejections on record · ${d.trips.byYear.at(-1)?.count ?? 0} this year`} />
        <OverviewCard section="money-market" label="Borrowed"
          value={primary ? F.usd(primary.debtUsd) : <Dash />}
          sub={primary ? `${F.int(primary.borrowers)} borrowers in the primary market` : 'no market data'} />
        <OverviewCard section="money-market" label="Within 5%"
          value={primary?.nearLiquidationDebtUsd != null ? F.usd(primary.nearLiquidationDebtUsd) : <Dash />}
          sub={primary?.nearLiquidationCount != null
            ? `${F.int(primary.nearLiquidationCount)} positions near liquidation, excluding e-mode and isolated loops`
            : 'needs chain state to tell a loop from a directional borrow'} />
        <OverviewCard section="money-market" label="Bad debt"
          value={primary ? (primary.badDebtUsd > 0 ? F.usd(primary.badDebtUsd) : 'none') : <Dash />}
          tone={primary && primary.badDebtUsd > 0 ? 'var(--red)' : 'var(--green)'}
          sub={primary && primary.badDebtCount > 0
            ? `unrecoverable, on ${F.int(primary.badDebtCount)} of the ${F.int(primary.underwaterCount)} positions under water`
            : 'every position covers its debt'} />
        <OverviewCard section="money-market" label="Liquidations"
          value={F.int(d.risk.liquidations.month)}
          sub={<>in 30 days{d.risk.liquidations.lastTimestamp && <> · last <Ago ts={d.risk.liquidations.lastTimestamp} now={now} /></>}</>} />
        <OverviewCard section="freezes" label="Switched off"
          value={`${F.int(d.freezes.paused.length)} calls`}
          tone={d.freezes.paused.length ? 'var(--amber)' : 'var(--green)'}
          sub={restricted ? `${F.int(restricted)} pool assets restricted` : 'no pool asset restricted'} />
        <OverviewCard section="guardians" label="Runtime"
          value={d.runtime.specVersion ? `spec ${F.int(d.runtime.specVersion)}` : <Dash />}
          sub={d.runtime.lastUpgrade ? <>upgraded <Ago ts={d.runtime.lastUpgrade.blockTimestamp} now={now} /> · {F.int(d.runtime.upgrades)} in total</> : 'no upgrade recorded'} />
      </div>

      <SecTitle title="Latest safety action" />
      <Ledger events={d.timeline.slice(0, 6)} now={now} compact />
    </>
  )
}

// 1. posture ribbon — the six numbers that answer "is anything tripped?"
function Ribbon({ d, now }: { d: SecurityDashboard; now: number }) {
  const cells: { k: string; v: ReactNode; to: SecuritySection }[] = [
    {
      k: 'Assets locked', to: 'cross-chain',
      v: <span style={{ color: d.fuses.lockedCount ? 'var(--red)' : 'var(--green)' }}>{F.int(d.fuses.lockedCount)}</span>,
    },
    { k: 'Calls paused', to: 'freezes', v: F.int(d.freezes.paused.length) },
    { k: 'Assets restricted', to: 'freezes', v: F.int(d.freezes.omnipool.length + d.freezes.stableswap.length) },
    {
      k: 'Egress used', to: 'cross-chain',
      v: d.withdraw.usagePct != null
        ? <span style={{ color: loadColor(d.withdraw.usagePct) }}>{fmtPct(d.withdraw.usagePct)}</span>
        : <Dash />,
    },
    { k: 'Breaker trips', to: 'omnipool', v: F.int(d.trips.enforcementTotal) },
    {
      k: 'Last action', to: 'ledger',
      v: d.timeline[0] ? <Ago ts={d.timeline[0].blockTimestamp} now={now} /> : <Dash />,
    },
  ]
  return (
    <div className="ribbon standalone">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <Link to={paths.security(c.to)} className="cell sec-ribbon-cell" ariaLabel={`${c.k} — open ${SECTION_LABELS[c.to]}`}>
            <span className="k">{c.k}</span><span className="v">{c.v}</span>
          </Link>
        </span>
      ))}
    </div>
  )
}

// 2. global withdraw limit
const WITHDRAW_EXPLAINER = 'Every withdrawal and every transfer into a bridge or exchange sink is priced in HDX and added to one chain-wide accumulator. The accumulator drains linearly back to zero over the window, so sustained outflow builds pressure while a single large transfer does not. An operation that would push the total past the limit is rejected outright — passing the limit does not lock the chain by itself; only the technical committee or governance can arm a lockdown.'

function WithdrawMeter({ d }: { d: SecurityDashboard }) {
  const w = d.withdraw
  if (!w.configured) return null
  const lockedDown = w.lockdownUntilMs != null
  return (
    <>
      <div className="sec-meter-head">
        <span className="mono sec-meter-value">
          {F.int(Math.round(w.used ?? 0))} <span className="muted">/ {F.int(Math.round(w.limit ?? 0))} HDX</span>
        </span>
        {lockedDown && <span className="badge fail">Locked down</span>}
      </div>
      <LoadMeter pct={w.usagePct} label={<span className="mono">{fmtPct(w.usagePct)}</span>} height={16} />
    </>
  )
}

function WithdrawSection({ d, now }: { d: SecurityDashboard; now: number }) {
  const w = d.withdraw
  if (!w.configured) {
    return (
      <>
        <SecTitle title="Withdraw limit" subtitle="chain-wide" />
        <div className="pf-card">
          <div className="hdx-note">
            {d.chainAsOf
              ? 'No global withdraw limit is configured, so the chain-wide egress budget is not enforced.'
              : 'Chain state is unavailable, so the egress budget cannot be shown. Its history is in the safety ledger below.'}
          </div>
        </div>
      </>
    )
  }
  return (
    <>
      <SecTitle title="Withdraw limit" subtitle={w.windowMs != null ? `${fmtDuration(w.windowMs)} window` : undefined} />
      <div className="pf-card">
        <WithdrawMeter d={d} />
        <div className="hdx-cards" style={{ marginTop: 14 }}>
          <div className="hdx-card">
            <div className="hk">Headroom</div>
            <div className="hv">{w.limit != null && w.used != null ? F.int(Math.round(w.limit - w.used)) : '—'}</div>
            <div className="hs">HDX before the next withdrawal is refused</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Drains to zero in</div>
            <div className="hv">{w.windowMs != null ? fmtDuration(w.windowMs) : '—'}</div>
            <div className="hs">linear decay · last credited {w.lastCreditedMs ? <Ago ts={new Date(w.lastCreditedMs).toISOString()} now={now} /> : '—'}</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Armed</div>
            <div className="hv">{w.armedAt ? <Ago ts={w.armedAt.blockTimestamp} now={now} /> : '—'}</div>
            <div className="hs">{w.armedAt ? <Link className="hash" to={paths.block(w.armedAt.blockHeight)}>block {F.int(w.armedAt.blockHeight)}</Link> : 'not yet armed'}</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Times tripped</div>
            <div className="hv" style={{ color: w.everTripped ? 'var(--amber)' : 'var(--green)' }}>{w.everTripped ? 'yes' : 'never'}</div>
            <div className="hs">no lockdown has ever been armed</div>
          </div>
        </div>
        <div className="hdx-note" style={{ marginTop: 14 }}>{WITHDRAW_EXPLAINER}</div>
        {w.egressAccounts.length > 0 && (
          <>
            <div className="sec-sub">Egress sinks · {w.egressAccounts.length}</div>
            <div className="sec-sinks">
              {w.egressAccounts.map(s => (
                <span key={s.account.accountId} className="sec-sink">
                  {s.chain && <span className="sec-sink-chain">{s.chain}</span>}
                  <AddrPill account={s.account} noTag />
                </span>
              ))}
            </div>
            <div className="hdx-note">
              Transfers into these accounts count against the budget. {w.localAssets.length > 0 && <>Only {w.localAssets.map(a => a.symbol).join(' and ')} are accounted as local assets — the other {F.int(w.externalAssetCount)} participating assets are external, and their every withdrawal counts.</>}
            </div>
          </>
        )}
      </div>
    </>
  )
}

// 3. deposit fuses
const FUSE_EXPLAINER = 'Each of these assets can be minted only so fast. Every deposit — a bridge arrival, an XCM transfer in, a mint through the EVM — is measured against the asset\'s own 24-hour allowance. A deposit that overshoots still lands, but the excess is held in a named reserve and the asset stops accepting free mints until the lockdown lifts, automatically after 24 hours or sooner if the technical committee lifts it. The reserved funds are then claimable by anyone, for free.'

const FUSE_STATUS_BADGE: Record<SecurityFuse['status'], { label: string; cls: string }> = {
  locked: { label: 'Locked', cls: 'fail' },
  active: { label: 'Armed', cls: 'ok' },
  expired: { label: 'Idle', cls: 'finalized' },
  unarmed: { label: 'Unused', cls: 'finalized' },
}

function FuseTable({ d, headBlock }: { d: SecurityDashboard; headBlock: number }) {
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead>
          <tr>
            <th>Asset</th><th>Status</th><th className="r">24h limit</th><th className="r">Minted</th>
            <th className="r">Used</th><th className="r">Window</th><th className="r">Trips</th>
          </tr>
        </thead>
        <tbody>
          {!d.fuses.rows.length ? <EmptyRow cols={7}>No asset carries a deposit limit</EmptyRow> : d.fuses.rows.map(r => {
            const badge = FUSE_STATUS_BADGE[r.status]
            const dormant = r.status === 'expired' || r.status === 'unarmed'
            return (
              <tr key={r.asset.assetId}>
                <td data-label="Asset"><AssetChip asset={r.asset} /></td>
                <td data-label="Status"><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                <td data-label="24h limit" className="r"><AssetAmount asset={r.asset} raw={r.limit} link={false} /></td>
                <td data-label="Minted" className={`r${dormant ? ' cell-empty' : ''}`}>{dormant ? <Dash /> : <AssetAmount asset={r.asset} raw={r.used} link={false} />}</td>
                <td data-label="Used" className={`r mono${dormant ? ' cell-empty' : ''}`} style={{ color: r.usagePct > 0 ? loadColor(r.usagePct) : undefined }}>
                  {dormant ? <span className="muted">—</span> : fmtPct(r.usagePct)}
                </td>
                <td data-label="Window" className="r mono muted">
                  {r.status === 'locked' && r.untilBlock ? `unlocks in ${fmtBlocks(Math.max(0, r.untilBlock - headBlock))}`
                    : r.status === 'active' && r.periodEndBlock ? `resets in ${fmtBlocks(Math.max(0, r.periodEndBlock - headBlock))}`
                      : r.status === 'expired' ? 'next mint resets' : 'not started'}
                </td>
                <td data-label="Trips" className={`r mono muted${r.lockdownCount ? '' : ' cell-empty'}`}>{r.lockdownCount || <span className="muted">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LockdownHistory({ d, now }: { d: SecurityDashboard; now: number }) {
  const [expanded, setExpanded] = useState(false)
  const rows = expanded ? d.fuses.lockdowns : d.fuses.lockdowns.slice(0, 10)
  return (
    <>
      <SecTitle title="Lockdowns" subtitle={`${d.fuses.lockdownTotal} since 2025 · ${d.fuses.releaseTotal} reserves released`} />
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>Asset</th><th>Tripped</th><th className="r">Held for</th><th>Cleared</th><th className="r">How</th></tr></thead>
          <tbody>
            {!rows.length ? <EmptyRow cols={5}>No deposit fuse has ever tripped</EmptyRow> : rows.map(l => (
              <tr key={`${l.asset.assetId}-${l.blockHeight}`}>
                <td data-label="Asset"><AssetChip asset={l.asset} /></td>
                <td data-label="Tripped"><MomentLink at={{ blockHeight: l.blockHeight, extrinsicIndex: l.extrinsicIndex, timestamp: l.blockTimestamp }} now={now} /></td>
                <td data-label="Held for" className="r mono muted">
                  {l.liftedAtBlock ? fmtBlocks(l.liftedAtBlock - l.blockHeight) : `${fmtBlocks(l.untilBlock - l.blockHeight)} (scheduled)`}
                </td>
                <td data-label="Cleared">{l.liftedAtTimestamp ? <Ago ts={l.liftedAtTimestamp} now={now} /> : <span className="muted">still locked</span>}</td>
                <td data-label="How" className={`r mono muted${l.liftedEarly == null ? ' cell-empty' : ''}`}>
                  {l.liftedEarly == null ? '—' : l.liftedEarly ? <span style={{ color: 'var(--lavender)' }}>lifted early</span> : 'window elapsed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.fuses.lockdowns.length > 10 && (
        <div className="sec-more">
          <button type="button" className="btn" onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Show fewer' : `Show all ${d.fuses.lockdowns.length}`}
          </button>
        </div>
      )}
    </>
  )
}

function FuseBoard({ d, explain, loadedOnly, note }: { d: SecurityDashboard; explain?: boolean; loadedOnly?: boolean; note?: ReactNode }) {
  const loaded = d.fuses.rows.filter(r => r.status === 'locked' || (r.status === 'active' && r.usagePct > 0))
  const shown = loadedOnly ? loaded : d.fuses.rows
  return (
    <div className="pf-card">
      {shown.length
        ? <FuseGrid fuses={shown} />
        : <div className="hdx-note">No asset is minting against its limit right now.</div>}
      <div className="sec-legend">
        <span><i style={{ background: 'var(--green)' }} />under half</span>
        <span><i style={{ background: 'var(--amber)' }} />over half</span>
        <span><i style={{ background: 'var(--red)' }} />over three quarters or locked</span>
        <span className="muted">
          {loadedOnly
            ? <>showing the {loaded.length} carrying load of {d.fuses.rows.length}</>
            : <>{loaded.length} of {d.fuses.rows.length} fuses carrying load</>}
        </span>
      </div>
      {explain && <div className="hdx-note" style={{ marginTop: 12 }}>{FUSE_EXPLAINER}</div>}
      {note != null && <div className="hdx-note" style={{ marginTop: 12 }}>{note}</div>}
    </div>
  )
}

function FuseSection({ d, headBlock, now }: { d: SecurityDashboard; headBlock: number; now: number }) {
  return (
    <>
      <SecTitle title="Deposit fuses" subtitle={`${d.fuses.rows.length} assets · ${fmtBlocks(d.fuses.periodBlocks)} window`} />
      <FuseBoard d={d} explain />
      <FuseTable d={d} headBlock={headBlock} />
      <LockdownHistory d={d} now={now} />
    </>
  )
}

// 4. per-block limits
const PER_BLOCK_EXPLAINER = 'The Omnipool measures each asset against its reserve at the start of every block. Net trade volume — buys minus sells, so a round trip inside one block is free — may not exceed half the reserve, and liquidity may not move more than a twentieth in either direction. The counters are wiped at the end of every block, so a rejected trade succeeds in the next one. The hub asset is exempt and the treasury is whitelisted from the liquidity limits.'

function PerBlockTable({ rows, peakDays }: { rows: SecurityPerBlockRow[]; peakDays: number }) {
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead>
          <tr>
            <th>Asset</th><th className="r">Reserve</th><th className="r">Net trade / block</th>
            <th className="r">Add / block</th><th className="r">Remove / block</th>
            <th className="r">Busiest block ({peakDays}d)</th><th className="r">of allowance</th>
          </tr>
        </thead>
        <tbody>
          {!rows.length ? <EmptyRow cols={7}>No Omnipool assets</EmptyRow> : rows.map(r => (
            <tr key={r.asset.assetId} className={r.tradable.length < 4 ? 'dim' : undefined}>
              <td data-label="Asset">
                <AssetChip asset={r.asset} />
                {r.overridden && <span className="pill-badge" style={{ background: 'var(--lavender-soft)', color: 'var(--lavender-deep)', marginLeft: 6 }}>override</span>}
              </td>
              <td data-label="Reserve" className="r">
                <span className="trade-leg">
                  <AssetAmount asset={r.asset} raw={r.reserve} link={false} />
                  {r.reserveUsd != null && <span className="muted">{F.usd(r.reserveUsd)}</span>}
                </span>
              </td>
              <td data-label="Net trade / block" className="r">
                <span className="trade-leg">
                  <AssetAmount asset={r.asset} raw={r.tradeAllowance} link={false} />
                  <span className="muted">{fmtPct(r.tradeLimitPct, 0)}</span>
                </span>
              </td>
              <td data-label="Add / block" className="r">
                {r.addAllowance == null ? <span className="muted">no limit</span> : <AssetAmount asset={r.asset} raw={r.addAllowance} link={false} />}
              </td>
              <td data-label="Remove / block" className="r">
                {r.removeAllowance == null ? <span className="muted">no limit</span> : <AssetAmount asset={r.asset} raw={r.removeAllowance} link={false} />}
              </td>
              <td data-label={`Busiest block (${peakDays}d)`} className={`r${r.peakBlockNet == null ? ' cell-empty' : ''}`}>
                {r.peakBlockNet == null || r.peakBlockHeight == null
                  ? <Dash />
                  : <Link className="hash" to={paths.block(r.peakBlockHeight)}>{F.amount(r.peakBlockNet, r.asset.decimals)}</Link>}
              </td>
              <td data-label="of allowance" className={`r mono${r.peakPressurePct == null ? ' cell-empty' : ''}`} style={{ color: r.peakPressurePct != null && r.peakPressurePct > 0 ? loadColor(r.peakPressurePct) : undefined }}>
                {r.peakPressurePct == null ? <Dash /> : fmtPct(r.peakPressurePct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PerBlockSection({ d }: { d: SecurityDashboard }) {
  const pb = d.perBlock
  const peak = pb.rows.reduce((m, r) => Math.max(m, r.peakPressurePct ?? 0), 0)
  return (
    <>
      <SecTitle title="Per-block limits" subtitle={`Omnipool · ${pb.rows.length} assets`} />
      <div className="pf-card">
        <div className="hdx-cards">
          <div className="hdx-card">
            <div className="hk">Net trade volume</div>
            <div className="hv">{fmtPct(pb.defaultTradePct, 0)}</div>
            <div className="hs">of the asset&apos;s reserve, per block</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Add liquidity</div>
            <div className="hv">{fmtPct(pb.defaultAddPct, 0)}</div>
            <div className="hs">of the reserve, per block</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Remove liquidity</div>
            <div className="hv">{fmtPct(pb.defaultRemovePct, 0)}</div>
            <div className="hs">of the reserve, per block</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Closest approach</div>
            <div className="hv" style={{ color: loadColor(peak) }}>{fmtPct(peak)}</div>
            <div className="hs">busiest single block in {pb.peakWindowDays} days, against today&apos;s allowance</div>
          </div>
        </div>
        <div className="hdx-note" style={{ marginTop: 14 }}>{PER_BLOCK_EXPLAINER}</div>
      </div>
      <PerBlockTable rows={pb.rows} peakDays={pb.peakWindowDays} />
      <div className="hdx-note" style={{ marginTop: 12 }}>
        Each busiest block links to the block that made it. For individual movements ranked by value, the{' '}
        <Link className="hash" to={`${paths.activity()}?tab=trade&min=${LARGE_MOVEMENT_USD}`}>activity feed</Link>{' '}
        classifies and values every trade one way — this page deliberately does not derive a second ranking that could disagree with it.
      </div>
    </>
  )
}

// 5. trips
function TripsSection({ d, now }: { d: SecurityDashboard; now: number }) {
  const t = d.trips
  const admin = t.byError.filter(e => !e.enforcement)
  return (
    <>
      <SecTitle title="Breaker trips" subtitle={`${F.int(t.enforcementTotal)} rejections on record`} />
      <div className="pf-card">
        <div className="sec-split">
          <div>
            <YearBars data={t.byYear} />
          </div>
          <div className="sec-errors">
            {t.byError.filter(e => e.enforcement).map(e => (
              <div key={e.name} className="sec-err">
                <span className="mono">{e.name}</span>
                <span className="mono sec-err-n">{F.int(e.count)}</span>
              </div>
            ))}
            {(['TokenOutflowLimitReached', 'TokenInfluxLimitReached', 'GlobalWithdrawLimitExceeded'] as const)
              .filter(name => !t.byError.some(e => e.name === name))
              .map(name => (
                <div key={name} className="sec-err dim">
                  <span className="mono">{name}</span>
                  <span className="mono sec-err-n">0</span>
                </div>
              ))}
          </div>
        </div>
        <div className="hdx-note" style={{ marginTop: 12 }}>
          Counted from every place a rejection surfaces: {F.int(t.directTotal)} as a failed extrinsic and {F.int(t.nestedTotal)} inside a batch or a multisig.
          The per-block <em>trade</em> limit has never rejected a trade, and neither has the chain-wide withdraw limit.
          {admin.length > 0 && <> A further {F.int(admin.reduce((s, e) => s + e.count, 0))} calls failed on the pallet&apos;s administrative errors ({admin.map(e => e.name).join(', ')}), which are not limits biting.</>}
        </div>
      </div>
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>Time</th><th>Call</th><th>Rejected by</th><th>Account</th></tr></thead>
          <tbody>
            {!t.recent.length ? <EmptyRow cols={4}>No circuit-breaker rejections on record</EmptyRow> : t.recent.map(r => (
              <tr key={r.extrinsicId}>
                <td data-label="Time"><Link className="hash" to={paths.extrinsic(r.extrinsicId)}><Ago ts={r.blockTimestamp} now={now} /></Link></td>
                <td data-label="Call" className="mono sec-wrap">{r.callName}</td>
                <td data-label="Rejected by" className="mono" style={{ color: 'var(--red)' }}>{r.errorName}</td>
                <td data-label="Account" className={r.account ? undefined : 'cell-empty'}>{r.account ? <AddrPill account={r.account} /> : <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// 6. freezes & pauses
function FreezeSection({ d, now }: { d: SecurityDashboard; now: number }) {
  const f = d.freezes
  return (
    <>
      <SecTitle title="Freezes & pauses" subtitle="switched off right now" />
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>Paused call</th><th>Since</th><th className="r">Held for</th></tr></thead>
          <tbody>
            {!f.paused.length ? <EmptyRow cols={3}>No call is paused</EmptyRow> : f.paused.map(p => (
              <tr key={`${p.pallet}.${p.call}`}>
                <td data-label="Paused call" className="mono sec-wrap" style={{ color: 'var(--text-high)' }}>
                  {p.pallet}.{p.call}
                  {/* The pause row outlives its pallet's removal, so it still stands
                      while gating nothing. */}
                  {p.orphaned && <span className="pill-badge sec-orphan">pallet retired</span>}
                </td>
                <td data-label="Since">
                  {p.pausedAtBlock != null && p.pausedAtTimestamp
                    ? <MomentLink at={{ blockHeight: p.pausedAtBlock, extrinsicIndex: p.extrinsicIndex, timestamp: p.pausedAtTimestamp }} now={now} />
                    : <Dash />}
                </td>
                <td data-label="Held for" className="r mono muted">{p.pausedAtBlock != null ? fmtBlocks(d.head.blockHeight - p.pausedAtBlock) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hdx-note" style={{ margin: '12px 0 20px' }}>
        A paused call is refused for everyone, immediately, without a runtime upgrade. The runtime refuses to let the filter touch{' '}
        {UNPAUSABLE.map((p, i) => <span key={p}>{i > 0 && ' · '}<span className="mono">{p}</span></span>)} — so governance itself can never be switched off.
      </div>

      <div className="hdx-cards">
        <div className="hdx-card">
          <div className="hk">Omnipool assets</div>
          <div className="hv" style={{ color: f.omnipool.length ? 'var(--amber)' : 'var(--green)' }}>
            {f.omnipool.length ? `${f.omnipool.length} restricted` : 'all open'}
          </div>
          <div className="hs">{F.int(f.omnipoolAssetCount)} listed{f.omnipool.length ? ` · ${f.omnipool.map(r => r.asset.symbol).join(', ')}` : ', every operation allowed'}</div>
        </div>
        <div className="hdx-card">
          <div className="hk">Stablepool assets</div>
          <div className="hv" style={{ color: f.stableswap.length ? 'var(--amber)' : 'var(--green)' }}>
            {f.stableswap.length ? `${f.stableswap.length} restricted` : 'all open'}
          </div>
          <div className="hs">{f.stableswap.length ? f.stableswap.map(r => `${r.asset.symbol} in pool ${r.poolId}`).join(', ') : 'no pool asset is frozen'}</div>
        </div>
        <div className="hdx-card">
          <div className="hk">Hub asset (H2O)</div>
          <div className="hv">{f.hubTradability.join(' · ') || 'Frozen'}</div>
          <div className="hs">permanent by design — the hub can only be sold into the pool</div>
        </div>
        <div className="hdx-card">
          <div className="hk">Wound down</div>
          <div className="hv">{F.int(f.delisted.length)}</div>
          <div className="hs">assets frozen and since removed from the pool</div>
        </div>
      </div>
      {f.delisted.length > 0 && (
        <div className="sec-pills" style={{ marginTop: 4 }}>
          {f.delisted.map(r => (
            <Link key={r.asset.assetId} to={paths.asset(r.asset.assetId)} className="pill-badge sec-delisted" title={`Last tradability: ${r.flags.join(' · ')}`}>
              {r.asset.symbol}
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

// 6. risk — where the protocol is actually exposed today, as opposed to what its
// limits would stop. Debt and collateral are reported per market: the markets are
// isolated, so blending their health factors would invent a number neither has.
const RISK_EXPLAINER = 'A position goes under water when its collateral stops covering its debt at the market\'s liquidation threshold, and it lands in exactly one of the two columns. Liquidatable means the collateral is still worth more than the debt, so anyone can repay it, take the collateral and profit — those clear within blocks. Bad debt means the collateral is worth less than the debt, and the amount shown is the shortfall: what no liquidation can recover. It persists because there is nothing left worth seizing, and the market carries it as a loss. A position close to its threshold is not in trouble by itself, so the near-threshold figure leaves out the two configurations that sit there by design: e-mode, where collateral and debt are correlated assets, and isolation mode, where a single capped asset backs an approved stablecoin borrow. Each market is counted on its own, so an isolated market\'s debt never lands in another\'s figures.'

// A risk figure leads with the money and carries its position count behind, because
// the count alone says nothing about the size of what is at stake.
function RiskAmount({ usd, count, tone }: { usd: number | null; count: number | null; tone?: string }) {
  if (usd == null || count == null || !count) return <Dash />
  return (
    <span className="sec-amt">
      <span style={tone ? { color: tone } : undefined}>{F.usd(usd)}</span>
      <span className="sec-amt-n">{F.int(count)}</span>
    </span>
  )
}

function SolvencyTable({ d }: { d: SecurityDashboard }) {
  return (
    <div className="panel">
      <table className="tbl sec-tbl">
        <thead>
          <tr>
            <th>Market</th><th className="r">Borrowers</th><th className="r">Debt</th><th className="r">Collateral</th>
            <th className="r">Within 5% <span className="th-sub">excl. loops</span></th><th className="r">Liquidatable</th><th className="r">Bad debt</th>
          </tr>
        </thead>
        <tbody>
          {d.risk.markets.map(m => (
            <tr key={m.key}>
              <td data-label="Market" style={{ color: 'var(--text-high)' }}>
                {m.label}
                {m.role === 'supplemental' && <span className="pill-badge sec-supplemental">isolated</span>}
              </td>
              <td data-label="Borrowers" className="r mono">{F.int(m.borrowers)}</td>
              <td data-label="Debt" className={`r mono${m.debtUsd > 0 ? '' : ' cell-empty'}`}>{m.debtUsd > 0 ? F.usd(m.debtUsd) : <Dash />}</td>
              <td data-label="Collateral" className={`r mono muted${m.collateralUsd > 0 ? '' : ' cell-empty'}`}>{m.collateralUsd > 0 ? F.usd(m.collateralUsd) : <Dash />}</td>
              <td data-label="Within 5% excl. loops" className={`r mono${m.nearLiquidationCount ? '' : ' cell-empty'}`}
                  title={m.nearLiquidationCount == null
                    ? 'Needs the pool contract to read each position\'s e-mode and isolation flags; chain state is unavailable.'
                    : 'Excludes e-mode and isolation-mode positions, which are run close to their threshold by design.'}>
                <RiskAmount usd={m.nearLiquidationDebtUsd} count={m.nearLiquidationCount} />
              </td>
              {/* Under water and still fully covered: the debt a liquidator can repay
                  in full and profit from, so it is expected to clear on its own. */}
              <td data-label="Liquidatable" className={`r mono${m.liquidatableCount ? '' : ' cell-empty'}`}
                  title={m.liquidatableCount ? 'Under water, but the collateral still covers the debt — closing the position is profitable.' : undefined}>
                <RiskAmount usd={m.liquidatableDebtUsd} count={m.liquidatableCount} />
              </td>
              {/* Disjoint from the column beside it: these positions are short of
                  collateral, and the amount is the shortfall, not the debt. */}
              <td data-label="Bad debt" className={`r mono${m.badDebtCount ? '' : ' cell-empty'}`}
                  title={m.badDebtCount ? 'Collateral no longer covers the debt — the shortfall shown is the part no liquidation can recover.' : undefined}>
                <RiskAmount usd={m.badDebtUsd} count={m.badDebtCount} tone="var(--red)" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MoneyMarketSection({ d, now }: { d: SecurityDashboard; now: number }) {
  const liq = d.risk.liquidations
  const primary = d.risk.markets.find(m => m.role === 'primary')
  return (
    <>
      <SecTitle title="Solvency" subtitle="per market · isolated" />
      <SolvencyTable d={d} />
      <div className="hdx-note" style={{ margin: '12px 0 8px' }}>{RISK_EXPLAINER}</div>
      {primary && primary.underwaterCount > 0 && (
        <div className="hdx-note">
          {F.int(primary.underwaterCount)} positions in the primary market are under water:
          {' '}{F.int(primary.liquidatableCount)} still cover their debt and are waiting for a liquidator,
          {' '}{F.int(primary.badDebtCount)} do not and are short {F.usd(primary.badDebtUsd)} between them —
          {' '}{primary.debtUsd > 0 ? fmtPct((primary.badDebtUsd / primary.debtUsd) * 100) : '—'} of everything borrowed, written off.
        </div>
      )}

      <SecTitle title="Liquidations" subtitle={liq.lastTimestamp ? undefined : 'none on record'} />
      <div className="pf-card">
        <div className="hdx-cards">
          <div className="hdx-card"><div className="hk">Last 24 hours</div><div className="hv">{F.int(liq.day)}</div><div className="hs">positions closed</div></div>
          <div className="hdx-card"><div className="hk">Last 7 days</div><div className="hv">{F.int(liq.week)}</div><div className="hs">positions closed</div></div>
          <div className="hdx-card"><div className="hk">Last 30 days</div><div className="hv">{F.int(liq.month)}</div><div className="hs">positions closed</div></div>
          <div className="hdx-card">
            <div className="hk">All time</div><div className="hv">{F.int(liq.total)}</div>
            <div className="hs">{liq.lastTimestamp ? <>most recent <Ago ts={liq.lastTimestamp} now={now} /></> : 'none yet'}</div>
          </div>
        </div>
      </div>
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>When</th><th>Borrower</th><th>Collateral seized</th><th className="r">Debt repaid</th></tr></thead>
          <tbody>
            {!liq.recent.length ? <EmptyRow cols={4}>No liquidation on record</EmptyRow> : liq.recent.map(r => (
              <tr key={`${r.blockHeight}-${r.borrower.accountId}-${r.collateral.assetId}`}>
                <td data-label="When"><MomentLink at={{ blockHeight: r.blockHeight, extrinsicIndex: r.extrinsicIndex, timestamp: r.blockTimestamp }} now={now} /></td>
                <td data-label="Borrower"><AddrPill account={r.borrower} /></td>
                <td data-label="Collateral seized"><AssetChip asset={r.collateral} /></td>
                <td data-label="Debt repaid" className="r"><AssetChip asset={r.debt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hdx-note" style={{ marginTop: 12 }}>
        The twelve most recent. Every liquidation, with the amounts it moved, is in the{' '}
        <Link className="hash" to={`${paths.activity()}?tab=mm&action=LiquidationCall`}>activity feed</Link>.
      </div>

    </>
  )
}

function LiquidityMovesSection({ d, now }: { d: SecurityDashboard; now: number }) {
  return (
    <>
      <SecTitle title="Largest liquidity moves" subtitle={`${d.risk.windowDays} days · against each asset's own allowance`} />
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>Asset</th><th>Move</th><th className="r">Amount</th><th className="r">Per-block allowance</th><th className="r">Of allowance</th><th className="r">When</th></tr></thead>
          <tbody>
            {!d.risk.largestMoves.length ? <EmptyRow cols={6}>No Omnipool liquidity moved in the window</EmptyRow> : d.risk.largestMoves.map(m => (
              <tr key={`${m.asset.assetId}-${m.kind}-${m.blockHeight}`}>
                <td data-label="Asset"><AssetChip asset={m.asset} /></td>
                <td data-label="Move" className="mono" style={{ color: m.kind === 'add' ? 'var(--sky)' : 'var(--cat-liquidity-remove)' }}>{m.kind === 'add' ? 'added' : 'removed'}</td>
                <td data-label="Amount" className="r"><AssetAmount asset={m.asset} raw={m.amount} link={false} /></td>
                <td data-label="Per-block allowance" className="r">
                  {m.allowance == null ? <span className="muted">not listed</span> : <AssetAmount asset={m.asset} raw={m.allowance} link={false} />}
                </td>
                <td data-label="Of allowance" className="r mono" style={{ color: m.shareOfAllowancePct != null ? loadColor(m.shareOfAllowancePct) : undefined }}>
                  {m.shareOfAllowancePct == null ? <Dash /> : fmtPct(m.shareOfAllowancePct)}
                </td>
                <td data-label="When" className="r"><MomentLink at={{ blockHeight: m.blockHeight, extrinsicIndex: m.extrinsicIndex, timestamp: m.blockTimestamp }} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hdx-note" style={{ marginTop: 12 }}>
        The allowance shown is 5% of the asset&apos;s reserve <em>today</em>, so a share above 100% means the move happened when the pool held less —
        it was inside the limit at the time, or it would have been rejected. Every{' '}
        <Link className="hash" to={`${paths.activity()}?tab=liquidity&min=${LARGE_MOVEMENT_USD}`}>liquidity move</Link>{' '}
        is in the activity feed.
      </div>
    </>
  )
}

// 7. safety ledger
function Ledger({ events, now, compact }: { events: SecuritySafetyEvent[]; now: number; compact?: boolean }) {
  const [shown, setShown] = useState(LEDGER_PAGE)
  const rows = compact ? events : events.slice(0, shown)
  return (
    <>
      {!compact && <SecTitle title="Safety ledger" subtitle={`${events.length} actions on the record`} />}
      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th style={{ width: 28 }}></th><th>Action</th><th>Detail</th><th className="r">When</th></tr></thead>
          <tbody>
            {!rows.length ? <EmptyRow cols={4}>No safety action on record</EmptyRow> : rows.map(e => (
              <tr key={`${e.blockHeight}-${e.kind}-${e.detail}`}>
                <td data-label="" className="sec-dot-cell col-hide-mobile"><Kind kind={e.kind} /></td>
                <td data-label="Action" style={{ color: 'var(--text-high)' }}>{e.label}</td>
                <td data-label="Detail" className="mono muted">{e.detail}</td>
                <td data-label="When" className="r">
                  <MomentLink at={{ blockHeight: e.blockHeight, extrinsicIndex: e.extrinsicIndex, timestamp: e.blockTimestamp }} now={now} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {compact
        ? <div className="sec-more"><Link className="btn" to={paths.security('ledger')}>Open the full ledger</Link></div>
        : shown < events.length && (
          <div className="sec-more">
            <button type="button" className="btn" onClick={() => setShown(s => s + LEDGER_PAGE * 3)}>Show more</button>
          </div>
        )}
    </>
  )
}

// 8. guardians
function GuardianSection({ d, now }: { d: SecurityDashboard; now: number }) {
  const tc = d.guardians.techCommittee
  return (
    <>
      <SecTitle title="Guardians" subtitle="who can pull each lever" />
      <div className="pf-card">
        <div className="sec-meter-head">
          <span className="sec-sub" style={{ margin: 0 }}>Technical committee</span>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {tc.size > 0 ? `${tc.majority} of ${tc.size} to act · ${tc.superMajority} of ${tc.size} for XCM channels` : 'membership unavailable'}
          </span>
        </div>
        {tc.members.length > 0
          ? <div className="sec-pills">{tc.members.map(m => <AddrPill key={m.accountId} account={m} />)}</div>
          : <div className="hdx-note">The committee roster is only recorded in the referendum that set it; none is indexed yet.</div>}
        <div className="hdx-note" style={{ marginTop: 12 }}>
          The committee is the chain&apos;s fast lane: a simple majority takes effect the moment the motion closes, with no referendum and no waiting period. Everything else waits out a track&apos;s decision period.
        </div>
      </div>

      <div className="panel">
        <table className="tbl sec-tbl">
          <thead><tr><th>Control</th><th>Committee</th><th>Other origins</th><th className="r">Speed</th></tr></thead>
          <tbody>
            {CONTROL_ORIGINS.map(c => (
              <tr key={c.control}>
                <td data-label="Control" style={{ color: 'var(--text-high)' }}>{c.control}</td>
                <td data-label="Committee" className="mono">
                  {c.committee == null
                    ? <span className="muted">no</span>
                    : <span style={{ color: 'var(--amber)' }}>{c.committee === 'super' ? tc.superMajority : tc.majority} of {tc.size || '?'}</span>}
                </td>
                <td data-label="Other origins" className="muted">{c.others}</td>
                <td data-label="Speed" className="r mono muted">{c.speed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {d.guardians.outstandingWhitelisted.length > 0 && (
        <>
          <div className="sec-sub">Whitelisted and undispatched · {d.guardians.outstandingWhitelisted.length}</div>
          <div className="panel">
            <table className="tbl sec-tbl">
              <thead><tr><th>Call hash</th><th className="r">Whitelisted</th></tr></thead>
              <tbody>
                {d.guardians.outstandingWhitelisted.map(w => (
                  <tr key={w.callHash}>
                    <td data-label="Call hash" className="mono">{F.shortHash(w.callHash)}</td>
                    <td data-label="Whitelisted" className="r"><Link className="hash" to={paths.block(w.blockHeight)}><Ago ts={w.blockTimestamp} now={now} /></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hdx-note" style={{ marginTop: 10 }}>
            Each of these can still be enacted with root power on the fast whitelisted-caller track, roughly four and a half hours from submission.
          </div>
        </>
      )}
    </>
  )
}

function RuntimeSection({ d, now }: { d: SecurityDashboard; now: number }) {
  return (
    <>
      <SecTitle title="Runtime" subtitle="the code currently executing" />
      <div className="pf-card">
        <div className="hdx-cards">
          <div className="hdx-card">
            <div className="hk">Spec version</div>
            <div className="hv">{d.runtime.specVersion ? F.int(d.runtime.specVersion) : '—'}</div>
            <div className="hs">every safety constant is compiled in at this version</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Last upgrade</div>
            <div className="hv">{d.runtime.lastUpgrade ? <Ago ts={d.runtime.lastUpgrade.blockTimestamp} now={now} /> : '—'}</div>
            <div className="hs">{d.runtime.lastUpgrade ? <Link className="hash" to={paths.block(d.runtime.lastUpgrade.blockHeight)}>block {F.int(d.runtime.lastUpgrade.blockHeight)}</Link> : 'none recorded'}</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Upgrades</div>
            <div className="hv">{F.int(d.runtime.upgrades)}</div>
            <div className="hs">each one a root referendum, 7-day decision plus 12h confirm</div>
          </div>
        </div>
      </div>
    </>
  )
}

// 9. assurance
function AssuranceSection() {
  return (
    <>
      <SecTitle title="Assurance" subtitle="reviews & bug bounty" />
      <div className="sec-split assurance">
        <div className="panel">
          <table className="tbl sec-tbl assurance-tbl">
            <thead><tr><th>Published</th><th>Reviewer</th><th>Scope</th></tr></thead>
            <tbody>
              {AUDITS.map(a => (
                <tr key={`${a.date}-${a.firm}-${a.scope}`}>
                  <td data-label="Published" className="mono muted">{a.date}</td>
                  <td data-label="Reviewer" style={{ color: 'var(--text-high)' }}>{a.firm}</td>
                  <td data-label="Scope" className="muted">{a.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pf-card" style={{ marginBottom: 0 }}>
          <div className="hk">Bug bounty</div>
          <div className="hv" style={{ fontSize: 26, margin: '6px 0 2px' }}>$222,222</div>
          <div className="hs">maximum payout for a critical finding, paid in HDX</div>
          <div className="sec-bounty">
            <div><span>Critical</span><span className="mono">$15k – $222,222</span></div>
            <div><span>High</span><span className="mono">$5k – $10k</span></div>
            <div><span>Medium</span><span className="mono">$2,500</span></div>
            <div><span>Low</span><span className="mono">$1,000</span></div>
          </div>
          <div className="hdx-note" style={{ marginTop: 12 }}>
            Critical findings pay 10% of the funds at risk, capped at the maximum. A proof of concept is required; no identity check.
          </div>
          <div className="sec-links">
            <a href={SECURITY_LINKS.bounty} target="_blank" rel="noreferrer noopener">Report a vulnerability →</a>
            <a href={SECURITY_LINKS.audits} target="_blank" rel="noreferrer noopener">Audit reports →</a>
            <a href={SECURITY_LINKS.docs} target="_blank" rel="noreferrer noopener">Security docs →</a>
          </div>
        </div>
      </div>
    </>
  )
}

function SecuritySkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Withdraw limit" subtitle="chain-wide" /><ChartSkeleton h={210} />
      <SecTitle title="Deposit fuses" /><ChartSkeleton h={180} />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={7} rows={6} /></tbody></table></div>
      <SecTitle title="Per-block limits" /><ChartSkeleton h={140} />
      <div className="panel"><table className="tbl sec-tbl"><tbody><TableSkeleton cols={7} rows={6} /></tbody></table></div>
    </>
  )
}

export function Security({ section }: { section: SecuritySection | null }) {
  const { data, isError } = useSecurityDashboard()
  const now = useNow()
  useDocumentTitle(data
    ? `Security${section ? ` · ${SECTION_LABELS[section]}` : ` · ${data.fuses.lockedCount ? `${data.fuses.lockedCount} locked` : 'nothing tripped'}`}`
    : 'Security')
  const headBlock = data?.chainBlock ?? data?.head.blockHeight ?? 0

  const body = (d: SecurityDashboard) => {
    switch (section) {
      case null: return <Overview d={d} now={now} />
      // Value entering and leaving the chain: the egress budget it is charged
      // against, and the per-asset fuse on the way in.
      case 'cross-chain': return <><WithdrawSection d={d} now={now} /><FuseSection d={d} headBlock={headBlock} now={now} /></>
      // What a block allows in the pool, the largest real moves against those
      // allowances, and every time a limit rejected something.
      case 'omnipool': return <><PerBlockSection d={d} /><LiquidityMovesSection d={d} now={now} /><TripsSection d={d} now={now} /></>
      case 'money-market': return <MoneyMarketSection d={d} now={now} />
      case 'freezes': return <FreezeSection d={d} now={now} />
      case 'ledger': return <Ledger events={d.timeline} now={now} />
      case 'guardians': return <><GuardianSection d={d} now={now} /><RuntimeSection d={d} now={now} /><AssuranceSection /></>
    }
  }

  return (
    <div className="wrap sec-page">
      <div className="page-head">
        <Crumbs items={section
          ? [{ label: 'Home', to: paths.dashboard() }, { label: 'Security', to: paths.security() }, { label: SECTION_LABELS[section] }]
          : [{ label: 'Home', to: paths.dashboard() }, { label: 'Security' }]} />
        <div className="page-title">
          {section ? SECTION_LABELS[section] : 'Security'}
          <span className="sub">{section ? SECTION_BLURB[section] : 'circuit breakers, freezes and the levers that can stop the chain'}</span>
        </div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the security dashboard.</div>
        : !data ? <SecuritySkeleton /> : (
          <>
            {section == null && <Ribbon d={data} now={now} />}
            {section != null && <SectionNav active={section} />}
            {!data.chainAsOf && (
              <div className="pf-card sec-warn">
                Chain state is unavailable, so the live limits and their consumption are not shown. Everything else comes from indexed history and is current.
              </div>
            )}
            {body(data)}
            {data.chainAsOf && (
              <div className="hdx-note sec-asof">
                Limits and consumption read from chain state at block {F.int(headBlock)}, <Ago ts={data.chainAsOf} now={now} />. History indexed through block {F.int(data.head.blockHeight)}.
              </div>
            )}
          </>
        )}
    </div>
  )
}
