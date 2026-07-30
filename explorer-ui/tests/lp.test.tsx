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
  it('carries the distinguishing section sub-label', () => {
    const html = renderToStaticMarkup(<LiquidityPositionsTable positions={[pos('Omnipool', '1', 'DOT')]} />)
    expect(html).toContain('provided to pools')
  })
})
