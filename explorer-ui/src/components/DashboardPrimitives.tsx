import type { ReactNode } from 'react'

export function ChartTooltipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return <span className="t-row">{color && <i style={{ background: color }} />}{label}<span className="tv">{value}</span></span>
}

/** A section's title; `as="h2"` makes it the page outline's heading (a page whose title is its h1). */
export function DashboardSectionTitle({ title, subtitle, as: Tag = 'div' }: { title: string; subtitle?: ReactNode; as?: 'div' | 'h2' }) {
  return (
    <Tag className="sec-title">
      {title}
      {subtitle && <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {subtitle}</span>}
    </Tag>
  )
}
