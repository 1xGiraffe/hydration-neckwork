/** Format a timestamp without losing the millisecond precision used for table versions. */
export function toClickHouseDateTime64(date: Date = new Date()): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Cannot format an invalid date for ClickHouse')
  }

  return date.toISOString().replace('T', ' ').replace(/Z$/, '')
}

/** Format a DateTime column value at whole-second precision. */
export function toClickHouseDateTime(date: Date = new Date()): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Cannot format an invalid date for ClickHouse')
  }

  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

/** Format a required on-chain timestamp at the second precision used by block tables. */
export function toClickHouseBlockTime(timestamp?: number, blockHeight?: number): string {
  if ((timestamp == null || timestamp === 0) && blockHeight === 0) {
    return '1970-01-01 00:00:00'
  }
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) {
    throw new RangeError(`Invalid block timestamp: ${String(timestamp)}`)
  }

  return toClickHouseDateTime(new Date(timestamp))
}

/** Parse ClickHouse's timezone-free DateTime text as UTC, independent of host locale. */
export function parseClickHouseDateTime(value: string | Date): number {
  if (value instanceof Date) return value.getTime()

  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`
  return Date.parse(withTimezone)
}
