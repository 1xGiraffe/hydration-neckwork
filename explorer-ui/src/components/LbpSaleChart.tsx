/* eslint-disable react-refresh/only-export-components -- the chart plus its tick/time formatters (mirrors HdxCharts) */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ChartTip, compactAmount } from './ui'
import type { BondLbpSale } from '../types'

// One LBP bond sale as it ran (the HDX bonds' primary sale): the pool's spot price per
// bond over the sale window — just before and just after every fill, so a purchase
// lifts it in a vertical step and the weights' drift pulls it down between fills —
// and every fill as a dot at the price it paid (a sell back at the price it got), its
// area by the bonds it moved. Both in face units at that moment's prices (HDX per
// bond for an HDX bond paid in DOT), against a dashed line at face: a dot above it
// paid more than the bond redeems for. The pointer snaps to the nearest fill.

export const LBP_BUY_COLOR = 'var(--cat-bond)'
export const LBP_SELL_COLOR = 'var(--cat-trade)'
export const LBP_SPOT_COLOR = 'var(--text-medium)'

const PAD_L = 56, PAD_R = 12, PAD_T = 12, PAD_B = 22
const HOUR_MS = 3_600_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')
/** "24 Oct 14:34" (UTC). */
export function lbpTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}
/** Gridlines at a round step covering [lo, hi]. */
export function priceTicks(lo: number, hi: number, count = 4): number[] {
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}
/** The time axis' labelled instants: a whole number of hours apart, at most ~`max` of them. */
export function timeTicks(fromMs: number, toMs: number, max: number): number[] {
  const hours = (toMs - fromMs) / HOUR_MS
  const step = [1, 2, 3, 4, 6, 12, 24, 48].find(h => hours / h <= max) ?? 96
  const out: number[] = []
  for (let t = Math.ceil(fromMs / (step * HOUR_MS)) * step * HOUR_MS; t <= toMs; t += step * HOUR_MS) out.push(t)
  return out
}

export function LbpSaleChart({ lbp, maturityAt, faceSymbol, paySymbol, bondSymbol, label, narrow, h = 220 }: {
  lbp: BondLbpSale; maturityAt: string; faceSymbol: string; paySymbol: string; bondSymbol: string; narrow: boolean; h?: number
  /** What the chart is of ("Round 1"), for its accessible name. */
  label: string
}) {
  // A phone gets a narrower drawing plane, not a shrunken desktop one: the chart keeps its height and its type size.
  const W = narrow ? 400 : 860
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  // Touch has no hover-out: a tapped tooltip stays until the next tap elsewhere.
  useEffect(() => {
    if (hover == null) return
    const onDown = (e: PointerEvent) => { if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setHover(null) }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [hover])

  const curve = lbp.reconciled === false ? [] : lbp.curve
  const fills = lbp.fills.filter(f => f.face != null)
  const times = [...curve.map(c => c.t), ...fills.map(f => f.t)]
  if (!times.length) return <div className="muted" style={{ padding: '24px 0', fontFamily: 'GeistMono', fontSize: 12 }}>No fill of this sale is priced.</div>
  const from = lbp.startAt ? Math.min(Date.parse(lbp.startAt), ...times) : Math.min(...times)
  const to = lbp.endAt ? Math.max(Date.parse(lbp.endAt), ...times) : Math.max(...times)
  const values = [...curve.map(c => c.face), ...fills.map(f => f.face)].filter((v): v is number => v != null)
  const lo = Math.min(1, ...values), hi = Math.max(1, ...values)
  const pad = (hi - lo) * 0.06 || 0.05
  const ticks = priceTicks(Math.max(0, lo - pad), hi + pad)
  const yMin = Math.min(Math.max(0, lo - pad), ticks[0]), yMax = Math.max(hi + pad, ticks[ticks.length - 1])
  const plotW = W - PAD_L - PAD_R, plotH = h - PAD_T - PAD_B
  const x = (t: number) => PAD_L + (to > from ? (t - from) / (to - from) : 0.5) * plotW
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * plotH
  // The spot line, broken where a point has no face value.
  let d = '', open = false
  for (const c of curve) {
    if (c.face == null) { open = false; continue }
    d += `${open ? 'L' : 'M'}${x(c.t).toFixed(1)} ${y(c.face).toFixed(1)}`
    open = true
  }
  // Dots: area by the bonds moved, sized up on a phone where the viewBox is scaled down.
  const maxBonds = Math.max(...fills.map(f => f.bonds), 1)
  const scale = narrow ? 1.1 : 1
  const radius = (bonds: number) => (2.4 + Math.sqrt(bonds / maxBonds) * 8.5) * scale
  const order = fills.map((_, i) => i).sort((a, b) => fills[b].bonds - fills[a].bonds)
  const hoverAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    if (!r.width || !fills.length) return
    const px = (e.clientX - r.left) / r.width * W
    let best = 0, dist = Infinity
    fills.forEach((f, i) => { const dd = Math.abs(x(f.t) - px); if (dd < dist) { dist = dd; best = i } })
    setHover(best)
  }
  const tTicks = timeTicks(from, to, narrow ? 4 : 8)
  const maturity = Date.parse(maturityAt)
  const f = hover != null ? fills[hover] : null
  const ret = f?.face ? (1 / f.face - 1) * 100 : null
  const apr = f && ret != null && maturity > f.t ? ret * 365 * 86_400_000 / (maturity - f.t) : null
  const faceY = y(1)
  return (
    <div ref={wrapRef} className="hdx-chart-wrap lbp-chart" onMouseLeave={() => setHover(null)}>
      <svg className="day-chart" viewBox={`0 0 ${W} ${h}`} role="img"
        aria-label={`${label}: the LBP pool's price per bond in ${faceSymbol} over the sale, with every purchase and sell back`}
        onPointerMove={hoverAt} onPointerDown={hoverAt}>
        {ticks.map(v => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v).toFixed(1)} y2={y(v).toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
            <text className="hdx-ax" x={PAD_L - 8} y={(y(v) + 3).toFixed(1)} textAnchor="end">{v.toFixed(v < 0.1 ? 3 : 2)}</text>
          </g>
        ))}
        {tTicks.map(t => {
          const dt = new Date(t)
          const label = dt.getUTCHours() === 0 ? `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}` : `${p2(dt.getUTCHours())}:00`
          return <text key={t} className="hdx-ax" x={x(t).toFixed(1)} y={h - 6} textAnchor="middle">{label}</text>
        })}
        {/* Face: what a bond redeems for at maturity. */}
        <line x1={PAD_L} x2={W - PAD_R} y1={faceY.toFixed(1)} y2={faceY.toFixed(1)} stroke="var(--text-low)" strokeWidth="1" strokeDasharray="5 4" />
        <text className="hdx-ax" x={W - PAD_R - 4} y={(faceY - 5).toFixed(1)} textAnchor="end">face · 1 {faceSymbol}</text>
        {d && <path d={d} fill="none" stroke={LBP_SPOT_COLOR} strokeWidth={narrow ? 1.8 : 1.6} strokeLinejoin="round" />}
        {order.map(i => {
          const fl = fills[i]
          return (
            <circle key={i} cx={x(fl.t).toFixed(1)} cy={y(fl.face!).toFixed(1)} r={radius(fl.bonds).toFixed(1)}
              fill={fl.side === 'sell' ? LBP_SELL_COLOR : LBP_BUY_COLOR} fillOpacity={hover == null || hover === i ? 0.78 : 0.35}
              stroke="var(--bg-elev)" strokeWidth={scale} />
          )
        })}
        {f && (
          <>
            <line x1={x(f.t).toFixed(1)} x2={x(f.t).toFixed(1)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--text-low)" strokeWidth={scale} strokeDasharray="2 3" />
            <circle cx={x(f.t).toFixed(1)} cy={y(f.face!).toFixed(1)} r={(radius(f.bonds) + 2 * scale).toFixed(1)} fill="none"
              stroke={f.side === 'sell' ? LBP_SELL_COLOR : LBP_BUY_COLOR} strokeWidth={1.5 * scale} />
          </>
        )}
      </svg>
      {f && (
        <ChartTip className="hdx-tip" xPct={x(f.t) / W * 100} top={2}>
          <span className="t-d">{lbpTime(f.t)} UTC · {f.side === 'sell' ? 'sold back' : 'purchase'}</span>
          <span className="t-row"><i style={{ background: f.side === 'sell' ? LBP_SELL_COLOR : LBP_BUY_COLOR }} />{bondSymbol}<span className="tv">{compactAmount(f.bonds)}</span></span>
          <span className="t-row">{faceSymbol} per bond<span className="tv">{f.face!.toFixed(4)}</span></span>
          {f.pay != null && <span className="t-row">{paySymbol} per bond<span className="tv">{f.pay < 0.01 ? f.pay.toPrecision(4) : f.pay.toFixed(4)}</span></span>}
          {f.side !== 'sell' && ret != null && <span className="t-row">to maturity<span className="tv">{ret >= 0 ? '+' : ''}{ret.toFixed(2)}%{apr != null ? ` · ${apr.toFixed(1)}% APR` : ''}</span></span>}
        </ChartTip>
      )}
    </div>
  )
}
