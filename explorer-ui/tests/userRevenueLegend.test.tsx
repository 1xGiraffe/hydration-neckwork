import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RiverLegend } from '../src/components/RevenueFlow'
import { userRevenueLegendItems } from '../src/components/revenueColors'

const drip = (stream: string, usdPerBlock: number, key = `${stream}:${usdPerBlock}`) => ({ key, stream, label: stream, assetId: 0, usdPerBlock })

// The user river carries only what users earn: its legend names each earning
// stream once, filled, in the palette's order, and never a cost.
describe('the user river legend', () => {
  it('names each earning stream once, in the palette order, and no cost', () => {
    const items = userRevenueLegendItems([
      drip('staking_forfeit', -0.2),
      drip('token_accrual', 0.1, 'a'),
      drip('token_accrual', 0.05, 'b'),
      drip('lp_fee_omnipool', 0.3),
      drip('farm_rewards', 0),
    ])
    expect(items.map(i => i.key)).toEqual(['lp_fee_omnipool', 'token_accrual'])
  })

  it('renders one filled marker per stream', () => {
    const html = renderToStaticMarkup(<RiverLegend label="x" items={[
      { key: 'a', label: 'A', color: 'red' },
      { key: 'b', label: 'B', color: 'blue' },
    ]} />)
    expect((html.match(/class="rev-dot"/g) ?? []).length).toBe(2)
    expect(html).not.toContain('rev-dot-out')
  })
})

describe('the Borrow card interest-paid hover', () => {
  it('marks each paid line hollow in its User Revenue stream colour — HOLLAR interest in HOLLAR\'s', async () => {
    const { paidRows } = await import('../src/components/positions/borrowMath')
    const { USER_REVENUE_STREAM_COLOR } = await import('../src/components/revenueColors')
    const asset = { assetId: 222, iconAssetId: 222, symbol: 'HOLLAR', name: 'HOLLAR', decimals: 18, parachainId: null }
    const item = (stream: string, label: string) => ({ category: 'paid' as const, stream, label, asset, via: null, usd: 1, unpriced: 0 })
    const rows = paidRows({ items: [item('mm_borrow_interest_hollar', 'HOLLAR interest'), item('mm_borrow_interest', 'DOT borrow interest')] } as never)
    expect(rows.map(r => [r.label, r.dot])).toEqual([
      ['HOLLAR interest', { color: 'var(--rv-hollar)', hollow: true }],
      ['DOT borrow interest', { color: USER_REVENUE_STREAM_COLOR.mm_borrow_interest, hollow: true }],
    ])
  })
})
