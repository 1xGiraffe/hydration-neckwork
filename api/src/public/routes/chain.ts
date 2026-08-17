import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { csv, errorEnvelope, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import {
  DEFAULT_HASH_LOOKUP_DAYS,
  MAX_HASH_LOOKUP_DAYS,
  STAKING_EVENT_TYPES,
  getExtrinsicAt,
  getExtrinsicByHash,
  getOtcOrder,
  queryStakingEvents,
  type StakingEventType,
} from '../services/chain.ts'

// Direct chain lookups: one extrinsic, one OTC order, the staking event streams.
// These are the surfaces the Hydration UI reads out of the archive indexer today
// (spec section "First-party /v1 additions").

const zError = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

// ---------------------------------------------------------------------------
// Extrinsics
// ---------------------------------------------------------------------------

const EXTRINSIC_HASH_RE = /^0x[0-9a-f]{64}$/

const zExtrinsicHash = z.string().toLowerCase().regex(EXTRINSIC_HASH_RE, 'expected a 0x-prefixed 32-byte extrinsic hash')

// Same pattern (so the OpenAPI document still publishes it), but the message is
// built from the input: `/v1/extrinsics/<height>` is the likely mistake on this
// route pair — a bare height is one path segment, so it lands here rather than on
// the two-segment position route — and a caller who makes it gets told the shape
// that does work instead of only the shape that does not.
const zExtrinsicHashParam = z.string().toLowerCase().regex(EXTRINSIC_HASH_RE, {
  error: issue => (/^\d+$/.test(String(issue.input))
    ? `expected a 0x-prefixed 32-byte extrinsic hash; a block height alone does not address an extrinsic — use /v1/extrinsics/${issue.input}/{index}`
    : 'expected a 0x-prefixed 32-byte extrinsic hash'),
})

const zDispatchError = z.object({
  kind: z.string().describe('The DispatchError variant: Module, Token, Arithmetic, BadOrigin, Other, …'),
  module: z.string().nullable().describe('Pallet name of a Module error, from the runtime metadata active at that block.'),
  name: z.string().nullable().describe('Error name inside the pallet.'),
  docs: z.string().nullable(),
  raw: z.string().describe('The undecoded DispatchError JSON, always present, so a caller can decode a variant this service does not name.'),
})

const zExtrinsic = z.object({
  blockHeight: z.number().int(),
  extrinsicIndex: z.number().int(),
  hash: zExtrinsicHash,
  timestamp: zIsoTimestamp,
  signer: zHexAddress.nullable(),
  success: z.boolean(),
  error: zDispatchError.nullable(),
})

const EXTRINSIC_DESCRIPTION = [
  '`success` and `error` are the extrinsic\'s dispatch outcome: exactly one of them is meaningful, and a successful extrinsic has `error: null`.',
  '`signer` is the extrinsic\'s signatory, or its effective signer for an EVM-originated transaction (the ETH-prefixed account id). An unsigned/inherent extrinsic reports null.',
  'A Module error is named from `runtime_error_names` for the spec version active at that block. A triple the metadata index does not know reports `module`/`name`/`docs` as null while keeping `kind` and `raw`, rather than inventing a name.',
].join('\n\n')

const HASH_WINDOW_DESCRIPTION = [
  '**Which of the two extrinsic routes to call.** They are told apart by path SHAPE, not by sniffing the value: a hash is ONE segment after `/v1/extrinsics` and a position is TWO, so `:hash` must be a 0x-prefixed 32-byte hex hash and nothing else. A bare block height is one segment and therefore arrives here, where it is a 400 naming the route that does work — an extrinsic is not addressable by height alone, it needs its index: GET /v1/extrinsics/{blockHeight}/{index}.',
  `**Bounded by time.** \`raw_extrinsics\` is ordered by (blockHeight, extrinsicIndex) and has no index over the hash, so this lookup is a partition-pruned scan and its cost is proportional to the window: measured on the live table at the chain's present ~6 s block time, 7 days reads ~5 MiB and 90 days ~189 MiB, against ~2.11 GiB for the whole table. Those figures are per unit of WALL CLOCK, so a move to 2 s blocks puts ~3x the rows in the same window and scales them accordingly. The default window is ${DEFAULT_HASH_LOOKUP_DAYS} days and the cap is ${MAX_HASH_LOOKUP_DAYS}; an extrinsic older than the window it was asked for is a 404, and is addressable through GET /v1/extrinsics/{blockHeight}/{index} instead.`,
  'The window covers the transaction-toast use case by a wide margin — a toast is polled for at most an hour after submission.',
  'A transaction that has been submitted but not yet indexed is also a 404: this endpoint reads indexed blocks only and has no view of the transaction pool. Poll until it appears.',
].join('\n\n')

// ---------------------------------------------------------------------------
// OTC orders
// ---------------------------------------------------------------------------

const zOtcEvent = z.object({
  type: z.enum(['placed', 'filled', 'partiallyFilled', 'cancelled']),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable().describe('The order size on `placed`; the fill size on `filled`/`partiallyFilled`; null on `cancelled`.'),
  amountOut: z.string().nullable(),
  filler: zHexAddress.nullable().describe('The filling account — carried only by the two fill events.'),
})

const zOtcOrder = z.object({
  orderId: z.number().int(),
  owner: zHexAddress.nullable(),
  assetIn: zAssetId,
  assetOut: zAssetId,
  amountIn: z.string(),
  amountOut: z.string(),
  partiallyFillable: z.boolean(),
  status: z.enum(['open', 'filled', 'cancelled']),
  filledAmountIn: z.string(),
  filledAmountOut: z.string(),
  events: z.array(zOtcEvent),
})

const OTC_DESCRIPTION = [
  'Order state folded from its event history, newest state from the oldest events: `open` until a terminal event, then `filled` or `cancelled`. Partial fills never end an order — an order pulled after two partial fills is `cancelled`, and `filledAmountIn`/`filledAmountOut` say how much of it had traded first.',
  '`assetIn`/`assetOut`/`amountIn`/`amountOut`/`partiallyFillable` describe the order AS PLACED and are read only from its OTC.Placed event. A fill or cancel event does not carry them, so an order whose placement is not indexed is a 404 rather than an order with a guessed pair.',
  '`filledAmountIn`/`filledAmountOut` are exact integer sums over every fill event, in raw on-chain units. The remaining size is `amountIn - filledAmountIn` (respectively out); combined with the placed amount, that is the partial-fill progress an order row shows.',
  '`owner` is always null. OTC.Placed does not carry the order owner and no indexed model records it; reporting the placing extrinsic\'s signatory would be wrong for a proxied or batched placement, so the field is honestly empty rather than plausibly filled.',
].join('\n\n')

// ---------------------------------------------------------------------------
// Staking events
// ---------------------------------------------------------------------------

// These events are ~1 per 1,200 blocks, so a page walks a long way through
// `raw_events` and its cost is set by how many rows it must walk PAST, not by how
// many it returns: measured on the live table, an unbounded first page of 200
// reads 199 MiB, a 1,300-row window ~400 MiB and a 5,300-row one 1.28 GiB. The
// page therefore keeps the shared limit of 200 and a shallow offset, and
// `fromBlock` — which prunes by the primary key — is the cursor for deep history
// (a 1.5-month window costs 76 MiB).
const MAX_STAKING_OFFSET = 1_000

const zStakingEvent = z.object({
  type: z.enum(STAKING_EVENT_TYPES),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  accumulatedRps: z.string().nullable().describe('AccumulatedRpsUpdated only: the reward-per-share accumulator, raw integer.'),
  totalStake: z.string().nullable().describe('AccumulatedRpsUpdated only: total staked HDX at the update, raw integer.'),
  nonDustableBalance: z.string().nullable().describe('StakingInitialized only: the staking pot\'s non-dustable balance, raw integer.'),
})

const zStakingQuery = zLimitOffset.extend({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).max(MAX_STAKING_OFFSET).default(0),
  types: z.string().optional().describe(`Comma-separated event types. Default: all of ${STAKING_EVENT_TYPES.join(', ')}.`),
  // Capped because both are bound as ClickHouse UInt32, which wraps MOD 2^32 in
  // silence: an overflowing cursor would page a window the caller did not ask for.
  fromBlock: z.coerce.number().int().min(0).max(4_294_967_295).optional(),
  toBlock: z.coerce.number().int().min(0).max(4_294_967_295).optional(),
})

const STAKING_DESCRIPTION = [
  '**Oldest first**, unlike the other feeds: the staking APR reconstruction differences each reward-per-share accumulator against the one before it, so ascending block order is part of the contract.',
  `Typed per stream: AccumulatedRpsUpdated carries \`accumulatedRps\` and \`totalStake\`, StakingInitialized carries \`nonDustableBalance\`, and the fields of the other stream are null. All three are raw integer strings — the accumulator and the total stake both exceed 2^53.`,
  `Bounded: page with \`fromBlock\`, which prunes by the primary key, rather than with a deep \`offset\`. These events are ~1 per 1,200 blocks, so a page's cost is set by how far through the event stream it must walk, not by how many rows it returns — which is why \`offset\` is capped at ${MAX_STAKING_OFFSET} and an offset past it is a 400 rather than a slow request. \`totalCount\` counts the same filter the page uses and is cached for 5 minutes per filter.`,
].join('\n\n')

function parseStakingTypes(raw: string | undefined): StakingEventType[] {
  const requested = csv(raw)
  if (!requested.length) return [...STAKING_EVENT_TYPES]
  const unknown = requested.filter(type => !(STAKING_EVENT_TYPES as readonly string[]).includes(type))
  if (unknown.length) throw badRequest(`unknown staking event type(s): ${unknown.join(', ')}. Known: ${STAKING_EVENT_TYPES.join(', ')}`)
  return [...new Set(requested)] as StakingEventType[]
}

export const chainRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/extrinsics/:hash', {
    schema: {
      tags: ['chain'],
      summary: 'One extrinsic by transaction hash',
      description: `${EXTRINSIC_DESCRIPTION}\n\n${HASH_WINDOW_DESCRIPTION}`,
      params: z.object({ hash: zExtrinsicHashParam }),
      querystring: z.object({
        withinDays: z.coerce.number().int().min(1).max(MAX_HASH_LOOKUP_DAYS).default(DEFAULT_HASH_LOOKUP_DAYS)
          .describe('How far back to search, in days. See the note above on why this is bounded.'),
      }),
      response: { 200: zExtrinsic, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { hash } = request.params
    const { withinDays } = request.query
    // Deliberately NOT memoised in-process, unlike its sibling below. Every hash
    // is a distinct key, so this route alone would churn the shared 5,000-entry
    // LRU — at the rate limit one caller cycles the whole cache in ~17 minutes,
    // evicting entries that other endpoints DO reuse (/v1/assets and friends).
    // It buys nothing in exchange: a toast polls every 10 s, so a 3 s memo never
    // hits, and repeat 200s are already collapsed by the nginx micro-cache in
    // front (max-age 10). The uncached read is bounded on its own — a 7-day
    // partition-pruned lookup is ~5 MiB / 8 ms — which is what makes that safe.
    const found = await getExtrinsicByHash(opts.client, hash, withinDays)
    if (!found) {
      return reply.code(404).send(errorEnvelope('not_found', `no extrinsic ${hash} in the last ${withinDays} day(s); an older one is addressable as /v1/extrinsics/{blockHeight}/{index}`))
    }
    return found
  })

  // A distinct path SHAPE, not a format-sniffing sibling of the route above: a
  // hash is one segment and a position is two, so fastify's router separates them
  // and neither can shadow the other. A bare block height (one numeric segment)
  // therefore hits the hash route and is a 400 — an extrinsic needs its index.
  app.get('/v1/extrinsics/:blockHeight/:index', {
    schema: {
      tags: ['chain'],
      summary: 'One extrinsic by block height and index',
      description: [
        'The canonical identity of an extrinsic, and the unbounded-in-age counterpart of the hash lookup: (blockHeight, extrinsicIndex) is this model\'s primary key, so the read is a key lookup at any depth of history.',
        EXTRINSIC_DESCRIPTION,
      ].join('\n\n'),
      // Both are bound as ClickHouse UInt32, which wraps MOD 2^32 in silence
      // rather than erroring — 4294967300 would read block 4 and answer 200 for a
      // different extrinsic entirely. Capped at the edge, as `orderId` below and
      // MAX_BLOCK_NUMBER on the DexScreener routes are.
      params: z.object({
        blockHeight: z.coerce.number().int().min(0).max(4_294_967_295),
        index: z.coerce.number().int().min(0).max(4_294_967_295),
      }),
      response: { 200: zExtrinsic, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { blockHeight, index } = request.params
    const found = await cached(`pub:extrinsic:at:${blockHeight}:${index}`, 3_000, () => getExtrinsicAt(opts.client, blockHeight, index))
    if (!found) return reply.code(404).send(errorEnvelope('not_found', `no extrinsic ${blockHeight}-${index}`))
    return found
  })

  app.get('/v1/otc/orders/:orderId', {
    schema: {
      tags: ['chain'],
      summary: 'One OTC order and its fill history',
      description: OTC_DESCRIPTION,
      params: z.object({ orderId: z.coerce.number().int().min(0).max(4_294_967_295) }),
      response: { 200: zOtcOrder, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const { orderId } = request.params
    const order = await cached(`pub:otc:order:${orderId}`, 3_000, () => getOtcOrder(opts.client, orderId))
    if (!order) return reply.code(404).send(errorEnvelope('not_found', `no OTC order ${orderId}`))
    return order
  })

  app.get('/v1/staking/events', {
    schema: {
      tags: ['chain'],
      summary: 'Staking pallet event streams, oldest first',
      description: STAKING_DESCRIPTION,
      querystring: zStakingQuery,
      response: { 200: zPage(zStakingEvent), 400: zError },
    },
  }, async request => {
    const { limit, offset, fromBlock, toBlock } = request.query
    const types = parseStakingTypes(request.query.types)
    if (fromBlock != null && toBlock != null && toBlock < fromBlock) throw badRequest('toBlock must not be below fromBlock')
    const key = `pub:staking:events:${types.slice().sort().join(',')}:${fromBlock ?? ''}:${toBlock ?? ''}:${limit}:${offset}`
    return cached(key, 10_000, () => queryStakingEvents(opts.client, {
      types,
      fromBlock: fromBlock ?? null,
      toBlock: toBlock ?? null,
      limit,
      offset,
    }))
  })
}
