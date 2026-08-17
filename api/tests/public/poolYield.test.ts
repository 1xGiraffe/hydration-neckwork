import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Yield endpoints and the APR/APY math. The pinned numbers below are computed
// from the spec's formulas, not from this implementation's output:
//   annualizeApr(f, W) = 100 · f · 365/W
//   aprToApy(apr, W)   = 100 · ((1 + (apr/100)·W/365)^(365/W) − 1)
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

const ANCHOR_ROW: Row = { legs: '4200', anchor: '2026-08-12 18:22:36', block_height: 9123456 }
const ANCHOR_ISO = '2026-08-12T18:22:36.000Z'

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      // No farm running unless a test says so: the farm APR (farmApr.ts) reads its
      // own tables off the same anchor, and stops after the config read when the
      // fold finds nothing active.
      if (query.includes('-- pub:farm:')) return result([])
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
  return client
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

async function buildApp(client: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

describe('annualizeApr', () => {
  it('scales a period ratio to a yearly percentage at four decimals', async () => {
    const { annualizeApr } = await import('../../src/public/services/poolYield.ts')
    // 100 · 0.001 · 365/30 = 1.21666… %
    expect(annualizeApr('0.001', 30)).toBe('1.2167')
    // A full year is the identity case: 100 · 0.0005 · 1 = 0.05 %
    expect(annualizeApr('0.0005', 365)).toBe('0.0500')
    // 100 · 0.00012345 · 365/7 = 0.6437035… %
    expect(annualizeApr('0.00012345', 7)).toBe('0.6437')
    expect(annualizeApr('0', 30)).toBe('0.0000')
    // 100 · 1 · 365 = 36 500 %
    expect(annualizeApr('1', 1)).toBe('36500.0000')
  })

  it('rounds half up on the exact midpoint', async () => {
    const { annualizeApr } = await import('../../src/public/services/poolYield.ts')
    // 100 · 0.0000005 · 365 = 0.018250 exactly → 0.0183, not 0.0182
    expect(annualizeApr('0.0000005', 1)).toBe('0.0183')
  })

  it('keeps full precision on ratios no double could hold', async () => {
    const { annualizeApr } = await import('../../src/public/services/poolYield.ts')
    // 18 significant decimals: a float would have dropped the tail before scaling.
    expect(annualizeApr('0.000000000000000001', 365)).toBe('0.0000')
    expect(annualizeApr('0.123456789012345678', 365)).toBe('12.3457')
  })

  it('refuses a window that cannot annualize', async () => {
    const { annualizeApr } = await import('../../src/public/services/poolYield.ts')
    expect(() => annualizeApr('0.001', 0)).toThrow(RangeError)
    expect(() => annualizeApr('0.001', -30)).toThrow(RangeError)
  })
})

describe('aprToApy', () => {
  it('compounds the period return over a year', async () => {
    const { aprToApy } = await import('../../src/public/services/poolYield.ts')
    // period return 1.2167 · 30/365 % → compounded 365/30 times = 1.22351… %
    expect(aprToApy('1.2167', 30)).toBe('1.2235')
    expect(aprToApy('0.7044', 30)).toBe('0.7067')
    expect(aprToApy('5', 7)).toBe('5.1246')
    // One period per year: no compounding at all.
    expect(aprToApy('10', 365)).toBe('10.0000')
    expect(aprToApy('0', 30)).toBe('0.0000')
  })

  it('never emits exponent notation for an absurd rate', async () => {
    const { aprToApy } = await import('../../src/public/services/poolYield.ts')
    const huge = aprToApy('36500', 1)
    expect(huge).not.toMatch(/e/i)
    expect(huge).toMatch(/^\d+\.\d{4}$/)
  })
})

describe('yield SQL invariants', () => {
  it('counts only non-burned fee legs', async () => {
    const { buildOmnipoolYieldSql, buildStableswapYieldSql } = await import('../../src/public/services/poolYield.ts')
    for (const sql of [buildOmnipoolYieldSql(), buildStableswapYieldSql()]) {
      expect(sql).toContain("fee_dest != 'burned'")
    }
  })

  it('counts only the omnipool asset fee that STAYED IN THE POOL', async () => {
    // The runtime splits an asset fee across recipients and emits one leg per
    // recipient, so "not burned" is about half the fee: the rest goes to staking
    // and referrals (until 2026-06-22) or to the fee processor (since). An
    // unfiltered numerator publishes ~1.9x the rate an LP earns.
    const { OMNIPOOL_ACCOUNT } = await import('../../src/public/services/poolVolumes.ts')
    const { buildOmnipoolYieldSql } = await import('../../src/public/services/poolYield.ts')
    const sql = buildOmnipoolYieldSql()
    expect(sql).toContain('argMax(fee_recipient, ingested_at) AS fee_recipient')
    // The asset-fee numerator is recipient-filtered; the legacy '' recipient is
    // included on purpose (pre-2025-01-25 legs carry none), which the served 7d
    // and 30d windows never reach.
    const end = sql.indexOf('AS asset_fees')
    const start = sql.lastIndexOf('groupArrayIf(', end)
    expect(start).toBeGreaterThan(-1)
    const assetFees = sql.slice(start, end)
    expect(assetFees).toContain(`fee_recipient = '${OMNIPOOL_ACCOUNT}'`)
    expect(assetFees).toContain("fee_recipient = ''")
    expect(assetFees).toContain("fee_dest != 'burned'")
  })

  it('leaves the LRNA protocol fee unfiltered by recipient', async () => {
    // Every destination the hub fee has ever had is protocol revenue, so
    // narrowing it to the pool account would report a rate nobody earns.
    const { buildOmnipoolYieldSql } = await import('../../src/public/services/poolYield.ts')
    const hubFee = /sumIf\(toDecimal256\(amount, 0\), (.*?)\) AS hub_fee_raw/.exec(buildOmnipoolYieldSql())
    expect(hubFee).not.toBeNull()
    expect(hubFee![1]).toBe("leg_kind = 'fee' AND asset_id = 1 AND fee_dest != 'burned'")
  })

  it('deduplicates both the legs and the state-history samples before averaging', async () => {
    const { buildOmnipoolYieldSql, buildStableswapYieldSql } = await import('../../src/public/services/poolYield.ts')
    const omni = buildOmnipoolYieldSql()
    expect(omni).toMatch(/GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index/)
    expect(omni).toContain('argMax(reserve_raw, ingested_at)')
    expect(omni).toContain('argMax(hub_reserve_raw, ingested_at)')
    expect(omni).toContain('GROUP BY asset_id, block_height')
    const ss = buildStableswapYieldSql()
    expect(ss).toContain('argMax(reserves_raw, ingested_at)')
    expect(ss).toContain('GROUP BY pool_id, block_height')
  })

  it('averages the reserve over in-window grid samples only', async () => {
    const { buildOmnipoolYieldSql } = await import('../../src/public/services/poolYield.ts')
    const sql = buildOmnipoolYieldSql()
    // A delisted asset keeps its last state row forever, so an unwindowed argMax
    // would value today's fees against a months-old reserve.
    expect(sql).toContain('block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR')
    expect(sql).toContain('block_timestamp <= {anchor:DateTime}')
  })
})

describe('omnipoolYield', () => {
  it('turns raw fee-over-reserve ratios into APR and APY', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:yield:omnipool': [
        { asset_id: '5', samples: '4320', fee_ratio: '0.001000000000000000', protocol_fee_ratio: '0.000500000000000000' },
        // No state-history sample in the window: the denominator is unknown, so
        // the APR is null rather than a number invented from a stale reserve.
        { asset_id: '222', samples: '0', fee_ratio: '0.000000000000000000', protocol_fee_ratio: '0.000000000000000000' },
      ],
    })
    const { omnipoolYield } = await import('../../src/public/services/poolYield.ts')
    expect(await omnipoolYield(client as never, '30d')).toEqual({
      asOf: ANCHOR_ISO,
      items: [
        { assetId: '5', feeAprPerc: '1.2167', feeApyPerc: '1.2235', farmAprPerc: null, farmRewardAssets: [], protocolFeeAprPerc: '0.6083' },
        { assetId: '222', feeAprPerc: null, feeApyPerc: null, farmAprPerc: null, farmRewardAssets: [], protocolFeeAprPerc: null },
      ],
    })
    const main = client.seen.find(s => s.query.includes('-- pub:yield:omnipool'))!
    expect(main.params.hours).toBe(720)
  })

  it('carries the farm APR of the assets that have one, off the same anchor', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:yield:omnipool': [
        { asset_id: '5', samples: '4320', fee_ratio: '0.001000000000000000', protocol_fee_ratio: '0.000000000000000000' },
        { asset_id: '222', samples: '4320', fee_ratio: '0.001000000000000000', protocol_fee_ratio: '0.000000000000000000' },
      ],
      // One farm on HOLLAR paying 0.01 HOLLAR/period over $1 000 000 staked
      // (half of a 2 000 000 HOLLAR reserve): 0.01 · 5 259 492 / 1e6 = 5.2595 %.
      '-- pub:farm:config': [
        {
          event_name: 'GlobalFarmCreated', global_farm_id: '133', yield_farm_id: '',
          block_height: '12228202', event_index: '10', block_timestamp: '2026-04-27 09:10:36',
          args_json: JSON.stringify({
            id: 133, rewardCurrency: 222, totalRewards: '126000000000000000000000',
            yieldPerPeriod: '41856925419', plannedYieldingPeriods: 2628000, blocksPerPeriod: 1,
            maxRewardPerPeriod: '10000000000000000', minDeposit: '1326259946950',
          }),
        },
        {
          event_name: 'YieldFarmCreated', global_farm_id: '133', yield_farm_id: '139',
          block_height: '12228202', event_index: '11', block_timestamp: '2026-04-27 09:10:36',
          args_json: JSON.stringify({ globalFarmId: 133, yieldFarmId: 139, assetId: 222, multiplier: '1000000000000000000' }),
        },
      ],
      '-- pub:farm:tvl': [{
        asset_id: '222', positions: '3',
        farmed_shares: '2000000000000000000000000', pool_shares: '4000000000000000000000000',
        reserve_raw: '2000000000000000000000000', sample_time: '2026-08-12 18:00:00',
      }],
      '-- pub:farm:price': [{ asset_id: '222', close: '1.000000000000', price_time: '2026-08-12 18:00:00' }],
    })
    const { omnipoolYield } = await import('../../src/public/services/poolYield.ts')
    const { items } = await omnipoolYield(client as never, '24h')
    expect(items).toEqual([
      { assetId: '5', feeAprPerc: '36.5000', feeApyPerc: '44.0251', farmAprPerc: null, farmRewardAssets: [], protocolFeeAprPerc: '0.0000' },
      { assetId: '222', feeAprPerc: '36.5000', feeApyPerc: '44.0251', farmAprPerc: '5.2595', farmRewardAssets: ['222'], protocolFeeAprPerc: '0.0000' },
    ])
    // The farm rate is current state, so it reads the yield surface's own anchor.
    expect(client.seen.find(s => s.query.includes('-- pub:farm:tvl'))!.params.anchor).toBe(ANCHOR_ROW.anchor)
  })
})

describe('GET /v1/pools/:venue/yield', () => {
  it('serves omnipool yield with the 10-minute cache header', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:yield:omnipool': [
        { asset_id: '5', samples: '1008', fee_ratio: '0.001000000000000000', protocol_fee_ratio: '0.000000000000000000' },
      ],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/v1/pools/omnipool/yield?window=7d')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        window: '7d',
        asOf: ANCHOR_ISO,
        // 100 · 0.001 · 365/7 = 5.2143 %
        items: [{ assetId: '5', feeAprPerc: '5.2143', feeApyPerc: '5.3499', farmAprPerc: null, farmRewardAssets: [], protocolFeeAprPerc: '0.0000' }],
      })
      expect(res.headers['cache-control']).toBe('public, max-age=600')
    } finally { await app.close() }
  })

  it('serves stableswap yield from the USD-weighted ratio', async () => {
    const client = fakeClient({
      '-- pub:vol:anchor': [ANCHOR_ROW],
      '-- pub:yield:stableswap': [
        { pool_id: '690', samples: '4320', fee_usd: '1234.500000000000', fee_ratio: '0.001000000000000000' },
        { pool_id: '102', samples: '0', fee_usd: '0.000000000000', fee_ratio: '0.000000000000000000' },
      ],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject('/v1/pools/stableswap/yield')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        window: '30d',
        asOf: ANCHOR_ISO,
        items: [
          { poolId: '690', feeAprPerc: '1.2167', feeApyPerc: '1.2235', farmAprPerc: null },
          { poolId: '102', feeAprPerc: null, feeApyPerc: null, farmAprPerc: null },
        ],
      })
    } finally { await app.close() }
  })

  it('rejects a window the yield model does not serve', async () => {
    const client = fakeClient({ '-- pub:vol:anchor': [ANCHOR_ROW] })
    const app = await buildApp(client)
    try {
      for (const window of ['1h', 'all', '1y', '2h']) {
        const res = await app.inject(`/v1/pools/omnipool/yield?window=${window}`)
        expect(res.statusCode, window).toBe(400)
      }
    } finally { await app.close() }
  })
})
