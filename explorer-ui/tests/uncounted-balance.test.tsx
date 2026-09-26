import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BalancesTreemap } from '../src/components/BalancesTreemap'
import { ProfileStats } from '../src/components/AccountSections'
import type { AddressBalance } from '../src/types'

// A balance the API values at nothing on purpose (the Omnipool's own H2O
// reserve, `uncounted`) is shown as the balance it is and named as not counted —
// never filed as "without a market price", and never silently absent from the
// Value it is left out of.

const H2O = { assetId: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachainId: null }
const DOT = { assetId: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null }
const raw = (units: number, decimals: number) => (BigInt(units) * 10n ** BigInt(decimals)).toString()

const h2oReserve: AddressBalance = {
  asset: H2O, total: raw(2_100_000, 12), free: raw(2_100_000, 12), reserved: '0', lastBlock: 1,
  valueUsd: 0, uncounted: { amount: raw(2_100_000, 12), reason: 'pool-hub-reserve' },
}
const dot: AddressBalance = { asset: DOT, total: raw(50, 10), free: raw(50, 10), reserved: '0', lastBlock: 1, valueUsd: 225 }

describe('BalancesTreemap', () => {
  it('files a whole-row uncounted holding under its own caption, not "without a market price"', () => {
    const html = renderToStaticMarkup(<BalancesTreemap balances={[dot, h2oReserve]} />)
    expect(html).toContain('1 holding not counted in value')
    expect(html).not.toContain('without a market price')
    // The chip carries the amount (the value would read as a worthless $0).
    expect(html).toContain('2.1M')
  })

  it('says why in the focused detail when the uncounted holding is the focus', () => {
    // The only holding: it is the default focus, and its detail names the reason.
    const html = renderToStaticMarkup(<BalancesTreemap balances={[h2oReserve]} />)
    expect(html).toContain('Not counted in value:')
    expect(html).toContain('own hub reserve')
    expect(html).toContain('not counted')
    expect(html).not.toContain('No balances observed')
  })
})

describe('ProfileStats', () => {
  it('names the uncounted balance beside the Value it leaves out', () => {
    const html = renderToStaticMarkup(<ProfileStats valueUsd={12_650_000} balances={[dot, h2oReserve]} />)
    expect(html).toContain('Excl.')
    expect(html).toContain('2.1M')
    expect(html).toContain('H2O')
    expect(html).toContain('own hub reserve')
  })

  it('says nothing when every balance is counted', () => {
    const html = renderToStaticMarkup(<ProfileStats valueUsd={225} balances={[dot]} />)
    expect(html).not.toContain('Excl.')
    expect(html).not.toContain('hub reserve')
  })
})
