import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { csv, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import type { DcaStatus } from '../services/dcaSchedules.ts'
import { queryDcaExecutions, queryDcaSchedules } from '../services/dcaSchedules.ts'

// DCA schedules and their executions. See spec section "Trades / DCA".

const DCA_STATUSES = ['created', 'completed', 'terminated', 'cancelled'] as const
const MAX_ASSET_FILTERS = 20

const zDcaScheduleRow = z.object({
  scheduleId: z.number().int(),
  owner: zHexAddress,
  assetIn: zAssetId,
  assetOut: zAssetId,
  // The four registered terms are null TOGETHER, and only for a pre-router schedule
  // whose order could not be recovered — see PRE_ROUTER_DESCRIPTION. Null is "unknown",
  // never "zero": a schedule that really set no cap reports budget "0" with
  // isRollingBudget true.
  singleTradeAmount: z.string().nullable(),
  budget: z.string().nullable(),
  isRollingBudget: z.boolean().nullable(),
  executedAmountIn: z.string(),
  executedAmountOut: z.string(),
  periodBlocks: z.number().int().nullable(),
  status: z.enum(DCA_STATUSES),
  createdAt: zIsoTimestamp,
  createdAtBlock: z.number().int(),
  lastEventAt: zIsoTimestamp.nullable(),
})

const zExecutionRow = z.object({
  status: z.enum(['executed', 'failed', 'planned']),
  amountIn: z.string().nullable(),
  amountOut: z.string().nullable(),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  errorState: z.object({ kind: z.string(), error: z.string(), index: z.number().int() }).nullable(),
})

const zScheduleFilters = z.object({
  owner: zHexAddress.describe('REQUIRED. The schedule owner, as a lowercase hex account id.'),
  status: z.string().optional().describe(`Comma-separated: ${DCA_STATUSES.join(', ')}. Defaults to all.`),
  assets: z.string().optional().describe('Comma-separated registry ids; matches either side of the pair.'),
})

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 })
}

function parseStatuses(raw: string | undefined): DcaStatus[] {
  const out: DcaStatus[] = []
  for (const value of csv(raw)) {
    const status = DCA_STATUSES.find(known => known === value.toLowerCase())
    // An unrecognised status is a caller error, not a filter to drop: ignoring it
    // would answer a narrow request with every schedule the owner has.
    if (!status) throw badRequest(`unknown status '${value}'; expected one of ${DCA_STATUSES.join(', ')}`)
    out.push(status)
  }
  return [...new Set(out)].sort()
}

function parseAssets(raw: string | undefined): string[] {
  const assets = csv(raw)
  if (assets.length > MAX_ASSET_FILTERS) throw badRequest(`assets accepts at most ${MAX_ASSET_FILTERS} ids, got ${assets.length}`)
  const parsed = z.array(zAssetId).safeParse(assets)
  if (!parsed.success) throw badRequest('assets must be decimal registry ids, e.g. assets=5,10')
  return [...new Set(parsed.data)].sort((a, b) => Number(a) - Number(b))
}

const STATUS_DESCRIPTION = [
  '`status` is computed server-side from the schedule\'s events, never stored: `completed` when the pallet reported DCA.Completed, `cancelled` when a DCA.Terminated event came from a SIGNED extrinsic (the owner\'s own dca.terminate call), `terminated` when it came from a block hook (the pallet ending the schedule on an error), and `created` while it is still live. The signed-extrinsic signal is what the explorer\'s DCA page uses, so both surfaces label the same schedule the same way; the older data-lake heuristic (terminated with the last execution still only planned ⇒ cancelled) is the fallback when that signal is unavailable, and it mislabels an error termination that left a pending plan.',
  '`isRollingBudget: true` means the schedule has no total budget: it keeps spending whatever the owner holds. It is `null`, together with `singleTradeAmount`, `budget` and `periodBlocks`, when the schedule\'s terms were never recorded on chain — see PRE-ROUTER SCHEDULES below, the only case where that happens. `executedAmountIn`/`executedAmountOut` sum the schedule\'s DCA.TradeExecuted events and are always known, whatever the terms are. Sorted by most recent event first; a schedule with no events yet sorts last.',
].join('\n\n')

const PRE_ROUTER_DESCRIPTION = [
  'PRE-ROUTER SCHEDULES (ids below 2354, created before block ~4,220,000). The runtime emitted DCA.Scheduled with only `{id, who}` in that era, so the indexed row carries no order at all — no pair, no amounts, no period. Rather than publish that as a schedule trading asset 0 for asset 0 (asset 0 is HDX, so it would read as a nonsensical HDX -> HDX order) with a zero budget, the order is RECOVERED per request, by the same two rules the explorer\'s DCA page uses:',
  '1. from the `DCA.schedule` extrinsic\'s own call arguments, which carry the whole order — pair, per-trade amount, budget and period. This covers 2,335 of the 2,354 pre-router schedules.',
  '2. for the remaining 19 (created inside a batch, a proxy call or a block hook, so no schedule call is addressable), the traded PAIR ALONE, taken from the first execution\'s own swap leg. Its TERMS are genuinely unknown, and `singleTradeAmount`, `budget`, `isRollingBudget` and `periodBlocks` are therefore `null` on exactly those rows — `null` meaning "not recorded on chain", never "zero". A schedule that really set no budget reports `budget: "0"` with `isRollingBudget: true` instead, so the two cases stay distinguishable.',
  'Between the two rules every pre-router schedule\'s pair is currently known (2,335 + 19 = 2,354, verified live against the explorer\'s DCA page). A schedule with neither an addressable call nor an executed trade would fall back to the stored `"0"`/`"0"` and report null terms; no such row exists today.',
  'The `assets` filter is applied to the RECOVERED pair, so filtering on a pre-router schedule\'s real asset finds it. `assetIn`/`assetOut` on GET /v1/dca/schedules/{id}/executions come from the same recovery, because they are what labels every amount in that response. Router-era schedules (ids 2354 and above) are unaffected by all of this.',
].join('\n\n')

const OWNER_DESCRIPTION = 'Owner is REQUIRED: the status filter and the ordering are computed over the owner\'s WHOLE set of schedules before the page is cut (filtering after a LIMIT would make page 2 depend on how many rows page 1 dropped), and only an owner-scoped set is small enough for that to stay bounded. A request without one is a 400, never an unbounded scan.'

export const dcaRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  const listing = (owner: string, statuses: DcaStatus[], assets: string[], limit: number, offset: number) => {
    const key = `pub:dca-schedules:${owner}:${statuses.join(',')}:${assets.join(',')}:${limit}:${offset}`
    return cached(key, 3_000, () => queryDcaSchedules(opts.client, { owner, statuses, assets, limit, offset }))
  }

  app.get('/v1/dca/schedules', {
    schema: {
      tags: ['dca'],
      summary: 'DCA schedules of one owner, with computed status',
      description: `${OWNER_DESCRIPTION}\n\n${STATUS_DESCRIPTION}\n\n${PRE_ROUTER_DESCRIPTION}`,
      querystring: zLimitOffset.extend(zScheduleFilters.shape),
      response: { 200: zPage(zDcaScheduleRow) },
    },
  }, async request => {
    const { owner, limit, offset } = request.query
    return listing(owner, parseStatuses(request.query.status), parseAssets(request.query.assets), limit, offset)
  })

  app.get('/v1/dca/schedules/count', {
    schema: {
      tags: ['dca'],
      summary: 'How many schedules match a filter',
      description: `The totalCount GET /v1/dca/schedules reports for the same filter, without the page. The \`assets\` filter matches a pre-router schedule on its RECOVERED pair, exactly as the listing does. ${OWNER_DESCRIPTION}`,
      querystring: zScheduleFilters,
      response: { 200: z.object({ totalCount: z.number().int().nonnegative() }) },
    },
  }, async request => {
    const { owner } = request.query
    // The service filters the owner's whole set anyway, so the count is that set's
    // size; a limit of 1 keeps the response small without changing the number.
    const page = await listing(owner, parseStatuses(request.query.status), parseAssets(request.query.assets), 1, 0)
    return { totalCount: page.totalCount }
  })

  app.get('/v1/dca/schedules/:id/executions', {
    schema: {
      tags: ['dca'],
      summary: 'Executions of one DCA schedule, newest first',
      description: [
        'Every execution event of the schedule: `executed` (DCA.TradeExecuted), `failed` (DCA.TradeFailed) and `planned` (DCA.ExecutionPlanned, the attempts the pallet has scheduled). A failed or planned attempt traded nothing, so its amounts are null rather than 0.',
        '`errorState` decodes a failed attempt\'s DispatchError. A Module error carries the pallet index and error bytes (`{"kind":"Module","error":"0x0c000000","index":66}`); every other kind is self-describing, so its sub-kind travels in `error` and `index` is 0 — the pallet index is never invented.',
        '`assetIn`/`assetOut` are the schedule\'s registered pair, and they label every amount above. A PRE-ROUTER schedule (id below 2354) registered none — that era\'s DCA.Scheduled event carried no order — so the pair is recovered from the schedule\'s own DCA.schedule call, or from its first execution\'s swap leg when no call is addressable; see GET /v1/dca/schedules for the full rule. An unknown schedule id is a 404.',
      ].join('\n\n'),
      // Bounded at the safe-integer limit: a larger id could not survive the trip
      // through a JS number into the UInt64 query parameter, and a caller's typo
      // must read as a 400 rather than a ClickHouse parse failure.
      params: z.object({ id: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
      querystring: zLimitOffset,
      response: {
        200: z.object({
          items: z.array(zExecutionRow),
          totalCount: z.number().int().nonnegative(),
          assetIn: zAssetId,
          assetOut: zAssetId,
        }),
      },
    },
  }, async request => {
    const { id } = request.params
    const { limit, offset } = request.query
    const page = await cached(`pub:dca-exec:${id}:${limit}:${offset}`, 3_000, () => queryDcaExecutions(opts.client, id, { limit, offset }))
    if (!page) throw notFound(`no DCA schedule ${id}`)
    return page
  })
}
