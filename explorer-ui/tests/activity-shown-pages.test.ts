import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, provenPageCount } from '../src/utils/activityPaging'

// The activity count is a sum of overlapping per-category counts, so it is an upper bound
// on the feed, not its length. One live account reported 1,209 where the classified feed
// holds 646 — trades 588 + dca 584 counted for the same 613 trade rows, xcm 3 for 1,
// transfers 20 for 19, staking 5 for 4. At 25 a page that advertised 49 pages when 26
// exist, and pages 26-48 loaded empty. The pager therefore reports only what the feed has
// proven.
describe('provenPageCount', () => {
  it('claims nothing while a page is loading', () => {
    expect(provenPageCount(0, 30, true)).toBeUndefined()
    expect(provenPageCount(PAGE_SIZE, 0, true)).toBeUndefined()
  })

  it('claims nothing on a full page — the next arrow covers "there may be more"', () => {
    expect(provenPageCount(PAGE_SIZE, 0, false)).toBeUndefined()
    expect(provenPageCount(PAGE_SIZE, 10, false)).toBeUndefined()
  })

  // The live feed: offset 625 (page 25) returned 21 rows, offset 650 returned 0.
  it('ends on a page that settled short, which is proof it is the last', () => {
    expect(provenPageCount(21, 25, false)).toBe(26)
    expect(provenPageCount(1, 25, false)).toBe(26)
  })

  // An empty page proves the end is EARLIER, not that it is here: claiming `page` would
  // still advertise pages that do not exist. Landing on ?apage=48 rendered "Page 49 of 48".
  it('claims nothing on an empty page, however deep the link', () => {
    expect(provenPageCount(0, 26, false)).toBeUndefined()
    expect(provenPageCount(0, 48, false)).toBeUndefined()
    expect(provenPageCount(0, 490, false)).toBeUndefined()
  })

  it('handles a feed that fits inside one page', () => {
    expect(provenPageCount(7, 0, false)).toBe(1)
    expect(provenPageCount(0, 0, false)).toBeUndefined()
  })

  it('never depends on the untrustworthy count at all', () => {
    // Same inputs, no count argument to disagree with: the signature makes the bug
    // unrepresentable rather than merely unlikely.
    expect(provenPageCount.length).toBe(3)
  })
})
