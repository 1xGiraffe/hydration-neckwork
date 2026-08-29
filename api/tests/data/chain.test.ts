import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'
import { encodeAddress } from '@polkadot/util-crypto'

// Contract tests for the chain core: /v1/status, /v1/blocks*, /v1/extrinsics*,
// /v1/events*. These pin exact response shapes, the cursor-pagination
// invariants, the 404-with-context envelope, and the bounded-window rule.

type Row = Record<string, unknown>

const SIGNER = `0x${'22'.repeat(32)}`
const SIGNER_SS58 = encodeAddress(SIGNER, 0)
const HASH_A = `0x${'aa'.repeat(32)}`
const HASH_B = `0x${'bb'.repeat(32)}`
const BLOCK_HASH = `0x${'cc'.repeat(32)}`

function blockRow(height: number): Row {
  return {
    block_height: height, block_hash: `0x${height.toString(16).padStart(64, '0')}`,
    parent_hash: `0x${(height - 1).toString(16).padStart(64, '0')}`,
    ts: '2026-08-20 10:00:00', spec_version: 440, author: null, ingested_at: '2026-08-20 10:00:05',
  }
}

const EXTRINSIC_ROW: Row = {
  block_height: 100, extrinsic_index: 2, extrinsic_hash: HASH_A, ts: '2026-08-20 10:00:00',
  call_name: 'Router.sell', signer: SIGNER, success: 1, fee: '12345', tip: '0',
  call_args_json: '{"assetIn":5}', error_json: null,
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/status', () => {
  it('reports the indexed head without a token', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject('/v1/status')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.indexedHead).toBe(TEST_HEAD)
    expect(body.indexedHeadTime).toBe('2026-08-28T12:00:00.000Z')
    expect(body.specVersion).toBe(440)
    expect(body.lagSeconds).toBeGreaterThanOrEqual(0)
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })
})

describe('GET /v1/blocks', () => {
  it('pages by cursor without overlap and stops cleanly', async () => {
    const heights = [105, 104, 103, 102, 101]
    const client = fakeDataClient((query, params) => {
      if (!query.includes('-- data:blocks:feed')) return undefined
      let rows = params.cb == null ? heights : heights.filter(h => h < Number(params.cb))
      if (params.rangeFrom != null) rows = rows.filter(h => h >= Number(params.rangeFrom))
      return rows.map(blockRow)
    })
    app = await freshDataApp(client)
    const first = await app.inject({ url: '/v1/blocks?limit=2', headers: AUTH })
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.items.map((b: { height: number }) => b.height)).toEqual([105, 104])
    expect(page1.hasMore).toBe(true)
    expect(page1.items[0]).toMatchObject({
      hash: blockRow(105).block_hash, specVersion: 440, timestamp: '2026-08-20T10:00:00.000Z', author: null,
    })

    const second = await app.inject({ url: `/v1/blocks?limit=2&cursor=${page1.nextCursor}`, headers: AUTH })
    const page2 = second.json()
    expect(page2.items.map((b: { height: number }) => b.height)).toEqual([103, 102])
    expect(page2.hasMore).toBe(true)

    const third = await app.inject({ url: `/v1/blocks?limit=2&cursor=${page2.nextCursor}`, headers: AUTH })
    const page3 = third.json()
    expect(page3.items.map((b: { height: number }) => b.height)).toEqual([101])
    expect(page3.hasMore).toBe(false)
    expect(page3.nextCursor).toBeUndefined()
  })

  it('collapses a replayed block to one row', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:blocks:feed')
      ? [blockRow(105), blockRow(105), blockRow(104)]
      : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/blocks?limit=10', headers: AUTH })
    expect(res.json().items.map((b: { height: number }) => b.height)).toEqual([105, 104])
  })

  it('rejects a garbage cursor instead of restarting at page one', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/blocks?cursor=@@@@', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })
})

describe('GET /v1/blocks/:heightOrHash', () => {
  function detailClient(overrides: { header?: Row | null; indexHeight?: number | null } = {}) {
    return fakeDataClient(
      query => (query.includes('-- data:blocks:by-height')
        ? (overrides.header === null ? [] : [overrides.header ?? { ...blockRow(100), block_hash: BLOCK_HASH }])
        : undefined),
      query => (query.includes('-- data:blocks:by-hash')
        ? (overrides.indexHeight === null ? [] : [{ block_height: overrides.indexHeight ?? 100 }])
        : undefined),
      query => (query.includes('-- data:blocks:extrinsic-count') ? [{ total: '3' }] : undefined),
      query => (query.includes('-- data:blocks:event-count') ? [{ total: '17' }] : undefined),
    )
  }

  it('answers a height with header and counts', async () => {
    app = await freshDataApp(detailClient())
    const res = await app.inject({ url: '/v1/blocks/100', headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ height: 100, hash: BLOCK_HASH, extrinsicCount: 3, eventCount: 17 })
  })

  it('resolves a hash through the index and re-checks it against the current header', async () => {
    app = await freshDataApp(detailClient())
    const hit = await app.inject({ url: `/v1/blocks/${BLOCK_HASH}`, headers: AUTH })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().height).toBe(100)

    // A superseded index row (hash no longer the block's current hash) is a
    // 404, never another block's header. A fresh hash, because the in-process
    // point-read cache is shared across apps within this test file.
    const supersededHash = `0x${'0d'.repeat(32)}`
    const stale = await freshDataApp(fakeDataClient(
      query => (query.includes('-- data:blocks:by-hash') ? [{ block_height: 100 }] : undefined),
      query => (query.includes('-- data:blocks:by-height') ? [{ ...blockRow(100), block_hash: `0x${'dd'.repeat(32)}` }] : undefined),
    ))
    try {
      const res = await stale.inject({ url: `/v1/blocks/${supersededHash}`, headers: AUTH })
      expect(res.statusCode).toBe(404)
    } finally {
      await stale.close()
    }
  })

  it('describes a not-yet-ingested height with aheadBy in the 404 context', async () => {
    app = await freshDataApp(detailClient({ header: null }))
    const res = await app.inject({ url: `/v1/blocks/${TEST_HEAD + 50}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    const { context } = res.json().error
    expect(context.indexedHead).toBe(TEST_HEAD)
    expect(context.aheadBy).toBe(50)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('rejects a segment that is neither height nor hash', async () => {
    app = await freshDataApp(detailClient())
    expect((await app.inject({ url: '/v1/blocks/xyz', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/blocks/:height/extrinsics and /events', () => {
  it('lists a block’s contents, or 404s when the block itself is unknown', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:blocks:by-height') ? [{ ...blockRow(100), block_hash: BLOCK_HASH }] : undefined),
      query => (query.includes('-- data:blocks:extrinsics') ? [EXTRINSIC_ROW] : undefined),
      query => (query.includes('-- data:blocks:events')
        ? [{ block_height: 100, event_index: 1, extrinsic_index: 2, event_name: 'Balances.Transfer', ts: '2026-08-20 10:00:00', args_json: '{"amount":"1"}' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const extrinsics = await app.inject({ url: '/v1/blocks/100/extrinsics', headers: AUTH })
    expect(extrinsics.statusCode).toBe(200)
    expect(extrinsics.json().items[0]).toMatchObject({
      blockHeight: 100, extrinsicIndex: 2, callName: 'Router.sell', success: true, fee: '12345',
      signer: { address: SIGNER_SS58, accountIdHex: SIGNER, evmAddress: null },
    })
    const events = await app.inject({ url: '/v1/blocks/100/events', headers: AUTH })
    expect(events.json().items[0]).toMatchObject({ eventName: 'Balances.Transfer', args: { amount: '1' } })

    const missing = await freshDataApp(fakeDataClient(query => (query.includes('-- data:blocks:by-height') ? [] : undefined)))
    try {
      expect((await missing.inject({ url: '/v1/blocks/123/extrinsics', headers: AUTH })).statusCode).toBe(404)
    } finally {
      await missing.close()
    }
  })
})

describe('GET /v1/extrinsics/:id', () => {
  it('resolves the hash form through the full-history index', async () => {
    const client = fakeDataClient(
      query => (query.includes('-- data:extrinsic:hash-index') ? [{ block_height: 100, extrinsic_index: 2 }] : undefined),
      query => (query.includes('-- data:extrinsic:by-position') ? [EXTRINSIC_ROW] : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/extrinsics/${HASH_A}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      blockHeight: 100, extrinsicIndex: 2, hash: HASH_A, success: true, error: null, args: { assetIn: 5 },
    })
    // No time bound anywhere in the lookup: full history is the point.
    const indexRead = client.seen.find(s => s.query.includes('-- data:extrinsic:hash-index'))!
    expect(indexRead.query).not.toMatch(/toIntervalDay|block_timestamp >=/)
  })

  it('decodes and names a Module dispatch error for the block’s runtime', async () => {
    // A fresh (block, index): the point-read cache is shared across this file.
    const failed = {
      ...EXTRINSIC_ROW,
      block_height: 101,
      extrinsic_index: 3,
      success: 0,
      error_json: '{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}',
    }
    const client = fakeDataClient(
      query => (query.includes('-- data:extrinsic:by-position') ? [failed] : undefined),
      query => (query.includes('-- data:extrinsic:error-name')
        ? [{ pallet_name: 'DCA', error_name: 'ScheduleNotFound', docs: 'Schedule not exist' }]
        : undefined),
    )
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/extrinsics/101-3', headers: AUTH })
    expect(res.json().error).toEqual({
      kind: 'Module', module: 'DCA', name: 'ScheduleNotFound', docs: 'Schedule not exist',
      raw: '{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}',
    })
    const nameRead = client.seen.find(s => s.query.includes('-- data:extrinsic:error-name'))!
    expect(nameRead.params).toMatchObject({ pallet: 66, error: 12 })
  })

  it('404s an unknown hash with the full-history hint', async () => {
    app = await freshDataApp(fakeDataClient(query => (query.includes('-- data:extrinsic:hash-index') ? [] : undefined)))
    const res = await app.inject({ url: `/v1/extrinsics/${HASH_B}`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toMatch(/full chain history/)
  })

  it('rejects a bare block height, naming the two working forms', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/extrinsics/12345', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/\{blockHeight\}-\{extrinsicIndex\}/)
  })
})

describe('GET /v1/extrinsics', () => {
  it('serves the signer filter from the account-first projection', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:extrinsics:by-signer')
      ? [{ block_height: 100, extrinsic_index: 2, extrinsic_hash: HASH_A, ts: '2026-08-20 10:00:00', call_name: 'Router.sell', signer: SIGNER, success: 1, fee: '1', tip: '0', ingested_at: '2026-08-20 10:00:05' }]
      : undefined))
    app = await freshDataApp(client)
    // SS58 input resolves to the same account the projection stores.
    const res = await app.inject({ url: `/v1/extrinsics?signer=${SIGNER_SS58}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toHaveLength(1)
    const read = client.seen.find(s => s.query.includes('-- data:extrinsics:by-signer'))!
    expect(read.params.account).toBe(SIGNER)
  })

  it('requires a bounded window for call= without signer', async () => {
    app = await freshDataApp(fakeDataClient())
    const bare = await app.inject({ url: '/v1/extrinsics?call=Router.sell', headers: AUTH })
    expect(bare.statusCode).toBe(400)
    expect(bare.json().error.context.maxWindowDays).toBe(90)

    const tooWide = await app.inject({
      url: '/v1/extrinsics?call=Router.sell&fromTime=2025-01-01T00:00:00Z&toTime=2026-01-01T00:00:00Z',
      headers: AUTH,
    })
    expect(tooWide.statusCode).toBe(400)
  })

  it('accepts call= inside a bounded window', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:extrinsics:feed') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({
      url: '/v1/extrinsics?call=Router.sell&fromTime=2026-08-01T00:00:00Z&toTime=2026-08-20T00:00:00Z',
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], hasMore: false })
  })

  it('rejects an unparseable signer', async () => {
    app = await freshDataApp(fakeDataClient())
    const res = await app.inject({ url: '/v1/extrinsics?signer=nonsense', headers: AUTH })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/SS58/)
  })
})

describe('GET /v1/events', () => {
  it('pages the feed and enforces the name-filter window', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:events:feed')
      ? [{ block_height: 100, event_index: 7, extrinsic_index: null, event_name: 'Omnipool.SellExecuted', ts: '2026-08-20 10:00:00', args_json: '{"who":"x"}', ingested_at: '2026-08-20 10:00:05' }]
      : undefined))
    app = await freshDataApp(client)

    const unbounded = await app.inject({ url: '/v1/events?name=Omnipool.SellExecuted', headers: AUTH })
    expect(unbounded.statusCode).toBe(400)

    const res = await app.inject({
      url: '/v1/events?name=Omnipool.SellExecuted&fromBlock=90&toBlock=110',
      headers: AUTH,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ blockHeight: 100, eventIndex: 7, extrinsicIndex: null, eventName: 'Omnipool.SellExecuted', args: { who: 'x' } })
  })

  it('answers an event id, and 404s a missing one with head context', async () => {
    const client = fakeDataClient(query => (query.includes('-- data:events:by-position') ? [] : undefined))
    app = await freshDataApp(client)
    const res = await app.inject({ url: '/v1/events/100-7', headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.indexedHead).toBe(TEST_HEAD)

    expect((await app.inject({ url: '/v1/events/not-an-id', headers: AUTH })).statusCode).toBe(400)
  })
})
