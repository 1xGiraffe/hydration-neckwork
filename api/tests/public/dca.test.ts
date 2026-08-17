import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// Contract tests for the three /v1/dca endpoints, plus unit tests for the two pure
// functions the surface's meaning lives in: computeDcaStatus (which of the four
// states a schedule is in) and parseDcaErrorState (the failure shape the UI parses).
type Row = Record<string, unknown>

function queryResult(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const OWNER = `0x${'11'.repeat(32)}`
const OTHER = `0x${'22'.repeat(32)}`
const EVM_OWNER = `0x${'aa'.repeat(20)}`
const EVM_OWNER_ID = `0x45544800${'aa'.repeat(20)}${'00'.repeat(8)}`
const BOUND_OWNER = `0x${'bb'.repeat(32)}`

const SCHEDULE_ROWS: Row[] = [
  { id: '1', block_height: 100, extrinsic_index: 2, ts: '2026-06-01 00:00:00', who: OWNER, asset_in: 5, asset_out: 0, direction: 'Sell', amount_per: '1000000000', total_amount: '10000000000', period: 6 },
  { id: '2', block_height: 200, extrinsic_index: 2, ts: '2026-06-02 00:00:00', who: OWNER, asset_in: 0, asset_out: 222, direction: 'Buy', amount_per: '2000000000000000000', total_amount: '0', period: 12 },
  { id: '3', block_height: 300, extrinsic_index: 2, ts: '2026-06-03 00:00:00', who: OWNER, asset_in: 5, asset_out: 222, direction: 'Sell', amount_per: '500000000', total_amount: '5000000000', period: 6 },
  { id: '4', block_height: 400, extrinsic_index: 2, ts: '2026-06-04 00:00:00', who: OWNER, asset_in: 0, asset_out: 5, direction: 'Sell', amount_per: '700000000', total_amount: '7000000000', period: 24 },
]

// Pre-router schedules: DCA.Scheduled carried only {id, who}, so the stored row has a
// BLANK direction, asset_in = asset_out = 0 and empty amounts. Schedule 5's order is
// recoverable from its DCA.schedule call, schedule 6's only from its first execution's
// swap leg (no addressable call), and schedule 7's from nothing at all.
const LEGACY_SCHEDULE_ROWS: Row[] = [
  { id: '5', block_height: 500, extrinsic_index: 3, ts: '2023-06-19 21:30:24', who: OWNER, asset_in: 0, asset_out: 0, direction: '', amount_per: '', total_amount: '', period: 0 },
  { id: '6', block_height: 600, extrinsic_index: null, ts: '2023-06-20 21:30:24', who: OWNER, asset_in: 0, asset_out: 0, direction: '', amount_per: '', total_amount: '', period: 0 },
  { id: '7', block_height: 700, extrinsic_index: null, ts: '2023-06-21 21:30:24', who: OWNER, asset_in: 0, asset_out: 0, direction: '', amount_per: '', total_amount: '', period: 0 },
]

const LEGACY_CALL_ROWS: Row[] = [
  {
    block_height: 500,
    extrinsic_index: 3,
    args_json: JSON.stringify({
      schedule: {
        owner: OWNER, period: 143, totalAmount: '6971200000000000000', slippage: 15000,
        order: { assetIn: 4, assetOut: 0, amountIn: '69000000000000000', minAmountOut: '0', route: [], __kind: 'Sell' },
      },
    }),
  },
]

// The schedule's first DCA.TradeExecuted, and the swap events of that block: the
// schedule's own swap is the nearest one BEFORE the execution event with the same
// `who`, so an owner running several schedules in one block is not mixed up.
const LEGACY_FIRST_EXEC_ROWS: Row[] = [
  { id: '6', bh: 610, ei: 20, who: OWNER },
]
const LEGACY_SWAP_EVENT_ROWS: Row[] = [
  { block_height: 610, event_index: 4, who: OWNER, asset_in: 99, asset_out: 98 },
  { block_height: 610, event_index: 11, who: OWNER, asset_in: 2, asset_out: 0 },
  { block_height: 610, event_index: 15, who: OTHER, asset_in: 77, asset_out: 76 },
  { block_height: 610, event_index: 25, who: OWNER, asset_in: 55, asset_out: 54 },
]

// One row per schedule that has any event; schedule 4 has none at all.
const EVENT_AGG_ROWS: Row[] = [
  { id: '1', completed: 1, terminated: 0, terminated_signed: 0, last_exec: 'DCA.TradeExecuted', last_at: '2026-06-05 00:00:00', executed_in: '4000000000', executed_out: '80000000000' },
  { id: '2', completed: 0, terminated: 1, terminated_signed: 1, last_exec: 'DCA.ExecutionPlanned', last_at: '2026-06-07 00:00:00', executed_in: '0', executed_out: '0' },
  { id: '3', completed: 0, terminated: 1, terminated_signed: 0, last_exec: 'DCA.TradeFailed', last_at: '2026-06-06 00:00:00', executed_in: '500000000', executed_out: '9000000000' },
]

const EXECUTION_ROWS: Row[] = [
  { event_name: 'DCA.TradeExecuted', block_height: 110, event_index: 4, ts: '2026-06-05 00:00:00', amount_in: '1000000000', amount_out: '20000000000', error: '' },
  { event_name: 'DCA.TradeFailed', block_height: 109, event_index: 2, ts: '2026-06-04 12:00:00', amount_in: '', amount_out: '', error: '{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}' },
  { event_name: 'DCA.ExecutionPlanned', block_height: 108, event_index: 1, ts: '2026-06-04 06:00:00', amount_in: '', amount_out: '', error: '' },
]

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(overrides: { schedules?: Row[]; aggregates?: Row[]; executions?: Row[]; aliases?: Row[]; calls?: Row[]; firstExecutions?: Row[]; swapEvents?: Row[] } = {}) {
  const seen: Seen[] = []
  const client = {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      const params = query_params ?? {}
      seen.push({ query, params })
      if (query.includes('FROM price_data.raw_calls')) {
        const keys = new Set(((params.keys as number[]) ?? []).map(Number))
        return queryResult((overrides.calls ?? LEGACY_CALL_ROWS)
          .filter(row => keys.has(Number(row.block_height) * 1_000_000 + Number(row.extrinsic_index))))
      }
      if (query.includes('FROM price_data.raw_events')) {
        const blocks = new Set(((params.blocks as number[]) ?? []).map(Number))
        return queryResult((overrides.swapEvents ?? LEGACY_SWAP_EVENT_ROWS).filter(row => blocks.has(Number(row.block_height))))
      }
      if (query.includes('FROM price_data.dca_schedules')) {
        const rows = overrides.schedules ?? SCHEDULE_ROWS
        if (params.ids) {
          const wanted = new Set((params.ids as string[]).map(String))
          return queryResult(rows.filter(row => wanted.has(String(row.id))))
        }
        const owners = new Set(((params.accounts as string[]) ?? []).map(String))
        return queryResult(rows.filter(row => owners.has(String(row.who))))
      }
      if (query.includes('FROM price_data.dca_events')) {
        if (query.includes('argMin')) {
          const wanted = new Set(((params.ids as number[]) ?? []).map(String))
          return queryResult((overrides.firstExecutions ?? LEGACY_FIRST_EXEC_ROWS).filter(row => wanted.has(String(row.id))))
        }
        if (query.includes('GROUP BY id')) {
          const wanted = new Set(((params.ids as string[]) ?? []).map(String))
          return queryResult((overrides.aggregates ?? EVENT_AGG_ROWS).filter(row => wanted.has(String(row.id))))
        }
        const rows = overrides.executions ?? EXECUTION_ROWS
        if (query.includes('uniqExact')) return queryResult([{ total: String(rows.length) }])
        const offset = Number(params.offset ?? 0)
        const limit = Number(params.limit ?? 20)
        return queryResult(rows.slice(offset, offset + limit))
      }
      if (query.includes('FROM price_data.account_alias_directory')) {
        return queryResult(overrides.aliases ?? [{ evm_address: EVM_OWNER, account_id: BOUND_OWNER }])
      }
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  return client
}

let app: FastifyInstance

async function freshApp(probe: ReturnType<typeof fakeClient>): Promise<FastifyInstance> {
  const { buildPublicApp } = await import('../../src/public/app.ts')
  return buildPublicApp({ client: probe as never, logger: false })
}

beforeAll(async () => {
  app = await freshApp(fakeClient())
})

afterAll(async () => {
  await app?.close()
})

describe('computeDcaStatus', () => {
  it('labels a live schedule created and a finished one completed', async () => {
    const { computeDcaStatus } = await import('../../src/public/services/dcaSchedules.ts')
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: false, terminatedByExtrinsic: null, lastExecEventName: 'DCA.ExecutionPlanned' })).toBe('created')
    expect(computeDcaStatus({ hasCompleted: true, hasTerminated: false, terminatedByExtrinsic: null, lastExecEventName: 'DCA.TradeExecuted' })).toBe('completed')
  })

  it('separates the owner cancelling from the pallet ending a schedule', async () => {
    const { computeDcaStatus } = await import('../../src/public/services/dcaSchedules.ts')
    // A DCA.Terminated event carried by a signed extrinsic is the owner's own
    // dca.terminate call; one from a block hook is the pallet ending it on an error.
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: true, lastExecEventName: 'DCA.TradeExecuted' })).toBe('cancelled')
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: false, lastExecEventName: 'DCA.TradeFailed' })).toBe('terminated')
    // The signed signal decides even when the older heuristic would disagree: an
    // error termination that left a pending plan is still `terminated`.
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: false, lastExecEventName: 'DCA.ExecutionPlanned' })).toBe('terminated')
  })

  it('falls back to the last-execution rule when the termination event is unknown', async () => {
    const { computeDcaStatus } = await import('../../src/public/services/dcaSchedules.ts')
    // Data-lake rule: terminated with the last execution still only planned means
    // the owner cancelled before it ran.
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: null, lastExecEventName: 'DCA.ExecutionPlanned' })).toBe('cancelled')
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: null, lastExecEventName: 'DCA.TradeExecuted' })).toBe('terminated')
    expect(computeDcaStatus({ hasCompleted: false, hasTerminated: true, terminatedByExtrinsic: null, lastExecEventName: null })).toBe('terminated')
  })

  it('reports a terminal state even when both terminal events are present', async () => {
    const { computeDcaStatus } = await import('../../src/public/services/dcaSchedules.ts')
    // Termination wins: it is the event that actually ended the schedule.
    expect(computeDcaStatus({ hasCompleted: true, hasTerminated: true, terminatedByExtrinsic: true, lastExecEventName: 'DCA.TradeExecuted' })).toBe('cancelled')
  })
})

describe('parseDcaErrorState', () => {
  it('decodes a module dispatch error into the shape the UI parses', async () => {
    const { parseDcaErrorState } = await import('../../src/public/services/dcaSchedules.ts')
    expect(parseDcaErrorState('{"__kind":"Module","value":{"index":66,"error":"0x0c000000"}}'))
      .toEqual({ kind: 'Module', error: '0x0c000000', index: 66 })
  })

  it('carries a named kind in `error`, with no fabricated pallet index', async () => {
    const { parseDcaErrorState } = await import('../../src/public/services/dcaSchedules.ts')
    expect(parseDcaErrorState('{"__kind":"Token","value":{"__kind":"Frozen"}}'))
      .toEqual({ kind: 'Token', error: 'Frozen', index: 0 })
    expect(parseDcaErrorState('{"__kind":"Other"}')).toEqual({ kind: 'Other', error: 'Other', index: 0 })
  })

  it('is null for an absent or malformed error', async () => {
    const { parseDcaErrorState } = await import('../../src/public/services/dcaSchedules.ts')
    expect(parseDcaErrorState('')).toBeNull()
    expect(parseDcaErrorState(null)).toBeNull()
    expect(parseDcaErrorState('not json')).toBeNull()
    expect(parseDcaErrorState('{"value":{"index":1}}')).toBeNull()
  })
})

describe('GET /v1/dca/schedules', () => {
  it('computes each status server-side and sorts by the most recent event', async () => {
    const res = await app.inject(`/v1/dca/schedules?owner=${OWNER}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [
        {
          scheduleId: 2, owner: OWNER, assetIn: '0', assetOut: '222',
          singleTradeAmount: '2000000000000000000', budget: '0', isRollingBudget: true,
          executedAmountIn: '0', executedAmountOut: '0', periodBlocks: 12,
          // Terminated by a signed extrinsic: the owner's own dca.terminate call.
          status: 'cancelled',
          createdAt: '2026-06-02T00:00:00.000Z', createdAtBlock: 200, lastEventAt: '2026-06-07T00:00:00.000Z',
        },
        {
          scheduleId: 3, owner: OWNER, assetIn: '5', assetOut: '222',
          singleTradeAmount: '500000000', budget: '5000000000', isRollingBudget: false,
          executedAmountIn: '500000000', executedAmountOut: '9000000000', periodBlocks: 6,
          status: 'terminated',
          createdAt: '2026-06-03T00:00:00.000Z', createdAtBlock: 300, lastEventAt: '2026-06-06T00:00:00.000Z',
        },
        {
          scheduleId: 1, owner: OWNER, assetIn: '5', assetOut: '0',
          singleTradeAmount: '1000000000', budget: '10000000000', isRollingBudget: false,
          executedAmountIn: '4000000000', executedAmountOut: '80000000000', periodBlocks: 6,
          status: 'completed',
          createdAt: '2026-06-01T00:00:00.000Z', createdAtBlock: 100, lastEventAt: '2026-06-05T00:00:00.000Z',
        },
        {
          scheduleId: 4, owner: OWNER, assetIn: '0', assetOut: '5',
          singleTradeAmount: '700000000', budget: '7000000000', isRollingBudget: false,
          executedAmountIn: '0', executedAmountOut: '0', periodBlocks: 24,
          // No events yet: scheduled and waiting, never a terminal state.
          status: 'created',
          createdAt: '2026-06-04T00:00:00.000Z', createdAtBlock: 400, lastEventAt: null,
        },
      ],
      totalCount: 4,
    })
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })

  it('requires an owner so the path stays bounded', async () => {
    const res = await app.inject('/v1/dca/schedules')
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
    expect(res.json().error.message).toMatch(/owner/)
  })

  it('applies the status filter before paginating, so pages stay deterministic', async () => {
    const res = await app.inject(`/v1/dca/schedules?owner=${OWNER}&status=terminated,cancelled`)
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((item: { scheduleId: number }) => item.scheduleId)).toEqual([2, 3])
    // The count is of the FILTERED set, not of the owner's schedules.
    expect(res.json().totalCount).toBe(2)

    const first = await app.inject(`/v1/dca/schedules?owner=${OWNER}&limit=2&offset=0`)
    const second = await app.inject(`/v1/dca/schedules?owner=${OWNER}&limit=2&offset=2`)
    const ids = (res2: { json: () => { items: { scheduleId: number }[] } }) => res2.json().items.map(item => item.scheduleId)
    expect(ids(first)).toEqual([2, 3])
    expect(ids(second)).toEqual([1, 4])
    expect(first.json().totalCount).toBe(4)
  })

  it('matches the assets filter on either side of the pair', async () => {
    const res = await app.inject(`/v1/dca/schedules?owner=${OWNER}&assets=222`)
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((item: { scheduleId: number }) => item.scheduleId)).toEqual([2, 3])
    expect(res.json().totalCount).toBe(2)
  })

  it('answers an owner with no schedules with empty items, not 404', async () => {
    const res = await app.inject(`/v1/dca/schedules?owner=${OTHER}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [], totalCount: 0 })
  })

  it('finds schedules filed under either half of a bound EVM identity', async () => {
    const schedule = { ...SCHEDULE_ROWS[0], who: BOUND_OWNER }
    const probe = fakeClient({
      schedules: [schedule],
      aggregates: [],
      aliases: [{ evm_address: EVM_OWNER, account_id: BOUND_OWNER }],
    })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/dca/schedules?owner=${EVM_OWNER}&limit=9`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items).toHaveLength(1)
      const listing = probe.seen.find(s => s.query.includes('FROM price_data.dca_schedules') && !s.params.ids)!
      expect(new Set(listing.params.accounts as string[])).toEqual(new Set([EVM_OWNER, EVM_OWNER_ID, BOUND_OWNER]))
    } finally {
      await app2.close()
    }
  })

  it('recovers a pre-router schedule\'s order instead of publishing HDX -> HDX', async () => {
    // The stored row is all zeros because DCA.Scheduled carried only {id, who} before
    // the router era, and asset 0 is HDX — so 2,354 real schedules published a
    // nonsensical HDX -> HDX pair, a zero budget and `isRollingBudget: true`, a claim
    // the schedule never made. The explorer recovers the order from the DCA.schedule
    // call; this surface must agree with it.
    const probe = fakeClient({ schedules: [LEGACY_SCHEDULE_ROWS[0]], aggregates: [] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/dca/schedules?owner=${OWNER}&limit=13`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items).toEqual([{
        scheduleId: 5, owner: OWNER, assetIn: '4', assetOut: '0',
        singleTradeAmount: '69000000000000000', budget: '6971200000000000000', isRollingBudget: false,
        executedAmountIn: '0', executedAmountOut: '0', periodBlocks: 143, status: 'created',
        createdAt: '2023-06-19T21:30:24.000Z', createdAtBlock: 500, lastEventAt: null,
      }])
      // One primary-key-addressed read, not a scan: the call is reached by
      // (block_height, extrinsic_index), which is raw_calls' own key prefix.
      const call = probe.seen.find(s => s.query.includes('FROM price_data.raw_calls'))!
      expect(call.params.blocks).toEqual([500])
      expect(call.params.keys).toEqual([500 * 1_000_000 + 3])
    } finally {
      await app2.close()
    }
  })

  it('recovers the traded pair from the first execution when no call is addressable', async () => {
    // Batch- or hook-created legacy schedules have no extrinsic to read the order
    // from. A DCA.TradeExecuted follows its own swap's events, so the schedule's swap
    // is the nearest owner-matching one BEFORE that event — event 11 here, not the
    // block's first swap (4), not another account's (15), not a later one (25).
    const probe = fakeClient({ schedules: [LEGACY_SCHEDULE_ROWS[1]], aggregates: [] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/dca/schedules?owner=${OWNER}&limit=14`)
      expect(res.statusCode).toBe(200)
      const [row] = res.json().items
      expect([row.assetIn, row.assetOut]).toEqual(['2', '0'])
      // Only the pair is knowable this way, and an unknown term is null — NOT the
      // stored zero. `budget: "0"` would read as "known zero", and the boolean derived
      // from it (`isRollingBudget: true`) asserts a schedule with no budget at all,
      // which is the opposite of the truth for a schedule the pallet ran to Completed.
      expect(row.singleTradeAmount).toBeNull()
      expect(row.budget).toBeNull()
      expect(row.isRollingBudget).toBeNull()
      expect(row.periodBlocks).toBeNull()
    } finally {
      await app2.close()
    }
  })

  it('leaves an unrecoverable pre-router schedule alone rather than inventing a pair', async () => {
    const probe = fakeClient({ schedules: [LEGACY_SCHEDULE_ROWS[2]], aggregates: [], firstExecutions: [], swapEvents: [] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject(`/v1/dca/schedules?owner=${OWNER}&limit=15`)
      expect(res.statusCode).toBe(200)
      expect(res.json().items[0]).toMatchObject({
        scheduleId: 7, assetIn: '0', assetOut: '0',
        // Terms unknown here too: nothing was recovered at all.
        singleTradeAmount: null, budget: null, isRollingBudget: null, periodBlocks: null,
      })
    } finally {
      await app2.close()
    }
  })

  it('still reports a genuine rolling budget for a router-era schedule with none', async () => {
    // The nullability is gated on the pre-router marker ALONE, so a real schedule that
    // set no total budget keeps the concrete `"0"` / `true` it has always reported.
    // Measured live: `direction = ''` holds on exactly the 2,354 rows whose terms are
    // blank, and no router-era row has period 0 or an empty amount.
    const res = await app.inject(`/v1/dca/schedules?owner=${OWNER}&status=cancelled&limit=18`)
    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ scheduleId: 2, budget: '0', isRollingBudget: true, periodBlocks: 12 })
  })

  it('filters a pre-router schedule on its recovered pair, not on the stored zeros', async () => {
    const probe = fakeClient({ schedules: LEGACY_SCHEDULE_ROWS, aggregates: [] })
    const app2 = await freshApp(probe)
    try {
      // Asset 4 exists only in the recovered order of schedule 5. Filtering before
      // recovery would answer this with nothing and match every legacy row on `0`.
      const hit = await app2.inject(`/v1/dca/schedules?owner=${OWNER}&assets=4&limit=16`)
      expect(hit.json().items.map((item: { scheduleId: number }) => item.scheduleId)).toEqual([5])
      expect(hit.json().totalCount).toBe(1)
    } finally {
      await app2.close()
    }
  })

  it('reads no recovery query when the owner has no pre-router schedules', async () => {
    const probe = fakeClient()
    const app2 = await freshApp(probe)
    try {
      await app2.inject(`/v1/dca/schedules?owner=${OWNER}&limit=17`)
      expect(probe.seen.some(s => s.query.includes('FROM price_data.raw_calls'))).toBe(false)
      expect(probe.seen.some(s => s.query.includes('FROM price_data.raw_events'))).toBe(false)
    } finally {
      await app2.close()
    }
  })

  it('rejects an unknown status and a malformed owner', async () => {
    expect((await app.inject(`/v1/dca/schedules?owner=${OWNER}&status=active`)).statusCode).toBe(400)
    expect((await app.inject('/v1/dca/schedules?owner=0x1234')).statusCode).toBe(400)
  })
})

describe('GET /v1/dca/schedules/count', () => {
  it('counts the same filtered set the listing pages over', async () => {
    const res = await app.inject(`/v1/dca/schedules/count?owner=${OWNER}&status=created`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalCount: 1 })
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })

  it('requires an owner, like the listing', async () => {
    expect((await app.inject('/v1/dca/schedules/count')).statusCode).toBe(400)
  })
})

describe('GET /v1/dca/schedules/:id/executions', () => {
  it('maps each execution event to its state and names the traded pair', async () => {
    const res = await app.inject('/v1/dca/schedules/1/executions')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      items: [
        {
          status: 'executed', amountIn: '1000000000', amountOut: '20000000000',
          blockHeight: 110, eventIndex: 4, timestamp: '2026-06-05T00:00:00.000Z', errorState: null,
        },
        {
          // A failed attempt traded nothing, so its amounts are null rather than 0.
          status: 'failed', amountIn: null, amountOut: null,
          blockHeight: 109, eventIndex: 2, timestamp: '2026-06-04T12:00:00.000Z',
          errorState: { kind: 'Module', error: '0x0c000000', index: 66 },
        },
        {
          status: 'planned', amountIn: null, amountOut: null,
          blockHeight: 108, eventIndex: 1, timestamp: '2026-06-04T06:00:00.000Z', errorState: null,
        },
      ],
      totalCount: 3,
      assetIn: '5',
      assetOut: '0',
    })
    expect(res.headers['cache-control']).toBe('public, max-age=3')
  })

  it('pages without overlap and keeps the total independent of the page', async () => {
    const first = await app.inject('/v1/dca/schedules/1/executions?limit=2&offset=0')
    const second = await app.inject('/v1/dca/schedules/1/executions?limit=2&offset=2')
    expect(first.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([110, 109])
    expect(second.json().items.map((i: { blockHeight: number }) => i.blockHeight)).toEqual([108])
    expect(second.json().totalCount).toBe(3)
  })

  it('names a pre-router schedule\'s recovered pair, so its amounts are labelled right', async () => {
    // Without this the UI labels a WETH->HDX schedule's execution amounts as HDX->HDX.
    const probe = fakeClient({ schedules: [LEGACY_SCHEDULE_ROWS[0]], aggregates: [] })
    const app2 = await freshApp(probe)
    try {
      const res = await app2.inject('/v1/dca/schedules/5/executions?limit=3')
      expect(res.statusCode).toBe(200)
      expect(res.json().assetIn).toBe('4')
      expect(res.json().assetOut).toBe('0')
    } finally {
      await app2.close()
    }
  })

  it('is a 404 for a schedule that was never indexed', async () => {
    const res = await app.inject('/v1/dca/schedules/999/executions')
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('rejects a non-numeric or unrepresentable schedule id', async () => {
    expect((await app.inject('/v1/dca/schedules/abc/executions')).statusCode).toBe(400)
    // Past the safe-integer limit the id cannot survive the trip into the UInt64
    // query parameter; unbounded it reached ClickHouse as a 500.
    const huge = await app.inject('/v1/dca/schedules/100000000000000000000/executions')
    expect(huge.statusCode).toBe(400)
    expect(huge.json().error.code).toBe('bad_request')
  })

  it('rejects an out-of-range asset filter rather than overflowing the query parameter', async () => {
    const res = await app.inject(`/v1/dca/schedules?owner=${OWNER}&assets=99999999999`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_request')
  })
})
