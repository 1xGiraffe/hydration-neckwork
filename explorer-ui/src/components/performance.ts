import { parseUtcTimestamp } from '../utils/time'

const DAY_MS = 86_400_000

interface PerformanceWindow {
  label: string
  days: number
}

export interface PerformancePoint {
  label: string
  value: number
}

// The explorer's trailing windows, spelled one way everywhere: 24H, 7D, 30D, 12M
// (12M is the trailing 365 days). The 24H change usually comes from a finer source
// than a daily series, so callers that have one add it themselves.
export const WINDOWS_7D_30D_12M: PerformanceWindow[] = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '12M', days: 365 },
]
export const WINDOWS_24H_7D_30D_12M: PerformanceWindow[] = [{ label: '24H', days: 1 }, ...WINDOWS_7D_30D_12M]
const DEFAULT_PERFORMANCE_WINDOWS = WINDOWS_7D_30D_12M

function parsePointTime(value?: string): number | null {
  if (!value) return null
  const ms = parseUtcTimestamp(value)
  return Number.isFinite(ms) ? ms : null
}

// Sanity guards for windows that would otherwise render meaningless percentages:
// `minBase` suppresses changes measured against a dust baseline; `maxRatio`
// suppresses growth beyond that multiple (an account being funded inside the
// window is not "performance"). Declines are never suppressed by maxRatio.
export interface ChangeGuards {
  minBase?: number
  maxRatio?: number
}

export function changeOverDays(series: number[], dates: string[] | undefined, days: number, guards: ChangeGuards = {}): number | null {
  if (!series.length || !dates || dates.length !== series.length) return null
  const lastIndex = series.length - 1
  const last = series[lastIndex]
  const lastMs = parsePointTime(dates[lastIndex])
  if (!(last > 0) || lastMs == null) return null

  const target = lastMs - days * DAY_MS
  let baseIndex = -1
  let baseMs = 0
  for (let i = lastIndex - 1; i >= 0; i--) {
    const ms = parsePointTime(dates[i])
    if (ms != null && ms <= target) {
      baseIndex = i
      baseMs = ms
      break
    }
  }
  if (baseIndex < 0) return null

  const maxStaleness = Math.max(2 * DAY_MS, days * DAY_MS * 0.5)
  if (target - baseMs > maxStaleness) return null

  const base = series[baseIndex]
  if (!(base > 0)) return null
  if (guards.minBase != null && base < guards.minBase) return null
  if (guards.maxRatio != null && last / base > guards.maxRatio) return null
  return (last - base) / base * 100
}

export function performancePoints(series: number[], dates: string[] | undefined, windows = DEFAULT_PERFORMANCE_WINDOWS, guards: ChangeGuards = {}): PerformancePoint[] {
  return windows.flatMap(w => {
    const value = changeOverDays(series, dates, w.days, guards)
    return value == null ? [] : [{ label: w.label, value }]
  })
}
