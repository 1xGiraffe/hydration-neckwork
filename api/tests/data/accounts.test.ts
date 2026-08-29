import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for the /v1/accounts core: summary, balances (three composed
// sources), balance history, raw event references, extrinsics, transfers.

type Row = Record<string, unknown>

const ACC = `0x${'31'.repeat(32)}`
const ACC_SS58 = encodeAddress(ACC, 0)
const OTHER = `0x${'32'.repeat(32)}`
const EVM = `0x${'ab'.repeat(20)}`
const EVM_ACCOUNT_ID = `0x45544800${'ab'.repeat(20)}${'00'.repeat(8)}`

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/accounts/:address', () => {
  function summaryClient(overrides: { identity?: Row[]; tags?: Row[]; bounds?: Row[]; hasBalances?: Row[] } = {}) {
    return fakeDataClient(
      query => (query.includes('-- data:accounts:identity') ? overrides.identity ?? [] : undefined),
      query => (query.includes('-- data:accounts:tags') ? overrides.tags ?? [] : undefined),
      query => (query.includes('-- data:accounts:activity-bounds') ? overrides.bounds ?? [] : undefined),
      query => (query.includes('-- data:accounts:has-balances') ? overrides.hasBalances ?? [] : undefined),
    )
  }

  it('resolves identity, tags and lifetime, accepting SS58 input', async () => {
    app = await freshDataApp(summaryClient({
      identity: [
        { chain: 'polkadot-people', display: 'Alice', verified: 1, priority: 5 },
        { chain: 'hydration', display: 'alice-hydra', verified: 0, priority: 9 },
      ],
      tags: [
        { label_id: 'treasury', label_name: 'Treasury', deleted: 0 },
        { label_id: 'old', label_name: 'Old', deleted: 1 },
      ],
      // Any event naming the account bounds its lifetime — not only HDX holding.
      bounds: [{ first_block: 1_500_000, first_ts: '2023-01-01 00:00:00', last_block: 13_000_000, last_ts: '2026-08-01 12:00:00' }],
      hasBalances: [{ present: 1 }],
    }))
    const res = await app.inject({ url: `/v1/accounts/${ACC_SS58}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      account: { address: ACC_SS58, accountIdHex: ACC, evmAddress: null },
      // Highest priority wins; the deleted tag is tombstoned away.
      identity: { display: 'alice-hydra', verified: false, chain: 'hydration' },
      tags: [{ labelId: 'treasury', name: 'Treasury' }],
      firstSeen: '2023-01-01T00:00:00.000Z',
      firstSeenBlock: 1_500_000,
      lastSeen: '2026-08-01T12:00:00.000Z',
      lastSeenBlock: 13_000_000,
    })
    expect(res.headers['cache-control']).toBe('private, max-age=10')
  })

  it('404s a valid but never-seen address with head context', async () => {
    app = await freshDataApp(summaryClient())
    const res = await app.inject({ url: `/v1/accounts/${OTHER}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    const { error } = res.json()
    expect(error.code).toBe('not_found')
    expect(error.context.indexedHead).toBe(TEST_HEAD)
    expect(error.context.hint).toMatch(/empty items/)
  })

  it('rejects an unparseable address naming the accepted formats', async () => {
    app = await freshDataApp(summaryClient())
    const res = await app.inject({ url: '/v1/accounts/not-an-address', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/SS58/)
  })

  it('renders an EVM account under its H160 identity', async () => {
    app = await freshDataApp(summaryClient({ hasBalances: [{ present: 1 }] }))
    const res = await app.inject({ url: `/v1/accounts/${EVM}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().account).toEqual({ address: EVM, accountIdHex: EVM_ACCOUNT_ID, evmAddress: EVM })
  })
})

describe('GET /v1/accounts/:address/balances', () => {
  const RAY = 10n ** 27n
  const PRECOMPILE_5 = '0x0000000000000000000000000000000100000005'
  const ATOKEN = `0x${'aa'.repeat(20)}`
  const VDEBT = `0x${'bd'.repeat(20)}`
  const POOL = `0x${'cc'.repeat(20)}`

  function balancesClient() {
    return fakeDataClient(
      query => (query.includes('-- data:accounts:balances-substrate')
        ? [{ asset_id: '5', total: '100000000000000', free: '90000000000000', reserved: '10000000000000' },
           { asset_id: '9', total: '0', free: '0', reserved: '0' }]
        : undefined),
      query => (query.includes('-- data:accounts:balances-erc20')
        ? [{ asset_id: '222', total: '3000000000000000000' }]
        : undefined),
      query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: 8_200_000 }] : undefined),
      (query, params) => (query.includes('-- data:accounts:atoken-scaled')
        ? (params.h === `0x${ACC.slice(2, 42)}`
          ? [{ contract: ATOKEN, scaled: '1000000000000' }, { contract: VDEBT, scaled: '500000000000' }]
          : [])
        : undefined),
      query => (query.includes('-- data:accounts:atoken-map')
        ? [{ asset_address: PRECOMPILE_5, atoken: ATOKEN, vdebt: VDEBT, pool_proxy: POOL, market_key: 'core' }]
        : undefined),
      query => (query.includes('-- data:accounts:reserve-indices')
        ? [{ pool_address: POOL, reserve_address: PRECOMPILE_5, liq: (2n * RAY).toString(), vbi: RAY.toString() }]
        : undefined),
      // The fresh current-price map /v1/assets also serves: a price inside the
      // 30-day bound values the position; asset 9's ancient close never does.
      query => (query.includes('-- data:assets:current-prices')
        ? [
            { asset_id: 5, price: '2', block: 8_999_000, ts: new Date().toISOString().slice(0, 19).replace('T', ' ') },
            { asset_id: 222, price: '1', block: 8_999_000, ts: new Date().toISOString().slice(0, 19).replace('T', ' ') },
            { asset_id: 9, price: '99', block: 4_000_000, ts: '2023-01-01 00:00:00' },
          ]
        : undefined),
    )
  }

  it('composes substrate, ERC-20 and money-market positions with integer math', async () => {
    const client = balancesClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/balances`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items, totals } = res.json()
    // The zero substrate balance is dropped; nothing invented for it.
    expect(items).toHaveLength(4)
    const byKind = Object.fromEntries(items.map((i: { kind: string }) => [i.kind, i]))
    // 100 tokens (12 decimals default) at $2.
    expect(byKind.substrate).toMatchObject({ assetId: '5', amount: '100000000000000', free: '90000000000000', reserved: '10000000000000', valueUsd: '200.00' })
    // 3 HOLLAR (12 decimals under the empty test registry) at $1.
    expect(byKind.erc20).toMatchObject({ assetId: '222', amount: '3000000000000000000', valueUsd: '3000000.00' })
    // Supplied = scaled 1 token × liquidity index 2 RAY / RAY = 2 tokens at $2.
    expect(byKind.atoken).toMatchObject({ assetId: '5', amount: '2000000000000', valueUsd: '4.00' })
    // Debt = scaled 0.5 token × borrow index 1 RAY / RAY.
    expect(byKind.vdebt).toMatchObject({ assetId: '5', amount: '500000000000', valueUsd: '1.00' })
    // Holdings and debt summed exactly, debt kept apart.
    expect(totals).toEqual({ assetsUsd: '3000204.00', debtUsd: '1.00', netUsd: '3000203.00' })
    expect(res.headers['cache-control']).toBe('private, max-age=5')

    // The reserve indices fold (1.8 M rows live) is global state, read once per
    // TTL and shared — a second account must not re-read it.
    await app.inject({ url: `/v1/accounts/${OTHER}/balances`, headers: AUTH })
    expect(client.seen.filter(s => s.query.includes('-- data:accounts:reserve-indices'))).toHaveLength(1)
  })

  it('answers an unseen account with empty items, not 404', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:accounts:balances-substrate') ? [] : undefined),
      query => (query.includes('-- data:accounts:balances-erc20') ? [] : undefined),
      query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: 0 }] : undefined),
      query => (query.includes('-- data:accounts:atoken-map') ? [] : undefined),
      query => (query.includes('-- data:accounts:reserve-indices') ? [] : undefined),
      query => (query.includes('-- data:assets:current-prices') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${OTHER}/balances`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], totals: { assetsUsd: '0.00', debtUsd: '0.00', netUsd: '0.00' } })
  })
})

describe('GET /v1/accounts/:address/balances/history', () => {
  it('pages end-of-interval balances by time cursor', async () => {
    const hours = ['2026-08-28 12:00:00', '2026-08-28 11:00:00', '2026-08-28 10:00:00']
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:accounts:balance-history')) return undefined
      const below = params.cursor == null ? hours : hours.filter(h => Date.parse(`${h.replace(' ', 'T')}Z`) / 1000 < Number(params.cursor))
      return below.map((h, i) => ({ ts: h, balance: String(1000 - i), last_block: 100 - i }))
    })
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/accounts/${ACC}/balances/history?asset=5&limit=2`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items).toEqual([
      { intervalStart: '2026-08-28T12:00:00.000Z', balance: '1000', lastBlock: 100 },
      { intervalStart: '2026-08-28T11:00:00.000Z', balance: '999', lastBlock: 99 },
    ])
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/accounts/${ACC}/balances/history?asset=5&limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((i: { intervalStart: string }) => i.intervalStart)).toEqual(['2026-08-28T10:00:00.000Z'])
    expect(second.json().hasMore).toBe(false)
  })

  it('requires the asset parameter', async () => {
    app = await freshDataApp(fakeDataClient())
    expect((await app.inject({ url: `/v1/accounts/${ACC}/balances/history`, headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/accounts/:address/events', () => {
  const EVENTS: Row[] = [
    { block_height: 500, event_index: 9, extrinsic_index: 2, event_name: 'Balances.Transfer', ts: '2026-08-20 10:00:00', asset_id: 0, amount: '123', has_amount: 1 },
    { block_height: 400, event_index: 4, extrinsic_index: null, event_name: 'DCA.ExecutionPlanned', ts: '2026-08-20 09:00:00', asset_id: 0, amount: '0', has_amount: 0 },
    { block_height: 300, event_index: 1, extrinsic_index: 5, event_name: 'Tokens.Transfer', ts: '2026-08-20 08:00:00', asset_id: 5, amount: '77', has_amount: 1 },
  ]

  it('serves raw references with cursor continuity and null amounts where the event carried none', async () => {
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:accounts:events')) return undefined
      let rows = EVENTS
      if (params.cb != null) rows = rows.filter(r => Number(r.block_height) < Number(params.cb))
      return rows
    })
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/accounts/${ACC}/events?limit=2`, headers: AUTH })
    const page1 = first.json()
    expect(page1.items).toEqual([
      { blockHeight: 500, eventIndex: 9, extrinsicIndex: 2, extrinsicHash: null, eventName: 'Balances.Transfer', timestamp: '2026-08-20T10:00:00.000Z', assetId: '0', amount: '123' },
      { blockHeight: 400, eventIndex: 4, extrinsicIndex: null, extrinsicHash: null, eventName: 'DCA.ExecutionPlanned', timestamp: '2026-08-20T09:00:00.000Z', assetId: '0', amount: null },
    ])
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/accounts/${ACC}/events?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([300])
    expect(second.json().hasMore).toBe(false)
  })

  it('passes the name and asset filters into the query', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:events') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${OTHER}/events?name=Balances.Transfer&asset=5`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const read = client.seen.find(s => s.query.includes('-- data:accounts:events'))!
    expect(read.params).toMatchObject({ name: 'Balances.Transfer', asset: 5 })
    expect(read.query).toMatch(/event_name = \{name:String\}/)
  })
})

describe('GET /v1/accounts/:address/extrinsics', () => {
  it('reads the account-first projection through the shared signer feed', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:extrinsics:by-signer')
      ? [{ block_height: 700, extrinsic_index: 3, extrinsic_hash: `0x${'cd'.repeat(32)}`, ts: '2026-08-20 10:00:00', call_name: 'Router.sell', signer: ACC, success: 1, fee: '10', tip: '0', ingested_at: '2026-08-20 10:00:05' }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC_SS58}/extrinsics?limit=30`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({
      blockHeight: 700, extrinsicIndex: 3, callName: 'Router.sell', success: true,
      signer: { accountIdHex: ACC, address: ACC_SS58 },
    })
    const read = client.seen.find(s => s.query.includes('-- data:extrinsics:by-signer'))!
    expect(read.params.account).toBe(ACC)
  })
})

describe('GET /v1/accounts/:address/transfers', () => {
  const TRANSFERS: Row[] = [
    { block_height: 900, event_index: 2, extrinsic_index: 1, ts: '2026-08-20 10:00:00', event_name: 'Balances.Transfer', from_account: ACC, to_account: OTHER, amount: '5', asset_id: 0 },
    { block_height: 899, event_index: 7, extrinsic_index: 2, ts: '2026-08-20 09:59:00', event_name: 'Tokens.Transfer', from_account: OTHER, to_account: ACC, amount: '9', asset_id: 5 },
    { block_height: 898, event_index: 1, extrinsic_index: null, ts: '2026-08-20 09:58:00', event_name: 'Balances.Transfer', from_account: ACC, to_account: ACC, amount: '1', asset_id: 0 },
  ]

  it('labels direction relative to the account, renders both parties, and values each transfer at event time', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:accounts:transfers') ? TRANSFERS : undefined),
      // Hourly closes: HDX (0) $0.5 from 09:00, asset 5 $2 from 09:00 — the
      // 09:58/09:59/10:00 transfers all see them; a close AFTER a transfer is
      // never used.
      query => (query.includes('-- data:prices:event-time-closes')
        ? [
            { asset_id: 0, price_time: Date.parse('2026-08-20T09:00:00Z') / 1000, close: '0.5' },
            { asset_id: 5, price_time: Date.parse('2026-08-20T09:00:00Z') / 1000, close: '2' },
          ]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/transfers?limit=10`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const directions = res.json().items.map((i: { direction: string }) => i.direction)
    expect(directions).toEqual(['out', 'in', 'self'])
    expect(res.json().items[0].from).toEqual({ address: ACC_SS58, accountIdHex: ACC, evmAddress: null })
    // 5 planck of HDX (12 decimals) at $0.5 rounds to 0.00; 9 planck of asset 5 at $2 likewise.
    expect(res.json().items.map((i: { valueUsd: string | null }) => i.valueUsd)).toEqual(['0.00', '0.00', '0.00'])
    const closes = client.seen.find(s => s.query.includes('-- data:prices:event-time-closes'))!
    // One closes read for the page, spanning its assets and time range.
    expect(closes.params.ids).toEqual(expect.arrayContaining([0, 5]))
    expect(closes.params.minT).toBe(Date.parse('2026-08-20T09:58:00Z') / 1000)
    expect(closes.params.maxT).toBe(Date.parse('2026-08-20T10:00:00Z') / 1000)
  })

  it('filters direction in SQL, not after the page', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:transfers') ? [] : undefined))
    app = await freshDataApp(client)
    await app.inject({ url: `/v1/accounts/${OTHER}/transfers?direction=out&limit=9`, headers: AUTH })
    const read = client.seen.find(s => s.query.includes('-- data:accounts:transfers'))!
    expect(read.query).toMatch(/from_account = \{account:String\}/)
  })
})
