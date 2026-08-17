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

export function formatPrice(price: number, usd = true): string {
  const prefix = usd ? '$' : ''
  if (!Number.isFinite(price) || price <= 0) return prefix + '0'
  if (price >= 10_000) return prefix + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (price >= 1000) return prefix + price.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (price >= 100) return prefix + price.toFixed(1)
  if (price >= 1) return prefix + price.toFixed(2)
  if (price >= 0.01) return prefix + price.toFixed(4)
  if (price >= 0.001) return prefix + price.toPrecision(4).replace(/\.?0+$/, '')
  // < 0.001 — too many leading zeros to be scannable; collapse into subscript notation
  return prefix + formatTinyPrice(price)
}

// Raw on-chain integer units → a display number. Amounts stay exact decimal
// strings all the way from ClickHouse, so this is the presentation boundary:
// a double keeps ~15 significant digits, far more than the 3-4 we render.
export function tokenAmountFromRaw(raw: string | null | undefined, decimals: number): number {
  if (!raw || !Number.isFinite(decimals)) return 0
  const value = Number(raw) / Math.pow(10, decimals)
  return Number.isFinite(value) ? value : 0
}

// Token amounts span many magnitudes (millions of HDX, fractions of a WBTC), so
// compact the large end like the volume figures and hand the small end to the
// price formatter, whose subscript notation keeps high-decimal assets readable.
export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(2)}K`
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`
  return sign + formatPrice(abs, false)
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
