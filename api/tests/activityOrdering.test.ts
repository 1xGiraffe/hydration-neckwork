import { describe, expect, it } from 'vitest'
import { compareActivityRowsNewestFirst } from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'

// Every activity surface is newest-first. The account and tag feeds merge several
// per-family queries, so without a within-block tiebreak their rows keep the order
// the families were concatenated in — the same two events then read differently on
// the account page than on the global or asset feed.
const row = (blockHeight: number, eventIndex: number | null, tag: string): ActivityRow =>
  ({ type: 'transfer', blockHeight, eventIndex, extrinsicIndex: null, timestamp: tag } as ActivityRow)

const order = (rows: ActivityRow[]) => [...rows].sort(compareActivityRowsNewestFirst).map(r => r.timestamp)

describe('activity ordering', () => {
  it('puts the newest block first', () => {
    expect(order([row(10, 1, 'old'), row(20, 1, 'new')])).toEqual(['new', 'old'])
  })

  it('puts the later event first inside a block', () => {
    // Source order is trade(63) then xcm(77); the feed must show xcm(77) first.
    expect(order([row(13_304_128, 63, 'trade'), row(13_304_128, 77, 'xcm')])).toEqual(['xcm', 'trade'])
  })

  it('does not depend on the order the sources were merged in', () => {
    const rows = [row(5, 232, 'a'), row(5, 114, 'b'), row(5, 246, 'c')]
    expect(order(rows)).toEqual(['c', 'a', 'b'])
    expect(order([...rows].reverse())).toEqual(['c', 'a', 'b'])
  })

  it('sorts a row without an event index last inside its block', () => {
    expect(order([row(7, null, 'hook'), row(7, 0, 'event')])).toEqual(['event', 'hook'])
  })
})
