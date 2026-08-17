import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract tests for the chain-lookup group (/v1/extrinsics, /v1/otc/orders,
// /v1/staking/events) plus unit tests for the three pure functions the surface's
// meaning lives in: parseDispatchError (what a failed extrinsic actually says),
// foldOtcOrder (open/filled/cancelled and how much of the order is gone), and
// parseStakingEventArgs (the typed fields of the two staking event streams).
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const SIGNER = `0x${'11'.repeat(32)}`
const EVM_SIGNER = `0x45544800${'aa'.repeat(20)}${'00'.repeat(8)}`
const FILLER = `0x${'22'.repeat(32)}`
const HASH = `0x${'ab'.repeat(32)}`
const MISSING_HASH = `0x${'cd'.repeat(32)}`
const FAILED_HASH = `0x${'ef'.repeat(32)}`
// A second failure and a second position. The by-position route is memoised
// in-process and that cache is global across app instances, so a test asserting
// on the query itself needs a key no other test used.
const UNNAMED_HASH = `0x${'ba'.repeat(32)}`
const PROBE_HASH = `0x${'9c'.repeat(32)}`

const EXTRINSIC_ROWS: Row[] = [
  {
    block_height: 13585924, extrinsic_index: 2, extrinsic_hash: HASH, ts: '2026-08-12 09:15:30',
    signer: SIGNER, success: 1, error_json: null,
  },
  {
    block_height: 13585900, extrinsic_index: 5, extrinsic_hash: FAILED_HASH, ts: '2026-08-12 09:12:00',
    signer: EVM_SIGNER, success: 0, error_json: '{"__kind":"Module","value":{"index":67,"error":"0x03000000"}}',
  },
  {
    block_height: 13585880, extrinsic_index: 1, extrinsic_hash: UNNAMED_HASH, ts: '2026-08-12 09:10:00',
    signer: SIGNER, success: 0, error_json: '{"__kind":"Module","value":{"index":250,"error":"0x07000000"}}',
  },
  {
    block_height: 13585870, extrinsic_index: 4, extrinsic_hash: PROBE_HASH, ts: '2026-08-12 09:09:00',
    signer: SIGNER, success: 1, error_json: null,
  },
]

// price_data.otc_order_events for order 1504: placed, four partial fills, cancelled.
// Only the Placed row carries the pair and partiallyFillable; a fill row's
// asset_in/asset_out default to 0, which is also HDX's real registry id.
const OTC_ROWS: Row[] = [
  { event_name: 'Placed', asset_in: 5, asset_out: 23, amount_in: '1622950819672', amount_out: '99000000', partially_fillable: 1, filler: '', block_height: 12769842, event_index: 146, ts: '2026-06-16 06:35:42' },
  { event_name: 'PartiallyFilled', asset_in: 0, asset_out: 0, amount_in: '10107171652', amount_out: '616537', partially_fillable: 0, filler: FILLER, block_height: 12894605, event_index: 62, ts: '2026-06-26 06:49:48' },
  { event_name: 'PartiallyFilled', asset_in: 0, asset_out: 0, amount_in: '1000000000', amount_out: '61000', partially_fillable: 0, filler: FILLER, block_height: 12935821, event_index: 14, ts: '2026-06-29 10:24:39' },
  { event_name: 'Cancelled', asset_in: 0, asset_out: 0, amount_in: '', amount_out: '', partially_fillable: 0, filler: '', block_height: 13000000, event_index: 3, ts: '2026-07-02 00:00:00' },
]

const STAKING_ROWS: Row[] = [
  { event_name: 'Staking.StakingInitialized', block_height: 3398400, event_index: 69, ts: '2024-01-01 00:00:00', args_json: '{"nonDustableBalance":"1000000000000000"}' },
  { event_name: 'Staking.AccumulatedRpsUpdated', block_height: 3398426, event_index: 6, ts: '2024-01-01 00:05:00', args_json: '{"accumulatedRps":"119305674157435","totalStake":"1382000000000000000"}' },
  { event_name: 'Staking.AccumulatedRpsUpdated', block_height: 3398476, event_index: 6, ts: '2024-01-01 00:10:00', args_json: '{"accumulatedRps":"125566079168634","totalStake":"4475000000000000000"}' },
  // A replay duplicate of the row above: same (block_height, event_index), which
  // is the ReplacingMergeTree key, so the page must report it once.
  { event_name: 'Staking.AccumulatedRpsUpdated', block_height: 3398476, event_index: 6, ts: '2024-01-01 00:10:00', args_json: '{"accumulatedRps":"125566079168634","totalStake":"4475000000000000000"}' },
]

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(overrides: { extrinsics?: Row[]; otc?: Row[]; staking?: Row[]; errorName?: Row[] } = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.raw_extrinsics')) {
        const rows = overrides.extrinsics ?? EXTRINSIC_ROWS
        if (params.hash != null) return queryResult(rows.filter(row => row.extrinsic_hash === params.hash))
        return queryResult(rows.filter(row => row.block_height === params.blockHeight && row.extrinsic_index === params.index))
      }
      if (query.includes('FROM price_data.runtime_error_names')) {
        return queryResult(overrides.errorName ?? [{ pallet_name: 'Omnipool', error_name: 'BuyLimitNotReached', docs: 'Minimum trading limit has not been reached' }])
      }
      if (query.includes('FROM price_data.otc_order_events')) {
        const rows = overrides.otc ?? OTC_ROWS
        return queryResult(Number(params.orderId) === 1504 ? rows : [])
      }
      if (query.includes('FROM price_data.raw_events')) {
        const rows = (overrides.staking ?? STAKING_ROWS)
          .filter(row => (params.names as string[]).includes(String(row.event_name)))
          .filter(row => params.fromBlock == null || Number(row.block_height) >= Number(params.fromBlock))
          .filter(row => params.toBlock == null || Number(row.block_height) <= Number(params.toBlock))
        if (query.includes('uniqExact')) {
          const keys = new Set(rows.map(row => `${row.block_height}:${row.event_index}`))
          return queryResult([{ total: String(keys.size) }])
        }
        return queryResult(rows.slice(0, Number(params.bound ?? rows.length)))
      }
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

let app: FastifyInstance
let probe: ReturnType<typeof fakeClient>

async function freshApp(client: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: client as never, logger: false })
}

beforeAll(async () => {
  probe = fakeClient()
  app = await freshApp(probe)
})

afterAll(async () => {
  await app?.close()
})

describe('parseDispatchError', () => {
  it('splits a Module error into its pallet and error indices', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    // The `error` field is a 4-byte little-endian array rendered as hex; only the
    // first byte is the error index within the pallet.
    expect(parseDispatchError('{"__kind":"Module","value":{"index":67,"error":"0x03000000"}}'))
      .toEqual({ kind: 'Module', moduleIndex: 67, errorIndex: 3, raw: '{"__kind":"Module","value":{"index":67,"error":"0x03000000"}}' })
  })

  // Blocks 692,900 … 1,475,949 (2022-07-06 … 2022-11-29) carry a DIFFERENT
  // Module shape: `index` and `error` sit at the top level and `error` is a plain
  // integer rather than a 4-byte little-endian hex array. Measured on the live
  // table: 601 extrinsics, and `runtime_error_names` can name all 601 — so
  // reading only the modern shape reported `module`/`name`/`docs` as null for
  // every one of them while the metadata to name them was already indexed. The
  // by-position route is age-unlimited by contract, so this era is reachable.
  it('reads the pre-2022-11 flat Module shape, whose error index is an integer', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    const filtered = '{"index":1,"error":5,"__kind":"Module"}'
    expect(parseDispatchError(filtered))
      .toEqual({ kind: 'Module', moduleIndex: 1, errorIndex: 5, raw: filtered })
    const invalid = '{"index":19,"error":14,"__kind":"Module"}'
    expect(parseDispatchError(invalid))
      .toEqual({ kind: 'Module', moduleIndex: 19, errorIndex: 14, raw: invalid })
    // Pallet 0 / error 0 is a real triple, so a flat shape reporting it must not
    // be confused with "no indices".
    expect(parseDispatchError('{"index":0,"error":0,"__kind":"Module"}'))
      .toMatchObject({ moduleIndex: 0, errorIndex: 0 })
  })

  // The nested shape stays authoritative where both could be read, so a row that
  // somehow carried both cannot flip meaning depending on parse order.
  it('prefers the nested value over top-level indices when both are present', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    expect(parseDispatchError('{"__kind":"Module","index":1,"error":5,"value":{"index":67,"error":"0x03000000"}}'))
      .toMatchObject({ moduleIndex: 67, errorIndex: 3 })
  })

  it('reports a Module error whose indices are unreadable without inventing 0', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    // 0 is System's pallet index and a real error index, so a shape neither reader
    // understands must stay null rather than defaulting into a valid triple. Both
    // of these fail on the PALLET index, so neither reaches the error reader —
    // which is why the discriminating case below is a separate assertion.
    expect(parseDispatchError('{"__kind":"Module"}'))
      .toMatchObject({ kind: 'Module', moduleIndex: null, errorIndex: null })
    expect(parseDispatchError('{"__kind":"Module","index":"notanumber","error":5}'))
      .toMatchObject({ kind: 'Module', moduleIndex: null, errorIndex: null })
  })

  // THE case that pins the error-index half of the honest-null rule, and the only
  // one that does: the pallet index is readable, so parsing proceeds to `error`
  // and finds nothing. The old reader computed `parseInt(''.slice(2, 4) || '0', 16)`
  // and published errorIndex 0 — a VALID triple naming the pallet's first error,
  // which `nameModuleError` would then have resolved to a real, wrong name.
  // Verified against the pre-fix function: it returns 0 for every input here.
  it('leaves the error index null when the pallet is readable but the error is not', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    for (const raw of [
      '{"__kind":"Module","value":{"index":67}}',              // field absent
      '{"__kind":"Module","value":{"index":67,"error":""}}',   // blank
      '{"__kind":"Module","value":{"index":67,"error":"   "}}', // whitespace only
      '{"__kind":"Module","value":{"index":67,"error":null}}',
      '{"__kind":"Module","value":{"index":67,"error":"nope"}}',
      '{"__kind":"Module","index":67}',                        // flat, error absent
    ]) {
      expect(parseDispatchError(raw), raw).toMatchObject({ kind: 'Module', moduleIndex: 67, errorIndex: null })
    }
  })

  // Both indices are u8 on chain and `nameModuleError` binds them as ClickHouse
  // UInt8, which throws rather than truncates — so an out-of-range index must
  // report null, not travel into the query and 500. Unreachable from live rows
  // (pallet 0…203, error 0…30 across all 362,681), hence a structural guard.
  it('refuses an index outside the u8 the metadata query binds', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    // Pallet out of range: nothing is nameable, so both go null.
    expect(parseDispatchError('{"__kind":"Module","value":{"index":300,"error":"0x05000000"}}'))
      .toMatchObject({ moduleIndex: null, errorIndex: null })
    expect(parseDispatchError('{"__kind":"Module","index":256,"error":5}'))
      .toMatchObject({ moduleIndex: null, errorIndex: null })
    // Error out of range only: the pallet still names, the error does not.
    expect(parseDispatchError('{"__kind":"Module","index":67,"error":300}'))
      .toMatchObject({ moduleIndex: 67, errorIndex: null })
    // 255 is in range on both.
    expect(parseDispatchError('{"__kind":"Module","index":255,"error":255}'))
      .toMatchObject({ moduleIndex: 255, errorIndex: 255 })
    expect(parseDispatchError('{"__kind":"Module","value":{"index":255,"error":"0xff000000"}}'))
      .toMatchObject({ moduleIndex: 255, errorIndex: 255 })
  })

  it('carries a named kind with no fabricated indices', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    expect(parseDispatchError('{"__kind":"Token","value":{"__kind":"FundsUnavailable"}}'))
      .toMatchObject({ kind: 'Token', moduleIndex: null, errorIndex: null })
    expect(parseDispatchError('{"__kind":"Other"}')).toMatchObject({ kind: 'Other', moduleIndex: null, errorIndex: null })
  })

  it('is null for an absent or malformed error', async () => {
    const { parseDispatchError } = await import('../../src/public/services/chain.ts')
    expect(parseDispatchError(null)).toBeNull()
    expect(parseDispatchError('')).toBeNull()
    expect(parseDispatchError('not json')).toBeNull()
    expect(parseDispatchError('{"value":{"index":1}}')).toBeNull()
  })
})

describe('foldOtcOrder', () => {
  it('reads the pair from the Placed row and sums the fills', async () => {
    const { foldOtcOrder } = await import('../../src/public/services/chain.ts')
    const order = foldOtcOrder(1504, OTC_ROWS as never)!
    expect(order.assetIn).toBe('5')
    expect(order.assetOut).toBe('23')
    expect(order.amountIn).toBe('1622950819672')
    expect(order.amountOut).toBe('99000000')
    expect(order.partiallyFillable).toBe(true)
    // Integer sums over both fill kinds, never floats.
    expect(order.filledAmountIn).toBe('11107171652')
    expect(order.filledAmountOut).toBe('677537')
  })

  it('reports the last terminal event as the status', async () => {
    const { foldOtcOrder } = await import('../../src/public/services/chain.ts')
    expect(foldOtcOrder(1504, OTC_ROWS as never)!.status).toBe('cancelled')
    const open = OTC_ROWS.filter(row => row.event_name !== 'Cancelled')
    expect(foldOtcOrder(1504, open as never)!.status).toBe('open')
    const filled = [...open, { event_name: 'Filled', asset_in: 0, asset_out: 0, amount_in: '1', amount_out: '2', partially_fillable: 0, filler: FILLER, block_height: 13000001, event_index: 1, ts: '2026-07-03 00:00:00' }]
    expect(foldOtcOrder(1504, filled as never)!.status).toBe('filled')
  })

  it('never reads the pair off a fill row, where 0 means "absent" and not HDX', async () => {
    const { foldOtcOrder } = await import('../../src/public/services/chain.ts')
    // Placed last in the input: the fold must pick it by event name, not position.
    const shuffled = [OTC_ROWS[1], OTC_ROWS[2], OTC_ROWS[0]]
    expect(foldOtcOrder(1504, shuffled as never)!.assetIn).toBe('5')
  })

  it('is null without a Placed row, rather than inventing a pair', async () => {
    const { foldOtcOrder } = await import('../../src/public/services/chain.ts')
    expect(foldOtcOrder(1504, [] as never)).toBeNull()
    expect(foldOtcOrder(1504, [OTC_ROWS[1]] as never)).toBeNull()
  })
})

describe('parseStakingEventArgs', () => {
  it('types the AccumulatedRpsUpdated stream as integer strings', async () => {
    const { parseStakingEventArgs } = await import('../../src/public/services/chain.ts')
    expect(parseStakingEventArgs('AccumulatedRpsUpdated', '{"accumulatedRps":"119305674157435","totalStake":"1382000000000000000"}'))
      .toEqual({ accumulatedRps: '119305674157435', totalStake: '1382000000000000000', nonDustableBalance: null })
  })

  it('types the StakingInitialized stream', async () => {
    const { parseStakingEventArgs } = await import('../../src/public/services/chain.ts')
    expect(parseStakingEventArgs('StakingInitialized', '{"nonDustableBalance":"1000000000000000"}'))
      .toEqual({ accumulatedRps: null, totalStake: null, nonDustableBalance: '1000000000000000' })
  })

  it('reports a missing or non-integer field as null rather than 0', async () => {
    const { parseStakingEventArgs } = await import('../../src/public/services/chain.ts')
    expect(parseStakingEventArgs('AccumulatedRpsUpdated', '{}')).toEqual({ accumulatedRps: null, totalStake: null, nonDustableBalance: null })
    expect(parseStakingEventArgs('AccumulatedRpsUpdated', 'not json')).toEqual({ accumulatedRps: null, totalStake: null, nonDustableBalance: null })
    expect(parseStakingEventArgs('AccumulatedRpsUpdated', '{"accumulatedRps":1.5,"totalStake":"x"}')).toEqual({ accumulatedRps: null, totalStake: null, nonDustableBalance: null })
  })
})

describe('GET /v1/extrinsics/:hash', () => {
  it('returns the toast fields for a successful extrinsic', async () => {
    const res = await app.inject('/v1/extrinsics/' + HASH)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      blockHeight: 13585924,
      extrinsicIndex: 2,
      hash: HASH,
      timestamp: '2026-08-12T09:15:30.000Z',
      signer: SIGNER,
      success: true,
      error: null,
    })
  })

  it('names a Module error from the runtime that raised it', async () => {
    const res = await app.inject('/v1/extrinsics/' + FAILED_HASH)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      success: false,
      signer: EVM_SIGNER,
      error: {
        kind: 'Module',
        module: 'Omnipool',
        name: 'BuyLimitNotReached',
        docs: 'Minimum trading limit has not been reached',
        raw: '{"__kind":"Module","value":{"index":67,"error":"0x03000000"}}',
      },
    })
  })

  it('reports an unnamed Module error honestly instead of guessing', async () => {
    const local = fakeClient({ errorName: [] })
    const localApp = await freshApp(local)
    try {
      const res = await localApp.inject('/v1/extrinsics/' + UNNAMED_HASH)
      expect(res.json().error).toMatchObject({
        kind: 'Module',
        module: null,
        name: null,
        docs: null,
        raw: '{"__kind":"Module","value":{"index":250,"error":"0x07000000"}}',
      })
    } finally {
      await localApp.close()
    }
  })

  it('reads a bounded recent window, not the whole table', async () => {
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      await localApp.inject('/v1/extrinsics/' + PROBE_HASH)
      const lookup = local.seen.find(entry => entry.query.includes('FROM price_data.raw_extrinsics'))!
      // raw_extrinsics is ordered (block_height, extrinsic_index) and carries no
      // hash index, so the ONLY thing keeping this lookup off a 33M-row scan is a
      // partition-pruning time bound. If this assertion ever goes, the endpoint
      // has silently become a whole-table scan on a 10-second poll.
      expect(lookup.query).toContain('block_timestamp >=')
      expect(lookup.params.days).toBe(7)
    } finally {
      await localApp.close()
    }
  })

  it('honours an explicit window and rejects one past the cap', async () => {
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      await localApp.inject('/v1/extrinsics/' + HASH + '?withinDays=30')
      expect(local.seen[0].params.days).toBe(30)
      const tooDeep = await localApp.inject('/v1/extrinsics/' + HASH + '?withinDays=365')
      expect(tooDeep.statusCode).toBe(400)
      expect(tooDeep.json().error.code).toBe('bad_request')
    } finally {
      await localApp.close()
    }
  })

  it('404s an unknown hash with the envelope, naming the window it searched', async () => {
    const res = await app.inject('/v1/extrinsics/' + MISSING_HASH)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
    expect(res.json().error.message).toContain('7')
  })

  it('400s anything that is not a 32-byte hash', async () => {
    for (const bad of ['0xdeadbeef', 'notahash', '13585924']) {
      const res = await app.inject('/v1/extrinsics/' + bad)
      expect(res.statusCode, bad).toBe(400)
      expect(res.json().error.code, bad).toBe('bad_request')
    }
  })

  it('points a bare block height at the route that does address an extrinsic', async () => {
    // The likeliest mistake on this route pair: a height is one path segment, so
    // it lands on the hash route. Telling the caller only what a hash looks like
    // leaves them stuck, because no hash-shaped value answers their question.
    const res = await app.inject('/v1/extrinsics/13585924')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toContain('/v1/extrinsics/13585924/{index}')
    // A value that is not a height keeps the plain shape message — the pointer is
    // only offered where it is actually the right advice.
    expect((await app.inject('/v1/extrinsics/notahash')).json().error.message).not.toContain('{index}')
  })

  it('publishes the route-shape rule in the OpenAPI description', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const description = doc.paths['/v1/extrinsics/{hash}'].get.description as string
    expect(description).toContain('/v1/extrinsics/{blockHeight}/{index}')
    expect(description).toMatch(/one segment|ONE segment/i)
    // The pattern still reaches the document, so the hash shape stays machine-readable.
    const param = doc.paths['/v1/extrinsics/{hash}'].get.parameters.find((p: { name: string }) => p.name === 'hash')
    expect(param.schema.pattern).toBe('^0x[0-9a-f]{64}$')
  })

  it('is not memoised in-process, so it cannot churn the shared cache', async () => {
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      // Every hash is a distinct key, so a memo here would evict entries other
      // endpoints reuse while never being hit itself (a toast polls every 10 s
      // against a 3 s TTL). The nginx micro-cache collapses the repeat instead.
      await localApp.inject('/v1/extrinsics/' + HASH)
      await localApp.inject('/v1/extrinsics/' + HASH)
      const lookups = local.seen.filter(entry => entry.query.includes('pub:extrinsic:by-hash'))
      expect(lookups).toHaveLength(2)
    } finally {
      await localApp.close()
    }
  })

  it('is not cached beyond a toast poll interval', async () => {
    const res = await app.inject('/v1/extrinsics/' + HASH)
    expect(res.headers['cache-control']).toBe('public, max-age=10')
  })
})

describe('GET /v1/extrinsics/:blockHeight/:index', () => {
  it('returns the same object the hash route returns', async () => {
    const byHash = (await app.inject('/v1/extrinsics/' + HASH)).json()
    const byIndex = await app.inject('/v1/extrinsics/13585924/2')
    expect(byIndex.statusCode).toBe(200)
    expect(byIndex.json()).toEqual(byHash)
  })

  it('does not collide with the hash route', async () => {
    // Distinct path shapes (one segment vs two), so fastify routes them without
    // any format sniffing: a hash never reaches the height route and vice versa.
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      await localApp.inject('/v1/extrinsics/13585870/4')
      const lookup = local.seen[0]
      expect(lookup.params).toMatchObject({ blockHeight: 13585870, index: 4 })
      // No time bound here: (block_height, extrinsic_index) IS the primary key.
      expect(lookup.query).not.toContain('block_timestamp >=')
    } finally {
      await localApp.close()
    }
  })

  it('404s an unknown position and 400s a non-numeric one', async () => {
    expect((await app.inject('/v1/extrinsics/13585924/99')).statusCode).toBe(404)
    expect((await app.inject('/v1/extrinsics/13585924/abc')).statusCode).toBe(400)
    expect((await app.inject('/v1/extrinsics/-1/0')).statusCode).toBe(400)
  })

  it('rejects a position past UInt32 instead of letting ClickHouse wrap it', async () => {
    // Both are bound as UInt32, which wraps MOD 2^32 in silence: 4294967300 binds
    // as 4, so an overflowing height would answer for a different extrinsic.
    expect((await app.inject('/v1/extrinsics/4294967300/0')).statusCode).toBe(400)
    expect((await app.inject('/v1/extrinsics/13585924/4294967296')).statusCode).toBe(400)
    // The largest legal values are still routed (404 here — no such extrinsic).
    expect((await app.inject('/v1/extrinsics/4294967295/4294967295')).statusCode).toBe(404)
  })
})

describe('GET /v1/otc/orders/:orderId', () => {
  it('reports the folded order state', async () => {
    const res = await app.inject('/v1/otc/orders/1504')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      orderId: 1504,
      owner: null,
      assetIn: '5',
      assetOut: '23',
      amountIn: '1622950819672',
      amountOut: '99000000',
      partiallyFillable: true,
      status: 'cancelled',
      filledAmountIn: '11107171652',
      filledAmountOut: '677537',
      events: [
        { type: 'placed', blockHeight: 12769842, eventIndex: 146, timestamp: '2026-06-16T06:35:42.000Z', amountIn: '1622950819672', amountOut: '99000000', filler: null },
        { type: 'partiallyFilled', blockHeight: 12894605, eventIndex: 62, timestamp: '2026-06-26T06:49:48.000Z', amountIn: '10107171652', amountOut: '616537', filler: FILLER },
        { type: 'partiallyFilled', blockHeight: 12935821, eventIndex: 14, timestamp: '2026-06-29T10:24:39.000Z', amountIn: '1000000000', amountOut: '61000', filler: FILLER },
        { type: 'cancelled', blockHeight: 13000000, eventIndex: 3, timestamp: '2026-07-02T00:00:00.000Z', amountIn: null, amountOut: null, filler: null },
      ],
    })
  })

  it('404s an order with no Placed event', async () => {
    const res = await app.inject('/v1/otc/orders/999999')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('400s a non-numeric order id', async () => {
    expect((await app.inject('/v1/otc/orders/abc')).statusCode).toBe(400)
  })

  it('declares its own short freshness', async () => {
    const res = await app.inject('/v1/otc/orders/1504')
    expect(res.headers['cache-control']).toBe('public, max-age=5')
  })
})

describe('GET /v1/staking/events', () => {
  it('returns both streams oldest first, typed and deduplicated', async () => {
    const res = await app.inject('/v1/staking/events')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.totalCount).toBe(3)
    expect(body.items).toEqual([
      { type: 'StakingInitialized', blockHeight: 3398400, eventIndex: 69, timestamp: '2024-01-01T00:00:00.000Z', accumulatedRps: null, totalStake: null, nonDustableBalance: '1000000000000000' },
      { type: 'AccumulatedRpsUpdated', blockHeight: 3398426, eventIndex: 6, timestamp: '2024-01-01T00:05:00.000Z', accumulatedRps: '119305674157435', totalStake: '1382000000000000000', nonDustableBalance: null },
      { type: 'AccumulatedRpsUpdated', blockHeight: 3398476, eventIndex: 6, timestamp: '2024-01-01T00:10:00.000Z', accumulatedRps: '125566079168634', totalStake: '4475000000000000000', nonDustableBalance: null },
    ])
  })

  it('filters by type', async () => {
    const res = await app.inject('/v1/staking/events?types=StakingInitialized')
    expect(res.json().items.map((row: { type: string }) => row.type)).toEqual(['StakingInitialized'])
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      await localApp.inject('/v1/staking/events?types=AccumulatedRpsUpdated')
      expect(local.seen[0].params.names).toEqual(['Staking.AccumulatedRpsUpdated'])
    } finally {
      await localApp.close()
    }
  })

  it('rejects an unknown type instead of silently returning everything', async () => {
    const res = await app.inject('/v1/staking/events?types=Staking.Rewarded')
    expect(res.statusCode).toBe(400)
  })

  it('bounds the read by fromBlock/toBlock', async () => {
    const res = await app.inject('/v1/staking/events?fromBlock=3398426&toBlock=3398450')
    expect(res.json().items.map((row: { blockHeight: number }) => row.blockHeight)).toEqual([3398426])
    expect(res.json().totalCount).toBe(1)
  })

  it('caps limit and offset rather than accepting an unbounded page', async () => {
    expect((await app.inject('/v1/staking/events?limit=201')).statusCode).toBe(400)
    expect((await app.inject('/v1/staking/events?offset=1001')).statusCode).toBe(400)
    expect((await app.inject('/v1/staking/events?fromBlock=-1')).statusCode).toBe(400)
    expect((await app.inject('/v1/staking/events?fromBlock=100&toBlock=50')).statusCode).toBe(400)
    // Both cursors are bound as UInt32, which wraps MOD 2^32 in silence.
    expect((await app.inject('/v1/staking/events?fromBlock=4294967296')).statusCode).toBe(400)
    expect((await app.inject('/v1/staking/events?toBlock=4294967300')).statusCode).toBe(400)
  })

  it('keeps the LIMIT able to stop the read', async () => {
    const local = fakeClient()
    const localApp = await freshApp(local)
    try {
      await localApp.inject('/v1/staking/events?limit=7&offset=3')
      const page = local.seen.find(entry => !entry.query.includes('uniqExact'))!
      // These events are ~1 per 1,200 blocks, so read-in-order buffering pre-reads
      // far past a complete page: measured on the live table, the default first
      // page went from 9.5M rows / 199 MiB to 136M rows / 850 MiB with buffering
      // on. Dropping this setting silently costs the endpoint 4x its budget.
      expect(page.query).toContain('read_in_order_use_buffering = 0')
      // The over-fetch window is limit + offset + slack, and the offset cap is
      // what bounds it — nothing may read past it.
      expect(page.params.bound).toBe(7 + 3 + 100)
    } finally {
      await localApp.close()
    }
  })

  it('pages deterministically over the ascending ordering', async () => {
    const first = await app.inject('/v1/staking/events?limit=2&offset=0')
    const second = await app.inject('/v1/staking/events?limit=2&offset=2')
    expect(first.json().items).toHaveLength(2)
    expect(second.json().items).toHaveLength(1)
    expect(first.json().items[0].blockHeight).toBe(3398400)
    expect(second.json().items[0].blockHeight).toBe(3398476)
    expect(first.json().totalCount).toBe(3)
  })

  it('declares a minute of freshness', async () => {
    const res = await app.inject('/v1/staking/events')
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })
})
