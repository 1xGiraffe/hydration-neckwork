import type { ReactNode } from 'react'
import { useHollarDashboard } from '../hooks/useExplorerData'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { paths } from '../router'
import { AssetAmount, Crumbs, F, AssetChip, Ago, AreaChart, ChartSkeleton, TableSkeleton, EmptyRow } from '../components/ui'
import { useAssetColors } from '../utils/iconColor'
import { ChartLegend, ShareBar, MirroredBarChart } from '../components/HdxCharts'
import type { ShareSegment, MirrorBar } from '../components/HdxCharts'
import type { AssetRef, HollarDashboard, HollarCollateral, HollarPool } from '../types'
import { ChartTooltipRow as TipRow, DashboardSectionTitle as SecTitle } from '../components/DashboardPrimitives'
import { monthDayLabel as mdLabel } from '../utils/dashboardDates'

// formatting
// HOLLAR/collateral/partner amounts arrive as already-human-unit numbers (see
// types.ts) — routed through F.amount's magnitude rules (M/B/T/Q, k, plain)
// by treating the number itself as a "raw" value at 0 decimals.
function fmtAmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return F.amount(String(v), 0)
}
function fmtBps(v: number): string {
  const r = Math.round(v * 10) / 10
  const s = r.toFixed(Number.isInteger(r) ? 0 : 1)
  return (r > 0 ? '+' : '') + s + ' bps'
}
// Peg deviation color bands: tight (≤10bps) green, watch (≤50bps) amber, beyond red.
function bpsColor(v: number | null | undefined): string {
  if (v == null) return 'var(--text-high)'
  const a = Math.abs(v)
  return a <= 10 ? 'var(--green)' : a <= 50 ? 'var(--amber)' : 'var(--red)'
}
// Fee/rate fields are already percentages (see hollarService.ts scale notes) —
// just pick enough precision to show sub-1% fees without a wall of zeros.
function fmtFeePct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0%'
  const dec = Math.abs(v) < 0.01 ? 4 : Math.abs(v) < 1 ? 3 : Math.abs(v) < 10 ? 2 : 1
  return v.toFixed(dec).replace(/\.?0+$/, '') + '%'
}

// 1. stat ribbon
function Ribbon({ d }: { d: HollarDashboard }) {
  const chg = d.change24h
  const stablepoolTvl = d.pools.reduce((s, p) => s + (p.tvlUsd ?? 0), 0)
  const cells: { k: string; v: ReactNode }[] = [
    {
      k: 'Price',
      v: <>{F.priceUsd(d.price)}{chg != null && <span style={{ color: chg >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 12, marginLeft: 6 }}>{F.pct(chg)}</span>}</>,
    },
    { k: 'Peg deviation', v: d.pegDeviationBps != null ? <span style={{ color: bpsColor(d.pegDeviationBps) }}>{fmtBps(d.pegDeviationBps)}</span> : '—' },
    { k: 'Supply', v: fmtAmt(d.supply.total) + ' HOLLAR' },
    { k: 'Holders', v: F.int(d.supply.holders) },
    { k: 'HSM reserves', v: F.usd(d.hsm.totalHoldingsUsd) },
    { k: 'Stablepool TVL', v: F.usd(stablepoolTvl) },
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

// 2. peg
function PegSection({ d }: { d: HollarDashboard }) {
  const { peg } = d
  const data = peg.hourly.map(h => h.close)
  const dates = peg.hourly.map(h => h.ts)
  return (
    <>
      <SecTitle title="Peg" subtitle="30 days" />
      <div className="pf-card">
        <AreaChart data={data} dates={dates} target={1} valueFmt={v => '$' + v.toFixed(4)} />
        <div className="hdx-cards">
          <div className="hdx-card">
            <div className="hk">Within ±25 bps</div>
            <div className="hv">{peg.within25bpsPct != null ? peg.within25bpsPct.toFixed(1) + '%' : '—'}</div>
            <div className="hs">of hourly closes · 30d</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Max deviation</div>
            <div className="hv" style={peg.maxDevBps != null ? { color: bpsColor(peg.maxDevBps) } : undefined}>{peg.maxDevBps != null ? fmtBps(peg.maxDevBps) : '—'}</div>
            <div className="hs">30d</div>
          </div>
          <div className="hdx-card">
            <div className="hk">Range</div>
            <div className="hv">{peg.min30d != null && peg.max30d != null ? `$${peg.min30d.toFixed(4)} – $${peg.max30d.toFixed(4)}` : '—'}</div>
            <div className="hs">30d</div>
          </div>
        </div>
      </div>
    </>
  )
}

// 3. stability module (HSM)
const HSM_EXPLAINER = "The HOLLAR Stability Module (HSM) is a GHO-style facilitator: it mints HOLLAR at a small premium over peg when users buy against an approved collateral, and burns HOLLAR bought back from the pool — rate-limited per block by each collateral's buy-back rate and the pool's imbalance. max_buy_price_coefficient sets a soft floor on what the HSM will pay per HOLLAR. An off-chain worker periodically executes flash-loan-funded arbitrage across these pools to keep them balanced, sending any profit to the Treasury."

function HsmCollateralTable({ collaterals, now }: { collaterals: HollarCollateral[]; now: number }) {
  return (
    <div className="panel">
      <table className="tbl">
        <thead>
          <tr>
            <th>Collateral</th><th>Pool</th><th className="r">HSM holdings</th>
            <th className="r">Purchase fee</th><th className="r">Buy-back fee</th>
            <th className="r">Max buy price</th><th className="r">Buy-back rate</th><th className="r">Last arbitrage</th>
          </tr>
        </thead>
        <tbody>
          {!collaterals.length ? <EmptyRow cols={8}>No HSM collaterals</EmptyRow> : collaterals.map(c => (
            <tr key={c.asset.assetId}>
              <td data-label="Collateral"><AssetChip asset={c.asset} /></td>
              <td data-label="Pool" className="mono muted">#{c.poolId}</td>
              <td data-label="HSM holdings" className="r mono">
                {/* one inline-flex line: keeps the USD tag vertically centered
                    with the icon+amount and stops it wrapping underneath */}
                <span className="trade-leg">
                  <AssetAmount asset={c.asset} raw={c.holdings} />
                  {c.holdingsUsd != null && <span className="muted">{F.usd(c.holdingsUsd)}</span>}
                </span>
              </td>
              <td data-label="Purchase fee" className="r mono">{fmtFeePct(c.purchaseFeePct)}</td>
              <td data-label="Buy-back fee" className="r mono">{fmtFeePct(c.buyBackFeePct)}</td>
              <td data-label="Max buy price" className="r mono">${c.maxBuyPrice.toFixed(3)}</td>
              <td data-label="Buy-back rate" className="r mono">{fmtFeePct(c.buybackRatePct)}</td>
              <td data-label="Last arbitrage" className="r mono muted">
                {c.lastArbTs
                  ? <>{c.lastArbDirection && <i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 6, background: c.lastArbDirection === 'in' ? 'var(--green)' : 'var(--amber)' }} />}<Ago ts={c.lastArbTs} now={now} /></>
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ArbitrageChart({ d, now }: { d: HollarDashboard; now: number }) {
  const daily = d.hsm.arbitrageDaily
  const bars: MirrorBar[] = daily.map(a => ({
    key: a.date, up: a.hollarIn, down: a.hollarOut,
    tip: (
      <>
        <span className="t-d">{mdLabel(a.date)}</span>
        <TipRow color="var(--green)" label="Bought back & burned" value={fmtAmt(a.hollarIn) + ' HOLLAR'} />
        <TipRow color="var(--amber)" label="Minted & sold" value={fmtAmt(a.hollarOut) + ' HOLLAR'} />
      </>
    ),
  }))
  const ticks = daily.map((a, i) => ({ i, label: mdLabel(a.date) })).filter(t => t.i % 10 === 0)
  const lastArb = d.hsm.lastArb
  return (
    <>
      <SecTitle title="Arbitrage" subtitle="60 days" />
      <div className="pf-card">
        <ChartLegend items={[{ label: 'Bought back & burned', color: 'var(--green)' }, { label: 'Minted & sold', color: 'var(--amber)' }]} />
        <MirroredBarChart data={bars} xTicks={ticks} upColor="var(--green)" downColor="var(--amber)" />
        <div className="hdx-note">
          {lastArb
            ? <>Last intervention <Ago ts={lastArb.ts} now={now} /></>
            : 'No arbitrage recorded in the last 60 days.'}
        </div>
      </div>
    </>
  )
}

function TradesChart({ d }: { d: HollarDashboard }) {
  const daily = d.hsm.tradesDaily
  const bars: MirrorBar[] = daily.map(t => ({
    key: t.date, up: t.bought, down: t.sold,
    tip: (
      <>
        <span className="t-d">{mdLabel(t.date)}</span>
        <TipRow color="var(--green)" label="Bought (minted)" value={fmtAmt(t.bought) + ' HOLLAR'} />
        <TipRow color="var(--red)" label="Sold (burned)" value={fmtAmt(t.sold) + ' HOLLAR'} />
      </>
    ),
  }))
  const ticks = daily.map((t, i) => ({ i, label: mdLabel(t.date) })).filter(x => x.i % 10 === 0)
  return (
    <>
      <SecTitle title="HSM trades" subtitle="60 days" />
      <div className="pf-card">
        <ChartLegend items={[{ label: 'Bought (minted)', color: 'var(--green)' }, { label: 'Sold (burned)', color: 'var(--red)' }]} />
        <MirroredBarChart data={bars} xTicks={ticks} />
      </div>
    </>
  )
}

function HsmSection({ d, now }: { d: HollarDashboard; now: number }) {
  return (
    <>
      <SecTitle title="Stability Module" subtitle="HSM" />
      <HsmCollateralTable collaterals={d.hsm.collaterals} now={now} />
      <div className="hdx-note" style={{ margin: '12px 0 24px' }}>{HSM_EXPLAINER}</div>
      <ArbitrageChart d={d} now={now} />
      <TradesChart d={d} />
    </>
  )
}

// 4. liquidity
// Minimal AssetRef for HOLLAR (asset 222) so its pool segment samples the same
// icon color as everywhere else, rather than a hard-coded token.
const HOLLAR_ASSET: AssetRef = { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'HOLLAR', decimals: 18, parachainId: null }
function poolLabel(p: HollarPool): string {
  return 'HOLLAR / ' + p.partners.map(pt => pt.asset.symbol).join(' + ')
}
function PoolCard({ p }: { p: HollarPool }) {
  // 50% balance only holds for a 2-asset pool — for N partners the balanced
  // reference is 100/(N+1)% for HOLLAR plus N partner assets.
  const balancedPct = 100 / (p.partners.length + 1)
  // Each segment uses its token's icon-sampled brand color (central useAssetColors),
  // so a pool's composition reads by asset — consistent with the icons/legend — and
  // every asset (incl. ones with no curated color) gets its real hue automatically.
  const colorFor = useAssetColors([HOLLAR_ASSET, ...p.partners.map(pt => pt.asset)])
  const segs: ShareSegment[] = [
    {
      key: 'hollar', label: 'HOLLAR', color: colorFor(HOLLAR_ASSET), value: p.hollar.usd ?? 0,
      tip: <><span className="t-d">HOLLAR</span><TipRow label="Amount" value={fmtAmt(p.hollar.amount) + ' HOLLAR'} /><TipRow label="Value" value={F.usd(p.hollar.usd)} /></>,
    },
    ...p.partners.map((pt, i) => ({
      key: `p${i}`, label: pt.asset.symbol, color: colorFor(pt.asset), value: pt.usd ?? 0,
      tip: <><span className="t-d">{pt.asset.symbol}</span><TipRow label="Amount" value={fmtAmt(pt.amount) + ' ' + pt.asset.symbol} /><TipRow label="Value" value={F.usd(pt.usd)} /></>,
    })),
  ]
  return (
    <div className="hdx-card" style={{ gap: 10 }}>
      <div className="hk" style={{ flexWrap: 'wrap', rowGap: 2 }}><span>{poolLabel(p)}</span><span className="cap">{F.usd(p.tvlUsd)} TVL</span></div>
      <ShareBar segments={segs} h={26} />
      <div className="hs">
        HOLLAR {p.hollarSharePct != null ? p.hollarSharePct.toFixed(1) + '%' : '—'}
        <span className="muted" title={`Balanced ≈ ${balancedPct.toFixed(1)}% for a ${p.partners.length + 1}-asset pool`}> (balanced ≈ {balancedPct.toFixed(1)}%)</span>
      </div>
      <div className="hs">{p.partners.map((pt, i) => <span key={i}>{i > 0 && ' · '}<AssetAmount asset={pt.asset} formatted={fmtAmt(pt.amount)} /></span>)}</div>
    </div>
  )
}
function LiquiditySection({ d }: { d: HollarDashboard }) {
  const segs: ShareSegment[] = [
    { key: 'stablepools', label: 'Stablepools', color: 'var(--sky)', value: d.supply.inStablepools, tip: <><span className="t-d">Stablepools</span><TipRow label="HOLLAR" value={fmtAmt(d.supply.inStablepools) + ' HOLLAR'} /></> },
    { key: 'omnipool', label: 'Omnipool', color: 'var(--sky-deep)', value: d.supply.inOmnipool, tip: <><span className="t-d">Omnipool</span><TipRow label="HOLLAR" value={fmtAmt(d.supply.inOmnipool) + ' HOLLAR'} /></> },
    { key: 'other', label: 'Other (wallets & protocol)', color: 'var(--text-low)', value: d.supply.other, tip: <><span className="t-d">Other</span><TipRow label="HOLLAR" value={fmtAmt(d.supply.other) + ' HOLLAR'} /></> },
  ]
  return (
    <>
      <SecTitle title="Liquidity" />
      <div className="pf-card">
        <ChartLegend items={segs.map(s => ({ label: s.label, color: s.color }))} />
        <ShareBar segments={segs} />
        <div className="hdx-cards pool-cards">
          {d.pools.map(p => <PoolCard key={p.poolId} p={p} />)}
        </div>
      </div>
    </>
  )
}

// loading skeleton (per section)
function HollarSkeleton() {
  return (
    <>
      <ChartSkeleton h={78} />
      <SecTitle title="Peg" subtitle="30 days" /><ChartSkeleton h={280} />
      <SecTitle title="Stability Module" subtitle="HSM" />
      <div className="panel"><table className="tbl"><tbody><TableSkeleton cols={8} rows={4} /></tbody></table></div>
      <ChartSkeleton h={210} />
      <ChartSkeleton h={210} />
      <SecTitle title="Liquidity" /><ChartSkeleton h={230} />
    </>
  )
}

export function Hollar() {
  const { data, isError } = useHollarDashboard()
  const now = useNow()
  useDocumentTitle(data && data.price != null ? `HOLLAR ${F.priceUsd(data.price)}` : 'HOLLAR')
  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'HOLLAR' }]} />
        <div className="page-title">HOLLAR <span className="sub">GHO-fork stablecoin · peg, HSM & liquidity</span></div>
      </div>
      {isError
        ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Failed to load the HOLLAR dashboard.</div>
        : !data ? <HollarSkeleton /> : (
          <>
            <Ribbon d={data} />
            <PegSection d={data} />
            <HsmSection d={data} now={now} />
            <LiquiditySection d={data} />
          </>
        )}
    </div>
  )
}
