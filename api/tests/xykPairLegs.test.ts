import { beforeEach, describe, expect, it } from 'vitest'
import { getExtrinsicActivity, initExplorerService, xykPairLegs, type ActivityRow } from '../src/services/explorerService.ts'
import { resetCacheForTests } from '../src/services/cache.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

// An XYK add or remove moves both of the pair's assets, and its event states
// neither amount in the row's denomination. The row therefore carries the shape a
// pool creation has — assetA's leg as `asset`/`amount` and `assetIn`/`amountIn`,
// assetB's as `assetOut`/`amountOut` — recovered from the pool↔who transfer legs of
// its own extrinsic. Read as a single-leg event, an add rendered with an empty
// amount and no value (its legs run who→pool, the payout direction's opposite) and
// a removal stated assetA alone, at half its value.

const WHO = `0x${'c3'.repeat(32)}`
const POOL = `0x${'d4'.repeat(32)}`
const TREASURY_POT = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const TS = '2026-09-24 22:14:18'
const DOT = 5
const MYTH = 30
const EWT = 252525
const HDX = 0

const event = (blockHeight: number, extrinsicIndex: number, eventIndex: number, eventName: string, args: Record<string, unknown>) => ({
  block_height: blockHeight, ts: TS, event_index: eventIndex, extrinsic_index: extrinsicIndex,
  event_name: eventName, call_address: '', args_json: JSON.stringify(args),
})
const leg = (blockHeight: number, extrinsicIndex: number, eventIndex: number, assetId: number, from: string, to: string, amount: string) => ({
  block_height: blockHeight, event_index: eventIndex, extrinsic_index: extrinsicIndex,
  asset_id: assetId, from_account: from, to_account: to, amount,
})

// The extrinsic's own events, and the transfer legs fillMissingLiquidityAmounts
// reads for them; every other read (prices, closes, tags) answers empty.
function fakeClient(events: Record<string, unknown>[], legs: Record<string, unknown>[]): ClickHouseClient {
  return {
    query: async (opts: { query: string }) => ({
      json: async () => {
        if (opts.query.includes('FROM price_data.raw_events') && opts.query.includes('args_json') && opts.query.includes('extrinsic_index = {i:UInt32}')) return events
        if (opts.query.includes('FROM price_data.transfer_activity_by_time')) return legs
        return []
      },
    }),
  } as unknown as ClickHouseClient
}

const liquidityRows = async (height: number, index: number): Promise<ActivityRow[]> =>
  (await getExtrinsicActivity(height, index, { revenue: false })).filter(r => r.type === 'liquidity')

describe('the extrinsic page renders an XYK add or remove with both legs', () => {
  beforeEach(() => resetCacheForTests())

  it('an add: assetA and assetB from the who→pool deposits, past the LP-token existential deposit', async () => {
    // HDX-paired, so the deposit the Treasury takes for endowing the LP-token account
    // is the nearest preceding HDX leg from `who` — and never the pool's.
    initExplorerService(fakeClient(
      [event(900_400, 3, 24, 'XYK.LiquidityAdded', { who: WHO, assetA: HDX, assetB: DOT, amountA: '5000', amountB: '700' })],
      [
        leg(900_400, 3, 13, HDX, WHO, POOL, '5000'),
        leg(900_400, 3, 15, DOT, WHO, POOL, '700'),
        leg(900_400, 3, 17, HDX, WHO, TREASURY_POT, '1100000000000'),
      ],
    ))
    const rows = await liquidityRows(900_400, 3)

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.liqAction).toBe('Add')
    expect(row.asset?.assetId).toBe(HDX)
    expect(row.amount).toBe('5000')
    expect(row.assetIn?.assetId).toBe(HDX)
    expect(row.assetOut?.assetId).toBe(DOT)
    expect(row.amountIn).toBe('5000')
    expect(row.amountOut).toBe('700')
  })

  it('a removal: assetA and assetB from the pool→who payouts', async () => {
    initExplorerService(fakeClient(
      [event(900_401, 2, 44, 'XYK.LiquidityRemoved', { who: WHO, assetA: DOT, assetB: MYTH, shares: '5555145712702' })],
      [
        leg(900_401, 2, 35, DOT, POOL, WHO, '1616158587135'),
        leg(900_401, 2, 37, MYTH, POOL, WHO, '59603890213654510857286'),
        leg(900_401, 2, 41, HDX, TREASURY_POT, WHO, '1000000000000'),
      ],
    ))
    const rows = await liquidityRows(900_401, 2)

    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.liqAction).toBe('Remove')
    expect(row.asset?.assetId).toBe(DOT)
    expect(row.amount).toBe('1616158587135')
    expect(row.assetIn?.assetId).toBe(DOT)
    expect(row.assetOut?.assetId).toBe(MYTH)
    expect(row.amountIn).toBe('1616158587135')
    expect(row.amountOut).toBe('59603890213654510857286')
  })

  it('a pair with an unrecovered leg names both assets, states the one amount and no value', async () => {
    initExplorerService(fakeClient(
      [event(900_402, 2, 44, 'XYK.LiquidityRemoved', { who: WHO, assetA: DOT, assetB: MYTH, shares: '5555145712702' })],
      [leg(900_402, 2, 35, DOT, POOL, WHO, '1616158587135')],
    ))
    const rows = await liquidityRows(900_402, 2)

    expect(rows).toHaveLength(1)
    expect(rows[0].assetOut?.assetId).toBe(MYTH)
    expect(rows[0].amountIn).toBe('1616158587135')
    expect(rows[0].amountOut).toBeNull()
    expect(rows[0].valueUsd).toBeNull()
  })

  it('an unrecovered add keeps its empty amount rather than a phantom value', async () => {
    initExplorerService(fakeClient(
      [event(900_403, 3, 24, 'XYK.LiquidityAdded', { who: WHO, assetA: EWT, assetB: DOT, amountA: '74998035088573853375', amountB: '194266520234' })],
      [],
    ))
    const rows = await liquidityRows(900_403, 3)

    expect(rows).toHaveLength(1)
    expect(rows[0].amountIn).toBeNull()
    expect(rows[0].amountOut).toBeNull()
    expect(rows[0].valueUsd).toBeNull()
  })
})

describe('xykPairLegs', () => {
  const dot = { assetId: DOT, iconAssetId: DOT, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachainId: null, origin: null }
  const base = (): ActivityRow => ({
    type: 'liquidity', blockHeight: 1, timestamp: TS, eventIndex: 1, extrinsicIndex: 1,
    who: null, to: null, asset: dot, amount: '1616158587135', assetIn: null, assetOut: null,
    amountIn: null, amountOut: null, valueUsd: 160, liqAction: 'Remove',
  })

  it('leaves every other liquidity event single-legged', () => {
    const row = base()
    xykPairLegs(row, { event_name: 'Omnipool.LiquidityRemoved', asset_b: 0 })
    expect(row).toEqual(base())
  })

  it('drops the construction-time single-leg value, so a half never survives on the wire', () => {
    const row = base()
    xykPairLegs(row, { event_name: 'XYK.LiquidityRemoved', asset_b: MYTH, amount_b: '59603890213654510857286' })
    expect(row.valueUsd).toBeNull()
    expect(row.assetIn).toBe(row.asset)
    expect(row.assetOut?.assetId).toBe(MYTH)
    expect(row.amountOut).toBe('59603890213654510857286')
  })
})
