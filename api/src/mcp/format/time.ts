/**
 * Time, as the explorer api hands it over.
 *
 * Almost every row and detail carries a ClickHouse timestamp — `"2026-09-18
 * 09:41:12"`, no `T` and no zone marker — and it is UTC. A timezone-naive
 * `new Date(s)` reads that as LOCAL time, which silently shifts every age and
 * every window by the server's offset, so the repo's idiom is to normalize the
 * separator and append `Z` before parsing. The exceptions are documented per
 * field: revenue/staker points and candle `intervalStart` are unix seconds, and
 * daily/histogram buckets are `"YYYY-MM-DD"` day strings.
 */

const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i
const DASH = '—'

/**
 * A chain timestamp as a Date, or null when there is nothing to parse. A value
 * that already carries a zone keeps it — appending `Z` to `…+02:00` would
 * produce an invalid date rather than a corrected one.
 */
export function parseChainTime(s: string | null | undefined): Date | null {
  if (s == null) return null
  const trimmed = String(s).trim()
  if (!trimmed) return null
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : trimmed.replace(' ', 'T')
  const ms = Date.parse(EXPLICIT_TIME_ZONE.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isFinite(ms) ? new Date(ms) : null
}

/** Unix seconds from a chain timestamp, or null. */
export function chainTimeSeconds(s: string | null | undefined): number | null {
  const d = parseChainTime(s)
  return d ? Math.floor(d.getTime() / 1000) : null
}

/**
 * The unix epoch is not a date on this chain, it is an ABSENCE.
 *
 * The genesis block carries no timestamp and the explorer answers
 * `"1970-01-01 00:00:00"` for it; rendered literally that reads as a real
 * moment 56 years ago. Hydration produced its first block in 2022, so nothing
 * at or below the epoch is a time this chain recorded.
 */
export function isUnrecordedTime(s: string | null | undefined): boolean {
  const d = parseChainTime(s)
  return d != null && d.getTime() <= 0
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`

/** `2026-09-18 09:41:12 UTC` — the zone is stated so an agent never has to assume it. */
export function formatTime(s: string | null | undefined): string {
  const d = parseChainTime(s)
  return d && d.getTime() > 0 ? stamp(d) : DASH
}

/**
 * The same rendering for the routes that speak unix seconds instead:
 * `RevenuePoint.t`, `StakerPoint.t`, `RevenueFlowItem.t` and a candle's
 * `intervalStart`.
 */
export function formatUnixSeconds(n: number | null | undefined): string {
  // `<= 0` is the same absence `isUnrecordedTime` names on the string path: this
  // chain recorded nothing at or before the epoch, so a 0 is a missing point
  // rather than a moment in 1970.
  if (n == null || !Number.isFinite(n) || n <= 0) return DASH
  return stamp(new Date(n * 1000))
}

/**
 * How long ago, in one unit: `just now`, `3m ago`, `2h ago`, `5d ago`. One unit
 * is the point — a feed line needs to place a row relative to now, and a second
 * unit of precision buys nothing at that job. A future timestamp (a scheduled
 * block, a clock skew) reads as `in 3m`.
 */
export function relativeAge(s: string | null | undefined, now: Date | number = Date.now()): string {
  const d = parseChainTime(s)
  if (!d || d.getTime() <= 0) return DASH
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const deltaSec = (nowMs - d.getTime()) / 1000
  const ahead = deltaSec < 0
  const a = Math.abs(deltaSec)
  if (a < 45) return ahead ? 'in a moment' : 'just now'
  const unit = a < 3600 ? `${Math.round(a / 60)}m`
    : a < 86400 ? `${Math.round(a / 3600)}h`
    : a < 86400 * 365 ? `${Math.round(a / 86400)}d`
    : `${(a / (86400 * 365)).toFixed(1)}y`
  return ahead ? `in ${unit}` : `${unit} ago`
}

/**
 * A span in words, coarsest unit first and at most two terms (`2h 5m`,
 * `3d 4h`). Used for DCA periods, track periods and index lag.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH
  const sign = seconds < 0 ? '-' : ''
  const total = Math.round(Math.abs(seconds))
  if (total < 60) return `${sign}${total}s`
  const parts: [number, string][] = [
    [Math.floor(total / 86400), 'd'],
    [Math.floor((total % 86400) / 3600), 'h'],
    [Math.floor((total % 3600) / 60), 'm'],
    [total % 60, 's'],
  ]
  const shown = parts.filter(([v]) => v > 0).slice(0, 2).map(([v, u]) => `${v}${u}`)
  return sign + (shown.length ? shown.join(' ') : '0s')
}

/**
 * A block COUNT as a wall-clock span.
 *
 * Callers must pass `nominalBlockSec` from `/explorer/stats`, never
 * `avgBlockSec`: every runtime constant expressed in blocks — a track's decision
 * period, a DCA schedule's period, an unlock delay — is DEFINED at the nominal
 * slot time, while the measured pace drifts with elastic scaling. Converting
 * with the measured pace restates a protocol parameter as something the chain
 * never promised.
 */
export function blocksToDuration(blocks: number | null | undefined, secondsPerBlock: number): string {
  if (blocks == null || !Number.isFinite(blocks)) return DASH
  if (!Number.isFinite(secondsPerBlock) || secondsPerBlock <= 0) return DASH
  return formatDuration(blocks * secondsPerBlock)
}
