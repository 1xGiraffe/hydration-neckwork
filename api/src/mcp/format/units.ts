/**
 * Numbers, as the Explorer shows them.
 *
 * The rough display scale here is a deliberate third copy of one rule:
 * `compactAmount` / `F` in `explorer-ui/src/components/ui.tsx` renders it in the
 * browser, `api/src/notifications/render.ts` renders it for outbound messages,
 * and this module renders it for an LLM reading the answer. The three are
 * parallel on purpose — an agent quoting "4.87k HDX" must be quoting the same
 * rounding the page it links to shows. Where the browser and the notification
 * renderer could differ, this module follows the notification renderer, which is
 * the server-side reference.
 *
 * The scale: ~3 significant digits with k/M/B/T/Q compaction — 500 · 537 ·
 * 4.87k · 40k · 112k · 4.59M. Values below 1 keep ~3 significant decimals
 * (0.12 · 0.0034), and very small fractions collapse into subscript-zero
 * notation (0.0₅7191) so high-decimal assets stay readable.
 */

/** What every formatter prints for a value that is absent or unusable. */
export const DASH = '—'

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
const subscriptDigits = (n: number) => String(n).split('').map(d => SUBSCRIPT[+d]).join('')
const BIG_UNITS = ['M', 'B', 'T', 'Q']
// ~3 significant digits: 4.87 · 40 · 112 · 537 (trailing zeros trimmed).
const sig3 = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')
// Round to 3 significant digits BEFORE picking a unit tier so a value in the
// carry band tiers up (999.6M → "1B") instead of rendering as "1000M".
const round3 = (n: number) => Number(n.toPrecision(3))

/**
 * Subscript-zero notation for a very small fraction (the CoinGecko / DexTools
 * form): 0.0000007191 → `0.0₅7191` — one shown zero, then five collapsed ones.
 * Exported so tests can pin it; `formatNumber` reaches for it below 0.001.
 */
export function subscriptZero(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n)
  const leadingZeros = -Math.floor(Math.log10(n)) - 1
  const factor = 10 ** (leadingZeros + 4)
  let sig = String(Math.round(n * factor))
  // Rounding can bump us up a power of ten (9.9999e-7 → "10000"); fall back to plain.
  if (sig.length !== 4) return n.toFixed(leadingZeros + 4).replace(/\.?0+$/, '')
  sig = sig.replace(/0+$/, '') || '0'
  return '0.0' + subscriptDigits(leadingZeros - 1) + sig
}

function bigCompact(v: number): string {
  let n = round3(v / 1e6)
  let u = 0
  while (n >= 1000 && u < BIG_UNITS.length - 1) { n /= 1000; u++ }
  if (n >= 1000) return v.toExponential(2)
  return sig3(n) + BIG_UNITS[u]
}

/** The rough scale for a number that is already scaled out of its raw units. */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a === 0) return '0'
  // Tier on the rounded value so 999.6k reads "1M", not "1000k" (round3 stays
  // off the sub-1 paths — subscriptZero needs the unrounded fraction).
  const r = a >= 1 ? round3(a) : a
  if (r >= 1e6) return sign + bigCompact(r)
  if (r >= 1000) return sign + sig3(r / 1000) + 'k'
  if (r >= 1) return sign + sig3(r)
  if (a >= 0.001) return sign + parseFloat(a.toPrecision(3)).toString()
  return sign + subscriptZero(a)
}

/**
 * USD on the same scale: whole dollars from $100 up, k/M compaction above,
 * ~3 significant decimals below, and subscript-zero for dust. A negative value
 * signs the whole figure (`-$1.2k`), never the digits (`$-1200.00`).
 */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a === 0) return '$0'
  const r = a >= 100 ? round3(a) : a
  if (r >= 1e6) return `${sign}$${bigCompact(r)}`
  if (r >= 1e3) return `${sign}$${sig3(r / 1e3)}k`
  if (r >= 100) return `${sign}$${r.toFixed(0)}`
  if (a >= 0.01) return `${sign}$${parseFloat(a.toPrecision(3)).toString()}`
  return `${sign}$${subscriptZero(a)}`
}

/**
 * An exact integer, thousands-grouped — a COUNT of discrete things or a block
 * HEIGHT. The rough scale above is for money and amounts and is wrong for both:
 * it renders 994,520 extrinsics as "995k", which cannot be compared with
 * another account's, and block 14,744,614 as "14.7M", which nobody can look up.
 */
export function formatCount(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? DASH : Math.trunc(n).toLocaleString('en-US')
}

const isIntegerString = (s: string) => /^[+-]?\d+$/.test(s)

/**
 * A raw on-chain amount, scaled out of its integer units into a JS number.
 *
 * Amounts reach 128 bits, so `Number(raw) / 10 ** decimals` is NOT safe in
 * general: `Number(raw)` drops every digit past the 17th and `10 ** decimals` is
 * not exactly representable past 10^22, so the two errors compound on exactly
 * the high-decimal assets (HOLLAR 18, wNEAR 24) where the leading digits matter
 * most. Instead the integer is split with BigInt — exact at any width — and
 * recomposed as a decimal string, which `Number` then parses to the correctly
 * rounded double. The double still holds only ~15 significant digits; what this
 * guarantees is that the digits it holds are the LEADING ones.
 *
 * Returns null for an absent, malformed or non-finite input, so a caller can
 * tell "no amount" from "zero".
 */
export function scaleAmount(raw: string | number | null | undefined, decimals: number): number | null {
  if (raw == null) return null
  const dec = Number.isFinite(decimals) && decimals > 0 ? Math.floor(decimals) : 0
  let digits: string
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    // A non-integer number is already a scaled value by construction; dividing
    // it again would be a unit error, so take it at face value.
    if (!Number.isInteger(raw)) return raw
    digits = raw.toFixed(0)
  } else {
    const trimmed = raw.trim()
    if (!trimmed || !isIntegerString(trimmed)) return null
    digits = trimmed
  }
  let value: bigint
  try { value = BigInt(digits) } catch { return null }
  if (dec === 0) return Number(value)
  const scale = 10n ** BigInt(dec)
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / scale
  const frac = abs % scale
  const text = `${whole}.${frac.toString().padStart(dec, '0')}`
  return Number(negative ? `-${text}` : text)
}

/**
 * A raw amount on the rough scale, with its symbol appended when one is known.
 * The symbol is dropped along with the number when there is nothing to scale —
 * `— HDX` would read as "zero HDX" rather than "no figure".
 */
export function formatAmount(raw: string | number | null | undefined, decimals: number, symbol?: string | null): string {
  const value = scaleAmount(raw, decimals)
  if (value == null) return DASH
  const shown = formatNumber(value)
  return symbol ? `${shown} ${symbol}` : shown
}

/**
 * A value the API already expresses in PERCENT units (0–100): a pool share, a
 * utilisation, an LTV. For a fractional change (`change24h` is 0.064 for
 * +6.4%) use `formatPercentChange`.
 */
export function formatPercent(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return DASH
  return `${n.toFixed(digits)}%`
}

/**
 * A signed FRACTIONAL change on the explorer's `F.pct` rule: 0.064 → `+6.40%`.
 * The sign is the point — a price move reads as a movement, not a share.
 */
export function formatPercentChange(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return DASH
  const p = n * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`
}

/**
 * The money market speaks THREE encodings in one object, and mixing them up is
 * a four-orders-of-magnitude error rather than a rounding one:
 *
 *  - `totalCollateralBase` / `totalSuppliedBase` / `totalDebtBase` /
 *    `availableBorrowsBase` are USD scaled by **1e8** (Aave's base currency);
 *  - `ltv` / `liquidationThreshold` are **basis points** (8500 = 85.00%);
 *  - `healthFactor` is scaled by **1e18**, and carries two string sentinels:
 *    `'inf'` (no debt at all) and `'unknown'` (a position the service could
 *    price but not risk-rate).
 *
 * Each has its own helper below so a caller never has to remember which.
 */

/** True for the "no debt" sentinel, in any casing. */
const isInfinite = (value: string) => value.trim().toLowerCase() === 'inf'

/** A `*Base` figure as a plain number of USD, or null when unusable. */
export function scaleBase1e8(value: string | null | undefined): number | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (!trimmed || isInfinite(trimmed)) return null
  return scaleAmount(trimmed, 8)
}

/**
 * A money-market `*Base` figure as USD on the rough scale — the single renderer
 * every collateral, debt, supplied and borrowing-headroom figure goes through,
 * so none of them can reach a reader at the wrong scale or without its currency.
 *
 * `'inf'` is a real value in this encoding rather than a parse failure, and it
 * is said in words: an unbounded figure is not a very large one.
 */
export function formatBase1e8(value: string | null | undefined): string {
  if (value == null) return DASH
  const trimmed = String(value).trim()
  if (!trimmed) return DASH
  if (isInfinite(trimmed)) return 'unbounded'
  return formatUsd(scaleBase1e8(trimmed))
}

/** An `ltv` / `liquidationThreshold` basis-point string: `8500` → `85.00%`. */
export function formatBasisPoints(value: string | number | null | undefined, digits = 2): string {
  if (value == null) return DASH
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return DASH
  return `${(n / 100).toFixed(digits)}%`
}

/**
 * A fixed-precision decimal string, trimmed. An order's limit price is a
 * precision surface — it is the exact term the owner set, so it keeps every
 * significant digit rather than going through the rough scale of
 * `formatNumber`, which would render a limit of 135.135135135135 as "135".
 * All the trimming removes is the padding to a fixed dp: "0.007400000000"
 * says 0.0074, and the zeros are an artefact of the wire format, not precision
 * the order stated.
 */
export function formatDecimalString(value: string | null | undefined): string {
  if (value == null) return DASH
  const trimmed = String(value).trim()
  if (!/^-?\d+\.\d+$/.test(trimmed)) return trimmed || DASH
  return trimmed.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * A health factor, spelled out. `'inf'` means the account owes nothing, which is
 * a different statement from a very large ratio, so it is said in words rather
 * than printed as a number. Anything else is the 1e18 scaling.
 *
 * Precision is the whole question near 1.0: liquidation turns on whether the
 * ratio has crossed 1, and two decimals render both 1.0004 and 1.0049 as
 * "1.00", hiding exactly the distance being asked about. Below 10 the figure
 * keeps four decimals; above that the fourth decimal describes a position
 * nobody is about to liquidate.
 *
 * Health factors are per ISOLATED market (AGENTS.md § Explorer semantics) — this
 * formats one, and no caller may average two.
 */
export function formatHealthFactor(value: string | null | undefined): string {
  if (value == null) return DASH
  const trimmed = String(value).trim()
  if (!trimmed) return DASH
  if (isInfinite(trimmed)) return '∞ (no debt)'
  if (trimmed.toLowerCase() === 'unknown') return 'unknown'
  const scaled = scaleAmount(trimmed, 18)
  // Tolerate an already-divided decimal string rather than dropping the figure.
  const ratio = scaled ?? (Number.isFinite(Number(trimmed)) ? Number(trimmed) : null)
  if (ratio == null) return DASH
  return ratio.toFixed(Math.abs(ratio) < 10 ? 4 : 2)
}
