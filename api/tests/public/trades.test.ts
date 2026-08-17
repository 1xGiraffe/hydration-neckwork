import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract tests for /v1/trades and /v1/trades/routed. Template:
// tests/public/accounts.test.ts — a fake ClickHouse client dispatching on SQL
// substrings, so no database is required. The row set the SQL selects (one row per
// user-level trade, never a router hop) is asserted on the generated SQL; the
// fixtures then pin the mapping, the swapper precedence and the DCA linkage.
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ROUTER_PALLET = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
const ACCOUNT_A = `0x${'11'.repeat(32)}`
const ACCOUNT_B = `0x${'22'.repeat(32)}`
const ACCOUNT_C = `0x${'33'.repeat(32)}`
const ACCOUNT_D = `0x${'44'.repeat(32)}`
// The runtime's unconditional AccountId32 -> H160 truncation form, which the resolver
// folds in for every 32-byte address (accountBalances.evmTruncationForm).
const ACCOUNT_A_TRUNCATED = `0x45544800${'11'.repeat(20)}${'00'.repeat(8)}`
const EVM_ACCOUNT = `0x${'aa'.repeat(20)}`
const EVM_ACCOUNT_ID = `0x45544800${'aa'.repeat(20)}${'00'.repeat(8)}`
const BOUND_ACCOUNT = `0x${'bb'.repeat(32)}`

// Global feed candidates, newest first — exactly what the net-row filter leaves.
const GLOBAL_ROWS: Row[] = [
  // A DCA execution: a hook-dispatched routed swap with no `who` at all.
  { block_height: 1000, event_index: 22, extrinsic_index: null, ts: '2026-06-24 02:00:00', event_name: 'Router.Executed', who: '', asset_in: 5, asset_out: 0, amount_in: '10000000000', amount_out: '500000000000' },
  // A signed routed swap: Broadcast.Swapped names the account whose funds moved.
  { block_height: 999, event_index: 7, extrinsic_index: 2, ts: '2026-06-24 01:00:00', event_name: 'Router.Executed', who: '', asset_in: 0, asset_out: 5, amount_in: '400000000000', amount_out: '8000000000' },
  // A direct pool call: the event carries its own `who` and its own direction.
  { block_height: 998, event_index: 3, extrinsic_index: 1, ts: '2026-06-24 00:30:00', event_name: 'Omnipool.BuyExecuted', who: ACCOUNT_A, asset_in: 5, asset_out: 0, amount_in: '1000000000', amount_out: '50000000000' },
  // A hook swap nothing can attribute: no Broadcast row, no DCA execution.
  { block_height: 997, event_index: 5, extrinsic_index: null, ts: '2026-06-24 00:00:00', event_name: 'Router.Executed', who: '', asset_in: 0, asset_out: 222, amount_in: '100000000000', amount_out: '2000000000000000000' },
]

// The account-scoped model stores the actor in `account` and the signatory in `signer`.
const ACCOUNT_ROWS: Row[] = [
  { account: ACCOUNT_A, block_height: 999, event_index: 7, extrinsic_index: 2, ts: '2026-06-24 01:00:00', event_name: 'Router.Executed', who: ACCOUNT_A, asset_in: 0, asset_out: 5, amount_in: '400000000000', amount_out: '8000000000' },
  { account: ACCOUNT_A, block_height: 998, event_index: 3, extrinsic_index: 1, ts: '2026-06-24 00:30:00', event_name: 'Omnipool.BuyExecuted', who: ACCOUNT_A, asset_in: 5, asset_out: 0, amount_in: '1000000000', amount_out: '50000000000' },
]

const DCA_EXEC_ROWS: Row[] = [
  { id: '42', block_height: 1000, event_index: 23, who: ACCOUNT_B, amount_in: '10000000000' },
]
const SWAP_ACTOR_ROWS: Row[] = [
  { block_height: 999, event_index: 7, swapper: ACCOUNT_C },
]
const EXTRINSIC_ROWS: Row[] = [
  { block_height: 999, extrinsic_index: 2, call_name: 'Router.sell', signer: ACCOUNT_D, effective_signer: '' },
  { block_height: 998, extrinsic_index: 1, call_name: 'Omnipool.buy', signer: ACCOUNT_A, effective_signer: '' },
]

interface Seen { query: string; params: Record<string, unknown> }

function assetsMatch(row: Row, assets: number[]): boolean {
  return !assets.length || assets.includes(Number(row.asset_in)) || assets.includes(Number(row.asset_out))
}

function fakeClient(overrides: { global?: Row[]; account?: Row[]; aliases?: Row[] } = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      const assets = ((params.assets as number[]) ?? []).map(Number)
      const page = (rows: Row[]) => {
        const matching = rows
          .filter(row => assetsMatch(row, assets))
          .filter(row => params.beforeBlock == null
            || Number(row.block_height) < Number(params.beforeBlock)
            || (Number(row.block_height) === Number(params.beforeBlock) && Number(row.event_index) < Number(params.beforeEvent)))
        if (query.includes('uniqExact')) {
          // The count is over the replacement key, so duplicates never inflate it.
          const keys = new Set(matching.map(row => `${row.block_height}:${row.event_index}`))
          return queryResult([{ total: String(keys.size) }])
        }
        // The global feed reads a bounded window and cuts the page itself (after
        // de-duplication); the account feed pages in SQL.
        if (params.bound != null) return queryResult(matching.slice(0, Number(params.bound)))
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 20)
        return queryResult(matching.slice(offset, offset + limit))
      }
      // Checked before swap_activity: the account model's name contains it.
      if (query.includes('FROM price_data.account_swap_activity')) {
        return page(overrides.account ?? ACCOUNT_ROWS)
      }
      if (query.includes('FROM price_data.asset_swap_activity')) return page(overrides.global ?? GLOBAL_ROWS)
      if (query.includes('FROM price_data.swap_activity')) return page(overrides.global ?? GLOBAL_ROWS)
      if (query.includes('FROM price_data.dca_events')) return queryResult(DCA_EXEC_ROWS)
      if (query.includes('FROM price_data.raw_events')) return queryResult(SWAP_ACTOR_ROWS)
      if (query.includes('FROM price_data.raw_extrinsics')) return queryResult(EXTRINSIC_ROWS)
      if (query.includes('FROM price_data.account_alias_directory')) {
        return queryResult(overrides.aliases ?? [{ evm_address: EVM_ACCOUNT, account_id: BOUND_ACCOUNT }])
      }
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

let app: FastifyInstance
let client: ReturnType<typeof fakeClient>

async function freshApp(probe: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: probe as never, logger: false })
}

beforeAll(async () => {
  client = fakeClient()
  app = await freshApp(client)
})

afterAll(async () => {
  await app?.close()
})

describe('GET /v1/trades', () => {
  it('returns one row per user-level trade, newest first, with the swapper resolved', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject('/v1/trades')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        items: [
          {
            blockHeight: 1000, eventIndex: 22, extrinsicIndex: null, timestamp: '2026-06-24T02:00:00.000Z',
            // The DCA execution names its owner; the router's net event carries no `who`.
            swapper: ACCOUNT_B, operationType: null,
            assetIn: '5', amountIn: '10000000000', assetOut: '0', amountOut: '500000000000',
            dca: { scheduleId: 42 },
          },
          {
            blockHeight: 999, eventIndex: 7, extrinsicIndex: 2, timestamp: '2026-06-24T01:00:00.000Z',
            // Broadcast.Swapped's swapper wins over the extrinsic's signatory: a swap
            // dispatched through a proxy belongs to the account whose funds moved.
            swapper: ACCOUNT_C, operationType: 'exactIn',
            assetIn: '0', amountIn: '400000000000', assetOut: '5', amountOut: '8000000000',
            dca: null,
          },
          {
            blockHeight: 998, eventIndex: 3, extrinsicIndex: 1, timestamp: '2026-06-24T00:30:00.000Z',
            swapper: ACCOUNT_A, operationType: 'exactOut',
            assetIn: '5', amountIn: '1000000000', assetOut: '0', amountOut: '50000000000',
            dca: null,
          },
          {
            blockHeight: 997, eventIndex: 5, extrinsicIndex: null, timestamp: '2026-06-24T00:00:00.000Z',
            // Unattributable rather than credited to the router pallet.
            swapper: null, operationType: null,
            assetIn: '0', amountIn: '100000000000', assetOut: '222', amountOut: '2000000000000000000',
            dca: null,
          },
        ],
        totalCount: 4,
      })
      expect(res.headers['cache-control']).toBe('public, max-age=3')
    } finally {
      await app2.close()
    }
  })

  it('selects net trades only: no router hop, no DCA fee leg, no legacy DCA hop', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      // A limit no other test uses: the in-process response cache is global, and a
      // shared key would answer this request without touching the client at all.
      await app2.inject('/v1/trades?limit=5')
      const swap = probe.seen.filter(s => s.query.includes('FROM price_data.swap_activity'))
      expect(swap.length).toBeGreaterThan(0)
      for (const call of swap) {
        // The per-hop AMM events of a routed swap are emitted with who=routerex.
        expect(call.query).toContain('who != {routerPallet:String}')
        expect(call.params.routerPallet).toBe(ROUTER_PALLET)
        // A DCA keeper-fee leg: unsigned, attributed to a real (non-pallet) account.
        expect(call.query).toContain("NOT (extrinsic_index IS NULL AND who != '' AND who NOT LIKE '0x6d6f646c%')")
        // Pre-rename DCA hops ran under the owner's own account.
        expect(call.query).toContain('block_height < {renameBlock:UInt32}')
        expect(call.params.renameBlock).toBe(4_542_080)
      }
      // The page read is a single bounded window in primary-key order: no LIMIT BY,
      // which measured 10.2 M rows read against 266 k for the bounded form, and no
      // OFFSET, because the page is cut after de-duplication in the service.
      const paged = swap.find(s => s.params.bound != null)!
      expect(paged.query).not.toContain('LIMIT 1 BY')
      expect(paged.query).not.toContain('OFFSET')
      expect(paged.query).toContain('ORDER BY block_height DESC, event_index DESC')
    } finally {
      await app2.close()
    }
  })

  it('scopes a swapper query to the account-first model and keeps only its net rows', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/trades?swapper=${ACCOUNT_A}`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((item: { blockHeight: number }) => item.blockHeight)).toEqual([999, 998])
      // Every row of the account's own feed belongs to the account asked about.
      for (const item of res.json().items) expect(item.swapper).toBe(ACCOUNT_A)
      const scoped = probe.seen.filter(s => s.query.includes('FROM price_data.account_swap_activity'))
      expect(scoped.length).toBeGreaterThan(0)
      for (const call of scoped) {
        // The account's own storage forms, and nothing else. The list also carries
        // the runtime's AccountId32 → H160 truncation ('ETH\0' + first 20 bytes),
        // because an account's EVM-side activity is filed under that form — see
        // accountBalances.evmTruncationForm. Measured on live data, no swap row
        // exists under the truncated form of a real AccountId32, so the extra key
        // widens the IN list without changing a single answer.
        // An exact set, not a `toContain`: the widened resolver makes "an unrelated
        // form leaked into the scoped IN list" a newly possible failure, and that is
        // exactly what a containment check cannot see.
        expect(new Set(call.params.accounts as string[])).toEqual(new Set([ACCOUNT_A, ACCOUNT_A_TRUNCATED]))
        // A routed trade's hops share their extrinsic with its net event; a direct
        // pool call has no net event, so its own row is the trade.
        expect(call.query).toContain('NOT IN net_extrinsics')
      }
      // ClickHouse clause order on the account page: LIMIT BY sits between ORDER BY
      // and LIMIT, so replay duplicates are removed before the page is cut. Written
      // the other way round the query is a syntax error, which no fake client can
      // see — it cost one live round trip to find.
      const paged = scoped.find(s => s.query.includes('LIMIT 1 BY'))!
      expect(paged.query.indexOf('ORDER BY')).toBeLessThan(paged.query.indexOf('LIMIT 1 BY'))
      expect(paged.query.indexOf('LIMIT 1 BY')).toBeLessThan(paged.query.indexOf('LIMIT {limit:UInt32}'))
      // The global table is never read on the scoped path.
      expect(probe.seen.some(s => /FROM price_data\.swap_activity/.test(s.query))).toBe(false)
    } finally {
      await app2.close()
    }
  })

  it('scopes a bound EVM identity to every form under which its trades can be stored', async () => {
    const probe = fakeClient({ aliases: [{ evm_address: EVM_ACCOUNT, account_id: BOUND_ACCOUNT }] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/trades?swapper=${EVM_ACCOUNT}&limit=9`)
      expect(res.statusCode).toBe(200)
      const scoped = probe.seen.filter(s => s.query.includes('FROM price_data.account_swap_activity'))
      expect(scoped.length).toBeGreaterThan(0)
      for (const call of scoped) {
        expect(new Set(call.params.accounts as string[])).toEqual(new Set([EVM_ACCOUNT, EVM_ACCOUNT_ID, BOUND_ACCOUNT]))
      }
    } finally {
      await app2.close()
    }
  })

  it('names the account by its stored form when asked about by an H160 half', async () => {
    // The rows of a bound EVM identity are filed under the 32-byte 'ETH\0' form, and
    // the scoped feed used to echo the REQUESTED address as `swapper` — which an
    // H160 request turned into null, because a 20-byte address is not an account id.
    // Reporting null there says "unknown actor" about rows the query was scoped to.
    const probe = fakeClient({
      account: ACCOUNT_ROWS.map(row => ({ ...row, account: EVM_ACCOUNT_ID })),
      aliases: [{ evm_address: EVM_ACCOUNT, account_id: BOUND_ACCOUNT }],
    })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/trades?swapper=${EVM_ACCOUNT}&limit=11`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items).toHaveLength(2)
      for (const item of res.json().items) expect(item.swapper).toBe(EVM_ACCOUNT_ID)
    } finally {
      await app2.close()
    }
  })

  it('pages a scoped feed past the global offset cap, which only bounds the global window', async () => {
    // The cap exists because the GLOBAL feed materialises its whole page window to
    // de-duplicate replays. The scoped feed pages in SQL inside one account's
    // primary-key prefix, so the same bound would hide most of a bot's history for
    // no reason (measured: 851,699 net trades on one account, 0.36 s at offset 100k).
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const scoped = await app2.inject(`/v1/trades?swapper=${ACCOUNT_A}&offset=10001&limit=5`)
      expect(scoped.statusCode).toBe(200)
      const routed = await app2.inject(`/v1/trades/routed?participant=${ACCOUNT_A}&offset=10001&limit=5`)
      expect(routed.statusCode).toBe(200)
      // The global feed still refuses to go deeper than its window.
      const global = await app2.inject('/v1/trades?offset=10001&limit=5')
      expect(global.statusCode).toBe(400)
      expect(global.json().error.message).toMatch(/10000/)
      // And the shared upper bound still applies to both.
      expect((await app2.inject(`/v1/trades?swapper=${ACCOUNT_A}&offset=1000001`)).statusCode).toBe(400)
    } finally {
      await app2.close()
    }
  })

  it('matches the assets filter on either side of the pair', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject('/v1/trades?assets=222')
      expect(res.statusCode).toBe(200)
      // Asset 222 is the OUT side of the oldest row and appears nowhere else.
      expect(res.json().items.map((item: { blockHeight: number }) => item.blockHeight)).toEqual([997])
      expect(res.json().totalCount).toBe(1)
      const swap = probe.seen.filter(s => s.query.includes('FROM price_data.asset_swap_activity'))
      for (const call of swap) {
        expect(call.query).toContain('asset_id IN {assets:Array(UInt32)}')
        expect(call.params.assets).toEqual([222])
      }
      expect(probe.seen.some(s => s.query.includes('FROM price_data.swap_activity'))).toBe(false)
    } finally {
      await app2.close()
    }
  })

  it('pages deterministically: consecutive pages neither overlap nor drop a row', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      const first = await app2.inject('/v1/trades?limit=2&offset=0')
      const second = await app2.inject('/v1/trades?limit=2&offset=2')
      const key = (item: { blockHeight: number; eventIndex: number }) => `${item.blockHeight}:${item.eventIndex}`
      const firstKeys = first.json().items.map(key)
      const secondKeys = second.json().items.map(key)
      expect(firstKeys).toEqual(['1000:22', '999:7'])
      expect(secondKeys).toEqual(['998:3', '997:5'])
      expect(firstKeys.filter((k: string) => secondKeys.includes(k))).toEqual([])
      // totalCount describes the filter, not the page.
      expect(first.json().totalCount).toBe(4)
      expect(second.json().totalCount).toBe(4)
    } finally {
      await app2.close()
    }
  })

  it('de-duplicates replay rows BEFORE cutting the page, so no page comes back short', async () => {
    // swap_activity is a ReplacingMergeTree and an unmerged replay duplicate lives at
    // the HEAD — the newest-first region this feed reads. Cutting the page first would
    // hand back 1 row instead of 2 and displace every later row, while the uniqExact
    // total kept reporting 4.
    const duplicated = [GLOBAL_ROWS[0], { ...GLOBAL_ROWS[0] }, GLOBAL_ROWS[1], { ...GLOBAL_ROWS[1] }, GLOBAL_ROWS[2], GLOBAL_ROWS[3]]
    const probe = fakeClient({ global: duplicated })
    const app2 = await freshApp(probe)
    try {
      const key = (item: { blockHeight: number; eventIndex: number }) => `${item.blockHeight}:${item.eventIndex}`
      const first = await app2.inject('/v1/trades?limit=2&offset=0&assets=0,5,222')
      const second = await app2.inject('/v1/trades?limit=2&offset=2&assets=0,5,222')
      expect(first.json().items.map(key)).toEqual(['1000:22', '999:7'])
      expect(second.json().items.map(key)).toEqual(['998:3', '997:5'])
      expect(first.json().totalCount).toBe(4)
    } finally {
      await app2.close()
    }
  })

  it('advances by event key when a replay run is larger than the over-fetch slack', async () => {
    const duplicated = [
      ...Array.from({ length: 250 }, () => ({ ...GLOBAL_ROWS[0] })),
      GLOBAL_ROWS[1],
      GLOBAL_ROWS[2],
      GLOBAL_ROWS[3],
    ]
    const probe = fakeClient({ global: duplicated })
    const app2 = await freshApp(probe)
    try {
      // This asset set is deliberately distinct from the preceding test's key:
      // the response cache is process-wide, while this probe must exercise SQL.
      const res = await app2.inject('/v1/trades?limit=2&assets=0,5&offset=0')
      const key = (item: { blockHeight: number; eventIndex: number }) => `${item.blockHeight}:${item.eventIndex}`
      expect(res.json().items.map(key)).toEqual(['1000:22', '999:7'])
      const pages = probe.seen.filter(s => s.query.includes('-- pub:trades:global-page'))
      expect(pages).toHaveLength(2)
      expect(pages[1].params).toMatchObject({ beforeBlock: 1000, beforeEvent: 22 })
    } finally {
      await app2.close()
    }
  })

  it('rejects an out-of-range limit or offset instead of serving page 1', async () => {
    expect((await app.inject('/v1/trades?limit=201')).statusCode).toBe(400)
    // The dedup window is materialised, so the offset bound is what bounds it.
    expect((await app.inject('/v1/trades?offset=10001')).statusCode).toBe(400)
  })

  it('rejects a malformed swapper or asset id', async () => {
    expect((await app.inject('/v1/trades?swapper=0x1234')).statusCode).toBe(400)
    // SS58 is never accepted on this surface.
    expect((await app.inject('/v1/trades?swapper=7KATdGakyhfBGnAt3XVgXTL7cYjzRXeSZHezKNtENcbSkry2')).statusCode).toBe(400)
    expect((await app.inject('/v1/trades?assets=DOT')).statusCode).toBe(400)
  })

  it('answers a swapper with no indexed trades with empty items, not 404', async () => {
    const probe = fakeClient({ account: [] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/trades?swapper=${ACCOUNT_B}`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ items: [], totalCount: 0 })
    } finally {
      await app2.close()
    }
  })
})

describe('GET /v1/trades/routed', () => {
  it('answers `participant` exactly as /v1/trades answers `swapper`', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      // limit=7 is this test's own cache key, so the routed route really runs.
      const viaParticipant = await app2.inject(`/v1/trades/routed?participant=${ACCOUNT_A}&limit=7`)
      expect(viaParticipant.statusCode).toBe(200)
      expect(viaParticipant.json().items.map((item: { blockHeight: number }) => item.blockHeight)).toEqual([999, 998])
      expect(probe.seen.some(s => s.query.includes('FROM price_data.account_swap_activity'))).toBe(true)
      expect(viaParticipant.headers['cache-control']).toBe('public, max-age=3')
      // Same query, same answer: the two endpoints exist for UI tab parity only.
      const viaSwapper = await app2.inject(`/v1/trades?swapper=${ACCOUNT_A}&limit=7`)
      expect(viaSwapper.json()).toEqual(viaParticipant.json())
    } finally {
      await app2.close()
    }
  })
})

describe('trade row semantics', () => {
  it('reads the fixed side from the pool event, and from the call for a routed trade', async () => {
    const { operationTypeOf } = await import('../../src/public/services/trades.ts')
    expect(operationTypeOf('Omnipool.SellExecuted', null)).toBe('exactIn')
    expect(operationTypeOf('Stableswap.BuyExecuted', null)).toBe('exactOut')
    // The router's net event does not say which side was fixed; its call does.
    expect(operationTypeOf('Router.Executed', 'Router.sell')).toBe('exactIn')
    expect(operationTypeOf('Router.Executed', 'Router.sell_all')).toBe('exactIn')
    expect(operationTypeOf('Router.Executed', 'Router.buy')).toBe('exactOut')
    // A batched or hook-dispatched route leaves it genuinely unknown.
    expect(operationTypeOf('Router.Executed', 'Utility.batch_all')).toBeNull()
    expect(operationTypeOf('Router.RouteExecuted', null)).toBeNull()
  })

  it('claims each DCA execution once, by nearest event after the swap', async () => {
    const { linkDcaExecutions } = await import('../../src/public/services/trades.ts')
    // Two schedules executing the same round amount in one block: (block, amount)
    // alone collides, so the claim is by adjacency and each execution is consumed.
    const links = linkDcaExecutions(
      [
        { blockHeight: 10, eventIndex: 4, extrinsicIndex: null, amountIn: '100' },
        { blockHeight: 10, eventIndex: 12, extrinsicIndex: null, amountIn: '100' },
        // A signed swap is never a DCA execution, whatever else the block holds.
        { blockHeight: 10, eventIndex: 20, extrinsicIndex: 3, amountIn: '100' },
      ],
      [
        { scheduleId: 7, blockHeight: 10, eventIndex: 5, who: ACCOUNT_A, amountIn: '100' },
        { scheduleId: 8, blockHeight: 10, eventIndex: 13, who: ACCOUNT_B, amountIn: '100' },
      ],
    )
    expect(links.get('10:4')).toEqual({ scheduleId: 7, who: ACCOUNT_A })
    expect(links.get('10:12')).toEqual({ scheduleId: 8, who: ACCOUNT_B })
    expect(links.has('10:20')).toBe(false)
  })
})
