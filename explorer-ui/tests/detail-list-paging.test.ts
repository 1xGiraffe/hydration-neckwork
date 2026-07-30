import { describe, expect, it } from 'vitest'
import {
  PAGE_SIZE, activityListCount, eventListCount, extrinsicListCount, hasNextPage, pageCount, voteListCount,
} from '../src/utils/activityPaging'

// Every list on an account/tag detail page pages against an exact row total for the
// filters it is showing. The predecessor of this behaviour sized the activity pager
// from a sum of overlapping per-category counts — a DCA execution IS a swap, so
// trades 588 + dca 584 both counted the same 613 trade rows and the pager offered 49
// pages of a 26-page feed, pages 26-48 all empty.
describe('page count', () => {
  it('is the total divided into pages, remainder included', () => {
    expect(pageCount(647)).toBe(26)
    expect(pageCount(650)).toBe(26)
    expect(pageCount(651)).toBe(27)
    expect(pageCount(1)).toBe(1)
    expect(pageCount(PAGE_SIZE)).toBe(1)
  })

  it('has no pages to offer without a total', () => {
    // null is the API stating the feed is too deep to walk to its end; undefined is
    // the total still loading. Neither may be turned into a page count.
    expect(pageCount(null)).toBeUndefined()
    expect(pageCount(undefined)).toBeUndefined()
    expect(pageCount(0)).toBeUndefined()
  })
})

describe('next page', () => {
  it('stops on the last page even when the last page is exactly full', () => {
    // 650 rows = 26 exactly-full pages. A row-count-driven arrow would offer page 27.
    expect(hasNextPage(26, 25, PAGE_SIZE)).toBe(false)
    expect(hasNextPage(26, 24, PAGE_SIZE)).toBe(true)
  })

  it('stops on the last page of a partial final page', () => {
    expect(hasNextPage(26, 25, 22)).toBe(false)
  })

  it('falls back to "a full page may have more" only without a total', () => {
    expect(hasNextPage(undefined, 25, PAGE_SIZE)).toBe(true)
    expect(hasNextPage(undefined, 25, 22)).toBe(false)
    expect(hasNextPage(undefined, 25, 0)).toBe(false)
  })
})

// A total that ignored a filter would size the pager for a longer list than the one
// on screen, so each list's total request carries every filter that list applies —
// and only those, so switching tabs does not re-count.
describe('list totals track their own filters', () => {
  it('carries the activity tab’s category, action and value filters', () => {
    expect(activityListCount('all', '', {})).toEqual({
      tab: 'activity', type: 'all', action: undefined, token: undefined, min: undefined, from: undefined, to: undefined,
    })
    expect(activityListCount('vote', 'Voted', { token: 'HDX', min: '100', from: '2024-01-01', to: '2024-02-01' })).toEqual({
      tab: 'activity', type: 'vote', action: 'Voted', token: 'HDX', min: '100', from: '2024-01-01', to: '2024-02-01',
    })
  })

  it('changes when any single activity filter changes', () => {
    const base = JSON.stringify(activityListCount('all', '', {}))
    const variants = [
      activityListCount('trade', '', {}),
      activityListCount('all', 'Swap', {}),
      activityListCount('all', '', { token: 'HDX' }),
      activityListCount('all', '', { min: '10' }),
      activityListCount('all', '', { from: '2024-01-01' }),
      activityListCount('all', '', { to: '2024-01-01' }),
    ]
    for (const variant of variants) expect(JSON.stringify(variant), JSON.stringify(variant)).not.toBe(base)
  })

  it('changes when any single extrinsic or event filter changes', () => {
    const extrinsics = JSON.stringify(extrinsicListCount({}))
    for (const variant of [
      extrinsicListCount({ call: 'Balances.transfer' }),
      extrinsicListCount({ result: 'failed' }),
      extrinsicListCount({ origin: 'proxy' }),
      extrinsicListCount({ from: '2024-01-01' }),
      extrinsicListCount({ to: '2024-01-01' }),
    ]) expect(JSON.stringify(variant), JSON.stringify(variant)).not.toBe(extrinsics)

    const events = JSON.stringify(eventListCount({}))
    for (const variant of [
      eventListCount({ event: 'Balances.Transfer' }),
      eventListCount({ from: '2024-01-01' }),
      eventListCount({ to: '2024-01-01' }),
    ]) expect(JSON.stringify(variant), JSON.stringify(variant)).not.toBe(events)
  })

  it('keeps one list’s filters out of another list’s total', () => {
    expect(Object.keys(extrinsicListCount({ call: 'x' }))).not.toContain('token')
    expect(Object.keys(eventListCount({ event: 'x' }))).not.toContain('call')
    expect(voteListCount()).toEqual({ tab: 'votes' })
  })

  it('treats a cleared filter as absent, so it shares the unfiltered total', () => {
    expect(JSON.stringify(activityListCount('all', '', { token: '', min: '' })))
      .toBe(JSON.stringify(activityListCount('all', '', {})))
  })
})
