import { paths } from '../router'
import type { SourceKind, SourceStatus } from '../api/oracles'

// The oracle pages' shared labels and formatters (/oracles and /oracle/:feed);
// OracleParts renders them.

export const KIND_LABEL: Record<SourceKind, string> = {
  dia: 'DIA', push: 'Push feed', ema: 'EMA oracle', composite: 'Composite', computed: 'Computed on call', fixed: 'Fixed', unknown: 'Unknown',
}

export const STATUS_LABEL: Record<SourceStatus, string> = {
  live: 'Live', stale: 'Stale', retired: 'Retired', static: 'Never updated', fixed: 'Constant', unknown: 'Unknown',
}

/** Age in the payload is as of its build; add the time since then. */
export function ageNow(ageSec: number | null | undefined, builtAt: string | null | undefined, now: number): number | null {
  if (ageSec == null) return null
  const built = builtAt ? Date.parse(builtAt) : NaN
  return ageSec + (Number.isFinite(built) ? Math.max(0, (now - built) / 1000) : 0)
}

/** A pair quoted in USD reads as a price; any other pair is a ratio. */
export function isUsdPair(pair: string | null | undefined): boolean {
  return !!pair && /\/\s*USD$/i.test(pair.trim())
}

/**
 * A ratio at oracle precision: the money markets act on the fourth decimal of
 * a 1.30 jitoSOL/SOL, so the rough three-digit scale would hide what moved.
 */
export function fmtRatio(v: number, digits = 4): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (a >= 1) return v.toFixed(digits)
  if (a === 0) return '0'
  return v.toPrecision(digits)
}

/** Where a source's history lives, if it has one; a composite or constant links to its contract. */
export function sourceHref(s: { address: string; feedId: string | null }): string | null {
  if (s.feedId) return paths.oracle(s.feedId)
  if (/^0x[0-9a-f]{40}$/.test(s.address)) return paths.oracle(s.address)
  return null
}
