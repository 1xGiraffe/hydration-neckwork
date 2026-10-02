import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { cacheExpiry } from '../../src/services/cache.ts'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for the USD volume routes: GET /v1/stats/volume/usd (the three
// hourly folds — routed, pool/venue, asset — read with a plain GROUP BY, the
// fold's published cut stated) and GET /v1/accounts/{address}/volume (the netted
// per-trade model on the fixed bucket grid, one holder's two storage keys).

type Row = Record<string, unknown>

let app: FastifyInstance | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

const WINDOW = 'fromTime=2026-08-20T00:00:00Z&toTime=2026-08-22T00:00:00Z'
const CUT = [{ cut: '2026-08-28 11:00:00', n: '1234' }]

function volumeClient(rows: Row[]) {
  return fakeDataClient(
    query => (query.includes('-- data:stats:volume-usd:cut') ? CUT : undefined),
    query => (query.includes('-- data:stats:volume-usd') ? rows : undefined),
  )
}

describe('GET /v1/stats/volume/usd', () => {
  it('serves routed platform volume per day from the routed fold, with its published cut', async () => {
    const client = volumeClient([
      { bkt: '2026-08-20 00:00:00', grp: 'routed', usd: '2533262.603963649400', n: '23517', unpriced: '3' },
      { bkt: '2026-08-21 00:00:00', grp: 'routed', usd: '0.004999999999', n: '1', unpriced: '0' },
    ])
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/stats/volume/usd?${WINDOW}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      groupBy: 'routed', bucket: 'day',
      from: '2026-08-20T00:00:00.000Z', to: '2026-08-22T00:00:00.000Z',
      publishedThrough: '2026-08-28T11:00:00.000Z',
    })
    expect(body.items).toEqual([
      { bucket: '2026-08-20T00:00:00.000Z', group: 'routed', volumeUsd: '2533262.60', trades: 23517, unpriced: 3 },
      { bucket: '2026-08-21T00:00:00.000Z', group: 'routed', volumeUsd: '0.00', trades: 1, unpriced: 0 },
    ])
    const read = client.seen.find(s => s.query.includes('-- data:stats:volume-usd') && !s.query.includes(':cut'))!
    expect(read.query).toContain('FROM price_data.routed_volume_hourly')
    expect(read.query).toContain('toDateTime(toDate(hour))')
    expect(read.params).toMatchObject({ fromTime: Date.UTC(2026, 7, 20) / 1000, toTime: Date.UTC(2026, 7, 22) / 1000 })
    expect(res.headers['cache-control']).toBe('private, max-age=60')
  })

  it('serves pool volume with the fee split, normalising the poolKey', async () => {
    const client = volumeClient([
      { bkt: '2026-08-20 13:00:00', grp: 'stableswap:100', usd: '1000.5', n: '12', unpriced: '0', lp_fee: '1.234', protocol_fee: '0' },
    ])
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/stats/volume/usd?groupBy=pool&bucket=hour&venue=stableswap&poolKey=0100&${WINDOW}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      { bucket: '2026-08-20T13:00:00.000Z', group: 'stableswap:100', volumeUsd: '1000.50', fills: 12, unpriced: 0, lpFeeUsd: '1.23', protocolFeeUsd: '0.00' },
    ])
    const read = client.seen.find(s => s.query.includes('-- data:stats:volume-usd') && !s.query.includes(':cut'))!
    expect(read.query).toContain('FROM price_data.pool_volume_hourly')
    expect(read.params).toMatchObject({ venue: 'stableswap', poolKey: '100' })
  })

  it('serves asset volume per raw registry id from the asset fold', async () => {
    const client = volumeClient([{ bkt: '2026-08-20 00:00:00', grp: '1001', usd: '50', n: '4', unpriced: '1' }])
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/stats/volume/usd?groupBy=asset&asset=1001&${WINDOW}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([{ bucket: '2026-08-20T00:00:00.000Z', group: '1001', volumeUsd: '50.00', legs: 4, unpriced: 1 }])
    const read = client.seen.find(s => s.query.includes('-- data:stats:volume-usd') && !s.query.includes(':cut'))!
    expect(read.query).toContain('FROM price_data.asset_volume_hourly')
    expect(read.params).toMatchObject({ assetId: 1001 })
  })

  it('rejects filters that do not apply and windows over the cap', async () => {
    app = await freshDataApp(volumeClient([]))
    for (const qs of ['venue=omnipool', 'groupBy=venue&asset=5', 'groupBy=pool&poolKey=100', 'groupBy=venue&venue=stableswap&poolKey=100', 'groupBy=venue&venue=aave']) {
      expect((await app.inject({ url: `/v1/stats/volume/usd?${qs}`, headers: AUTH })).statusCode, qs).toBe(400)
    }
    const wide = await app.inject({ url: '/v1/stats/volume/usd?bucket=hour&fromTime=2026-01-01T00:00:00Z&toTime=2026-08-01T00:00:00Z', headers: AUTH })
    expect(wide.statusCode).toBe(400)
    expect(wide.json().error.context.maxWindowDays).toBe(30)
  })
})

// The chain clock fixture of the bucketed-history tests: one row per hour, the
// block stamped on the mark and the hour's last block.
const ACC = `0x${'72'.repeat(32)}`
const ETH_FORM = `0x45544800${'72'.repeat(20)}0000000000000000`
const H = 3_600
const CLOCK_START = Date.UTC(2026, 6, 1) / 1000
const CLOCK_END = Date.UTC(2026, 7, 28, 12) / 1000
const CLOCK_ROWS: Row[] = []
for (let h = CLOCK_START, i = 0; h <= CLOCK_END; h += H, i++) CLOCK_ROWS.push({ h, top: 1_000_000 + i * 1000 + 999, at_mark: 1_000_000 + i * 1000 })
const markHeight = (sec: number) => 1_000_000 + ((sec - CLOCK_START) / H) * 1000

describe('GET /v1/accounts/:address/volume', () => {
  it('buckets the netted trades of the address and its EVM-side form on the day grid', async () => {
    const client = fakeDataClient(
      query => (query.includes('max(block_height) AS top') && !query.includes('account_trade_volume') ? CLOCK_ROWS : undefined),
      query => (query.includes('-- data:accounts:volume:totals') ? [{ usd: '3364473.289322673300', n: '9001', first_block: 5_000_000, rows_n: '9001' }] : undefined),
      query => (query.includes('-- data:accounts:volume:as-of') ? [{ top: 9_000_000, n: '10' }] : undefined),
      query => (query.includes('-- data:accounts:volume') ? [{ b: 0, usd: '100.005', n: '2' }, { b: 3, usd: '0.5', n: '1' }] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/volume?fromTime=2026-08-01T00:00:00Z&toTime=2026-08-05T12:00:00Z`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.bucket).toBe('day')
    expect(body.from).toBe('2026-08-01T00:00:00.000Z')
    expect(body.to).toBe('2026-08-06T00:00:00.000Z')
    expect(body.points).toHaveLength(5)
    expect(body.points[0]).toEqual({ bucket: '2026-08-01T00:00:00.000Z', blockHeight: markHeight(Date.UTC(2026, 7, 2) / 1000), volumeUsd: '100.01', trades: 2 })
    expect(body.points[1]).toMatchObject({ volumeUsd: '0.00', trades: 0 })
    expect(body.points[3]).toMatchObject({ volumeUsd: '0.50', trades: 1 })
    expect(body.totals).toEqual({ windowUsd: '100.51', windowTrades: 3, allTimeUsd: '3364473.29', allTimeTrades: 9001 })
    expect(body.firstTradeBlock).toBe(5_000_000)
    expect(body.asOfBlock).toBe(9_000_000)

    const read = client.seen.find(s => s.query.includes('-- data:accounts:volume\n'))!
    expect(read.params.accounts).toEqual([ACC, ETH_FORM])
    // (start, end] in blocks: after the block dated at or before the window start.
    expect(read.params.fromHeight).toBe(markHeight(Date.UTC(2026, 7, 1) / 1000))
    expect(read.params.toHeight).toBe(markHeight(Date.UTC(2026, 7, 6) / 1000))
    expect(res.headers['cache-control']).toBe('private, max-age=60')
    const from = Date.UTC(2026, 7, 1) / 1000
    const to = Date.UTC(2026, 7, 6) / 1000
    expect(cacheExpiry(`data:accounts:volume:${ACC}:day:${from}:${to}`)).not.toBeNull()
  })

  it('answers an address that never traded with zero points and totals', async () => {
    app = await freshDataApp(fakeDataClient(
      query => (query.includes('max(block_height) AS top') && !query.includes('account_trade_volume') ? CLOCK_ROWS : undefined),
      query => (query.includes('-- data:accounts:volume:totals') ? [{ usd: '0', n: '0', first_block: 0, rows_n: '0' }] : undefined),
      query => (query.includes('-- data:accounts:volume:as-of') ? [{ top: 0, n: '0' }] : undefined),
      query => (query.includes('-- data:accounts:volume') ? [] : undefined),
    ))
    const body = (await app.inject({ url: `/v1/accounts/${ACC}/volume?bucket=week&fromTime=2026-08-03T00:00:00Z&toTime=2026-08-20T00:00:00Z`, headers: AUTH })).json()
    expect(body.points.every((p: { volumeUsd: string; trades: number }) => p.volumeUsd === '0.00' && p.trades === 0)).toBe(true)
    expect(body.totals).toEqual({ windowUsd: '0.00', windowTrades: 0, allTimeUsd: '0.00', allTimeTrades: 0 })
    expect(body.firstTradeBlock).toBeNull()
    expect(body.asOfBlock).toBeNull()
  })
})
