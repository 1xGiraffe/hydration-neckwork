import { describe, expect, it } from 'vitest'
import { borrowersAtHeight } from '../../src/raw/indexer.ts'

// The periodic money-market re-snapshot fires on absolute block boundaries, and a
// backfill worker seeds the borrower set from every position ever indexed. Reading
// all of them at a boundary below the pool's deployment asks the contract for
// accounts that cannot exist, which answers with a decode failure per borrower —
// millions of warning rows asserting a read failure for nothing.
describe('borrowers at a snapshot height', () => {
  const borrowers = new Map([
    ['0xaaa', 6_468_408],
    ['0xbbb', 7_000_000],
    ['0xccc', 13_000_000],
  ])

  it('is empty below the first known position', () => {
    expect(borrowersAtHeight(borrowers, 0)).toEqual([])
    expect(borrowersAtHeight(borrowers, 6_468_407)).toEqual([])
  })

  it('includes a borrower from its first known block', () => {
    expect(borrowersAtHeight(borrowers, 6_468_408)).toEqual(['0xaaa'])
  })

  it('grows with the height', () => {
    expect(borrowersAtHeight(borrowers, 7_200_000).sort()).toEqual(['0xaaa', '0xbbb'])
    expect(borrowersAtHeight(borrowers, 13_500_000).sort()).toEqual(['0xaaa', '0xbbb', '0xccc'])
  })

  it('is empty for an empty set', () => {
    expect(borrowersAtHeight(new Map(), 13_500_000)).toEqual([])
  })
})
