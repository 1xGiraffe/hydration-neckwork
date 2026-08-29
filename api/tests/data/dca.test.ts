import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { encodeAddress } from '@polkadot/util-crypto'

// Contract tests for /v1/dca/*: as-stored schedule facts (with the pre-router
// null rule), the owner-first event fold, and the executions page.

type Row = Record<string, unknown>

const OWNER = `0x${'77'.repeat(32)}`
const OWNER_SS58 = encodeAddress(OWNER, 0)

const MODERN_ROW: Row = {
  id: '35672', block_height: 13930671, ts: '2026-08-28 21:45:06', who: OWNER,
  asset_in: 10, asset_out: 0, direction: 'Sell', amount_per: '825000000', total_amount: '3300000000',
  period: 18, max_retries: 0,
}

// A pre-router schedule: DCA.Scheduled carried only {id, who}, so the stored
// row is all zeros/blanks (direction '') — the HDX=0 trap this surface nulls.
const PRE_ROUTER_ROW: Row = {
  id: '7', block_height: 700, ts: '2023-06-21 21:30:24', who: OWNER,
  asset_in: 0, asset_out: 0, direction: '', amount_per: '', total_amount: '',
  period: 0, max_retries: 0,
}

const EVENT_ROWS: Row[] = [
  { event_name: 'DCA.Completed', block_height: 13930900, event_index: 9, ts: '2026-08-28 22:00:00', amount_in: '', amount_out: '', error: '' },
  { event_name: 'DCA.TradeExecuted', block_height: 13930800, event_index: 7, ts: '2026-08-28 21:50:00', amount_in: '825000000', amount_out: '111', error: '' },
  { event_name: 'DCA.TradeFailed', block_height: 13930750, event_index: 5, ts: '2026-08-28 21:47:00', amount_in: '', amount_out: '', error: '{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}' },
  { event_name: 'DCA.TradeExecuted', block_height: 13930700, event_index: 3, ts: '2026-08-28 21:46:00', amount_in: '825000000', amount_out: '112', error: '' },
]

function dcaClient(schedules: Row[] = [MODERN_ROW, PRE_ROUTER_ROW], events: Row[] = EVENT_ROWS) {
  return fakeDataClient(
    (query, params) => {
      if (query.includes('-- data:dca:schedule-by-id')) {
        return schedules.filter(row => String(row.id) === String(params.id))
      }
      if (query.includes('-- data:dca:schedules')) {
        let rows = schedules
        if (params.owner) rows = rows.filter(row => row.who === params.owner)
        if (params.cursorId != null) rows = rows.filter(row => Number(row.id) < Number(params.cursorId))
        return [...rows].sort((a, b) => Number(b.id) - Number(a.id))
      }
      if (query.includes('-- data:dca:schedule-executions')) {
        if (params.owner !== OWNER) return []
        let rows = events
        if (params.cb != null) rows = rows.filter(row => Number(row.block_height) < Number(params.cb)
          || (Number(row.block_height) === Number(params.cb) && Number(row.event_index) < Number(params.ci)))
        return rows
      }
      if (query.includes('-- data:dca:schedule-aggregates')) {
        // What ClickHouse folds over the same rows.
        const executed = events.filter(row => row.event_name === 'DCA.TradeExecuted')
        const sum = (key: string) => executed.reduce((acc, row) => acc + BigInt(String(row[key] || '0')), 0n).toString()
        return params.owner === OWNER
          ? [{ executed: String(executed.length), in_sum: sum('amount_in'), out_sum: sum('amount_out'),
              failed: String(events.filter(row => row.event_name === 'DCA.TradeFailed').length),
              completed: events.some(row => row.event_name === 'DCA.Completed') ? 1 : 0,
              terminated: events.some(row => row.event_name === 'DCA.Terminated') ? 1 : 0,
              last_ts: String(events[0]?.ts ?? '1970-01-01 00:00:00'), n: String(events.length) }]
          : [{ executed: '0', in_sum: '0', out_sum: '0', failed: '0', completed: 0, terminated: 0, last_ts: '1970-01-01 00:00:00', n: '0' }]
      }
      return undefined
    },
  )
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/dca/schedules', () => {
  it('publishes stored facts for a router-era schedule and nulls for a pre-router one', async () => {
    app = await freshDataApp(dcaClient())
    const res = await app.inject({ url: '/v1/dca/schedules', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const [modern, preRouter] = res.json().items
    expect(modern).toEqual({
      scheduleId: 35672,
      owner: { address: OWNER_SS58, accountIdHex: OWNER, evmAddress: null },
      assetIn: '10', assetOut: '0', direction: 'sell',
      amountPer: '825000000', totalAmount: '3300000000', periodBlocks: 18, maxRetries: 0,
      createdAt: '2026-08-28T21:45:06.000Z', createdAtBlock: 13930671,
    })
    // Never the stored zeros: asset 0 is HDX, so they would assert an HDX→HDX
    // schedule that was never placed.
    expect(preRouter).toMatchObject({
      scheduleId: 7, assetIn: null, assetOut: null, direction: null,
      amountPer: null, totalAmount: null, periodBlocks: null,
    })
  })

  it('filters by owner (resolved from SS58) and pages by id cursor', async () => {
    const client = dcaClient()
    app = await freshDataApp(client)
    const first = await app.inject({ url: `/v1/dca/schedules?owner=${OWNER_SS58}&limit=1`, headers: AUTH })
    const page1 = first.json()
    expect(page1.items.map((i: { scheduleId: number }) => i.scheduleId)).toEqual([35672])
    expect(page1.hasMore).toBe(true)
    const listing = client.seen.find(s => s.query.includes('-- data:dca:schedules'))!
    expect(listing.params.owner).toBe(OWNER)

    const second = await app.inject({ url: `/v1/dca/schedules?owner=${OWNER_SS58}&limit=1&cursor=${page1.nextCursor}`, headers: AUTH })
    expect(second.json().items.map((i: { scheduleId: number }) => i.scheduleId)).toEqual([7])
  })
})

describe('GET /v1/dca/schedules/:id', () => {
  it('folds execution aggregates in SQL over the owner-first event read', async () => {
    app = await freshDataApp(dcaClient())
    const res = await app.inject({ url: '/v1/dca/schedules/35672', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      scheduleId: 35672,
      executedAmountIn: '1650000000',
      executedAmountOut: '223',
      executionCount: 2,
      failureCount: 1,
      completed: true,
      terminated: false,
      lastEventAt: '2026-08-28T22:00:00.000Z',
    })
  })

  it('404s an unknown schedule with the enumeration hint', async () => {
    app = await freshDataApp(dcaClient())
    const res = await app.inject({ url: '/v1/dca/schedules/424242', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toBe('list ids via /v1/dca/schedules')
  })
})

describe('GET /v1/dca/schedules/:id/executions', () => {
  it('maps event kinds to statuses, nulls non-executed amounts, and pages by keyset cursor', async () => {
    const client = dcaClient()
    app = await freshDataApp(client)
    const first = await app.inject({ url: '/v1/dca/schedules/35672/executions?limit=2', headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items).toEqual([
      { status: 'completed', blockHeight: 13930900, eventIndex: 9, timestamp: '2026-08-28T22:00:00.000Z', amountIn: null, amountOut: null, error: null },
      { status: 'executed', blockHeight: 13930800, eventIndex: 7, timestamp: '2026-08-28T21:50:00.000Z', amountIn: '825000000', amountOut: '111', error: null },
    ])
    expect(page1.hasMore).toBe(true)

    const second = await app.inject({ url: `/v1/dca/schedules/35672/executions?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    const page2 = second.json()
    expect(page2.items.map((i: { status: string }) => i.status)).toEqual(['failed', 'executed'])
    expect(page2.items[0].error).toBe('{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}')
    expect(page2.hasMore).toBe(false)
    // The cursor travels into SQL as a keyset predicate — the schedule is never
    // read whole (the treasury buyback has 370k+ events, past the row cap).
    const reads = client.seen.filter(s => s.query.includes('-- data:dca:schedule-executions'))
    expect(reads).toHaveLength(2)
    expect(reads[1].params).toMatchObject({ cb: 13930800, ci: 7 })
    expect(reads[1].query).toMatch(/LIMIT \{bound:UInt32\}/)
  })
})
