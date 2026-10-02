import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Liquidity, parsePoolType, poolsOfType } from '../src/pages/Liquidity'
import type { PoolListEntry, PoolsIndexResponse } from '../src/types'

const pool = (kind: PoolListEntry['kind'], name: string, tvlUsd: number): PoolListEntry =>
  ({ kind, poolId: kind === 'omnipool' ? null : 1, name, tvlUsd, sharePct: null, composition: [], hasPegs: false })
const pools = [pool('omnipool', 'Omnipool', 9_000), pool('stableswap', '2-Pool', 500), pool('xyk', 'HDX/DED', 200), pool('uniswapv3', 'GDOT/DOT', 300)]

describe('Liquidity pool-type filter', () => {
  it('offers every pool type but the Omnipool', () => {
    const qc = new QueryClient()
    qc.setQueryData<PoolsIndexResponse>(['pools'], { totalTvlUsd: 10_000, pools })
    const html = renderToStaticMarkup(<QueryClientProvider client={qc}><Liquidity /></QueryClientProvider>)
    expect(html).toContain('aria-label="Pool type"')
    const buttons = [...html.matchAll(/class="seg-btn[^"]*"[^>]*>([^<]+)</g)].map(m => m[1])
    expect(buttons).toEqual(['All', 'Stableswap', 'XYK', 'Uniswap v3'])
  })

  it('keeps one type, and the Omnipool only under All', () => {
    expect(poolsOfType(pools, 'all')).toHaveLength(4)
    expect(poolsOfType(pools, 'xyk').map(p => p.name)).toEqual(['HDX/DED'])
    expect(poolsOfType(pools, 'stableswap').some(p => p.kind === 'omnipool')).toBe(false)
  })

  it('reads an unknown or Omnipool deep link as All', () => {
    expect(parsePoolType('uniswapv3')).toBe('uniswapv3')
    expect(parsePoolType('omnipool')).toBe('all')
    expect(parsePoolType(null)).toBe('all')
  })
})
