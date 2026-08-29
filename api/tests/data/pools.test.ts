import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
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

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/pools', () => {
  it('assembles the three venues from the per-block snapshot at the head', async () => {
    const client = fakeDataClient(
      snapshotHandler,
      query => (query.includes('-- data:pools:xyk-registry') ? [{ pool_account: XYK_POOL, lp_asset_id: 1000086 }] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/pools', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
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
          { bucket_start: '2026-08-20 00:00:00', asset_id: 5, leg_kind: 'in', amount: '123', legs: '7' },
          { bucket_start: '2026-08-20 00:00:00', asset_id: 0, leg_kind: 'out', amount: '456', legs: '7' },
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

  it('bounds the window at 90 days', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/pools/stableswap/100/volumes?fromTime=2025-01-01T00:00:00Z&toTime=2026-01-01T00:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.context.maxWindowDays).toBe(90)
  })
})
