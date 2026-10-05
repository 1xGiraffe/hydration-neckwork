import type { AreaSeries } from '../components/HdxCharts'
import type { OracleFeedDetail } from '../api/oracles'

/** A move between updates: two decimals, more when it is under a hundredth of a percent (a 6-hourly rate step). */
export function fmtChangePct(pct: number): string {
  const a = Math.abs(pct)
  return (pct >= 0 ? '+' : '') + pct.toFixed(a > 0 && a < 0.01 ? 4 : 2) + '%'
}

const SERIES_COLOR: Record<string, string> = { value: 'var(--accent)', market: 'var(--sky)', short: 'var(--accent)', day: 'var(--sky)' }

/** The drawn lines: a series with no point in the window is neither drawn nor named in the legend. */
export function chartSeries(chart: OracleFeedDetail['chart']): AreaSeries[] {
  return (chart?.series ?? []).filter(s => s.values.some(v => v != null)).map(s => ({
    key: s.key, label: s.label, color: SERIES_COLOR[s.key] ?? 'var(--accent)', values: s.values, dashed: s.key === 'market' || s.key === 'day',
  }))
}
