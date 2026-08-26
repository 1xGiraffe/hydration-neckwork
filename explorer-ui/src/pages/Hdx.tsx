import type { ReactNode } from 'react'
import { useHdxDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, F, AddrPill, AssetIcon, ChartSkeleton, EmptyRow, compactAmount } from '../components/ui'
import {
  fmtHdx, cohortColor, OWNERSHIP_COLORS, AGE_COLORS,
  ChartLegend, ShareBar, StackedColumnChart, MirroredBarChart, StackedAreaChart, MultiLineChart, GigaLiquidationChart,
} from '../components/HdxCharts'
import { LOCK_ORDER, lockColor } from '../components/lockColors'
import type { ShareSegment, StackColumn, MirrorBar, AreaSeries } from '../components/HdxCharts'
import type { HdxDashboard, HdxStructure, HdxLockType, HdxMover } from '../types'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel, monthLabel as monLabel } from '../utils/dashboardDates'
import { useMediaQuery } from '../hooks/useMediaQuery'

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
  const fmtAmt = compactAmount
  return (
    <>
      <SecTitle title="GIGAHDX Money Market" subtitle="lend & borrow against staked HDX" />
      <div className="pf-card">
        <div className="hdx-cards">
          {rows.map(r => {
            // The GIGAHDX money market's collateral is stHDX (the internal vehicle);
            // users know it 1:1 as GIGAHDX, so surface the branded name and icon
            // (GIGAHDX is asset 67; stHDX/670 has no icon of its own).
            const isStHdx = r.asset.symbol === 'stHDX'
            const sym = isStHdx ? 'GIGAHDX' : r.asset.symbol
            const iconId = isStHdx ? 67 : r.asset.iconAssetId
            return (
            <span key={r.asset.assetId} style={{ display: 'contents' }}>
              {r.supplied > 0 && (
                <div className="hdx-card">
                  <div className="hk"><AssetIcon assetId={r.asset.assetId} iconAssetId={iconId} symbol={sym} size={16} parachainId={r.asset.parachainId} origin={r.asset.origin} /> {sym} supplied</div>
                  <div className="hv">{fmtAmt(r.supplied)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{sym}</span></div>
                  <div className="hs">{r.suppliedUsd != null ? F.usd(r.suppliedUsd) : '—'} · {F.int(r.suppliers)} suppliers</div>
                </div>
              )}
              {r.debt > 0 && (
                <div className="hdx-card">
                  <div className="hk"><AssetIcon assetId={r.asset.assetId} iconAssetId={iconId} symbol={sym} size={16} parachainId={r.asset.parachainId} origin={r.asset.origin} /> {sym} borrowed</div>
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
  // Singular, spelled-out names from the shared label map (parity with the
  // unlock legend and the account balance breakdown); the API label is only a
  // fallback for any unmapped folded type.
  const lockLabel = (t: HdxLockType) => LOCK_LABELS[t.key] ?? t.label
  const segs: ShareSegment[] = types.map(t => ({
    key: t.key, label: lockLabel(t), color: lockColor(t.key), value: t.totalHdx,
    tip: (
      <>
        <span className="t-d">{lockLabel(t)}</span>
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
              <div className="hk"><i style={{ background: lockColor(t.key) }} />{lockLabel(t)}</div>
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
// GIGAHDX unstakes carry a fixed 28-day unbond, so they can only ever land in
// the first four weekly buckets (≤28d) — never later ones. Drop it from those
// tooltips (and the "later" bucket) so we don't imply a lock type that can
// never have a value there.
const GIGA_UNLOCK_WEEKS = 4
const NON_GIGA_KEYS = UNLOCK_KEYS.filter(k => k !== 'gigahdx')
function UnlocksSection({ d }: { d: HdxDashboard }) {
  const { buckets, laterHdx, gigaPending } = d.unlocks
  const weeklyN = Math.min(8, buckets.length)
  // 30-day monthly buckets can straddle month boundaries — blank out a label
  // that would repeat its neighbour ("Dec Dec") instead of showing it twice.
  const monthLabels = buckets.map((b, i) => (i < weeklyN ? mdLabel(b.fromTs) : monLabel(b.fromTs)))
  const keysFor = (i: number) => (i < GIGA_UNLOCK_WEEKS ? UNLOCK_KEYS : NON_GIGA_KEYS)
  const columns: StackColumn[] = buckets.map((b, i) => {
    const keys = keysFor(i)
    return {
      key: `${b.fromTs}-${i}`,
      label: i > 0 && monthLabels[i] === monthLabels[i - 1] ? '' : monthLabels[i],
      segments: keys.map(k => ({ key: k, label: LOCK_LABELS[k], color: lockColor(k), value: b[k] })),
      tip: (
        <>
          <span className="t-d">{mdLabel(b.fromTs)} – {mdLabel(b.toTs)}</span>
          {keys.map(k => <TipRow key={k} color={lockColor(k)} label={LOCK_LABELS[k]} value={fmtHdx(b[k]) + ' HDX'} />)}
          <TipRow label="Total" value={fmtHdx(keys.reduce((s, k) => s + b[k], 0)) + ' HDX'} />
        </>
      ),
    }
  })
  columns.push({
    key: 'later',
    label: 'later',
    segments: NON_GIGA_KEYS.map(k => ({ key: k, label: LOCK_LABELS[k], color: lockColor(k), value: laterHdx[k] })),
    tip: (
      <>
        <span className="t-d">Later{buckets.length ? ` (after ${mdLabel(buckets[buckets.length - 1].toTs)})` : ''}</span>
        {NON_GIGA_KEYS.map(k => <TipRow key={k} color={lockColor(k)} label={LOCK_LABELS[k]} value={fmtHdx(laterHdx[k]) + ' HDX'} />)}
        <TipRow label="Total" value={fmtHdx(NON_GIGA_KEYS.reduce((s, k) => s + laterHdx[k], 0)) + ' HDX'} />
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
          {/* The order counts open the asset page's DCAs tab on the matching
              section — the list these headline figures are summed from. */}
          <div className="mm-stat">
            <span className="k">Scheduled DCA buys</span>
            <span className="v">≈ {fmtHdx(buy.hdxPerDay)}/day</span>
            <span className="s"><Link className="hash" to={`${paths.asset(0)}?tab=dcas&side=buys`} title="The ongoing DCA orders buying HDX">{F.int(buy.orders)} orders</Link></span>
          </div>
          <div className="mm-stat">
            <span className="k">Scheduled DCA sells</span>
            <span className="v">≈ {fmtHdx(sell.hdxPerDay)}/day</span>
            <span className="s"><Link className="hash" to={`${paths.asset(0)}?tab=dcas&side=sells`} title="The ongoing DCA orders selling HDX">{F.int(sell.orders)} orders</Link></span>
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

// ── holder structure history (ownership + loyalty) ──────────────────────────
// Shared helpers for the weekly full-era series. The 1e-9 floor keeps a class
// that never existed in early weeks (e.g. Kraken pre-listing) from drawing a
// zero-thick band edge — StackedAreaChart treats null as absent.
const pct1 = (v: number) => `${v.toFixed(1)}%`
const last = <T,>(a: T[]): T => a[a.length - 1]
// Value ~52 weekly rows back, for "vs 1y ago" deltas (null when too young).
function yearAgo<T>(a: T[]): T | null { return a.length > 52 ? a[a.length - 53] : null }
function deltaPp(now: number, then: number | null): string | null {
  if (then == null) return null
  const d = now - then
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}pp vs 1y ago`
}

const OWNERSHIP_BANDS: { key: keyof HdxStructure['ownership']; label: string }[] = [
  { key: 'treasury', label: 'Treasury' },
  { key: 'protocol', label: 'Protocol & pools' },
  { key: 'kraken', label: 'Kraken' },
  { key: 'top10', label: 'Top 10' },
  { key: 'top11to100', label: 'Top 11–100' },
  { key: 'top101to1000', label: 'Top 101–1k' },
  { key: 'rest', label: 'Smaller holders' },
]

// 6. ownership over time
function OwnershipSection({ s }: { s: HdxStructure }) {
  const o = s.ownership
  const series: AreaSeries[] = OWNERSHIP_BANDS.map(b => ({
    key: b.key, label: b.label, color: OWNERSHIP_COLORS[b.key],
    values: o[b.key].map(v => (v > 0 ? v : null)),
  }))
  const userTotal = s.weeks.map((_, i) => o.top10[i] + o.top11to100[i] + o.top101to1000[i] + o.rest[i])
  const top10Share = s.weeks.map((_, i) => (userTotal[i] > 0 ? o.top10[i] / userTotal[i] * 100 : null))
  const totalNow = s.weeks.map((_, i) => OWNERSHIP_BANDS.reduce((sum, b) => sum + o[b.key][i], 0))
  const effNow = last(s.effectiveHolders)
  const effThen = yearAgo(s.effectiveHolders)
  const t10Now = last(top10Share) ?? 0
  return (
    <>
      <SecTitle title="Who holds HDX" subtitle="weekly since Jul 2022" />
      <div className="pf-card">
        <ChartLegend items={series.map(b => ({ label: b.label, color: b.color }))} />
        <StackedAreaChart buckets={s.weeks} series={series} h={240} />
        <div className="hdx-cards" style={{ marginTop: 14 }}>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: OWNERSHIP_COLORS.top10 }} />Top 10 hold</div>
            <div className="hv">{pct1(t10Now)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>of user-held</span></div>
            <div className="hs">{deltaPp(t10Now, yearAgo(top10Share) ?? null) ?? '—'}</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Effective holders</div>
            <div className="hv">{F.int(effNow)}</div>
            <div className="hs">equal-size equivalent (1/HHI){effThen != null ? ` · ${effNow >= effThen ? '+' : '−'}${F.int(Math.abs(effNow - effThen))} vs 1y ago` : ''}</div>
          </div>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: OWNERSHIP_COLORS.kraken }} />Kraken custody</div>
            <div className="hv">{fmtHdx(last(o.kraken))} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">{pct1(last(o.kraken) / last(totalNow) * 100)} of total supply</div>
          </div>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: OWNERSHIP_COLORS.treasury }} />Treasury</div>
            <div className="hv">{fmtHdx(last(o.treasury))} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">{pct1(last(o.treasury) / last(totalNow) * 100)} of total supply</div>
          </div>
        </div>
        <div className="hdx-note">
          Tranches rank user accounts only — the Treasury, module &amp; pool accounts and Kraken's tagged custody wallets are carved out above.
          Kraken and pool accounts carry today's tags across the whole history.
          {s.backfilledAllocationHdx > 0 && <> Allocations minted later ({fmtHdx(s.backfilledAllocationHdx)} — growth pots, completed vesting) are counted in their band from the start, so realizing them on-chain doesn't read as new supply.</>}
        </div>
      </div>
    </>
  )
}

// ── full-era trend sections (all series data-validated before charting) ─────
const trendSub = (text: string) => (
  <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {text}</span>
)
// "Sep ’25" month label for x-ticks and tooltips on the monthly trend grids.
const monthYearShort = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', ' ’') : d
}
const quarterLabel = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`)
  return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ’${String(t.getUTCFullYear()).slice(2)}`
}
const lastNum = (a: (number | null)[]): number | null => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]
  return null
}

// 6b. supply sinks: staked HDX and the liquid float it leaves
function SupplySinksSection({ s }: { s: HdxStructure }) {
  const t = s.trends
  const staked: AreaSeries[] = [
    { key: 'classic', label: 'Staking', color: 'var(--cat-stake)', values: t.stakedClassic.map(v => (v ? v : null)) },
    { key: 'giga', label: 'GIGAHDX', color: lockColor('gigahdx'), values: t.stakedGiga.map(v => (v ? v : null)), hatch: true },
  ]
  const float: AreaSeries[] = [
    { key: 'float', label: 'Liquid float', color: 'var(--cat-liquidity)', values: t.liquidFloat },
  ]
  const stakedNow = (lastNum(t.stakedClassic) ?? 0) + (lastNum(t.stakedGiga) ?? 0)
  const floatNow = lastNum(t.liquidFloat) ?? 0
  const floatStart = t.liquidFloat.find(v => v != null) ?? 0
  return (
    <>
      <SecTitle title="Supply sinks" subtitle="staked HDX and the liquid float it leaves" />
      <div className="pf-card">
        <div className="sec-title" style={{ marginBottom: 6 }}>Staked HDX{trendSub('classic staking handed off to GIGAHDX in July 2026')}</div>
        <ChartLegend items={staked.map(x => ({ label: x.label, color: x.color }))} />
        <StackedAreaChart buckets={t.months} series={staked} h={190} />
        <div className="sec-title" style={{ margin: '18px 0 6px' }}>Liquid float{trendSub('user-held HDX not locked in staking')}</div>
        <StackedAreaChart buckets={t.months} series={float} h={160} showShare={false} />
        <div className="hdx-cards" style={{ marginTop: 14 }}>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: 'var(--cat-stake)' }} />Staked</div>
            <div className="hv">{fmtHdx(stakedNow)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">{(stakedNow / (stakedNow + floatNow) * 100).toFixed(1)}% of user-held supply</div>
          </div>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: 'var(--cat-liquidity)' }} />Liquid float</div>
            <div className="hv">{fmtHdx(floatNow)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">{floatStart > 0 ? `−${((1 - floatNow / floatStart) * 100).toFixed(0)}% since ${monthYearShort(t.months[0])}` : '—'}</div>
          </div>
        </div>
        <div className="hdx-note">Staked HDX stays in its owner's wallet under a lock, so both series live inside user-held supply.
          The float still carries vote and vesting locks — this is the unstaked share, not free-to-sell supply.</div>
      </div>
    </>
  )
}

// 6c. cost basis & accumulation
function CostBasisSection({ s }: { s: HdxStructure }) {
  const t = s.trends
  // "Treasury bought back" wraps the card badge at 390px — shorten on phones.
  const narrow = useMediaQuery('(max-width: 720px)')
  const priceLines: AreaSeries[] = [
    { key: 'market', label: 'Market price', color: 'var(--accent)', values: t.marketPrice },
    { key: 'realized', label: 'Cost basis', color: 'var(--neutral-cool)', values: t.realizedPrice },
  ]
  const px = lastNum(t.marketPrice), rp = lastNum(t.realizedPrice)
  const mvrv = px != null && rp != null && rp > 0 ? px / rp : null
  const buyback: AreaSeries[] = [
    { key: 'buyback', label: 'Bought back', color: 'var(--green)', values: t.buybackHdx },
  ]
  const whaleLine: AreaSeries[] = [
    { key: 'top100', label: 'Top-100 share', color: cohortColor('whale'), values: t.top100Share },
  ]
  const kraken: AreaSeries[] = [
    { key: 'kraken', label: 'Kraken custody', color: OWNERSHIP_COLORS.kraken, values: t.krakenHdx.map(v => (v ? v : null)) },
  ]
  const buybackNow = lastNum(t.buybackHdx) ?? 0
  const krakenNow = lastNum(t.krakenHdx) ?? 0
  const krakenPeak = Math.max(...t.krakenHdx.map(v => v ?? 0))
  return (
    <>
      <SecTitle title="Cost basis & accumulation" subtitle="what holders paid, and who is soaking up supply" />
      <div className="pf-card">
        <div className="sec-title" style={{ marginBottom: 6 }}>Price vs cost basis{trendSub('the aggregate price user-held HDX was acquired at')}</div>
        <ChartLegend items={priceLines.map(x => ({ label: x.label, color: x.color }))} />
        <MultiLineChart buckets={t.months} series={priceLines} h={190} yFmt={v => `$${v.toFixed(4)}`} floorZero />
        <div className="hdx-cards" style={{ marginTop: 14 }}>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: 'var(--accent)' }} />Price / cost basis</div>
            <div className="hv">{mvrv != null ? mvrv.toFixed(2) : '—'}</div>
            <div className="hs">{mvrv != null ? (mvrv >= 1 ? `holders are ${((mvrv - 1) * 100).toFixed(0)}% in profit in aggregate` : `holders are ${((1 - mvrv) * 100).toFixed(0)}% underwater in aggregate`) : ''}</div>
          </div>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: 'var(--green)' }} />{narrow ? 'Treasury BB' : 'Treasury bought back'}</div>
            <div className="hv">{fmtHdx(buybackNow)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">revenue recycled into HDX since Oct 2024</div>
          </div>
          <div className="hdx-card">
            <div className="hk"><i style={{ background: OWNERSHIP_COLORS.kraken }} />Kraken custody</div>
            <div className="hv">{fmtHdx(krakenNow)} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>HDX</span></div>
            <div className="hs">−{krakenPeak > 0 ? ((1 - krakenNow / krakenPeak) * 100).toFixed(0) : 0}% from its {fmtHdx(krakenPeak)} peak</div>
          </div>
        </div>
        <div className="sec-title" style={{ margin: '18px 0 6px' }}>Treasury buyback{trendSub('cumulative HDX the protocol bought with its own revenue')}</div>
        <StackedAreaChart buckets={t.months} series={buyback} h={160} showShare={false} />
        <div className="sec-title" style={{ margin: '18px 0 6px' }}>Top-100 share of user supply{trendSub('whales have re-accumulated since the 2025 trough')}</div>
        <MultiLineChart buckets={t.months} series={whaleLine} h={160} yFmt={v => `${v.toFixed(1)}%`} />
        <div className="sec-title" style={{ margin: '18px 0 6px' }}>Kraken custody{trendSub('HDX on the tagged exchange wallets — halved from the 2024 peak')}</div>
        <StackedAreaChart buckets={t.months} series={kraken} h={160} showShare={false} />
        <div className="hdx-note">Cost basis is account-level: balance increases are booked at that week's close (pre-price-era holdings at the
          first known close), decreases release cost proportionally — wallet moves therefore re-book at current prices.
          Kraken custody counts the tagged hot wallets on Hydration, not the exchange's global books.</div>
      </div>
    </>
  )
}

// 6d. participation
function ParticipationSection({ s }: { s: HdxStructure }) {
  const t = s.trends
  const govCols: StackColumn[] = t.gov.quarters.map((q, i) => ({
    key: q,
    label: i % 2 === 0 ? quarterLabel(q) : '',
    segments: [{ key: 'gov', label: 'Capital voting', color: 'var(--cat-vote)', value: t.gov.capital[i] }],
    tip: (
      <>
        <span className="t-d">{quarterLabel(q)}</span>
        <TipRow color="var(--cat-vote)" label="Capital voting" value={fmtHdx(t.gov.capital[i]) + ' HDX'} />
        <TipRow label="Voters" value={F.int(t.gov.voters[i])} />
      </>
    ),
  }))
  const traderStep = Math.max(1, Math.floor(t.months.length / 7))
  const traderCols: StackColumn[] = t.months.map((m, i) => ({
    key: m,
    label: i % traderStep === 0 && i < t.months.length - 2 ? monthYearShort(m) : '',
    segments: [{ key: 'traders', label: 'Traders', color: 'var(--neutral-cool)', value: t.traders[i] ?? 0 }],
    tip: (
      <>
        <span className="t-d">{monthYearShort(m)}</span>
        <TipRow color="var(--neutral-cool)" label="Unique traders" value={F.int(t.traders[i] ?? 0)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Participation" subtitle="who shows up — capital in governance, wallets on the market" />
      <div className="pf-card">
        <div className="sec-title" style={{ marginBottom: 6 }}>Capital in governance{trendSub('each voter counted once per quarter at their largest vote')}</div>
        <StackedColumnChart columns={govCols} h={180} />
        <div className="sec-title" style={{ margin: '18px 0 6px' }}>Monthly active traders{trendSub('unique wallets trading HDX — activity has concentrated into fewer, larger hands')}</div>
        <StackedColumnChart columns={traderCols} h={160} yFmt={v => F.int(Math.round(v))} />
        <div className="hdx-note">Trader counts exclude module accounts. Governance capital spans Democracy and OpenGov;
          the same capital voting on many referenda in a quarter is counted once, at its largest single vote.</div>
      </div>
    </>
  )
}

// 7. holder loyalty (HODL waves)
const AGE_BANDS: { key: keyof HdxStructure['hodl']; label: string }[] = [
  { key: 'over2y', label: 'Held 2y+' },
  { key: 'y1to2', label: '1–2y' },
  { key: 'm3to12', label: '3–12m' },
  { key: 'under3m', label: 'Under 3m' },
]
function LoyaltySection({ s }: { s: HdxStructure }) {
  const series: AreaSeries[] = AGE_BANDS.map(b => ({
    key: b.key, label: b.label, color: AGE_COLORS[b.key],
    values: s.hodl[b.key].map(v => (v > 0 ? v : null)),
  }))
  return (
    <>
      <SecTitle title="Holder loyalty" subtitle="how long user-held HDX has been held" />
      <div className="pf-card">
        <ChartLegend items={series.map(b => ({ label: b.label, color: b.color }))} />
        <StackedAreaChart buckets={s.weeks} series={series} h={220} />
        <div className="hdx-note">Age counts from an account's first nonzero HDX balance — an account that exits and returns keeps its
          original age, and a wallet that empties into a single fresh wallet passes its age on, so moving between own wallets counts as continuous holding.</div>
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
      <SecTitle title="Who holds HDX" subtitle="weekly since Jul 2022" /><ChartSkeleton h={480} />
      <SecTitle title="Supply sinks" subtitle="staked HDX and the liquid float it leaves" /><ChartSkeleton h={430} />
      <SecTitle title="Locks" /><ChartSkeleton h={230} />
      <SecTitle title="Upcoming unlocks" /><ChartSkeleton h={280} />
      <SecTitle title="Buys vs sells" subtitle="60 days" /><ChartSkeleton h={250} />
      <SecTitle title="New vs exited holders" subtitle="weekly" /><ChartSkeleton h={210} />
      <SecTitle title="Holder loyalty" subtitle="how long user-held HDX has been held" /><ChartSkeleton h={280} />
      <SecTitle title="Cost basis & accumulation" subtitle="what holders paid, and who is soaking up supply" /><ChartSkeleton h={640} />
      <SecTitle title="Participation" subtitle="who shows up — capital in governance, wallets on the market" /><ChartSkeleton h={400} />
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
            <OwnershipSection s={data.structure} />
            <SupplySinksSection s={data.structure} />
            <LocksSection d={data} />
            <UnlocksSection d={data} />
            <GigaMarketSection d={data} />
            <FlowsSection d={data} />
            <ChurnSection d={data} />
            <LoyaltySection s={data.structure} />
            <CostBasisSection s={data.structure} />
            <ParticipationSection s={data.structure} />
            <MoversSection d={data} />
          </>
        )}
    </div>
  )
}
