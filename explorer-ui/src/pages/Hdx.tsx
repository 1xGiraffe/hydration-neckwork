import type { ReactNode } from 'react'
import { useHdxDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { Crumbs, F, AddrPill, AssetIcon, ChartSkeleton, EmptyRow } from '../components/ui'
import {
  fmtHdx, lockColor, cohortColor, LOCK_ORDER,
  ChartLegend, ShareBar, StackedColumnChart, MirroredBarChart, GigaLiquidationChart,
} from '../components/HdxCharts'
import type { ShareSegment, StackColumn, MirrorBar } from '../components/HdxCharts'
import type { HdxDashboard, HdxLockType, HdxMover } from '../types'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel, monthLabel as monLabel } from '../utils/dashboardDates'

const UNLOCK_KEYS = ['gigahdx', 'vesting', 'vote'] as const
const LOCK_LABELS: Record<string, string> = { vote: 'Vote', staking: 'Staking', gigahdx: 'GIGAHDX', vesting: 'Vesting', other: 'Other' }
// Sum of the first 4 weekly unlock buckets across all lock types (≤28 days out).
function near28d(d: HdxDashboard): number {
  return d.unlocks.buckets.slice(0, 4).reduce((s, b) => s + b.gigahdx + b.vesting + b.vote, 0)
}

// 1. stat ribbon
function Ribbon({ d }: { d: HdxDashboard }) {
  const giga = d.locks.types.find(t => t.key === 'gigahdx')
  const chg = d.change24h
  const cells: { k: string; v: ReactNode; s?: string }[] = [
    {
      k: 'Price',
      v: <>{F.priceUsd(d.price)}{chg != null && <span style={{ color: chg >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 12, marginLeft: 6 }}>{F.pct(chg)}</span>}</>,
    },
    { k: 'Holders', v: F.int(d.supply.holders) },
    { k: 'User-held supply', v: fmtHdx(d.supply.userHdx), s: `of ${fmtHdx(d.supply.totalHdx)} total` },
    { k: 'Locked', v: fmtHdx(d.locks.totalLockedHdx), s: `${d.locks.lockedPctOfUser.toFixed(1)}% of user-held` },
    { k: 'GIGAHDX locked', v: giga ? fmtHdx(giga.totalHdx) : '—' },
    { k: 'Unlocking ≤28d', v: fmtHdx(near28d(d)) },
  ]
  return (
    <div className="ribbon standalone">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <span className="cell"><span className="k">{c.k}</span><span className="v">{c.v}</span>{c.s && <span className="s">{c.s}</span>}</span>
        </span>
      ))}
    </div>
  )
}

// GIGAHDX money market
// Per-reserve totals of the GIGAHDX market: stHDX collateral (staked HDX,
// valued at the HDX price) and the HOLLAR borrowed against it.
function GigaMarketSection({ d }: { d: HdxDashboard }) {
  const rows = d.gigaMarket
  if (!rows?.length) return null
  const fmtAmt = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0)
  return (
    <>
      <SecTitle title="GIGAHDX Money Market" subtitle="supply & borrow against staked HDX" />
      <div className="pf-card">
        <div className="hdx-cards">
          {rows.map(r => {
            // The GIGAHDX money market's collateral is stHDX (the internal vehicle);
            // users know it 1:1 as GIGAHDX, so surface the branded name (icon included).
            const sym = r.asset.symbol === 'stHDX' ? 'GIGAHDX' : r.asset.symbol
            return (
            <span key={r.asset.assetId} style={{ display: 'contents' }}>
              {r.supplied > 0 && (
                <div className="hdx-card">
                  <div className="hk"><AssetIcon assetId={r.asset.assetId} iconAssetId={r.asset.iconAssetId} symbol={sym} size={16} parachainId={r.asset.parachainId} origin={r.asset.origin} /> {sym} supplied</div>
                  <div className="hv">{fmtAmt(r.supplied)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{sym}</span></div>
                  <div className="hs">{r.suppliedUsd != null ? F.usd(r.suppliedUsd) : '—'} · {F.int(r.suppliers)} suppliers</div>
                </div>
              )}
              {r.debt > 0 && (
                <div className="hdx-card">
                  <div className="hk"><AssetIcon assetId={r.asset.assetId} iconAssetId={r.asset.iconAssetId} symbol={sym} size={16} parachainId={r.asset.parachainId} origin={r.asset.origin} /> {sym} borrowed</div>
                  <div className="hv">{fmtAmt(r.debt)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{sym}</span></div>
                  <div className="hs">{r.debtUsd != null ? F.usd(r.debtUsd) : '—'} · {F.int(r.borrowers)} borrowers</div>
                </div>
              )}
            </span>
            )
          })}
        </div>
        {d.gigaLiquidations && (
          <div style={{ marginTop: 18 }}>
            <div className="sec-title" style={{ marginBottom: 6 }}>Liquidation levels <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>
              · {fmtHdx(d.gigaLiquidations.points.reduce((a, p) => a + p.stHdx, 0))} GIGAHDX at risk across {d.gigaLiquidations.points.length} borrowers — how much becomes liquidatable as the HDX price falls
            </span></div>
            <GigaLiquidationChart currentPrice={d.gigaLiquidations.currentPrice} points={d.gigaLiquidations.points} />
          </div>
        )}
      </div>
    </>
  )
}

// 2. holder distribution
function HolderSection({ d }: { d: HdxDashboard }) {
  const user = d.supply.userHdx || 1
  const segs: ShareSegment[] = d.cohorts.map(c => ({
    key: c.key, label: c.label, color: cohortColor(c.key), value: c.totalHdx,
    tip: (
      <>
        <span className="t-d">{c.label}</span>
        <TipRow label="Accounts" value={F.int(c.accounts)} />
        <TipRow label="HDX" value={fmtHdx(c.totalHdx)} />
        <TipRow label="Of user supply" value={(c.totalHdx / user * 100).toFixed(1) + '%'} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Holder distribution" />
      <div className="pf-card">
        <ChartLegend items={segs.map(s => ({ label: s.label, color: s.color }))} />
        <ShareBar segments={segs} />
        <div className="hdx-cards">
          {d.cohorts.map((c, i) => (
            <div className="hdx-card" key={c.key}>
              <div className="hk">
                <i style={{ background: cohortColor(c.key) }} />{c.label}
                <span className="cohort-threshold" title={c.minPct > 0 ? `> ${fmtHdx(c.minHdx)} HDX at current supply` : i > 0 ? `≤ ${fmtHdx(d.cohorts[i - 1].minHdx)} HDX at current supply` : undefined}>
                  {c.minPct > 0 ? `> ${c.minPct}% of supply` : i > 0 ? `≤ ${d.cohorts[i - 1].minPct}%` : ''}
                </span>
              </div>
              <div className="hv">{fmtHdx(c.totalHdx)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
              <div className="hs">{F.int(c.accounts)} accounts · {(c.totalHdx / user * 100).toFixed(1)}% share</div>
            </div>
          ))}
        </div>
        <div className="hdx-note">Protocol accounts (treasury, omnipool, staking pot) hold {fmtHdx(d.supply.protocolHdx)} — excluded from cohorts.</div>
      </div>
    </>
  )
}

// 3. locks
function orderedLockTypes(types: HdxLockType[]): HdxLockType[] {
  const idx = (k: string) => { const i = (LOCK_ORDER as readonly string[]).indexOf(k); return i === -1 ? LOCK_ORDER.length : i }
  return [...types].sort((a, b) => idx(a.key) - idx(b.key))
}
function LocksSection({ d }: { d: HdxDashboard }) {
  const types = orderedLockTypes(d.locks.types)
  const sum = types.reduce((s, t) => s + t.totalHdx, 0) || 1
  const segs: ShareSegment[] = types.map(t => ({
    key: t.key, label: t.label, color: lockColor(t.key), value: t.totalHdx,
    tip: (
      <>
        <span className="t-d">{t.label}</span>
        <TipRow label="Accounts" value={F.int(t.accounts)} />
        <TipRow label="HDX" value={fmtHdx(t.totalHdx)} />
        <TipRow label="Of locked" value={(t.totalHdx / sum * 100).toFixed(1) + '%'} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Locks" />
      <div className="pf-card">
        <ChartLegend items={segs.map(s => ({ label: s.label, color: s.color }))} />
        <ShareBar segments={segs} />
        <div className="hdx-cards">
          {types.map(t => (
            <div className="hdx-card" key={t.key}>
              <div className="hk"><i style={{ background: lockColor(t.key) }} />{t.label}</div>
              <div className="hv">{fmtHdx(t.totalHdx)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
              <div className="hs">{F.int(t.accounts)} accounts</div>
            </div>
          ))}
        </div>
        <div className="hdx-note">
          Locks overlap on the same balance — net locked is {fmtHdx(d.locks.totalLockedHdx)} ({d.locks.lockedPctOfUser.toFixed(1)}% of user-held HDX).
          {d.locks.vestedUnclaimedHdx > 0 && <> Vesting counts only HDX still on schedule — another {fmtHdx(d.locks.vestedUnclaimedHdx)} is vested but unclaimed and not counted.</>}
        </div>
      </div>
    </>
  )
}

// 4. unlock timeline
function UnlocksSection({ d }: { d: HdxDashboard }) {
  const { buckets, laterHdx, gigaPending } = d.unlocks
  const weeklyN = Math.min(8, buckets.length)
  // 30-day monthly buckets can straddle month boundaries — blank out a label
  // that would repeat its neighbour ("Dec Dec") instead of showing it twice.
  const monthLabels = buckets.map((b, i) => (i < weeklyN ? mdLabel(b.fromTs) : monLabel(b.fromTs)))
  const columns: StackColumn[] = buckets.map((b, i) => ({
    key: `${b.fromTs}-${i}`,
    label: i > 0 && monthLabels[i] === monthLabels[i - 1] ? '' : monthLabels[i],
    segments: UNLOCK_KEYS.map(k => ({ key: k, label: LOCK_LABELS[k], color: lockColor(k), value: b[k] })),
    tip: (
      <>
        <span className="t-d">{mdLabel(b.fromTs)} – {mdLabel(b.toTs)}</span>
        {UNLOCK_KEYS.map(k => <TipRow key={k} color={lockColor(k)} label={LOCK_LABELS[k]} value={fmtHdx(b[k]) + ' HDX'} />)}
        <TipRow label="Total" value={fmtHdx(b.gigahdx + b.vesting + b.vote) + ' HDX'} />
      </>
    ),
  }))
  columns.push({
    key: 'later',
    label: 'later',
    segments: UNLOCK_KEYS.map(k => ({ key: k, label: LOCK_LABELS[k], color: lockColor(k), value: laterHdx[k] })),
    tip: (
      <>
        <span className="t-d">Later{buckets.length ? ` (after ${mdLabel(buckets[buckets.length - 1].toTs)})` : ''}</span>
        {UNLOCK_KEYS.map(k => <TipRow key={k} color={lockColor(k)} label={LOCK_LABELS[k]} value={fmtHdx(laterHdx[k]) + ' HDX'} />)}
        <TipRow label="Total" value={fmtHdx(laterHdx.gigahdx + laterHdx.vesting + laterHdx.vote) + ' HDX'} />
      </>
    ),
  })
  return (
    <>
      <SecTitle title="Upcoming unlocks" />
      <div className="pf-card">
        <ChartLegend items={UNLOCK_KEYS.map(k => ({ label: LOCK_LABELS[k], color: lockColor(k) }))} />
        <StackedColumnChart columns={columns} h={200} separatorAt={weeklyN} separatorCaption="weekly → monthly" />
        {gigaPending.count > 0 && (
          <div className="hdx-note">
            GIGAHDX: {F.int(gigaPending.count)} pending unstakes · {fmtHdx(gigaPending.totalHdx)} HDX{gigaPending.nextUnlockTs ? ` · next ${mdLabel(gigaPending.nextUnlockTs)}` : ''}
          </div>
        )}
      </div>
    </>
  )
}

// 5. trading flow
function FlowsSection({ d }: { d: HdxDashboard }) {
  const daily = d.flows.daily
  const bars: MirrorBar[] = daily.map(f => ({
    key: f.date, up: f.buyHdx, down: f.sellHdx,
    tip: (
      <>
        <span className="t-d">{mdLabel(f.date)}</span>
        <TipRow color="var(--green)" label="Bought" value={fmtHdx(f.buyHdx) + ' HDX'} />
        <TipRow color="var(--red)" label="Sold" value={fmtHdx(f.sellHdx) + ' HDX'} />
        <TipRow label="Buyers / sellers" value={`${F.int(f.buyers)} / ${F.int(f.sellers)}`} />
      </>
    ),
  }))
  const ticks = daily.map((f, i) => ({ i, label: mdLabel(f.date) })).filter(t => t.i % 10 === 0)
  const avgBuy = daily.length ? daily.reduce((s, f) => s + f.buyHdx, 0) / daily.length : 0
  const avgSell = daily.length ? daily.reduce((s, f) => s + f.sellHdx, 0) / daily.length : 0
  const { buy, sell } = d.flows.dca
  return (
    <>
      <SecTitle title="Buys vs sells" subtitle="60 days" />
      <div className="hdx-flow-grid">
        <div className="pf-card" style={{ marginBottom: 0 }}>
          <ChartLegend items={[{ label: 'Buys', color: 'var(--green)' }, { label: 'Sells', color: 'var(--red)' }]} />
          <MirroredBarChart data={bars} h={190} xTicks={ticks} />
          <div className="bal-xaxis" style={{ justifyContent: 'center' }}><span>avg buys {fmtHdx(avgBuy)}/day · avg sells {fmtHdx(avgSell)}/day</span></div>
        </div>
        <div className="pf-card hdx-dca" style={{ marginBottom: 0 }}>
          <div className="mm-stat">
            <span className="k">Scheduled DCA buys</span>
            <span className="v">≈ {fmtHdx(buy.hdxPerDay)}/day</span>
            <span className="s">{F.int(buy.orders)} orders</span>
          </div>
          <div className="mm-stat">
            <span className="k">Scheduled DCA sells</span>
            <span className="v">≈ {fmtHdx(sell.hdxPerDay)}/day</span>
            <span className="s">{F.int(sell.orders)} orders</span>
          </div>
          <div className="mm-stat">
            <span className="k">Potential unlock overhang (28d)</span>
            <span className="v">{fmtHdx(near28d(d))}</span>
            <span className="s">weekly unlock buckets 1–4, all lock types</span>
          </div>
        </div>
      </div>
    </>
  )
}

// 6. holder churn
function ChurnSection({ d }: { d: HdxDashboard }) {
  const weeks = d.churn.weekly
  const bars: MirrorBar[] = weeks.map(w => ({
    key: w.weekStart, up: w.newHolders, down: w.exitedHolders,
    tip: (
      <>
        <span className="t-d">Week of {mdLabel(w.weekStart)}</span>
        <TipRow color="var(--green)" label="New holders" value={F.int(w.newHolders)} />
        <TipRow color="var(--red)" label="Exited holders" value={F.int(w.exitedHolders)} />
      </>
    ),
  }))
  const ticks = weeks.map((w, i) => ({ i, label: mdLabel(w.weekStart) })).filter(t => t.i % 2 === 0)
  return (
    <>
      <SecTitle title="New vs exited holders" subtitle="weekly" />
      <div className="pf-card">
        <ChartLegend items={[{ label: 'New', color: 'var(--green)' }, { label: 'Exited', color: 'var(--red)' }]} />
        <MirroredBarChart data={bars} h={160} xTicks={ticks} />
      </div>
    </>
  )
}

// 7. top movers
function MoversPanel({ title, rows }: { title: string; rows: HdxMover[] }) {
  return (
    <div className="panel">
      <div className="panel-head"><span className="t">{title}</span></div>
      <table className="tbl">
        <thead><tr><th>Account</th><th className="r">Balance</th><th className="r">Bought</th><th className="r">Sold</th><th className="r">Net</th></tr></thead>
        <tbody>
          {!rows.length ? <EmptyRow cols={5}>No movers</EmptyRow> : rows.map(m => (
            <tr key={m.account.accountId}>
              <td data-label="Account"><AddrPill account={m.account} noCopy /></td>
              <td data-label="Balance" className="r mono muted">{fmtHdx(m.balanceHdx)}</td>
              <td data-label="Bought" className="r mono">{fmtHdx(m.boughtHdx)}</td>
              <td data-label="Sold" className="r mono">{fmtHdx(m.soldHdx)}</td>
              <td data-label="Net" className="r mono" style={{ color: m.netHdx >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {(m.netHdx >= 0 ? '+' : '−') + fmtHdx(Math.abs(m.netHdx))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
function MoversSection({ d }: { d: HdxDashboard }) {
  return (
    <>
      <SecTitle title="Top movers" subtitle="7 days" />
      <div className="cols hdx-movers">
        <MoversPanel title="Accumulators" rows={d.topMovers.accumulators} />
        <MoversPanel title="Distributors" rows={d.topMovers.distributors} />
      </div>
    </>
  )
}

// loading skeleton (per section)
function HdxSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Holder distribution" /><ChartSkeleton h={230} />
      <SecTitle title="Locks" /><ChartSkeleton h={230} />
      <SecTitle title="Upcoming unlocks" /><ChartSkeleton h={280} />
      <SecTitle title="Buys vs sells" subtitle="60 days" /><ChartSkeleton h={250} />
      <SecTitle title="New vs exited holders" subtitle="weekly" /><ChartSkeleton h={210} />
      <SecTitle title="Top movers" subtitle="7 days" /><ChartSkeleton h={240} />
    </>
  )
}

export function Hdx() {
  const { data, isError } = useHdxDashboard()
  useDocumentTitle(data && data.price != null ? `HDX ${F.priceUsd(data.price)}` : 'HDX')
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'HDX' }]} />
        <div className="page-title">HDX <span className="sub">native token · supply, locks, unlocks & flow</span></div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the HDX dashboard.</div>
        : !data ? <HdxSkeleton /> : (
          <>
            <Ribbon d={data} />
            <HolderSection d={data} />
            <LocksSection d={data} />
            <UnlocksSection d={data} />
            <GigaMarketSection d={data} />
            <FlowsSection d={data} />
            <ChurnSection d={data} />
            <MoversSection d={data} />
          </>
        )}
    </div>
  )
}
