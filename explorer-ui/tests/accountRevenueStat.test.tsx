import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProfileStats } from '../src/components/AccountSections'
import { AccountsSortSelect } from '../src/components/AccountsTable'

describe('account Revenue stat', () => {
  it('renders Revenue like Trading/Liquidation, only when there is any', () => {
    const withRevenue = renderToStaticMarkup(
      <ProfileStats tradingVolumeUsd={1000} liquidationVolumeUsd={0} revenueUsd={12.4} valueUsd={500} />,
    )
    expect(withRevenue).toContain('Revenue')
    expect(withRevenue).toContain('$12.4')
    // Zero is "nothing to show", never a zero standing in for a value.
    const without = renderToStaticMarkup(
      <ProfileStats tradingVolumeUsd={1000} liquidationVolumeUsd={0} revenueUsd={0} valueUsd={500} />,
    )
    expect(without).not.toContain('Revenue')
  })
})

describe('accounts revenue sort', () => {
  it('offers Revenue in the mobile sort select', () => {
    const html = renderToStaticMarkup(<AccountsSortSelect id="s" sort="revenue" onSort={() => {}} />)
    expect(html).toContain('value="revenue"')
    expect(html).toContain('Revenue')
  })
})
