import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { activityListCount } from '../src/utils/activityPaging'
import { activityFilterFields, marketFilterField } from '../src/components/activityFilters'
import { FilterZone } from '../src/components/Filters'
import type { MmMarketOption } from '../src/types'

// The money-market (Borrow) tab's market selector. Its options are the API's own
// market list, narrowed on an account/tag to the markets its feed has rows in; it
// exists on the mm tab only, and its value must reach the pager's total exactly like
// the rows request, or a filtered list offers pages that hold nothing.
const MARKETS: MmMarketOption[] = [
  { key: 'core', label: 'Money Market', role: 'primary' },
  { key: 'gigahdx', label: 'GIGAHDX', role: 'supplemental' },
  { key: 'bil', label: 'BIL', role: 'supplemental' },
]

describe('marketFilterField', () => {
  it('offers "All markets" and every configured market, in the API’s order', () => {
    const field = marketFilterField(MARKETS)
    expect(field?.key).toBe('market')
    expect(field?.kind).toBe('select')
    expect(field?.options?.map(o => [o.value, o.label])).toEqual([
      ['', 'All markets'], ['core', 'Money Market'], ['gigahdx', 'GIGAHDX'], ['bil', 'BIL'],
    ])
  })

  it('narrows to the markets a holder touched, but keeps the one a link selected', () => {
    expect(marketFilterField(MARKETS, undefined, ['core', 'bil'])?.options?.map(o => o.value)).toEqual(['', 'core', 'bil'])
    expect(marketFilterField(MARKETS, 'gigahdx', ['core'])?.options?.map(o => o.value)).toEqual(['', 'core', 'gigahdx'])
  })

  it('is no field at all while the list is unknown or empty', () => {
    expect(marketFilterField(undefined)).toBeNull()
    expect(marketFilterField([])).toBeNull()
    expect(marketFilterField(MARKETS, undefined, [])).toBeNull()
  })
})

describe('the market field in the activity filter set', () => {
  const field = marketFilterField(MARKETS)

  it('sits on the money-market tab, right after its action select', () => {
    const keys = activityFilterFields('mm', [], true, field).map(f => f.key)
    expect(keys.slice(0, 2)).toEqual(['action', 'market'])
  })

  it('is absent from every other tab', () => {
    for (const type of ['all', 'trade', 'transfer', 'liquidity', 'xcm']) {
      expect(activityFilterFields(type, [], true, field).map(f => f.key)).not.toContain('market')
    }
  })

  it('renders as the same select the action filter uses, showing the chosen market', () => {
    const html = renderToStaticMarkup(
      <FilterZone fields={activityFilterFields('mm', [], true, field)} values={{ market: 'gigahdx' }} onChange={() => {}} onClear={() => {}} />,
    )
    expect(html).toMatch(/<select[^>]*aria-label="Money market"/)
    expect(html).toContain('<option value="">All markets</option>')
    expect(html).toMatch(/<option value="gigahdx" selected="">GIGAHDX<\/option>/)
  })
})

describe('the market in the pager’s total', () => {
  it('travels with a money-market count', () => {
    expect(activityListCount('mm', 'Borrow', { market: 'gigahdx' }).market).toBe('gigahdx')
  })

  it('never reaches another type’s count, which the API would refuse', () => {
    expect(activityListCount('trade', '', { market: 'core' }).market).toBeUndefined()
    expect(activityListCount('mm', '', {}).market).toBeUndefined()
  })
})
