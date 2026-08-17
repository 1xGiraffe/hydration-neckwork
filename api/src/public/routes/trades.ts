import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { csv, zAssetId, zHexAddress, zIsoTimestamp, zLimitOffset, zPage } from '../schemas/common.ts'
import { queryTrades } from '../services/trades.ts'

// Market swaps. See spec section "Trades / DCA" for the normative definitions.

// The global feed materialises its whole page window to deduplicate replay rows
// before cutting the page, so the offset bound is what bounds that window: 10,200
// narrow rows at the deepest page. A deeper page is a 400 rather than a slow request
// that ships tens of megabytes; the full history stays reachable through the
// `assets` and `swapper` filters.
//
// It bounds the GLOBAL feed only. A scoped request pages in SQL inside one account's
// primary-key prefix and never materialises a window, so the same bound would hide
// almost all of an active trader's history for no reason (measured on the busiest
// account: 851,699 net trades, 0.36 s at offset 100,000). Scoped requests keep the
// surface-wide `zLimitOffset` bound instead.
const MAX_TRADE_OFFSET = 10_000
// One request may filter on at most this many assets — a cost ceiling on the
// uncached path and a cardinality ceiling on the count cache's keys.
const MAX_ASSET_FILTERS = 20

const zTradeRow = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  timestamp: zIsoTimestamp,
  swapper: zHexAddress.nullable(),
  operationType: z.enum(['exactIn', 'exactOut']).nullable(),
  assetIn: zAssetId,
  amountIn: z.string(),
  assetOut: zAssetId,
  amountOut: z.string(),
  dca: z.object({ scheduleId: z.number().int() }).nullable(),
})

const zTradesQuery = zLimitOffset.extend({
  offset: zLimitOffset.shape.offset.describe(`Row offset. On the GLOBAL feed (no account parameter) at most ${MAX_TRADE_OFFSET}, the bound on the de-duplication window; a scoped feed pages the whole account.`),
  assets: z.string().optional().describe('Comma-separated registry ids; matches either side of the pair.'),
})

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/** The window bound is the global feed's alone; see MAX_TRADE_OFFSET. */
function checkOffset(account: string | null, offset: number): void {
  if (!account && offset > MAX_TRADE_OFFSET) {
    throw badRequest(`offset accepts at most ${MAX_TRADE_OFFSET} on the global feed, got ${offset}; scope the query to an account to page deeper`)
  }
}

function parseAssets(raw: string | undefined): string[] {
  const assets = csv(raw)
  if (assets.length > MAX_ASSET_FILTERS) {
    throw badRequest(`assets accepts at most ${MAX_ASSET_FILTERS} ids, got ${assets.length}`)
  }
  const parsed = z.array(zAssetId).safeParse(assets)
  if (!parsed.success) throw badRequest('assets must be decimal registry ids, e.g. assets=5,10')
  // Sorted and deduplicated, so the cache key is one entry per SET of assets.
  return [...new Set(parsed.data)].sort((a, b) => Number(a) - Number(b))
}

const ROW_DESCRIPTION = [
  'Newest first. ONE ROW PER USER-LEVEL TRADE: `swap_activity` holds both the router\'s net summary (assetIn→assetOut end to end) and the AMM event of every hop, and only the net row is returned — a 3-hop route is one trade in the pair the user named, never three trades in intermediate assets. Router hops, DCA keeper-fee legs and (before the router event rename at block 4,542,080) the AMM legs of DCA executions are excluded for the same reason.',
  '`amountIn`/`amountOut` are therefore the end-to-end legs (first input, last output) in raw on-chain integer units.',
  '`swapper` is resolved in order of authority: Broadcast.Swapped\'s swapper (the account the router traded FOR, which is the proxied or multisig account when the extrinsic ran on behalf of one), then the owner of the DCA execution the swap belongs to, then the extrinsic\'s signatory, then the pool event\'s own `who`. A hook-dispatched swap older than the Broadcast events (block 6,837,789) that no DCA execution claims reports null rather than being credited to a pallet.',
  '`operationType` is the side the user fixed: a pool event names it, a routed trade\'s call names it, and a batched or hook-dispatched route leaves it null rather than guessed.',
  '`dca` names the schedule a hook-dispatched execution belongs to, matched to its DCA.TradeExecuted event by block and per-trade amount.',
].join('\n\n')

const SCOPE_DESCRIPTION = [
  'With an address the query is scoped to the account-first model, which files a trade under the extrinsic\'s signatory (and its EVM effective signer); either half of a bound EVM identity finds the same trades. DCA executions are NOT in that model — they are the DCA path\'s rows — so a schedule owner sees them on the global feed and under /v1/dca, not here.',
  'Without an address the global feed is served. `totalCount` counts the same filter the page uses and is cached for 30 s per filter.',
].join('\n\n')

export const tradesRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  const serve = async (swapper: string | null, assets: string[], limit: number, offset: number) => {
    checkOffset(swapper, offset)
    const key = `pub:trades:${swapper ?? ''}:${assets.join(',')}:${limit}:${offset}`
    return cached(key, 3_000, () => queryTrades(opts.client, { swapper, assets, limit, offset }))
  }

  app.get('/v1/trades', {
    schema: {
      tags: ['trades'],
      summary: 'Market swaps, newest first',
      description: `${ROW_DESCRIPTION}\n\n${SCOPE_DESCRIPTION}`,
      querystring: zTradesQuery.extend({
        swapper: zHexAddress.optional().describe('Scope to one account. Omit for the global feed.'),
      }),
      response: { 200: zPage(zTradeRow) },
    },
  }, async request => {
    const { limit, offset } = request.query
    return serve(request.query.swapper ?? null, parseAssets(request.query.assets), limit, offset)
  })

  app.get('/v1/trades/routed', {
    schema: {
      tags: ['trades'],
      summary: 'Routed trades, newest first (equivalent to /v1/trades)',
      description: [
        'IDENTICAL to GET /v1/trades, with `participant` as the name of the account parameter. Both exist so the UI\'s two tabs map 1:1 onto the API; in this indexer they are the same query, because /v1/trades already returns the netted end-to-end view of each routed trade rather than its hops.',
        ROW_DESCRIPTION,
        SCOPE_DESCRIPTION,
      ].join('\n\n'),
      querystring: zTradesQuery.extend({
        participant: zHexAddress.optional().describe('Scope to one account. Omit for the global feed.'),
      }),
      response: { 200: zPage(zTradeRow) },
    },
  }, async request => {
    const { limit, offset } = request.query
    return serve(request.query.participant ?? null, parseAssets(request.query.assets), limit, offset)
  })
}
