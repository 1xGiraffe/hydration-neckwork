import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { csv, parseAssets, notFound, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import type { IntentKind, IntentStatus } from '../services/intentOrders.ts'
import {
  INTENT_EVENT_KINDS, INTENT_KINDS, INTENT_STATUSES,
  queryIntentEvents, queryIntentOrderById, queryIntentOrders,
} from '../services/intentOrders.ts'

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
  // The order's price limit in whole units, 12 dp, both directions — `amountOut`
  // per one `amountIn` and its inverse. Stated on BOTH kinds: pallet_intent
  // enforces `amountOut` on every fill, over the whole order for a swap intent and
  // over ONE PERIOD's trade for a dca intent. `slippagePpm` does NOT loosen it —
  // on a dca intent it builds a second, oracle-derived floor and the pallet takes
  // the tighter of the two, so the effective floor at fill time can only be better
  // for the owner. Both directions are published because inverting one 12 dp
  // decimal does not reproduce the other's truncation. Null when the registry
  // cannot vouch for an asset's decimals, or a leg names no amount.
  limitPriceOutPerIn: z.string().nullable(),
  limitPriceInPerOut: z.string().nullable(),
})

const zIntentEventRow = z.object({
  kind: z.enum(INTENT_EVENT_KINDS as [string, ...string[]]),
  eventName: z.string().describe('The runtime event. `Intent.IntentResovedPartially` is spelled that way on chain (sic).'),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable().describe('Fills happen inside the UNSIGNED ICE.submit_solution, so a fill names an extrinsic but never a signer.'),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable(),
  amountOut: z.string().nullable(),
  remainingBudget: z.string().nullable(),
})

// A u128 in decimal is at most 39 digits. Bounded at the edge so a caller's typo
// reads as a 400 rather than a ClickHouse parse failure surfacing as a 500.
const zIntentId = z.string()
  .regex(/^\d{1,39}$/, 'expected a decimal intent id')
  .refine(id => BigInt(id) <= 2n ** 128n - 1n, 'intent id exceeds u128')

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

  app.get('/v1/intents/:id', {
    schema: {
      tags: ['dca'],
      summary: 'One intent with its computed status and fill totals',
      description: [
        INTENT_DESCRIPTION,
        'The same row GET /v1/intents publishes for this order, built by the same fold, so a progress page cannot contradict the list it was reached from. No owner is needed: the id alone bounds both reads — the placement is a point read of the id-keyed table, and its block is the lower bound of the event fold.',
        STATUS_DESCRIPTION,
        'A DCA intent\'s progress is `filledAmountIn` against `budget`: `amountIn` is ONE PERIOD\'s trade, never the total. Amounts are raw integers at each asset\'s own decimals, so compute the percentage in integer arithmetic rather than through a float. An unknown id is a 404.',
      ].join('\n\n'),
      params: z.object({ id: zIntentId }),
      response: { 200: zIntentRow },
    },
  }, async request => {
    const { id } = request.params
    // Short-lived: an order being watched for its next fill must not lag behind
    // a shared cache entry.
    const found = await cached(`pub:intent:${id}`, 3_000, () => queryIntentOrderById(opts.client, id))
    if (!found) throw notFound(`no intent ${id}`)
    return found
  })

  app.get('/v1/intents/:id/events', {
    schema: {
      tags: ['dca'],
      summary: 'Lifecycle events of one intent, newest first',
      description: [
        'Every event of the order\'s life, newest first: its submission, each dca trade, each full or partial resolution, its completion, cancellation or expiry, and a failed forward callback. A DCA fill table is the `dca_trade` rows; a swap intent\'s fills are `resolved` and `partially_resolved`.',
        'Amounts are the EVENT\'s, not the order\'s, and an event that traded nothing reports them as null rather than 0 — a submission, a cancellation, an expiry, and `Intent.DcaCompleted`, whose final trade states its amounts only in the solution\'s settlement transfers. `remainingBudget` is the pallet\'s own figure after a dca trade, and "0" on the completion, which by definition spent the rest.',
        'Only the submission names the pair, so `assetIn`/`assetOut` sit on the envelope: they label every amount in the page. An unknown id is a 404.',
      ].join('\n\n'),
      params: z.object({ id: zIntentId }),
      querystring: zLimitOffset,
      response: {
        200: z.object({
          items: z.array(zIntentEventRow),
          totalCount: z.number().int().nonnegative(),
          assetIn: zAssetId,
          assetOut: zAssetId,
        }),
      },
    },
  }, async request => {
    const { id } = request.params
    const { limit, offset } = request.query
    const page = await cached(`pub:intent-events:${id}:${limit}:${offset}`, 3_000,
      () => queryIntentEvents(opts.client, id, { limit, offset }))
    if (!page) throw notFound(`no intent ${id}`)
    return page
  })
}
