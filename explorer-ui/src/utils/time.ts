const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i

// API timestamps without an explicit offset are UTC. Preserve timestamps that
// already include a zone instead of producing invalid values such as `...+02:00Z`.
export function parseUtcTimestamp(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : trimmed.replace(' ', 'T')
  return Date.parse(EXPLICIT_TIME_ZONE.test(normalized) ? normalized : `${normalized}Z`)
}

/** Unix seconds from an indexer UTC timestamp or a chart bucket key. NaN when unparseable. */
export function utcSeconds(value: string): number {
  return Math.floor(parseUtcTimestamp(value) / 1000)
}

/** The inverse: unix seconds as the `YYYY-MM-DD HH:MM:SS` shape the tooltips parse. */
export function utcStamp(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/** Unix seconds as a short ISO day (`YYYY-MM-DD`) — chart zoom-window labels. */
export function utcDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** Short ISO date (`YYYY-MM-DD`) from an indexer UTC timestamp, '' when unparseable. */
export function tsDate(ts: string): string {
  const t = parseUtcTimestamp(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
}

// Date + time, for series whose points are closer than a day (a refined zoom
// window) — a date-only label would repeat across neighbouring points.
export function tsDateTime(ts: string): string {
  const t = parseUtcTimestamp(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : ''
}
