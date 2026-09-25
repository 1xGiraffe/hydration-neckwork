import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiquidityPositionsTable, ProfileStats, type FarmedLpPosition } from '../src/components/AccountSections'
import type { LpPosition } from '../src/types'

const pos = (venue: string, positionId: string, symbol: string): LpPosition => ({
  positionId, asset: { assetId: 690, symbol, name: null, decimals: 12, parachainId: null },
  amount: '1000000000000', shares: '1000000000000', valueUsd: 42, venue,
})

describe('LiquidityPositionsTable — venue-aware rows', () => {
  it('labels NFT-held Omnipool positions with their position id', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('Omnipool', '71061', 'GSOL')]} />)
    expect(html).toContain('Position #71061')
    expect(html).toContain('Omnipool')
  })
  it('labels wallet-held stableswap shares as pool shares, not a position id', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('Stablepool', 'share-690', '2-Pool-GDOT')]} />)
    expect(html).toContain('Pool shares')
    expect(html).not.toContain('Position #')
    expect(html).toContain('Stablepool')
  })
  // A concentrated-liquidity position holds two tokens and belongs to a pool, not an
  // asset: both legs are shown and the row names the NFT (or the vault share). Its
  // row navigates to the pool page (rowNav is a click handler, not markup).
  it('renders concentrated-liquidity positions with both legs and their venue', () => {
    const pool = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
    const hollar = { assetId: 222, symbol: 'HOLLAR', name: null, decimals: 18, parachainId: null }
    const nft: LpPosition = { ...pos('Uniswap v3', 'v3:0xd5:1', 'aDOT'), assetB: hollar, amountB: '300000000000000000', poolAddress: pool, tokenId: '1' }
    const vault: LpPosition = { ...pos('Gamma vault', 'gamma:0xa2', 'aDOT'), assetB: hollar, amountB: '1176707870000000000', poolAddress: pool }
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[nft, vault]} />)
    expect(html).toContain('Position #1')
    expect(html).toContain('Vault shares')
    expect(html).toContain('aDOT / HOLLAR')
    expect(html).toContain('Uniswap v3')
    expect(html).toContain('Gamma vault')
    // The second leg reads under the first, the way an Omnipool row shows its H2O leg.
    expect(html.replace(/<[^>]+>/g, '')).toContain('+ 0.3 HOLLAR')
    expect(html.replace(/<[^>]+>/g, '')).toContain('+ 1.18 HOLLAR')
  })
  it('carries the distinguishing section sub-label', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('Omnipool', '1', 'DOT')]} />)
    expect(html).toContain('provided to pools')
  })
})

// Unclaimed farm rewards are a claim of their own: a quiet line under the farmed
// row's (principal-only) value, and one under the account value saying how much
// of it they are — the API already counts them in portfolioUsd, so the UI adds
// them to nothing.
describe('unclaimed farm rewards', () => {
  const gdot = { assetId: 69, symbol: 'GDOT', name: null, decimals: 18, parachainId: null }
  const reward = (over: Partial<NonNullable<FarmedLpPosition['unclaimedRewards']>[number]> = {}) => ({
    depositId: '77', globalFarmId: 133, yieldFarmId: 139, asset: gdot, amount: '2500000000000000000', valueUsd: 12.5, projected: true, ...over,
  })
  const text = (html: string) => html.replace(/<[^>]+>/g, '')

  it('adds the priced rewards under a farmed row, beside its unchanged value', () => {
    const farmed: FarmedLpPosition = { ...pos('Omnipool Farm', '4712', 'DOT'), unclaimedRewards: [reward(), reward({ yieldFarmId: 140, valueUsd: 0.5 })] }
    const html = text(renderToStaticMarkup(<LiquidityPositionsTable positions={[farmed]} />))
    expect(html).toContain('$42.00')
    expect(html).toContain('+ $13.00 unclaimed')
  })

  it('falls back to the amounts when no reward asset is priced, and shows nothing for none', () => {
    const unpriced: FarmedLpPosition = { ...pos('Omnipool Farm', '1', 'DOT'), unclaimedRewards: [reward({ valueUsd: null })] }
    expect(text(renderToStaticMarkup(<LiquidityPositionsTable positions={[unpriced]} />))).toContain('+ 2.5 GDOT')
    const empty: FarmedLpPosition = { ...pos('Omnipool Farm', '2', 'DOT'), unclaimedRewards: [reward({ amount: '0', valueUsd: 0 })] }
    expect(text(renderToStaticMarkup(<LiquidityPositionsTable positions={[empty]} />))).not.toContain('unclaimed')
  })

  it('states the account total as part of the value, without adding it again', () => {
    const html = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 14_996_170, totalUsd: 25 }} />))
    expect(html).toContain('Value$1k')
    expect(html).toContain('Incl. $25.00 unclaimed farm rewards')
    expect(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 14_996_170, totalUsd: 25 }} />)).toContain('Included in Value')
    expect(text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 0 }} />))).not.toContain('Unclaimed')
  })

  it('names the unpriced rewards a mixed row leaves out of its sum', () => {
    const mixed: FarmedLpPosition = { ...pos('Omnipool Farm', '3', 'DOT'), unclaimedRewards: [reward(), reward({ yieldFarmId: 140, valueUsd: null, belowExistentialDeposit: true })] }
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[mixed]} />)
    expect(text(html)).toContain('+ $12.50 (+ 1 unpriced) unclaimed')
    // Below ED but payable (the owner holds the deposit): a claim pays it, nothing to explain.
    expect(html).not.toContain('existential deposit')
  })

  // Below ED with the owner holding less: the runtime pays the claim to the
  // treasury, so the amount stays visible but is in no sum, and says why.
  it('names an unpayable sub-ED reward and keeps it out of the sums', () => {
    const row: FarmedLpPosition = { ...pos('Omnipool Farm', '5', 'DOT'), unclaimedRewards: [reward(), reward({ yieldFarmId: 141, valueUsd: 0, belowExistentialDeposit: true, payable: false })] }
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[row]} />)
    expect(text(html)).toContain('+ $12.50 (+ 1 unpayable) unclaimed')
    expect(html).toContain('pay them to the treasury')
    const only: FarmedLpPosition = { ...pos('Omnipool Farm', '6', 'DOT'), unclaimedRewards: [reward({ valueUsd: 0, belowExistentialDeposit: true, payable: false })] }
    expect(text(renderToStaticMarkup(<LiquidityPositionsTable positions={[only]} />))).toContain('+ 2.5 GDOT (unpayable)')
    const stats = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 12.5, items: [{ claimable: '1', claimableUsd: 12.5 }, { claimable: '5', claimableUsd: 0, payable: false }] }} />))
    expect(stats).toContain('Incl. $12.50 unclaimed farm rewards (+ 1 unpayable, not included)')
  })

  it('shows the account line when only unpriced rewards exist', () => {
    const html = text(renderToStaticMarkup(<ProfileStats valueUsd={1000} farmRewards={{ asOfBlock: 1, totalUsd: 0, items: [{ claimable: '5', claimableUsd: null }, { claimable: '0', claimableUsd: 0 }] }} />))
    expect(html).toContain('Incl. $0.00 unclaimed farm rewards (+ 1 unpriced, not included)')
  })
})
