import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

// GET /lending/v1/caps.
//
// The properties pinned here are the ones a base-URL swap off HydraDX-api depends
// on — the incumbent's four fields and the core HOLLAR row staying at index 0 —
// plus the two derivations that replaced its live RPC/GraphQL reads: caps decoded
// from undecoded pool-configurator logs, and the HOLLAR limit coming from the
// market's own facilitator rather than from an Aave cap that does not exist.

type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

vi.mock('../../src/services/poolService.ts', () => ({
  initPoolService: vi.fn(),
  getPoolsIndex: vi.fn(async () => ({ totalTvlUsd: 0, pools: [] })),
}))

const CORE_POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const GIGA_POOL = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
const HOLLAR_RESERVE = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const DOT_RESERVE = '0x0000000000000000000000000000000100000005'
const CORE_HOLLAR_ATOKEN = '0x8c0f3b9602374198974d2b2679d14a386f5b108e'
const GIGA_HOLLAR_ATOKEN = '0x116d7bb8e4e2a4c932b4d36c115d4122dc360462'
const DOT_ATOKEN = '0xaa00000000000000000000000000000000000005'
const CORE_CONFIGURATOR = '0xe64c38e2fa00dfe4f1d0b92f75b8e44ebdf292e4'

// 1 000 DOT supplied, 250 borrowed; HOLLAR minted (debt, no deposits) in two markets.
const RESERVE_ROWS: Row[] = [
  {
    pool_address: CORE_POOL, reserve_address: DOT_RESERVE, market_key: 'core', atoken: DOT_ATOKEN,
    block_height: 13_586_887, block_timestamp: '2026-08-12 22:55:06',
    supplied: '10000000000000', debt: '2500000000000', listed: 1,
  },
  {
    pool_address: CORE_POOL, reserve_address: HOLLAR_RESERVE, market_key: 'core', atoken: CORE_HOLLAR_ATOKEN,
    block_height: 13_586_486, block_timestamp: '2026-08-12 22:22:15',
    supplied: '0', debt: '10735924996230626593777299', listed: 1,
  },
  {
    pool_address: GIGA_POOL, reserve_address: HOLLAR_RESERVE, market_key: 'gigahdx', atoken: GIGA_HOLLAR_ATOKEN,
    block_height: 13_576_461, block_timestamp: '2026-08-12 06:44:12',
    supplied: '0', debt: '223693541371114989464001', listed: 1,
  },
]

const CAP_EVENT_ROWS: Row[] = [
  {
    configurator: CORE_CONFIGURATOR, kind: 'init', asset: DOT_RESERVE, atoken: DOT_ATOKEN,
    new_cap: '0', block_height: 6_382_910, block_timestamp: '2024-11-12 14:40:00',
  },
  {
    configurator: CORE_CONFIGURATOR, kind: 'supply', asset: DOT_RESERVE, atoken: '',
    new_cap: '5000000', block_height: 7_350_210, block_timestamp: '2025-04-16 21:21:24',
  },
  {
    configurator: CORE_CONFIGURATOR, kind: 'borrow', asset: DOT_RESERVE, atoken: '',
    new_cap: '10000000', block_height: 8_097_463, block_timestamp: '2025-06-27 15:19:42',
  },
  // A later change wins; the rows arrive in block order.
  {
    configurator: CORE_CONFIGURATOR, kind: 'supply', asset: DOT_RESERVE, atoken: '',
    new_cap: '25000000', block_height: 9_446_471, block_timestamp: '2025-09-30 15:53:06',
  },
  {
    configurator: CORE_CONFIGURATOR, kind: 'borrow', asset: DOT_RESERVE, atoken: '',
    new_cap: '17000000', block_height: 9_446_471, block_timestamp: '2025-09-30 15:53:06',
  },
]

const FACILITATOR_ROWS: Row[] = [
  { facilitator: CORE_HOLLAR_ATOKEN, capacity: '12000000000000000000000000', block_height: 12_017_893, block_timestamp: '2026-04-08 01:08:36' },
  { facilitator: GIGA_HOLLAR_ATOKEN, capacity: '222222000000000000000000', block_height: 12_959_351, block_timestamp: '2026-07-01 07:11:36' },
  // The HSM pallet mints HOLLAR outside the money market; it is no market's
  // aToken, so its capacity must not become a reserve's borrow cap.
  { facilitator: '0x6d6f646c70792f68736d6f640000000000000000', capacity: '18000000000000000000000000', block_height: 10_479_714, block_timestamp: '2025-12-12 21:19:57' },
]

function fakeClient(overrides: Record<string, Row[]> = {}) {
  const byMarker: Record<string, Row[]> = {
    '-- pub:mm:reserve-state': RESERVE_ROWS,
    '-- pub:caps:aave': CAP_EVENT_ROWS,
    '-- pub:caps:facilitator': FACILITATOR_ROWS,
    'FROM price_data.prices': [{ asset_id: 5, price: '0.75' }],
    ...overrides,
  }
  return {
    query: vi.fn(({ query }: { query: string }) => {
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
}

async function freshApp(client: unknown) {
  vi.resetModules()
  const assets = await import('../../src/services/explorerAssets.ts')
  await assets.loadExplorerAssets(client as never)
  const { buildPublicApp } = await import('../../src/public/app.ts')
  const app: FastifyInstance = await buildPublicApp({ client: client as never, logger: false })
  return { app, stop: assets.stopExplorerAssetsRefresh }
}

let stopAssets: () => void
beforeAll(async () => {
  const assets = await import('../../src/services/explorerAssets.ts')
  await assets.loadExplorerAssets(fakeClient() as never)
  stopAssets = assets.stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

describe('GET /lending/v1/caps', () => {
  it('keeps the incumbent\'s HOLLAR row first and its four fields intact', async () => {
    const { app, stop } = await freshApp(fakeClient())
    try {
      const res = await app.inject('/lending/v1/caps')
      expect(res.statusCode).toBe(200)
      const rows = res.json()
      expect(rows).toHaveLength(3)

      // A consumer reading body[0] must still read the core market's HOLLAR cap.
      expect(rows[0]).toMatchObject({
        asset: 'Hydrated Dollar',
        borrowCap: 12_000_000,
        borrowCapSource: 'facilitator',
        market: 'core',
        assetId: '222',
        symbol: 'HOLLAR',
        // The facilitator capacity is raw (18 decimals); the debt is the
        // variable-debt token's totalSupply, which is what the incumbent read
        // over RPC.
        currentBorrow: 10_735_924.996230626,
        // HOLLAR is minted, never deposited, so there is nothing to utilize.
        currentSupply: 0,
        utilization: null,
        supplyCap: null,
        asOf: '2026-08-12T22:22:15.000Z',
      })
      expect(rows[0].available).toBeCloseTo(12_000_000 - 10_735_924.996230626, 6)

      expect(res.headers['cache-control']).toBe('public, max-age=60')
    } finally { await app.close(); stop() }
  })

  // The compatibility contract for row 0, held separately from the values. Probed
  // on the incumbent 2026-08-13 via api.nice.hydration.cloud (api.hydradx.io
  // answers 500 — a GraphQL 404 on aaveFacilitatorHistoricalData):
  //   [{"asset":"Hydrated Dollar","borrowCap":12000000,
  //     "currentBorrow":10711766.633749591,"available":1288233.3662504088}]
  // One string then three JSON numbers, in that order. Our rows are a superset,
  // so what has to hold is that those four stay FIRST and keep their types.
  it('opens row 0 with the incumbent\'s four keys, in its order and its types', async () => {
    const { app, stop } = await freshApp(fakeClient())
    try {
      const res = await app.inject('/lending/v1/caps')
      const rows = res.json() as Record<string, unknown>[]
      expect(Array.isArray(rows)).toBe(true)
      const legacy = ['asset', 'borrowCap', 'currentBorrow', 'available']
      // A JS object's key order IS its wire order. The inherited keys lead every
      // row, so a consumer that logs or positionally reads one is unaffected by
      // the detail appended after them.
      for (const row of rows) expect(Object.keys(row).slice(0, 4)).toEqual(legacy)
      expect(legacy.map(k => typeof rows[0][k])).toEqual(['string', 'number', 'number', 'number'])
      // Numbers, never the decimal STRINGS the /v1 surfaces carry.
      expect(res.body).not.toMatch(/"(borrowCap|currentBorrow|available)":\s*"/)
    } finally { await app.close(); stop() }
  })

  it('reports per-reserve Aave caps and utilization for the rest', async () => {
    const { app, stop } = await freshApp(fakeClient())
    try {
      const rows = (await app.inject('/lending/v1/caps')).json()
      const dot = rows.find((r: { symbol: string }) => r.symbol === 'DOT')
      expect(dot).toEqual({
        asset: 'Polkadot',
        // Aave stores caps in WHOLE tokens, and the newest change wins.
        borrowCap: 17_000_000,
        supplyCap: 25_000_000,
        borrowCapSource: 'poolConfigurator',
        currentBorrow: 250,
        currentSupply: 1000,
        available: 17_000_000 - 250,
        utilization: 0.25,
        market: 'core',
        assetId: '5',
        symbol: 'DOT',
        asOf: '2026-08-12T22:55:06.000Z',
      })
    } finally { await app.close(); stop() }
  })

  it('attributes a facilitator capacity to the market whose aToken it is, and ignores the rest', async () => {
    const { app, stop } = await freshApp(fakeClient())
    try {
      const rows = (await app.inject('/lending/v1/caps')).json()
      const giga = rows.find((r: { market: string; symbol: string }) => r.market === 'gigahdx' && r.symbol === 'HOLLAR')
      // GIGAHDX's own facilitator, not the core market's and not the HSM pallet's
      // 18 M — the isolated markets are never blended.
      expect(giga.borrowCap).toBe(222_222)
      expect(giga.borrowCapSource).toBe('facilitator')
      expect(rows.every((r: { borrowCap: number | null }) => r.borrowCap !== 18_000_000)).toBe(true)
    } finally { await app.close(); stop() }
  })

  it('serves an empty array when the money-market reserve model has no state', async () => {
    const { app, stop } = await freshApp(fakeClient({ '-- pub:mm:reserve-state': [] }))
    try {
      const res = await app.inject('/lending/v1/caps')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    } finally { await app.close(); stop() }
  })

  it('never lets a SELECT alias shadow a column its own filter or ordering key reads', async () => {
    // Both cap queries alias aggregates beside the columns they aggregate, and
    // ClickHouse resolves a bare name against the SELECT's aliases FIRST. Written
    // the obvious way — `argMax(topic0, …) AS topic0` with `WHERE topic0 IN (…)`,
    // or `max(block_height) AS block_height` beside `argMax(…, tuple(block_height,
    // …))` — both queries are rejected at runtime, and a mocked client cannot see
    // it. Two rules keep them valid: filters are table-qualified, and an aggregate
    // alias never reuses a source column's name.
    const source = readFileSync(new URL('../../src/public/services/lendingCaps.ts', import.meta.url), 'utf8')
    expect(source).toContain('WHERE raw_evm_logs.topic0 IN')
    expect(source).toContain('WHERE raw_money_market_reserves.event_name IN')
    // No aggregate is aliased back onto the column it reads.
    for (const column of ['topic0', 'topics', 'data', 'block_timestamp', 'block_height', 'contract_address', 'event_name']) {
      expect(source, `an aggregate aliased to '${column}' shadows the column`)
        .not.toMatch(new RegExp(`(argMax|max|min|any)\\([^)]*\\)\\s+AS ${column}\\b`))
    }
  })

  it('computes whole-token amounts and utilization on the integers', async () => {
    const { tokenAmount, utilizationRatio, configuratorMarkets, orderCaps } =
      await import('../../src/public/services/lendingCaps.ts')

    // A 27-digit HOLLAR debt: the division happens on the bigint, so only the
    // precision a double cannot hold is lost.
    expect(tokenAmount(10_735_924_996_230_626_593_777_299n, 18)).toBeCloseTo(10_735_924.996230626, 6)
    expect(tokenAmount(0n, 18)).toBe(0)
    expect(tokenAmount(1n, 18)).toBe(1e-18)

    expect(utilizationRatio(1000n, 250n)).toBe(0.25)
    // Nothing supplied is not zero utilization, and not infinity either.
    expect(utilizationRatio(0n, 500n)).toBeNull()

    // A configurator is attributed through the aTokens its initializations made.
    expect(configuratorMarkets(
      [{ configurator: 'cfg', kind: 'init', asset: 'a', atoken: 'at', new_cap: '0', block_height: 1, block_timestamp: '' }],
      new Map([['at', 'pool']]),
    )).toEqual(new Map([['cfg', 'pool']]))

    // Legacy row first, then a stable (market, symbol) order.
    const ordered = orderCaps([
      { market: 'gigahdx', symbol: 'HOLLAR', borrowCapSource: 'facilitator' },
      { market: 'core', symbol: 'DOT', borrowCapSource: 'poolConfigurator' },
      { market: 'core', symbol: 'HOLLAR', borrowCapSource: 'facilitator' },
    ] as never)
    expect(ordered.map(r => `${r.market}:${r.symbol}`)).toEqual(['core:HOLLAR', 'core:DOT', 'gigahdx:HOLLAR'])
  })
})
