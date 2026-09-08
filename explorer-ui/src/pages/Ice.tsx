import type { ReactNode } from 'react'
import { useIceDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { paths } from '../router'
import { AssetAmount, AssetChip, ChartSkeleton, Crumbs, EmptyRow, F, TableSkeleton } from '../components/ui'
import { useAssetColors } from '../utils/iconColor'
import { ChartLegend, MultiLineChart, ShareBar, StackedColumnChart } from '../components/HdxCharts'
import type { AreaSeries, ShareSegment, StackColumn } from '../components/HdxCharts'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'
import { fmtDuration, fmtPermill } from '../utils/dca'
import { REVENUE_STREAM_COLOR } from '../components/revenueColors'
import type { IceDashboard } from '../types'

// ICE is the intent solver runtime 443 added: a swap intent is the product's
// "limit order", a DCA intent the new DCA, and an off-chain solver settles both
// inside unsigned ICE.submit_solution extrinsics — matching intents against each
// other where it can and routing the rest through the AMMs as the pot. The
// dashboard reads the venue: its governance status, what it holds, what it
// settled, how well, the fee it earns, and the migration feeding it.

// Runtime 443's first block — where the venue starts existing.
const ICE_LAUNCH_BLOCK = 14362830
const WINDOW_LABEL = '30 days'
const MATCHED_COLOR = 'var(--cat-intent)'
const ROUTED_COLOR = 'var(--sky-deep)'
const MIGRATED_COLOR = 'var(--green)'
const CANCELLED_COLOR = 'var(--amber)'
const FEE_COLOR = REVENUE_STREAM_COLOR.ice_matched_fee
const MODE_TONE: Record<IceDashboard['status']['solverMode'], string> = {
  V4: 'var(--green)', Passthrough: 'var(--amber)', Disabled: 'var(--red)',
}

// Signed basis points to a tenth, the way the API computes them.
function fmtBp(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)
  return (v > 0 ? '+' : '') + s + ' bp'
}
function Switch({ on }: { on: boolean }) {
  return <span style={{ color: on ? 'var(--green)' : 'var(--text-low)' }}>{on ? 'on' : 'off'}</span>
}
function Card({ k, v, s, dot }: { k: string; v: ReactNode; s?: ReactNode; dot?: string }) {
  return (
    <div className="hdx-card">
      <div className="hk">{dot && <i style={{ background: dot }} />}{k}</div>
      <div className="hv">{v}</div>
      {s && <div className="hs">{s}</div>}
    </div>
  )
}
// Every column carries a label slot; only every n-th prints so 30 days stay legible.
function dayLabel(days: string[], i: number): string {
  const every = Math.max(1, Math.ceil(days.length / 10))
  return i % every === 0 ? mdLabel(days[i]) : ''
}

// Nothing has happened on the venue yet: no order, no fill, no fee, no migration.
function isLaunchState(d: IceDashboard): boolean {
  return d.openOrders.total === 0
    && !d.fillsPerDay.some(x => x.fills > 0 || x.solutions > 0)
    && !d.feeRevenue.perDay.some(x => x.usd > 0)
    && d.feeRevenue.potHoldings.length === 0
    && d.migration.migrated + d.migration.cancelled === 0
    && d.topPairs.length === 0
}

// 1. status strip — governance settings, latest event wins
function Ribbon({ d }: { d: IceDashboard }) {
  const s = d.status
  const cells: { k: string; v: ReactNode }[] = [
    { k: 'Solver mode', v: <span style={{ color: MODE_TONE[s.solverMode] }}>{s.solverMode}</span> },
    { k: 'Protocol fee', v: <>{fmtPermill(s.protocolFeePpm)}<span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>of matched volume</span></> },
    { k: 'DCA migration', v: <Switch on={s.dcaMigrationEnabled} /> },
    {
      k: 'Uniswap v3',
      v: s.uniswapV3
        ? <span className="mono" title={`factory ${s.uniswapV3.factory} · router ${s.uniswapV3.swapRouter} · quoter ${s.uniswapV3.quoter}`}>{F.shortHash(s.uniswapV3.factory)}</span>
        : <span className="muted">not set</span>,
    },
    {
      k: 'As of',
      v: s.asOfBlock > ICE_LAUNCH_BLOCK
        ? <span className="mono">block {F.int(s.asOfBlock)}</span>
        : <span className="muted">runtime 443 defaults</span>,
    },
  ]
  return (
    <div className="ribbon standalone">
      {cells.map((c, i) => (
        <span key={c.k} style={{ display: 'contents' }}>
          {i > 0 && <span className="rs" />}
          <span className="cell"><span className="k">{c.k}</span><span className="v">{c.v}</span></span>
        </span>
      ))}
    </div>
  )
}

// 2. open orders — what the venue holds, by the asset it holds
function OpenOrdersSection({ d }: { d: IceDashboard }) {
  const o = d.openOrders
  const colorFor = useAssetColors(o.byAsset.map(r => r.asset))
  const reservedUsd = o.byAsset.reduce((sum, r) => sum + (r.reservedUsd ?? 0), 0)
  const segs: ShareSegment[] = o.byAsset.map(r => ({
    key: String(r.asset.assetId), label: r.asset.symbol, color: colorFor(r.asset), value: r.reservedUsd ?? 0,
    tip: (
      <>
        <span className="t-d">{r.asset.symbol}</span>
        <TipRow label="Reserved" value={`${F.amount(r.reserved, r.asset.decimals)} ${r.asset.symbol}`} />
        <TipRow label="Value" value={F.usd(r.reservedUsd)} />
        <TipRow label="Orders" value={F.int(r.orders)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Open orders" subtitle="intents without a terminal event, and what they still hold" />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0, marginBottom: o.byAsset.length ? 14 : 0 }}>
          <Card k="Open" v={F.int(o.total)} s="limit orders and DCA intents" />
          <Card k="Limit orders" v={F.int(o.limit)} s="swap intents waiting for a match" />
          <Card k="DCA intents" v={F.int(o.dca)} s="budgeted or rolling" />
          <Card k="Reserved" v={F.usd(reservedUsd)} s="held for open orders, at current prices" />
        </div>
        {o.byAsset.length ? (
          <>
            <ChartLegend items={segs.map(s => ({ label: s.label, color: s.color }))} />
            <ShareBar segments={segs} h={26} />
            <div className="panel" style={{ marginTop: 12 }}>
              <table className="tbl">
                <thead><tr><th>Asset</th><th className="r">Orders</th><th className="r">Reserved</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {o.byAsset.map(r => (
                    <tr key={r.asset.assetId}>
                      <td data-label="Asset"><AssetChip asset={r.asset} /></td>
                      <td data-label="Orders" className="r mono">{F.int(r.orders)}</td>
                      <td data-label="Reserved" className="r mono"><AssetAmount asset={r.asset} raw={r.reserved} /></td>
                      <td data-label="Value" className="r mono muted">{F.usd(r.reservedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : <div className="hdx-note" style={{ marginTop: 12 }}>No open orders.</div>}
      </div>
    </>
  )
}

// 3. fills — settled volume per day, matched against another intent or routed
function FillsSection({ d }: { d: IceDashboard }) {
  const rows = d.fillsPerDay
  const days = rows.map(x => x.day)
  const totals = rows.reduce((t, x) => ({
    fills: t.fills + x.fills, solutions: t.solutions + x.solutions, usd: t.usd + x.usd, matched: t.matched + x.matchedUsd, routed: t.routed + x.routedUsd,
  }), { fills: 0, solutions: 0, usd: 0, matched: 0, routed: 0 })
  const any = totals.fills > 0 || totals.solutions > 0
  const columns: StackColumn[] = rows.map((x, i) => ({
    key: x.day, label: dayLabel(days, i),
    segments: [
      { key: 'matched', label: 'Matched', color: MATCHED_COLOR, value: x.matchedUsd },
      { key: 'routed', label: 'Routed', color: ROUTED_COLOR, value: x.routedUsd },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={MATCHED_COLOR} label="Matched" value={F.usd(x.matchedUsd)} />
        <TipRow color={ROUTED_COLOR} label="Routed" value={F.usd(x.routedUsd)} />
        <TipRow label="Fills" value={F.int(x.fills)} />
        <TipRow label="Solutions" value={F.int(x.solutions)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="Fills" subtitle={`${WINDOW_LABEL} · matched against another intent vs routed through the AMMs`} />
      <div className="pf-card">
        {any ? (
          <>
            <ChartLegend items={[{ label: 'Matched', color: MATCHED_COLOR }, { label: 'Routed', color: ROUTED_COLOR }]} />
            <StackedColumnChart columns={columns} h={200} yFmt={v => F.usd(v)} />
            <div className="hdx-cards">
              <Card k="Volume" v={F.usd(totals.usd)} s={`${F.int(totals.fills)} fills — limit-order fills and DCA-intent trades`} />
              <Card k="Matched" v={F.usd(totals.matched)} dot={MATCHED_COLOR} s={totals.usd > 0 ? `${F.share(totals.matched / totals.usd)} never touched an AMM` : 'never touched an AMM'} />
              <Card k="Routed" v={F.usd(totals.routed)} dot={ROUTED_COLOR} s="the pot's own AMM trades" />
              <Card k="Solutions" v={F.int(totals.solutions)} s={totals.solutions > 0 ? `${(totals.fills / totals.solutions).toFixed(1)} fills per solution` : 'submit_solution extrinsics'} />
            </div>
          </>
        ) : <div className="hdx-note" style={{ marginTop: 0 }}>No fills in the last {WINDOW_LABEL}.</div>}
      </div>
    </>
  )
}

// 4. execution quality — closed limit orders
function QualitySection({ d }: { d: IceDashboard }) {
  const q = d.quality
  const bp = q.priceVsLimitBp
  const any = q.medianTimeToFillSec != null || q.cancelRate != null || bp.p50 != null
  return (
    <>
      <SecTitle title="Execution quality" subtitle={`limit orders closed in the last ${WINDOW_LABEL}`} />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0 }}>
          <Card k="Median time to fill" v={q.medianTimeToFillSec != null ? fmtDuration(q.medianTimeToFillSec, { seconds: true }) : '—'} s="placement to first fill" />
          <Card k="Price vs limit" v={fmtBp(bp.p50)} s={`median · p10 ${fmtBp(bp.p10)} · p90 ${fmtBp(bp.p90)}`} />
          <Card k="Partial fills" v={F.share(q.partialShare)} s="of filled orders took more than one fill" />
          <Card k="Cancelled" v={F.share(q.cancelRate)} s="of closed orders, by their owner" />
          <Card k="Expired" v={F.share(q.expiryRate)} s="of closed orders, unmatched by their deadline" />
        </div>
        {!any && <div className="hdx-note">No limit order has closed yet — every figure fills in with the first resolution, cancel or expiry.</div>}
      </div>
    </>
  )
}

// 5. fee revenue — the matched-volume fee, as the revenue model books it
function FeeSection({ d }: { d: IceDashboard }) {
  const perDay = d.feeRevenue.perDay
  const days = perDay.map(x => x.day)
  const total = perDay.reduce((s, x) => s + x.usd, 0)
  const holdings = d.feeRevenue.potHoldings
  const holdingsUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0)
  const line: AreaSeries[] = [{ key: 'fee', label: 'Fee per day', color: FEE_COLOR, values: perDay.map(x => x.usd) }]
  return (
    <>
      <SecTitle title="Fee revenue" subtitle={`${fmtPermill(d.status.protocolFeePpm)} of matched volume, swept from the pot to the fee account per solution`} />
      <div className="pf-card">
        {total > 0 ? (
          <>
            <ChartLegend items={[{ label: 'Fee per day', color: FEE_COLOR }]} />
            <MultiLineChart buckets={days} series={line} h={170} yFmt={v => F.usd(v)} floorZero />
          </>
        ) : <div className="hdx-note" style={{ marginTop: 0 }}>No fee revenue yet — the fee is charged on matched volume only, never on the routed part.</div>}
        <div className="hdx-cards">
          <Card k={WINDOW_LABEL} v={F.usd(total)} dot={FEE_COLOR} s="booked as ICE matched fee on the revenue page" />
          <Card k="In the fee account" v={F.usd(holdingsUsd)} s="held right now, at current prices" />
        </div>
        {holdings.length > 0 && (
          <div className="panel" style={{ marginTop: 12 }}>
            <table className="tbl">
              <thead><tr><th>Asset</th><th className="r">Held</th><th className="r">Value</th></tr></thead>
              <tbody>
                {holdings.map(h => (
                  <tr key={h.asset.assetId}>
                    <td data-label="Asset"><AssetChip asset={h.asset} /></td>
                    <td data-label="Held" className="r mono"><AssetAmount asset={h.asset} raw={h.amount} /></td>
                    <td data-label="Value" className="r mono muted">{F.usd(h.valueUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

// 6. DCA migration — old schedules converted into DCA intents by the hook
function MigrationSection({ d }: { d: IceDashboard }) {
  const m = d.migration
  const days = m.perDay.map(x => x.day)
  const any = m.migrated + m.cancelled > 0
  const columns: StackColumn[] = m.perDay.map((x, i) => ({
    key: x.day, label: dayLabel(days, i),
    segments: [
      { key: 'migrated', label: 'Migrated', color: MIGRATED_COLOR, value: x.migrated },
      { key: 'cancelled', label: 'Cancelled', color: CANCELLED_COLOR, value: x.cancelled },
    ],
    tip: (
      <>
        <span className="t-d">{mdLabel(x.day)}</span>
        <TipRow color={MIGRATED_COLOR} label="Migrated" value={F.int(x.migrated)} />
        <TipRow color={CANCELLED_COLOR} label="Cancelled" value={F.int(x.cancelled)} />
      </>
    ),
  }))
  return (
    <>
      <SecTitle title="DCA migration" subtitle="each old schedule is converted at its next execution slot, or cancelled and refunded" />
      <div className="pf-card">
        <div className="hdx-cards" style={{ marginTop: 0, marginBottom: any ? 14 : 0 }}>
          <Card k="Migrated" v={F.int(m.migrated)} dot={MIGRATED_COLOR} s="schedules now running as DCA intents" />
          <Card k="Cancelled" v={F.int(m.cancelled)} dot={CANCELLED_COLOR} s="refunded to their owners" />
          <Card k="Remaining" v={F.int(m.remainingSchedules)} s="old schedules still to migrate" />
          <Card k="Switch" v={<Switch on={d.status.dcaMigrationEnabled} />} s="DCA.set_migration_enabled" />
        </div>
        {any ? (
          <>
            <ChartLegend items={[{ label: 'Migrated', color: MIGRATED_COLOR }, { label: 'Cancelled', color: CANCELLED_COLOR }]} />
            <StackedColumnChart columns={columns} h={160} yFmt={v => F.int(Math.round(v))} />
            {m.byReason.length > 0 && (
              <div className="panel" style={{ marginTop: 12 }}>
                <table className="tbl">
                  <thead><tr><th>Cancel reason</th><th className="r">Schedules</th></tr></thead>
                  <tbody>
                    {m.byReason.map(r => (
                      <tr key={r.reason}>
                        <td data-label="Cancel reason" className="mono">{r.reason}</td>
                        <td data-label="Schedules" className="r mono">{F.int(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : <div className="hdx-note" style={{ marginTop: 12 }}>No migrations yet{d.status.dcaMigrationEnabled ? '.' : ' — the switch is off.'}</div>}
      </div>
    </>
  )
}

// 7. top pairs — by fill volume
function TopPairsSection({ d }: { d: IceDashboard }) {
  return (
    <>
      <SecTitle title="Top pairs" subtitle={`by fill volume, ${WINDOW_LABEL}`} />
      <div className="panel">
        <table className="tbl">
          <thead><tr><th>Pair</th><th className="r">Fills</th><th className="r">Volume</th></tr></thead>
          <tbody>
            {!d.topPairs.length ? <EmptyRow cols={3}>No fills in the last {WINDOW_LABEL}</EmptyRow> : d.topPairs.map(p => (
              <tr key={`${p.assetIn.assetId}-${p.assetOut.assetId}`}>
                <td data-label="Pair"><span className="trade-leg"><AssetChip asset={p.assetIn} /><span className="muted">→</span><AssetChip asset={p.assetOut} /></span></td>
                <td data-label="Fills" className="r mono">{F.int(p.fills)}</td>
                <td data-label="Volume" className="r mono">{F.usd(p.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function IceSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Open orders" /><ChartSkeleton h={160} />
      <SecTitle title="Fills" /><ChartSkeleton h={260} />
      <SecTitle title="Execution quality" /><ChartSkeleton h={120} />
      <SecTitle title="Fee revenue" /><ChartSkeleton h={230} />
      <SecTitle title="DCA migration" /><ChartSkeleton h={200} />
      <SecTitle title="Top pairs" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={3} rows={4} /></tbody></table></div>
    </>
  )
}

export function Ice() {
  const { data, isError } = useIceDashboard()
  useDocumentTitle('ICE')
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'ICE' }]} />
        <div className="page-title">ICE <span className="sub">intent solver · limit orders, DCA intents & the matched-volume fee</span></div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the ICE dashboard.</div>
        : !data ? <IceSkeleton /> : (
          <>
            <Ribbon d={data} />
            {isLaunchState(data) && (
              <div className="detail-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-medium)', marginBottom: 24 }}>
                No intents yet — the ICE venue went live at block {ICE_LAUNCH_BLOCK}.
              </div>
            )}
            <OpenOrdersSection d={data} />
            <FillsSection d={data} />
            <QualitySection d={data} />
            <FeeSection d={data} />
            <MigrationSection d={data} />
            <TopPairsSection d={data} />
          </>
        )}
    </div>
  )
}
