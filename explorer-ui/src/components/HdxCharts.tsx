/* eslint-disable react-refresh/only-export-components -- chart primitives + shared tick-formatter/color-token module (mirrors ui.tsx) */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { ChartMarkerLayer, ChartTip, compactAmount } from './ui'
import type { ChartMarker } from './ui'
import { ZoomReset, ZoomSelection, bracketToView, fracOfTime, seriesGrainSec, useChartZoom, useZoomRefineValue } from './chartZoom'
import type { TimeWindow } from './chartZoom'
export { seriesGrainSec }
import { useMediaQuery } from '../hooks/useMediaQuery'
import { parseUtcTimestamp, utcDay, utcSeconds, utcStamp } from '../utils/time'

/* ============ formatting ============ */
// Compact form for on-bar clamp labels: whole millions once past ~10M, so the
// value labels on adjacent clamped columns keep clear space between them
// (147.94M → "148M"). Billions still collapse via the shared scale (1.61B).
export function fmtHdxTick(v: number): string {
  return Math.abs(v) >= 1e7 ? compactAmount(Math.round(v / 1e6) * 1e6) : compactAmount(v)
}

/* ============ chart color system (CVD-validated — fixed, never cycled) ============ */
// Lock hues live in ./lockColors, a leaf module, so the account and tag balance
// bars can share them without pulling these chart components along.
// Cohorts: ordinal ramp, light→dark = Shrimp→Whale.
const COHORT_COLORS: Record<string, string> = {
  shrimp: '#b7d3f4',
  fish: '#7fb0ea',
  dolphin: '#3f88dd',
  whale: '#1d5fae',
}
export function cohortColor(key: string): string { return COHORT_COLORS[key] ?? 'var(--text-low)' }

// Ownership-over-time classes. Entity colors are fixed: the Treasury wears a
// near-white grey (the big neutral block at the chart floor) over the darker
// protocol-plumbing grey, Kraken its tag purple (#7b6cf6 — the hue its account
// pill wears everywhere), and the user tranches reuse the cohort ramp so
// "Top 10" is the same whale blue as the Holder distribution bar above.
// Adjacent non-ramp pairs are CVD-checked; the blue ramp is ordinal on purpose.
export const OWNERSHIP_COLORS: Record<string, string> = {
  treasury: '#DDE3ED',
  protocol: 'var(--neutral)',
  kraken: '#7b6cf6',
  top10: COHORT_COLORS.whale,
  top11to100: COHORT_COLORS.dolphin,
  top101to1000: COHORT_COLORS.fish,
  rest: COHORT_COLORS.shrimp,
}

// Holder-age bands (HODL waves): one sequential violet ramp, dark→light =
// oldest→newest, so loyalty literally deepens toward the chart floor.
export const AGE_COLORS: Record<string, string> = {
  over2y: '#5E35A8',
  y1to2: '#9165D6',
  m3to12: '#BC9BE8',
  under3m: '#E3D3F7',
}

/* ============ legend ============ */
// Small legend row: colored dot + label (GeistMono 11px, reuses .bal-legend).
// `dashed` draws the swatch as a short dashed stroke, for a series drawn dashed.
export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="bal-legend" style={{ margin: '0 0 10px' }}>
      {items.map(it => <span key={it.label}>{it.dashed ? <i className="lg-dash" style={{ color: it.color }} /> : <i style={{ background: it.color }} />}{it.label}</span>)}
    </div>
  )
}

// Touch has no hover-out: a tapped tooltip deliberately stays open so it can be
// read after the finger lifts, but it then needs a way OFF the screen. Clear it
// when the next pointerdown lands anywhere outside the chart (the capture phase
// beats stopPropagation in whatever was tapped instead).
function useClearOnOutsidePointer(clear: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  // `clear` is an inline arrow, so the listener re-subscribes per render — but
  // only while a tooltip is open, and renders then only happen on hover moves.
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const el = ref.current
      if (el && e.target instanceof Node && !el.contains(e.target)) clear()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [active, clear])
  return ref
}

/* ============ 100%-stacked horizontal share bar ============ */
export interface ShareSegment { key: string; label: string; color: string; value: number; tip: ReactNode }

// Rounded 8px outer ends via clipPath; 2px card-background gaps between segments
// (stroke with var(--bg-elev)); per-segment hover tooltip below the bar.
export function ShareBar({ segments, h = 44 }: { segments: ShareSegment[]; h?: number }) {
  const clipId = useId()
  const [hover, setHover] = useState<{ leftPct: number; tip: ReactNode } | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const segs = segments.filter(s => s.value > 0)
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!segs.length || total <= 0) return <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, padding: '12px 0' }}>Nothing to show yet</div>
  const offsets: number[] = []
  for (let i = 0, run = 0; i < segs.length; i++) { offsets.push(run); run += segs[i].value }
  const rects = segs.map((s, i) => ({ ...s, x0: offsets[i] / total * 100, w: s.value / total * 100 }))
  return (
    <div ref={wrapRef} className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg width="100%" height={h} role="img">
        <defs><clipPath id={clipId}><rect x="0" y="0" width="100%" height={h} rx="8" /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          {rects.map(s => (
            <rect
              key={s.key} x={`${s.x0}%`} y="0" width={`${s.w}%`} height={h} fill={s.color}
              stroke={rects.length > 1 ? 'var(--bg-elev)' : 'none'} strokeWidth={2}
              onMouseEnter={() => setHover({ leftPct: s.x0 + s.w / 2, tip: s.tip })}
            />
          ))}
        </g>
      </svg>
      {hover && <ChartTip className="hdx-tip" xPct={hover.leftPct} top={h + 8}>{hover.tip}</ChartTip>}
    </div>
  )
}

/* ============ vertical stacked-column chart (unlock timeline) ============ */
interface StackSegment { key: string; label: string; color: string; value: number }
export interface StackColumn { key: string; label: string; segments: StackSegment[]; tip: ReactNode }

// Distribute segment pixel heights inside one column. When the column fits the
// plot, true-scale heights pass through. When it overflows (clamped outlier
// column), small segments KEEP their true height — so e.g. a steady vesting
// drip renders identically next to its unclamped neighbours — and only the
// oversized segment(s) share the leftover, proportionally, floored at minPx.
export function stackHeights(trueHeights: number[], plotH: number, minPx = 4): number[] {
  const total = trueHeights.reduce((s, v) => s + v, 0)
  if (total <= plotH) return trueHeights
  const asc = trueHeights.map((_, i) => i).sort((a, b) => trueHeights[a] - trueHeights[b])
  // Ascending greedy: segments stay true-scale while the running total leaves
  // at least minPx for every remaining (bigger) segment; the rest are outliers.
  let cut = asc.length
  let smallSum = 0
  for (let k = 0; k < asc.length; k++) {
    const h = trueHeights[asc[k]]
    if (smallSum + h + minPx * (asc.length - k - 1) > plotH) { cut = k; break }
    smallSum += h
  }
  const out = [...trueHeights]
  const larges = asc.slice(cut)
  const largeSum = larges.reduce((s, i) => s + trueHeights[i], 0)
  const leftover = plotH - smallSum
  for (const i of larges) out[i] = Math.max(minPx, leftover * (trueHeights[i] / largeSum))
  return out
}

export function stackedColumnMax(totals: number[], outlierRatio = 2.5): number {
  const positive = totals.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => b - a)
  if (positive.length === 0) return 1

  // A high-end cluster can contain several related tall buckets. Find the
  // strongest separation within the top third and scale from the first
  // representative bucket below it, so the tall cluster clamps and the smaller
  // bars keep a visible, readable height. Every value above the scale is still
  // labelled directly and marked as clamped by the chart. `ceil` (not `floor`)
  // so a cluster of just over a third — e.g. five tall unlock buckets amongst
  // fourteen — is still recognised rather than left to flatten the rest.
  const maxHighCluster = Math.max(1, Math.ceil(positive.length / 3))
  let split = -1
  let strongestRatio = outlierRatio
  for (let i = 0; i < positive.length - 1 && i < maxHighCluster; i++) {
    const ratio = positive[i] / positive[i + 1]
    if (ratio > strongestRatio) {
      strongestRatio = ratio
      split = i
    }
  }

  const base = split >= 0 ? positive[split + 1] * 1.15 : positive[0]
  return Math.max(base, 1) * 1.05
}

// Round a cap up to a tidy axis ceiling. Only two gridlines are drawn — the top
// and its midpoint — so we round the MIDPOINT up to a clean unit (a quarter of
// the leading decade: 25M at the 100M scale, 2.5M at the 10M scale, …) and set
// the top to exactly twice it. Both lines then land on round numbers that step
// evenly with no gaps (midpoints 75M · 100M · 125M · 150M …, tops 150M · 200M ·
// 250M · 300M …), and the rule scales to any magnitude.
export function niceAxisMax(v: number): number {
  if (!(v > 0)) return 1
  const decade = 10 ** Math.floor(Math.log10(v) + 1e-9)
  const unit = decade / 4
  const mid = Math.ceil(v / 2 / unit - 1e-9) * unit
  return mid * 2
}

// Segments stack bottom-up in the order given, separated by 2px gaps; 3 y-gridlines
// with compact labels; optional dashed separator (weekly → monthly) before a column.
export function StackedColumnChart({ columns, h = 200, separatorAt, separatorCaption, yFmt = compactAmount }: {
  columns: StackColumn[]; h?: number; separatorAt?: number; separatorCaption?: string; yFmt?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const n = columns.length
  const totals = columns.map(c => c.segments.reduce((s, x) => s + x.value, 0))
  // Single shared axis for weekly and monthly. Detect the tall-bucket cluster
  // across all columns and cap just above the representative smaller bars,
  // rounded up to a tidy ceiling: the tall buckets clamp (break marks + their
  // true value) while the smaller bars keep a readable height instead of being
  // flattened.
  const split = separatorAt != null && separatorAt > 0 && separatorAt < n ? separatorAt : null
  const max = niceAxisMax(stackedColumnMax(totals))
  const W = 860, padL = 46, padR = 6, padT = 16, padB = 18
  const plotH = h - padT - padB
  const bw = n ? (W - padL - padR) / n : 0
  const colX = (i: number) => padL + i * bw
  const gy = (t: number) => padT + (1 - t) * plotH
  return (
    <div ref={wrapRef} className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={gy(t).toFixed(1)} y2={gy(t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={padL - 8} y={(gy(t) + 3).toFixed(1)} textAnchor="end">{yFmt(max * t)}</text>
          </g>
        ))}
        {split != null && (
          <g>
            <line x1={colX(split).toFixed(1)} x2={colX(split).toFixed(1)} y1={padT - 4} y2={h - padB} stroke="var(--text-low)" strokeDasharray="3 4" strokeOpacity="0.5" />
            {separatorCaption && <text className="hdx-ax" x={(colX(split) - 5).toFixed(1)} y={padT - 6} textAnchor="end">{separatorCaption}</text>}
          </g>
        )}
        {columns.map((c, i) => {
          const bx = colX(i) + 3, bwid = Math.max(1, bw - 6)
          const clamped = totals[i] > max
          // Clamped outlier: only the oversized segment(s) compress — small
          // segments keep the shared scale so they stay comparable with the
          // neighbouring columns; break slashes + a direct value label mark
          // the cut column.
          const heights = stackHeights(c.segments.map(s => s.value / max * plotH), plotH)
          let cursor = h - padB
          const segRects = c.segments.map((s, j) => ({ s, hPix: heights[j] })).filter(x => x.s.value > 0).map(({ s, hPix }) => {
            const rect = (
              <rect
                key={s.key} x={bx.toFixed(1)} y={(cursor - hPix + Math.min(2, hPix - 0.75)).toFixed(1)}
                width={bwid.toFixed(1)} height={Math.max(0.75, hPix - 2).toFixed(1)}
                fill={s.color} rx="1.5" opacity={hover == null || hover === i ? 1 : 0.7}
              />
            )
            cursor -= hPix
            return rect
          })
          return (
            <g key={c.key}>
              {segRects}
              {clamped && (
                <g>
                  <line x1={(bx - 2).toFixed(1)} x2={(bx + bwid + 2).toFixed(1)} y1={padT + 9} y2={padT + 4} stroke="var(--bg-elev)" strokeWidth="3" />
                  <line x1={(bx - 2).toFixed(1)} x2={(bx + bwid + 2).toFixed(1)} y1={padT + 15} y2={padT + 10} stroke="var(--bg-elev)" strokeWidth="3" />
                  <text className="hdx-ax" x={(bx + bwid / 2).toFixed(1)} y={padT - 5} textAnchor="middle" style={{ fill: 'var(--text-medium)' }}>{fmtHdxTick(totals[i])}</text>
                </g>
              )}
              <text className="hdx-ax" x={(bx + bwid / 2).toFixed(1)} y={h - 4} textAnchor="middle">{c.label}</text>
              <rect x={colX(i).toFixed(1)} y={padT - 4} width={bw.toFixed(1)} height={plotH + 4} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          )
        })}
      </svg>
      {hover != null && columns[hover] && (
        <ChartTip className="hdx-tip" xPct={(colX(hover) + bw / 2) / W * 100} top={2}>{columns[hover].tip}</ChartTip>
      )}
    </div>
  )
}


/* ============ stacked area (pool composition over time) ============ */
// `hatch` overlays a faint light diagonal texture on the band's fill and a
// light halo under its top edge — for brand-black bands (GIGAHDX) that would
// otherwise vanish into a dark background. The light marks disappear on light
// surfaces, where the black fill carries itself.
// `dashed` (MultiLineChart only) draws the line dashed and fainter — a figure from
// another source than the solid lines beside it — and leaves it unmarked by markLast.
export interface AreaSeries { key: string; label: string; color: string; values: (number | null)[]; hatch?: boolean; dashed?: boolean }

// Cumulative stack tops, bottom-up in the order given (largest first from the
// API). A null contributes nothing to its bucket — the band is absent there,
// not zero-thick by fiat — while the numbers stay null for the tooltip.
export function stackSeries(series: AreaSeries[]): { tops: number[][]; max: number } {
  const n = series[0]?.values.length ?? 0
  const tops: number[][] = []
  let prev = new Array<number>(n).fill(0)
  for (const s of series) {
    const top = prev.map((v, i) => v + (s.values[i] ?? 0))
    tops.push(top)
    prev = top
  }
  const max = prev.reduce((m, v) => (v > m ? v : m), 0)
  return { tops, max }
}

// Contiguous non-null index runs of a series — a line breaks where data is
// absent (a destroyed pool, a pre-listing gap) instead of bridging the hole.
export function lineRuns(values: (number | null)[]): [number, number][] {
  const runs: [number, number][] = []
  let start: number | null = null
  for (let i = 0; i <= values.length; i++) {
    const has = i < values.length && values[i] != null
    if (has && start == null) start = i
    if (!has && start != null) { runs.push([start, i - 1]); start = null }
  }
  return runs
}

// X tick label at the granularity the DRAWN window justifies: month + year
// across eras, month + day inside a few months, and the clock once a
// zoom-refined window is down to a day or two — otherwise all four ticks of a
// zoomed window read the same "Aug ’26", and an hourly grid printed its full
// `YYYY-MM-DD HH:MM:SS` key. `spanSec` 0 (no usable time axis) keeps the
// month + year form.
//
// `grainSec` caps that: the clock is only ever printed for a series whose points
// are finer than a day. A daily series zoomed under two days would otherwise
// label every tick "Sep 3 00:00" — a clock the data does not carry, which reads
// as intraday precision that isn't there.
export function axisTick(key: string, spanSec: number, grainSec = 0): string {
  const t = parseUtcTimestamp(key)
  if (!Number.isFinite(t)) return key
  const d = new Date(t)
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (!(spanSec > 0) || spanSec > 150 * 86_400) return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', ' ’')
  if (spanSec > 2 * 86_400 || grainSec >= 86_400) return day
  return `${day} ${d.toISOString().slice(11, 16)}`
}

/**
 * Tooltip date at the series' own resolution: a daily point names its day, a
 * finer point adds the clock. Clipping a zoom window re-keys buckets to the full
 * `YYYY-MM-DD HH:MM:SS` form, so without this a daily chart's tooltip gains a
 * ` 00:00:00` the moment it is zoomed.
 */
export function tipDate(key: string, grainSec: number): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(key)) return key
  return grainSec > 0 && grainSec < 86_400 ? key.slice(0, 16) : key.slice(0, 10)
}

// The drawn series' own resolution (`seriesGrainSec`) lives in chartZoom.tsx,
// where the zoom's extent is inferred from it; re-exported above.
// Four evenly spaced x-axis date ticks (first/last + thirds).
function dateTicks(n: number): number[] {
  if (n < 2) return []
  return [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])]
}

// Stacked area chart on a continuous daily axis: pool/asset composition over
// time. Bands are the series' own (icon-sampled) colors — identity follows the
// token, exactly like ShareBar — with a 2px top edge in the band color over a
// translucent fill so adjacent bands separate without a synthetic gap. Axis and
// hover follow StackedColumnChart / AreaChart conventions; no animation.
// `showShare={false}` drops the tooltip's per-bucket share suffix — a chart
// already plotting shares (100%-stacked mode) would repeat every value.
const AREA_W = 860, AREA_PAD_L = 46, AREA_PAD_R = 6
/** Bucket keys -> unix seconds, for either grain the API emits. */
const bucketSecs = (keys: string[]): number[] => keys.map(utcSeconds)

/** What a refined multi-series payload looks like: one grid, every band on it. */
export interface RefinedGrid { buckets: string[]; series: AreaSeries[] }

// Stable identity: this goes into the refine effect's deps.
const acceptGrid = (r: RefinedGrid, span: number) =>
  r.buckets.length > span && r.series.every(s => s.values.length === r.buckets.length)

export function StackedAreaChart({ buckets, series, h = 220, yFmt = compactAmount, showShare = true, totalLabel, zoomKey, refine }: {
  buckets: string[]; series: AreaSeries[]; h?: number; yFmt?: (v: number) => string; showShare?: boolean
  /** Adds a summed stack-top row under the bands in the tooltip, under this label. */
  totalLabel?: string
  /** Query-param name persisting the zoom window (back-navigable, shareable). */
  zoomKey?: string
  /** Refetch-on-zoom: a finer grid for base-index window [lo, hi]. */
  refine?: (fromSec: number, toSec: number, points: number) => Promise<RefinedGrid | null>
}) {
  const hatchId = useId()
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const W = AREA_W, padL = AREA_PAD_L, padR = AREA_PAD_R, padT = 12, padB = 18
  const plotW = W - padL - padR
  // Absolute-time window: the hook needs only the buckets' instants.
  const bucketTimes = useMemo(() => bucketSecs(buckets), [buckets])
  // Gesture zoom (chartZoom.tsx): plot fractions exclude the y-axis gutter.
  const zoom = useChartZoom(
    bucketTimes,
    e => {
      const r = (wrapRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect()
      if (!r.width) return 0
      return Math.min(1, Math.max(0, (((e.clientX - r.left) / r.width) * W - padL) / plotW))
    },
    () => setHover(null),
    zoomKey,
  )
  // A refined grid replaces the coarse slice wholesale: buckets and every band
  // come from one fetch, so they cannot end up drawn on different grids.
  const refined = useZoomRefineValue(zoom, refine, 180, acceptGrid)
  const rawBuckets = refined?.buckets ?? (zoom.zoomed ? buckets.slice(zoom.lo, zoom.hi + 1) : buckets)
  const rawSeries = refined?.series ?? (zoom.zoomed ? series.map(s => ({ ...s, values: s.values.slice(zoom.lo, zoom.hi + 1) })) : series)
  // Clip to the window: a bucket outside it maps past this chart's axis gutter and
  // draws to the container edge, and a coarse slice with a couple of interior
  // points would cover part of the width until the refined grid arrives.
  const clip = zoom.zoomed ? bracketToView(bucketSecs(rawBuckets), zoom.view, rawSeries.map(s => s.values)) : null
  const useClip = clip != null && clip.times.length >= 2
  const vBuckets = useClip ? clip.times.map(utcStamp) : rawBuckets
  const vSeries = useClip ? rawSeries.map((s, i) => ({ ...s, values: clip.series[i] })) : rawSeries
  const n = vBuckets.length
  const { tops, max: rawMax } = stackSeries(vSeries)
  if (n < 2 || !vSeries.length || !(rawMax > 0)) {
    return (
      <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12, position: 'relative' }}>
        Not enough history.
        {zoom.zoomed && <ZoomReset onReset={zoom.reset} />}
      </div>
    )
  }
  const max = niceAxisMax(rawMax)
  const plotH = h - padT - padB
  // Positions come from the view's TIME domain, the same one the zoom window and
  // its selection shade use — index spacing would put the line and the shade on
  // different axes, which is the mismatch this whole model exists to remove. It
  // falls back to index spacing when the buckets are not a usable time axis.
  const vTimes = bucketSecs(vBuckets)
  const viewSpan = zoom.view.to - zoom.view.from
  const timeAxis = viewSpan > 0 && vTimes.length === n && vTimes.every(Number.isFinite)
  // The drawn points' own spacing bounds how precisely a label may name them.
  const grainSec = timeAxis ? seriesGrainSec(vTimes) : 0
  // Clamped into the plot: the slice deliberately keeps the point on each side of
  // the window so the line reaches both edges, and this chart's plot is inset by a
  // y-axis gutter — unclamped, those points draw over the axis and out to the
  // container edge. Only the DRAWN x is clamped; the tooltip still names the
  // point's real time, and for a forward-filled series the bracketing value is
  // the correct value at the edge anyway.
  const xf = (i: number) => Math.min(1, Math.max(0, timeAxis ? (vTimes[i] - zoom.view.from) / viewSpan : n > 1 ? i / (n - 1) : 0))
  const sx = (i: number) => padL + xf(i) * plotW
  const sy = (v: number) => padT + (1 - v / max) * plotH
  const bands = vSeries.map((s, k) => {
    const top = tops[k]
    const bottom = k === 0 ? null : tops[k - 1]
    const fwd = top.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
    const back = bottom
      ? [...bottom.keys()].reverse().map(i => `L ${sx(i).toFixed(1)} ${sy(bottom[i]).toFixed(1)}`).join(' ')
      : `L ${sx(n - 1).toFixed(1)} ${sy(0).toFixed(1)} L ${sx(0).toFixed(1)} ${sy(0).toFixed(1)}`
    return { s, area: `${fwd} ${back} Z`, edge: fwd }
  })
  function onMove(e: React.PointerEvent) {
    if (zoom.selecting || zoom.pinching) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!r.width) return
    const x = ((e.clientX - r.left) / r.width) * W
    const f = (x - padL) / plotW
    let i = Math.round(f * (n - 1))
    if (timeAxis) {
      // Nearest point along the same time axis the line is drawn on.
      let best = 0
      for (let k = 1; k < n; k++) if (Math.abs(xf(k) - f) < Math.abs(xf(best) - f)) best = k
      i = best
    }
    setHover(Math.min(n - 1, Math.max(0, i)))
  }
  const selPct = (f: number) => (padL + Math.min(1, Math.max(0, f)) * plotW) / W * 100
  // Back/forward can change the window without a gesture; a stale hover index
  // past the new slice must not address it.
  if (hover != null && hover > n - 1) setHover(null)
  const hoverTotal = hover != null && hover <= n - 1 ? vSeries.reduce((s, x) => s + (x.values[hover] ?? 0), 0) : 0
  return (
    <div ref={wrapRef} className="hdx-chart-wrap apx-wrap" data-zoom-key={zoomKey}
      onPointerDown={e => { zoom.onPointerDown(e); onMove(e) }}
      onPointerMove={e => { zoom.onPointerMove(e); onMove(e) }}
      onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerCancel} onDoubleClick={zoom.onDoubleClick}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={sy(max * t).toFixed(1)} y2={sy(max * t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={padL - 8} y={(sy(max * t) + 3).toFixed(1)} textAnchor="end">{yFmt(max * t)}</text>
          </g>
        ))}
        {series.some(x => x.hatch) && (
          <defs>
            <pattern id={hatchId} patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,0.28)" strokeWidth="1.6" />
            </pattern>
          </defs>
        )}
        {bands.map(({ s, area, edge }) => (
          <g key={s.key}>
            <path d={area} fill={s.color} fillOpacity={0.42} />
            {s.hatch && <path d={area} fill={`url(#${hatchId})`} />}
            {s.hatch && <path d={edge} fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="4.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            <path d={edge} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {dateTicks(n).map(i => (
          <text key={i} className="hdx-ax" x={sx(i).toFixed(1)} y={h - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{axisTick(vBuckets[i], timeAxis ? viewSpan : 0, grainSec)}</text>
        ))}
        {hover != null && !zoom.selecting && <line x1={sx(hover).toFixed(1)} x2={sx(hover).toFixed(1)} y1={padT} y2={h - padB} stroke="var(--text-medium)" strokeOpacity="0.55" />}
      </svg>
      {hover != null && !zoom.selecting && (
        <ChartTip className="hdx-tip" xPct={sx(hover) / W * 100} top={2}>
          <span className="t-d">{tipDate(vBuckets[hover], grainSec)}</span>
          {vSeries.map(s => s.values[hover] != null && (
            <span key={s.key} className="t-row"><i style={{ background: s.color }} />{s.label}
              <span className="tv">{yFmt(s.values[hover]!)}{showShare && hoverTotal > 0 && <span className="muted"> · {(s.values[hover]! / hoverTotal * 100).toFixed(1)}%</span>}</span>
            </span>
          ))}
          {/* The stack top is a quantity of its own on a chart whose bands share a
              unit (collateral, TVL) — reading it off the axis is guesswork. */}
          {totalLabel && vSeries.length > 1 && hoverTotal > 0 && (
            <span className="t-row t-total">{totalLabel}<span className="tv">{yFmt(hoverTotal)}</span></span>
          )}
        </ChartTip>
      )}
      {zoom.preview && (() => {
        // The shade IS the window a lift commits, on the view's time domain, so
        // it tracks the cursor instead of stepping between buckets.
        const pw = zoom.preview
        return <ZoomSelection aPct={selPct(fracOfTime(zoom.view, pw.from))} bPct={selPct(fracOfTime(zoom.view, pw.to))}
          label={`${utcDay(pw.from)} – ${utcDay(pw.to)}`} />
      })()}
      {zoom.zoomed && !zoom.sel && <ZoomReset onReset={zoom.reset} />}
    </div>
  )
}

/* ============ multi-line (peg drift) ============ */
// Sparse multi-line chart for slow-moving rates (stableswap peg drift). One
// shared axis zoomed to the data (pegs sit at 1.05–1.65, a zero base would
// flatten the drift that is the whole story); the unit peg 1.0 gets a dashed
// reference line only when it is in view. Lines break at nulls.
// `floorZero` clamps the axis floor at 0 — a price or share axis must not pad
// into negative territory when the data sits near its floor.
const LINE_W = 860, LINE_PAD_L = 56, LINE_PAD_R = 6
/** A horizontal value band (a vault's managed range, a peg corridor). */
export interface ChartZone { from: number; to: number; label?: string; color?: string }

/**
 * Where a zone lands on a chart whose y-domain is [min, max], as fractions from
 * the TOP: a zone reaching past an edge is clipped to it rather than dropped, so a
 * band wider than the drawn window still reads as "we are inside it". `covers` is
 * true when it fills the plot — then the tint says nothing and only its label does.
 */
export function zoneSpan(zone: ChartZone, min: number, max: number): { top: number; bottom: number; covers: boolean; loInside: boolean; hiInside: boolean } | null {
  const span = max - min
  if (!(span > 0)) return null
  const lo = Math.min(zone.from, zone.to), hi = Math.max(zone.from, zone.to)
  if (hi <= min || lo >= max) return null
  const top = Math.max(0, (max - hi) / span)
  const bottom = Math.min(1, (max - lo) / span)
  return { top, bottom, covers: bottom - top > 0.95, loInside: lo > min, hiInside: hi < max }
}

/**
 * An unlabelled second scale for some of a MultiLineChart's series — a ratio drawn
 * beside the amounts it is a ratio of (a health factor over supplied and borrowed
 * USD), on its own vertical scale so neither flattens the other. It draws no axis:
 * its values are read from the tooltip (`fmt`) and the newest-point dot. `keys`
 * names its series; everything else stays on the (left) axis. `anchor` is the
 * value drawn ON the axis's floor line (a health factor's 1 on $0), so the two
 * share that baseline and a value below it continues the same scale downward into
 * the `floorZone` (clamped at its floor); without it the scale starts at the
 * data's padded low. `max` is a ceiling (the scale ends at the data's padded top,
 * never above `max`, so a capped series runs along the top).
 */
export interface SecondaryScale { keys: string[]; fmt: (v: number) => string; anchor?: number; max?: number }

/**
 * A strip under the axis floor (`frac` of the plot's height), tinted `color`: the
 * region a second scale's values below its anchor fall into (a liquidation zone
 * under HF 1), and where the chart's markers sit, named by `label` right-aligned
 * inside it. The label steps left of any marker or newest-point dot near the
 * right edge (they win), and wears a halo so a line crossing it stays legible.
 * The axis itself stays floored at 0 — no axis value is drawn in it.
 */
export interface FloorZone { frac: number; color: string; label?: string }

export function MultiLineChart({ buckets, series, h = 190, yFmt = (v: number) => v.toFixed(4), floorZero, band, zones, secondary, floorZone, markLast, markers, hideDates, zoomKey, refine }: {
  buckets: string[]; series: AreaSeries[]; h?: number; yFmt?: (v: number) => string; floorZero?: boolean
  /**
   * Draw two of the series as one filled low/high envelope: a RANGE reads as an
   * area between its bounds, not as two more measurements. `lo`/`hi` name the
   * pair's keys and `label` the single tooltip row that replaces their two. A
   * refined window carrying only the main line simply has no pair, and no band.
   */
  band?: { lo: string; hi: string; label: string }
  /**
   * Horizontal value bands behind the lines — a vault's managed range, a peg
   * corridor. They are drawn, never measured: keeping them out of the y-domain is
   * the point, because a band several times wider than the window would flatten
   * every line inside it. Clipped to the plot, labelled at the right edge.
   */
  zones?: ChartZone[]
  /**
   * Opt-in second scale (see SecondaryScale). Without it the chart is one-scale
   * and draws exactly as it always has.
   */
  secondary?: SecondaryScale
  /** Mark the newest point of each drawn line, so "where it stands now" is visible without hovering. */
  markLast?: boolean
  /**
   * Events flagged on the same time axis (the AreaChart's markers — liquidations on
   * a health-factor line). Drawn only on a time axis, inside the plot's gutters.
   */
  markers?: ChartMarker[]
  /**
   * Opt-in (see FloorZone): extend the plot below the axis floor by a tinted strip
   * and put the markers in it instead of as flags over the lines. The axis is then
   * floored at exactly 0.
   */
  floorZone?: FloorZone
  /**
   * Opt-in: no date labels under the plot (and no gutter for them) — the hovered
   * point's date is in the tooltip, as on the value chart.
   */
  hideDates?: boolean
  /** Query-param name persisting the zoom window (back-navigable, shareable). */
  zoomKey?: string
  /** Refetch-on-zoom: a finer grid for base-index window [lo, hi]. */
  refine?: (fromSec: number, toSec: number, points: number) => Promise<RefinedGrid | null>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [markOpen, setMarkOpen] = useState(false)
  // Only the floor-zone label's collision estimate reads these (px → viewBox units).
  const narrowView = useMediaQuery('(max-width: 720px)')
  const coarse = useMediaQuery('(hover: none)')
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const H = h
  const W = LINE_W, padL = LINE_PAD_L, padR = LINE_PAD_R, padT = 12, padB = hideDates ? 4 : 18
  const plotW = W - padL - padR
  // Absolute-time window: the hook needs only the buckets' instants.
  const bucketTimes = useMemo(() => bucketSecs(buckets), [buckets])
  // Gesture zoom (chartZoom.tsx): plot fractions exclude the y-axis gutter. The
  // y-axis already fits the data, so a zoomed window re-fits vertically too.
  const zoom = useChartZoom(
    bucketTimes,
    e => {
      const r = (wrapRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect()
      if (!r.width) return 0
      return Math.min(1, Math.max(0, (((e.clientX - r.left) / r.width) * W - padL) / plotW))
    },
    () => setHover(null),
    zoomKey,
  )
  // A refined grid replaces the coarse slice wholesale: buckets and every band
  // come from one fetch, so they cannot end up drawn on different grids.
  const refined = useZoomRefineValue(zoom, refine, 180, acceptGrid)
  const rawBuckets = refined?.buckets ?? (zoom.zoomed ? buckets.slice(zoom.lo, zoom.hi + 1) : buckets)
  const rawSeries = refined?.series ?? (zoom.zoomed ? series.map(s => ({ ...s, values: s.values.slice(zoom.lo, zoom.hi + 1) })) : series)
  // Clip to the window: a bucket outside it maps past this chart's axis gutter and
  // draws to the container edge, and a coarse slice with a couple of interior
  // points would cover part of the width until the refined grid arrives.
  const clip = zoom.zoomed ? bracketToView(bucketSecs(rawBuckets), zoom.view, rawSeries.map(s => s.values)) : null
  const useClip = clip != null && clip.times.length >= 2
  const vBuckets = useClip ? clip.times.map(utcStamp) : rawBuckets
  const vSeries = useClip ? rawSeries.map((s, i) => ({ ...s, values: clip.series[i] })) : rawSeries
  const n = vBuckets.length
  const flat = vSeries.flatMap(s => s.values).filter((v): v is number => v != null)
  if (n < 2 || !flat.length) {
    return (
      <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12, position: 'relative' }}>
        Not enough history.
        {zoom.zoomed && <ZoomReset onReset={zoom.reset} />}
      </div>
    )
  }
  // With a second scale its series leave the axis domain; each scale fits its own.
  const onSecondary = (key: string) => !!secondary && secondary.keys.includes(key)
  const leftFlat = secondary ? vSeries.filter(s => !onSecondary(s.key)).flatMap(s => s.values).filter((v): v is number => v != null) : flat
  const secFlat = secondary ? vSeries.filter(s => onSecondary(s.key)).flatMap(s => s.values).filter((v): v is number => v != null) : []
  const domainFlat = leftFlat.length ? leftFlat : [0, 1]
  const lo = Math.min(...domainFlat), hi = Math.max(...domainFlat)
  const pad = Math.max((hi - lo) * 0.08, hi * 0.0005)
  const min = floorZone ? 0 : floorZero ? Math.max(0, lo - pad) : lo - pad, max = hi + pad
  // A floor zone is carved out of the bottom of the plot: the axis maps onto the
  // rest, and `floorY` is its floor line.
  const zoneH = floorZone ? (H - padT - padB) * floorZone.frac / (1 + floorZone.frac) : 0
  const plotH = H - padT - padB - zoneH
  const floorY = padT + plotH
  let rMin = 0, rMax = 1
  if (secondary && secFlat.length) {
    const rLo = Math.min(...secFlat), rHi = Math.max(...secFlat)
    const rPad = Math.max((rHi - rLo) * 0.08, Math.abs(rHi) * 0.0005)
    rMin = secondary.anchor ?? rLo - rPad
    const top = secondary.anchor != null && rHi <= secondary.anchor ? (secondary.max ?? secondary.anchor + 1) : rHi + rPad
    rMax = secondary.max != null ? Math.min(secondary.max, top) : top
    if (!(rMax > rMin)) rMax = rMin + 1
  }
  // Positions come from the view's TIME domain, the same one the zoom window and
  // its selection shade use — index spacing would put the line and the shade on
  // different axes, which is the mismatch this whole model exists to remove. It
  // falls back to index spacing when the buckets are not a usable time axis.
  const vTimes = bucketSecs(vBuckets)
  const viewSpan = zoom.view.to - zoom.view.from
  const timeAxis = viewSpan > 0 && vTimes.length === n && vTimes.every(Number.isFinite)
  // The drawn points' own spacing bounds how precisely a label may name them.
  const grainSec = timeAxis ? seriesGrainSec(vTimes) : 0
  // Clamped into the plot: the slice deliberately keeps the point on each side of
  // the window so the line reaches both edges, and this chart's plot is inset by a
  // y-axis gutter — unclamped, those points draw over the axis and out to the
  // container edge. Only the DRAWN x is clamped; the tooltip still names the
  // point's real time, and for a forward-filled series the bracketing value is
  // the correct value at the edge anyway.
  const xf = (i: number) => Math.min(1, Math.max(0, timeAxis ? (vTimes[i] - zoom.view.from) / viewSpan : n > 1 ? i / (n - 1) : 0))
  const sx = (i: number) => padL + xf(i) * plotW
  const sy = (v: number) => padT + (1 - (v - min) / ((max - min) || 1)) * plotH
  // Below its anchor a second-scale value continues into the floor zone, clamped
  // at the zone's floor so a very low value cannot stretch it.
  const syR = (v: number) => Math.min(floorY + zoneH, padT + (1 - (v - rMin) / (rMax - rMin)) * plotH)
  const syOf = (key: string) => (onSecondary(key) ? syR : sy)
  const fmtOf = (key: string) => (secondary && onSecondary(key) ? secondary.fmt : yFmt)
  // The band's bounds are ordinary series, so they slice, clip and refine with
  // everything else; only their DRAWING is joined here. Filled per contiguous
  // run where both bounds exist — a gap in either leaves the envelope open
  // rather than closing it across missing weeks.
  const bLo = band ? vSeries.find(s => s.key === band.lo) : undefined
  const bHi = band ? vSeries.find(s => s.key === band.hi) : undefined
  const bandKeys = bLo && bHi ? [bLo.key, bHi.key] : []
  const bandAreas = bLo && bHi
    ? lineRuns(bHi.values.map((v, i) => (v != null && bLo.values[i] != null ? v : null)))
      .filter(([a, b]) => b > a)
      .map(([a, b]) => {
        const up = []
        const down = []
        for (let i = a; i <= b; i++) {
          up.push(`${i === a ? 'M' : 'L'} ${sx(i).toFixed(1)} ${sy(bHi.values[i]!).toFixed(1)}`)
          down.push(`L ${sx(b - (i - a)).toFixed(1)} ${sy(bLo.values[b - (i - a)]!).toFixed(1)}`)
        }
        return `${up.join(' ')} ${down.join(' ')} Z`
      })
    : []
  // Back/forward can change the window without a gesture; a stale hover index
  // past the new slice must not address it.
  if (hover != null && hover > n - 1) setHover(null)
  function onMove(e: React.PointerEvent) {
    if (zoom.selecting || zoom.pinching) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!r.width) return
    const x = ((e.clientX - r.left) / r.width) * W
    const f = (x - padL) / plotW
    let i = Math.round(f * (n - 1))
    if (timeAxis) {
      // Nearest point along the same time axis the line is drawn on.
      let best = 0
      for (let k = 1; k < n; k++) if (Math.abs(xf(k) - f) < Math.abs(xf(best) - f)) best = k
      i = best
    }
    setHover(Math.min(n - 1, Math.max(0, i)))
  }
  // The floor zone's label, right-aligned inside it, stepped left past whatever
  // sits there: a marker cap (drawn above the svg) or a newest-point dot inside
  // the zone. The unit sizes are estimates — the svg scales with its card, ~0.75
  // units per px on a desktop card and ~2.4 on a phone.
  let zoneLabel: { right: number } | null = null
  if (floorZone?.label) {
    const unitsPerPx = narrowView ? 2.4 : 0.75
    const textW = floorZone.label.length * (narrowView ? 11 : 6.2)
    const obstacles: { x: number; half: number }[] = []
    if (markers && timeAxis) {
      for (const m of markers) {
        const f = (utcSeconds(m.ts) - zoom.view.from) / viewSpan
        if (f >= -0.01 && f <= 1.01) obstacles.push({ x: padL + Math.min(1, Math.max(0, f)) * plotW, half: (coarse ? 10 : 6) * unitsPerPx + 4 })
      }
    }
    if (markLast) {
      for (const s of vSeries) {
        if (bandKeys.includes(s.key) || s.dashed) continue
        for (let i = s.values.length - 1; i >= 0; i--) {
          if (s.values[i] == null) continue
          if (syOf(s.key)(s.values[i]!) > floorY) obstacles.push({ x: sx(i), half: 3.5 * 2 + 4 })
          break
        }
      }
    }
    let right = W - padR - 8
    for (let k = 0; k <= obstacles.length; k++) {
      const hit = obstacles.filter(o => o.x + o.half > right - textW && o.x - o.half < right)
      if (!hit.length) break
      right = Math.min(...hit.map(o => o.x - o.half)) - 2
    }
    if (right - textW > padL + 4) zoneLabel = { right }
  }
  const selPct = (f: number) => (padL + Math.min(1, Math.max(0, f)) * plotW) / W * 100
  return (
    <div ref={wrapRef} className="hdx-chart-wrap apx-wrap" data-zoom-key={zoomKey}
      onPointerDown={e => { zoom.onPointerDown(e); onMove(e) }}
      onPointerMove={e => { zoom.onPointerMove(e); onMove(e) }}
      onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerCancel} onDoubleClick={zoom.onDoubleClick}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${H}`}>
        {[0, 0.5, 1].map(t => {
          const v = min + (max - min) * t
          return (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={sy(v).toFixed(1)} y2={sy(v).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
              <text className="hdx-ax" x={padL - 8} y={(sy(v) + 3).toFixed(1)} textAnchor="end">{yFmt(v)}</text>
            </g>
          )
        })}
        {(zones ?? []).map((z, i) => {
          const span = zoneSpan(z, min, max)
          if (!span) return null
          const y0 = padT + span.top * plotH, y1 = padT + span.bottom * plotH
          const colour = z.color ?? 'var(--text-low)'
          return (
            <g key={`zone${i}`}>
              {!span.covers && <rect x={padL} y={y0.toFixed(1)} width={plotW} height={Math.max(1, y1 - y0).toFixed(1)} fill={colour} fillOpacity={0.12} />}
              {span.hiInside && <line x1={padL} x2={W - padR} y1={y0.toFixed(1)} y2={y0.toFixed(1)} stroke={colour} strokeOpacity={0.65} strokeDasharray="4 3" />}
              {span.loInside && <line x1={padL} x2={W - padR} y1={y1.toFixed(1)} y2={y1.toFixed(1)} stroke={colour} strokeOpacity={0.65} strokeDasharray="4 3" />}
              {/* Labelled only where an edge is visible: a zone filling the plot is
                  named by the legend, and its label would float in open space. */}
              {z.label && (span.hiInside || span.loInside) && (
                <text className="hdx-ax" x={W - padR - 4} y={(span.hiInside ? y0 + 11 : y1 - 5).toFixed(1)} textAnchor="end" style={{ fill: colour }}>{z.label}</text>
              )}
            </g>
          )
        })}
        {floorZone && <rect className="mlc-floor-zone" x={padL} y={floorY.toFixed(1)} width={plotW} height={zoneH.toFixed(1)} fill={floorZone.color} fillOpacity={0.1} />}
        {bandAreas.map((d, i) => <path key={`band${i}`} d={d} fill={bHi!.color} fillOpacity={0.2} />)}
        {!secondary && min < 1 && max > 1 && <line x1={padL} x2={W - padR} y1={sy(1).toFixed(1)} y2={sy(1).toFixed(1)} stroke="var(--text-low)" strokeDasharray="3 4" strokeOpacity="0.6" />}
        {vSeries.map(s => {
          // A band bound is the edge of a filled range, so it wears a hairline
          // instead of the full 2px a standalone line gets.
          const edge = bandKeys.includes(s.key)
          // A second-scale line is thinner, so it reads as the ratio beside the amounts.
          const ry = onSecondary(s.key)
          const y = syOf(s.key)
          return (
            <g key={s.key} strokeOpacity={edge ? 0.5 : s.dashed ? 0.7 : 1} data-series={s.key}>
              {lineRuns(s.values).map(([a, b]) => a === b
                ? <circle key={a} cx={sx(a).toFixed(1)} cy={y(s.values[a]!).toFixed(1)} r="2.5" fill={s.color} fillOpacity={edge ? 0.5 : s.dashed ? 0.7 : 1} />
                : <path key={a} d={s.values.slice(a, b + 1).map((v, j) => `${j ? 'L' : 'M'} ${sx(a + j).toFixed(1)} ${y(v!).toFixed(1)}`).join(' ')}
                    fill="none" stroke={s.color} strokeWidth={edge ? 1 : s.dashed || ry ? 1.5 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
            </g>
          )
        })}
        {markLast && vSeries.filter(s => !bandKeys.includes(s.key) && !s.dashed).map(s => {
          // The newest drawn point, so "where it stands now" needs no hover.
          for (let i = s.values.length - 1; i >= 0; i--) {
            if (s.values[i] == null) continue
            return <circle key={`last${s.key}`} cx={sx(i).toFixed(1)} cy={syOf(s.key)(s.values[i]!).toFixed(1)} r="3.5" fill={s.color} stroke="var(--bg-elev)" strokeWidth="1.5" />
          }
          return null
        })}
        {!hideDates && dateTicks(n).map(i => (
          <text key={i} className="hdx-ax" x={sx(i).toFixed(1)} y={H - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{axisTick(vBuckets[i], timeAxis ? viewSpan : 0, grainSec)}</text>
        ))}
        {hover != null && !zoom.selecting && <line x1={sx(hover).toFixed(1)} x2={sx(hover).toFixed(1)} y1={padT} y2={H - padB} stroke="var(--text-medium)" strokeOpacity="0.55" />}
        {zoneLabel && <text className="hdx-ax mlc-floor-label" x={zoneLabel.right.toFixed(1)} y={(floorY + zoneH / 2).toFixed(1)} textAnchor="end" dominantBaseline="central" style={{ fill: floorZone!.color }}>{floorZone!.label}</text>}
      </svg>
      {markers && markers.length > 0 && timeAxis && (
        <ChartMarkerLayer key={`${zoom.view.from}:${viewSpan}`} markers={markers} t0={zoom.view.from * 1000} span={viewSpan * 1000}
          className={floorZone ? 'lane' : undefined}
          style={{
            left: `${(padL / W * 100).toFixed(3)}%`, right: `${(padR / W * 100).toFixed(3)}%`,
            // In the floor zone: from the axis floor line down to the plot's bottom.
            ...(floorZone ? { top: `${(floorY / H * 100).toFixed(3)}%`, bottom: `${(padB / H * 100).toFixed(3)}%` } : {}),
          }} onOpenChange={setMarkOpen} />
      )}
      {hover != null && !zoom.selecting && !markOpen && (
        <ChartTip className="hdx-tip" xPct={sx(hover) / W * 100} top={2}>
          <span className="t-d">{tipDate(vBuckets[hover], grainSec)}</span>
          {vSeries.filter(s => !bandKeys.includes(s.key)).map(s => s.values[hover] != null && (
            <span key={s.key} className="t-row"><i style={{ background: s.color }} />{s.label} <span className="tv">{fmtOf(s.key)(s.values[hover]!)}</span></span>
          ))}
          {/* One row for the pair: a range is read as an interval, not as two numbers. */}
          {bLo && bHi && bLo.values[hover] != null && bHi.values[hover] != null && (
            <span className="t-row"><i style={{ background: bHi.color, opacity: 0.5 }} />{band!.label}
              <span className="tv">{yFmt(bLo.values[hover]!)} – {yFmt(bHi.values[hover]!)}</span></span>
          )}
        </ChartTip>
      )}
      {zoom.preview && (() => {
        // The shade IS the window a lift commits, on the view's time domain, so
        // it tracks the cursor instead of stepping between buckets.
        const pw = zoom.preview
        return <ZoomSelection aPct={selPct(fracOfTime(zoom.view, pw.from))} bPct={selPct(fracOfTime(zoom.view, pw.to))}
          label={`${utcDay(pw.from)} – ${utcDay(pw.to)}`} />
      })()}
      {zoom.zoomed && !zoom.sel && <ZoomReset onReset={zoom.reset} />}
    </div>
  )
}

/* ============ GIGAHDX liquidation levels ============ */
export interface GigaLiqPoint { price: number; stHdx: number }

// How much stHDX collateral crosses HF = 1 at each HDX price level. Bars are
// per-price-bucket amounts; the tooltip adds the cumulative reading ("if HDX
// falls to $X, everything at higher levels has already liquidated"). Positions
// already under water clamp into the bucket nearest the current price.
// HDX trades far below a cent, so a liquidation level needs six decimals to say
// anything. Shared with the caption beside the chart, which quotes the same
// prices and must not round them differently.
export const fmtLiqPrice = (v: number) => '$' + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))

export function GigaLiquidationChart({ currentPrice, points, h = 190 }: { currentPrice: number; points: GigaLiqPoint[]; h?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  const W = 860, padL = 46, padR = 14, padT = 10, padB = 24
  const BUCKETS = 28
  const plotW = W - padL - padR, plotH = h - padT - padB
  const minP = Math.min(...points.map(p => p.price), currentPrice) * 0.95
  const span = Math.max(currentPrice - minP, currentPrice * 0.01)
  const bucketOf = (price: number) => Math.min(BUCKETS - 1, Math.max(0, Math.floor((Math.min(price, currentPrice * 0.9999) - minP) / span * BUCKETS)))
  const sums = Array.from({ length: BUCKETS }, () => 0)
  for (const pt of points) sums[bucketOf(pt.price)] += pt.stHdx
  // cumulative from the right: falling TO a level liquidates every level above it
  const cum = [...sums]
  for (let i = BUCKETS - 2; i >= 0; i--) cum[i] += cum[i + 1]
  const totalAtRisk = cum[0]
  const max = Math.max(...sums, 1)
  const bw = plotW / BUCKETS
  const x = (i: number) => padL + i * bw
  const y = (v: number) => padT + (1 - v / max) * plotH
  const priceAt = (i: number) => minP + i / BUCKETS * span
  const fmt = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0)
  const fmtP = fmtLiqPrice
  const dropPct = (price: number) => `−${Math.max(0, (1 - price / currentPrice) * 100).toFixed(0)}%`
  // x ticks at −75 / −50 / −25% of spot, when inside the domain
  const ticks = [0.75, 0.5, 0.25].map(d => currentPrice * (1 - d)).filter(p => p > minP)
  return (
    <div ref={wrapRef} className="hdx-chart-wrap giga-liq-chart" onMouseLeave={() => setHover(null)}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {[1, 0.5].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(max * t).toFixed(1)} y2={y(max * t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={padL - 8} y={(y(max * t) + 3).toFixed(1)} textAnchor="end">{fmt(max * t)}</text>
          </g>
        ))}
        {ticks.map(p => {
          const tx = padL + (p - minP) / span * plotW
          return (
            <g key={p}>
              <line x1={tx.toFixed(1)} x2={tx.toFixed(1)} y1={padT} y2={h - padB} stroke="var(--separator)" strokeWidth="1" strokeDasharray="2 5" />
              <text className="hdx-ax" x={tx.toFixed(1)} y={h - 8} textAnchor="middle">{dropPct(p)}</text>
            </g>
          )
        })}
        {sums.map((v, i) => v > 0 && (
          <rect key={i} className="liq-bar" x={(x(i) + 1).toFixed(1)} y={y(v).toFixed(1)} width={Math.max(0.75, bw - 2).toFixed(1)}
            height={Math.max(1, plotH - (y(v) - padT)).toFixed(1)} rx="1.5" fill="var(--red)" opacity={hover == null || hover === i ? 0.85 : 0.4} />
        ))}
        {/* current price marker at the right edge */}
        <line x1={W - padR} x2={W - padR} y1={padT - 2} y2={h - padB} stroke="var(--text-medium)" strokeWidth="1" strokeDasharray="4 3" />
        <text className="hdx-ax liq-now-label" x={W - padR} y={h - 8} textAnchor="end">now {fmtP(currentPrice)}</text>
        {sums.map((_, i) => (
          <rect key={`h${i}`} className="liq-hit" x={x(i).toFixed(1)} y={padT} width={bw.toFixed(1)} height={plotH} fill="transparent"
            onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover != null && (
        <ChartTip className="hdx-tip" xPct={(padL + hover * bw + bw / 2) / W * 100} top={2}>
          <span className="t-d">if HDX falls to {fmtP(priceAt(hover))} ({dropPct(priceAt(hover))})</span>
          <span className="t-row"><i style={{ background: 'var(--red)' }} />at this level<span className="tv">{fmt(sums[hover])} GIGAHDX</span></span>
          <span className="t-row">cumulative<span className="tv">{fmt(cum[hover])} GIGAHDX ({totalAtRisk > 0 ? (cum[hover] / totalAtRisk * 100).toFixed(0) : 0}% of at-risk)</span></span>
        </ChartTip>
      )}
    </div>
  )
}

/* ============ zoomable time bars (shared by the bar charts) ============ */
// A bar chart on a time axis zooms like the line and area charts: the window is
// absolute time (chartZoom.tsx), and a zoom can refetch the window at a finer
// grain. A bar is drawn as a SLOT on that axis: `slot` wide, centred on its
// bucket's instant, with the axis inset by half a slot at each end so the first
// and last bars sit inside the plot. Unzoomed on an evenly stepped series this is
// exactly the old index layout (n equal slots filling the width); zoomed, it puts
// bars and the selection shade on one time domain.

/**
 * Bar geometry for `times` (ascending unix seconds) across `view`: the slot width
 * and each bar's left edge, in plot units from the plot's left edge. `grainSec`
 * falls back to `fallbackGrainSec` when fewer than two bars are drawn. Without a
 * usable time domain the bars fill the width by index.
 */
export function barFrame(times: number[], view: TimeWindow, plotW: number, fallbackGrainSec = 0): { slot: number; left: (i: number) => number } {
  const n = times.length
  const span = view.to - view.from
  const grain = seriesGrainSec(times) || fallbackGrainSec
  if (!(span > 0) || !(grain > 0) || !times.every(Number.isFinite)) {
    const slot = n ? plotW / n : plotW
    return { slot, left: i => i * slot }
  }
  const slot = Math.min(plotW, (grain * plotW) / (span + grain))
  // A bucket that opens before the view but overlaps it (a zoom narrower than
  // one coarse bar) is pinned to the plot edge rather than drawn off-canvas.
  return { slot, left: i => Math.min(plotW - slot, Math.max(0, ((times[i] - view.from) / span) * (plotW - slot))) }
}

/** The plot fraction of the view a pointer x (plot units) addresses, on barFrame's inset axis. */
export function barFrac(x: number, slot: number, plotW: number): number {
  const inner = plotW - slot
  return inner > 0 ? Math.min(1, Math.max(0, (x - slot / 2) / inner)) : 0
}

/**
 * Zoom state for a bar chart whose bars are keyed by bucket keys. Returns the
 * zoom api (inert unless the keys are a time axis and the chart opted in) and the
 * refined payload once a window refetch has been accepted. `slotRef` carries the
 * drawn slot width into the pointer→fraction mapping.
 */
function useBarZoom<T>(opts: {
  keys: string[]
  enabled: boolean
  zoomKey?: string
  refine?: (fromSec: number, toSec: number, points: number) => Promise<T | null>
  accept: (value: T, span: number) => boolean
  wrapRef: RefObject<HTMLDivElement | null>
  W: number
  padL: number
  plotW: number
  onWindowChange: () => void
}) {
  const { keys, enabled, zoomKey, refine, accept, wrapRef, W, padL, plotW, onWindowChange } = opts
  const times = useMemo(() => keys.map(utcSeconds), [keys])
  const timeAxis = enabled && times.length > 1 && times.every(Number.isFinite)
  const slotRef = useRef(0)
  const zoom = useChartZoom(
    timeAxis ? times : [],
    e => {
      const r = (wrapRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect()
      if (!r.width) return 0
      return barFrac(((e.clientX - r.left) / r.width) * W - padL, slotRef.current, plotW)
    },
    onWindowChange,
    timeAxis ? zoomKey : undefined,
  )
  const refined = useZoomRefineValue(zoom, timeAxis ? refine : undefined, 180, accept)
  return { zoom, timeAxis, times, refined, slotRef, baseGrain: seriesGrainSec(times) }
}

/**
 * Keep the items whose bucket overlaps the view: a bucket keyed by its start
 * covers [t, t + grain), so a window narrower than one bar still shows the bar
 * it falls in (like bracketToView for the line charts) instead of "No data"
 * until a refetch lands. Without a grain, the instant must lie inside.
 */
export function overlapView<T>(items: T[], keyOf: (x: T) => string, view: TimeWindow, grainSec: number): T[] {
  return items.filter(x => {
    const t = utcSeconds(keyOf(x))
    return grainSec > 0 ? t <= view.to && t + grainSec > view.from : t >= view.from && t <= view.to
  })
}

/* ============ mirrored bar chart (buys/sells, new/exited) ============ */
export interface MirrorBar { key: string; up: number; down: number; tip: ReactNode }

// Height cap for a daily/weekly activity series. A cap is a trade: every bar
// above it clamps to full height (its magnitude is lost, break mark + tooltip
// value), and every bar below it grows. So pick the cap that maximises
// `readable − clamped`, where a bar is readable when it lands in
// [cap · minVisibleRatio, cap]; ties go to the taller cap, so nothing is clamped
// without a strict gain. Candidates are the values themselves — a cap between
// two values clamps the same bars as the lower one while making every bar
// shorter, so it can never win.
//
// `stackedColumnMax` (the unlock-schedule rule) cuts instead at the widest ratio
// gap inside the top third of the values, which assumes everything above the gap
// is a small outlier cluster. Daily activity breaks that assumption: HOLLAR HSM
// trades span 0.02 → 500k HOLLAR over 60 days, and the widest gap sits between
// the real trading days (≥5k) and sub-HOLLAR rounding dust (≤430), so it capped
// at ~516 and flattened all ten meaningful days to identical full-height bars.
// This objective picks 94.5k there — one clamped spike, the rest legible — and
// on live data it is window-invariant, i.e. the phone view (last 30 bars) and
// the desktop view (60 bars) agree, which the gap rule did not.
//
// minVisibleRatio 1/16 ≈ 5px of the ~87px half-plot at the default h=190: the
// shortest bar still comparable by eye. The choice is not knife-edge — every
// ratio from ~1/14 to 1/32 picks the same cap on all four live series.
export function readableBarMax(values: number[], minVisibleRatio = 1 / 16): number {
  const asc = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const n = asc.length
  if (!n) return 1
  let best = asc[n - 1]
  let bestScore = -Infinity
  let lo = 0
  for (let i = 0; i < n; i++) {
    if (i + 1 < n && asc[i + 1] === asc[i]) continue // score a run of equal values once, at its top
    const cap = asc[i]
    while (asc[lo] < cap * minVisibleRatio) lo++ // monotone in cap, so this scans once overall
    const score = (i - lo + 1) - (n - 1 - i)
    if (score >= bestScore) { bestScore = score; best = cap }
  }
  return best * 1.05
}

const acceptBars = (bars: MirrorBar[], span: number) => bars.length > span

// Positive series above the zero line, negative below, 2px gaps between bars,
// zero axis line, per-bar hover tooltip. Optional sparse x tick labels.
//
// `zoomKey`/`refine` make it zoomable (bar keys must then be bucket keys): drag
// or pinch a window, and `refine` can hand back that window's bars at a finer
// grain — the page builds them, tooltips included, from the same mapping as the
// coarse bars. Zoomed, the ticks follow the drawn window instead of `xTicks`.
export function MirroredBarChart({ data, h = 190, xTicks, upColor = 'var(--green)', downColor = 'var(--red)', zoomKey, refine }: {
  data: MirrorBar[]; h?: number; xTicks?: { i: number; label: string }[]; upColor?: string; downColor?: string
  /** Query-param name persisting the zoom window (back-navigable, shareable). */
  zoomKey?: string
  /** Refetch-on-zoom: the window's bars at a finer grain. */
  refine?: (fromSec: number, toSec: number, points: number) => Promise<MirrorBar[] | null>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  // Same phone treatment as DayBarChart: keep the most recent 30 bars so each
  // stays wide enough to tap-inspect; ticks shift with the dropped prefix. The
  // zoom works inside what the phone shows.
  const narrow = useMediaQuery('(max-width: 720px)')
  const cut = narrow && data.length > 30 ? data.length - 30 : 0
  const base = cut ? data.slice(cut) : data
  const baseTicks = cut ? xTicks?.filter(t => t.i >= cut).map(t => ({ ...t, i: t.i - cut })) : xTicks
  const W = 860, padX = 2, padT = 8
  const plotW = W - 2 * padX
  const baseKeys = useMemo(() => base.map(d => d.key), [base])
  const { zoom, timeAxis, refined, slotRef, baseGrain } = useBarZoom({
    keys: baseKeys, enabled: zoomKey != null || refine != null, zoomKey, refine, accept: acceptBars,
    wrapRef, W, padL: padX, plotW, onWindowChange: () => setHover(null),
  })
  const shown = refined ?? base
  const bars = zoom.zoomed ? overlapView(shown, d => d.key, zoom.view, seriesGrainSec(shown.map(d => utcSeconds(d.key))) || baseGrain) : base
  const n = bars.length
  const times = timeAxis ? bars.map(d => utcSeconds(d.key)) : []
  // Without a time axis the bars fill the width by index: n slots of plotW / n.
  const frame = timeAxis ? barFrame(times, zoom.view, plotW, baseGrain) : barFrame(bars.map(() => Number.NaN), { from: 0, to: 0 }, plotW)
  // The pointer mapping reads the drawn slot at event time.
  useEffect(() => { slotRef.current = frame.slot })
  const viewSpan = zoom.view.to - zoom.view.from
  const grainSec = timeAxis ? (seriesGrainSec(times) || baseGrain) : 0
  const ticks = zoom.zoomed
    ? dateTicks(n).map(i => ({ i, label: axisTick(bars[i].key, viewSpan, grainSec) }))
    : baseTicks
  const padB = ticks?.length ? 18 : 8
  if (hover != null && hover > n - 1) setHover(null)
  if (!n) {
    return (
      <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, padding: '12px 0', position: 'relative' }}>
        {zoom.zoomed ? 'Nothing in this range' : 'Nothing to show yet'}
        {zoom.zoomed && <ZoomReset onReset={zoom.reset} />}
      </div>
    )
  }
  const half = (h - padT - padB) / 2
  const zeroY = padT + half
  // Cap the axis where the most bars stay readable (see readableBarMax) so
  // neither a single huge day nor a long low-volume tail flattens the rest. Bars
  // above the cap clamp to full height and carry a break mark; the exact value
  // stays in the hover tooltip.
  const max = readableBarMax(bars.flatMap(d => [d.up, d.down]))
  const bw = frame.slot
  const barW = Math.max(0.75, bw - 2)
  const barX = (i: number) => padX + (timeAxis ? frame.left(i) : i * bw)
  // A non-zero bar always leaves a mark, so "traded a little" still reads
  // differently from "no activity at all" once the cap is set by louder days.
  const minBarH = 1.5
  const selPct = (f: number) => (padX + bw / 2 + Math.min(1, Math.max(0, f)) * (plotW - bw)) / W * 100
  const zoomHandlers = timeAxis ? {
    onPointerDown: zoom.onPointerDown, onPointerMove: zoom.onPointerMove, onPointerUp: zoom.onPointerUp,
    onPointerCancel: zoom.onPointerCancel, onDoubleClick: zoom.onDoubleClick,
  } : {}
  return (
    <div ref={wrapRef} className={`hdx-chart-wrap${timeAxis ? ' apx-wrap' : ''}`} data-zoom-key={zoomKey} onMouseLeave={() => setHover(null)} {...zoomHandlers}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {bars.map((d, i) => {
          const x = barX(i)
          const uh = d.up > 0 ? Math.max(minBarH, Math.min(d.up, max) / max * (half - 2)) : 0
          const dh = d.down > 0 ? Math.max(minBarH, Math.min(d.down, max) / max * (half - 2)) : 0
          const upTop = zeroY - 1 - uh, downBot = zeroY + 1 + dh
          return (
            <g key={d.key} opacity={hover == null || hover === i ? 1 : 0.65}>
              {d.up > 0 && <rect x={x.toFixed(1)} y={upTop.toFixed(1)} width={barW.toFixed(1)} height={uh.toFixed(1)} fill={upColor} rx="1.5" />}
              {d.down > 0 && <rect x={x.toFixed(1)} y={(zeroY + 1).toFixed(1)} width={barW.toFixed(1)} height={dh.toFixed(1)} fill={downColor} rx="1.5" />}
              {d.up > max && <g stroke="var(--bg-elev)" strokeWidth="2.5">
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(upTop + 5).toFixed(1)} y2={(upTop + 2).toFixed(1)} />
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(upTop + 9).toFixed(1)} y2={(upTop + 6).toFixed(1)} />
              </g>}
              {d.down > max && <g stroke="var(--bg-elev)" strokeWidth="2.5">
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(downBot - 5).toFixed(1)} y2={(downBot - 2).toFixed(1)} />
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(downBot - 9).toFixed(1)} y2={(downBot - 6).toFixed(1)} />
              </g>}
              <rect x={x.toFixed(1)} y={padT} width={bw.toFixed(1)} height={h - padT - padB} fill="transparent" onMouseEnter={() => { if (!zoom.selecting) setHover(i) }} />
            </g>
          )
        })}
        <line x1={padX} x2={W - padX} y1={zeroY.toFixed(1)} y2={zeroY.toFixed(1)} stroke="var(--text-low)" strokeOpacity="0.6" strokeWidth="1" />
        {ticks?.map(t => {
          // Anchor edge ticks inward so the first/last labels aren't clipped.
          const cx = barX(t.i) + (bw - 2) / 2
          const anchor = cx < 30 ? 'start' : cx > W - 30 ? 'end' : 'middle'
          return <text key={t.i} className="hdx-ax" x={cx.toFixed(1)} y={h - 4} textAnchor={anchor}>{t.label}</text>
        })}
      </svg>
      {hover != null && bars[hover] && !zoom.selecting && (
        <ChartTip className="hdx-tip" xPct={(barX(hover) + bw / 2) / W * 100} top={2}>{bars[hover].tip}</ChartTip>
      )}
      {zoom.preview && (() => {
        const pw = zoom.preview
        return <ZoomSelection aPct={selPct(fracOfTime(zoom.view, pw.from))} bPct={selPct(fracOfTime(zoom.view, pw.to))}
          label={`${utcDay(pw.from)} – ${utcDay(pw.to)}`} />
      })()}
      {zoom.zoomed && !zoom.sel && <ZoomReset onReset={zoom.reset} />}
    </div>
  )
}

/* ============ stacked time bars (a stock split into parts, over time) ============ */
// The bar twin of StackedAreaChart: the same buckets/series model (and so the
// same RefinedGrid refine payload), drawn as one stacked column per bucket —
// for a stock whose parts are the point (supply by minter), where an area's
// interpolation between weeks would imply a path the data does not state. Bands
// stack bottom-up in the order given, 2px apart like StackedColumnChart; the
// tooltip names every band and, with `totalLabel`, the stack top.
// `bare` draws it like the AreaChart beside it (the volume charts): no axis
// labels, gridlines or date ticks, the plot stretched to the fixed `.apx-chart`
// height, a crosshair on the hovered bar, and a tooltip of date, bands and total
// without shares.
export function StackedBarChart({ buckets, series, h: hProp, yFmt = compactAmount, totalLabel, zoomKey, refine, bare, tipLabel, fill }: {
  buckets: string[]; series: AreaSeries[]; h?: number; yFmt?: (v: number) => string
  /** Adds a summed stack-top row under the bands in the tooltip, under this label. */
  totalLabel?: string
  /**
   * One ink for every bar: each is drawn whole, as its stack total, and the bands
   * appear only as the tooltip's rows (no swatches, since nothing on the plot
   * wears their colours). For a split worth reading on hover but not worth a
   * palette on the plot.
   */
  fill?: string
  /** No axes or gridlines, AreaChart's frame and crosshair (see above). */
  bare?: boolean
  /** The tooltip's date line for a bucket at the drawn grain (default tipDate). */
  tipLabel?: (bucket: string, grainSec: number) => string
  /** Query-param name persisting the zoom window (back-navigable, shareable). */
  zoomKey?: string
  /** Refetch-on-zoom: a finer grid for the window. */
  refine?: (fromSec: number, toSec: number, points: number) => Promise<RefinedGrid | null>
}) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useClearOnOutsidePointer(() => setHover(null), hover != null)
  // Bare: AreaChart's frame (190-unit viewBox, 14 above and below the plot, no label gutter).
  const h = hProp ?? (bare ? 190 : 200)
  const W = AREA_W, padL = bare ? 0 : AREA_PAD_L, padR = bare ? 0 : AREA_PAD_R, padT = bare ? 14 : 12, padB = bare ? 14 : 18
  const plotW = W - padL - padR
  const { zoom, timeAxis, refined, slotRef, baseGrain } = useBarZoom({
    keys: buckets, enabled: true, zoomKey, refine, accept: acceptGrid,
    wrapRef, W, padL, plotW, onWindowChange: () => setHover(null),
  })
  const src = refined ?? { buckets, series }
  const srcGrain = seriesGrainSec(src.buckets.map(utcSeconds)) || baseGrain
  const keep = zoom.zoomed
    ? overlapView(src.buckets.map((b, i) => ({ b, i })), x => x.b, zoom.view, srcGrain).map(x => x.i)
    : src.buckets.map((_, i) => i)
  const vBuckets = keep.map(i => src.buckets[i])
  const vSeries = src.series.map(s => ({ ...s, values: keep.map(i => s.values[i] ?? null) }))
  const n = vBuckets.length
  const { tops, max: rawMax } = stackSeries(vSeries)
  const times = timeAxis ? vBuckets.map(utcSeconds) : []
  // Without a time axis the bars fill the width by index: n slots of plotW / n.
  const frame = timeAxis ? barFrame(times, zoom.view, plotW, baseGrain) : barFrame(vBuckets.map(() => Number.NaN), { from: 0, to: 0 }, plotW)
  // The pointer mapping reads the drawn slot at event time.
  useEffect(() => { slotRef.current = frame.slot })
  if (hover != null && hover > n - 1) setHover(null)
  if (!n || !vSeries.length || !(rawMax > 0)) {
    return (
      <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12, position: 'relative' }}>
        Not enough history.
        {zoom.zoomed && <ZoomReset onReset={zoom.reset} />}
      </div>
    )
  }
  const viewSpan = zoom.view.to - zoom.view.from
  const grainSec = timeAxis ? (seriesGrainSec(times) || baseGrain) : 0
  const max = niceAxisMax(rawMax)
  const plotH = h - padT - padB
  const sy = (v: number) => padT + (1 - v / max) * plotH
  const bw = frame.slot
  const gap = bw > 4 ? 2 : bw > 2 ? 1 : 0
  const barW = Math.max(0.75, bw - gap)
  const barX = (i: number) => padL + (timeAxis ? frame.left(i) : i * bw)
  const selPct = (f: number) => (padL + bw / 2 + Math.min(1, Math.max(0, f)) * (plotW - bw)) / W * 100
  function onMove(e: React.PointerEvent) {
    if (zoom.selecting || zoom.pinching) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!r.width) return
    const x = ((e.clientX - r.left) / r.width) * W
    let best = 0
    for (let k = 1; k < n; k++) if (Math.abs(barX(k) + bw / 2 - x) < Math.abs(barX(best) + bw / 2 - x)) best = k
    setHover(best)
  }
  const hoverTotal = hover != null ? vSeries.reduce((s, x) => s + (x.values[hover] ?? 0), 0) : 0
  return (
    <div ref={wrapRef} className="hdx-chart-wrap apx-wrap" data-zoom-key={zoomKey}
      onPointerDown={e => { zoom.onPointerDown(e); onMove(e) }}
      onPointerMove={e => { zoom.onPointerMove(e); onMove(e) }}
      onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerCancel} onDoubleClick={zoom.onDoubleClick}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
      <svg className={bare ? 'apx-chart' : 'day-chart'} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio={bare ? 'none' : undefined}>
        {!bare && [0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={sy(max * t).toFixed(1)} y2={sy(max * t).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={padL - 8} y={(sy(max * t) + 3).toFixed(1)} textAnchor="end">{yFmt(max * t)}</text>
          </g>
        ))}
        {vBuckets.map((b, i) => {
          const x = barX(i)
          return (
            <g key={b} opacity={hover == null || hover === i ? 1 : bare ? 0.55 : 0.7}>
              {fill != null ? (() => {
                const top = tops.length ? tops[tops.length - 1][i] : 0
                if (!(top > 0)) return null
                return <rect x={x.toFixed(1)} y={sy(top).toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.75, sy(0) - sy(top)).toFixed(1)} fill={fill} rx={bare ? undefined : '1.5'} />
              })() : vSeries.map((s, k) => {
                const v = s.values[i]
                if (v == null || !(v > 0)) return null
                const top = sy(tops[k][i])
                const bottom = sy(k === 0 ? 0 : tops[k - 1][i])
                const hPix = bottom - top
                // A band touching the one below leaves a sliver of card between them.
                const inset = k > 0 && hPix > 2 ? Math.min(1, hPix / 4) : 0
                // A stretched (bare) plot would turn the corner radius into an ellipse.
                return <rect key={s.key} x={x.toFixed(1)} y={top.toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.75, hPix - inset).toFixed(1)} fill={s.color} rx={bare ? undefined : '1.5'} />
              })}
            </g>
          )
        })}
        {!bare && dateTicks(n).map(i => (
          <text key={i} className="hdx-ax" x={(barX(i) + barW / 2).toFixed(1)} y={h - 4} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{axisTick(vBuckets[i], timeAxis ? viewSpan : 0, grainSec)}</text>
        ))}
      </svg>
      {bare && hover != null && !zoom.selecting && (
        <div className="apx-cross"><div className="apx-vline" style={{ left: `${(barX(hover) + barW / 2) / W * 100}%` }} /></div>
      )}
      {hover != null && !zoom.selecting && (
        <ChartTip className="hdx-tip" xPct={(barX(hover) + bw / 2) / W * 100} top={bare ? 4 : 2}>
          <span className="t-d">{(tipLabel ?? tipDate)(vBuckets[hover], grainSec)}</span>
          {/* Bare: a band absent from the hovered bar (0) has no row, like its absent rect. */}
          {vSeries.map(s => s.values[hover] != null && (!bare || s.values[hover]! > 0) && (
            <span key={s.key} className="t-row">{fill == null && <i style={{ background: s.color }} />}{s.label}
              <span className="tv">{yFmt(s.values[hover]!)}{!bare && hoverTotal > 0 && <span className="muted"> · {(s.values[hover]! / hoverTotal * 100).toFixed(1)}%</span>}</span>
            </span>
          ))}
          {totalLabel && vSeries.length > 1 && hoverTotal > 0 && (
            <span className="t-row t-total">{totalLabel}<span className="tv">{yFmt(hoverTotal)}</span></span>
          )}
        </ChartTip>
      )}
      {zoom.preview && (() => {
        const pw = zoom.preview
        return <ZoomSelection aPct={selPct(fracOfTime(zoom.view, pw.from))} bPct={selPct(fracOfTime(zoom.view, pw.to))}
          label={`${utcDay(pw.from)} – ${utcDay(pw.to)}`} />
      })()}
      {zoom.zoomed && !zoom.sel && <ZoomReset onReset={zoom.reset} />}
    </div>
  )
}
