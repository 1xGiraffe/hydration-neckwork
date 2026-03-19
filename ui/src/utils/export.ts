import type { ApiCandle } from '../types'

/**
 * Export candle data as CSV. If visibleFrom/visibleTo provided, slices to that range.
 * Falls back to exporting all data if range is null.
 */
export function exportVisibleCSV(
  data: ApiCandle[],
  base: string,
  quote: string,
  interval: string,
  visibleFrom: number | null,
  visibleTo: number | null,
): void {
  if (data.length === 0) return

  const from = visibleFrom !== null ? Math.max(0, Math.floor(visibleFrom)) : 0
  const to = visibleTo !== null ? Math.min(data.length - 1, Math.ceil(visibleTo)) : data.length - 1
  const visible = data.slice(from, to + 1)

  const header = 'timestamp,open,high,low,close,volume\n'
  const rows = visible.map(c =>
    `${c.intervalStart},${c.open},${c.high},${c.low},${c.close},${c.volumeTotal}`
  ).join('\n')

  const blob = new Blob([header + rows], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const utcNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
  a.download = `hydration_preis_${base}${quote}_${interval}_${utcNow}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
