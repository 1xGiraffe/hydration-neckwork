import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activityWindowPlan, blockFloorBound, parseBlockFloor, timeWindowMatcher } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const body = (src: string, signature: string): string => {
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`missing ${signature}`)
  const next = src.indexOf('\nasync function ', start + signature.length)
  const nextFn = src.indexOf('\nfunction ', start + signature.length)
  const ends = [next, nextFn].filter(i => i > 0)
  return src.slice(start, ends.length ? Math.min(...ends) : undefined)
}

// The notification evaluator's global lanes read the feed from the window's first
// block (a BLOCK FLOOR) instead of from the window's first day, so a tick reads the
// blocks it matches over rather than the whole UTC day.
describe('block floor bound', () => {
  const floor = '2026-11-10 10:54:00#16844164'

  it('round-trips a block and its timestamp, and refuses anything else', () => {
    expect(blockFloorBound({ height: 16_844_164, timestamp: '2026-11-10 10:54:00' })).toBe(floor)
    expect(parseBlockFloor(floor)).toEqual({ height: 16_844_164, timestamp: '2026-11-10 10:54:00' })
    // A day, a bare timestamp, or a mangled height is not a floor.
    expect(parseBlockFloor('2026-11-10')).toBeNull()
    expect(parseBlockFloor('2026-11-10 10:54:00')).toBeNull()
    expect(parseBlockFloor('2026-11-10 10:54:00#')).toBeNull()
    expect(parseBlockFloor("2026-11-10 10:54:00#1' OR 1")).toBeNull()
    expect(blockFloorBound({ height: -1, timestamp: '2026-11-10 10:54:00' })).toBeNull()
    expect(blockFloorBound({ height: 5, timestamp: '2026-11-10T10:54:00Z' })).toBeNull()
  })

  it('opens the in-memory window at the floor block’s own timestamp', () => {
    const within = timeWindowMatcher(floor)
    expect(within('2026-11-10 10:54:00')).toBe(true)
    expect(within('2026-11-10 11:30:00')).toBe(true)
    expect(within('2026-11-10 10:53:54')).toBe(false)
    expect(within('2026-11-10 00:00:00')).toBe(false)
    // A day still opens at midnight.
    expect(timeWindowMatcher('2026-11-10')('2026-11-10 00:00:00')).toBe(true)
  })

  // The cache-key rule for a forward-only reader: a bound that changes the key's
  // shape must still turn over per block. A floor never closes the window (it has
  // no `to`), so the forward-only window stays head-keyed whatever the value floor.
  it('keeps a floored forward-only window on the head-keyed live entry', () => {
    const p = activityWindowPlan(50, 0, 'trade', floor, undefined, { min: 95_000, unit: 'usd' }, undefined, true)
    expect(p!.live).toBe(true)
    expect(p!.key).toContain(floor)
    expect(activityWindowPlan(50, 0, 'all', floor, undefined, {}, undefined, true)!.live).toBe(true)
  })

  it('states the floor as both a block range and a timestamp in SQL', () => {
    const tw = body(explorerService, 'function timeWindow(')
    expect(tw).toContain("block_timestamp >= '${floor.timestamp}' AND block_height >= ${floor.height}")
    // The one source that rewrites the bound onto an alias rewrites both columns.
    expect(body(explorerService, 'async function getRecentDcaFailures(')).toContain(".replaceAll('block_timestamp', 'e.block_timestamp').replaceAll('block_height', 'e.block_height')")
  })

  // The legacy DCA hop clause can only match blocks below the router rename, and it
  // builds a ~0.6M-row dca_events set on every read; a floor above the rename drops it.
  it('drops the pre-rename DCA hop clause from a read floored above the rename', () => {
    const trades = body(explorerService, 'async function getRecentTrades(')
    expect(trades).toContain("(parseBlockFloor(from)?.height ?? 0) >= ROUTER_NET_RENAME_BLOCK ? '' : NOT_LEGACY_DCA_HOP")
  })
})
