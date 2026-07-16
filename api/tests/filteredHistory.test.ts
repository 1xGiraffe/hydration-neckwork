import { describe, expect, it, vi } from 'vitest'
import { accountTransferWindowSaturated, fetchFilteredDeep, activitySourceCoversCutoff, activitySourcesNeedingMore, completeActivityPageCutoff, activityCutoffFromDate, activitySourceSeedSize, historicalPriceHour } from '../src/services/explorerService.ts'

describe('deep filtered history', () => {
  it('preserves saturation when indexed refs outlive a filtered raw page', () => {
    expect(accountTransferWindowSaturated(20, 20, false)).toBe(true)
    expect(accountTransferWindowSaturated(3, 20, true)).toBe(true)
    expect(accountTransferWindowSaturated(3, 20, false)).toBe(false)
  })

  it('widens only sources whose candidate page has not reached the merged cutoff', () => {
    const cutoff = { blockHeight: 100, eventIndex: 20 }
    expect(activitySourceCoversCutoff(24, 25, { blockHeight: 110, eventIndex: 1 }, cutoff)).toBe(true)
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 101, eventIndex: 1 }, cutoff)).toBe(false)
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 100, eventIndex: 21 }, cutoff)).toBe(false)
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 100, eventIndex: 20 }, cutoff)).toBe(true)
    expect(activitySourceCoversCutoff(25, 25, { blockHeight: 99, eventIndex: 99 }, cutoff)).toBe(true)
    expect(activitySourceCoversCutoff(25, 25, null, cutoff)).toBe(false)
  })

  it('deepens only the source that has not crossed the merged cutoff', () => {
    const pages = [
      { key: 'trade', rawSize: 10, fetchSize: 10, oldest: { blockHeight: 99, eventIndex: 1 } },
      { key: 'transfer', rawSize: 10, fetchSize: 10, oldest: { blockHeight: 101, eventIndex: 1 } },
      { key: 'dca', rawSize: 0, fetchSize: 10, oldest: null, valueIrrelevant: true },
    ]
    expect(activitySourcesNeedingMore(pages, { blockHeight: 100, eventIndex: 5 }, true).map(page => page.key))
      .toEqual(['transfer'])
    expect(activitySourcesNeedingMore(pages, null, true).map(page => page.key))
      .toEqual(['trade', 'transfer'])
  })

  it('does not treat a partial filtered page as a complete cutoff', () => {
    const rows = [
      { blockHeight: 100, eventIndex: 3 },
      { blockHeight: 99, eventIndex: 2 },
    ]
    expect(completeActivityPageCutoff(rows, 3)).toBeNull()
    expect(completeActivityPageCutoff(rows, 2)).toEqual(rows[1])
  })

  it('bounds other activity sources to the complete cutoff day', () => {
    const rows = [
      { timestamp: '2026-07-16 11:00:00' },
      { timestamp: '2026-07-15 23:59:59' },
    ]
    expect(activityCutoffFromDate(undefined, rows, 2)).toBe('2026-07-15')
    expect(activityCutoffFromDate('2026-07-16', rows, 2)).toBe('2026-07-16')
    expect(activityCutoffFromDate('2026-07-01', rows, 2)).toBe('2026-07-15')
    expect(activityCutoffFromDate(undefined, rows, 3)).toBeUndefined()
  })

  it('shares the exact completed close within an event hour', () => {
    expect(historicalPriceHour('2026-07-16 20:00:00')).toBe('2026-07-16 20:00:00')
    expect(historicalPriceHour('2026-07-16T20:59:59.123Z')).toBe('2026-07-16 20:00:00')
  })

  it('shares source cache buckets across adjacent activity pages', () => {
    expect(activitySourceSeedSize(25)).toBe(16)
    expect(activitySourceSeedSize(50)).toBe(16)
    expect(activitySourceSeedSize(75)).toBe(32)
    expect(activitySourceSeedSize(100)).toBe(32)
  })

  it('continues until it finds a match or exhausts history', async () => {
    let nextHeight = 1_000_000
    const run = vi.fn(async (_bound: string, limit: number) => {
      const call = run.mock.calls.length
      const rows = Array.from({ length: limit }, (_, index) => ({
        blockHeight: nextHeight - index,
        key: `${call}:${index}`,
        matches: call === 18 && index === 0,
      }))
      nextHeight -= limit
      return rows
    })

    const rows = await fetchFilteredDeep(
      null,
      1,
      run,
      row => row.matches,
      row => row.blockHeight,
      () => 0,
      row => row.key,
      { pageSize: 1 },
    )

    expect(run).toHaveBeenCalledTimes(18)
    expect(rows).toHaveLength(1)
  })

  it('walks every event when one block is denser than the page limit', async () => {
    const source = Array.from({ length: 12 }, (_, index) => ({
      blockHeight: 42,
      eventIndex: 12 - index,
      key: `42:${12 - index}`,
      matches: index === 10,
    }))
    const run = vi.fn(async (bound: string, limit: number) => {
      const eventCursor = /event_index < (\d+)/.exec(bound)
      const cursor = eventCursor ? Number(eventCursor[1]) : Number.POSITIVE_INFINITY
      return source.filter(row => row.eventIndex < cursor).slice(0, limit)
    })

    const rows = await fetchFilteredDeep(
      null,
      1,
      run,
      row => row.matches,
      row => row.blockHeight,
      row => row.eventIndex,
      row => row.key,
      { pageSize: 2 },
    )

    expect(rows.map(row => row.eventIndex)).toEqual([2])
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[1]?.[0]).toContain('block_height = 42 AND event_index < 11')
  })

  it('uses the scanned cursor when row construction suppresses an entire page', async () => {
    const source = Array.from({ length: 12 }, (_, index) => ({
      blockHeight: 42,
      eventIndex: 12 - index,
      key: `42:${12 - index}`,
    }))
    let pageState: { scanned: number; cursor: { blockHeight: number; eventIndex: number } | null } = { scanned: 0, cursor: null }
    const run = vi.fn(async (bound: string, limit: number) => {
      const eventCursor = /event_index < (\d+)/.exec(bound)
      const cursor = eventCursor ? Number(eventCursor[1]) : Number.POSITIVE_INFINITY
      const scanned = source.filter(row => row.eventIndex < cursor).slice(0, limit)
      const last = scanned.at(-1)
      pageState = {
        scanned: scanned.length,
        cursor: last ? { blockHeight: last.blockHeight, eventIndex: last.eventIndex } : null,
      }
      return scanned.filter(row => row.eventIndex === 2)
    })

    const rows = await fetchFilteredDeep(
      null,
      1,
      run,
      () => true,
      row => row.blockHeight,
      row => row.eventIndex,
      row => row.key,
      { pageSize: 2, pageState: () => pageState },
    )

    expect(rows.map(row => row.eventIndex)).toEqual([2])
    expect(run).toHaveBeenCalledTimes(3)
  })
})
