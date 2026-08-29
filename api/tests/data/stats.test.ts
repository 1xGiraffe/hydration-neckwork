import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for /v1/stats/*: the volume fold (fee legs excluded), the
// revenue matrix (canonical protocol predicate), the daily activity counts
// (honest metric), and the TVL fold (staleness + unpriced rules).

type Row = Record<string, unknown>

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/stats/volume', () => {
  it('sums in/out legs per bucket/group/asset/side and never fee legs', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:stats:volume')
      ? [
          { bucket: '2026-08-20 00:00:00', grp: 'omnipool', asset_id: '5', side: 'in', amount: '1000000000000', legs: '12' },
          { bucket: '2026-08-20 00:00:00', grp: 'omnipool', asset_id: '5', side: 'out', amount: '990000000000', legs: '12' },
        ]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/volume?groupBy=venue&bucket=day', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      { bucket: '2026-08-20T00:00:00.000Z', group: 'omnipool', assetId: '5', side: 'in', amount: '1000000000000', legCount: 12 },
      { bucket: '2026-08-20T00:00:00.000Z', group: 'omnipool', assetId: '5', side: 'out', amount: '990000000000', legCount: 12 },
    ])
    const read = client.seen.find(s => s.query.includes('-- data:stats:volume'))!
    expect(read.query).toMatch(/leg_kind IN \('in', 'out'\)/)
    expect(res.headers['cache-control']).toBe('private, max-age=60')
  })

  it('bounds the window per bucket granularity', async () => {
    app = await freshDataApp(fakeDataClient(query => (query.includes('-- data:stats:volume') ? [] : undefined)))
    const tooWideHourly = await app.inject({
      url: '/v1/stats/volume?bucket=hour&fromTime=2026-01-01T00:00:00Z&toTime=2026-08-01T00:00:00Z',
      headers: AUTH,
    })
    expect(tooWideHourly.statusCode).toBe(400)
    expect(tooWideHourly.json().error.context.maxWindowDays).toBe(30)
    // The same span is fine at day granularity.
    const day = await app.inject({
      url: '/v1/stats/volume?bucket=day&fromTime=2026-01-01T00:00:00Z&toTime=2026-08-01T00:00:00Z',
      headers: AUTH,
    })
    expect(day.statusCode).toBe(200)
  })
})

describe('GET /v1/stats/revenue', () => {
  const REVENUE_ROWS: Row[] = [
    { bucket: '2026-08-01 00:00:00', stream: 'omnipool_asset_fee', dest: 'protocol', usd: '123.456789', events: '10' },
    { bucket: '2026-08-01 00:00:00', stream: 'network_fee', dest: '', usd: '7.001', events: '400' },
  ]

  it('applies the canonical protocol predicate by default and renders 2-decimal USD', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:stats:revenue') ? REVENUE_ROWS : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/revenue?bucket=month', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      { bucket: '2026-08-01T00:00:00.000Z', stream: 'omnipool_asset_fee', dest: 'protocol', amountUsd: '123.46', events: 10 },
      { bucket: '2026-08-01T00:00:00.000Z', stream: 'network_fee', dest: '', amountUsd: '7.00', events: 400 },
    ])
    const read = client.seen.find(s => s.query.includes('-- data:stats:revenue'))!
    // The canonical rule from services/revenueStreams.ts, restated verbatim.
    expect(read.query).toMatch(/stream != 'omnipool_asset_fee' OR dest IN \('protocol', 'burned', 'pol'\)/)
    expect(read.query).toMatch(/dest != 'lp'/)
  })

  it('widens to the full destination matrix with scope=all and filters by stream', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:stats:revenue') ? REVENUE_ROWS : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/revenue?scope=all&stream=network_fee&bucket=day', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const read = client.seen.find(s => s.query.includes('-- data:stats:revenue'))!
    expect(read.query).not.toMatch(/dest != 'lp'/)
    expect(read.params.stream).toBe('network_fee')

    const badStream = await app.inject({ url: '/v1/stats/revenue?stream=made_up', headers: AUTH })
    expect(badStream.statusCode).toBe(400)
  })
})

describe('GET /v1/stats/active-accounts', () => {
  it('counts distinct signing accounts per day by default, from the signer-first projection', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:stats:active-accounts')
      ? [{ d: '2026-08-27', c: '291' }, { d: '2026-08-28', c: '326' }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/active-accounts', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ kind: 'accounts', items: [{ day: '2026-08-27', count: 291 }, { day: '2026-08-28', count: 326 }] })
    const read = client.seen.find(s => s.query.includes('-- data:stats:active-accounts'))!
    expect(read.query).toMatch(/uniqExact\(account\)/)
    expect(read.query).toMatch(/FROM price_data.extrinsics_by_signer/)
  })

  it('serves the extrinsic and event histograms under their own kinds', async () => {
    const client = fakeDataClient((query, params) => (query.includes('-- data:stats:active') && !query.includes('active-accounts')
      ? (params.kind === 'events' ? [{ d: '2026-08-27', c: '150000' }] : [{ d: '2026-08-27', c: '6599' }])
      : undefined))
    app = await freshDataApp(client)
    const extrinsics = await app.inject({ url: '/v1/stats/active-accounts?kind=extrinsics', headers: AUTH })
    expect(extrinsics.json()).toEqual({ kind: 'extrinsics', items: [{ day: '2026-08-27', count: 6599 }] })
    const events = await app.inject({ url: '/v1/stats/active-accounts?kind=events', headers: AUTH })
    expect(events.json()).toEqual({ kind: 'events', items: [{ day: '2026-08-27', count: 150000 }] })
  })
})

describe('GET /v1/stats/tvl', () => {
  it('values the live snapshot at fresh prices and lists unpriced assets', async () => {
    // Registry snapshot is empty under test, so every asset falls back to the
    // synthetic 12-decimals descriptor — amounts below are scaled for that.
    const nowCh = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const client = fakeDataClient(
      query => (query.includes('-- data:assets:current-prices')
        ? [
            { asset_id: 5, price: '2.5', block: 9_000_000, ts: nowCh },
            { asset_id: 10, price: '1', block: 9_000_000, ts: nowCh },
            // A feed that died years ago never values a live reserve.
            { asset_id: 7, price: '50', block: 4_000_000, ts: '2023-01-01 00:00:00' },
          ]
        : undefined),
      query => (query.includes('-- data:pools:snapshot')
        ? [{ block_height: 9_000_000, ts: '2026-08-28 12:00:00', payload_json: JSON.stringify({
            // 4 tokens of asset 5 at $2.50 = $10.
            omnipool: { assets: [{ asset_id: 5, reserve: '4000000000000', hub_reserve: '1', shares: '1', protocol_shares: '0' }] },
            stableswap: { pools: [{ pool_id: 102, assets: [10], reserves: ['1000000000000'], amplification: '100', fee: 200, total_issuance: '1' }] },
            xyk: { pools: [{ pool_account: `0x${'99'.repeat(32)}`, asset_a: 5, asset_b: 7, reserve_a: '2000000000000', reserve_b: '3000000000000' }] },
          }) }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/stats/tvl', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      // omnipool $10 + stableswap $1 + xyk $5 (asset 7 unpriced -> 0).
      totalUsd: '16.00',
      venues: [
        { venue: 'omnipool', tvlUsd: '10.00' },
        { venue: 'stableswap', tvlUsd: '1.00' },
        { venue: 'xyk', tvlUsd: '5.00' },
      ],
      asOfBlock: 9_000_000,
      unpricedAssets: ['7'],
    })
    expect(res.headers['cache-control']).toBe('private, max-age=300')
  })
})
