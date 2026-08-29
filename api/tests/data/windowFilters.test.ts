import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// The uniform window quartet (fromBlock/toBlock/fromTime/toTime) on the deep
// feeds: bounds must reach the SQL as parameters (so cost scales with the
// window, not the entity's history), and two windows must never share a cache
// entry.

const ACC = `0x${'11'.repeat(32)}`

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('SQL-windowed account feeds', () => {
  it('passes block and time bounds into the staking read as parameters', async () => {
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:accounts:staking')) return undefined
      expect(query).toMatch(/block_height >= \{fromBlock:UInt32\}/)
      expect(query).toMatch(/block_height <= \{toBlock:UInt32\}/)
      expect(query).toMatch(/block_timestamp >= toDateTime\(\{fromTime:UInt32\}\)/)
      expect(params).toMatchObject({ fromBlock: 100, toBlock: 200, fromTime: 1754006400 })
      return []
    })
    app = await freshDataApp(client)
    const res = await app.inject({
      url: `/v1/accounts/${ACC}/staking?fromBlock=100&toBlock=200&fromTime=2025-08-01T00:00:00Z`,
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    expect(client.seen.some(s => s.query.includes('-- data:accounts:staking'))).toBe(true)
  })

  it('keeps two windows in separate cache entries', async () => {
    let calls = 0
    const client = fakeDataClient(query => {
      if (!query.includes('-- data:accounts:events')) return undefined
      calls += 1
      return []
    })
    app = await freshDataApp(client)
    await app.inject({ url: `/v1/accounts/${ACC}/events?fromBlock=1&toBlock=50`, headers: AUTH })
    await app.inject({ url: `/v1/accounts/${ACC}/events?fromBlock=51&toBlock=99`, headers: AUTH })
    expect(calls).toBe(2)
  })

  it('windows the trades leg read alongside the block-granular cursor', async () => {
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:accounts:trade-legs')) return undefined
      expect(params).toMatchObject({ fromTime: 1753920000, toTime: 1754006400 })
      expect(query).toMatch(/block_timestamp <= toDateTime\(\{toTime:UInt32\}\)/)
      return []
    })
    app = await freshDataApp(client)
    const res = await app.inject({
      url: `/v1/accounts/${ACC}/trades?fromTime=2025-07-31T00:00:00Z&toTime=2025-08-01T00:00:00Z`,
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('SQL-windowed schedule executions', () => {
  it('passes the quartet into the executions read instead of reading the schedule whole', async () => {
    const seenParams: Record<string, unknown>[] = []
    const client = fakeDataClient(
      query => (query.includes('-- data:dca:schedule-by-id')
        ? [{ id: '7', block_height: 90, ts: '2026-08-01 00:00:00', who: ACC, asset_in: 5, asset_out: 0, direction: 'Sell', amount_per: '1', total_amount: '10', period: 10, max_retries: 3 }]
        : undefined),
      (query, params) => {
        if (!query.includes('-- data:dca:schedule-executions')) return undefined
        seenParams.push(params)
        expect(query).toMatch(/WHERE who = \{owner:String\} AND id = \{id:UInt64\}/)
        expect(query).toMatch(/LIMIT \{bound:UInt32\}/)
        return [{ event_name: 'DCA.TradeExecuted', block_height: 200, event_index: 2, ts: '2026-08-02 00:00:00', amount_in: '1', amount_out: '2', error: '' }]
      },
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/dca/schedules/7/executions?fromBlock=150&toBlock=250', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((item: { blockHeight: number }) => item.blockHeight)).toEqual([200])
    expect(seenParams[0]).toMatchObject({ owner: ACC, id: 7, fromBlock: 150, toBlock: 250 })

    const timed = await app.inject({ url: '/v1/dca/schedules/7/executions?toTime=2026-08-01T23:00:00Z', headers: AUTH })
    expect(timed.statusCode).toBe(200)
    expect(seenParams[1]).toMatchObject({ toTime: Math.floor(Date.parse('2026-08-01T23:00:00Z') / 1000) })
    expect(seenParams[1]).not.toHaveProperty('fromBlock')
  })
})
