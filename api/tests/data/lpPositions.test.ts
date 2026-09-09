import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/accounts/{address}/liquidity/positions: the three
// venues' redemption math against a pinned pool snapshot, farmed vs direct,
// current-price valuation with the alias fallback, and the exact total.

type Row = Record<string, unknown>

const ACC = `0x${'61'.repeat(32)}`
const XYK_POOL = `0x${'62'.repeat(32)}`
const nowCh = new Date().toISOString().slice(0, 19).replace('T', ' ')
const FIXED = 10n ** 18n

// Omnipool asset 5: R = 1000, Q (hub) = 1000, S = 1000. A position of 100
// shares entered at price 1.0 (Q/R) sits exactly at the pool price, so the
// node's removal returns R × shares / S = 100 of the asset and no hub leg.
const SNAPSHOT: Row = {
  block_height: 9_000_000, ts: '2026-08-28 12:00:00',
  payload_json: JSON.stringify({
    omnipool: { assets: [{ asset_id: 5, reserve: '1000', hub_reserve: '1000', shares: '1000', protocol_shares: '0' }] },
    // Pool 100: two reserves, 100 shares issued -> 10 shares redeem 10%.
    stableswap: { pools: [{ pool_id: 100, assets: [10, 22], reserves: ['1000', '2000'], amplification: '320', fee: 200, total_issuance: '100' }] },
    // XYK: 50 shares outstanding, reserves 556/778.
    xyk: { pools: [{ pool_account: XYK_POOL, asset_a: 1000085, asset_b: 5, reserve_a: '556', reserve_b: '778' }] },
  }),
}

// The concentrated-liquidity arm (services/uniswapV3Positions): the account's
// manager positions and vault-share balance, then the held vaults' pool, totals
// and the token contracts' asset ids. Default: nothing held.
const V3_VAULT = `0x${'a2'.repeat(20)}`
const V3_POOL = `0x${'5c'.repeat(20)}`
const ADOT_CONTRACT = `0x${'02'.repeat(20)}`
const HOLLAR_CONTRACT = `0x${'53'.repeat(20)}`
function lpClient(overrides: { omni?: Row[]; farmed?: Row[]; shares?: Row[]; v3Positions?: Row[]; v3Shares?: Row[] } = {}) {
  return fakeDataClient(
    (query, params) => (query.includes('-- lp:v3-manager-positions')
      ? ((params.accounts as string[]).includes(`0x${'61'.repeat(20)}`) ? overrides.v3Positions ?? [] : [])
      : undefined),
    (query, params) => (query.includes('-- lp:v3-vault-shares')
      ? ((params.accounts as string[]).includes(`0x${'61'.repeat(20)}`) ? overrides.v3Shares ?? [] : [])
      : undefined),
    query => (query.includes('-- lp:v3-vault-pools') ? [{ vault: V3_VAULT, token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, fee: 3000, pool: V3_POOL }] : undefined),
    query => (query.includes('-- lp:v3-vault-totals') ? [{ vault: V3_VAULT, shares_out: '1000', total0: '5000', total1: '9000' }] : undefined),
    query => (query.includes('-- lp:v3-token-assets') ? [{ asset_id: 1000085, addr: ADOT_CONTRACT }, { asset_id: 5, addr: HOLLAR_CONTRACT }] : undefined),
    query => (query.includes('-- data:pools:snapshot') ? [SNAPSHOT] : undefined),
    query => (query.includes('-- data:pools:xyk-registry') ? [{ pool_account: XYK_POOL, lp_asset_id: 1000086 }] : undefined),
    // Registry is empty under test: every asset is the synthetic 12-decimal
    // descriptor, so $ = amount / 1e12 × price. Asset 5 at $2, 10 at $1, 22
    // unpriced, 1000085 at $0.5, H2O (1) at $10.
    query => (query.includes('-- data:assets:current-prices')
      ? [
          { asset_id: 5, price: '2', block: 9_000_000, ts: nowCh },
          { asset_id: 10, price: '1', block: 9_000_000, ts: nowCh },
          { asset_id: 1000085, price: '0.5', block: 9_000_000, ts: nowCh },
          { asset_id: 1, price: '10', block: 9_000_000, ts: nowCh },
        ]
      : undefined),
    (query, params) => (query.includes('-- data:lp:omnipool-positions')
      ? (params.account === ACC ? overrides.omni ?? [
          { position_id: '4711', farmed: 0, asset_id: 5, shares: '100', amount: '100', price: FIXED.toString() },
          { position_id: '4712', farmed: 1, asset_id: 5, shares: '50', amount: '50', price: FIXED.toString() },
        ] : [])
      : undefined),
    (query, params) => (query.includes('-- data:lp:xyk-farmed')
      ? (params.account === ACC ? overrides.farmed ?? [{ lp_asset_id: 1000086, shares: '5' }] : [])
      : undefined),
    (query, params) => (query.includes('-- data:lp:share-balances')
      ? (params.account === ACC ? overrides.shares ?? [{ asset_id: '100', total: '10' }, { asset_id: '1000086', total: '20' }] : [])
      : undefined),
    query => (query.includes('-- data:lp:xyk-total-shares') ? [{ lp_asset_id: 1000086, total: '50' }] : undefined),
  )
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/accounts/:address/liquidity/positions', () => {
  it('redeems every venue at the snapshot state and values it at current prices', async () => {
    const client = lpClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asOfBlock).toBe(9_000_000)
    const by = (venue: string, farmed: boolean) => body.items.find((i: { venue: string; farmed: boolean }) => i.venue === venue && i.farmed === farmed)

    // Omnipool: 100 shares of 1000 -> 100 units of asset 5 (× $2 / 1e12).
    expect(by('omnipool', false)).toEqual({
      venue: 'omnipool', farmed: false, positionId: '4711', poolKey: 'omnipool', shareAssetId: null, shares: '100',
      legs: [{ assetId: '5', amount: '100', valueUsd: '0.00' }], valueUsd: '0.00',
    })
    expect(by('omnipool', true)).toMatchObject({ positionId: '4712', shares: '50', legs: [{ assetId: '5', amount: '50' }] })

    // Stableswap: 10 of 100 shares -> 10% of each reserve; asset 22 is
    // unpriced, so the position's total is null while asset 10's leg is priced.
    expect(by('stableswap', false)).toMatchObject({
      poolKey: '100', shareAssetId: '100', shares: '10',
      legs: [{ assetId: '10', amount: '100', valueUsd: '0.00' }, { assetId: '22', amount: '200', valueUsd: null }],
      valueUsd: null,
    })

    // XYK: direct 20 of 50 shares and farmed 5 of 50, floor division.
    expect(by('xyk', false)).toMatchObject({ poolKey: XYK_POOL, shareAssetId: '1000086', shares: '20', legs: [{ assetId: '1000085', amount: '222' }, { assetId: '5', amount: '311' }] })
    expect(by('xyk', true)).toMatchObject({ shares: '5', legs: [{ assetId: '1000085', amount: '55' }, { assetId: '5', amount: '77' }] })
    expect(body.items).toHaveLength(5)
    expect(res.headers['cache-control']).toBe('private, max-age=10')
  })

  it('emits the H2O hub leg when the pool price moved above the entry price', async () => {
    // Entry price 0.5 while the pool trades at 1.0: the node returns part of
    // the value as H2O — hub = Q(Q − pxr)/(Q + pxr) × shares / S with
    // pxr = 501: 1000 × 499 / 1501 × 100 / 1000 = 33 (integer steps).
    const client = lpClient({ omni: [{ position_id: '9', farmed: 0, asset_id: 5, shares: '100', amount: '100', price: (FIXED / 2n).toString() }], farmed: [], shares: [] })
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })
    const [position] = res.json().items
    expect(position.legs.map((l: { assetId: string }) => l.assetId)).toEqual(['5', '1'])
    expect(position.legs[1].amount).toBe('33')
  })

  // A substrate account acts on the EVM side through the runtime's truncation of its
  // AccountId32 (the first 20 bytes): that is the address the position NFTs and vault
  // shares are held by, and what the reader asks for.
  it('adds concentrated-liquidity positions: the manager NFT principal and vault shares pro-rata', async () => {
    const client = lpClient({
      omni: [], farmed: [], shares: [],
      v3Positions: [{ mgr: `0x${'d5'.repeat(20)}`, tid: '7', pool_addr: V3_POOL, t0: ADOT_CONTRACT, t1: HOLLAR_CONTRACT, pool_fee: 3000, lo: 184980, hi: 185100, opened: 9_000_001, net_liquidity: '555', net0: '400', net1: '300', last_block: 9_000_002 }],
      v3Shares: [{ vault: V3_VAULT, held: '250' }],
    })
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const by = (venue: string) => body.items.find((i: { venue: string }) => i.venue === venue)
    // The position: liquidity as its shares, the net principal in both tokens; asset
    // 1000085 at $0.5, asset 5 at $2 (12-decimal synthetic descriptors).
    expect(by('uniswapv3')).toEqual({
      venue: 'uniswapv3', farmed: false, positionId: '7', poolKey: V3_POOL, shareAssetId: null, shares: '555',
      legs: [{ assetId: '1000085', amount: '400', valueUsd: '0.00' }, { assetId: '5', amount: '300', valueUsd: '0.00' }], valueUsd: '0.00',
    })
    // 250 of 1000 shares -> a quarter of 5000 and of 9000; the vault is the pool key.
    expect(by('gamma')).toMatchObject({ venue: 'gamma', farmed: false, positionId: null, poolKey: V3_VAULT, shareAssetId: null, shares: '250', legs: [{ assetId: '1000085', amount: '1250' }, { assetId: '5', amount: '2250' }] })
    expect(body.items).toHaveLength(2)
    const asked = client.seen.filter(q => q.query.includes('-- lp:v3-vault-shares')).map(q => q.params.accounts)
    expect(asked).toEqual([[`0x${'61'.repeat(20)}`]])
  })

  it('answers an account with no positions with empty items and a zero total', async () => {
    app = await freshDataApp(lpClient())
    const res = await app.inject({ url: `/v1/accounts/0x${'63'.repeat(32)}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], asOfBlock: 9_000_000, totals: { valueUsd: '0.00' } })
  })
})
