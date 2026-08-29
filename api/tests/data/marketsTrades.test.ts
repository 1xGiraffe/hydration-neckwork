import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'
import { encodeAddress } from '@polkadot/util-crypto'

// Contract tests for GET /v1/trades — the bounded global fill feed.

type Row = Record<string, unknown>

const SWAPPER = `0x${'66'.repeat(32)}`
const SWAPPER_SS58 = encodeAddress(SWAPPER, 0)

function legRow(overrides: Row): Row {
  return {
    venue: 'stableswap', pool_key: '100', block_height: 500, event_index: 9, leg_index: 0, leg_kind: 'in',
    asset_id: 10, amount: '42', fee_dest: '', fee_recipient: '', swapper: SWAPPER, op_key: '',
    extrinsic_index: 4, ts: '2026-08-28 09:00:00', ingested_at: '2026-08-28 09:00:03',
    ...overrides,
  }
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/trades', () => {
  it('defaults to a 24h window and assembles fills', async () => {
    const client = fakeDataClient(
      (query, params) => {
        if (query.includes('-- data:trades:fill-keys')) return [{ block_height: 500, event_index: 9 }]
        if (query.includes('-- data:trades:fill-legs')) {
          void params
          return [legRow({}), legRow({ leg_kind: 'out', asset_id: 0, amount: '84' })]
        }
        return undefined
      },
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/trades', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({
      venue: 'stableswap', poolKey: '100',
      swapper: { address: SWAPPER_SS58 },
      inputs: [{ assetId: '10', amount: '42' }],
      outputs: [{ assetId: '0', amount: '84' }],
    })
    const keys = client.seen.find(s => s.query.includes('-- data:trades:fill-keys'))!
    const from = Number(keys.params.fromTime)
    const to = Number(keys.params.toTime)
    expect(to - from).toBe(86_400)
    expect(Math.abs(Date.now() / 1000 - to)).toBeLessThan(120)
  })

  it('bounds the window at 7 days and names the deep-history alternatives', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/trades?fromTime=2026-08-01T00:00:00Z&toTime=2026-08-20T00:00:00Z', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/\/v1\/pools\/\{venue\}\/\{poolKey\}\/trades/)
    expect(res.json().error.context.maxWindowDays).toBe(7)
  })

  it('binds the venue, asset and resolved account filters', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:trades:fill-keys') ? [] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/trades?venue=xyk&asset=5&account=${SWAPPER_SS58}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], hasMore: false })
    const keys = client.seen.find(s => s.query.includes('-- data:trades:fill-keys'))!
    expect(keys.params).toMatchObject({ venue: 'xyk', assetId: 5, swapper: SWAPPER })
  })

  it('rejects an unparseable account', async () => {
    app = await freshDataApp(fakeDataClient())
    expect((await app.inject({ url: '/v1/trades?account=zzz', headers: AUTH })).statusCode).toBe(400)
  })
})
