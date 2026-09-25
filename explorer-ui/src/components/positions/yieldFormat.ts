import type { AssetRef, YieldComponent } from '../../types'

// Percent in the shared rough scale: ~3 significant digits, "<0.01%" for a
// positive rate too small to print, "—" for an unknown one (never 0%).
export function aprText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a === 0) return '0%'
  if (a < 0.01) return `${sign}<0.01%`
  if (a < 10) return `${sign}${a.toFixed(2)}%`
  if (a < 100) return `${sign}${a.toFixed(1)}%`
  if (a < 10_000) return `${sign}${Math.round(a).toLocaleString('en-US')}%`
  return `${sign}${(a / 1000).toFixed(a < 100_000 ? 1 : 0)}k%`
}

// One line of a yield breakdown: what it is, the asset it pays in or comes
// from, and its rate. `group` starts a titled block (farm rewards) the way the
// Hydration UI heads its farm rows.
export interface YieldRow { key: string; label: string; asset?: AssetRef; pct: number | null; note?: string; group?: string }

export const YIELD_LABELS: Record<YieldComponent['kind'], string> = {
  'omnipool-fee': 'Omnipool fee',
  'stablepool-fee': 'Stablepool fee',
  'xyk-fee': 'Isolated pool fee',
  'v3-fee': 'Pool fee (range-wide)',
  'mm-supply': 'Supply APY',
  'mm-incentive': 'Incentives APR',
  'token-yield': 'Token yield',
  farm: 'Farm rewards',
}

// A token rate's source, as the hover names it.
const TOKEN_YIELD_SOURCE: Record<string, string> = { defillama: 'DeFiLlama', kamino: 'Kamino', 'on-chain': 'on-chain, 180d' }

// A component's line in a hover card. A weighted term (a pool leg's supply APY or
// token yield) names its asset and its share; a farm row sits under the farm group.
export function yieldComponentRow(c: YieldComponent, i: number): YieldRow {
  if (c.kind === 'farm') return { key: `farm-${c.asset?.assetId ?? i}-${i}`, label: c.asset?.symbol ?? 'Farm', asset: c.asset, pct: c.aprPct, group: 'Farm rewards', note: 'full loyalty' }
  const weighted = c.kind === 'mm-supply' || c.kind === 'token-yield'
  const share = weighted && c.weightPct != null && Math.round(c.weightPct) < 100 ? `${Math.round(c.weightPct)}% of pool` : undefined
  const source = c.kind === 'token-yield' && c.source ? TOKEN_YIELD_SOURCE[c.source] : undefined
  const note = [share, source].filter(Boolean).join(' · ') || undefined
  const label = weighted || c.kind === 'mm-incentive'
    ? `${YIELD_LABELS[c.kind]}${c.asset ? ` · ${c.asset.symbol}` : ''}`
    : YIELD_LABELS[c.kind]
  return { key: `${c.kind}-${c.asset?.assetId ?? ''}-${i}`, label, asset: c.asset, pct: c.aprPct, note }
}

// Σ of the rates, or null when any term is unknown — a sum missing a term is
// not a smaller sum.
export function sumPct(values: (number | null | undefined)[]): number | null {
  let total = 0
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null
    total += v
  }
  return total
}
