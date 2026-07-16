import { createHash } from 'node:crypto'

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Build a deterministic token that cannot collide merely because two batches share bounds. */
export function buildInsertDedupeToken(
  prefix: string,
  replayNamespace: string,
  rows: unknown[],
  context: Array<string | number> = [],
): string {
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(stableJson(row))
    hash.update('\0')
  }
  const fingerprint = hash.digest('hex').slice(0, 24)
  return [prefix, replayNamespace, ...context, rows.length, fingerprint].join('-')
}
