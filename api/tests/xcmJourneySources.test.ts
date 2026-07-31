import { afterEach, describe, expect, it, vi } from 'vitest'

// Request paths read only the bounded in-memory map and persisted resolutions.
// Ocelloids misses trigger one bounded background walk whose results are
// persisted for later requests.
//
// Each test does a fresh dynamic import after vi.resetModules() so the
// module's internal maps/timers start empty (they're closed-over singletons,
// not reset between tests otherwise).

const ORIGIN_URN = 'urn:ocn:polkadot:1000'
const DEST_URN = 'urn:ocn:polkadot:2034'
const MSG_A = '0x' + '1'.repeat(64)
const MSG_B = '0x' + '2'.repeat(64)
const MSG_PERSISTED = '0x' + '3'.repeat(64)
const FROM_1 = '0x' + 'a'.repeat(64)
const FROM_2 = '0x' + 'b'.repeat(64)
const FROM_PERSISTED = '0x' + 'c'.repeat(64)

type InsertArgs = { table: string; values: { message_id: string; from_hex: string; origin_urn: string }[] }
type QueryArgs = { query: string; query_params: { ids: string[] } }

function fakeClient(overrides: { query?: ReturnType<typeof makeQueryMock>; insert?: ReturnType<typeof makeInsertMock> } = {}) {
  return {
    insert: overrides.insert ?? makeInsertMock(),
    query: overrides.query ?? makeQueryMock(async () => []),
  }
}

function makeInsertMock() {
  return vi.fn(async (_args: InsertArgs) => ({}))
}

function makeQueryMock(handler: (args: QueryArgs) => Promise<unknown[]>) {
  return vi.fn(async (args: QueryArgs) => ({ json: async () => handler(args) }))
}

// The sweep probes both feeds with a one-item request to measure whether the one it
// walks has fallen behind (see reportFeedLag). Those probes are requests too, so
// counting raw fetch calls no longer measures walking. These split the two: a walk
// asks for a page, a probe asks for a single item.
const isProbe = (init: { body: string }) =>
  (JSON.parse(init.body) as { pagination?: { limit?: number } }).pagination?.limit === 1
const walkCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.filter(call => !isProbe(call[1] as { body: string }))

// A fetch mock that answers probes itself and hands every WALK request to `handler`,
// so a test can gate or vary the walk without having to model the probes.
function makeFetchMock(handler: (init: { body: string }) => unknown, probeNewestMs = Date.now()) {
  return vi.fn((_url: string, init: { body: string }) => {
    if (isProbe(init)) {
      const item = { correlationId: 'probe', origin: 'urn:ocn:polkadot:1000', destination: DEST_URN, sentAt: probeNewestMs, recvAt: probeNewestMs }
      return Promise.resolve({ ok: true, json: async () => ({ items: [item], pageInfo: { hasNextPage: false } }) })
    }
    return handler(init)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('xcmJourneySourcesFor', () => {
  it('returns before a deduplicated background walk completes, then serves and persists its result', async () => {
    const body = {
      items: [
        {
          correlationId: 'corr-1',
          from: FROM_1,
          to: '',
          origin: ORIGIN_URN,
          destination: DEST_URN,
          originTxPrimary: null,
          sentAt: Date.now() - 2000,
          recvAt: Date.now() - 1000,
          stops: [{ instructions: [{ messageId: MSG_A }] }],
        },
        // Same message id as above (re-notified/duplicate) plus a second,
        // distinct one — exercises within-batch de-dup (last write wins).
        {
          correlationId: 'corr-2',
          from: FROM_2,
          to: '',
          origin: ORIGIN_URN,
          destination: DEST_URN,
          originTxPrimary: null,
          sentAt: Date.now() - 500,
          recvAt: Date.now(),
          stops: [{ instructions: [{ messageId: MSG_A }, { messageId: MSG_B }] }],
        },
      ],
      pageInfo: { hasNextPage: false },
    }
    let releaseFetch!: (response: { ok: boolean; json: () => Promise<typeof body> }) => void
    const fetchMock = makeFetchMock(() => new Promise(resolve => { releaseFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')

    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    const insert = makeInsertMock()
    const query = makeQueryMock(async () => [])
    initXcmJourneyService(fakeClient({ insert, query }) as never)

    const keys = [
      { messageId: MSG_A, timestampMs: Date.now() },
      { messageId: MSG_B, timestampMs: Date.now() },
    ]
    const result = await xcmJourneySourcesFor(keys)

    // The external request remains unresolved, but the explorer lookup has
    // already returned after its single ClickHouse miss.
    expect(result.size).toBe(0)
    await vi.waitFor(() => expect(walkCalls(fetchMock)).toHaveLength(1))

    // A concurrent miss shares the same background walk.
    expect((await xcmJourneySourcesFor(keys)).size).toBe(0)
    expect(walkCalls(fetchMock)).toHaveLength(1)

    releaseFetch({ ok: true, json: async () => body })
    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1))

    const cached = await xcmJourneySourcesFor(keys)

    // MSG_A was mapped by both items; the later one (corr-2, FROM_2) wins.
    expect(cached.get(MSG_A)).toMatchObject({ from: FROM_2, origin: ORIGIN_URN, correlationId: 'corr-2' })
    expect(cached.get(MSG_B)).toMatchObject({ from: FROM_2, origin: ORIGIN_URN, correlationId: 'corr-2' })

    // Each unresolved lookup reads twice — the persisted resolutions, then the miss
    // ledger that decides whether this id is due another walk — so the two misses
    // above account for four. The cached read that follows needs neither.
    expect(query).toHaveBeenCalledTimes(4)

    const call = insert.mock.calls[0][0]
    expect(call.table).toBe('price_data.xcm_journey_sources')
    expect(call.values).toHaveLength(2)
    expect(call.values.find(v => v.message_id === MSG_A)).toMatchObject({ message_id: MSG_A, from_hex: FROM_2, origin_urn: ORIGIN_URN, origin_tx: '', origin_protocol: '' })
    expect(call.values.find(v => v.message_id === MSG_B)).toMatchObject({ message_id: MSG_B, from_hex: FROM_2, origin_urn: ORIGIN_URN, origin_tx: '', origin_protocol: '' })
  })

  it('falls back to the persisted ClickHouse table when the live walk has nothing for the message id', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    const query = makeQueryMock(async ({ query_params }) => (query_params.ids.includes(MSG_PERSISTED)
      ? [{ message_id: MSG_PERSISTED, from_hex: FROM_PERSISTED, origin_urn: ORIGIN_URN }]
      : []))
    initXcmJourneyService(fakeClient({ query }) as never)

    const result = await xcmJourneySourcesFor([{ messageId: MSG_PERSISTED, timestampMs: Date.now() }])

    expect(result.get(MSG_PERSISTED)).toEqual({
      from: FROM_PERSISTED,
      to: '',
      fromFormatted: '',
      toFormatted: '',
      origin: ORIGIN_URN,
      destination: '',
      originTx: null,
      destTx: null,
      correlationId: '',
      originProtocol: '',
      destProtocol: '',
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    const [{ query: sql, query_params }] = query.mock.calls[0]
    expect(sql).toContain('price_data.xcm_journey_sources')
    expect(query_params.ids).toEqual([MSG_PERSISTED])
  })

  it('returns an empty map (no throw) when nothing resolves either path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [], pageInfo: { hasNextPage: false } }) })))
    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)

    const result = await xcmJourneySourcesFor([{ messageId: '0x' + '9'.repeat(64), timestampMs: Date.now() }])
    expect(result.size).toBe(0)
  })
})

describe('stop-level message ids (hrmp journey shape)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  // Real Ocelloids hrmp journeys carry the topic directly on the stop
  // (messageId/messageHash), not under instructions[] — the collector must
  // handle both shapes or inbound sources silently never resolve.
  it('indexes journeys whose stops carry messageId directly', async () => {
    const body = {
      items: [{
        correlationId: 'corr-hrmp',
        from: '0x' + 'ab'.repeat(32),
        to: '',
        origin: 'urn:ocn:polkadot:2006',
        destination: 'urn:ocn:polkadot:2034',
        originTxPrimary: '0x' + 'cd'.repeat(32),
        sentAt: Date.now() - 500,
        recvAt: Date.now(),
        stops: [{ type: 'hrmp', messageHash: '0x' + '11'.repeat(32), messageId: '0x' + '11'.repeat(32) }],
      }],
      pageInfo: { hasNextPage: false },
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')
    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService({ insert: vi.fn(async () => {}), query: vi.fn(async () => ({ json: async () => [] })) } as never)
    const key = { messageId: '0x' + '11'.repeat(32), timestampMs: Date.now() }
    expect((await xcmJourneySourcesFor([key])).size).toBe(0)
    await vi.waitFor(async () => {
      const result = await xcmJourneySourcesFor([key])
      expect(result.get(key.messageId)).toMatchObject({
      from: '0x' + 'ab'.repeat(32),
      origin: 'urn:ocn:polkadot:2006',
      originTx: '0x' + 'cd'.repeat(32),
      })
    })
  })
})

describe('in-flight journeys do not truncate the walk', () => {
  // A journey whose destination leg has not been observed reports recvAt: 0, not
  // null. `??` keeps a zero, so reading `recvAt ?? sentAt` made the page walk
  // believe it had reached 1970 and stop after its first page — and pinned the
  // module's "oldest covered" marker at 0 for the life of the process, after which
  // no refresh ever walks back again. A sixth of a live page is in that state.
  it('keeps paging when a page holds an unreceived journey', async () => {
    const now = Date.now()
    const page1 = {
      items: [{
        correlationId: 'corr-waiting',
        from: FROM_1,
        to: '',
        origin: 'urn:ocn:ethereum:1',
        destination: DEST_URN,
        originTxPrimary: '0x' + 'ef'.repeat(32),
        sentAt: now - 60_000,
        recvAt: 0,                       // still in flight — the whole point
        stops: [{ type: 'bridge', instructions: [{ messageId: MSG_A }] }],
      }],
      pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
    }
    const page2 = {
      items: [{
        correlationId: 'corr-old',
        from: FROM_2,
        to: '',
        origin: ORIGIN_URN,
        destination: DEST_URN,
        originTxPrimary: null,
        sentAt: now - 4 * 3_600_000,
        recvAt: now - 4 * 3_600_000,     // reaches past what the caller needs
        stops: [{ type: 'hrmp', messageId: MSG_B }],
      }],
      pageInfo: { hasNextPage: false },
    }
    const cursors: (string | undefined)[] = []
    const fetchMock = makeFetchMock(async (init: { body: string }) => {
      const body = JSON.parse(init.body) as { pagination?: { cursor?: string } }
      cursors.push(body.pagination?.cursor)
      return { ok: true, json: async () => (body.pagination?.cursor === 'cursor-2' ? page2 : page1) }
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')

    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)

    // Asking for a message three hours back: page 1 only reaches a minute back, so
    // the walk has to follow the cursor to cover it.
    const key = { messageId: MSG_A, timestampMs: now - 3 * 3_600_000 }
    expect((await xcmJourneySourcesFor([key])).size).toBe(0)

    await vi.waitFor(() => expect(cursors).toEqual([undefined, 'cursor-2']))
    await vi.waitFor(async () => {
      expect((await xcmJourneySourcesFor([key])).get(MSG_A)).toMatchObject({ origin: 'urn:ocn:ethereum:1' })
    })
  })
})

describe('misses back off instead of re-walking', () => {
  // A bridged journey reaches the index only after it lands here (~20 min for
  // Snowbridge), so the first look legitimately finds nothing. Without a persisted
  // marker that miss was re-walked on every single request, which both wasted the
  // whole background budget on one id and never gave the journey time to appear.
  const missRow = (attempts: number, lastAttemptS: number) =>
    [{ message_id: MSG_A, attempts: String(attempts), last_attempt_s: String(lastAttemptS), first_seen_ms: '1' }]

  const runWith = async (rows: unknown[]) => {
    const fetchMock = makeFetchMock(async () => ({ ok: true, json: async () => ({ items: [], pageInfo: { hasNextPage: false } }) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')
    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    // The sources lookup finds nothing; the miss ledger returns `rows`.
    const query = makeQueryMock(async ({ query: sql }) => (sql.includes('xcm_journey_misses') ? rows : []))
    initXcmJourneyService(fakeClient({ query }) as never)
    await xcmJourneySourcesFor([{ messageId: MSG_A, timestampMs: Date.now(), bridge: true }])
    await new Promise(r => setTimeout(r, 150))
    return fetchMock
  }

  it('skips a walk for an id looked for moments ago', async () => {
    const fetchMock = await runWith(missRow(1, Math.floor(Date.now() / 1000)))
    expect(walkCalls(fetchMock)).toHaveLength(0)
  })

  it('walks again once the backoff for that attempt has elapsed', async () => {
    const fetchMock = await runWith(missRow(1, Math.floor(Date.now() / 1000) - 3600))
    expect(walkCalls(fetchMock).length).toBeGreaterThan(0)
  })

  // Past the last step the id is left alone rather than retried forever: some
  // journeys genuinely never appear, and they must not consume the budget for good.
  it('gives up after the schedule runs out', async () => {
    const fetchMock = await runWith(missRow(99, 0))
    expect(walkCalls(fetchMock)).toHaveLength(0)
  })

  it('always walks an id it has never looked for', async () => {
    const fetchMock = await runWith([])
    expect(walkCalls(fetchMock).length).toBeGreaterThan(0)
  })
})

describe('outbound journeys resolve by topic id', () => {
  // Outbound reports `from` as the origin CHAIN's urn, not an account, and roughly
  // half of outbound BRIDGE journeys carry no origin extrinsic hash at all — while
  // every one of them carries a topic id. Keying outbound by hash could therefore
  // never reach a Wormhole destination; keying by topic reaches all of them, and the
  // topic is also what the persisted table stores, so it survives a restart.
  it('indexes a journey with no source account, and keeps both of its ends', async () => {
    const now = Date.now()
    const journey = {
      correlationId: 'corr-out-wh',
      from: 'urn:ocn:polkadot:2034',          // a chain urn, not an account
      to: '0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65',
      fromFormatted: null,
      toFormatted: '6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24',
      origin: 'urn:ocn:polkadot:2034',
      destination: 'urn:ocn:solana:101',
      originProtocol: 'xcm',
      destinationProtocol: 'wh_portal',
      originTxPrimary: null,                   // the key the old design needed
      destinationTxPrimary: null,
      sentAt: now - 2000, recvAt: now - 1000,
      stops: [{ type: 'hrmp', instructions: [{ messageId: MSG_A }] }],
    }
    const insert = makeInsertMock()
    vi.stubGlobal('fetch', makeFetchMock(async () => ({ ok: true, json: async () => ({ items: [journey], pageInfo: { hasNextPage: false } }) })))
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')
    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient({ insert }) as never)

    await xcmJourneySourcesFor([{ messageId: MSG_A, timestampMs: now }])
    await vi.waitFor(async () => {
      const got = await xcmJourneySourcesFor([{ messageId: MSG_A, timestampMs: now }])
      expect(got.get(MSG_A)).toMatchObject({
        destination: 'urn:ocn:solana:101',
        toFormatted: '6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24',
        destProtocol: 'wh_portal',
      })
    })

    // And the persisted row carries the destination, so the next process can serve it
    // without walking anything.
    const row = (insert.mock.calls.at(-1)![0] as { values: Record<string, string>[] }).values
      .find(v => v.message_id === MSG_A)
    expect(row).toMatchObject({
      dest_urn: 'urn:ocn:solana:101',
      to_formatted: '6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24',
      dest_protocol: 'wh_portal',
      from_hex: '',
    })
  })
})

describe('bridgeLabel', () => {
  it('names the bridges the crosschain index distinguishes', async () => {
    const { bridgeLabel } = await import('../src/services/xcmJourneyService.ts')
    expect(bridgeLabel('snowbridge')).toBe('Snowbridge')
    expect(bridgeLabel('wh_portal')).toBe('Wormhole')
    expect(bridgeLabel('basejump')).toBe('Basejump')
    expect(bridgeLabel('hyperbridge')).toBe('Hyperbridge')
    // Wormhole reaches Hydration as the Portal token bridge (via Moonbeam — the old
    // MRL route) and as Native Token Transfers, which burns and mints directly. A
    // reader knows both as Wormhole; only the route differs.
    expect(bridgeLabel('wh_ntt')).toBe('Wormhole')
    expect(bridgeLabel('xcm', 'wh_ntt')).toBe('Wormhole')
  })

  // A journey that only ever spoke XCM is not "bridged", and neither end being a
  // bridge means no label at all.
  it('leaves a plain XCM journey unlabelled', async () => {
    const { bridgeLabel } = await import('../src/services/xcmJourneyService.ts')
    expect(bridgeLabel('xcm')).toBeNull()
    expect(bridgeLabel('xcm', 'xcm')).toBeNull()
    expect(bridgeLabel('')).toBeNull()
  })

  // Outbound journeys carry the bridge on the DESTINATION side (xcm -> snowbridge),
  // so whichever end names a bridge is the one that answers.
  it('reads the bridge from whichever end has one', async () => {
    const { bridgeLabel } = await import('../src/services/xcmJourneyService.ts')
    expect(bridgeLabel('xcm', 'snowbridge')).toBe('Snowbridge')
    expect(bridgeLabel('snowbridge', 'xcm')).toBe('Snowbridge')
  })

  // Snowbridge v1 and v2 differ in the hops they take, not in this field, so a new
  // upstream protocol should surface under its own name rather than vanish into
  // "plain hop" — that is what makes an unrecognised bridge visible at all.
  it('passes an unknown protocol through instead of dropping it', async () => {
    const { bridgeLabel } = await import('../src/services/xcmJourneyService.ts')
    expect(bridgeLabel('some_new_bridge')).toBe('some_new_bridge')
  })
})

describe('feed staleness is reported', () => {
  // The filter is the only usable source, so when it falls behind there is nothing to
  // switch to — walking the unfiltered feed instead sounds appealing and does not
  // work: only ~1 journey per 100 at its head touches Hydration, and one page spans
  // most of a day, so a time-coverage walk finishes having learned nothing. What this
  // can do is refuse to fail silently, since a stale filtered page looks exactly like
  // a healthy one.
  it('warns when the networks filter falls behind the unfiltered feed', async () => {
    const now = Date.now()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { args: { criteria: Record<string, unknown> }; pagination: { limit: number } }
      const filtered = Array.isArray(body.args.criteria.networks)
      const sentAt = filtered ? now - 14 * 3_600_000 : now - 60_000
      const item = {
        correlationId: 'c1', from: FROM_1, to: '', origin: ORIGIN_URN, destination: DEST_URN,
        originProtocol: 'xcm', originTxPrimary: null, sentAt, recvAt: sentAt,
        stops: [{ instructions: [{ messageId: MSG_A }] }],
      }
      return { ok: true, json: async () => ({ items: [item], pageInfo: { hasNextPage: false } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')

    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)
    await xcmJourneySourcesFor([{ messageId: MSG_B, timestampMs: now - 30 * 60_000, bridge: true }])

    await vi.waitFor(() => {
      expect(warn.mock.calls.flat().join(' ')).toMatch(/networks filter is \d+ min behind/)
    })
    warn.mockRestore()
  })

  // The walk itself only ever reads the filtered feed — the unfiltered one is probed
  // for comparison, never paged.
  it('never pages the unfiltered feed', async () => {
    const now = Date.now()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { args: { criteria: Record<string, unknown> }; pagination: { limit: number } }
      const item = {
        correlationId: 'c1', from: FROM_1, to: '', origin: ORIGIN_URN, destination: DEST_URN,
        originProtocol: 'xcm', originTxPrimary: null, sentAt: now - 1000, recvAt: now,
        stops: [{ instructions: [{ messageId: MSG_A }] }],
      }
      void body
      return { ok: true, json: async () => ({ items: [item], pageInfo: { hasNextPage: false } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')
    const { initXcmJourneyService, xcmJourneySourcesFor } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)
    await xcmJourneySourcesFor([{ messageId: MSG_A, timestampMs: now, bridge: false }])
    await new Promise(r => setTimeout(r, 150))

    for (const call of walkCalls(fetchMock)) {
      const body = JSON.parse((call[1] as { body: string }).body) as { args: { criteria: Record<string, unknown> } }
      expect(Array.isArray(body.args.criteria.networks)).toBe(true)
    }
  })
})

describe('xcmJourneysByOriginTx', () => {
  it('serves the cache immediately and refreshes outbound journeys in the background', async () => {
    const txHash = '0x' + 'd'.repeat(64)
    const body = {
      items: [{
        correlationId: 'corr-out',
        from: FROM_1,
        to: FROM_2,
        origin: 'urn:ocn:polkadot:2034',
        destination: 'urn:ocn:polkadot:2004',
        originTxPrimary: txHash,
        sentAt: Date.now(),
        stops: [],
      }],
      pageInfo: { hasNextPage: false },
    }
    let releaseFetch!: (response: { ok: boolean; json: () => Promise<typeof body> }) => void
    const fetchMock = makeFetchMock(() => new Promise(resolve => { releaseFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')

    const { initXcmJourneyService, xcmJourneysByOriginTx } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)
    const key = { txHash, timestampMs: Date.now() }

    expect((await xcmJourneysByOriginTx([key])).size).toBe(0)
    await vi.waitFor(() => expect(walkCalls(fetchMock)).toHaveLength(1))
    expect((await xcmJourneysByOriginTx([key])).size).toBe(0)
    expect(walkCalls(fetchMock)).toHaveLength(1)

    releaseFetch({ ok: true, json: async () => body })
    await vi.waitFor(async () => {
      expect((await xcmJourneysByOriginTx([key])).get(txHash)?.[0]).toMatchObject({
        correlationId: 'corr-out',
        destination: 'urn:ocn:polkadot:2004',
      })
    })
  })
})

describe('historical journey resolution helpers', () => {
  it('crafts the keyset cursor the Ocelloids list API uses (base64 "<ms>|<id>")', async () => {
    const { historicalCursorAt } = await import('../src/services/xcmJourneyService.ts')
    const cursor = historicalCursorAt(1_755_426_200_000)
    expect(Buffer.from(cursor, 'base64').toString()).toBe('1755426200000|999999999')
  })

  it('builds explorer deep links for origin transactions per consensus system', async () => {
    const { originTxExplorerUrl } = await import('../src/services/explorerService.ts')
    expect(originTxExplorerUrl('urn:ocn:polkadot:2006', '0xf1a9da7aebf2afa410577bcb4226d0c13e73a0569a2d5cc90ebf709ea98c9b8e'))
      .toBe('https://astar.subscan.io/extrinsic/0xf1a9da7aebf2afa410577bcb4226d0c13e73a0569a2d5cc90ebf709ea98c9b8e')
    expect(originTxExplorerUrl('urn:ocn:polkadot:0', '0xabc1')).toBe('https://polkadot.subscan.io/extrinsic/0xabc1')
    expect(originTxExplorerUrl('urn:ocn:ethereum:1', '0xabc1')).toBe('https://etherscan.io/tx/0xabc1')
    expect(originTxExplorerUrl('urn:ocn:solana:0', '0xabc1')).toBe('https://solscan.io/tx/0xabc1')
    expect(originTxExplorerUrl('urn:ocn:polkadot:2006', null)).toBeNull()
    expect(originTxExplorerUrl('not-a-urn', '0xabc1')).toBeNull()
    expect(originTxExplorerUrl('urn:ocn:polkadot:2006', 'garbage')).toBeNull()
  })
})
