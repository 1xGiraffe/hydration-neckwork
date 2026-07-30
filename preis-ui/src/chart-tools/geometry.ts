import type { AnchorPoint } from './types'

/** Distance from point (px, py) to the segment (x1, y1)-(x2, y2), in the same units. */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export interface MeasureStatsResult {
  deltaPrice: number
  deltaPct: number
  bars: number
  seconds: number
}

/** Signed price/percent change from a to b; percent is relative to a.price. */
export function measureStats(a: AnchorPoint, b: AnchorPoint, barsBetween: number): MeasureStatsResult {
  const deltaPrice = b.price - a.price
  const deltaPct = a.price === 0 ? 0 : (deltaPrice / a.price) * 100
  return {
    deltaPrice,
    deltaPct,
    bars: barsBetween,
    seconds: Math.abs(b.time - a.time),
  }
}

const DURATION_UNITS: ReadonlyArray<readonly [label: string, seconds: number]> = [
  ['w', 604_800],
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
]

/** Humanized duration using the largest two units: `45m`, `1h 30m`, `2d 4h`, `3w 2d`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  for (let i = 0; i < DURATION_UNITS.length; i++) {
    const [label, size] = DURATION_UNITS[i]
    const count = Math.floor(total / size)
    if (count === 0) continue
    const next = DURATION_UNITS[i + 1]
    if (!next) return `${count}${label}`
    const nextCount = Math.floor((total - count * size) / next[1])
    return nextCount > 0 ? `${count}${label} ${nextCount}${next[0]}` : `${count}${label}`
  }
  return '0m'
}

export function newDrawingId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
