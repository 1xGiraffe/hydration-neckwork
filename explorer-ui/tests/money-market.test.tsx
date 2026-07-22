import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MoneyMarketPositions, mmPositionCount, moneyMarketDebtUsd, profileTabs } from '../src/components/AccountSections'
import { ActivityBadge } from '../src/components/ActivityTable'
import type { MoneyMarketPosition, ActivityRow } from '../src/types'

function position(overrides: Partial<MoneyMarketPosition> = {}): MoneyMarketPosition {
  return {
    marketKey: 'core',
    market: 'Money Market',
    role: 'primary',
    defiSimSupported: true,
    blockHeight: 12,
    timestamp: '2026-07-10 12:00:00',
    totalCollateralBase: '10000000000',
    totalDebtBase: '4000000000',
    availableBorrowsBase: '2500000000',
    liquidationThreshold: '8000',
    ltv: '6500',
    healthFactor: '2000000000000000000',
    reserves: [
      { assetId: 5, symbol: 'DOT', decimals: 10, supplied: '225000000000', debt: '0', suppliedUsd: 100, debtUsd: null, collateral: true },
      { assetId: 222, symbol: 'HOLLAR', decimals: 18, supplied: '0', debt: '40000000000000000000', suppliedUsd: null, debtUsd: 40, collateral: false },
    ],
    ...overrides,
  }
}

const supplemental = position({
  marketKey: 'gigahdx',
  market: 'GIGAHDX',
  role: 'supplemental',
  defiSimSupported: false,
  stakingBacked: true,
  totalCollateralBase: '2400000000000',
  totalDebtBase: '620000000000',
  healthFactor: '2380000000000000000',
})

describe('primary-first Money Market presentation', () => {
  it('renders every market as a full card, primary first, GIGAHDX labeled with its logo', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[supplemental, position()]} defisimAddress="0xabc" />)

    expect(html.indexOf('data-market-key="core"')).toBeLessThan(html.indexOf('data-market-key="gigahdx"'))
    expect(html).not.toContain('mm-secondary')
    expect(html).toContain('GIGAHDX · supply &amp; borrow')
    expect(html).toContain('/assets/67/icon')
    // both markets carry the full summary stats
    expect(html.match(/mm-summary/g)).toHaveLength(2)
    expect(html.match(/https:\/\/defisim\.neckwork\.net/g)).toHaveLength(1)
  })

  it('never offers DefiSim when only the GIGAHDX market is active', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[supplemental]} defisimAddress="0xabc" />)
    expect(html).toContain('GIGAHDX · supply &amp; borrow')
    expect(html).not.toContain('defisim.neckwork.net')
  })

  it('uses debt divided by collateral for current LTV and exposes an accessible meter', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ totalSuppliedBase: '15000000000' })]} defisimAddress="0xabc" />)
    expect(html).toContain('$150')
    expect(html).toContain('Current LTV 40.0%')
    expect(html).not.toContain('Current LTV 26.7%')
    expect(html).not.toContain('Current LTV 65.0%')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuetext="40.0% current loan-to-value; liquidation threshold 80%"')
  })

  it('renders origin badges on supplied aTokens', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({
      reserves: [{
        assetId: 1003,
        iconAssetId: 22,
        symbol: 'aUSDC',
        decimals: 6,
        parachainId: 1000,
        origin: { ecosystem: 'polkadot', chainId: '1000', assetId: null },
        supplied: '1000000',
        debt: '0',
        suppliedUsd: 1,
        debtUsd: null,
        collateral: true,
      }],
    })]} />)

    expect(html).toContain('/polkadot/1000/icon.svg')
    expect(html).toContain('/polkadot/2034/assets/22/icon.svg')
  })

  it('counts all isolated money markets as one position family', () => {
    expect(mmPositionCount([])).toBe(0)
    expect(mmPositionCount([position(), supplemental])).toBe(1)
  })

  it('shares profile debt and tab calculations between accounts and tags', () => {
    const markets = [position(), supplemental]
    expect(moneyMarketDebtUsd(markets)).toBe(6_240)
    expect(profileTabs(3, markets, 2, 1, 42, 7)).toEqual([
      { key: 'overview', label: 'Overview' },
      { key: 'balances', label: 'Balances', count: 3 },
      { key: 'positions', label: 'Positions', count: 4 },
      { key: 'activity', label: 'Activity', count: 42 },
      { key: 'votes', label: 'Votes', count: 7 },
    ])
  })

  it('labels a tag aggregate as the lowest real member health', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ simAccount: '0xabc' })]} />)
    expect(html).toContain('Lowest member health')
  })
})

describe('supplemental market hints', () => {
  it('labels supplemental Money Market activity but leaves primary activity unchanged', () => {
    const row: ActivityRow = {
      type: 'mm', blockHeight: 1, timestamp: '2026-07-10 12:00:00', extrinsicIndex: 0,
      who: null, to: null, asset: null, assetIn: null, assetOut: null,
      amount: null, amountIn: null, amountOut: null, valueUsd: null, mmAction: 'Borrow',
    }
    expect(renderToStaticMarkup(<ActivityBadge r={{ ...row, mmMarketKey: 'gigahdx', mmMarket: 'GIGAHDX' }} />)).toContain('mm-activity-market')
    expect(renderToStaticMarkup(<ActivityBadge r={{ ...row, mmMarketKey: 'core', mmMarket: 'Money Market' }} />)).not.toContain('mm-activity-market')
  })
})
