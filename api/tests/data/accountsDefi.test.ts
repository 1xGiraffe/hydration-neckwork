import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for the /v1/accounts DeFi feeds: trades (netting + event-time
// USD), DCA, OTC, staking, votes, liquidity, XCM, money market, liquidations,
// protocol fees.

type Row = Record<string, unknown>

const ACC = `0x${'41'.repeat(32)}`
const ACC2 = `0x${'42'.repeat(32)}`
const ACC3 = `0x${'43'.repeat(32)}`
const ACC4 = `0x${'44'.repeat(32)}`

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/accounts/:address/trades', () => {
  // A routed A(5)→H2O(1)→B(222) trade: two fills sharing op_key 42 in block
  // 300, plus a fee leg — and an unrouted single fill in block 250.
  const LEGS: Row[] = [
    { venue: 'omnipool', block_height: 300, event_index: 10, leg_index: 0, leg_kind: 'in', asset_id: 5, amount: '100000000000000', fee_dest: '', fee_recipient: '', op_key: '42', ts: '2026-08-20 10:30:00' },
    { venue: 'omnipool', block_height: 300, event_index: 10, leg_index: 1, leg_kind: 'out', asset_id: 1, amount: '50000000000000', fee_dest: '', fee_recipient: '', op_key: '42', ts: '2026-08-20 10:30:00' },
    { venue: 'stableswap', block_height: 300, event_index: 11, leg_index: 0, leg_kind: 'in', asset_id: 1, amount: '50000000000000', fee_dest: '', fee_recipient: '', op_key: '42', ts: '2026-08-20 10:30:00' },
    { venue: 'stableswap', block_height: 300, event_index: 11, leg_index: 1, leg_kind: 'out', asset_id: 222, amount: '99000000000000', fee_dest: '', fee_recipient: '', op_key: '42', ts: '2026-08-20 10:30:00' },
    // A fat fee leg: if it leaked into the netting, usdValue would move by $50.
    { venue: 'stableswap', block_height: 300, event_index: 11, leg_index: 2, leg_kind: 'fee', asset_id: 222, amount: '50000000000000', fee_dest: 'account', fee_recipient: `0x${'fe'.repeat(32)}`, op_key: '42', ts: '2026-08-20 10:30:00' },
    { venue: 'xyk', block_height: 250, event_index: 4, leg_index: 0, leg_kind: 'in', asset_id: 0, amount: '10000000000000', fee_dest: '', fee_recipient: '', op_key: '', ts: '2026-08-20 09:00:00' },
    { venue: 'xyk', block_height: 250, event_index: 4, leg_index: 1, leg_kind: 'out', asset_id: 5, amount: '4000000000000', fee_dest: '', fee_recipient: '', op_key: '', ts: '2026-08-20 09:00:00' },
  ]
  // Hourly closes usable at the fills (price_time <= trade time).
  const CLOSES: Row[] = [
    // Sorted per asset, oldest first — the reader picks the newest ≤ trade
    // time, so the 08:00 close prices the 09:00 fill and the 10:00 close the
    // 10:30 one; a close after the fill is a future price and never used.
    { asset_id: 5, price_time: Date.parse('2026-08-20T08:00:00Z') / 1000, close: '2' },
    { asset_id: 5, price_time: Date.parse('2026-08-20T10:00:00Z') / 1000, close: '2' },
    { asset_id: 222, price_time: Date.parse('2026-08-20T10:00:00Z') / 1000, close: '1' },
    { asset_id: 0, price_time: Date.parse('2026-08-20T08:00:00Z') / 1000, close: '0.5' },
  ]

  function tradesClient() {
    return fakeDataClient(
      (query, params) => {
        if (!query.includes('-- data:accounts:trade-legs')) return undefined
        let rows = LEGS
        if (params.cb != null) rows = rows.filter(r => Number(r.block_height) <= Number(params.cb))
        return rows
      },
      query => (query.includes('-- data:prices:event-time-closes') ? CLOSES : undefined),
    )
  }

  it('nets a routed trade per asset (intermediates cancel) and values it at event time', async () => {
    app = await freshDataApp(tradesClient())
    const res = await app.inject({ url: `/v1/accounts/${ACC}/trades`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const [routed, direct] = res.json().items
    expect(routed).toEqual({
      opKey: '42', blockHeight: 300, eventIndex: 10, timestamp: '2026-08-20T10:30:00.000Z',
      venues: ['omnipool', 'stableswap'],
      // H2O (asset 1) is the intermediate hop: out of fill one, into fill two —
      // it nets to zero and appears on NEITHER side.
      inputs: [{ assetId: '5', amount: '100000000000000' }],
      outputs: [{ assetId: '222', amount: '99000000000000' }],
      // The same fee-leg shape the fill feeds publish: destination class and
      // the credited account as a ref, never raw hex.
      fees: [{ assetId: '222', amount: '50000000000000', feeDest: 'account', feeRecipient: { address: encodeAddress(`0x${'fe'.repeat(32)}`, 0), accountIdHex: `0x${'fe'.repeat(32)}`, evmAddress: null } }],
      // max(in $200, out $99) — the fee leg restates out-value and adds NOTHING.
      valueUsd: '200.00',
    })
    expect(direct).toMatchObject({
      opKey: null, blockHeight: 250, eventIndex: 4,
      inputs: [{ assetId: '0', amount: '10000000000000' }],
      outputs: [{ assetId: '5', amount: '4000000000000' }],
      // max(in 10×$0.5, out 4×$2).
      valueUsd: '8.00',
    })
  })

  it('pages trades without overlap across the cursor', async () => {
    app = await freshDataApp(tradesClient())
    const first = await app.inject({ url: `/v1/accounts/${ACC}/trades?limit=1`, headers: AUTH })
    const page1 = first.json()
    expect(page1.items.map((t: { blockHeight: number }) => t.blockHeight)).toEqual([300])
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/accounts/${ACC}/trades?limit=1&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((t: { blockHeight: number }) => t.blockHeight)).toEqual([250])
  })

  it('reports null usdValue when nothing on either side had a usable price', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:accounts:trade-legs')
        ? [{ venue: 'xyk', block_height: 100, event_index: 1, leg_index: 0, leg_kind: 'in', asset_id: 77, amount: '5', fee_dest: '', fee_recipient: '', op_key: '', ts: '2026-08-20 09:00:00' }]
        : undefined),
      query => (query.includes('-- data:prices:event-time-closes') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC2}/trades`, headers: AUTH })
    expect(res.json().items[0].valueUsd).toBeNull()
  })
})

describe('GET /v1/accounts/:address/dca', () => {
  it('serves the owner’s schedules through the /v1/dca/schedules reader and nulls pre-router terms', async () => {
    const client = fakeDataClient(
      (query, params) => (query.includes('-- data:dca:schedules') && params.owner === ACC
        ? [
          { id: '7', block_height: 900, ts: '2026-06-01 00:00:00', who: ACC, asset_in: 5, asset_out: 0, direction: 'Sell', amount_per: '100', total_amount: '1000', period: 6, max_retries: 3 },
          { id: '3', block_height: 500, ts: '2023-06-01 00:00:00', who: ACC, asset_in: 0, asset_out: 0, direction: '', amount_per: '', total_amount: '', period: 0, max_retries: 0 },
        ]
        : undefined),
      query => (query.includes('-- data:accounts:dca-events')
        ? [{ id: '7', event_name: 'DCA.TradeExecuted', block_height: 910, event_index: 4, extrinsic_index: null, ts: '2026-06-02 00:00:00', amount_in: '100', amount_out: '90', planned_block: 0, error: '' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/dca`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { schedules, hasMoreSchedules, events } = res.json()
    expect(hasMoreSchedules).toBe(false)
    // Identical object to /v1/dca/schedules: owner, periodBlocks, integer maxRetries.
    expect(schedules[0]).toMatchObject({ scheduleId: 7, owner: { accountIdHex: ACC }, assetIn: '5', assetOut: '0', direction: 'sell', periodBlocks: 6, maxRetries: 3 })
    expect(schedules[1]).toMatchObject({
      scheduleId: 3, createdAt: '2023-06-01T00:00:00.000Z', createdAtBlock: 500,
      assetIn: null, assetOut: null, direction: null, amountPer: null, totalAmount: null, periodBlocks: null, maxRetries: 0,
    })
    const listing = client.seen.find(s => s.query.includes('-- data:dca:schedules'))!
    expect(listing.params.owner).toBe(ACC)
    expect(events.items[0]).toMatchObject({ scheduleId: 7, eventName: 'DCA.TradeExecuted', amountIn: '100', plannedBlock: null, error: null })
  })
})

describe('GET /v1/accounts/:address/otc and /otc/fills', () => {
  const FILLS: Row[] = [
    { order_id: 12, event_name: 'PartiallyFilled', block_height: 810, event_index: 5, ts: '2026-08-02 00:00:00', amount_in: '10', amount_out: '20' },
    { order_id: 12, event_name: 'Filled', block_height: 805, event_index: 1, ts: '2026-08-01 12:00:00', amount_in: '30', amount_out: '60' },
  ]
  function otcClient() {
    return fakeDataClient(
      query => (query.includes('-- data:accounts:otc-calls')
        ? [{ block_height: 800, extrinsic_index: 2, extrinsic_hash: `0x${'ee'.repeat(32)}`, ts: '2026-08-01 00:00:00', call_name: 'OTC.place_order', success: 1 }]
        : undefined),
      (query, params) => {
        if (!query.includes('-- data:accounts:otc-fills')) return undefined
        let rows = FILLS
        if (params.cb != null) rows = rows.filter(r => Number(r.block_height) < Number(params.cb) || (Number(r.block_height) === Number(params.cb) && Number(r.event_index) < Number(params.ci)))
        return rows
      },
    )
  }

  it('serves the account’s signed OTC calls as their own feed', async () => {
    const client = otcClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/otc`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ callName: 'OTC.place_order', success: true })
    expect(res.json().hasMore).toBe(false)
    const calls = client.seen.find(s => s.query.includes('-- data:accounts:otc-calls'))!
    expect(calls.query).toMatch(/startsWith\(call_name, 'OTC\.'\)/)
  })

  it('pages the fills the account executed as the order events /v1/otc/orders/{id} publishes', async () => {
    const client = otcClient()
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/accounts/${ACC}/otc/fills?limit=1`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    expect(first.json().items).toEqual([{ orderId: 12, type: 'partiallyFilled', blockHeight: 810, eventIndex: 5, timestamp: '2026-08-02T00:00:00.000Z', amountIn: '10', amountOut: '20', filler: { address: encodeAddress(ACC, 0), accountIdHex: ACC, evmAddress: null } }])
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/accounts/${ACC}/otc/fills?limit=1&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((f: { type: string; amountIn: string }) => `${f.type}:${f.amountIn}`)).toEqual(['filled:30'])
    expect(second.json().hasMore).toBe(false)
    const read = client.seen.filter(s => s.query.includes('-- data:accounts:otc-fills')).at(-1)!
    expect(read.query).toMatch(/filler = \{account:String\}/)
    expect(read.params).toMatchObject({ cb: 810, ci: 5 })
  })
})

describe('GET /v1/accounts/:address/staking', () => {
  it('decodes args and pages by position', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:staking')
      ? [{ block_height: 700, event_index: 3, extrinsic_index: 1, ts: '2026-08-01 00:00:00', event_name: 'GigaHdx.Staked', who: ACC, args_json: '{"who":"x","amount":"5"}' }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/staking`, headers: AUTH })
    // The same item /v1/staking/events serves: who, extrinsic linkage, args.
    expect(res.json().items[0]).toEqual({
      blockHeight: 700, eventIndex: 3, extrinsicIndex: 1, extrinsicHash: null, timestamp: '2026-08-01T00:00:00.000Z',
      eventName: 'GigaHdx.Staked', who: { address: encodeAddress(ACC, 0), accountIdHex: ACC, evmAddress: null }, args: { who: 'x', amount: '5' },
    })
  })
})

describe('GET /v1/accounts/:address/votes', () => {
  const VOTES: Row[] = [
    { who: ACC, pallet: 'opengov', ref_index: 397, block_height: 950, extrinsic_index: 2, call_address: 'root', ts: '2026-08-01 00:00:00', call_name: 'ConvictionVoting.vote', vote_kind: 'Standard', vote_byte: 134, balance: '17000000000000', aye: '', nay: '', abstain: '', success: 1, ingested_at: '2026-08-01 00:00:05' },
    // Replay duplicate of the row above — must collapse.
    { who: ACC, pallet: 'opengov', ref_index: 397, block_height: 950, extrinsic_index: 2, call_address: 'root', ts: '2026-08-01 00:00:00', call_name: 'ConvictionVoting.vote', vote_kind: 'Standard', vote_byte: 134, balance: '17000000000000', aye: '', nay: '', abstain: '', success: 1, ingested_at: '2026-08-01 00:00:05' },
    { who: ACC, pallet: 'opengov', ref_index: 395, block_height: 940, extrinsic_index: 1, call_address: 'root', ts: '2026-07-30 00:00:00', call_name: 'ConvictionVoting.remove_vote', vote_kind: '', vote_byte: 0, balance: '', aye: '', nay: '', abstain: '', success: 1, ingested_at: '2026-07-30 00:00:05' },
    { who: ACC, pallet: 'democracy', ref_index: 12, block_height: 100, extrinsic_index: 3, call_address: 'root', ts: '2023-01-01 00:00:00', call_name: 'Democracy.vote', vote_kind: 'Split', vote_byte: 0, balance: '', aye: '5', nay: '3', abstain: '', success: 1, ingested_at: '2023-01-01 00:00:05' },
  ]

  it('is the /v1/governance/votes feed under the account: same reader, same decoded item, newest first', async () => {
    const client = fakeDataClient((query, params) => (query.includes('-- data:governance:votes:by-voter') && params.voter === ACC ? VOTES : undefined))
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/accounts/${ACC}/votes?limit=2`, headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items.map((v: { refIndex: number }) => v.refIndex)).toEqual([397, 395])
    // The Standard byte is decoded (aye is a BOOLEAN here, never a string amount).
    expect(page1.items[0]).toMatchObject({ voter: { accountIdHex: ACC }, voteKind: 'Standard', voteByte: 134, aye: true, conviction: 6, balance: '17000000000000' })
    expect(page1.items[1]).toMatchObject({ callName: 'ConvictionVoting.remove_vote', voteKind: null, aye: null, balance: null })
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/accounts/${ACC}/votes?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((v: { refIndex: number }) => v.refIndex)).toEqual([12])
    expect(second.json().items[0]).toMatchObject({ voteKind: 'Split', ayeAmount: '5', nayAmount: '3', abstainAmount: null })
    expect(second.json().hasMore).toBe(false)
  })

  it('replays the history oldest first with order=asc and a matching cursor', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:governance:votes:by-voter') ? VOTES : undefined))
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/accounts/${ACC}/votes?order=asc&limit=2`, headers: AUTH })
    expect(first.json().items.map((v: { refIndex: number }) => v.refIndex)).toEqual([12, 395])
    const second = await app.inject({ url: `/v1/accounts/${ACC}/votes?order=asc&limit=2&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((v: { refIndex: number }) => v.refIndex)).toEqual([397])
    expect(second.json().hasMore).toBe(false)
  })
})

describe('GET /v1/accounts/:address/liquidity', () => {
  it('maps the liquidity event columns', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:liquidity')
      ? [{ block_height: 600, event_index: 8, extrinsic_index: 2, ts: '2026-08-01 00:00:00', event_name: 'Omnipool.LiquidityAdded', asset_id: 5, amount: '100', amount_a: '', asset_b: 0, pool_account: '', asset_refs: [5] }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidity`, headers: AUTH })
    expect(res.json().items[0]).toEqual({
      blockHeight: 600, eventIndex: 8, extrinsicIndex: 2, extrinsicHash: null, timestamp: '2026-08-01T00:00:00.000Z',
      eventName: 'Omnipool.LiquidityAdded', assetId: '5', amount: '100', amountA: null, assetB: null, poolAccount: null, assetRefs: ['5'],
    })
  })
})

describe('GET /v1/accounts/:address/xcm', () => {
  it('labels directions and filters by the direction’s name family', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:xcm')
      ? [
        { block_height: 500, event_index: 2, extrinsic_index: null, ts: '2026-08-01 00:00:00', event_name: 'Currencies.Deposited', asset_id: 5, amount: '10' },
        { block_height: 499, event_index: 6, extrinsic_index: 1, ts: '2026-08-01 00:00:00', event_name: 'XTokens.TransferredAssets', asset_id: 5, amount: '7' },
      ]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/xcm`, headers: AUTH })
    expect(res.json().items.map((i: { direction: string }) => i.direction)).toEqual(['in', 'out'])

    await app.inject({ url: `/v1/accounts/${ACC}/xcm?direction=in&limit=7`, headers: AUTH })
    const read = client.seen.filter(s => s.query.includes('-- data:accounts:xcm')).at(-1)!
    expect(read.params.names).toContain('Currencies.Deposited')
    expect(read.params.names).not.toContain('XTokens.TransferredAssets')
  })
})

describe('GET /v1/accounts/:address/money-market', () => {
  it('reports isolated per-pool positions with their market key', async () => {
    const POOL = `0x${'1b'.repeat(20)}`
    const client = fakeDataClient(
      query => (query.includes('-- data:accounts:mm-positions')
        ? [
          { pool_address: POOL, total_collateral_base: '5000000000', total_debt_base: '1000000000', available_borrows_base: '2000000000', liquidation_threshold: '8000', ltv: '7500', health_factor: '2500000000000000000', block_height: 8_900_000, ts: '2026-08-01 00:00:00' },
          { pool_address: `0x${'2c'.repeat(20)}`, total_collateral_base: '0', total_debt_base: '0', available_borrows_base: '0', liquidation_threshold: '0', ltv: '0', health_factor: '0', block_height: 8_900_000, ts: '2026-08-01 00:00:00' },
        ]
        : undefined),
      query => (query.includes('-- data:accounts:atoken-anchor-block') ? [{ b0: 8_200_000 }] : undefined),
      query => (query.includes('-- data:accounts:atoken-map')
        ? [{ asset_address: '0x0000000000000000000000000000000100000005', atoken: `0x${'aa'.repeat(20)}`, vdebt: `0x${'bd'.repeat(20)}`, pool_proxy: POOL, market_key: 'core' }]
        : undefined),
      query => (query.includes('-- data:accounts:reserve-indices') ? [] : undefined),
      query => (query.includes('-- data:accounts:mm-activity')
        ? [{ block_height: 8_899_000, event_index: 40, ts: '2026-07-30 00:00:00', event_name: 'Supply', asset_address: '0x0000000000000000000000000000000100000005', pool_address: POOL, amount: '123', liquidated_collateral_amount: '' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/money-market`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { positions, activity } = res.json()
    // The empty second pool is dropped, never blended into the first.
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({
      poolAddress: POOL, marketKey: 'core',
      totalCollateralBase: '5000000000', totalDebtBase: '1000000000', healthFactor: '2500000000000000000',
    })
    expect(activity.items[0]).toMatchObject({ eventName: 'Supply', amount: '123', liquidatedCollateralAmount: null })
  })
})

describe('GET /v1/accounts/:address/liquidations', () => {
  it('lists the account’s liquidation calls', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:liquidations')
      ? [{ block_height: 8_000_000, event_index: 12, ts: '2026-05-01 00:00:00', pool_address: `0x${'1b'.repeat(20)}`, asset_address: '0x0000000000000000000000000000000100000005', liquidated_collateral_amount: '999' }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC}/liquidations`, headers: AUTH })
    expect(res.json().items[0]).toMatchObject({ liquidatedCollateralAmount: '999' })
  })
})

describe('GET /v1/accounts/:address/fees', () => {
  it('reads both payer identities and renders monthly USD rows', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:fees')
      ? [{ stream: 'network_fee', month: 202608, revenue_usd: '3.141592653589' }]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC3}/fees`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    // The same row shape as /v1/stats/revenue: a month bucket and amountUsd.
    expect(res.json().items).toEqual([{ bucket: '2026-08-01T00:00:00.000Z', stream: 'network_fee', amountUsd: '3.14' }])
    const read = client.seen.find(s => s.query.includes('-- data:accounts:fees'))!
    // Native and ETH-truncated identities are both queried.
    expect(read.params.accounts).toEqual([ACC3, `0x45544800${'43'.repeat(20)}0000000000000000`])
  })

  it('answers an unseen account with empty items', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:accounts:fees') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/accounts/${ACC4}/fees`, headers: AUTH })
    expect(res.json()).toEqual({ items: [] })
  })
})
