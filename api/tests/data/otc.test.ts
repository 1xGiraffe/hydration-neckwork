import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { encodeAddress } from '@polkadot/util-crypto'

// Contract tests for /v1/otc/*: the read-time fold (open/filled/cancelled),
// the Placed-row-only pair rule, filters, and the id cursor.

type Row = Record<string, unknown>

const FILLER = `0x${'88'.repeat(32)}`
const FILLER_SS58 = encodeAddress(FILLER, 0)

function event(orderId: number, name: string, block: number, index: number, overrides: Row = {}): Row {
  return {
    order_id: orderId, event_name: name,
    asset_in: 0, asset_out: 0, amount_in: '', amount_out: '', partially_fillable: 0, filler: '',
    block_height: block, event_index: index, ts: '2026-08-20 10:00:00', ingested_at: '2026-08-20 10:00:05',
    ...overrides,
  }
}

// Order 10: open. Order 11: partially filled twice then pulled → cancelled.
// Order 12: fully filled. Order 13: a fill with no Placed row → never served.
const EVENT_ROWS: Row[] = [
  event(10, 'Placed', 100, 1, { asset_in: 5, asset_out: 0, amount_in: '1000', amount_out: '2000', partially_fillable: 1 }),
  event(11, 'Placed', 101, 1, { asset_in: 10, asset_out: 22, amount_in: '500', amount_out: '600', partially_fillable: 1 }),
  event(11, 'PartiallyFilled', 102, 2, { amount_in: '100', amount_out: '120', filler: FILLER }),
  event(11, 'PartiallyFilled', 103, 3, { amount_in: '50', amount_out: '60', filler: FILLER }),
  event(11, 'Cancelled', 104, 4, {}),
  event(12, 'Placed', 105, 1, { asset_in: 0, asset_out: 5, amount_in: '9', amount_out: '8' }),
  event(12, 'Filled', 106, 2, { amount_in: '9', amount_out: '8', filler: FILLER }),
  event(13, 'Filled', 107, 2, { amount_in: '1', amount_out: '1', filler: FILLER }),
]

function otcClient() {
  return fakeDataClient(
    (query, params) => {
      if (query.includes('-- data:otc:order-by-id')) {
        return EVENT_ROWS.filter(row => Number(row.order_id) === Number(params.orderId))
      }
      if (query.includes('-- data:otc:orders')) return EVENT_ROWS
      return undefined
    },
  )
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/otc/orders', () => {
  it('folds status per order and drops an order with no indexed placement', async () => {
    app = await freshDataApp(otcClient())
    const res = await app.inject({ url: '/v1/otc/orders', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const items = res.json().items
    expect(items.map((o: { orderId: number; status: string }) => [o.orderId, o.status])).toEqual([
      [12, 'filled'],
      [11, 'cancelled'], // partial fills never end an order; the pull did
      [10, 'open'],
    ])
    const pulled = items.find((o: { orderId: number }) => o.orderId === 11)
    expect(pulled).toMatchObject({
      assetIn: '10', assetOut: '22', amountIn: '500', amountOut: '600',
      filledAmountIn: '150', filledAmountOut: '180', partiallyFillable: true,
      placedAtBlock: 101,
    })
  })

  it('filters by status and by either side of the placed pair', async () => {
    app = await freshDataApp(otcClient())
    const open = await app.inject({ url: '/v1/otc/orders?status=open', headers: AUTH })
    expect(open.json().items.map((o: { orderId: number }) => o.orderId)).toEqual([10])
    // asset 5 appears as assetIn of order 10 and assetOut of order 12.
    const asset5 = await app.inject({ url: '/v1/otc/orders?asset=5', headers: AUTH })
    expect(asset5.json().items.map((o: { orderId: number }) => o.orderId)).toEqual([12, 10])
  })

  it('pages by order-id cursor without overlap', async () => {
    app = await freshDataApp(otcClient())
    const first = await app.inject({ url: '/v1/otc/orders?limit=2', headers: AUTH })
    const page1 = first.json()
    expect(page1.items.map((o: { orderId: number }) => o.orderId)).toEqual([12, 11])
    expect(page1.hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/otc/orders?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((o: { orderId: number }) => o.orderId)).toEqual([10])
    expect(second.json().hasMore).toBe(false)
  })
})

describe('GET /v1/otc/orders/:id', () => {
  it('serves the fold with its event history and typed fillers', async () => {
    app = await freshDataApp(otcClient())
    const res = await app.inject({ url: '/v1/otc/orders/11', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('cancelled')
    expect(body.events).toHaveLength(4)
    expect(body.events[1]).toEqual({
      type: 'partiallyFilled', blockHeight: 102, eventIndex: 2, timestamp: '2026-08-20T10:00:00.000Z',
      amountIn: '100', amountOut: '120',
      filler: { address: FILLER_SS58, accountIdHex: FILLER, evmAddress: null },
    })
    // The Cancelled row carries no amounts — never the zero-default.
    expect(body.events[3]).toMatchObject({ type: 'cancelled', amountIn: null, amountOut: null, filler: null })
  })

  it('404s an order whose placement is not indexed, and an unknown id', async () => {
    app = await freshDataApp(otcClient())
    const unplaced = await app.inject({ url: '/v1/otc/orders/13', headers: AUTH })
    expect(unplaced.statusCode).toBe(404)
    const unknown = await app.inject({ url: '/v1/otc/orders/999999', headers: AUTH })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.context.hint).toBe('list ids via /v1/otc/orders')
  })

  it('serves the bare event list', async () => {
    app = await freshDataApp(otcClient())
    const res = await app.inject({ url: '/v1/otc/orders/10/events', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ type: 'placed', amountIn: '1000', amountOut: '2000' })
  })
})
