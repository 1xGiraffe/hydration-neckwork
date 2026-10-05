// ONE presentation rule for User Revenue's catch-up stream: the explorer UI shows
// `token_accrual_catchup` (yield that accrued while a token's rate sat flat,
// spread over that stretch) INSIDE "Yield-bearing token accrual" everywhere —
// dashboard, account and tag tabs, the river. The APIs keep the two streams
// apart (the split is documented there); only the reader-facing view merges.

import type { UserRevenueBreakdown, UserRevenueDashboard, UserRevenueFlowResponse, UserRevenueStreamRow, UserRevenueStreamSummary } from '../types'

export const CATCHUP_STREAM = 'token_accrual_catchup'
export const TOKEN_ACCRUAL_STREAM = 'token_accrual'
const target = (stream: string): string => (stream === CATCHUP_STREAM ? TOKEN_ACCRUAL_STREAM : stream)

function mergeSummaries(rows: readonly UserRevenueStreamSummary[]): UserRevenueStreamSummary[] {
  const out: UserRevenueStreamSummary[] = []
  const at = new Map<string, number>()
  for (const r of rows) {
    const key = target(r.stream)
    const i = at.get(key)
    if (i == null) { at.set(key, out.length); out.push({ ...r, stream: key }); continue }
    const m = out[i]
    out[i] = { ...m, earned: m.earned + r.earned, paid: m.paid + r.paid, net: m.net + r.net, unpriced: m.unpriced + r.unpriced, revisable: m.revisable || r.revisable }
  }
  // A catch-up row with no plain token row keeps the plain stream's name.
  return out.map(r => (r.stream === TOKEN_ACCRUAL_STREAM && rows.every(x => x.stream !== TOKEN_ACCRUAL_STREAM) ? { ...r, label: 'Yield-bearing token accrual' } : r))
}

/** The /revenue/users dashboard with the catch-up folded into token accrual (breakdown and history). */
export function mergeDashboardCatchup(d: UserRevenueDashboard): UserRevenueDashboard {
  if (!d.breakdown.some(b => b.stream === CATCHUP_STREAM) && !d.history.series.some(s => s.stream === CATCHUP_STREAM)) return d
  const series = new Map<string, Map<number, { t: number; usd: number; earned: number; paid: number }>>()
  const order: string[] = []
  for (const s of d.history.series) {
    const key = target(s.stream)
    if (!series.has(key)) { series.set(key, new Map()); order.push(key) }
    const m = series.get(key)!
    for (const p of s.points) {
      const q = m.get(p.t)
      m.set(p.t, q ? { t: p.t, usd: q.usd + p.usd, earned: q.earned + p.earned, paid: q.paid + p.paid } : { ...p })
    }
  }
  return {
    ...d,
    breakdown: mergeSummaries(d.breakdown),
    history: { series: order.map(stream => ({ stream, points: [...series.get(stream)!.values()].sort((a, b) => a.t - b.t) })) },
  }
}

/** An account's / tag's User Revenue tab with the catch-up folded into token accrual (streams, chart points). */
export function mergeBreakdownCatchup(b: UserRevenueBreakdown): UserRevenueBreakdown {
  if (!b.streams.some(s => s.stream === CATCHUP_STREAM) && !b.points.some(p => p.streams.some(s => s.stream === CATCHUP_STREAM))) return b
  const streams: UserRevenueStreamRow[] = []
  const at = new Map<string, number>()
  for (const s of b.streams) {
    const key = target(s.stream)
    const i = at.get(key)
    if (i == null) { at.set(key, streams.length); streams.push({ ...s, stream: key, label: key === TOKEN_ACCRUAL_STREAM ? 'Yield-bearing token accrual' : s.label }); continue }
    const m = streams[i]
    streams[i] = {
      ...m, earned: m.earned + s.earned, paid: m.paid + s.paid, net: m.net + s.net, unpriced: m.unpriced + s.unpriced,
      revisable: m.revisable || s.revisable, items: [...m.items, ...s.items].sort((x, y) => Math.abs(y.net) - Math.abs(x.net)),
      otherCount: m.otherCount + s.otherCount, otherNet: m.otherNet + s.otherNet,
    }
  }
  const points = b.points.map(p => {
    const m = new Map<string, number>()
    for (const s of p.streams) m.set(target(s.stream), (m.get(target(s.stream)) ?? 0) + s.net)
    return { ...p, streams: [...m].map(([stream, net]) => ({ stream, net })) }
  })
  return { ...b, streams, points }
}

/** The river's drips with the catch-up folded into each token's accrual drip. */
export function mergeFlowCatchup(f: UserRevenueFlowResponse): UserRevenueFlowResponse {
  if (!f.drips.some(d => d.stream === CATCHUP_STREAM)) return f
  const out = new Map<string, UserRevenueFlowResponse['drips'][number]>()
  for (const d of f.drips) {
    const stream = target(d.stream)
    const key = `${stream}:${d.assetId}`
    const label = stream === d.stream ? d.label : d.label.replace(/^[^·]*·/, 'Yield-bearing token accrual ·')
    const q = out.get(key)
    out.set(key, q ? { ...q, usdPerBlock: q.usdPerBlock + d.usdPerBlock } : { ...d, key, stream, label })
  }
  return { ...f, drips: [...out.values()].sort((a, b) => Math.abs(b.usdPerBlock) - Math.abs(a.usdPerBlock)) }
}
