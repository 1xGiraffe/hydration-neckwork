/* eslint-disable react-refresh/only-export-components -- chart component + ema7 helper */
import { useRef, useState } from 'react'
import { performancePoints } from './performance'
import { ChartTip, F } from './ui'

// Asset price chart with an EMA7 overlay, an availability-based performance row,
// and a crosshair tooltip.
export function PriceChart({ data, dates, price, change24h }: { data: number[]; dates?: string[]; price: number | null; change24h: number | null }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ xPct: number; yPct: number; date: string; price: string; ema: string } | null>(null)
  if (!data || data.length < 2) return null

  const W = 820, H = 190, padTop = 14, padBot = 14
  const n = data.length
  const min = Math.min(...data), max = Math.max(...data)
  // Span full width so the line/EMA align with the hover crosshair (0..100% across
  // the container); a horizontal inset leaves the first/last points hoverable but
  // with no line drawn there.
  const sx = (i: number) => i / (n - 1) * W
  const sy = (v: number) => padTop + (1 - (v - min) / ((max - min) || 1)) * (H - padTop - padBot)
  const line = data.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
  const area = `${line} L ${sx(n - 1).toFixed(1)} ${H - padBot} L ${sx(0).toFixed(1)} ${H - padBot} Z`
  const up = data[n - 1] >= data[0]
  const col = up ? 'var(--green)' : 'var(--red)'

  // EMA7
  const k = 2 / 8
  const ema: number[] = []
  data.forEach((v, i) => ema.push(i ? v * k + ema[i - 1] * (1 - k) : v))
  const emaLine = ema.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')

  // perf
  const last = data[n - 1]
  const dated = dates && dates.length === data.length ? dates : undefined
  const perfItems = [
    ...(change24h != null ? [{ label: '24H', value: change24h }] : []),
    ...performancePoints(data, dated),
  ]
  const perf = (label: string, val: number) => (
    <span key={label} className="perf"><span className="pk">{label}</span><span className="pv" style={{ color: val >= 0 ? 'var(--green)' : 'var(--red)' }}>{val >= 0 ? '+' : ''}{val.toFixed(2)}%</span></span>
  )

  function onMove(e: React.PointerEvent) {
    const wrap = wrapRef.current; if (!wrap) return
    const r = wrap.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const i = Math.round(frac * (n - 1))
    setHover({
      xPct: i / (n - 1) * 100, yPct: sy(data[i]) / H * 100,
      date: dated?.[i]?.slice(0, 10) ?? '',
      price: F.priceUsd(data[i]), ema: F.priceUsd(ema[i]),
    })
  }

  return (
    <div className="pf-card">
      <div className="pf-head pf-head-asset">
        <div className="pf-now">{F.priceUsd(price ?? last)}</div>
        <div className="perf-row">{perfItems.map(p => perf(p.label, p.value))}</div>
      </div>
      {/* Same pointer wiring as AreaChart (ui.tsx): touch scrubs, tap sticks, mouse leave clears. */}
      <div className="apx-wrap" ref={wrapRef} onPointerDown={onMove} onPointerMove={onMove}
        onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(null) }}>
        <svg className="apx-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs><linearGradient id="apxg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.26" /><stop offset="100%" stopColor={col} stopOpacity="0" /></linearGradient></defs>
          <path d={area} fill="url(#apxg)" />
          <path d={emaLine} fill="none" stroke="var(--lavender)" strokeWidth="1.4" strokeDasharray="4 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {hover && <div className="apx-cross"><div className="apx-vline" style={{ left: `${hover.xPct}%` }} /><div className="apx-dot" style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%` }} /></div>}
        {hover && (
          <ChartTip xPct={hover.xPct}>
            <span className="t-d">{hover.date}</span>
            <span className="t-p">{hover.price}</span>
            <span className="t-e">EMA {hover.ema}</span>
          </ChartTip>
        )}
      </div>
      <div className="bal-legend" style={{ marginTop: 10 }}><span><i style={{ background: col }} />Price</span><span><i style={{ background: 'var(--lavender)' }} />EMA7</span></div>
    </div>
  )
}

// EMA7 of a series (for the detail-card price tag).
export function ema7(data: number[]): number | null {
  if (!data?.length) return null
  const k = 2 / 8
  let e = data[0]
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k)
  return e
}
