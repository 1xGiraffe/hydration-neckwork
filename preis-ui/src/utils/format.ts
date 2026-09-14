const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'

function subscript(n: number): string {
  return String(n).split('').map(d => SUBSCRIPT_DIGITS[Number(d)]).join('')
}

// Subscript-zero notation for very small prices, matching CoinGecko / DexTools:
//   0.000001234   → "0.0₄1234"   (1 visible zero + 4 collapsed zeros)
//   0.00000009396 → "0.0₆9396"   (1 visible + 6 collapsed)
// The subscript counts zeros after the leading "0." in addition to the one we show.
function formatTinyPrice(price: number): string {
  const leadingZeros = -Math.floor(Math.log10(price)) - 1
  // 4 significant digits, rounded
  const factor = Math.pow(10, leadingZeros + 4)
  let sig = String(Math.round(price * factor))
  // Rounding could push us up a power of 10 (e.g. 9.99999e-7 → "10000").
  // In that case drop into plain toFixed.
  if (sig.length !== 4) return price.toFixed(leadingZeros + 4).replace(/\.?0+$/, '')
  // Strip trailing zeros from the significant digits — "1200" → "12", "1230" → "123".
  sig = sig.replace(/0+$/, '') || '0'
  return '0.0' + subscript(leadingZeros - 1) + sig
}

// The single graduated price ladder: more decimals the smaller the price, so a
// four-figure asset and a sub-cent one are both scannable at a glance. Every
// price the app renders — headers, rows, legends, the document title — goes
// through here so one asset never reads at two precisions across surfaces.
export function formatPrice(price: number, usd = true): string {
  const prefix = usd ? '$' : ''
  if (!Number.isFinite(price) || price <= 0) return prefix + '0'
  if (price >= 1000) return prefix + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (price >= 100) return prefix + price.toFixed(1)
  if (price >= 1) return prefix + price.toFixed(2)
  if (price >= 0.01) return prefix + price.toFixed(4)
  if (price >= 0.001) return prefix + price.toPrecision(4).replace(/\.?0+$/, '')
  // < 0.001 — too many leading zeros to be scannable; collapse into subscript notation
  return prefix + formatTinyPrice(price)
}

// ~3 significant digits with trailing zeros trimmed: 4.87 · 40 · 112 · 537.
function sig3(n: number): string {
  const fixed = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
  return fixed.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')
}

// Round to 3 significant digits BEFORE picking a unit tier, so a value in the
// carry band tiers up (999.6M → "1B") instead of rendering as "1000M".
function round3(n: number): number {
  return Number(n.toPrecision(3))
}

// Collapse large magnitudes (≥ 1e6) into M/B/T/Q suffixes. Beyond quadrillion,
// fall back to scientific notation.
const BIG_UNITS = ['M', 'B', 'T', 'Q']
function compactBig(value: number): string {
  let n = round3(value / 1e6)
  let unit = 0
  while (n >= 1000 && unit < BIG_UNITS.length - 1) { n /= 1000; unit++ }
  if (n >= 1000) return value.toExponential(2)
  return sig3(n) + BIG_UNITS[unit]
}

// The app-wide rough display scale, matching the explorer's `compactAmount`:
// ~3 significant digits with k/M/B compaction — 500 · 537 · 4.87k · 40k ·
// 112k · 4.59M. Values below 1 keep ~3 significant decimals (0.12 · 0.0034),
// and very small fractions collapse into the subscript-zero price notation
// (0.0₅7191) so high-decimal assets stay readable.
export function compactAmount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs === 0) return '0'
  const sign = value < 0 ? '-' : ''
  // Tier on the rounded value so 999.6k reads "1M", not "1000k" (round3 stays
  // off the sub-1 paths — the subscript notation needs the unrounded fraction).
  const rounded = abs >= 1 ? round3(abs) : abs
  if (rounded >= 1e6) return sign + compactBig(rounded)
  if (rounded >= 1000) return sign + sig3(rounded / 1000) + 'k'
  if (rounded >= 1) return sign + sig3(rounded)
  if (abs >= 0.001) return sign + parseFloat(abs.toPrecision(3)).toString()
  return sign + formatTinyPrice(abs)
}

/** A USD figure on the rough scale — "$4.59M", "-$112k", "$0.12". */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return (value < 0 ? '-$' : '$') + compactAmount(Math.abs(value))
}

/** A USD figure whose sign is the point (net flow) — "+$4.59M", "-$112k". */
export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return (value >= 0 ? '+$' : '-$') + compactAmount(Math.abs(value))
}

/** An exact, grouped whole number — trade and account tallies. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('en-US')
}

/** A tally compacted onto the rough scale, for places with no room to spell it out. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e6) return compactBig(value)
  if (abs >= 1000) return sig3(value / 1000) + 'k'
  return formatCount(value)
}

// Raw on-chain integer units → a display number. Amounts stay exact decimal
// strings all the way from ClickHouse, so this is the presentation boundary:
// a double keeps ~15 significant digits, far more than the 3-4 we render.
export function tokenAmountFromRaw(raw: string | null | undefined, decimals: number): number {
  if (!raw || !Number.isFinite(decimals)) return 0
  const value = Number(raw) / Math.pow(10, decimals)
  return Number.isFinite(value) ? value : 0
}

export function formatChange(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '—'
  const pct = change * 100
  const abs = Math.abs(pct)
  let formatted: string
  if (abs >= 100) formatted = Math.round(pct).toString()
  else if (abs >= 10) formatted = pct.toFixed(1)
  else formatted = pct.toFixed(2)
  if (pct >= 0) return '+' + formatted + '%'
  return formatted + '%'
}

// Smart countdown: short uses MM:SS, longer durations show units like "3d 15h"
// or "21h 04m" so a weekly close is readable.
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  seconds = Math.floor(seconds)
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`
  if (h >= 10) return `${h}h ${String(m).padStart(2, '0')}m`
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
