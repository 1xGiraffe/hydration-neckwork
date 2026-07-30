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
    const fetchMock = vi.fn(() => new Promise(resolve => { releaseFetch = resolve }))
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
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // A concurrent miss shares the same background walk.
    expect((await xcmJourneySourcesFor(keys)).size).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    releaseFetch({ ok: true, json: async () => body })
    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1))

    const cached = await xcmJourneySourcesFor(keys)

    // MSG_A was mapped by both items; the later one (corr-2, FROM_2) wins.
    expect(cached.get(MSG_A)).toMatchObject({ from: FROM_2, origin: ORIGIN_URN, correlationId: 'corr-2' })
    expect(cached.get(MSG_B)).toMatchObject({ from: FROM_2, origin: ORIGIN_URN, correlationId: 'corr-2' })

    // Both initial misses shared one persisted lookup; the cached read needs none.
    expect(query).toHaveBeenCalledTimes(2)

    const call = insert.mock.calls[0][0]
    expect(call.table).toBe('price_data.xcm_journey_sources')
    expect(call.values).toHaveLength(2)
    expect(call.values.find(v => v.message_id === MSG_A)).toEqual({ message_id: MSG_A, from_hex: FROM_2, origin_urn: ORIGIN_URN, origin_tx: '' })
    expect(call.values.find(v => v.message_id === MSG_B)).toEqual({ message_id: MSG_B, from_hex: FROM_2, origin_urn: ORIGIN_URN, origin_tx: '' })
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
      origin: ORIGIN_URN,
      destination: '',
      originTx: null,
      correlationId: '',
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
    const fetchMock = vi.fn(() => new Promise(resolve => { releaseFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('EXPLORER_OCELLOIDS_TOKEN', 'test-token')

    const { initXcmJourneyService, xcmJourneysByOriginTx } = await import('../src/services/xcmJourneyService.ts')
    initXcmJourneyService(fakeClient() as never)
    const key = { txHash, timestampMs: Date.now() }

    expect((await xcmJourneysByOriginTx([key])).size).toBe(0)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect((await xcmJourneysByOriginTx([key])).size).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

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
