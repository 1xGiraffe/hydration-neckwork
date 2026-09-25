// The single conversion of a ClickHouse DateTime into the ISO-8601 UTC wire format
// (milliseconds, trailing Z). ClickHouse hands DateTime columns back as
// 'YYYY-MM-DD hh:mm:ss' in the session timezone, which the api services assert is
// UTC at boot (src/public/server.ts for the public surface) — that assertion is
// what makes appending 'Z' correct here rather than a guess. A leaf (no imports) so
// the public tree, which re-exports it from its schemas, and the shared yield read
// models state one timestamp one way.
export function iso(d: Date | string | number): string {
  if (d instanceof Date) return assertValid(d, d)
  if (typeof d === 'number') return assertValid(new Date(d), d)
  const trimmed = d.trim()
  // Already carries a zone (…Z or ±hh:mm) — let Date parse it as-is.
  const zoned = /[Zz]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)
  return assertValid(new Date(zoned ? trimmed : `${trimmed.replace(' ', 'T')}Z`), d)
}

function assertValid(parsed: Date, input: Date | string | number): string {
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`not a timestamp: ${JSON.stringify(input)}`)
  return parsed.toISOString()
}
