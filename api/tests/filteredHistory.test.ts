import { describe, expect, it, vi } from 'vitest'
import { accountTransferWindowSaturated, fetchFilteredDeep, activitySourceCoversCutoff } from '../src/services/explorerService.ts'

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
