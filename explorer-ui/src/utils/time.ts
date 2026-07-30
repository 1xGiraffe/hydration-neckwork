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
