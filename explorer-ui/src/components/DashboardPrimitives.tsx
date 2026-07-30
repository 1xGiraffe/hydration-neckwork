import type { ReactNode } from 'react'

export function ChartTooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return <span className="t-row">{color && <i style={{ background: color }} />}{label}<span className="tv">{value}</span></span>
}

export function DashboardSectionTitle({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="sec-title">
      {title}
      {subtitle && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {subtitle}</span>}
    </div>
  )
}
