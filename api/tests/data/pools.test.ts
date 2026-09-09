import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { loadExplorerAssets } from '../../src/services/explorerAssets.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'
import { encodeAddress } from '@polkadot/util-crypto'

// Contract tests for /v1/pools*: the snapshot (with the delisted flag), the
// three histories, fill pages under the parametric trades route, and volumes.

type Row = Record<string, unknown>

const XYK_POOL = '0xb941ce809e9793289c9e9127102d447723cabdfb9d51d0893f2bdbf9958995ce'
const XYK_POOL_SS58 = encodeAddress(XYK_POOL, 0)
const SWAPPER = `0x${'55'.repeat(32)}`
const SWAPPER_SS58 = encodeAddress(SWAPPER, 0)
const PLACEHOLDER = '0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a'

// The per-block pool snapshot at the head: exactly the pools live at that
// block. Stableswap pool 100 uses the legacy one-byte-per-asset encoding
// ("0x0a16" = [10, 22]); pool 690 the array form.
const SNAPSHOT_ROW: Row = {
  block_height: 13931400,
  ts: '2026-08-28 12:00:00',
  payload_json: JSON.stringify({
    omnipool: { assets: [{ asset_id: 5, reserve: '111', hub_reserve: '222', shares: '333', protocol_shares: '44', cap: '1', tradable: 15 }] },
    stableswap: { pools: [
      { pool_id: 100, assets: '0x0a16', reserves: ['1000', '2000'], amplification: '320', fee: 200, total_issuance: '3000', initial_amplification: 320, final_amplification: 320, initial_block: 1, final_block: 1 },
      { pool_id: 690, assets: [15, 1001], reserves: ['5', '6'], amplification: '100', fee: 300, total_issuance: '11', initial_amplification: 100, final_amplification: 100, initial_block: 2, final_block: 2 },
    ] },
    xyk: { pools: [{ pool_account: XYK_POOL, asset_a: 1000085, asset_b: 5, reserve_a: '556', reserve_b: '778' }] },
  }),
}
const snapshotHandler = (query: string) => (query.includes('-- data:pools:snapshot') ? [SNAPSHOT_ROW] : undefined)

function legRow(overrides: Row): Row {
  return {
    venue: 'omnipool', pool_key: 'omnipool', block_height: 100, event_index: 5, leg_index: 0, leg_kind: 'in',
    asset_id: 5, amount: '1000', fee_dest: '', fee_recipient: '', swapper: SWAPPER, op_key: '77',
    extrinsic_index: 2, ts: '2026-08-20 10:00:00', ingested_at: '2026-08-20 10:00:05',
    ...overrides,
  }
}

let app: FastifyInstance | undefined

// The v3 distribution scales its prices by the tokens' decimals, so the shared
// registry snapshot has to hold them (aDOT 10, HOLLAR 18).
beforeAll(async () => {
  await loadExplorerAssets(fakeDataClient(
    query => (query.includes('FROM price_data.assets FINAL')
      ? [
          { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
          { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
        ]
      : undefined),
    query => (query.includes('Bonds.TokenCreated') ? [] : undefined),
  ) as unknown as ClickHouseClient)
})

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/pools', () => {
  it('assembles the three venues from the per-block snapshot at the head', async () => {
    const client = fakeDataClient(
      snapshotHandler,
      query => (query.includes('-- data:pools:xyk-registry') ? [{ pool_account: XYK_POOL, lp_asset_id: 1000086 }] : undefined),
      // The concentrated-liquidity pools come from their own projection; a chain
      // without one answers an empty list, not an absent field.
      query => (query.includes('-- data:pools:uniswapv3') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.uniswapV3).toEqual([])
    // ClickHouse wants the alias BEFORE FINAL (`t AS p FINAL`); the other order is a
    // syntax error that turned the whole /v1/pools answer into a 500.
    const v3Query = client.query.mock.calls.map(c => (c[0] as { query: string }).query).find(q => q.includes('-- data:pools:uniswapv3\n'))
    expect(v3Query).toContain('FROM price_data.uniswap_v3_pools AS p FINAL')
    expect(body.omnipool).toEqual([
      { assetId: '5', reserve: '111', hubReserve: '222', shares: '333', protocolShares: '44', blockHeight: 13931400 },
    ])
    // Both stableswap asset-id encodings decode.
    expect(body.stableswap).toEqual([
      { poolId: '100', assetIds: ['10', '22'], reserves: ['1000', '2000'], amplification: 320, feePermill: 200, totalIssuance: '3000', blockHeight: 13931400 },
      { poolId: '690', assetIds: ['15', '1001'], reserves: ['5', '6'], amplification: 100, feePermill: 300, totalIssuance: '11', blockHeight: 13931400 },
    ])
    expect(body.xyk[0]).toMatchObject({
      poolAccount: { address: XYK_POOL_SS58, accountIdHex: XYK_POOL },
      lpAssetId: '1000086', assetA: '1000085', reserveB: '778', blockHeight: 13931400,
    })
    // One point read serves all three venues.
    expect(client.seen.filter(s => s.query.includes('-- data:pools:snapshot'))).toHaveLength(1)
    expect(client.seen[client.seen.length - 1].query).not.toMatch(/omnipool_pool_state_history|xyk_pool_reserve_history/)
  })
})

describe('pool histories', () => {
  it('pages omnipool history by block cursor', async () => {
    app = await freshDataApp(fakeDataClient(
      (query, params) => {
        if (!query.includes('-- data:pools:omnipool-history')) return undefined
        const rows = [13931400, 13930800, 13930200]
          .filter(b => params.cb == null || b < Number(params.cb))
          .map(b => ({ block_height: b, ts: '2026-08-20 10:00:00', reserve_raw: '1', hub_reserve_raw: '2', shares_raw: '3', protocol_shares_raw: '4', spec_version: 440, ingested_at: 'x' }))
        return rows
      },
    ))
    const first = await app.inject({ url: '/v1/pools/omnipool/5/history?limit=2', headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([13931400, 13930800])
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/pools/omnipool/5/history?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([13930200])
  })

  it('404s an asset that was never in the Omnipool, with the enumeration hint', async () => {
    app = await freshDataApp(fakeDataClient(
      query => (query.includes('-- data:pools:omnipool-history') ? [] : undefined),
      snapshotHandler,
    ))
    const res = await app.inject({ url: '/v1/pools/omnipool/424242/history', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toBe('list Omnipool assets via /v1/pools')
  })

  it('states active liquidity as the open ranges straddling the tick, not the last swap\'s field', async () => {
    const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
    const client = fakeDataClient(
      snapshotHandler,
      query => (query.includes('-- data:pools:xyk-registry') ? [] : undefined),
      query => (query.includes('-- data:pools:uniswapv3-active-liquidity')
        ? [{ pool: POOL, liquidity: '4504017577969432095' }]
        : undefined),
      query => (query.includes('-- data:pools:uniswapv3')
        ? [{ pool: POOL, token0: '0x02639ec01313c8775fae74f2dad1118c8a8a86da', token1: '0x531a654d1696ed52e7275a8cede955e82620f99a', asset0: 1001, asset1: 222, fee: 3000, tick_spacing: 60, created_block: 14359646, sqrt_price: '862203316974439708502410565924684', tick: 185907, swaps: 2, priced_rows: 3, last_block: 14404139 }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools', headers: AUTH })
    expect(res.statusCode).toBe(200)
    // The pool's last swap crossed out of its only range and reported 0; the range still stands.
    expect(res.json().uniswapV3).toEqual([
      { pool: POOL, token0: '0x02639ec01313c8775fae74f2dad1118c8a8a86da', token1: '0x531a654d1696ed52e7275a8cede955e82620f99a', asset0: '1001', asset1: '222', fee: 3000, tickSpacing: 60, sqrtPriceX96: '862203316974439708502410565924684', tick: 185907, liquidity: '4504017577969432095', createdBlock: 14359646, blockHeight: 14404139 },
    ])
  })

  it('serves one pool\'s liquidity distribution: ticks, segments and the ranges behind them', async () => {
    const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
    const VAULT = '0xa206d0959813f17c17c87147271c49065438648a'
    const client = fakeDataClient(
      query => (query.includes('-- v3:liquidity:ranges')
        ? [{ owner: VAULT, tick_lower: 184860, tick_upper: 186840, net: '4504017577969432095', mints: 2 }]
        : undefined),
      query => (query.includes('-- v3:liquidity:state')
        ? [{ tick: 185907, sqrt: '862203316974439708502410565924684', priced: 3, last_block: 14404139, n: 193 }]
        : undefined),
      query => (query.includes('-- data:pools:uniswapv3')
        ? [{ pool: POOL, token0: '0x02639ec01313c8775fae74f2dad1118c8a8a86da', token1: '0x531a654d1696ed52e7275a8cede955e82620f99a', asset0: 1001, asset1: 222, fee: 3000, tick_spacing: 60, created_block: 14359646, sqrt_price: '862203316974439708502410565924684', tick: 185907, swaps: 2, priced_rows: 3, last_block: 14404139 }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/pools/uniswapv3/${POOL.toUpperCase().replace('0X', '0x')}/liquidity`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ pool: POOL, asset0: '1001', asset1: '222', fee: 3000, tickSpacing: 60, tick: 185907, liquidity: '4504017577969432095', blockHeight: 14404139 })
    expect(body.ticks.map((t: { tick: number; liquidityNet: string; liquidityGross: string }) => [t.tick, t.liquidityNet, t.liquidityGross])).toEqual([
      [184860, '4504017577969432095', '4504017577969432095'],
      [186840, '-4504017577969432095', '4504017577969432095'],
    ])
    // Both tokens are registry assets, so every tick carries its price.
    expect(body.ticks[0].price).toBe('1.06651360727')
    expect(body.segments).toHaveLength(1)
    // The price sits inside the range, so it holds both tokens.
    expect(BigInt(body.segments[0].amount0) > 0n && BigInt(body.segments[0].amount1) > 0n).toBe(true)
    expect(body.ranges).toEqual([
      { owner: VAULT, tickLower: 184860, tickUpper: 186840, priceLower: '1.06651360727', priceUpper: '1.30002711029', liquidity: '4504017577969432095', amount0: body.segments[0].amount0, amount1: body.segments[0].amount1, positions: 2, inRange: true },
    ])
    // The pool key is lower-cased before it is bound.
    for (const seen of client.seen.filter(x => x.query.includes('-- v3:liquidity:'))) expect(seen.params.pool).toBe(POOL)
  })

  it('404s a contract that is no concentrated-liquidity pool, with the enumeration hint', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:pools:uniswapv3') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools/uniswapv3/0x1111111111111111111111111111111111111111/liquidity', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toBe('list the concentrated-liquidity pools via /v1/pools (uniswapV3)')
  })

  it('pages a Uniswap v3 pool history per swap on the position cursor', async () => {
    const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
    const client = fakeDataClient(
      (query, params) => {
        if (!query.includes('-- data:pools:uniswapv3-history')) return undefined
        const rows = [
          { block_height: 14397741, event_index: 14, ts: '2026-09-09 09:44:24', event_name: 'Swap', sqrt_price: '8296', tick: 185842, liq: '6653831914530704', amount0_s: '-1124332283', amount1_s: '132942843369061750', ingested_at: 'x' },
          { block_height: 14395782, event_index: 34, ts: '2026-09-09 08:30:30', event_name: 'Swap', sqrt_price: '8295', tick: 185060, liq: '5534876290645021', amount0_s: '-421811245', amount1_s: '46181299507238469', ingested_at: 'x' },
          { block_height: 14359650, event_index: 3, ts: '2026-09-08 10:37:30', event_name: 'Initialize', sqrt_price: '8290', tick: 184990, liq: '0', amount0_s: '0', amount1_s: '0', ingested_at: 'x' },
        ]
        return rows.filter(r => params.cb == null || r.block_height < Number(params.cb) || (r.block_height === Number(params.cb) && r.event_index < Number(params.ci)))
      },
    )
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/pools/uniswapv3/${POOL.toUpperCase().replace('0X', '0x')}/history?limit=2`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items).toEqual([
      { blockHeight: 14397741, eventIndex: 14, timestamp: '2026-09-09T09:44:24.000Z', eventName: 'Swap', sqrtPriceX96: '8296', tick: 185842, liquidity: '6653831914530704', amount0: '-1124332283', amount1: '132942843369061750' },
      { blockHeight: 14395782, eventIndex: 34, timestamp: '2026-09-09T08:30:30.000Z', eventName: 'Swap', sqrtPriceX96: '8295', tick: 185060, liquidity: '5534876290645021', amount0: '-421811245', amount1: '46181299507238469' },
    ])
    expect(page1.hasMore).toBe(true)
    // The pool key is lower-cased before it is bound.
    const read = client.seen.find(s => s.query.includes('-- data:pools:uniswapv3-history'))!
    expect(read.params.pool).toBe(POOL)
    expect(read.query).toContain("kind = 'pool' AND event_name IN ('Swap', 'Initialize')")
    const second = await app.inject({ url: `/v1/pools/uniswapv3/${POOL}/history?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    // Initialize carries the starting price only.
    expect(second.json().items).toEqual([
      { blockHeight: 14359650, eventIndex: 3, timestamp: '2026-09-08T10:37:30.000Z', eventName: 'Initialize', sqrtPriceX96: '8290', tick: 184990, liquidity: null, amount0: null, amount1: null },
    ])
    expect(second.json().hasMore).toBe(false)
    expect(second.headers['cache-control']).toBe('private, max-age=30')
  })

  it('404s an unknown Uniswap v3 pool and 400s a key that is not a contract address', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:pools:uniswapv3-history') ? [] : undefined),
      query => (query.includes('-- data:pools:uniswapv3') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const missing = await app.inject({ url: `/v1/pools/uniswapv3/0x${'ab'.repeat(20)}/history`, headers: AUTH })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.context.hint).toMatch(/\/v1\/pools/)
    const bad = await app.inject({ url: '/v1/pools/uniswapv3/notapool/history', headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toMatch(/pool contract address/)
  })

  it('normalizes an SS58 XYK pool account to its stored hex', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:pools:xyk-history')
        ? [{ block_height: 100, ts: '2026-08-20 10:00:00', asset_a: 1000085, asset_b: 5, reserve_a_raw: '1', reserve_b_raw: '2', ingested_at: 'x' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/pools/xyk/${XYK_POOL_SS58}/history`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const read = client.seen.find(s => s.query.includes('-- data:pools:xyk-history'))!
    expect(read.params.poolAccount).toBe(XYK_POOL)
  })
})

describe('GET /v1/pools/:venue/:poolKey/trades', () => {
  it('reaches the parametric route past the static history branches and groups legs into fills', async () => {
    const client = fakeDataClient(
      (query, params) => {
        if (query.includes('-- data:trades:fill-keys')) {
          return params.cb == null ? [{ block_height: 100, event_index: 5 }, { block_height: 99, event_index: 2 }] : []
        }
        if (query.includes('-- data:trades:fill-legs')) {
          return [
            legRow({}),
            legRow({ leg_index: 0, leg_kind: 'out', asset_id: 0, amount: '2000' }),
            legRow({ leg_index: 0, leg_kind: 'out', asset_id: 0, amount: '2000' }), // replay duplicate
            legRow({ leg_index: 0, leg_kind: 'fee', asset_id: 0, amount: '3', fee_dest: 'burned' }),
            legRow({ block_height: 99, event_index: 2, swapper: PLACEHOLDER, op_key: '' }),
          ]
        }
        return undefined
      },
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools/omnipool/omnipool/trades?limit=5', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const [fill, placeholderFill] = res.json().items
    expect(fill).toMatchObject({
      blockHeight: 100, eventIndex: 5, venue: 'omnipool', poolKey: 'omnipool', opKey: '77',
      swapper: { address: SWAPPER_SS58, accountIdHex: SWAPPER, evmAddress: null },
      inputs: [{ assetId: '5', amount: '1000' }],
      outputs: [{ assetId: '0', amount: '2000' }], // the replayed leg collapsed
      fees: [{ assetId: '0', amount: '3', feeDest: 'burned', feeRecipient: null }],
    })
    // A placeholder swapper is not an account and must not render as one.
    expect(placeholderFill).toMatchObject({ blockHeight: 99, swapper: null, opKey: null })
  })

  it("reaches the dead LBP pallet's fills under the literal 'lbp' key and rejects any other", async () => {
    const client = fakeDataClient(query => (query.includes('-- data:trades:fill-keys') ? [] : undefined))
    app = await freshDataApp(client)
    const ok = await app.inject({ url: '/v1/pools/lbp/lbp/trades', headers: AUTH })
    expect(ok.statusCode).toBe(200)
    const scan = client.seen.find(s => s.query.includes('-- data:trades:fill-keys'))!
    expect(scan.params).toMatchObject({ venue: 'lbp', poolKey: '' })
    expect((await app.inject({ url: '/v1/pools/lbp/123/trades', headers: AUTH })).statusCode).toBe(400)
  })

  it('rejects a wrong omnipool pool key and an unknown venue', async () => {
    app = await freshDataApp(fakeDataClient())
    const badKey = await app.inject({ url: '/v1/pools/omnipool/5/trades', headers: AUTH })
    expect(badKey.statusCode).toBe(400)
    expect(badKey.json().error.message).toMatch(/'omnipool'/)
    expect((await app.inject({ url: '/v1/pools/lbp2/x/trades', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/pools/:venue/:poolKey/volumes', () => {
  it('buckets closed-hour sums per asset and side', async () => {
    app = await freshDataApp(fakeDataClient(
      query => (query.includes('-- data:pools:volumes')
        ? [
          { bucket_start: '2026-08-20 00:00:00', asset_id: 5, side: 'in', amount: '123', legs: '7' },
          { bucket_start: '2026-08-20 00:00:00', asset_id: 0, side: 'out', amount: '456', legs: '7' },
        ]
        : undefined),
    ))
    const res = await app.inject({ url: '/v1/pools/stableswap/100/volumes?bucket=day&fromTime=2026-08-18T00:00:00Z&toTime=2026-08-21T00:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      { bucket: '2026-08-20T00:00:00.000Z', assetId: '5', side: 'in', amount: '123', legCount: 7 },
      { bucket: '2026-08-20T00:00:00.000Z', assetId: '0', side: 'out', amount: '456', legCount: 7 },
    ])
  })

  it('takes the fold below its cut and the pool\'s deduplicated raw legs above it', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:pools:volumes') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools/uniswapv3/0x5c6208a3c316a801f8996750aa7b6f45fc988548/volumes?bucket=hour', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { query, params } = client.seen.find(s => s.query.includes('-- data:pools:volumes'))!
    // One cut for both arms: the first hour the fold does not hold.
    expect(query).toContain('WITH (SELECT max(hour) + INTERVAL 1 HOUR FROM price_data.pool_swap_hourly) AS cut')
    expect(query).toMatch(/FROM price_data\.pool_swap_hourly[\s\S]*AND hour < cut/)
    expect(query).toMatch(/FROM price_data\.pool_swap_legs[\s\S]*AND block_timestamp >= cut/)
    // The raw arm collapses the leg replacement key BEFORE summing, and is key-pruned.
    expect(query).toContain('GROUP BY block_height, event_index, leg_kind, leg_index')
    expect(query).toMatch(/argMax\(amount, ingested_at\)/)
    expect(query.match(/venue = \{venue:String\} AND pool_key = \{poolKey:String\}/g)).toHaveLength(2)
    expect(params).toMatchObject({ venue: 'uniswapv3', poolKey: '0x5c6208a3c316a801f8996750aa7b6f45fc988548' })
  })

  it('bounds the window at 90 days', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/pools/stableswap/100/volumes?fromTime=2025-01-01T00:00:00Z&toTime=2026-01-01T00:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.context.maxWindowDays).toBe(90)
  })
})
