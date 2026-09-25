import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../../src/services/explorerAssets.ts'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// A stableswap share token on the Data API is valued at what one share redeems for
// (freshPriceMap → lpMath.stableswapSharePrices), the definition the explorer and
// the public API use — never at its main asset's price. Its own file: it loads a
// registry, which is process state the other data tests run without.
type Row = Record<string, unknown>
const E18 = 10n ** 18n
const ACC = `0x${'44'.repeat(32)}`
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const assetRow = (asset_id: number, symbol: string): Row => ({
  asset_id, symbol, name: symbol, decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: null,
})

let app: FastifyInstance | undefined

beforeAll(async () => {
  const registry = fakeDataClient(
    query => (query.includes('FROM price_data.assets FINAL') ? [assetRow(46, 'apyUSD'), assetRow(146, '2-Pool-apyUSD'), assetRow(222, 'HOLLAR')] : undefined),
    query => (query.includes('stableswap_pool_state_history') ? [{ pool_id: 146, members: [46, 222] }] : undefined),
    () => [],
  )
  await loadExplorerAssets(registry as never)
})

afterAll(async () => {
  await app?.close()
  stopExplorerAssetsRefresh()
})

function client(poolAssets: number[], snapshotTs = now()) {
  return fakeDataClient(
    query => (query.includes('-- data:accounts:balances-substrate')
      ? [{ asset_id: '146', total: String(10n * E18), free: String(10n * E18), reserved: '0' }]
      : undefined),
    query => (query.includes('-- data:accounts:balances-erc20') ? [] : undefined),
    query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: 0 }] : undefined),
    query => (query.includes('-- data:accounts:atoken-map') ? [] : undefined),
    query => (query.includes('-- data:accounts:reserve-indices') ? [] : undefined),
    query => (query.includes('-- data:assets:current-prices')
      ? [
          { asset_id: 46, price: '1.386', block: 8_999_000, ts: now() },
          { asset_id: 222, price: '1', block: 8_999_000, ts: now() },
          // The share's own feed: never published as its current price.
          { asset_id: 146, price: '9.99', block: 8_999_000, ts: now() },
        ]
      : undefined),
    // $277.20 of apyUSD + $722.80 of HOLLAR over 1,000 shares: $1.00 a share.
    query => (query.includes('-- data:pools:snapshot')
      ? [{
          block_height: 8_999_990, ts: snapshotTs,
          payload_json: JSON.stringify({ stableswap: { pools: [{ pool_id: 146, assets: poolAssets, reserves: [String(200n * E18), String(7228n * E18 / 10n)], amplification: '100', fee: 400, total_issuance: String(1000n * E18) }] } }),
        }]
      : undefined),
  )
}

describe('Data API share-token valuation', () => {
  it('values a held share at its redeemable value, not at its main asset\'s price', async () => {
    app = await freshDataApp(client([46, 222]))
    const res = await app.inject({ url: `/v1/accounts/${ACC}/balances`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const [item] = res.json().items
    // 10 shares × $1.00, where apyUSD's price would state $13.86.
    expect(item).toMatchObject({ assetId: '146', valueUsd: '10.00' })
    await app.close(); app = undefined
  })

  it('leaves a share unpriced when a leg is unpriced, rather than aliasing it', async () => {
    app = await freshDataApp(client([46, 999]))
    const res = await app.inject({ url: `/v1/accounts/${ACC}/balances`, headers: AUTH })
    const [item] = res.json().items
    expect(item).toMatchObject({ assetId: '146', valueUsd: null })
    expect(res.json().totals.assetsUsd).toBe('0.00')
  })
})

describe('Data API share-token price on /v1/assets', () => {
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')

  it('publishes the derived share price, dated by the pool snapshot, on the list, the entry and /price', async () => {
    const ts = ago(30)
    app = await freshDataApp(client([46, 222], ts))
    const list = await app.inject({ url: '/v1/assets', headers: AUTH })
    expect(list.statusCode).toBe(200)
    const items = list.json().items as Array<{ assetId: string; priceUsd: string | null; priceUpdatedAt: string | null }>
    const iso = `${ts.replace(' ', 'T')}.000Z`
    expect(items.find(i => i.assetId === '146')).toMatchObject({ priceUsd: '1', priceUpdatedAt: iso })
    // A non-share asset keeps its own feed.
    expect(items.find(i => i.assetId === '46')).toMatchObject({ priceUsd: '1.386' })
    const one = await app.inject({ url: '/v1/assets/146', headers: AUTH })
    expect(one.json()).toMatchObject({ assetId: '146', priceUsd: '1', priceUpdatedAt: iso })
    const price = await app.inject({ url: '/v1/assets/146/price', headers: AUTH })
    expect(price.json()).toEqual({ assetId: '146', priceUsd: '1', atBlock: 8_999_990, atTime: iso })
    await app.close(); app = undefined
  })

  it('publishes a share with an unpriced leg as unpriced, never at its own feed', async () => {
    app = await freshDataApp(client([46, 999]))
    const one = await app.inject({ url: '/v1/assets/146', headers: AUTH })
    expect(one.json()).toMatchObject({ assetId: '146', priceUsd: null, priceUpdatedAt: null })
    const price = await app.inject({ url: '/v1/assets/146/price', headers: AUTH })
    expect(price.json()).toEqual({ assetId: '146', priceUsd: null, atBlock: null, atTime: null })
    await app.close(); app = undefined
  })

  it('leaves every share unpriced when the pool snapshot is over an hour old', async () => {
    app = await freshDataApp(client([46, 222], ago(3_700)))
    const one = await app.inject({ url: '/v1/assets/146', headers: AUTH })
    expect(one.json()).toMatchObject({ priceUsd: null })
    const res = await app.inject({ url: `/v1/accounts/${ACC}/balances`, headers: AUTH })
    expect(res.json().items[0]).toMatchObject({ assetId: '146', valueUsd: null })
    await app.close(); app = undefined
  })
})
