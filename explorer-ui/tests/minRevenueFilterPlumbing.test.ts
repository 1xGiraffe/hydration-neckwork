import { describe, expect, it } from 'vitest'
import { activityListCount } from '../src/utils/activityPaging'
import { activityFilterFields } from '../src/components/activityFilters'

// A filter the list SHOWS but does not send is worse than no filter: the rows come back
// unfiltered under the reader's own query string. The revenue box shipped in the shared
// field set, so every surface that renders those fields has to carry the value too —
// and the pager's total has to move with it, or a filtered list offers pages that hold
// nothing.
describe('the minimum-revenue filter', () => {
  it('is offered by the shared activity field set', () => {
    const keys = activityFilterFields('all', []).map(f => f.key)

    expect(keys).toContain('minRevenue')
  })

  it('reaches the pager’s total, like every other filter the list shows', () => {
    const count = activityListCount('all', '', { minRevenue: '100' } as never)

    expect(count.minRevenue).toBe('100')
  })

  it('is left out of the total when it is not set', () => {
    const count = activityListCount('all', '', {} as never)

    expect(count.minRevenue).toBeUndefined()
  })
})
