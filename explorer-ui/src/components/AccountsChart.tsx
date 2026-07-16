// Dual-line daily Active & New accounts chart with independent left/right scales.
// The chart stays mounted while data resolves so its dimensions remain stable.
import { DayChartSkeleton } from './ui'

export function AccountsChart({ data, loading }: { data: { date: string; active: number; new: number }[]; loading?: boolean }) {
  const W = 860, H = 160, padL = 46, padR = 46, padT = 12, padB = 18
  const has = data.length > 1
  const active = data.map(d => d.active), neu = data.map(d => d.new)
  const axisA = Math.max(...active, 1) * 1.1, axisN = Math.max(...neu, 1) * 1.3
  const sx = (i: number) => padL + (has ? i / (data.length - 1) : 0) * (W - padL - padR)
  const syA = (v: number) => padT + (1 - v / axisA) * (H - padT - padB)
  const syN = (v: number) => padT + (1 - v / axisN) * (H - padT - padB)
  const path = (vals: number[], sy: (v: number) => number) => vals.map((v, i) => `${i ? 'L' : 'M'} ${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`).join(' ')
  const fk = (v: number) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v))
  const grid = [0, 0.5, 1].map(t => {
    const y = padT + (1 - t) * (H - padT - padB)
    return (
      <g key={t}>
        <line x1={padL} x2={W - padR} y1={y.toFixed(1)} y2={y.toFixed(1)} stroke="var(--separator)" strokeWidth="1" />
        <text x={padL - 8} y={(y + 3).toFixed(1)} textAnchor="end" className="ax-lbl" fill="var(--sky)">{fk(axisA * t)}</text>
        <text x={W - padR + 8} y={(y + 3).toFixed(1)} textAnchor="start" className="ax-lbl" fill="var(--accent)">{fk(axisN * t)}</text>
      </g>
    )
  })
  return (
    <>
      <div className="sec-title">Daily active &amp; new accounts <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}>· last 30 days</span></div>
      <div className="pf-card">
        <div className="bal-legend" style={{ margin: '0 0 10px' }}><span><i style={{ background: 'var(--sky)' }} />Active</span><span><i style={{ background: 'var(--accent)' }} />New</span></div>
        {loading && !has ? <DayChartSkeleton ratio={W / H} /> : (
        <svg className="day-chart" viewBox={`0 0 ${W} ${H}`}>
          {grid}
          {has && <path className="chart-line" d={path(active, syA)} fill="none" stroke="var(--sky)" strokeWidth="2" strokeLinejoin="round" />}
          {has && <path className="chart-line" d={path(neu, syN)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />}
        </svg>
        )}
      </div>
    </>
  )
}
