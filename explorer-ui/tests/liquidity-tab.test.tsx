import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LiquidityTab } from '../src/components/positions/LiquidityTab'
import {
  groupPools, historyRows, liquidityKpis, poolIdentity, positionApr, rewardsEarned, valueWeightedApr,
} from '../src/components/positions/liquidityModel'
import type { LpPosition, PoolYield } from '../src/types'
import {
  MOCK_FARM_REWARDS, MOCK_V3_POOL, mockLiquidityHistory, mockLiquidityPositions, mockLiquidityRewards, mockYields,
} from './fixtures/positionsMock'

const positions = mockLiquidityPositions()
const byId = (id: string): LpPosition => positions.find(p => p.positionId === id)!
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('poolIdentity — the yields map key per venue', () => {
  it('keys Omnipool rows (bare and farmed) by their Omnipool asset', () => {
    expect(poolIdentity(byId('71061'))).toEqual({ family: 'omnipool', key: '5' })
    expect(poolIdentity(byId('71062'))).toEqual({ family: 'omnipool', key: '5' })
    // A stableswap share listed in the Omnipool is an Omnipool position.
    expect(poolIdentity(byId('71100'))).toEqual({ family: 'omnipool', key: '690' })
  })
  it('keys wallet-held stableswap shares by the pool, XYK rows by their LP token', () => {
    expect(poolIdentity(byId('share-690'))).toEqual({ family: 'stableswap', key: '690' })
    expect(poolIdentity(byId('xyk:1000194:farm'))).toEqual({ family: 'xyk', key: '1000194' })
    expect(poolIdentity(byId('xyk:1000194:direct'))).toEqual({ family: 'xyk', key: '1000194' })
  })
  it('keys concentrated liquidity by the lower-case pool address, vaults included', () => {
    const upper = { ...byId('v3:0xd5a1:1'), poolAddress: MOCK_V3_POOL.toUpperCase().replace('0X', '0x') }
    expect(poolIdentity(upper)).toEqual({ family: 'uniswapV3', key: MOCK_V3_POOL })
    expect(poolIdentity(byId('gamma:0xa2b3'))).toEqual({ family: 'uniswapV3', key: MOCK_V3_POOL })
  })
  it('knows nothing about an unknown venue or a malformed XYK id', () => {
    expect(poolIdentity({ ...byId('71061'), venue: 'Mystery' })).toBeNull()
    expect(poolIdentity({ ...byId('xyk:1000194:farm'), positionId: 'xyk:abc' })).toBeNull()
  })
})

describe('groupPools', () => {
  const groups = groupPools(positions, mockYields(), MOCK_FARM_REWARDS)
  it('aggregates by pool, sorted by value, with summed legs incl. H2O', () => {
    expect(groups.map(g => g.id)).toEqual(['omnipool:5', 'omnipool:690', 'uniswapV3:' + MOCK_V3_POOL, 'xyk:1000194', 'stableswap:690'])
    const dot = groups[0]
    expect(dot.positions).toHaveLength(2)
    expect(dot.valueUsd).toBe(9_800)
    expect(dot.venues).toEqual(['Omnipool', 'Omnipool Farm'])
    expect(dot.legs.map(l => [l.asset.symbol, l.raw.toString()])).toEqual([['DOT', '20000000000000'], ['H2O', '190000000000000']])
    const xyk = groups.find(g => g.id === 'xyk:1000194')!
    expect(xyk.label).toBe('HDX / DOT')
    expect(xyk.legs.map(l => l.asset.symbol)).toEqual(['HDX', 'DOT'])
  })
  it('links each pool to its page', () => {
    expect(groups.find(g => g.id === 'omnipool:5')!.to).toBe('/asset/5?tab=liquidity')
    expect(groups.find(g => g.id === 'stableswap:690')!.to).toBe('/pool/690')
    expect(groups.find(g => g.id === 'xyk:1000194')!.to).toBe('/pool/1000194')
    expect(groups.find(g => g.id.startsWith('uniswapV3'))!.to).toBe(`/pool/${MOCK_V3_POOL}`)
  })
  it('counts an unpriced position aloud instead of pricing it at zero', () => {
    const v3 = groups.find(g => g.id.startsWith('uniswapV3'))!
    expect(v3.valueUsd).toBe(1_900)
    expect(v3.unpricedPositions).toBe(1)
  })

  describe('a share wrapped by a money-market aToken (the app\'s "Hydrated" pool)', () => {
    const husdtPool = { assetId: 111, symbol: '2-Pool-HUSDT', name: null, decimals: 18, parachainId: null }
    const husdt = { assetId: 1111, symbol: 'HUSDT', name: 'Hydrated Tether', decimals: 18, parachainId: null }
    const prime = { assetId: 43, symbol: 'PRIME', name: null, decimals: 6, parachainId: null }
    const shares: LpPosition = { positionId: 'share-111', asset: husdtPool, amount: '5', shares: '5', valueUsd: 500, venue: 'Stablepool', wrapper: { asset: husdt, marketKey: 'core', named: true } }
    const own: PoolYield = { totalAprPct: 2.75, components: [{ kind: 'stablepool-fee', aprPct: 1.57 }, { kind: 'mm-supply', aprPct: 1.18, asset: { ...prime, assetId: 10, symbol: 'USDT' }, weightPct: 44 }], farms: [] }
    const wrapped: PoolYield = { totalAprPct: 8.47, components: [...own.components, { kind: 'mm-incentive', aprPct: 5.72, asset: prime }], farms: [] }
    const yields = { ...mockYields(), stableswap: { 111: own }, moneyMarket: { core: { 1111: { supplyApyPct: 0, borrowApyPct: null, supplyIncentives: [{ rewardAsset: prime, aprPct: 5.72 }], borrowIncentives: [], supply: wrapped } } } }

    it('goes by the wrapper and is rated as the wrapper earns, while the shares keep their own rate', () => {
      const [g] = groupPools([shares], yields, null)
      expect(g.id).toBe('stableswap:111')
      expect(g.label).toBe('HUSDT')
      expect(g.icon.assetId).toBe(1111)
      expect(g.wrapper?.asset.symbol).toBe('HUSDT')
      expect(g.yield?.totalAprPct).toBe(8.47)
      expect(g.to).toBe('/pool/111')
      // The row holds unwrapped 2-Pool-HUSDT shares: the legs and the position rate say so.
      expect(g.legs.map(l => l.asset.symbol)).toEqual(['2-Pool-HUSDT'])
      expect(g.positions[0].apr.total).toBe(2.75)
      expect(g.positions[0].apr.note).toContain('paid on HUSDT')
      expect(liquidityKpis([g], null, null).apr.pct).toBe(2.75)
    })
    it('keeps the pool\'s own name when the wrapper does not name it (a3-Pool over 3-Pool), still rated as the wrapper', () => {
      const threePool = { ...shares, positionId: 'share-103', asset: { ...husdtPool, assetId: 103, symbol: '3-Pool' }, wrapper: { asset: { ...husdt, assetId: 1008, symbol: 'a3-Pool' }, marketKey: 'core', named: false } }
      const y = { ...yields, moneyMarket: { core: { 1008: yields.moneyMarket.core[1111] } } }
      const [g] = groupPools([threePool], y, null)
      expect(g.label).toBe('3-Pool')
      expect(g.icon.assetId).toBe(103)
      expect(g.yield?.totalAprPct).toBe(8.47)
    })
    it('reads an unknown headline, never the shares\' own rate, when the yields lack the wrapper', () => {
      const [g] = groupPools([shares], { ...yields, moneyMarket: {} }, null)
      expect(g.yield).toBeNull()
      expect(g.positions[0].apr.total).toBe(2.75)
    })
  })
})

describe('positionApr — fees plus farms at the entry\'s loyalty', () => {
  const y = mockYields()
  const farmItems = MOCK_FARM_REWARDS.items!
  it('adds each live farm at farm APR × loyalty for a farmed Omnipool NFT', () => {
    const p = byId('71062')
    const apr = positionApr(p, y.omnipool['5'], farmItems.filter(i => i.positionId === '71062'))
    expect(apr.total).toBeCloseTo(4.12 + 9.8 * 0.625 + 2.1 * 0.625, 6)
    expect(apr.rows.filter(r => r.group === 'Farm rewards').map(r => r.note)).toEqual(['62.5% loyalty', '62.5% loyalty'])
  })
  it('gives a bare position the fee side only, never the pool\'s farm APR', () => {
    expect(positionApr(byId('71061'), y.omnipool['5'], []).total).toBeCloseTo(4.12, 6)
    expect(positionApr(byId('71100'), y.omnipool['690'], []).total).toBeCloseTo(1.9 + 0.85 + 5.6 + 0.9, 6)
  })
  it('makes the total unknown when a term is unknown', () => {
    // No pool yield at all.
    expect(positionApr(byId('71061'), null, []).total).toBeNull()
    // A null component.
    expect(positionApr(byId('v3:0xd5a1:1'), y.uniswapV3[MOCK_V3_POOL], []).total).toBeNull()
    // A farmed row whose entries are unavailable (stale rewards snapshot).
    const stale = positionApr(byId('71062'), y.omnipool['5'], [])
    expect(stale.total).toBeNull()
    expect(stale.note).toMatch(/unavailable/)
    // An entry in a farm the yields do not list.
    const unlisted = positionApr(byId('71062'), y.omnipool['5'], [{ ...farmItems[0], yieldFarmId: 99 }])
    expect(unlisted.total).toBeNull()
    // Deposits in one farm at different loyalty.
    const mixed: PoolYield = y.xyk['1000194']
    const xyk = byId('xyk:1000194:farm')
    const e = farmItems.find(i => i.positionId === xyk.positionId)!
    expect(positionApr(xyk, mixed, [e, { ...e, depositId: '9003', loyaltyPct: 80 }]).total).toBeNull()
    expect(positionApr(xyk, mixed, [e]).total).toBeCloseTo(3.4 + 14 * 0.3, 6)
  })
  it('lets a stopped farm add nothing without making the rate unknown', () => {
    const p = byId('71062')
    const stopped = farmItems.filter(i => i.positionId === '71062').map(i => ({ ...i, farmState: 'stopped' as const }))
    expect(positionApr(p, mockYields().omnipool['5'], stopped).total).toBeCloseTo(4.12, 6)
  })
})

describe('valueWeightedApr and the KPI strip', () => {
  it('weights by value over the positions with a known rate and states coverage', () => {
    const w = valueWeightedApr([{ valueUsd: 100, apr: 10 }, { valueUsd: 300, apr: 20 }, { valueUsd: 600, apr: null }, { valueUsd: null, apr: 50 }])
    expect(w.pct).toBeCloseTo(17.5, 6)
    expect(w.coveredUsd).toBe(400)
    expect(w.totalUsd).toBe(1_000)
    expect(valueWeightedApr([{ valueUsd: 10, apr: null }]).pct).toBeNull()
  })
  it('counts unclaimed rewards priced and payable only, the rest aloud', () => {
    const k = liquidityKpis(groupPools(positions, mockYields(), MOCK_FARM_REWARDS), MOCK_FARM_REWARDS, mockLiquidityRewards())
    expect(k.valueUsd).toBe(16_520)
    expect(k.inFarmsUsd).toBe(3_620 + 840)
    expect(k.inFarmsUnpriced).toBe(0)
    expect(k.unclaimed.usd).toBeCloseTo(276.15, 6)
    expect(k.unclaimed.unpayable).toBe(1)
    expect(k.claimedUsd).toBe(5_728.6)
    // v3 (unknown rate) and the unpriced vault are outside the weighting.
    expect(k.apr.coveredUsd).toBe(16_520 - 1_900)
    expect(k.apr.pct).not.toBeNull()
  })
})

describe('rewardsEarned and historyRows', () => {
  it('joins claimed and claimable-now per pool × reward asset', () => {
    const rows = rewardsEarned(mockLiquidityRewards(), MOCK_FARM_REWARDS, positions)
    const dotHdx = rows.find(r => r.key === 'omnipool:5:0')!
    expect(dotHdx.claimedUsd).toBe(4_870.2)
    expect(dotHdx.unclaimedUsd).toBe(270.82)
    const xyk = rows.find(r => r.key === 'xyk:1000194:0')!
    // The XYK pool reads as its pair, and a below-ED entry is unpayable, not priced.
    expect(xyk.pool.symbol).toBe('HDX / DOT')
    expect(xyk.unclaimedUsd).toBe(0)
    expect(xyk.unclaimedUnpayable).toBe(1)
    expect(xyk.claimedUnpriced).toBe(1)
    // A closed pool keeps its claimed row.
    expect(rows.some(r => r.key === 'omnipool:16:0')).toBe(true)
  })
  it('counts an unpriced farmed position aloud in the In farms KPI', () => {
    const ps = positions.map(p => (p.positionId === '71062' ? { ...p, valueUsd: null } : p))
    const k = liquidityKpis(groupPools(ps, mockYields(), MOCK_FARM_REWARDS), MOCK_FARM_REWARDS, null)
    expect(k.inFarmsUsd).toBe(840)
    expect(k.inFarmsUnpriced).toBe(1)
  })
  it('keeps unclaimed entries whose position has no LP row, so the table agrees with the KPI', () => {
    // Neither farmed position is listed any more (a delisted asset).
    const ps = positions.filter(p => p.positionId !== '71062' && p.positionId !== 'xyk:1000194:farm')
    const rows = rewardsEarned(null, MOCK_FARM_REWARDS, ps)
    const unknown = rows.filter(r => r.pallet === 'omnipool')
    expect(unknown.map(r => r.pool.symbol)).toEqual(['Unknown pool', 'Unknown pool'])
    expect(unknown.reduce((s, r) => s + r.unclaimedUsd, 0)).toBeCloseTo(270.82 + 5.33, 6)
    // The XYK entry's id names its LP token; the other XYK row still reads as the pair.
    const xyk = rows.find(r => r.pallet === 'xyk')!
    expect(xyk.key).toBe('xyk:1000194:0')
    expect(xyk.pool.symbol).toBe('HDX / DOT')
    expect(xyk.unclaimedUnpayable).toBe(1)
    // With the claimed history, the XYK row is the claimed one's.
    const withClaims = rewardsEarned(mockLiquidityRewards(), MOCK_FARM_REWARDS, [])
    expect(withClaims.filter(r => r.key === 'xyk:1000194:0')).toHaveLength(1)
  })
  it('lists history newest first with open/closed spans and the last value', () => {
    const rows = historyRows(mockLiquidityHistory().positions)
    expect(rows[0].openedBlock).toBeGreaterThanOrEqual(rows[1].openedBlock!)
    const gamma = rows.find(r => r.positionId === 'gamma:0xa2b3')!
    expect(gamma.active).toBe(true)
    expect(gamma.lastValueUsd).toBeNull()
    expect(gamma.poolLabel).toBe('DOT / HOLLAR')
    const glmr = rows.find(r => r.positionId === '60001')!
    expect(glmr.active).toBe(false)
    expect(glmr.venue).toBe('Omnipool Farm')
    expect(glmr.closedAt).not.toBeNull()
    expect(rows.find(r => r.venue === 'Stablepool')!.poolLabel).toBe('2-Pool-GDOT')
  })
})

describe('LiquidityTab markup', () => {
  const address = '1L53bUTBopXqDXSXjBdQXFV7jZ8FtdRZS5JoMjGq5z3Cv2zr'
  const render = (ps: LpPosition[], showOwner = false) => {
    const qc = new QueryClient()
    qc.setQueryData(['explorer-yields'], mockYields())
    qc.setQueryData(['liquidity-rewards', 'account', address], mockLiquidityRewards())
    qc.setQueryData(['liquidity-history', 'account', address], mockLiquidityHistory())
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <LiquidityTab scope={{ kind: 'account', address }} positions={ps} farmRewards={MOCK_FARM_REWARDS} showOwner={showOwner} />
      </QueryClientProvider>,
    )
  }
  it('renders the KPI strip, pools expanded by default, and the history sections', () => {
    const html = render(positions)
    const t = text(html)
    expect(t).toContain('LP value')
    expect(t).toContain('Claimed all-time')
    expect(t).toMatch(/of \$14\.6k/)
    expect((html.match(/class="lpt-pos"/g) ?? []).length).toBe(8)
    expect(html).toContain('aria-expanded="true"')
    expect(t).toContain('Collapse all')
    expect(t).toContain('Rewards earned')
    expect(t).toContain('Position history · 32')
    expect(t).toContain('3 older positions not listed')
  })
  it('collapses by default past 12 positions', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...byId('71061'), positionId: String(80_000 + i) }))
    const html = render(many)
    expect((html.match(/class="lpt-pos"/g) ?? []).length).toBe(0)
    expect(text(html)).toContain('Expand all')
  })
  it('names the owner of NFT positions on tags', () => {
    expect(render(mockLiquidityPositions(true), true)).toContain('Owner')
  })
})
