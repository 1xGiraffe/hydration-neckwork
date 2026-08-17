import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import {
  DEX_KEY,
  DexScreenerRequestError,
  MAX_BLOCK_NUMBER,
  MAX_BLOCK_SPAN,
  MAX_EVENTS,
  RESERVE_GRID_BLOCKS,
  RESERVE_MAX_STALE_BLOCKS,
  dexScreenerAsset,
  dexScreenerEvents,
  dexScreenerPair,
  latestBlock,
  pairIdForms,
  parsePairIdShape,
  resolveAssetRef,
} from '../services/dexscreener.ts'

// The DexScreener DEX-adapter endpoints. Their field names and response
// envelopes are DexScreener's, not this API's — see the header of
// src/public/services/dexscreener.ts for the pinned source of the contract, the
// three deliberate deviations from the /v1 wire conventions (token-unit amounts,
// unix-second timestamps, no `items`/`totalCount` envelope) and every optional
// spec field this deployment cannot serve honestly.
//
// These routes live outside /v1 on purpose: /v1 is ours to version, while this
// surface must track whatever DexScreener's adapter spec says.

const ADAPTER = 'DexScreener adapter endpoint. Amounts are token-unit decimal strings and timestamps are unix seconds — DexScreener\'s conventions, not the /v1 ones.'

const COVERAGE = 'Swap coverage extends BELOW block 6,837,788 — the first block emitting the unified `Broadcast.Swapped` event — through the legacy per-pallet projections, back to block 1,708,104. Stableswap and XYK fills are served there, subject to the registry-gap skip above: measured in blocks 6,836,788..6,837,787, 45 of the window\'s 147 XYK fills are published and the 102 missing ones all sit in pools holding an asset the registry does not yet carry (the 9 of 34 pools with no such asset are complete). The Omnipool is the exception: a legacy Omnipool fill records the user\'s own two assets rather than the pair of hub hops behind them, so it carries no LRNA leg and cannot be published as an event on an asset/LRNA pair. Only a legacy fill whose own asset WAS LRNA has one — measured, 11,628 of 2,528,860 pre-boundary Omnipool fills (0.46%) — so treat Omnipool pair events as starting at the boundary.'

const PAIR_IDS = 'Pair ids are the PREVIOUS adapter\'s (`adapters.kril.hydration.cloud/dexscreener`) byte for byte, so an aggregator\'s existing per-pair history carries over a base-URL swap instead of every pair being seen as new. Three venue shapes: an XYK pair is the pool ACCOUNT alone (an XYK pool has exactly one registered pair, so the assets add nothing); an Omnipool pair is `<omnipool pallet account>-<asset0>-<asset1>`; a stableswap pair is `<pool account>-<asset0>-<asset1>`, the pool\'s on-chain account rather than its pool id. The two sides are ordered class-first — every plain registry id sorts before every contract-addressed asset, as an explicit flag rather than a comparison of the ids\' numeric values — then numerically within each class. That ordering decides which side is asset0 and therefore whether `priceNative` is a price or its reciprocal.'

const ASSET_IDS = 'An asset id is the on-chain registry id as a decimal string, EXCEPT for an ERC-20-registered asset, which is named by its 20-byte contract address (HOLLAR is `0x531a654d1696ed52e7275a8cede955e82620f99a`, not `222`) — again the previous adapter\'s convention. The mapping is derived from the asset registry\'s own `Registered`/`Updated` and `LocationSet` events, so a new listing needs no code change. `/asset` and `/pair` accept BOTH forms on input; every response names the contract form.'

const TXN_ID = 'TWO fields on this surface deliberately differ from the previous adapter\'s, and both are ordering-neutral for a consumer that reads the stream as emitted. '
  + '(1) `txnId` VALUES. Ours is `<block>-<extrinsicIndex>`, or `<block>-r<routerOperationId>` for a hook-dispatched route, or `<block>-e<eventIndex>`; all three are resolvable on this chain. The previous adapter publishes the fill\'s own chain operation id (the outermost non-DCA entry of the `Broadcast.Swapped*` `operationStack`) — reproducing it would mean projecting that id into `pool_swap_legs`, which today carries only the Router entry, and the legacy pre-`Broadcast` era has no operation stack at all. `txnId` is opaque to DexScreener, so only its grouping matters, and it groups the same fills.'
  + ' (2) `txnIndex` SEMANTICS. Ours is always 0, with `eventIndex` — unique and strictly increasing within a block across every dispatch phase — carrying the whole order, which is the true on-chain order. The previous adapter\'s `txnIndex` is a per-ROUTE hop counter that restarts at 0 inside each `txnId` group (measured: 0..n-1 in 229 of 229 groups), so it does not order a block across routes: sorting its own stream by `(txnIndex, eventIndex)` reorders what it emitted in 60 of 100 blocks. Consequently a consumer that sorts by `(txnIndex, eventIndex)` gets DIFFERENT sequences from the two feeds — measured, 60 of 100 blocks — e.g. block 13,596,009 becomes eventIndex 17, 38, 18, 39 there against the chain\'s 17, 18, 38, 39 here. This is a deliberate correction, not a match: two thirds of Hydration\'s fills are dispatched by block hooks with no extrinsic at all and sort after the block\'s extrinsic events, so no per-block transaction index can order the stream.'

const VENUES = 'Pairs cover the three AMM venues: Omnipool (every asset against the LRNA hub), stableswap (each pool\'s assets against each other and against the pool share token) and XYK. The `aave` (aToken mint/redeem, always 1:1), `otc` (per-order, not a pool) and `hsm` legs of the same trade model are deliberately not pairs.'

const SKIPPED_ASSETS = 'Fills touching an asset the on-chain registry does not yet carry are skipped rather than priced on an assumed scale — registration is permissionless, so an AssetHub external can trade here before its decimals are indexed, and without them every amount and `priceNative` on that fill would be a guess. Such an asset also 404s on `/dexscreener/asset` and its pairs 404 on `/dexscreener/pair`, so the three endpoints stay consistent.'

const NO_LIQUIDITY ='`join` and `exit` events are not served: the indexed liquidity events carry at most one side\'s amount, and a pair event needs both. See the service module for the per-event-name measurement.'

const zBlock = z.object({
  blockNumber: z.number().int().nonnegative(),
  blockTimestamp: z.number().int().nonnegative(),
})

/**
 * An asset id on the wire: the decimal registry id, or the 20-byte contract address
 * of an ERC-20-registered asset. The previous adapter names ERC-20 assets by their
 * contract, and DexScreener keys its history on whatever this field says, so the two
 * forms have to coexist rather than one being normalised away.
 */
const zAssetRef = z.string()
  .regex(/^(\d{1,10}|0x[0-9a-f]{40})$/i, 'expected a decimal asset id or a 0x-prefixed 20-byte contract address')

const zAsset = z.object({
  id: zAssetRef,
  name: z.string(),
  symbol: z.string(),
  metadata: z.object({ decimals: z.string() }),
})

const zPair = z.object({
  id: z.string(),
  dexKey: z.literal(DEX_KEY),
  asset0Id: zAssetRef,
  asset1Id: zAssetRef,
})

const zReserves = z.object({ asset0: z.string(), asset1: z.string() })

const zSwapEvent = z.object({
  block: zBlock,
  eventType: z.literal('swap'),
  txnId: z.string(),
  txnIndex: z.number().int().nonnegative(),
  eventIndex: z.number().int().nonnegative(),
  maker: z.string(),
  pairId: z.string(),
  priceNative: z.string(),
  asset0In: z.string().optional(),
  asset1In: z.string().optional(),
  asset0Out: z.string().optional(),
  asset1Out: z.string().optional(),
  reserves: zReserves.optional(),
})

/** An asset id in a query string, in either wire form, as DexScreener sends it. */
const zAssetIdQuery = z.object({ id: zAssetRef })

const zPairIdQuery = z.object({ id: z.string().min(1) })

/**
 * A block height in a query string.
 *
 * Validated as a STRING before it becomes a number, for two reasons a
 * `z.coerce.number()` cannot cover. `Number('')` is 0, so `?fromBlock=` would
 * silently mean "start at genesis" — here a blank or non-numeric value is a 400.
 * And the value is bound into the query as a ClickHouse `UInt32`, which wraps
 * MOD 2^32 without erroring, so anything above `MAX_BLOCK_NUMBER` must be
 * rejected at the edge rather than answered for a different window.
 */
const zBlockNumber = z.string()
  .regex(/^\d+$/, 'expected a decimal block number')
  .refine(v => v.length <= 10 && Number(v) <= MAX_BLOCK_NUMBER, `block number must be at most ${MAX_BLOCK_NUMBER}`)
  .transform(Number)

const zEventsQuery = z.object({
  fromBlock: zBlockNumber,
  toBlock: zBlockNumber,
})

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 })
}

export const dexscreenerRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/dexscreener/latest-block', {
    schema: {
      tags: ['dexscreener'],
      summary: 'Newest indexed block',
      description: [
        ADAPTER,
        'The head of the indexed chain, from the same source `/v1/status` reports. DexScreener only requests event windows at or below this height, so it is the read models\' own progress rather than the raw pipeline\'s checkpoint.',
      ].join('\n\n'),
      response: { 200: z.object({ block: zBlock }) },
    },
  }, async () => ({ block: await latestBlock(opts.client) }))

  app.get('/dexscreener/asset', {
    schema: {
      tags: ['dexscreener'],
      summary: 'Asset metadata by registry id',
      description: [
        ADAPTER,
        ASSET_IDS,
        'This is a SUBSET of what the previous adapter serves: the optional spec fields `totalSupply`, `circulatingSupply`, `coinGeckoId`, `coinMarketCapId` and `metadata.assetType` are omitted rather than guessed, because no per-asset issuance model, external catalogue id or asset-type column exists in this index. `/coingecko/v1/totalsupply` reconstructs a supply for four product tokens only; publishing it for those four and not the other ~119 registry assets would be less useful than omitting it everywhere.',
        'An id the registry does not know is a 404, never a synthesised placeholder token.',
      ].join('\n\n'),
      querystring: zAssetIdQuery,
      response: { 200: z.object({ asset: zAsset }) },
    },
  }, async request => {
    const forms = await pairIdForms(opts.client)
    const assetId = resolveAssetRef(forms, request.query.id)
    const asset = assetId == null ? null : dexScreenerAsset(assetId, forms)
    if (!asset) throw notFound(`no asset ${request.query.id}`)
    return { asset }
  })

  app.get('/dexscreener/pair', {
    schema: {
      tags: ['dexscreener'],
      summary: 'Pair metadata by pair id',
      description: [
        ADAPTER,
        PAIR_IDS,
        ASSET_IDS,
        VENUES,
        'Both legacy shapes are also ACCEPTED: a stableswap pool named by its decimal pool id, and an XYK pool named with `-<asset0>-<asset1>` appended. Either order of the two assets resolves. The response always reports the CANONICAL id, so a consumer that follows the id it reads back converges on the form `/events` publishes.',
        'The id is resolved against the pools that exist: a well-formed id whose pool does not hold both assets, or either of whose assets the registry cannot resolve, is a 404. The optional spec fields `createdAtBlockNumber`, `createdAtTxnId`, `creator`, `feeBps` and `pool` are omitted — pool creation is not projected per pair, and the Omnipool\'s fee is a dynamic per-asset value rather than a pair constant.',
      ].join('\n\n'),
      querystring: zPairIdQuery,
      response: { 200: z.object({ pair: zPair }) },
    },
  }, async request => {
    const { id } = request.query
    // An id this API could never have produced is the caller's error; a
    // well-formed id naming a pool that does not hold the pair is a real 404. The
    // two must not collapse, or a consumer cannot tell a broken cursor from a
    // delisted pair.
    if (!parsePairIdShape(id)) throw badRequest(`not a pair id: ${id}`)
    const pair = await dexScreenerPair(opts.client, id)
    if (!pair) throw notFound(`no pair ${id}`)
    return { pair }
  })

  app.get('/dexscreener/events', {
    schema: {
      tags: ['dexscreener'],
      summary: 'Swap events in a block range',
      description: [
        ADAPTER,
        `Every AMM swap fill with \`fromBlock <= block <= toBlock\`, ordered by block then event index. The range is inclusive and spans at most ${MAX_BLOCK_SPAN} blocks (~${MAX_EVENTS.toLocaleString('en-US')} events is the hard ceiling); a wider or denser range is a 400 asking for a narrower one, never a silently truncated page.`,
        PAIR_IDS,
        ASSET_IDS,
        TXN_ID,
        `\`reserves\` is the pool's state at the nearest sample AT OR BEFORE the fill's block. The state histories are sampled on a ${RESERVE_GRID_BLOCKS}-block grid — ≈1 h at the chain's present ~6 s block time, ≈20 min if it moves to 2 s — so that sample is normally one grid step old; past ${RESERVE_MAX_STALE_BLOCKS} blocks (two grid steps, whatever the block time) the field is omitted rather than publishing a stale reserve (a delisted Omnipool asset keeps its final sample forever). The bound is deliberately counted in blocks rather than in wall clock: the grid is block-counted too, so two grid steps means the same thing at any cadence. For an Omnipool pair the two sides are the asset's hub reserve and its own reserve; for a stableswap pair against the pool share token, the share side is the pool's total issuance.`,
        '`reserves` is also omitted when either side would read 0. A fill proves the pool held both assets, so a zero is an indexing artefact rather than the pool\'s state, and publishing it would report the pool as empty. This currently suppresses reserves for every HDX-quoted XYK pool: native HDX balances live in `System.Account` rather than `Tokens`, so the XYK reserve history reads 0 on the HDX side.',
        SKIPPED_ASSETS,
        VENUES,
        NO_LIQUIDITY,
        COVERAGE,
      ].join('\n\n'),
      querystring: zEventsQuery,
      response: { 200: z.object({ events: z.array(zSwapEvent) }) },
    },
  }, async request => {
    const { fromBlock, toBlock } = request.query
    try {
      return { events: await dexScreenerEvents(opts.client, fromBlock, toBlock) }
    } catch (err) {
      if (err instanceof DexScreenerRequestError) throw badRequest(err.message)
      throw err
    }
  })
}
