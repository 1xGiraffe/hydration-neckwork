import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { loadExplorerAssets } from '../../src/services/explorerAssets.ts'
import { encodeAddress } from '@polkadot/util-crypto'
import type { ClickHouseClient } from '../../src/db/client.ts'

// Contract tests for /v1/assets*. The registry is the shared in-memory
// snapshot, seeded once here through loadExplorerAssets with a faked assets
// table; prices/candles/holders dispatch on the SQL markers.

type Row = Record<string, unknown>

const HOLDER = `0x${'33'.repeat(32)}`
const HOLDER_SS58 = encodeAddress(HOLDER, 0)

const REGISTRY_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'Hydration', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: null, origin_ecosystem: 'polkadot', origin_chain_id: 'polkadot', origin_asset_id: null },
  { asset_id: 222, symbol: 'GDOT', name: 'GigaDOT', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

// A price refreshed now (fresh) and one whose feed died in 2023 (stale).
const nowCh = new Date().toISOString().slice(0, 19).replace('T', ' ')
const PRICE_ROWS: Row[] = [
  { asset_id: 0, price: '0.007363527971', block: 13931580, ts: nowCh },
  { asset_id: 5, price: '3.51', block: 13931580, ts: nowCh },
  { asset_id: 222, price: '41543.04', block: 4047484, ts: '1970-01-01 00:00:00' },
]

function marketsClient(extra: Array<(query: string, params: Record<string, unknown>) => Row[] | undefined> = []) {
  return fakeDataClient(
    ...extra,
    query => (query.includes('FROM price_data.assets FINAL') ? REGISTRY_ROWS : undefined),
    query => (query.includes('Bonds.TokenCreated') ? [] : undefined),
    query => (query.includes('-- data:assets:current-prices') ? PRICE_ROWS : undefined),
  )
}

let app: FastifyInstance | undefined

beforeAll(async () => {
  await loadExplorerAssets(marketsClient() as unknown as ClickHouseClient)
})

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/assets', () => {
  it('lists the registry with fresh prices, and nulls a stale feed’s price', async () => {
    app = await freshDataApp(marketsClient())
    const res = await app.inject({ url: '/v1/assets', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const items = res.json().items
    const hdx = items.find((item: { assetId: string }) => item.assetId === '0')
    expect(hdx).toMatchObject({ symbol: 'HDX', decimals: 12, priceUsd: '0.007363527971' })
    // Asset 222's last price row is ancient (block 4M against head 9M with an
    // epoch-zero timestamp): unpriced, never priced at its final close.
    const gdot = items.find((item: { assetId: string }) => item.assetId === '222')
    expect(gdot.priceUsd).toBeNull()
    expect(gdot.priceUpdatedAt).toBeNull()
    expect(res.headers['cache-control']).toBe('private, max-age=300')
  })

  it('serves one asset and 404s an unknown id with the enumeration hint', async () => {
    app = await freshDataApp(marketsClient())
    const hit = await app.inject({ url: '/v1/assets/5', headers: AUTH })
    expect(hit.statusCode).toBe(200)
    expect(hit.json()).toMatchObject({ assetId: '5', symbol: 'DOT', origin: { ecosystem: 'polkadot' } })

    const miss = await app.inject({ url: '/v1/assets/99999', headers: AUTH })
    expect(miss.statusCode).toBe(404)
    expect(miss.json().error.context.hint).toBe('list ids via /v1/assets')
  })
})

describe('GET /v1/assets/:id/price', () => {
  it('answers an as-of block read with the block the price came from', async () => {
    app = await freshDataApp(marketsClient([
      (query, params) => (query.includes('-- data:assets:price-at-block')
        ? (Number(params.block) >= 4047484 ? [{ price: '3.4', block_height: 4047484, ts: '2024-01-01 00:00:00' }] : [])
        : undefined),
    ]))
    const res = await app.inject({ url: '/v1/assets/5/price?at=5000000', headers: AUTH })
    expect(res.statusCode).toBe(200)
    // The as-of read reports where the price ACTUALLY comes from — an older
    // block than requested, with no staleness bound (documented).
    expect(res.json()).toEqual({ assetId: '5', priceUsd: '3.4', atBlock: 4047484, atTime: '2024-01-01T00:00:00.000Z' })
  })

  it('answers the current price without at=', async () => {
    app = await freshDataApp(marketsClient())
    const res = await app.inject({ url: '/v1/assets/0/price', headers: AUTH })
    expect(res.json()).toMatchObject({ assetId: '0', priceUsd: '0.007363527971', atBlock: 13931580 })
  })

  it('rejects a garbage at=', async () => {
    app = await freshDataApp(marketsClient())
    expect((await app.inject({ url: '/v1/assets/0/price?at=yesterday', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/assets/:id/candles', () => {
  it('serves candles as decimal strings and enforces the per-bucket window', async () => {
    app = await freshDataApp(marketsClient([
      query => (query.includes('-- data:assets:candles')
        ? [{ interval_start: '2026-08-01 00:00:00', open: '3.1', high: '3.5', low: '3.0', close: '3.4', volume_buy: '100.5', volume_sell: '90.25', volume_total: '190.75' }]
        : undefined),
    ]))
    const ok = await app.inject({ url: '/v1/assets/5/candles?bucket=1h&fromTime=2026-08-01T00:00:00Z&toTime=2026-08-02T00:00:00Z', headers: AUTH })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().items[0]).toEqual({
      time: '2026-08-01T00:00:00.000Z', open: '3.1', high: '3.5', low: '3.0', close: '3.4',
      volumeBuy: '100.5', volumeSell: '90.25', volumeTotal: '190.75',
    })

    const tooWide = await app.inject({ url: '/v1/assets/5/candles?bucket=5m&fromTime=2026-01-01T00:00:00Z&toTime=2026-08-01T00:00:00Z', headers: AUTH })
    expect(tooWide.statusCode).toBe(400)
    expect(tooWide.json().error.context.maxWindowDays).toBe(14)

    const missing = await app.inject({ url: '/v1/assets/5/candles?bucket=1h', headers: AUTH })
    expect(missing.statusCode).toBe(400)
  })

  it('knows no 1-minute bucket', async () => {
    app = await freshDataApp(marketsClient())
    const res = await app.inject({ url: '/v1/assets/5/candles?bucket=1m&fromTime=2026-08-01T00:00:00Z&toTime=2026-08-02T00:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /v1/assets/:id/transfers and /swaps', () => {
  it('pages transfers by cursor with account refs', async () => {
    app = await freshDataApp(marketsClient([
      (query, params) => (query.includes('-- data:assets:transfers')
        ? (params.cb == null
          ? [{ block_height: 200, event_index: 3, extrinsic_index: 1, ts: '2026-08-20 10:00:00', event_name: 'Tokens.Transfer', from_account: HOLDER, to_account: `0x${'44'.repeat(32)}`, amount: '777' }]
          : [])
        : undefined),
    ]))
    const res = await app.inject({ url: '/v1/assets/5/transfers?limit=1', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({
      blockHeight: 200, eventName: 'Tokens.Transfer', amount: '777',
      from: { address: HOLDER_SS58, accountIdHex: HOLDER },
    })
    expect(res.json().hasMore).toBe(false)
  })

  it('serves swaps with null who for actor-less router rows', async () => {
    app = await freshDataApp(marketsClient([
      query => (query.includes('-- data:assets:swaps')
        ? [{ block_height: 201, event_index: 5, extrinsic_index: null, ts: '2026-08-20 10:00:06', event_name: 'Router.Executed', who: '', asset_in: 5, asset_out: 0, amount_in: '10', amount_out: '20' }]
        : undefined),
    ]))
    const res = await app.inject({ url: '/v1/assets/5/swaps', headers: AUTH })
    expect(res.json().items[0]).toMatchObject({ who: null, assetIn: '5', assetOut: '0' })
  })
})

describe('GET /v1/assets/:id/holders', () => {
  it('ranks substrate holders with the exact holder count, falling back to the ERC-20 snapshot when empty', async () => {
    const client = marketsClient([
      (query, params) => (query.includes('-- data:assets:holders-erc20')
        ? [{ account_id: HOLDER, total: '5000', holder_count: '3' }]
        : query.includes('-- data:assets:holders')
          ? (params.assetId === '5' ? [{ account_id: HOLDER, total: '123456', last_block: 9_000_000, holder_count: '4711' }] : [])
          : undefined),
    ])
    app = await freshDataApp(client)
    const substrate = await app.inject({ url: '/v1/assets/5/holders?limit=10', headers: AUTH })
    expect(substrate.statusCode).toBe(200)
    expect(substrate.json()).toEqual({
      items: [{ account: { address: HOLDER_SS58, accountIdHex: HOLDER, evmAddress: null }, amount: '123456', lastBlock: 9_000_000 }],
      holderCount: 4711,
    })
    // The count rides on the ranking read as a window aggregate — no second fold.
    const read = client.seen.find(s => s.query.includes('-- data:assets:holders'))!
    expect(read.query).toMatch(/count\(\) OVER \(\) AS holder_count/)

    // Asset 222 has no substrate balance rows: the ERC-20 snapshot answers,
    // whose rows carry no observation block.
    const erc20 = await app.inject({ url: '/v1/assets/222/holders?limit=10', headers: AUTH })
    expect(erc20.json().items[0]).toMatchObject({ amount: '5000', lastBlock: null })
    expect(erc20.json().holderCount).toBe(3)
  })
})
