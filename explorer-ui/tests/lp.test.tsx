import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiquidityPositionsTable } from '../src/components/AccountSections'
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
    expect(html).toContain('+ 0.3 HOLLAR')
    expect(html).toContain('+ 1.18 HOLLAR')
  })
  it('carries the distinguishing section sub-label', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('Omnipool', '1', 'DOT')]} />)
    expect(html).toContain('provided to pools')
  })
})
