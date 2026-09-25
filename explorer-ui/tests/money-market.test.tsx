import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MoneyMarketPositions, ProfileStats, mmPositionCount, moneyMarketDebtUsd, profileTabs, resolveProfileView } from '../src/components/AccountSections'

const NO_POSITIONS = { orders: 0, liquidity: 0, borrow: 0 }
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

  // A reserve that IS a pool share has no single icon to borrow: a2-Pool-PRIME is
  // PRIME+HOLLAR, so it draws as that cluster, exactly as the activity feed draws
  // it. Without the members it fell back to a bare glyph.
  it('draws a pool-share reserve as its pool, not as one bare glyph', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({
      reserves: [{
        assetId: 1143,
        iconAssetId: 143,
        iconAssetIds: [43, 222],
        symbol: 'a2-Pool-PRIME',
        decimals: 18,
        parachainId: null,
        origin: null,
        supplied: '1000000000000000000',
        debt: '0',
        suppliedUsd: 1,
        debtUsd: null,
        collateral: true,
      }],
    })]} />)
    // 43 ships a .png and 222 an .svg, so the pair is asserted extension-agnostically.
    expect(html).toContain('/assets/43/icon.')
    expect(html).toContain('/assets/222/icon.')
  })

  // A reserve names an asset the reader can open — every other surface links its
  // assets, and the positions card left them as dead text.
  it('links each reserve to its asset page', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({
      reserves: [{
        assetId: 1143, iconAssetId: 143, symbol: 'a2-Pool-PRIME', decimals: 18,
        parachainId: null, origin: null, supplied: '1000000000000000000', debt: '0',
        suppliedUsd: 1, debtUsd: null, collateral: true,
      }],
    })]} />)
    expect(html).toContain('href="/asset/1143"')
  })

  // The Borrow tab renders one card per isolated market, so the badge counts
  // one per market — an account lending in core, GIGAHDX and BIL shows 3, not 1.
  it('counts one position per isolated money market', () => {
    expect(mmPositionCount([])).toBe(0)
    expect(mmPositionCount([position(), supplemental])).toBe(2)
  })

  it('shares profile debt and tab calculations between accounts and tags', () => {
    const markets = [position(), supplemental]
    expect(moneyMarketDebtUsd(markets)).toBe(6_240)
    expect(profileTabs(3, { orders: 2, liquidity: 1, borrow: mmPositionCount(markets) }, { total: 42, complete: true }, 7, false, 120, 340)).toEqual([
      { key: 'overview', label: 'Overview' },
      { key: 'balances', label: 'Balances', count: 3 },
      { key: 'orders', label: 'Orders', count: 2 },
      { key: 'liquidity', label: 'Liquidity', count: 1 },
      { key: 'borrow', label: 'Borrow', count: 2 },
      { key: 'activity', label: 'Activity', count: 42, countAtLeast: false },
      { key: 'extrinsics', label: 'Extrinsics', count: 120 },
      { key: 'events', label: 'Events', count: 340 },
      { key: 'votes', label: 'Votes', count: 7 },
    ])
  })

  // Nothing open now, but history exists: the tab shows without a badge, so a
  // closed-out borrower or a finished DCA user can still reach their history.
  it('shows a position tab for history alone, without a count', () => {
    const tabs = profileTabs(0, { ...NO_POSITIONS, presence: { orderHistory: 4, liquidityHistory: false, moneyMarketHistory: true } })
    expect(tabs.find(t => t.key === 'orders')).toEqual({ key: 'orders', label: 'Orders' })
    expect(tabs.find(t => t.key === 'borrow')).toEqual({ key: 'borrow', label: 'Borrow' })
    expect(tabs.some(t => t.key === 'liquidity')).toBe(false)
  })

  // Old links named the combined tab; they land on the first split tab the
  // holder has, Borrow first.
  it('maps a legacy positions view onto the split tabs', () => {
    const all = profileTabs(0, { orders: 1, liquidity: 1, borrow: 1 })
    expect(resolveProfileView('positions', all)).toBe('borrow')
    expect(resolveProfileView('positions', profileTabs(0, { orders: 1, liquidity: 1, borrow: 0 }))).toBe('liquidity')
    expect(resolveProfileView('positions', profileTabs(0, { orders: 1, liquidity: 0, borrow: 0 }))).toBe('orders')
    expect(resolveProfileView('positions', profileTabs(0, NO_POSITIONS))).toBe('overview')
    expect(resolveProfileView('nonsense', all)).toBe('overview')
    expect(resolveProfileView('liquidity', all)).toBe('liquidity')
  })

  // A deep link to a position tab must not bounce through Overview while
  // positions-presence is still answering whether the tab exists.
  it('keeps the requested position tab while presence loads', () => {
    const loading = profileTabs(0, { ...NO_POSITIONS, presenceLoading: true, requestedView: 'borrow' })
    expect(loading.find(t => t.key === 'borrow')).toEqual({ key: 'borrow', label: 'Borrow' })
    expect(resolveProfileView('borrow', loading)).toBe('borrow')
    // Only the tab asked for; the others wait for the answer.
    expect(loading.some(t => t.key === 'orders' || t.key === 'liquidity')).toBe(false)
    // Once presence says there is nothing, the tab goes and the view falls back.
    const answered = profileTabs(0, { ...NO_POSITIONS, presence: { orderHistory: 0, liquidityHistory: false, moneyMarketHistory: false }, requestedView: 'borrow' })
    expect(resolveProfileView('borrow', answered)).toBe('overview')
    expect(resolveProfileView('orders', profileTabs(0, { ...NO_POSITIONS, presenceLoading: true, requestedView: 'orders' }))).toBe('orders')
  })

  // A feed too deep to walk to its end is counted exactly back to its frontier, so
  // the badge is a floor, not the account's whole history — it has to read "24,322+".
  it('marks an activity badge counted over part of the feed', () => {
    const tabs = profileTabs(0, NO_POSITIONS, { total: 24_322, complete: false })

    expect(tabs.find(t => t.key === 'activity')).toEqual({ key: 'activity', label: 'Activity', count: 24_322, countAtLeast: true })
    expect(renderToStaticMarkup(<DetailTabs tabs={tabs} active="activity" onChange={() => {}} />)).toContain('24,322+')
  })

  it('leaves the badge off entirely while no total is known', () => {
    expect(profileTabs(0, NO_POSITIONS, { total: null, complete: false }).find(t => t.key === 'activity'))
      .toEqual({ key: 'activity', label: 'Activity' })
    expect(profileTabs(0, NO_POSITIONS, undefined).find(t => t.key === 'activity'))
      .toEqual({ key: 'activity', label: 'Activity' })
  })

  // Only a row that SUMS several members shows the worst of them, so only that
  // row may say so. This used to key off simAccount, which meant "has a DefiSim
  // target" — true of the tag aggregate alone until per-account rows gained one
  // so each could link to its own address, at which point every single account
  // claimed to be showing the lowest of several.
  it('labels a multi-member aggregate as the lowest real member health', () => {
    const html = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ simAccount: '0xabc', memberCount: 3 })]} />)
    expect(html).toContain('Lowest member health')
  })

  it('calls it a health factor when the row is one account, DefiSim target or not', () => {
    // A per-account row on a tag page: carries a sim target, sums nobody.
    const perAccount = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ simAccount: '0xabc' })]} />)
    expect(perAccount).toContain('Health factor')
    expect(perAccount).not.toContain('Lowest member health')
    // A tag whose market has exactly one holder has a health factor, not a lowest one.
    const single = renderToStaticMarkup(<MoneyMarketPositions markets={[position({ simAccount: '0xabc', memberCount: 1 })]} />)
    expect(single).not.toContain('Lowest member health')
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
    expect(html.replace(/<[^>]+>/g, '')).toContain('primary $100 lent · −$40.00 borrowed')
    expect(html.replace(/<[^>]+>/g, '')).toContain('GIGAHDX debt −$6.2k')
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
    expect(html.replace(/<[^>]+>/g, '')).toContain('primary $100 lent · −$40.00 borrowed')
    expect(html.replace(/<[^>]+>/g, '')).toContain('GIGAHDX debt −$6.2k')
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

// Claimable lending incentives are already inside the account's Value; the UI
// states their share on the profile and under the market they accrue on, never
// adding them to Lent — and an unpriced one reads as its amount, never "$0.00".
describe('unclaimed lending incentives', () => {
  const gdot = { assetId: 69, symbol: 'GDOT', name: null, decimals: 18, parachainId: null }
  const text = (html: string) => html.replace(/<[^>]+>/g, '')
  const item = (over: Record<string, unknown> = {}) => ({ marketKey: 'core', asset: gdot, claimable: '2100000000000000000', claimableUsd: 12.5, ...over })

  it('states the account total as part of the value, counting unpriced ones aloud', () => {
    const html = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} moneyMarketRewards={{ asOfBlock: 15_000_000, totalUsd: 12.5, items: [item(), item({ claimableUsd: null })] }} />))
    expect(html).toContain('Incl. $12.50 unclaimed lending incentives (+ 1 unpriced, not included)')
    expect(text(renderToStaticMarkup(<ProfileStats valueUsd={1000} moneyMarketRewards={{ asOfBlock: 1, totalUsd: 0, items: [] }} />))).not.toContain('lending incentives')
  })

  it('shows the market\'s incentives as a card stat, and raw amounts when none is priced', () => {
    const priced = text(renderToStaticMarkup(<MoneyMarketPositions markets={[position({ unclaimedRewards: [item()] } as Partial<MoneyMarketPosition>)]} />))
    expect(priced).toContain('Unclaimed incentives$12.50')
    const unpriced = text(renderToStaticMarkup(<MoneyMarketPositions markets={[position({ unclaimedRewards: [item({ claimableUsd: null })] } as Partial<MoneyMarketPosition>)]} />))
    expect(unpriced).toContain('Unclaimed incentives2.1 GDOT')
    expect(unpriced).not.toContain('Unclaimed incentives$0.00')
    const none = text(renderToStaticMarkup(<MoneyMarketPositions markets={[position()]} />))
    expect(none).not.toContain('Unclaimed incentives')
  })
})
