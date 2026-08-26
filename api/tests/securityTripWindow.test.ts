import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { mergeLiquidationWindow, mergeTripWindow, type LiquidationWindowRow } from '../src/services/securityService.ts'

// A circuit-breaker trip is found by a pallet index and an error byte that both
// live inside JSON, so none of the four arms can prune on anything: read
// unbounded, they scan raw_extrinsics and raw_events end to end to return the
// 253 rows four years of chain hold. The dashboard rebuilds every 20 seconds,
// which made that 24 billion rows an hour.
//
// The read is incremental instead. These pin the two properties that keep the
// ANSWER the same: everything ever seen is still returned, newest first, and the
// floor only lets go of blocks the next read will not be asked about.
const row = (block_height: number, source = 'extrinsic'): Parameters<typeof mergeTripWindow>[1][number] => ({
  block_height, block_timestamp: '2026-08-26 10:00:00', extrinsic_index: 2,
  call_name: 'Omnipool.sell', signer: null, spec_version: 300, error_index: 3, source,
})

describe('mergeTripWindow', () => {
  it('returns the whole history, newest first, from a cold start', () => {
    const { all, next } = mergeTripWindow(null, [row(500), row(100), row(300)], 10_000)
    expect(all.map(r => r.block_height)).toEqual([500, 300, 100])
    expect(next.upTo).toBe(9_400)
    expect(next.rows.map(r => r.block_height)).toEqual([500, 300, 100])
  })

  it('keeps the cached rows and folds the new ones in by height', () => {
    const cached = { upTo: 9_400, rows: [row(500), row(100)] }
    const { all } = mergeTripWindow(cached, [row(9_900), row(9_500)], 10_400)
    expect(all.map(r => r.block_height)).toEqual([9_900, 9_500, 500, 100])
  })

  it('holds back the blocks a reorg could still rewrite', () => {
    // Above the floor nothing is kept, so the next read asks about those blocks
    // again and any rewrite of them lands.
    const { next } = mergeTripWindow(null, [row(9_900), row(500)], 10_000)
    expect(next.upTo).toBe(9_400)
    expect(next.rows.map(r => r.block_height)).toEqual([500])
  })

  it('never lets the floor move backwards', () => {
    // A head that reads lower than the last one must not drop rows the next
    // read — bounded by the OLD floor — will never ask for again.
    const cached = { upTo: 9_400, rows: [row(9_000), row(500)] }
    const { next } = mergeTripWindow(cached, [], 8_000)
    expect(next.upTo).toBe(9_400)
    expect(next.rows.map(r => r.block_height)).toEqual([9_000, 500])
  })

  it('is exactly the read bound the query uses', () => {
    // The cached floor is an exclusive lower bound on the next read, so a row
    // sitting exactly on it must be kept — otherwise it is in neither.
    const source = readFileSync(new URL('../src/services/securityService.ts', import.meta.url), 'utf8')
    expect(source).toContain('block_height > ${fromBlock}')
    expect(source.split('block_height > ${fromBlock}').length - 1).toBe(3)
    const { next } = mergeTripWindow(null, [row(9_400)], 10_000)
    expect(next.rows.map(r => r.block_height)).toEqual([9_400])
  })
})

// The same block-bound trick applied to the liquidation counters: `event_name`
// is not in raw_events' sort key, so counting the 8,640 liquidations four years
// hold read 14.3M rows, 160 times an hour. The sliding windows cannot reach past
// 30 days and the settled total is a number that never changes, so both accept a
// bound — as long as the split at the floor stays idempotent.
describe('mergeLiquidationWindow', () => {
  const win = (over: Partial<LiquidationWindowRow> = {}): LiquidationWindowRow =>
    ({ day: '2', week: '9', month: '31', added: '0', above: '0', last: '2026-08-26 10:00:00', ...over })

  it('folds the settled range in once and recounts only the tail', () => {
    const cold = mergeLiquidationWindow(null, win({ added: '8600', above: '40' }), 9_400)
    expect(cold.counts.total).toBe('8640')
    expect(cold.next).toEqual({ upTo: 9_400, total: 8_600, last: '2026-08-26 10:00:00' })

    // The same tail read again must not be counted twice.
    const again = mergeLiquidationWindow(cold.next, win({ added: '0', above: '40' }), 9_400)
    expect(again.counts.total).toBe('8640')
    expect(again.next.total).toBe(8_600)
  })

  it('carries the sliding windows straight through', () => {
    const { counts } = mergeLiquidationWindow(null, win({ day: '3', week: '11', month: '44' }), 9_400)
    expect([counts.day, counts.week, counts.month]).toEqual(['3', '11', '44'])
  })

  it('keeps the newest timestamp when the window read can no longer see it', () => {
    const cached = { upTo: 9_400, total: 8_600, last: '2026-08-01 00:00:00' }
    // Nothing in the last 30 days: the read returns ClickHouse's empty-set max.
    const { counts, next } = mergeLiquidationWindow(cached, win({ last: '1970-01-01 00:00:00' }), 9_500)
    expect(counts.last).toBe('2026-08-01 00:00:00')
    expect(next.last).toBe('2026-08-01 00:00:00')
  })

  it('takes the fresher timestamp when there is one', () => {
    const cached = { upTo: 9_400, total: 1, last: '2026-08-01 00:00:00' }
    expect(mergeLiquidationWindow(cached, win({ last: '2026-08-26 10:00:00' }), 9_500).counts.last)
      .toBe('2026-08-26 10:00:00')
  })

  it('survives a read that returned no row at all', () => {
    const cached = { upTo: 9_400, total: 8_600, last: '2026-08-01 00:00:00' }
    const { counts } = mergeLiquidationWindow(cached, undefined, 9_500)
    expect(counts.total).toBe('8600')
    expect(counts.last).toBe('2026-08-01 00:00:00')
  })
})
