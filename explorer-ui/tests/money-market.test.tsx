import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MoneyMarketPositions, ProfileStats, mmPositionCount, moneyMarketDebtUsd, profileTabs } from '../src/components/AccountSections'
import { ActivityBadge } from '../src/components/ActivityTable'
import { DetailTabs } from '../src/components/ui'
import { Account } from '../src/pages/Account'
import type { AddressDetail, MoneyMarketPosition, ActivityRow } from '../src/types'

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
    expect(html).toContain('GIGAHDX · lend &amp; borrow')
    expect(html).toContain('/assets/67/icon')
    // both markets carry the full summary stats
    expect(html.match(/mm-summary/g)).toHaveLength(2)
    expect(html.match(/https:\/\/defisim\.neckwork\.net/g)).toHaveLength(1)
  })

  it('never offers DefiSim when only the GIGAHDX market is active', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[supplemental]} defisimAddress="0xabc" />)
    expect(html).toContain('GIGAHDX · lend &amp; borrow')
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

  // The Positions tab renders one card per isolated market, so the badge counts
  // one per market — an account lending in core, GIGAHDX and BIL shows 3, not 1.
  it('counts one position per isolated money market', () => {
    expect(mmPositionCount([])).toBe(0)
    expect(mmPositionCount([position(), supplemental])).toBe(2)
  })

  it('shares profile debt and tab calculations between accounts and tags', () => {
    const markets = [position(), supplemental]
    expect(moneyMarketDebtUsd(markets)).toBe(6_240)
    expect(profileTabs(3, markets, 2, 1, { total: 42, complete: true }, 7, false, 120, 340)).toEqual([
      { key: 'overview', label: 'Overview' },
      { key: 'balances', label: 'Balances', count: 3 },
      { key: 'positions', label: 'Positions', count: 5 },
      { key: 'activity', label: 'Activity', count: 42, countAtLeast: false },
      { key: 'extrinsics', label: 'Extrinsics', count: 120 },
      { key: 'events', label: 'Events', count: 340 },
      { key: 'votes', label: 'Votes', count: 7 },
    ])
  })

  // A feed too deep to walk to its end is counted exactly back to its frontier, so
  // the badge is a floor, not the account's whole history — it has to read "24,322+".
  it('marks an activity badge counted over part of the feed', () => {
    const tabs = profileTabs(0, [], 0, 0, { total: 24_322, complete: false })

    expect(tabs.find(t => t.key === 'activity')).toEqual({ key: 'activity', label: 'Activity', count: 24_322, countAtLeast: true })
    expect(renderToStaticMarkup(<DetailTabs tabs={tabs} active="activity" onChange={() => {}} />)).toContain('24,322+')
  })

  it('leaves the badge off entirely while no total is known', () => {
    expect(profileTabs(0, [], 0, 0, { total: null, complete: false }).find(t => t.key === 'activity'))
      .toEqual({ key: 'activity', label: 'Activity' })
    expect(profileTabs(0, [], 0, 0, undefined).find(t => t.key === 'activity'))
      .toEqual({ key: 'activity', label: 'Activity' })
  })

  it('labels a tag aggregate as the lowest real member health', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ simAccount: '0xabc' })]} />)
    expect(html).toContain('Lowest member health')
  })
})

// Both surfaces show Value as portfolio MINUS money-market debt, so the stat is
// netted against a loan no balance row holds and turns negative once the debt
// outgrows the wallet — the fixture below holds $1,000 and owes $40 in the primary
// market plus $6,200 in GIGAHDX, which reads as "-$5.24k" beside a balance list
// holding nothing that explains it. The breakdown row under the stats is the only
// place either overview names the borrow at all, and the markets are isolated, so
// it names each one that carries debt rather than blending them.
describe('the Value stat names the money-market debt it nets out', () => {
  const borrowing = [position(), supplemental]

  it('breaks the debt down per isolated market, primary first', () => {
    const html = renderToStaticMarkup(<ProfileStats valueUsd={-5_240} moneyMarket={borrowing} />)

    expect(html).toContain('acct-stats-hint')
    expect(html).toContain('primary $100 lent · −$40.00 borrowed')
    expect(html).toContain('GIGAHDX debt −$6.2k')
  })

  it('leaves the row off entirely when nothing is borrowed', () => {
    const lender = position({ totalDebtBase: '0', reserves: [] })

    expect(renderToStaticMarkup(<ProfileStats valueUsd={100} moneyMarket={[lender]} />)).not.toContain('acct-stats-hint')
    expect(renderToStaticMarkup(<ProfileStats valueUsd={100} moneyMarket={[]} />)).not.toContain('acct-stats-hint')
    expect(renderToStaticMarkup(<ProfileStats valueUsd={100} />)).not.toContain('acct-stats-hint')
  })

  // The account page owns no copy of this breakdown — it hands ProfileStats the
  // same market list the tag pages do. It was the one surface that passed none,
  // so a borrower's own page showed a negative Value and never mentioned either
  // market's loan, while every tag listing that same account did.
  it('renders on the account page, not just on tag aggregates', () => {
    const address = '15' + 'Bo7rower'.repeat(5) + 'x'
    const detail: AddressDetail = {
      input: address, kind: 'substrate', accountId: '0x' + 'ab'.repeat(32), emoji: '🦊',
      evmAddress: null, ss58: address, ss58Polkadot: address, tag: null, identity: null,
      relatedAccountIds: [], aliases: [], balances: [], topAssets: [], portfolioUsd: 1_000,
      moneyMarket: borrowing,
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['address', address], detail)

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}><Account address={address} /></QueryClientProvider>,
    )

    expect(html).toContain('-$5.24k')          // portfolio $1,000 − $6,240 of debt
    expect(html).toContain('primary $100 lent · −$40.00 borrowed')
    expect(html).toContain('GIGAHDX debt −$6.2k')
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
