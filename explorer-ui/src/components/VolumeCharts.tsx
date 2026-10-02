import { useMemo, type ReactNode } from 'react'
import { ChartLegend, StackedBarChart, type AreaSeries } from './HdxCharts'
import { AreaChart, ChartCardSkeleton, F, Usd } from './ui'
import { UNFILTERED_COLOR } from './activityColors'
import { useAssetColors } from '../utils/iconColor'
import { gridRefine, payloadRefine, windowRefine } from '../utils/chartRefine'
import { asOfLabel, fmtVolumeTvl, venueBands, volumeTipLabelAt, WINDOWS } from '../utils/volume'
import { useAssetVolume, useOmnipoolVolume, usePoolVolume, volumeApi, type PoolVolume, type WindowKey } from '../api/volume'
import type { ChartWindowPayload } from '../types'

// The volume sections of the asset and pool pages, in the account Volume
// section's look: a `.pf-card` whose head carries one headline figure and a strip
// of the trailing windows every surface states — 24H, 7D, 30D, 12M — with the
// chart below drawn like the area charts beside it (no axes, no gridlines, date
// and value on hover) and zooming with drag, refined through the route's window
// form down to hourly buckets.
//
// A pool page reads as three sections over one zoom (`ztvl`, the TVL chart's
// long-standing key): TVL (now, and as it stood 24H … 12M ago), Volume (all time,
// and the window totals) and Volume / TVL (the turnover per bucket, and per
// window). The bars wear the neutral ink of /activity's unfiltered daily bars;
// only the Omnipool keeps a colour per asset, the split its readers come for.

export const VOLUME_BAR_COLOR = UNFILTERED_COLOR
const TVL_COLOR = 'var(--sky-deep)'
const TURNOVER_COLOR = 'var(--lavender-deep)'
const OTHER_COLOR = 'var(--text-low)'
const subStyle = { color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 } as const
/** The one zoom a pool page's TVL, Volume and Volume / TVL charts share. */
const POOL_ZOOM_KEY = 'ztvl'


export interface HeadItem { label: string; value: ReactNode; title?: string }

/** A chart card's head: the headline figure left, a strip of window figures right (the account Value/Volume head). */
function FigureHead({ now, nowTitle, items }: { now: ReactNode; nowTitle?: string; items: HeadItem[] }) {
  return (
    <div className="pf-head pf-head-volume">
      <div className="pf-now" title={nowTitle}>{now}</div>
      {items.length > 0 && (
        <div className="perf-row">
          {items.map(it => (
            <span key={it.label} className="perf" title={it.title}><span className="pk">{it.label}</span><span className="pv">{it.value}</span></span>
          ))}
        </div>
      )}
    </div>
  )
}

/** The window totals of a volume payload's KPIs, as head items. */
function totalItems(kpis: Record<WindowKey, { volumeUsd: number }>): HeadItem[] {
  return WINDOWS.map(w => ({ label: w.label, value: <Usd v={kpis[w.key].volumeUsd} />, title: w.days === 1 ? 'Traded in the last 24 hours' : `Traded in the last ${w.days} days` }))
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <>
      <div className="sec-title">{title}</div>
      <ChartCardSkeleton metrics={4} />
    </>
  )
}

function SecTitle({ title, sub }: { title: string; sub?: ReactNode }) {
  return <div className="sec-title">{title}{sub && <span style={subStyle}> · {sub}</span>}</div>
}

/** The window's volume over the mean value pooled across it, explained on hover. */
function volumeTvlTitle(label: string, days: number, meanTvlUsd: number | null | undefined): string {
  if (days === 1) return `${label} volume over the current TVL`
  const span = days === 365 ? '12 months' : `${days} days`
  return meanTvlUsd != null
    ? `${label} volume over the mean TVL across the ${span} (${F.usd(meanTvlUsd)})`
    : `${label} volume over the mean TVL across the ${span}`
}

// ── asset page ────────────────────────────────────────────────────────────────

/**
 * An asset's volume: the value of its own legs, sold plus bought, in every fill —
 * with its money-market aToken and the pool shares shown under it folded in (DOT's
 * page counts aDOT). Headline all time, the strip the window totals, one neutral
 * bar per bucket whose hover splits it by venue. Hidden when the asset never traded.
 */
export function AssetVolumeSection({ assetId, symbol }: { assetId: number; symbol: string }) {
  const q = useAssetVolume(assetId)
  const d = q.data
  const bands = useMemo(() => (d ? venueBands(d.chart) : []), [d])
  if (!d) return q.isLoading ? <SectionSkeleton title="Volume" /> : null
  if (!(d.allTimeUsd > 0) || d.chart.buckets.length < 2 || !bands.length) return null
  const folded = d.assets.filter(a => a.assetId !== assetId).map(a => a.symbol)
  const refine = gridRefine((f, t, n) => volumeApi.assetWindow(assetId, f, t, n), bands)
  const through = asOfLabel(d.asOf)
  const sub = [folded.length > 0 ? `${symbol} with ${folded.join(', ')}` : null, through ? `through ${through}` : null].filter(Boolean)
  return (
    <>
      <SecTitle title="Volume" sub={sub.length > 0 ? sub.join(' · ') : undefined} />
      <div className="pf-card">
        <FigureHead now={<Usd v={d.allTimeUsd} />} nowTitle="All-time volume" items={[
          ...totalItems(d.kpis),
          { label: '7D vol / TVL', value: fmtVolumeTvl(d.volumeTvl.d7), title: volumeTvlTitle('7D', 7, d.volumeTvl.meanTvl7dUsd) },
        ]} />
        <StackedBarChart bare fill={VOLUME_BAR_COLOR} buckets={d.chart.buckets} series={bands} yFmt={F.usd} zoomKey="zvol" refine={refine}
          tipLabel={volumeTipLabelAt(d.asOf)} totalLabel="All venues" />
        <div className="hdx-note">Counts both sides of every swap {symbol} is in; aToken wraps are not volume.</div>
      </div>
    </>
  )
}

// ── pool pages ────────────────────────────────────────────────────────────────

/** "TVL 24H ago · daily close 2026-10-01 00:00 UTC". */
function agoTitle(label: string, at: string | null): string {
  if (!at) return `TVL ${label} ago`
  const d = new Date(at)
  return `TVL ${label} ago · daily close ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * A pool's TVL: now, and as it stood 24H / 7D / 30D / 12M ago (the daily close
 * nearest each instant, `tvlAgo` of the volume payload — absent until it loads),
 * over the page's own TVL history.
 */
export function TvlSection({ title = 'TVL', sub, nowUsd, points, refine, ago, zoomKey = POOL_ZOOM_KEY }: {
  title?: string; sub?: ReactNode; zoomKey?: string
  nowUsd: number | null | undefined
  points: { b: string; v: number }[]
  refine?: Parameters<typeof AreaChart>[0]['refine']
  ago: PoolVolume['tvlAgo'] | undefined
}) {
  if (points.length < 2) return null
  const items: HeadItem[] = ago ? WINDOWS.map(w => ({
    label: w.label, title: agoTitle(w.label, ago[w.key].at),
    value: ago[w.key].usd != null ? <Usd v={ago[w.key].usd!} /> : '—',
  })) : []
  return (
    <>
      <SecTitle title={title} sub={sub} />
      <div className="pf-card">
        <FigureHead now={nowUsd != null ? <Usd v={nowUsd} /> : '—'} nowTitle="TVL now" items={items} />
        <AreaChart data={points.map(p => p.v)} dates={points.map(p => p.b)} h={180} color={TVL_COLOR} floor={0} zoomKey={zoomKey} refine={refine} />
      </div>
    </>
  )
}

/** The volume section's head on a pool page: all time, then the window totals. */
export function PoolVolumeHead({ allTimeUsd, kpis }: { allTimeUsd: number; kpis: PoolVolume['kpis'] | undefined }) {
  return <FigureHead now={<Usd v={allTimeUsd} />} nowTitle="All-time volume" items={kpis ? totalItems(kpis) : []} />
}

function poolVolumeSub(asOf: string | null | undefined): string | undefined {
  const through = asOfLabel(asOf)
  return through ? `through ${through}` : undefined
}

/** A stableswap or XYK pool's Volume: one neutral series, drawn and hovered like the account's Volume bars. */
export function PoolVolumeSection({ poolId }: { poolId: number }) {
  const q = usePoolVolume(poolId)
  const d = q.data
  const data = useMemo(() => (d ? (d.chart.series.volume ?? []).map(v => v ?? 0) : []), [d])
  if (!d) return q.isLoading ? <SectionSkeleton title="Volume" /> : null
  if (!(d.allTime.volumeUsd > 0) || d.chart.buckets.length < 2) return null
  const refine = payloadRefine((f, t, n) => volumeApi.poolWindow(poolId, f, t, n),
    p => (Array.isArray(p.series.volume) ? { data: p.series.volume.map(v => v ?? 0), dates: p.buckets } : null))
  return (
    <>
      <SecTitle title="Volume" sub={poolVolumeSub(d.asOf)} />
      <div className="pf-card">
        <PoolVolumeHead allTimeUsd={d.allTime.volumeUsd} kpis={d.kpis} />
        <AreaChart bars data={data} dates={d.chart.buckets} h={180} floor={0} color={VOLUME_BAR_COLOR} zoomKey={POOL_ZOOM_KEY} refine={refine} />
        <div className="hdx-note">Every swap in this pool counts once; a route through two pools counts in both.</div>
      </div>
    </>
  )
}

/** The Omnipool's Volume: the bars split by asset. */
export function OmnipoolVolumeSection() {
  const q = useOmnipoolVolume()
  const d = q.data
  const colorFor = useAssetColors(d?.stackAssets ?? [])
  // Not memoised: an icon colour resolving later re-renders through useAssetColors
  // without changing `colorFor`'s identity, and the bands must pick it up.
  const bands: AreaSeries[] = !d ? [] : [
    ...(d.stackAssets ?? []).map(a => ({ key: `a:${a.assetId}`, label: a.symbol, color: colorFor(a), values: d.chart.series[`a:${a.assetId}`] ?? [] })),
    { key: 'other', label: 'Other', color: OTHER_COLOR, values: d.chart.series.other ?? [] },
  ]
  if (!d) return q.isLoading ? <SectionSkeleton title="Volume" /> : null
  if (!(d.allTime.volumeUsd > 0) || d.chart.buckets.length < 2) return null
  const refine = gridRefine((f, t, n) => volumeApi.omnipoolWindow(f, t, n), bands)
  return (
    <>
      <SecTitle title="Volume" sub={poolVolumeSub(d.asOf)} />
      <div className="pf-card">
        <PoolVolumeHead allTimeUsd={d.allTime.volumeUsd} kpis={d.kpis} />
        <ChartLegend items={bands.map(b => ({ label: b.label, color: b.color }))} />
        <StackedBarChart bare buckets={d.chart.buckets} series={bands} yFmt={F.usd} zoomKey={POOL_ZOOM_KEY} refine={refine}
          tipLabel={volumeTipLabelAt(d.asOf)} totalLabel="Omnipool volume" />
        <div className="hdx-note" title="Its two hub hops are one swap; the bands split each bar by the assets' share of the value bought and sold in it.">
          Each swap counts once, at the value it bought; a route through another pool also counts there.
        </div>
      </div>
    </>
  )
}

/** The bucketed volume/TVL ratios of a volume payload, null buckets (no TVL) dropped. */
function turnoverPoints(chart: Pick<ChartWindowPayload, 'buckets' | 'series'>): { b: string; v: number | null }[] {
  const s = chart.series.volumeTvl ?? []
  return chart.buckets.map((b, i) => ({ b, v: s[i] ?? null }))
}

/**
 * Volume / TVL — turnover: per bucket, the bucket's volume over the TVL at its
 * end; head 7D, strip the four windows (window volume over the window's mean TVL,
 * 24H over the current TVL), never annualised. `points` and `refine` default to
 * the hourly-model payload's `volumeTvl` series (the Omnipool, stableswap and
 * XYK pages); the Uniswap v3 page passes its own history's.
 */
export function VolumeTvlSection({ d, points: pointsProp, refine: refineProp, fetchWindow, zoomKey = POOL_ZOOM_KEY }: {
  d: PoolVolume | undefined
  zoomKey?: string
  points?: { b: string; v: number | null }[]
  refine?: Parameters<typeof AreaChart>[0]['refine']
  /** The payload's window form, for the default series' zoom refine. */
  fetchWindow?: (fromTs: number, toTs: number, points: number) => Promise<ChartWindowPayload>
}) {
  if (!d) return null
  const points = (pointsProp ?? turnoverPoints(d.chart)).filter((p): p is { b: string; v: number } => p.v != null && Number.isFinite(p.v))
  if (points.length < 2) return null
  const refine = refineProp ?? (fetchWindow ? windowRefine(fetchWindow, turnoverPoints) : undefined)
  const mean: Record<WindowKey, number | null> = { d1: d.tvlUsd, d7: d.meanTvl7dUsd, d30: d.meanTvl30dUsd, d365: d.meanTvl365dUsd }
  return (
    <>
      <SecTitle title="Volume / TVL" sub="each bucket's volume over the TVL at its end, never annualised" />
      <div className="pf-card">
        <FigureHead now={fmtVolumeTvl(d.volumeTvl.d7)} nowTitle={volumeTvlTitle('7D', 7, d.meanTvl7dUsd)} items={WINDOWS.map(w => ({
          label: w.label, value: fmtVolumeTvl(d.volumeTvl[w.key]), title: volumeTvlTitle(w.label, w.days, mean[w.key]),
        }))} />
        <AreaChart data={points.map(p => p.v)} dates={points.map(p => p.b)} h={150} color={TURNOVER_COLOR} floor={0} valueFmt={v => F.share(v)} zoomKey={zoomKey} refine={refine} />
      </div>
    </>
  )
}

/** The `.dl` rows a pool page's header card carries: volume, fees to LPs, volume/TVL and the stableswap fee APR. */
export function PoolVolumeRows({ d }: { d: PoolVolume | undefined }) {
  if (!d) return null
  return (
    <>
      <div className="dt">Volume</div>
      <div className="dd mono"><Usd v={d.kpis.d1.volumeUsd} /> <span className="muted">24H</span>
        <span style={{ marginLeft: 12 }}><Usd v={d.kpis.d7.volumeUsd} /> <span className="muted">7D · {F.int(d.fills.d7)} {d.fills.d7 === 1 ? 'swap' : 'swaps'}</span></span>
      </div>
      <div className="dt">Fees to LPs</div>
      <div className="dd mono"><Usd v={d.fees.d1.lpUsd} /> <span className="muted">24H</span>
        <span style={{ marginLeft: 12 }}><Usd v={d.fees.d7.lpUsd} /> <span className="muted">7D{d.feeApr7dPct != null && <> · {d.feeApr7dPct.toFixed(2)}% fee APR</>}</span></span>
      </div>
      <div className="dt">Volume / TVL</div>
      <div className="dd mono">{fmtVolumeTvl(d.volumeTvl.d1)} <span className="muted">24H</span>
        <span style={{ marginLeft: 12 }}>{fmtVolumeTvl(d.volumeTvl.d7)} <span className="muted">7D</span></span>
      </div>
    </>
  )
}

