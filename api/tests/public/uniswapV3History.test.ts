import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetCacheForTests } from '../../src/services/cache.ts'
import { V3_HISTORY_DEFAULT_BUCKETS, V3_HISTORY_MAX_BUCKETS, v3HistoryWindow } from '../../src/public/routes/pools.ts'

// The vault and position manager the fixture's ranges belong to.
const VAULT = '0xa206d0959813f17c17c87147271c49065438648a'
const MANAGER = '0xd5029e471ee3f6f51fefb63fed0482a74bb310b3'

// /v1/pools/uniswapv3/{pool}/history: the same builder the explorer's pool page
// charts read, on fixed public buckets. The fake client answers each of the
// builder's reads by its SQL marker.

type Row = Record<string, unknown>
const POOL = '0x5c6208a3c316a801f8996750aa7b6f45fc988548'
const ADOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'

const ASSET_ROWS: Row[] = [
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

function result(rows: Row[]) { return { json: async () => rows } }

function fakeClient(byMarker: Record<string, Row[]> = {}, registry: { vaults?: Row[]; managers?: Row[] } = {}) {
  const seen: { query: string; params: Record<string, unknown> }[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      // The v3 registry the pool lookup reads.
      if (query.includes('FROM price_data.uniswap_v3_pools FINAL')) return result([{ pool_address: POOL, factory: '0x776c4fd6a6170165a91ba45dec40a14bcc8ec354', token0: ADOT, token1: HOLLAR, fee: 3000, tick_spacing: 60, block_height: 14359646, ts: '2026-09-01 10:37:24', extrinsic_index: 2 }])
      if (query.includes('FROM price_data.uniswap_v3_vaults FINAL')) return result(registry.vaults ?? [])
      if (query.includes("kind = 'manager' AND event_name = 'IncreaseLiquidity'")) return result(registry.managers ?? [])
      if (query.includes('FROM price_data.atoken_reserve_map FINAL')) return result([{ atoken: ADOT, reserve: '0x0000000000000000000000000000000100000005' }])
      if (query.includes("kind = 'manager' AND event_name = 'Transfer'")) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
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
  resetCacheForTests()
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

describe('v3HistoryWindow', () => {
  const now = Date.UTC(2026, 8, 9, 15, 30) / 1000
  it('defaults to the most recent buckets and never returns the bucket in progress', () => {
    const w = v3HistoryWindow('1d', undefined, undefined, now)
    if ('error' in w) throw new Error(w.error)
    expect(w.toSec).toBe(Date.UTC(2026, 8, 9) / 1000)
    expect((w.toSec - w.fromSec) / 86_400).toBe(V3_HISTORY_DEFAULT_BUCKETS)
  })
  it('floors the bounds onto the grid and refuses an inverted or oversize window', () => {
    const w = v3HistoryWindow('1h', '2026-09-09T08:20:00Z', '2026-09-09T11:59:00Z', now)
    if ('error' in w) throw new Error(w.error)
    expect(w.fromSec).toBe(Date.UTC(2026, 8, 9, 8) / 1000)
    expect(w.toSec).toBe(Date.UTC(2026, 8, 9, 11) / 1000)
    expect(v3HistoryWindow('1h', '2026-09-09T11:00:00Z', '2026-09-09T08:00:00Z', now)).toEqual({ error: '`from` must be before `to`' })
    expect(v3HistoryWindow('1h', '2026-05-01T00:00:00Z', '2026-09-09T00:00:00Z', now)).toMatchObject({ error: expect.stringContaining(`${V3_HISTORY_MAX_BUCKETS}`) })
  })
  it('a period is the switch a chart offers: the window ends at the last closed bucket and spans the period', () => {
    const w = v3HistoryWindow('1h', undefined, undefined, now, '7d')
    if ('error' in w) throw new Error(w.error)
    expect(w.toSec).toBe(Date.UTC(2026, 8, 9, 15) / 1000)
    expect(w.toSec - w.fromSec).toBe(7 * 86_400)
    // A period and a `from` contradict each other.
    expect(v3HistoryWindow('1h', '2026-09-01T00:00:00Z', undefined, now, '7d')).toMatchObject({ error: expect.stringContaining('period') })
  })
})

describe('GET /v1/pools/uniswapv3/{pool}/history', () => {
  it('serves closed daily buckets with the price carried through a swap-less day', async () => {
    const client = fakeClient({
      '-- v3:history:facts': [{ swaps: 2, first_sec: Date.UTC(2026, 8, 1, 10) / 1000, last_sec: Date.UTC(2026, 8, 2, 9) / 1000, n: 10 }],
      '-- v3:history:carry': [{ close: 0, tick: 0, priced: 0, flow0: '0', flow1: '0' }],
      // The vault's range is minted on the 1st and straddles every tick the pool visits.
      '-- v3:history:ranges': [{ d: '2026-09-01', tick_lower: 184860, tick_upper: 186840, delta: '4504017577969432095' }],
      '-- v3:history:buckets': [
        { d: '2026-09-01', open: 1.09068003, high: 1.09068003, low: 1.09068003, close: 1.09068003, tick: 185084, swaps: 0, inits: 1, volume0: '0', volume1: '0', fees0: '0', fees1: '0', flow0: '10000000000', flow1: '1000000000000000000', last_block: 14359650 },
        { d: '2026-09-02', open: 1.17670787, high: 1.18429586, low: 1.17670787, close: 1.18429586, tick: 185907, swaps: 2, inits: 0, volume0: '1546143528', volume1: '179124142876300219', fees0: '0', fees1: '537372428628900', flow0: '-1546143528', flow1: '179124142876300219', last_block: 14397741 },
      ],
      '-- v3:history:prices': [
        { asset_id: 5, d: '2026-09-01', close: 1.17 }, { asset_id: 222, d: '2026-09-01', close: 1.0 },
        { asset_id: 5, d: '2026-09-02', close: 1.18 }, { asset_id: 222, d: '2026-09-02', close: 0.999 },
        { asset_id: 5, d: '2026-09-03', close: 1.19 }, { asset_id: 222, d: '2026-09-03', close: 0.999 },
      ],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject(`/v1/pools/uniswapv3/${POOL}/history?bucket=1d&from=2026-09-01T00:00:00Z&to=2026-09-04T00:00:00Z`)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      // The UI polls these while a period switch is used: a shared 30 s micro-cache.
      expect(res.headers['cache-control']).toBe('public, max-age=30')
      expect(body.pool).toBe(POOL)
      expect(body.token0).toBe('1001'); expect(body.token1).toBe('222'); expect(body.fee).toBe(3000); expect(body.bucket).toBe('1d')
      // Three closed days: the fixture sits a week behind any clock this test runs on.
      expect(body.items.map((i: { timestamp: string }) => i.timestamp)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'])
      const [d8, d9, d10] = body.items
      // Liquidity is active from the mint on, a swap is not what switches it on.
      expect(d8).toMatchObject({ swaps: 0, open: '1.09068003', close: '1.09068003', balance0: '10000000000', volume0: '0', liquidity: '4504017577969432095' })
      expect(d9).toMatchObject({ swaps: 2, open: '1.17670787', high: '1.18429586', close: '1.18429586', volume0: '1546143528', liquidity: '4504017577969432095', balance0: '8453856472' })
      // No swap on the 3rd: the price is the 2nd's close, the volume 0 — never a hole.
      expect(d10).toMatchObject({ swaps: 0, open: '1.18429586', close: '1.18429586', volumeUsd: '0.00', liquidity: '4504017577969432095' })
      // USD: one side of the swaps (aDOT priced as DOT) — mean of 0.1546 × 1.18 and 0.179 × 0.999.
      expect(Number(d9.volumeUsd)).toBeCloseTo((0.1546143528 * 1.18 + 0.179124142876300219 * 0.999) / 2, 2)
      // Every read was bounded to the pool.
      for (const { query, params } of client.seen.filter(s => s.query.includes('-- v3:history:'))) {
        if (query.includes('uniswap_v3_events')) expect(params.pool).toBe(POOL)
      }
    } finally { await app.close() }
  })

  it('never pads the window with buckets from before the pool existed', async () => {
    const client = fakeClient({
      '-- v3:history:facts': [{ swaps: 2, first_sec: Date.UTC(2026, 8, 1, 10) / 1000, last_sec: Date.UTC(2026, 8, 2, 9) / 1000, n: 10 }],
      '-- v3:history:carry': [{ close: 0, tick: 0, priced: 0, flow0: '0', flow1: '0' }],
      '-- v3:history:ranges': [], '-- v3:history:buckets': [], '-- v3:history:prices': [],
    })
    const app = await buildApp(client)
    try {
      // A month asked for, a pool three days old: three closed days come back, not thirty-four.
      const res = await app.inject(`/v1/pools/uniswapv3/${POOL}/history?bucket=1d&from=2026-08-01T00:00:00Z&to=2026-09-04T00:00:00Z`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((i: { timestamp: string }) => i.timestamp)).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'])
      // The reads started at the pool's first event, not at the requested `from`.
      const read = client.seen.find(s => s.query.includes('-- v3:history:buckets'))
      expect(read?.params.from).toBe(Date.UTC(2026, 8, 1, 10) / 1000)
    } finally { await app.close() }
  })

  it('a period picks the bucket a chart switch wants unless the caller names one', async () => {
    const client = fakeClient({
      '-- v3:history:facts': [{ swaps: 2, first_sec: Date.UTC(2026, 8, 1, 10) / 1000, last_sec: Date.UTC(2026, 8, 2, 9) / 1000, n: 10 }],
      '-- v3:history:carry': [{ close: 0, tick: 0, priced: 0, flow0: '0', flow1: '0' }],
      '-- v3:history:ranges': [], '-- v3:history:buckets': [], '-- v3:history:prices': [],
    })
    const app = await buildApp(client)
    try {
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=24h`)).json().bucket).toBe('1h')
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=7d`)).json().bucket).toBe('1h')
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=30d`)).json().bucket).toBe('4h')
      const year = (await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=1y`)).json()
      expect(year.bucket).toBe('1d')
      // The pool is younger than the period: its first bucket is the pool's, not a year back.
      expect(year.items[0].timestamp).toBe('2026-09-01T00:00:00.000Z')
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=24h&bucket=1d`)).json().bucket).toBe('1d')
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?period=7d&from=2026-09-01T00:00:00Z`)).statusCode).toBe(400)
    } finally { await app.close() }
  })

  it('answers 404 for a contract that is not a pool and 400 for a malformed key or window', async () => {
    const client = fakeClient()
    const app = await buildApp(client)
    try {
      expect((await app.inject('/v1/pools/uniswapv3/0x1111111111111111111111111111111111111111/history')).statusCode).toBe(404)
      expect((await app.inject('/v1/pools/uniswapv3/nope/history')).statusCode).toBe(400)
      expect((await app.inject(`/v1/pools/uniswapv3/${POOL}/history?bucket=1h&from=2026-01-01T00:00:00Z&to=2026-09-09T00:00:00Z`)).statusCode).toBe(400)
    } finally { await app.close() }
  })
})

describe('GET /v1/pools/uniswapv3/{pool}/liquidity', () => {
  it('serves the open ranges as ticks and segments, valued at the current tick, with each owner named', async () => {
    const client = fakeClient({
      '-- v3:liquidity:ranges': [
        { owner: VAULT, tick_lower: 184860, tick_upper: 186840, net: '4504017577969432095', mints: 2 },
        { owner: MANAGER, tick_lower: 185880, tick_upper: 185940, net: '11', mints: 2 },
        { owner: '0x000000000000000000000000000000000000dead', tick_lower: 190000, tick_upper: 190060, net: '7', mints: 1 },
      ],
      '-- v3:liquidity:state': [{ tick: 185907, sqrt: '862203316974439708502410565924684', priced: 3, last_block: 14404139, n: 193 }],
    }, {
      vaults: [{ vault_address: VAULT, factory: '0x02b5b5ee8f7d7a5b0f8b0d4b4bd4b8dfc9a3fd0e', token0: ADOT, token1: HOLLAR, fee: 3000, vault_index: 0, block_height: 14359700, ts: '2026-09-01 10:40:00', event_index: 3 }],
      managers: [{ contract_address: MANAGER }],
    })
    const app = await buildApp(client)
    try {
      const res = await app.inject(`/v1/pools/uniswapv3/${POOL}/liquidity`)
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('public, max-age=30')
      const body = res.json()
      expect(body).toMatchObject({ pool: POOL, token0: '1001', token1: '222', fee: 3000, tickSpacing: 60, tick: 185907, blockHeight: 14404139 })
      expect(body.price).toBe('1.18429586')
      // Two ranges straddle the tick: the vault's and the manager's tiny one.
      expect(body.liquidity).toBe('4504017577969432106')
      expect(body.ticks.map((t: { tick: number; liquidityNet: string }) => [t.tick, t.liquidityNet])).toEqual([
        [184860, '4504017577969432095'], [185880, '11'], [185940, '-11'], [186840, '-4504017577969432095'], [190000, '7'], [190060, '-7'],
      ])
      expect(body.segments.map((s: { tickLower: number; tickUpper: number; liquidity: string }) => [s.tickLower, s.tickUpper, s.liquidity])).toEqual([
        [184860, 185880, '4504017577969432095'], [185880, 185940, '4504017577969432106'], [185940, 186840, '4504017577969432095'], [190000, 190060, '7'],
      ])
      // The straddling segment holds both tokens; one entirely above the price holds token0 only.
      const [below, at, above] = body.segments
      expect(BigInt(below.amount1) > 0n && below.amount0 === '0').toBe(true)
      expect(BigInt(at.amount0) > 0n && BigInt(at.amount1) > 0n).toBe(true)
      expect(BigInt(above.amount0) > 0n && above.amount1 === '0').toBe(true)
      expect(body.ranges.map((r: { ownerKind: string; inRange: boolean; positions: number }) => [r.ownerKind, r.inRange, r.positions])).toEqual([
        ['vault', true, 2], ['manager', true, 2], ['direct', false, 1],
      ])
      expect(body.ranges[0].priceLower).toBe('1.06651360727')
      // Bounded to the pool.
      for (const { query, params } of client.seen.filter(s => s.query.includes('-- v3:liquidity:'))) {
        if (query.includes('uniswap_v3_events')) expect(params.pool).toBe(POOL)
      }
    } finally { await app.close() }
  })
})
