import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProfileStats } from '../src/components/AccountSections'

// The account header's farm-reward line. The per-position rows moved to the
// Liquidity tab (tests/liquidity-tab.test.tsx).
describe('unclaimed farm rewards', () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, '')

  it('states the account total as part of the value, without adding it again', () => {
    const html = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 14_996_170, totalUsd: 25 }} />))
    expect(html).toContain('Value$1k')
    expect(html).toContain('Incl. $25.00 unclaimed farm rewards')
    expect(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 14_996_170, totalUsd: 25 }} />)).toContain('Included in Value')
    expect(text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 0 }} />))).not.toContain('Unclaimed')
  })

  it('shows the account line when only unpriced rewards exist', () => {
    const html = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 0, items: [{ claimable: '5', claimableUsd: null }, { claimable: '0', claimableUsd: 0 }] }} />))
    expect(html).toContain('Incl. $0.00 unclaimed farm rewards (+ 1 unpriced, not included)')
  })

  it('keeps an unpayable sub-ED reward out of the account total and names it', () => {
    const stats = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 12.5, items: [{ claimable: '1', claimableUsd: 12.5 }, { claimable: '5', claimableUsd: 0, payable: false }] }} />))
    expect(stats).toContain('Incl. $12.50 unclaimed farm rewards (+ 1 unpayable, not included)')
  })
})
