import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for GET /v1/xcm/transfers: the bounded-window flow feed and
// its name-set direction classification.

type Row = Record<string, unknown>

const SENDER = `0x${'77'.repeat(32)}`

const ROWS: Row[] = [
  { block_height: 900, event_index: 4, extrinsic_index: 2, ts: '2026-08-28 09:00:00', event_name: 'XTokens.TransferredAssets', asset_id: 5, who: SENDER, amount: '5000000000', ingested_at: '2026-08-28 09:00:05' },
  { block_height: 800, event_index: 7, extrinsic_index: null, ts: '2026-08-28 08:00:00', event_name: 'Tokens.Deposited', asset_id: 10, who: SENDER, amount: '123', ingested_at: '2026-08-28 08:00:05' },
]

function xcmClient(rows: Row[] = ROWS) {
  return fakeDataClient((query, params) => {
    if (!query.includes('-- data:xcm:transfers')) return undefined
    let matched = rows
    const outNames = params.outNames as string[]
    const inNames = params.inNames as string[]
    // Mirror the route's direction SQL — the QUERY TEXT says which set is
    // bound (both name arrays always travel in params).
    const wantsOut = query.includes('{outNames')
    const wantsIn = query.includes('{inNames')
    matched = matched.filter(row => {
      const isOut = outNames.includes(String(row.event_name))
      const isIn = inNames.includes(String(row.event_name)) && row.extrinsic_index == null
      return (wantsOut && isOut) || (wantsIn && isIn)
    })
    if (params.assetId != null) matched = matched.filter(row => Number(row.asset_id) === Number(params.assetId))
    return matched
  })
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/xcm/transfers', () => {
  it('classifies direction by name set and hook context, newest first', async () => {
    const client = xcmClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/xcm/transfers', headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items } = res.json()
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      blockHeight: 900, eventIndex: 4, extrinsicIndex: 2, extrinsicHash: null, timestamp: '2026-08-28T09:00:00.000Z',
      eventName: 'XTokens.TransferredAssets', direction: 'out',
      who: { address: encodeAddress(SENDER, 0), accountIdHex: SENDER, evmAddress: null },
      assetId: '5', amount: '5000000000',
    })
    expect(items[1]).toMatchObject({ eventName: 'Tokens.Deposited', direction: 'in', assetId: '10', extrinsicIndex: null })

    // The read is windowed even with no explicit bounds (default last 24 h) and
    // never names the ambiguous Currencies.Withdrawn or the queue barriers.
    const read = client.seen.find(s => s.query.includes('-- data:xcm:transfers'))!
    expect(read.params.fromTime).toBeTypeOf('number')
    expect(read.params.toTime).toBeTypeOf('number')
    expect(Number(read.params.toTime) - Number(read.params.fromTime)).toBe(86_400)
    expect(JSON.stringify(read.params)).not.toMatch(/Currencies.Withdrawn|MessageQueue.Processed|System.NewAccount/)
    expect(read.query).toMatch(/extrinsic_index IS NULL/)
  })

  it('filters by direction and asset', async () => {
    app = await freshDataApp(xcmClient())
    const out = await app.inject({ url: '/v1/xcm/transfers?direction=out', headers: AUTH })
    expect(out.json().items.map((i: { eventName: string }) => i.eventName)).toEqual(['XTokens.TransferredAssets'])
    const inbound = await app.inject({ url: '/v1/xcm/transfers?direction=in', headers: AUTH })
    expect(inbound.json().items.map((i: { eventName: string }) => i.eventName)).toEqual(['Tokens.Deposited'])
    const asset = await app.inject({ url: '/v1/xcm/transfers?asset=10', headers: AUTH })
    expect(asset.json().items.map((i: { assetId: string }) => i.assetId)).toEqual(['10'])
  })

  it('rejects a window wider than 7 days, naming the bound', async () => {
    app = await freshDataApp(xcmClient())
    const res = await app.inject({
      url: '/v1/xcm/transfers?fromTime=2026-08-01T00:00:00Z&toTime=2026-08-20T00:00:00Z',
      headers: AUTH,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
    expect(res.json().error.context.maxWindowDays).toBe(7)
  })

  it('pages by cursor inside the window', async () => {
    const many = [ROWS[0], { ...ROWS[1] }, { ...ROWS[1], block_height: 700, ts: '2026-08-28 07:00:00' }]
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:xcm:transfers')) return undefined
      let matched = many
      if (params.cb != null) matched = matched.filter(row => Number(row.block_height) < Number(params.cb))
      return matched
    })
    app = await freshDataApp(client)
    const first = await app.inject({ url: '/v1/xcm/transfers?limit=2&fromTime=2026-08-28T00:00:00Z&toTime=2026-08-28T10:00:00Z', headers: AUTH })
    expect(first.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([900, 800])
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/xcm/transfers?limit=2&fromTime=2026-08-28T00:00:00Z&toTime=2026-08-28T10:00:00Z&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([700])
  })
})
