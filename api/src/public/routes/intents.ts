import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { csv, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import type { IntentKind, IntentStatus } from '../services/intentOrders.ts'
import { INTENT_KINDS, INTENT_STATUSES, queryIntentOrders } from '../services/intentOrders.ts'

// ICE intents (runtime 443's limit orders and DCA intents). See spec section
// "Trades / DCA".

const MAX_ASSET_FILTERS = 20

const zIntentRow = z.object({
  intentId: z.string(),
  seq: z.number().int(),
  owner: zHexAddress,
  kind: z.enum(['swap', 'dca']),
  assetIn: zAssetId,
  assetOut: zAssetId,
  amountIn: z.string(),
  amountOut: z.string(),
  partiallyFillable: z.boolean(),
  slippagePpm: z.number().int(),
  // A swap intent has no budget and no period; a DCA intent has both. Null is
  // "does not apply to this kind", never zero.
  budget: z.string().nullable(),
  isRollingBudget: z.boolean().nullable(),
  periodBlocks: z.number().int().nullable(),
  status: z.enum(['open', 'partially_filled', 'filled', 'cancelled', 'expired', 'completed']),
  filledAmountIn: z.string(),
  filledAmountOut: z.string(),
  fillCount: z.number().int(),
  remainingAmountIn: z.string(),
  remainingBudget: z.string().nullable(),
  deadline: zIsoTimestamp.nullable(),
  createdAt: zIsoTimestamp,
  createdAtBlock: z.number().int(),
  lastEventAt: zIsoTimestamp.nullable(),
})

const zIntentFilters = z.object({
  owner: zHexAddress.describe('REQUIRED. The intent owner, as a lowercase hex account id.'),
  status: z.string().optional().describe(`Comma-separated: ${INTENT_STATUSES.join(', ')}. Defaults to all.`),
  kind: z.string().optional().describe(`Comma-separated: ${INTENT_KINDS.join(', ')}. Defaults to both.`),
  assets: z.string().optional().describe('Comma-separated registry ids; matches either side of the pair.'),
})

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function parseStatuses(raw: string | undefined): IntentStatus[] {
  const out: IntentStatus[] = []
  for (const value of csv(raw)) {
    const status = INTENT_STATUSES.find(known => known === value.toLowerCase())
    // An unrecognised status is a caller error, not a filter to drop: ignoring it
    // would answer a narrow request with every intent the owner has.
    if (!status) throw badRequest(`unknown status '${value}'; expected one of ${INTENT_STATUSES.join(', ')}`)
    out.push(status)
  }
  return [...new Set(out)].sort()
}

function parseKinds(raw: string | undefined): IntentKind[] {
  const out: IntentKind[] = []
  for (const value of csv(raw)) {
    const kind = INTENT_KINDS.find(known => known === value.toLowerCase())
    if (!kind) throw badRequest(`unknown kind '${value}'; expected one of ${INTENT_KINDS.join(', ')}`)
    out.push(kind)
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

const INTENT_DESCRIPTION = [
  'An ICE intent is a resting order: the owner\'s `assetIn` goes under a named reserve at submission and a solver\'s ICE.submit_solution fills it. A **swap** intent is the product\'s **limit order** (`amountOut` is the minimum it accepts); a **dca** intent is runtime 443\'s DCA, where `amountIn` is ONE PERIOD\'s trade and `budget` the whole commitment. The Intent pallet went live at block 14,362,830.',
  '`intentId` is a u128 and travels as a DECIMAL STRING — it is the identity everywhere. `seq` is its low 64 bits, the short "#n" handle the explorer shows; it is a display value and exact only below 2^53, so never key on it.',
].join('\n\n')

const STATUS_DESCRIPTION = [
  '`status` is computed server-side from the intent\'s events, never stored. A PARTIAL resolution does NOT end an order: pallet_ice leaves the remainder resting and keeps filling it, so `partially_filled` is a live state and an order pulled after two partials reports `cancelled` with its progress in `filledAmountIn`/`filledAmountOut`. A dca intent never resolves — it trades once per period and reports `completed` once the trade that spent the last of its budget emitted Intent.DcaCompleted. The same rule labels the explorer\'s intent page, so both surfaces label the same order the same way.',
  '`remainingAmountIn` is what the order still commits: a swap intent\'s placed `amountIn` less the partial fills, a dca intent\'s `budget` less what its trades have spent. It is exact integer arithmetic and never goes negative. `remainingBudget` is the separate figure the pallet itself reported on the newest dca trade, and is null on a swap intent.',
  '`isRollingBudget: true` means a dca intent set no budget: it keeps spending whatever the owner holds, exactly as a DCA schedule with `totalAmount: "0"` does. `budget`, `isRollingBudget` and `periodBlocks` are null TOGETHER on a swap intent, where they do not apply — null here is "not this kind of order", never zero.',
].join('\n\n')

const OWNER_DESCRIPTION = 'Owner is REQUIRED: the status filter and the ordering are computed over the owner\'s WHOLE set of intents before the page is cut (filtering after a LIMIT would make page 2 depend on how many rows page 1 dropped), and only an owner-scoped set is small enough for that to stay bounded. A request without one is a 400, never an unbounded scan.'

export const intentsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  const listing = (owner: string, statuses: IntentStatus[], kinds: IntentKind[], assets: string[], limit: number, offset: number) => {
    const key = `pub:intents:${owner}:${statuses.join(',')}:${kinds.join(',')}:${assets.join(',')}:${limit}:${offset}`
    return cached(key, 3_000, () => queryIntentOrders(opts.client, { owner, statuses, kinds, assets, limit, offset }))
  }

  app.get('/v1/intents', {
    schema: {
      tags: ['dca'],
      summary: 'ICE intents of one owner, with computed status',
      description: `${INTENT_DESCRIPTION}\n\n${OWNER_DESCRIPTION}\n\n${STATUS_DESCRIPTION}\n\nSorted by most recent event first; an intent with no events yet sorts by its submission.`,
      querystring: zLimitOffset.extend(zIntentFilters.shape),
      response: { 200: zPage(zIntentRow) },
    },
  }, async request => {
    const { owner, limit, offset } = request.query
    return listing(owner, parseStatuses(request.query.status), parseKinds(request.query.kind), parseAssets(request.query.assets), limit, offset)
  })

  app.get('/v1/intents/count', {
    schema: {
      tags: ['dca'],
      summary: 'How many intents match a filter',
      description: `The totalCount GET /v1/intents reports for the same filter, without the page. ${OWNER_DESCRIPTION}`,
      querystring: zIntentFilters,
      response: { 200: z.object({ totalCount: z.number().int().nonnegative() }) },
    },
  }, async request => {
    const { owner } = request.query
    // The service filters the owner's whole set anyway, so the count is that
    // set's size; a limit of 1 keeps the response small without changing it.
    const page = await listing(owner, parseStatuses(request.query.status), parseKinds(request.query.kind), parseAssets(request.query.assets), 1, 0)
    return { totalCount: page.totalCount }
  })
}
