import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PoolApr } from '../src/components/positions/PoolApr'
import { omnipoolAprSpan, omnipoolListingOf, poolAprRows, poolHeadline, rewardIcons } from '../src/components/positions/liquidityModel'
import { Liquidity } from '../src/pages/Liquidity'
import type { AssetRef, ExplorerYields, PoolListEntry, PoolsIndexResponse, PoolYield } from '../src/types'
import { MOCK_V3_POOL, mockYields } from './fixtures/positionsMock'

const ref = (assetId: number, symbol: string): AssetRef => ({ assetId, symbol, name: symbol, decimals: 12, parachainId: null })
const GDOT = ref(69, 'GDOT')
const HDX = ref(0, 'HDX')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

// The pool's own yield (fee and legs) and what its money-market wrapper earns on
// top (the reserve's incentive): the Hydration app rates the pool as the latter.
const OWN: PoolYield = { totalAprPct: 2.5, components: [{ kind: 'stablepool-fee', aprPct: 0.5 }, { kind: 'token-yield', aprPct: 2, asset: ref(15, 'vDOT'), weightPct: 50 }], farms: [] }
const WRAPPED: PoolYield = { ...OWN, totalAprPct: 3.3, components: [...OWN.components, { kind: 'mm-incentive', aprPct: 0.8, asset: GDOT }] }

function yields(): ExplorerYields {
  const y = mockYields()
  return {
    ...y,
    stableswap: { ...y.stableswap, 9690: OWN },
    moneyMarket: { ...y.moneyMarket, core: { ...y.moneyMarket.core, 69: { supplyApyPct: 0, borrowApyPct: null, supplyIncentives: [], borrowIncentives: [], supply: WRAPPED } } },
    shareWrappers: { 9690: { asset: GDOT, marketKey: 'core', named: true } },
  }
}

function render(node: React.ReactNode, y: ExplorerYields | null = yields(), seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient()
  if (y) qc.setQueryData(['explorer-yields'], y)
  seed?.(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('poolHeadline — one rate per pool on every surface', () => {
  it('rates a wrapped stableswap pool as its aToken earns, an unwrapped one by its own yield', () => {
    expect(poolHeadline(yields(), { family: 'stableswap', key: '9690' })).toEqual({ yield: WRAPPED, wrapper: yields().shareWrappers![9690] })
    expect(poolHeadline(yields(), { family: 'stableswap', key: '690' }).yield?.totalAprPct).toBe(7.35)
    expect(poolHeadline(yields(), { family: 'omnipool', key: '5' }).yield?.totalAprPct).toBe(16.02)
  })
  it('reads a wrapper without its reserve yield as unknown, never as the smaller own figure', () => {
    const y = yields()
    delete y.moneyMarket.core[69]
    expect(poolHeadline(y, { family: 'stableswap', key: '9690' }).yield).toBeNull()
  })
  it('works against an API that ships no wrappers yet', () => {
    const y = mockYields()
    expect(poolHeadline(y, { family: 'stableswap', key: '690' }).wrapper).toBeUndefined()
    expect(poolHeadline(null, { family: 'xyk', key: '1' }).yield).toBeNull()
  })
  it('names every reward asset once: farms first, then lending incentives', () => {
    const y: PoolYield = { totalAprPct: 1, components: [{ kind: 'mm-incentive', aprPct: 0.1, asset: HDX }, { kind: 'mm-incentive', aprPct: 0.1, asset: GDOT }], farms: [{ globalFarmId: 1, yieldFarmId: 2, rewardAsset: HDX, aprPct: 1 }] }
    expect(rewardIcons(y).map(a => a.symbol)).toEqual(['HDX', 'GDOT'])
    expect(rewardIcons(null)).toEqual([])
  })
})

describe('PoolApr', () => {
  it('states the total incl. farms with a hover trigger and the reward icons', () => {
    const html = render(<PoolApr family="omnipool" poolKey="5" label="DOT in the Omnipool" />)
    expect(html).toContain('yh-trigger')
    expect(text(html)).toContain('16.0%')
    expect((html.match(/class="asset-logo"/g) ?? []).length).toBe(2)
  })
  it('reads the v3 key case-insensitively and an unknown rate as —', () => {
    const html = render(<PoolApr family="uniswapV3" poolKey={MOCK_V3_POOL.toUpperCase().replace('0X', '0x')} label="v3" />)
    expect(text(html)).toContain('—')
    expect(html).toContain('yh-trigger')
  })
  it('shows a placeholder while the yields load, and — for a pool the yields do not list', () => {
    expect(text(render(<PoolApr family="xyk" poolKey="1000194" label="x" />, null))).toContain('…')
    expect(text(render(<PoolApr family="xyk" poolKey="424242" label="x" />))).toContain('—')
  })
})

describe('Liquidity list APR column', () => {
  const pool = (p: Partial<PoolListEntry> & Pick<PoolListEntry, 'kind' | 'name'>): PoolListEntry =>
    ({ poolId: null, tvlUsd: 1_000, sharePct: null, composition: [], hasPegs: false, ...p })
  const pools = [
    pool({ kind: 'omnipool', name: 'Omnipool', tvlUsd: 9_000 }),
    pool({ kind: 'stableswap', name: 'GDOT', poolId: 9690 }),
    pool({ kind: 'xyk', name: 'HDX / DOT', poolId: 1000194 }),
  ]
  it('rates every pool row and spans the Omnipool\'s assets', () => {
    const html = render(<Liquidity />, yields(), qc => qc.setQueryData<PoolsIndexResponse>(['pools'], { totalTvlUsd: 11_000, pools }))
    expect(html).toContain('>APR</th>')
    expect((html.match(/data-label="APR"/g) ?? []).length).toBe(3)
    const t = text(html)
    expect(t).toContain('9.25%–16.0%')
    expect(t).toContain('3.30%')
    expect(t).toContain('17.4%')
  })
  it('spans only known rates', () => {
    const y = mockYields()
    y.omnipool[7] = { totalAprPct: null, components: [], farms: [] }
    expect(omnipoolAprSpan(y)).toEqual([9.25, 16.02])
    expect(omnipoolAprSpan(undefined)).toBeNull()
  })
})

describe('breakdown lines name what the Hydration app states differently', () => {
  it('marks an ended farm and a past-plan farm, and a scheduled one at full loyalty', () => {
    const y: PoolYield = {
      totalAprPct: 1.5,
      components: [{ kind: 'xyk-fee', aprPct: 0.9 }, { kind: 'farm', aprPct: 0, asset: HDX }, { kind: 'farm', aprPct: 0.6, asset: GDOT }, { kind: 'farm', aprPct: 0, asset: ref(15, 'vDOT') }],
      farms: [
        { globalFarmId: 1, yieldFarmId: 2, rewardAsset: HDX, aprPct: 0, state: 'ended' },
        { globalFarmId: 5, yieldFarmId: 6, rewardAsset: GDOT, aprPct: 0.6, state: 'past-end' },
        { globalFarmId: 7, yieldFarmId: 8, rewardAsset: ref(15, 'vDOT'), aprPct: 0 },
      ],
    }
    expect(poolAprRows(y).filter(r => r.group).map(r => [r.label, r.note])).toEqual([
      ['HDX', 'ended · pot empty'], ['GDOT', 'past planned end · paid, 30D'], ['vDOT', 'full loyalty'],
    ])
  })
  it('names HDX\'s own Omnipool fee and a listed aToken\'s own supply APY', () => {
    const fee: PoolYield = { totalAprPct: 0.77, components: [{ kind: 'omnipool-fee', aprPct: 0.77 }], farms: [] }
    expect(poolAprRows(fee, { assetId: 0, symbol: 'HDX' })[0].note).toContain('the Hydration app shows 0%')
    expect(poolAprRows(fee, { assetId: 5, symbol: 'DOT' })[0].note).toBeUndefined()
    const adot: PoolYield = { totalAprPct: 5.66, components: [{ kind: 'omnipool-fee', aprPct: 4.89 }, { kind: 'mm-supply', aprPct: 0.78, asset: ref(5, 'DOT'), weightPct: 100 }], farms: [] }
    expect(poolAprRows(adot, { assetId: 1001, symbol: 'aDOT' })[1].note).toBe("aDOT's own lending yield · not in the Hydration app")
    // Over a stablepool (GETH) the app counts the supply side: no such note.
    const geth: PoolYield = { ...adot, components: [...adot.components, { kind: 'stablepool-fee', aprPct: 0.2 }] }
    expect(poolAprRows(geth, { assetId: 420, symbol: 'GETH' })[1].note).toBeUndefined()
  })
  it('says an on-chain token yield is not in the Hydration app', () => {
    const bil: PoolYield = { totalAprPct: 8.8, components: [{ kind: 'token-yield', aprPct: 8.6, asset: ref(1000, 'BIL'), weightPct: 50, source: 'on-chain' }], farms: [] }
    expect(poolAprRows(bil)[0].note).toBe('50% of pool · on-chain, 180d · not in the Hydration app')
  })
})

describe('a stableswap pool that is also an Omnipool asset', () => {
  const y = (): ExplorerYields => ({ ...yields(), omnipool: { ...yields().omnipool, 69: { totalAprPct: 6.29, components: [], farms: [] } } })
  it('finds the listing through the wrapper first, then the share', () => {
    expect(omnipoolListingOf(y(), 9690)).toBe(69)
    expect(omnipoolListingOf(y(), 690)).toBe(690)
    expect(omnipoolListingOf(y(), 1000194)).toBeNull()
  })
  it('keeps the pool\'s own APR on /liquidity with the Omnipool rate beneath', () => {
    const pools: PoolListEntry[] = [{ kind: 'stableswap', name: 'GDOT', poolId: 9690, tvlUsd: 1_000, sharePct: null, composition: [], hasPegs: false }]
    const html = render(<Liquidity />, y(), qc => qc.setQueryData<PoolsIndexResponse>(['pools'], { totalTvlUsd: 1_000, pools }))
    const t = text(html)
    expect(t).toContain('3.30%')
    expect(t).toContain('6.29% in Omnipool')
  })
})
