import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/accounts/{address}/money-market/positions: the
// reserve rows /balances states (settled index, current prices), grouped per
// isolated market beside that market's newest observation and E-mode, the
// collateral flag read (never inferred from a balance), and totals that sum
// priced legs across markets without ever carrying a health factor.

const ACC = `0x${'71'.repeat(32)}`
const H160 = `0x${'71'.repeat(20)}`
const RAY = 10n ** 27n
const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const GIGA = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const DOT = '0x0000000000000000000000000000000100000005'
const USDT = '0x000000000000000000000000000000010000000a'
const STHDX = '0x000000000000000000000000000000010000029e'
const A5 = `0x${'a5'.repeat(20)}`, D5 = `0x${'d5'.repeat(20)}`
const A10 = `0x${'aa'.repeat(20)}`, D10 = `0x${'da'.repeat(20)}`
const A670 = `0x${'a6'.repeat(20)}`, D670 = `0x${'d6'.repeat(20)}`
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

function positionsClient() {
  return fakeDataClient(
    query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: 8_200_000 }] : undefined),
    query => (query.includes('-- data:accounts:atoken-map')
      ? [
          { asset_address: DOT, atoken: A5, vdebt: D5, pool_proxy: CORE, market_key: 'core' },
          { asset_address: USDT, atoken: A10, vdebt: D10, pool_proxy: CORE, market_key: 'core' },
          { asset_address: STHDX, atoken: A670, vdebt: D670, pool_proxy: GIGA, market_key: 'gigahdx' },
        ]
      : undefined),
    query => (query.includes('-- data:accounts:reserve-indices')
      ? [
          { pool_address: CORE, reserve_address: DOT, liq: (2n * RAY).toString(), vbi: RAY.toString() },
          { pool_address: CORE, reserve_address: USDT, liq: RAY.toString(), vbi: RAY.toString() },
          { pool_address: GIGA, reserve_address: STHDX, liq: RAY.toString(), vbi: RAY.toString() },
        ]
      : undefined),
    (query, params) => (query.includes('-- data:accounts:atoken-scaled')
      ? (params.h === H160 ? [{ contract: A5, scaled: '1000000000000' }, { contract: D5, scaled: '500000000000' }, { contract: A10, scaled: '7000000000000' }, { contract: A670, scaled: '3000000000000' }] : [])
      : undefined),
    (query, params) => (query.includes('-- data:accounts:mm-positions')
      ? params.h !== H160 ? [] : [
          { pool_address: CORE, total_collateral_base: '5000000000', total_debt_base: '1000000000', available_borrows_base: '2000000000', liquidation_threshold: '8000', ltv: '7500', health_factor: '2500000000000000000', block_height: 8_990_000, ts: '2026-08-28 10:00:00' },
          { pool_address: GIGA, total_collateral_base: '900', total_debt_base: '0', available_borrows_base: '700', liquidation_threshold: '7000', ltv: '6000', health_factor: '115792089237316195423570985008687907853269984665640564039457584007913129639935', block_height: 8_980_000, ts: '2026-08-28 09:00:00' },
        ]
      : undefined),
    query => (query.includes('-- mm:collateral-flags-current') ? [{ user_address: H160, pool_address: CORE, reserve_address: DOT, enabled_last: 1 }, { user_address: H160, pool_address: CORE, reserve_address: USDT, enabled_last: 0 }] : undefined),
    query => (query.includes('-- mm:emode-current') ? [{ pool: CORE, category: 1 }] : undefined),
    // The incentive snapshot (services/mmIncentiveSnapshot): 1 DOT claimable on the
    // core market's A5, below its existential deposit, with the arithmetic's leg.
    query => (query.includes('-- mm:incentive-snapshot-state') ? [{ snapshot_id: 'mmr-1', block_height: 8_999_500, age_seconds: 60 }] : undefined),
    query => (query.includes('-- mm:incentive-post-snapshot-claims') ? [] : undefined),
    (query, params) => (query.includes('-- mm:incentive-snapshot-rows')
      ? (params.accs as string[]).includes(`0x45544800${H160.slice(2)}0000000000000000`) ? [
          { account_id: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, reward_asset_id: 5, reward_address: DOT, asset_address: '', market_key: 'core', claimable_s: '1000000000000', model_s: '1000000000000', accrued_s: '999999999995', pending_s: '5', scaled_s: '0', user_index_s: '0', asset_index_s: '0', reconciled: 1, below_ed: 1, snapshot_block: 8_999_500 },
          { account_id: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, reward_asset_id: 5, reward_address: DOT, asset_address: A5, market_key: 'core', claimable_s: '0', model_s: '0', accrued_s: '0', pending_s: '5', scaled_s: '1000000000000', user_index_s: '1', asset_index_s: '6', reconciled: 1, below_ed: 0, snapshot_block: 8_999_500 },
        ] : []
      : undefined),
    // DOT $2, stHDX $1; USDT has no fresh price.
    query => (query.includes('-- data:assets:current-prices')
      ? [{ asset_id: 5, price: '2', block: 8_999_000, ts: now() }, { asset_id: 670, price: '1', block: 8_999_000, ts: now() }]
      : undefined),
  )
}

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/accounts/:address/money-market/positions', () => {
  it('groups the /balances reserve rows per isolated market beside each market\'s observation', async () => {
    app = await freshDataApp(positionsClient())
    const res = await app.inject({ url: `/v1/accounts/${ACC}/money-market/positions`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.asOfBlock).toBe(TEST_HEAD)
    expect(body.markets.map((m: { marketKey: string }) => m.marketKey)).toEqual(['core', 'gigahdx'])
    const [core, giga] = body.markets
    expect(core).toMatchObject({ poolAddress: CORE, role: 'primary', stakingBacked: false, eModeCategoryId: 1 })
    expect(core.observation).toEqual({
      observedAtBlock: 8_990_000, timestamp: '2026-08-28T10:00:00.000Z',
      totalCollateralBase: '5000000000', totalDebtBase: '1000000000', availableBorrowsBase: '2000000000', liquidationThreshold: '8000', ltv: '7500', healthFactor: '2500000000000000000',
    })
    // Settled index, truncating: 1 scaled × 2 = 2 DOT supplied ($4), 0.5 owed ($1);
    // USDT supplied but unpriced ranks last and is not collateral (its flag is off).
    expect(core.reserves).toEqual([
      { assetId: '5', reserveAddress: DOT, aTokenAssetId: '1001', supplied: '2000000000000', borrowed: '500000000000', suppliedUsd: '4.00', borrowedUsd: '1.00', collateral: true },
      { assetId: '10', reserveAddress: USDT, aTokenAssetId: '1002', supplied: '7000000000000', borrowed: '0', suppliedUsd: null, borrowedUsd: '0.00', collateral: false },
    ])
    expect(giga).toMatchObject({ role: 'supplemental', stakingBacked: true, eModeCategoryId: null })
    expect(giga.reserves[0]).toMatchObject({ assetId: '670', supplied: '3000000000000', suppliedUsd: '3.00', collateral: false })
    // Totals sum priced legs across markets (staking-backed included) and carry no health factor.
    expect(body.totals).toEqual({ suppliedUsd: '7.00', borrowedUsd: '1.00', unclaimedRewardsUsd: '2.00' })
    // The claimable incentive is the chain's amount, under the market of the aToken it accrues on,
    // beside the reserves and never in them.
    expect(body.rewardsAsOfBlock).toBe(8_999_500)
    expect(core.unclaimedRewards).toEqual([{
      assetId: '5', amount: '1000000000000', valueUsd: '2.00', reconciled: true, belowExistentialDeposit: true,
      legs: [{ aTokenAddress: A5, aTokenAssetId: '1001', pending: '5' }],
    }])
    expect(giga.unclaimedRewards).toEqual([])
    expect(res.headers['cache-control']).toBe('private, max-age=10')
  })

  it('answers an unseen account with no markets and zero totals', async () => {
    app = await freshDataApp(positionsClient())
    const body = (await app.inject({ url: `/v1/accounts/0x${'33'.repeat(20)}/money-market/positions`, headers: AUTH })).json()
    expect(body.markets).toEqual([])
    expect(body.totals).toEqual({ suppliedUsd: '0.00', borrowedUsd: '0.00', unclaimedRewardsUsd: '0.00' })
    expect(body.rewardsAsOfBlock).toBe(8_999_500)
  })

  it('states no incentives when the snapshot is stale — rewardsAsOfBlock null, nothing in the totals', async () => {
    const stale = fakeDataClient(
      query => (query.includes('-- mm:incentive-snapshot-state') ? [{ snapshot_id: 'mmr-1', block_height: 8_999_500, age_seconds: 16 * 60 }] : undefined),
      query => (query.includes('-- mm:incentive-snapshot-rows') ? [{ account_id: 'x' }] : undefined),
    )
    // Everything else answers from the ordinary fixture.
    const base = positionsClient()
    const route = (c: unknown, args: unknown) => (c as { query: (a: unknown) => unknown }).query(args)
    const client = { ...base, query: (args: { query: string }) => (args.query.includes("-- mm:incentive-snapshot") ? route(stale, args) : route(base, args)) }
    app = await freshDataApp(client as never)
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/money-market/positions`, headers: AUTH })).json()
    expect(body.rewardsAsOfBlock).toBeNull()
    expect(body.totals.unclaimedRewardsUsd).toBe('0.00')
    expect(body.markets.every((m: { unclaimedRewards: unknown[] }) => m.unclaimedRewards.length === 0)).toBe(true)
  })
})
