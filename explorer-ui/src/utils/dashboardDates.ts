import { parseUtcTimestamp } from './time'

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function parseTimestamp(timestamp: string): Date | null {
  const date = new Date(parseUtcTimestamp(timestamp))
  return Number.isNaN(date.getTime()) ? null : date
}

export function monthDayLabel(timestamp: string): string {
  const date = parseTimestamp(timestamp)
  return date ? `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}` : timestamp
}

export function monthLabel(timestamp: string): string {
  const date = parseTimestamp(timestamp)
  return date ? MONTH_LABELS[date.getUTCMonth()] : timestamp
}
