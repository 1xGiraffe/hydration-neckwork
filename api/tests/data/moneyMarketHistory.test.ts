import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { cacheExpiry } from '../../src/services/cache.ts'
import { BUCKET_HISTORY_CLOSED_TTL_MS, BUCKET_HISTORY_SETTLING_TTL_MS } from '../../src/data/services/lpHistory.ts'
import { mmEthAccountForm } from '../../src/services/moneyMarketHistory.ts'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/accounts/{address}/money-market/history: the wire on
// the fixed day/hour grid, the groupBy forms, the market filter (unknown → 400),
// the bucket cap, null-not-zero before the coverage floor, and the cache key —
// the window, never the head. The per-reserve arithmetic is pinned by
// tests/moneyMarketHistory.test.ts.

type Row = Record<string, unknown>

const H160 = `0x${'4a'.repeat(20)}`
const H = 3_600

const RAY = 10n ** 27n
const E12 = 10n ** 12n
const CLOCK_START = Date.UTC(2026, 6, 1) / 1000
const CLOCK_END = Date.UTC(2026, 7, 28, 12) / 1000
const CLOCK_ROWS: Row[] = []
for (let h = CLOCK_START, i = 0; h <= CLOCK_END; h += H, i++) CLOCK_ROWS.push({ h, top: 1_000_000 + i * 1000 + 999, at_mark: 1_000_000 + i * 1000 })
const markHeight = (sec: number) => 1_000_000 + ((sec - CLOCK_START) / H) * 1000
const timeOf = (height: number) => CLOCK_START + Math.floor((height - 1_000_000) / 1000) * H
const PRICED_AT = Date.UTC(2026, 6, 31) / 1000

const CORE = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const BIL = '0x69310fda58c819ad82df7d2cb61841c853337a53'
const DOT = '0x0000000000000000000000000000000100000005'
const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const A5 = `0x${'a5'.repeat(20)}`
const D5 = `0x${'d5'.repeat(20)}`
const A222 = `0x${'a2'.repeat(20)}`
const D222 = `0x${'d2'.repeat(20)}`
// A lending-incentive programme on an aToken the account does not hold: its
// claimable is the stored accrual alone — the chain's 10 HDX at B0.
const PROG_ATOKEN = `0x${'ee'.repeat(20)}`
const HDX_REWARD = '0x0000000000000000000000000000000100000000'
const MAP = [
  { asset_address: DOT, atoken: A5, vdebt: D5, pool_proxy: CORE, market_key: 'core' },
  { asset_address: HOLLAR, atoken: A222, vdebt: D222, pool_proxy: BIL, market_key: 'bil' },
]

function mmClient(overrides: { anchorBlock?: number } = {}) {
  const anchorBlock = overrides.anchorBlock ?? 900_000
  return fakeDataClient(
    query => (query.includes('max(block_height) AS top') ? CLOCK_ROWS : undefined),
    // The data-side reserve state (market-key validation).
    query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: anchorBlock }] : undefined),
    query => (query.includes('-- data:accounts:atoken-map') ? MAP : undefined),
    query => (query.includes('-- data:accounts:reserve-indices') ? [] : undefined),
    // The leaf.
    query => (query.includes('-- mm:reserve-map') ? MAP : undefined),
    query => (query.includes('-- mm:anchor-block') ? [{ b0: anchorBlock }] : undefined),
    (query, params) => (query.includes('-- mm:scaled-anchor')
      ? (params.hs as string[]).includes(H160) ? [
          { holder: H160, contract: A5, scaled: String(10n * E12) },
          { holder: H160, contract: D5, scaled: String(4n * E12) },
          { holder: H160, contract: A222, scaled: String(3n * E12) },
        ] : []
      : undefined),
    query => (query.includes('-- mm:scaled-deltas') ? [] : undefined),
    (query, params) => (query.includes('-- mm:observations\n')
      ? ((params.accs as string[]).includes(mmEthAccountForm(H160))
          ? [{ pool: CORE, b: -1, obs_block: 950_000, coll: '2000000000', debt: '800000000', avail: '100', lt: '8000', max_ltv: '7500', hf: '2000000000000000000' }]
          : [])
      : undefined),
    query => (query.includes('-- mm:observations-carry') ? [] : undefined),
    query => (query.includes('-- mm:collateral-flags') ? [{ pool: CORE, reserve: DOT, b: -1, enabled_last: 1 }] : undefined),
    query => (query.includes('-- mm:emode') ? [{ pool: CORE, b: -1, category: 2 }] : undefined),
    // One settled update per reserve before every window: rates zero, so amounts
    // are scaled × index exactly.
    query => (query.includes('-- mm:reserve-indices\n')
      ? [
          { pool: CORE, reserve: DOT, b: -1, liq: String(2n * RAY), vbi: String(RAY), blk: 950_000, ev: 4, ts: timeOf(950_000) },
          { pool: BIL, reserve: HOLLAR, b: -1, liq: String(RAY), vbi: String(RAY), blk: 950_001, ev: 2, ts: timeOf(950_001) },
        ]
      : undefined),
    query => (query.includes('-- mm:reserve-rates\n')
      ? [
          { pool: CORE, reserve: DOT, b: -1, liq_rate: '0', vb_rate: '0', blk: 950_000, ev: 4 },
          { pool: BIL, reserve: HOLLAR, b: -1, liq_rate: '0', vb_rate: '0', blk: 950_001, ev: 2 },
        ]
      : undefined),
    query => (query.includes('-- mm:reserve-indices-carry') || query.includes('-- mm:reserve-rates-carry') ? [] : undefined),
    query => (query.includes('-- mm:reserve-update-phase') ? [{ block_height: 950_000, event_index: 4, init: 0 }, { block_height: 950_001, event_index: 2, init: 0 }] : undefined),
    (query, params) => (query.includes('-- mm:block-times') ? (params.hs as number[]).map(h => ({ block_height: h, t: timeOf(h) })) : undefined),
    // The incentive history (services/mmIncentiveHistory): both anchors at B0, one
    // programme, the anchored 10 HDX accrual and nothing since.
    query => (query.includes('-- mm:incentive-anchor-blocks') ? [{ b0: anchorBlock, s0: anchorBlock }] : undefined),
    query => (query.includes('-- mm:incentive-programmes') ? [{ asset: PROG_ATOKEN, reward: HDX_REWARD }] : undefined),
    (query, params) => (query.includes('-- mm:incentive-anchor\n')
      ? (params.users as string[]).includes(H160) ? [{ u: H160, asset: '', reward: HDX_REWARD, value: String(10n * E12) }] : []
      : undefined),
    query => (/-- mm:incentive-(accruals|claims|scaled-anchor|scaled-deltas|index|index-carry)\n/.test(query) ? [] : undefined),
    query => (query.includes('-- mm:incentive-snapshot-state') ? [] : undefined),
    // DOT at $2, HDX at $0.50; HOLLAR (222) has no candle.
    query => (query.includes('-- lp:bucket-closes') ? [{ asset_id: 5, closed_at: PRICED_AT, px: '2' }, { asset_id: 0, closed_at: PRICED_AT, px: '0.5' }] : undefined),
  )
}

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

const CLOSED = 'fromTime=2026-08-01T00:00:00Z&toTime=2026-08-05T12:00:00Z'

describe('GET /v1/accounts/:address/money-market/history', () => {
  it('serves the account line, each isolated market and its reserves, exact at the bucket end', async () => {
    const client = mmClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${H160}/money-market/history?${CLOSED}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ bucket: 'day', from: '2026-08-01T00:00:00.000Z', to: '2026-08-06T00:00:00.000Z' })
    expect(body.reserveHistoryFrom).toEqual({ blockHeight: 900_000, time: new Date(timeOf(900_000) * 1000).toISOString() })
    expect(body.points).toHaveLength(5)
    // DOT: 10 scaled × index 2 = 20 supplied ($40), 4 owed ($8); HOLLAR in BIL is
    // held but has no candle: left out of the sums and counted.
    // The 10 HDX of unclaimed incentives ($5) ride beside the legs, never in suppliedUsd.
    expect(body.points[0]).toEqual({ bucket: '2026-08-01T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 2) / 1000), suppliedUsd: '40.00', borrowedUsd: '8.00', unpriced: 1, unclaimedRewardsUsd: '5.00', rewardsIncomplete: 0 })
    expect(body.markets.map((m: { marketKey: string }) => m.marketKey)).toEqual(['core', 'bil'])
    const [core, bil] = body.markets
    expect(core).toMatchObject({ marketKey: 'core', poolAddress: CORE, stakingBacked: false })
    expect(core.points[0]).toEqual({
      bucket: '2026-08-01T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 2) / 1000),
      suppliedUsd: '40.00', borrowedUsd: '8.00', netUsd: '32.00', unpriced: 0, eModeCategoryId: 2,
      // Listed under the market whose aToken accrues them; nothing pending, so no settling block.
      unclaimedRewards: [{ assetId: '0', amount: String(10n * E12), valueUsd: '5.00', settledAtBlock: null }],
      observation: {
        observedAtBlock: 950_000, timestamp: new Date(timeOf(950_000) * 1000).toISOString(),
        totalCollateralBase: '2000000000', totalDebtBase: '800000000', availableBorrowsBase: '100', liquidationThreshold: '8000', ltv: '7500', healthFactor: '2000000000000000000',
      },
    })
    expect(core.reserves).toHaveLength(1)
    expect(core.reserves[0]).toMatchObject({ assetId: '5', reserveAddress: DOT, aTokenAssetId: '1001' })
    expect(core.reserves[0].points[4]).toEqual({
      bucket: '2026-08-05T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 6) / 1000),
      supplied: String(20n * E12), borrowed: String(4n * E12), suppliedUsd: '40.00', borrowedUsd: '8.00', collateral: true,
    })
    // BIL: an unpriced leg makes the market's figures partial, never zero-valued.
    expect(bil.points[0]).toMatchObject({ suppliedUsd: '0.00', borrowedUsd: '0.00', netUsd: null, unpriced: 1, observation: null, eModeCategoryId: null, unclaimedRewards: [] })
    expect(bil.reserves[0].points[0]).toMatchObject({ supplied: String(3n * E12), suppliedUsd: null, collateral: null })
    expect(res.headers['cache-control']).toBe('private, max-age=60')
    // The observation and the H160 are read in the forms the pools key on.
    const obsRead = client.seen.find(s => s.query.includes('-- mm:observations\n'))!
    expect(obsRead.params.accs).toEqual([mmEthAccountForm(H160)])
    // Closed (the head is weeks past): keyed on the window alone, with the long TTL.
    const key = `data:accounts:mm-history:${mmAccountId()}:day:${Date.UTC(2026, 7, 1) / 1000}:${Date.UTC(2026, 7, 6) / 1000}:all:reserve`
    const expiry = cacheExpiry(key)
    expect(expiry! - Date.now()).toBeGreaterThan(BUCKET_HISTORY_SETTLING_TTL_MS)
    expect(expiry! - Date.now()).toBeLessThanOrEqual(BUCKET_HISTORY_CLOSED_TTL_MS)
    expect(cacheExpiry(`${key}:h${TEST_HEAD}`)).toBeNull()
  })

  it('omits reserves for groupBy=market and markets for groupBy=account', async () => {
    app = await freshDataApp(mmClient())
    const market = (await app.inject({ url: `/v1/accounts/${H160}/money-market/history?${CLOSED}&groupBy=market`, headers: AUTH })).json()
    expect(market.markets).toHaveLength(2)
    for (const m of market.markets) expect(m).not.toHaveProperty('reserves')
    const account = (await app.inject({ url: `/v1/accounts/${H160}/money-market/history?${CLOSED}&groupBy=account`, headers: AUTH })).json()
    expect(account.points).toHaveLength(5)
    expect(account).not.toHaveProperty('markets')
  })

  it('narrows every figure to the markets asked for and rejects an unknown one', async () => {
    app = await freshDataApp(mmClient())
    const core = (await app.inject({ url: `/v1/accounts/${H160}/money-market/history?${CLOSED}&market=core`, headers: AUTH })).json()
    expect(core.markets.map((m: { marketKey: string }) => m.marketKey)).toEqual(['core'])
    expect(core.points[0]).toMatchObject({ suppliedUsd: '40.00', unpriced: 0 })
    const bad = await app.inject({ url: `/v1/accounts/${H160}/money-market/history?market=core,aave`, headers: AUTH })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.message).toContain('aave')
    expect(bad.json().error.message).toContain('core, bil')
  })

  it('rejects a span over the bucket cap', async () => {
    app = await freshDataApp(mmClient())
    const wide = await app.inject({ url: `/v1/accounts/${H160}/money-market/history?bucket=hour&fromTime=2026-07-01T00:00:00Z&toTime=2026-08-01T00:00:00Z`, headers: AUTH })
    expect(wide.statusCode).toBe(400)
    expect(wide.json().error.message).toContain('money-market history')
    expect(wide.json().error.message).toContain('maximum')
  })

  it('states no reserve figure before the coverage floor — null, never zero — and keeps the observation', async () => {
    // B0 after the whole window.
    app = await freshDataApp(mmClient({ anchorBlock: 2_500_000 }))
    const body = (await app.inject({ url: `/v1/accounts/${H160}/money-market/history?${CLOSED}`, headers: AUTH })).json()
    expect(body.points.every((p: { suppliedUsd: unknown; borrowedUsd: unknown }) => p.suppliedUsd === null && p.borrowedUsd === null)).toBe(true)
    expect(body.markets.map((m: { marketKey: string }) => m.marketKey)).toEqual(['core'])
    expect(body.markets[0].reserves).toEqual([])
    expect(body.markets[0].points[0]).toMatchObject({ suppliedUsd: null, netUsd: null })
    expect(body.markets[0].points[0].observation.healthFactor).toBe('2000000000000000000')
    // The incentives share the floor: unstated before it, not zero.
    expect(body.points.every((p: { unclaimedRewardsUsd: unknown }) => p.unclaimedRewardsUsd === null)).toBe(true)
    expect(body.markets[0].points[0].unclaimedRewards).toEqual([])
  })

  it('keys a settling window on the window with the short TTL', async () => {
    app = await freshDataApp(mmClient())
    const res = await app.inject({ url: `/v1/accounts/${H160}/money-market/history?bucket=hour&groupBy=account`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const to = Date.UTC(2026, 7, 28, 12) / 1000
    const expiry = cacheExpiry(`data:accounts:mm-history:${mmAccountId()}:hour:${to - 90 * H}:${to}:all:account`)
    expect(expiry).not.toBeNull()
    expect(expiry! - Date.now()).toBeLessThanOrEqual(BUCKET_HISTORY_SETTLING_TTL_MS)
  })
})

// The canonical AccountId32 of the fixture's H160 (the EVM-truncated form).
function mmAccountId(): string { return mmEthAccountForm(H160) }

