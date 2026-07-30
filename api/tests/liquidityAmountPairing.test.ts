import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIQUIDITY_AMOUNT_ARG, liquidityAmountFromArgs } from '../src/services/explorerService.ts'

const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// A liquidity row displays one amount against one asset_id, and the event arg that
// holds that amount differs per event. A generic presence chain
// (claimed → amount → shares) pairs them wrongly: `shares` is denominated in the
// pool's LP share token, which equals the displayed asset only for Stableswap
// (asset_id = poolId = the share token). XYK.LiquidityRemoved is
// {who, assetA, assetB, shares} — no underlying amount at all — so a fallthrough
// renders share units at assetA's price. Every derivation of the display amount
// (the service's arg map plus both materialized views) must therefore gate its
// `shares` branch on the events whose asset_id IS the share token.
const SHARE_DENOMINATED = Object.entries(LIQUIDITY_AMOUNT_ARG)
  .filter(([, arg]) => arg === 'shares')
  .map(([name]) => name)
  .sort()

// One statement out of the declarative schema, so a `shares` guard belonging to a
// different view can never satisfy the assertions below.
function mvStatement(target: string): string {
  const statement = schema.split(/^CREATE MATERIALIZED VIEW /m).find(s => s.startsWith(target))
  expect(statement, `${target} missing from 003_materialized_views.sql`).toBeTruthy()
  return statement as string
}

// The event names guarding the branch that reads `shares`. A bare
// `JSONHas(args_json, 'shares')` fallthrough yields no guard (or a guard separated
// from the value by another branch's extraction), which fails.
function sharesBranchEvents(statement: string): string[] {
  const at = statement.indexOf("JSONExtractString(args_json, 'shares')")
  expect(at, 'view never reads shares').toBeGreaterThan(-1)
  const guardAt = statement.lastIndexOf('event_name IN (', at)
  expect(guardAt, 'shares is read without an event_name guard').toBeGreaterThan(-1)
  const guard = statement.slice(guardAt, at)
  expect(guard, 'the event_name guard belongs to an earlier branch, not to shares')
    .not.toContain('JSONExtractString(args_json,')
  return [...guard.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1]).sort()
}

describe('liquidity display amount pairing', () => {
  it('decides an amount arg for every event the liquidity read model ingests', () => {
    const ingested = mvStatement('IF NOT EXISTS price_data.liquidity_activity_mv')
    const where = ingested.slice(ingested.lastIndexOf('WHERE event_name IN ('))
    const names = [...where.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1]).sort()

    expect(names.length).toBeGreaterThan(0)
    expect(Object.keys(LIQUIDITY_AMOUNT_ARG).sort()).toEqual(names)
  })

  // Arg shapes as emitted on chain — one per liquidity event name.
  it('reads only the arg denominated in the row\'s displayed asset', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['Omnipool.LiquidityAdded', { who: 'x', assetId: 5, amount: '700', positionId: '1' }, '700'],
      ['Omnipool.LiquidityRemoved', { who: 'x', positionId: '1', assetId: 5, sharesRemoved: '900', fee: '1' }, ''],
      ['Stableswap.LiquidityAdded', { poolId: 102, who: 'x', shares: '800', assets: [] }, '800'],
      ['Stableswap.LiquidityRemoved', { poolId: 102, who: 'x', shares: '800', amounts: [], fee: '1' }, '800'],
      ['XYK.LiquidityAdded', { who: 'x', assetA: 0, assetB: 5, amountA: '600', amountB: '7' }, ''],
      ['XYK.LiquidityRemoved', { who: 'x', assetA: 1000085, assetB: 5, shares: '21174522741' }, ''],
      ['XYK.PoolCreated', { who: 'x', assetA: 0, assetB: 5, initialSharesAmount: '500', shareToken: 9, pool: 'p' }, ''],
      ['OmnipoolLiquidityMining.RewardClaimed', { who: 'x', claimed: '400', rewardCurrency: 0, depositId: '1' }, '400'],
      ['XYKLiquidityMining.RewardClaimed', { who: 'x', claimed: '400', rewardCurrency: 0, depositId: '1' }, '400'],
    ]

    expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(LIQUIDITY_AMOUNT_ARG).sort())
    for (const [name, args, expected] of cases) {
      expect(liquidityAmountFromArgs(name, args), name).toBe(expected)
    }
  })

  it('gates the shares branch of both materialized views on the share-denominated events', () => {
    expect(SHARE_DENOMINATED).toEqual(['Stableswap.LiquidityAdded', 'Stableswap.LiquidityRemoved'])
    expect(sharesBranchEvents(mvStatement('IF NOT EXISTS price_data.liquidity_activity_mv'))).toEqual(SHARE_DENOMINATED)
    expect(sharesBranchEvents(mvStatement('IF NOT EXISTS price_data.account_activity_v3_mv'))).toEqual(SHARE_DENOMINATED)
  })
})
