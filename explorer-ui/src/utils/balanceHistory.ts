import type { AssetBalanceHistory } from '../types'

// Project the selected asset onto the account-wide shared time axis so the x-axis
// ALWAYS starts at the earliest observed balance across ALL of the account's assets
// — switching the selected asset never shifts the start. The axis is the longest
// per-asset history (the API aligns every asset to it); the selected asset's balance
// is forward-filled over it, reading 0 before it was first held. aTokens keep their
// "Indexed from" caption (their authoritative data begins at the node anchor) but
// still share the same axis start rather than truncating the window. Falls back to
// the asset's own points only when it isn't on the shared axis (pre-alignment data).
export function balanceChartSeries(selected: AssetBalanceHistory, all: AssetBalanceHistory[]): { series: number[]; dates: string[] } {
  const cur = selected
  const usable = all.filter(h => h.points.length >= 1)
  const axisTs = usable.reduce((a, h) => (h.points.length > a.length ? h.points.map(p => p.ts) : a), [] as string[])
  const balByTs = new Map(cur.points.map(p => [p.ts, p.balance]))
  const onAxis = axisTs.length > 0 && cur.points.some(p => balByTs.has(p.ts) && axisTs.includes(p.ts))
  let last = 0
  const series = onAxis ? axisTs.map(ts => { const v = balByTs.get(ts); if (v != null) last = v; return last }) : cur.points.map(p => p.balance)
  const dates = onAxis ? axisTs : cur.points.map(p => p.ts)
  return { series, dates }
}
