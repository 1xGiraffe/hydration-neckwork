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
// venue history — its position NFTs' events and ranges, its vault-share transfers,
// then the touched vaults' pool and flows and the token contracts' asset ids —
// folded at the head. Default: nothing held.
const V3_VAULT = `0x${'a2'.repeat(20)}`
const V3_POOL = `0x${'5c'.repeat(20)}`
const ADOT_CONTRACT = `0x${'02'.repeat(20)}`
const HOLLAR_CONTRACT = `0x${'53'.repeat(20)}`
// The unclaimed-reward snapshot (services/lmRewardSnapshot): a pointer and the
// account's farm-entry rows. Default: no snapshot published yet.
const rewardRow = (over: Row): Row => ({
  account_id: ACC, pallet: 'omnipool', deposit_id: '77', yield_farm_id: 139, global_farm_id: 133, pool_key: '5',
  position_id: '4712', lp_asset_id: null, reward_asset_id: 5, farm_state: 'active',
  settled_s: '1000000000000', projected_s: '2000000000000', max_reward_s: '3000000000000', forfeit_s: '1000000000000',
  loyalty_s: '666666666666666666', farm_updated_at_period: 100, current_period: 110, below_ed: 0, snapshot_block: 8_999_990, ...over,
})
function lpClient(overrides: { omni?: Row[]; farmed?: Row[]; shares?: Row[]; v3Events?: Row[]; v3Ranges?: Row[]; v3Shares?: Row[]; rewards?: Row[] | null; rewardEvents?: Row[]; rewardsFail?: boolean; rewardsAgeSec?: number } = {}) {
  const forAccount = (params: Record<string, unknown>, rows: Row[] | undefined) =>
    ((params.accounts as string[]).includes(`0x${'61'.repeat(20)}`) ? rows ?? [] : [])
  return fakeDataClient(
    query => {
      if (!query.includes('-- lm:reward-snapshot-state')) return undefined
      if (overrides.rewardsFail) throw new Error('Table price_data.lm_reward_snapshot_state does not exist')
      return overrides.rewards == null ? [] : [{ snapshot_id: '1700000000000', block_height: 8_999_990, age_seconds: overrides.rewardsAgeSec ?? 60 }]
    },
    (query, params) => (query.includes('-- lm:reward-snapshot-rows')
      ? ((params.accs as string[]).includes(ACC) ? overrides.rewards ?? [] : [])
      : undefined),
    query => (query.includes('-- lm:reward-post-snapshot-events') ? overrides.rewardEvents ?? [] : undefined),
    (query, params) => (query.includes('-- lp:v3-manager-history') ? forAccount(params, overrides.v3Events) : undefined),
    (query, params) => (query.includes('-- lp:v3-manager-ranges') ? forAccount(params, overrides.v3Ranges) : undefined),
    (query, params) => (query.includes('-- lp:v3-vault-share-history') ? forAccount(params, overrides.v3Shares) : undefined),
    query => (query.includes('-- lp:v3-vault-pools') ? [{ vault: V3_VAULT, token0: ADOT_CONTRACT, token1: HOLLAR_CONTRACT, fee: 3000, pool: V3_POOL }] : undefined),
    // 1000 shares outstanding against 5000 / 9000.
    query => (query.includes('-- lp:v3-vault-flow-history') ? [{ vault: V3_VAULT, b: 9_000_001, i: 0, ev: 'Deposit', shares: '1000', a0: '5000', a1: '9000' }] : undefined),
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
      legs: [{ assetId: '5', amount: '100', valueUsd: '0.00' }], valueUsd: '0.00', unclaimedRewards: [],
    })
    expect(body.rewardsAsOfBlock).toBeNull()
    expect(body.totals).toEqual({ valueUsd: '0.00', unclaimedRewardsUsd: '0.00' })
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
      v3Events: [
        { mgr: `0x${'d5'.repeat(20)}`, tid: '7', b: 9_000_001, i: 0, ev: 'Transfer', holder: `0x${'61'.repeat(20)}`, liq: '0', a0: '0', a1: '0' },
        { mgr: `0x${'d5'.repeat(20)}`, tid: '7', b: 9_000_001, i: 1, ev: 'IncreaseLiquidity', holder: '', liq: '555', a0: '400', a1: '300' },
      ],
      v3Ranges: [{ mgr: `0x${'d5'.repeat(20)}`, tid: '7', pool_addr: V3_POOL, t0: ADOT_CONTRACT, t1: HOLLAR_CONTRACT, pool_fee: 3000, lo: 184980, hi: 185100, opened: 9_000_001 }],
      v3Shares: [{ vault: V3_VAULT, b: 9_000_002, i: 0, src: `0x${'00'.repeat(20)}`, dst: `0x${'61'.repeat(20)}`, value: '250' }],
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
      legs: [{ assetId: '1000085', amount: '400', valueUsd: '0.00' }, { assetId: '5', amount: '300', valueUsd: '0.00' }], valueUsd: '0.00', unclaimedRewards: [],
    })
    // 250 of 1000 shares -> a quarter of 5000 and of 9000; the vault is the pool key.
    expect(by('gamma')).toMatchObject({ venue: 'gamma', farmed: false, positionId: null, poolKey: V3_VAULT, shareAssetId: null, shares: '250', legs: [{ assetId: '1000085', amount: '1250' }, { assetId: '5', amount: '2250' }] })
    expect(body.items).toHaveLength(2)
    const asked = client.seen.filter(q => q.query.includes('-- lp:v3-vault-share-history')).map(q => q.params.accounts)
    expect(asked).toEqual([[`0x${'61'.repeat(20)}`]])
  })

  it('answers an account with no positions with empty items and a zero total', async () => {
    app = await freshDataApp(lpClient())
    const res = await app.inject({ url: `/v1/accounts/0x${'63'.repeat(32)}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], asOfBlock: 9_000_000, rewardsAsOfBlock: null, totals: { valueUsd: '0.00', unclaimedRewardsUsd: '0.00' } })
  })

  // Rewards ride on the farmed positions as a separate claim: the claimable-now
  // amount (projected when the snapshot brought the farm to its block, else the
  // last-sync amount flagged unprojected), valued at the current price, summed
  // into their own total and never into a leg or the position value.
  it('attaches unclaimed farm rewards to the farmed positions, outside their value', async () => {
    const client = lpClient({
      rewards: [
        // Omnipool deposit 77 → position 4712: 2 units projected at $2 (12 decimals).
        rewardRow({}),
        // A second entry of the same deposit, in an active farm whose projection
        // failed that cycle: its last-sync amount, flagged unprojected.
        rewardRow({ yield_farm_id: 140, global_farm_id: 134, projected_s: null, settled_s: '500000000000', below_ed: 1 }),
        // XYK deposit on LP 1000086: reward in asset 10 at $1.
        rewardRow({ pallet: 'xyk', deposit_id: '3', yield_farm_id: 2, global_farm_id: 1, pool_key: XYK_POOL, position_id: '', lp_asset_id: 1000086, reward_asset_id: 10, projected_s: '4000000000000' }),
        // A deposit whose position this read does not list: in the total only.
        rewardRow({ deposit_id: '99', position_id: '5555', projected_s: '1000000000000' }),
      ],
    })
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const by = (venue: string, farmed: boolean) => body.items.find((i: { venue: string; farmed: boolean }) => i.venue === venue && i.farmed === farmed)
    expect(by('omnipool', true).unclaimedRewards).toEqual([
      { depositId: '77', globalFarmId: 133, yieldFarmId: 139, assetId: '5', amount: '2000000000000', valueUsd: '4.00', projected: true, belowExistentialDeposit: false, payable: true },
      { depositId: '77', globalFarmId: 134, yieldFarmId: 140, assetId: '5', amount: '500000000000', valueUsd: '1.00', projected: false, belowExistentialDeposit: true, payable: true },
    ])
    expect(by('omnipool', true).valueUsd).toBe('0.00')
    expect(by('xyk', true).unclaimedRewards).toEqual([
      { depositId: '3', globalFarmId: 1, yieldFarmId: 2, assetId: '10', amount: '4000000000000', valueUsd: '4.00', projected: true, belowExistentialDeposit: false, payable: true },
    ])
    expect(by('omnipool', false).unclaimedRewards).toEqual([])
    expect(by('xyk', false).unclaimedRewards).toEqual([])
    expect(body.rewardsAsOfBlock).toBe(8_999_990)
    // 4 + 1 + 4 + 2 (the unlisted deposit): the account's rewards, not the items'.
    expect(body.totals).toEqual({ valueUsd: '0.00', unclaimedRewardsUsd: '11.00' })
  })

  // A sub-ED entry whose owner holds less than the deposit (below_ed 2) keeps its
  // amount visible but pays nothing, so it values at 0; a claim indexed after the
  // snapshot block comes off its entry, and a withdrawn entry reads 0.
  it('counts an unpayable entry as 0 and brings entries forward over later claims and withdrawals', async () => {
    const client = lpClient({
      rewards: [
        rewardRow({}),
        rewardRow({ yield_farm_id: 140, global_farm_id: 134, projected_s: '500000000000', below_ed: 2 }),
        rewardRow({ deposit_id: '99', position_id: '5555', projected_s: '1000000000000' }),
      ],
      rewardEvents: [
        { pallet: 'omnipool', deposit_id: '77', yield_farm_id: 139, kind: 'claimed', amount_s: '1500000000000' },
        { pallet: 'omnipool', deposit_id: '99', yield_farm_id: 139, kind: 'withdrawn', amount_s: '0' },
      ],
    })
    app = await freshDataApp(client)
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })).json()
    const farmed = body.items.find((i: { venue: string; farmed: boolean }) => i.venue === 'omnipool' && i.farmed)
    expect(farmed.unclaimedRewards).toEqual([
      { depositId: '77', globalFarmId: 133, yieldFarmId: 139, assetId: '5', amount: '500000000000', valueUsd: '1.00', projected: true, belowExistentialDeposit: false, payable: true },
      { depositId: '77', globalFarmId: 134, yieldFarmId: 140, assetId: '5', amount: '500000000000', valueUsd: '0.00', projected: true, belowExistentialDeposit: true, payable: false },
    ])
    // 2 − 1.5 claimed = 0.5 units at $2; the unpayable entry and the withdrawn deposit add nothing.
    expect(body.totals.unclaimedRewardsUsd).toBe('1.00')
  })

  it('states the rewards as unavailable, not the positions as failed, when the snapshot cannot be read', async () => {
    app = await freshDataApp(lpClient({ rewardsFail: true }))
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ rewardsAsOfBlock: null, totals: { unclaimedRewardsUsd: '0.00' } })
    expect(res.json().items).toHaveLength(5)
  })

  it('does not serve a snapshot older than 15 minutes', async () => {
    app = await freshDataApp(lpClient({ rewards: [rewardRow({})], rewardsAgeSec: 16 * 60 }))
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/liquidity/positions`, headers: AUTH })).json()
    expect(body.rewardsAsOfBlock).toBeNull()
    expect(body.totals.unclaimedRewardsUsd).toBe('0.00')
    expect(body.items.find((i: { farmed: boolean; venue: string }) => i.farmed && i.venue === 'omnipool').unclaimedRewards).toEqual([])
  })
})
