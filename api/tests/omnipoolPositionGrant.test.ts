import { describe, expect, it } from 'vitest'
import {
  liqActionFor,
  liquidityActionEventNames,
  liquidityCandidateArgs,
  routerHopLiquiditySql,
  suppressPositionCreatedCompanions,
} from '../src/services/explorerService.ts'

// A token listing seeds the Omnipool through `add_token`, which mints the seed
// position NFT to a designated owner and emits Omnipool.PositionCreated WITHOUT
// an Omnipool.LiquidityAdded — the only path that creates an LP position with no
// LiquidityAdded row. On every user add_liquidity the two events are companions
// in the same block, so PositionCreated is renderable ONLY when no LiquidityAdded
// in its block names the same owner and asset; otherwise every add would render
// twice. 40 listing grants and 81 scheduler-dispatched companions exist chain-wide.

// Args exactly as emitted at block 7,031,549 (the KSM listing).
const GRANT_ARGS = {
  positionId: '41255',
  owner: '0xb0a515ef5ef6d725a227223c279f000bda1f19ddcfd011ff5132b82ea651dbb6',
  asset: 1000771,
  amount: '33330998934753390',
  shares: '33330998934753390',
  price: '748993616069613000',
}

describe('omnipool listing-grant positions', () => {
  it('classifies Omnipool.PositionCreated as an Add liquidity action', () => {
    expect(liquidityActionEventNames('Add')).toContain('Omnipool.PositionCreated')
    expect(liqActionFor('Omnipool.PositionCreated')).toBe('Add')
  })

  it('reads the grant owner, asset and amount from the event args', () => {
    expect(liquidityCandidateArgs('Omnipool.PositionCreated', GRANT_ARGS)).toEqual({
      who: '0xb0a515ef5ef6d725a227223c279f000bda1f19ddcfd011ff5132b82ea651dbb6',
      asset_id: 1000771,
      asset_b: 0,
      pool_acc: '',
      amount: '33330998934753390',
    })
  })

  it('keeps the existing who/asset extraction for the other liquidity events', () => {
    expect(liquidityCandidateArgs('Omnipool.LiquidityAdded', { who: 'w', assetId: 5, amount: '700', positionId: '1' })).toEqual({
      who: 'w', asset_id: 5, asset_b: 0, pool_acc: '', amount: '700',
    })
    expect(liquidityCandidateArgs('XYK.PoolCreated', { who: 'w', assetA: 0, assetB: 5, initialSharesAmount: '500', shareToken: 9, pool: 'p' })).toEqual({
      who: 'w', asset_id: 0, asset_b: 5, pool_acc: 'p', amount: '',
    })
  })

  it('suppresses a PositionCreated whose block holds its LiquidityAdded companion', () => {
    const added = { event_name: 'Omnipool.LiquidityAdded', block_height: 100, who: '0xabc', asset_id: 5 }
    const companion = { event_name: 'Omnipool.PositionCreated', block_height: 100, who: '0xabc', asset_id: 5 }
    const grant = { event_name: 'Omnipool.PositionCreated', block_height: 100, who: '0xdef', asset_id: 5 }
    expect(suppressPositionCreatedCompanions([added, companion, grant])).toEqual([added, grant])
  })

  it('never suppresses across blocks or assets', () => {
    const added = { event_name: 'Omnipool.LiquidityAdded', block_height: 100, who: '0xabc', asset_id: 5 }
    const otherBlock = { event_name: 'Omnipool.PositionCreated', block_height: 101, who: '0xabc', asset_id: 5 }
    const otherAsset = { event_name: 'Omnipool.PositionCreated', block_height: 100, who: '0xabc', asset_id: 9 }
    expect(suppressPositionCreatedCompanions([added, otherBlock, otherAsset])).toEqual([added, otherBlock, otherAsset])
  })

  it('keeps the SQL companion lookup block-complete under an event-granular page bound', () => {
    // The deep walk cuts inside a block at an event index. A companion
    // LiquidityAdded lives at a DIFFERENT index of the candidate's own block,
    // so the LiquidityAdded scan must never inherit the row bound verbatim —
    // it is bounded by the blocks holding a bound-admitted PositionCreated.
    const bound = '(1) AND (block_height < 100 OR (block_height = 100 AND event_index < 25))'
    const { predicateSql } = routerHopLiquiditySql(bound)
    // The LiquidityAdded scan carries no row bound of its own — only the
    // block-set membership test.
    expect(predicateSql).toMatch(/WHERE event_name = 'Omnipool\.LiquidityAdded'\s+AND block_height IN \(/)
    // The row bound appears exactly once: on the PositionCreated block set,
    // where it mirrors what the outer query admits.
    const boundUses = predicateSql.split('event_index < 25').length - 1
    expect(boundUses).toBe(1)
    expect(predicateSql).toMatch(/event_index < 25\)\) AND event_name = 'Omnipool\.PositionCreated'/)
  })
})
