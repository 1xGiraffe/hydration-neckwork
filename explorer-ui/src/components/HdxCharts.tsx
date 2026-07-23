/* eslint-disable react-refresh/only-export-components -- chart primitives + shared fmtHdx/color-token module (mirrors ui.tsx) */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { compactAmount } from './ui'
import { useMediaQuery } from '../hooks/useMediaQuery'

/* ============ formatting ============ */
// Compact HDX amount — the shared explorer-wide rough scale (1.56B · 797M ·
// 12.6k · 537 · 0.0₅7191), centralized in ui.tsx.
export function fmtHdx(v: number): string {
  return compactAmount(v)
}

// Compact form for on-bar clamp labels: whole millions once past ~10M, so the
// value labels on adjacent clamped columns keep clear space between them
// (147.94M → "148M"). Billions still collapse via fmtHdx (1.61B).
export function fmtHdxTick(v: number): string {
  return Math.abs(v) >= 1e7 ? fmtHdx(Math.round(v / 1e6) * 1e6) : fmtHdx(v)
}

/* ============ chart color system (CVD-validated — fixed, never cycled) ============ */
// Lock types: the SAME entity keeps the SAME hue on every chart, in fixed
// categorical order vote / staking / gigahdx / vesting / other. This is the
// single source of truth for lock colors across the /hdx dashboard AND the
// per-account balance breakdown bar — they must stay in parity.
export const LOCK_ORDER = ['vote', 'staking', 'gigahdx', 'vesting', 'other'] as const
const LOCK_COLORS: Record<string, string> = {
  vote: 'var(--lavender-deep)',
  staking: '#9c5cc4', // staking purple
  gigahdx: '#000000', // GIGAHDX brand black
  vesting: 'var(--red)',
  other: 'var(--text-low)',
}
export function lockColor(key: string): string { return LOCK_COLORS[key] ?? LOCK_COLORS.other }
// Cohorts: ordinal ramp, light→dark = Shrimp→Whale.
const COHORT_COLORS: Record<string, string> = {
  shrimp: '#b7d3f4',
  fish: '#7fb0ea',
  dolphin: '#3f88dd',
  whale: '#1d5fae',
}
export function cohortColor(key: string): string { return COHORT_COLORS[key] ?? 'var(--text-low)' }

/* ============ legend ============ */
// Small legend row: colored dot + label (GeistMono 11px, reuses .bal-legend).
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="bal-legend" style={{ margin: '0 0 10px' }}>
      {items.map(it => <span key={it.label}><i style={{ background: it.color }} />{it.label}</span>)}
    </div>
  )
}

// Clamp a tooltip's left % so a translateX(-50%) tip doesn't spill the card edge.
function tipLeft(pct: number): string { return `${Math.min(91, Math.max(9, pct))}%` }

/* ============ 100%-stacked horizontal share bar ============ */
export interface ShareSegment { key: string; label: string; color: string; value: number; tip: ReactNode }

// Rounded 8px outer ends via clipPath; 2px card-background gaps between segments
// (stroke with var(--bg-elev)); per-segment hover tooltip below the bar.
export function ShareBar({ segments, h = 44 }: { segments: ShareSegment[]; h?: number }) {
  const clipId = useId()
  const [hover, setHover] = useState<{ leftPct: number; tip: ReactNode } | null>(null)
  const segs = segments.filter(s => s.value > 0)
  const total = segs.reduce((s, x) => s + x.value, 0)
  if (!segs.length || total <= 0) return <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, padding: '12px 0' }}>No data.</div>
  const offsets: number[] = []
  for (let i = 0, run = 0; i < segs.length; i++) { offsets.push(run); run += segs[i].value }
  const rects = segs.map((s, i) => ({ ...s, x0: offsets[i] / total * 100, w: s.value / total * 100 }))
  return (
    <div className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
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
      {hover && <div className="hdx-tip" style={{ left: tipLeft(hover.leftPct), top: h + 8 }}>{hover.tip}</div>}
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
export function StackedColumnChart({ columns, h = 200, separatorAt, separatorCaption, yFmt = fmtHdx }: {
  columns: StackColumn[]; h?: number; separatorAt?: number; separatorCaption?: string; yFmt?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
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
    <div className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
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
        <div className="hdx-tip" style={{ left: tipLeft((colX(hover) + bw / 2) / W * 100), top: 2 }}>{columns[hover].tip}</div>
      )}
    </div>
  )
}


/* ============ GIGAHDX liquidation levels ============ */
export interface GigaLiqPoint { price: number; stHdx: number }

// How much stHDX collateral crosses HF = 1 at each HDX price level. Bars are
// per-price-bucket amounts; the tooltip adds the cumulative reading ("if HDX
// falls to $X, everything at higher levels has already liquidated"). Positions
// already under water clamp into the bucket nearest the current price.
export function GigaLiquidationChart({ currentPrice, points, h = 190 }: { currentPrice: number; points: GigaLiqPoint[]; h?: number }) {
  const [hover, setHover] = useState<number | null>(null)
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
  const fmtP = (v: number) => '$' + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))
  const dropPct = (price: number) => `−${Math.max(0, (1 - price / currentPrice) * 100).toFixed(0)}%`
  // x ticks at −75 / −50 / −25% of spot, when inside the domain
  const ticks = [0.75, 0.5, 0.25].map(d => currentPrice * (1 - d)).filter(p => p > minP)
  return (
    <div className="hdx-chart-wrap giga-liq-chart" onMouseLeave={() => setHover(null)}>
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
        <div className="hdx-tip" style={{ left: tipLeft((padL + hover * bw + bw / 2) / W * 100), top: 2 }}>
          <span className="t-d">if HDX falls to {fmtP(priceAt(hover))} ({dropPct(priceAt(hover))})</span>
          <span className="t-row"><i style={{ background: 'var(--red)' }} />at this level<span className="tv">{fmt(sums[hover])} GIGAHDX</span></span>
          <span className="t-row">cumulative<span className="tv">{fmt(cum[hover])} GIGAHDX ({totalAtRisk > 0 ? (cum[hover] / totalAtRisk * 100).toFixed(0) : 0}% of at-risk)</span></span>
        </div>
      )}
    </div>
  )
}

/* ============ mirrored bar chart (buys/sells, new/exited) ============ */
export interface MirrorBar { key: string; up: number; down: number; tip: ReactNode }

// Positive series above the zero line, negative below, 2px gaps between bars,
// zero axis line, per-bar hover tooltip. Optional sparse x tick labels.
export function MirroredBarChart({ data, h = 190, xTicks, upColor = 'var(--green)', downColor = 'var(--red)' }: {
  data: MirrorBar[]; h?: number; xTicks?: { i: number; label: string }[]; upColor?: string; downColor?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // Same phone treatment as DayBarChart: keep the most recent 30 bars so each
  // stays wide enough to tap-inspect; ticks shift with the dropped prefix.
  const narrow = useMediaQuery('(max-width: 720px)')
  const cut = narrow && data.length > 30 ? data.length - 30 : 0
  const bars = cut ? data.slice(cut) : data
  const ticks = cut ? xTicks?.filter(t => t.i >= cut).map(t => ({ ...t, i: t.i - cut })) : xTicks
  const W = 860, padX = 2, padT = 8
  const padB = ticks?.length ? 18 : 8
  const n = bars.length
  if (!n) return <div className="muted" style={{ fontFamily: 'GeistMono', fontSize: 12, padding: '12px 0' }}>No data.</div>
  const half = (h - padT - padB) / 2
  const zeroY = padT + half
  // Cap the axis at the outlier-aware max (same detection as the stacked chart)
  // so a single huge day doesn't flatten every other bar into invisibility. Bars
  // above the cap clamp to full height and carry a break mark; the exact value
  // stays in the hover tooltip.
  const max = stackedColumnMax(bars.flatMap(d => [d.up, d.down]))
  const bw = (W - 2 * padX) / n
  const barW = Math.max(0.75, bw - 2)
  return (
    <div className="hdx-chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`}>
        {bars.map((d, i) => {
          const x = padX + i * bw
          const uh = Math.min(d.up, max) / max * (half - 2), dh = Math.min(d.down, max) / max * (half - 2)
          const upTop = zeroY - 1 - uh, downBot = zeroY + 1 + dh
          return (
            <g key={d.key} opacity={hover == null || hover === i ? 1 : 0.65}>
              {d.up > 0 && <rect x={x.toFixed(1)} y={upTop.toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.75, uh).toFixed(1)} fill={upColor} rx="1.5" />}
              {d.down > 0 && <rect x={x.toFixed(1)} y={(zeroY + 1).toFixed(1)} width={barW.toFixed(1)} height={Math.max(0.75, dh).toFixed(1)} fill={downColor} rx="1.5" />}
              {d.up > max && <g stroke="var(--bg-elev)" strokeWidth="2.5">
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(upTop + 5).toFixed(1)} y2={(upTop + 2).toFixed(1)} />
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(upTop + 9).toFixed(1)} y2={(upTop + 6).toFixed(1)} />
              </g>}
              {d.down > max && <g stroke="var(--bg-elev)" strokeWidth="2.5">
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(downBot - 5).toFixed(1)} y2={(downBot - 2).toFixed(1)} />
                <line x1={x.toFixed(1)} x2={(x + barW).toFixed(1)} y1={(downBot - 9).toFixed(1)} y2={(downBot - 6).toFixed(1)} />
              </g>}
              <rect x={x.toFixed(1)} y={padT} width={bw.toFixed(1)} height={h - padT - padB} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          )
        })}
        <line x1={padX} x2={W - padX} y1={zeroY.toFixed(1)} y2={zeroY.toFixed(1)} stroke="var(--text-low)" strokeOpacity="0.6" strokeWidth="1" />
        {ticks?.map(t => {
          // Anchor edge ticks inward so the first/last labels aren't clipped.
          const cx = padX + t.i * bw + (bw - 2) / 2
          const anchor = cx < 30 ? 'start' : cx > W - 30 ? 'end' : 'middle'
          return <text key={t.i} className="hdx-ax" x={cx.toFixed(1)} y={h - 4} textAnchor={anchor}>{t.label}</text>
        })}
      </svg>
      {hover != null && bars[hover] && (
        <div className="hdx-tip" style={{ left: tipLeft((padX + hover * bw + bw / 2) / W * 100), top: 2 }}>{bars[hover].tip}</div>
      )}
    </div>
  )
}
