import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RiverLegend } from '../src/components/RevenueFlow'
import { userRevenueLegendItems } from '../src/components/revenueColors'

const drip = (stream: string, usdPerBlock: number, key = `${stream}:${usdPerBlock}`) => ({ key, stream, label: stream, assetId: 0, usdPerBlock })

// The legend's marker follows the particles: a stream whose drips flow both ways this
// hour draws filled AND hollow particles, so its legend shows both markers rather than
// only the income one.
describe('the user river legend', () => {
  it('marks income, cost and mixed streams as their particles are drawn, incomes first', () => {
    const items = userRevenueLegendItems([
      drip('staking_forfeit', -0.2),
      drip('token_accrual', 0.1, 'a'),
      drip('token_accrual', -0.05, 'b'),
      drip('lp_fee_omnipool', 0.3),
      drip('farm_rewards', 0),
    ])
    expect(items.map(({ key, out, both }) => ({ key, out, both }))).toEqual([
      { key: 'lp_fee_omnipool', out: undefined, both: undefined },
      { key: 'token_accrual', out: undefined, both: true },
      { key: 'staking_forfeit', out: true, both: undefined },
    ])
  })

  it('renders both markers for a mixed stream and one for the others', () => {
    const html = renderToStaticMarkup(<RiverLegend label="x" items={[
      { key: 'in', label: 'In', color: 'red' },
      { key: 'mix', label: 'Mix', color: 'blue', both: true },
      { key: 'out', label: 'Out', color: 'green', out: true },
    ]} />)
    const item = (label: string) => html.slice(html.lastIndexOf('<span class="rev-legend-item"', html.indexOf(`>${label}<`)), html.indexOf(`>${label}<`))
    const dots = (s: string) => ({ filled: (s.match(/class="rev-dot"/g) ?? []).length, hollow: (s.match(/rev-dot rev-dot-out/g) ?? []).length })
    expect(dots(item('In'))).toEqual({ filled: 1, hollow: 0 })
    expect(dots(item('Mix'))).toEqual({ filled: 1, hollow: 1 })
    expect(dots(item('Out'))).toEqual({ filled: 0, hollow: 1 })
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
