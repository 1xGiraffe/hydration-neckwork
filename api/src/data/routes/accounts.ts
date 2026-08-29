import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import {
  errorEnvelope, feedPage, requireCursor, requirePositionCursor, zAccountRef, zAssetId, zCursor, zError,
  zFeedPage, zIsoTimestamp, zLimit, zOrder, zTimeParam,
} from '../schemas/common.ts'
import { liveHeadTag, notFoundContext } from '../services/head.ts'
import { extrinsicsFeed } from '../services/chainCore.ts'
import {
  accountBalances, accountEvents, accountSummary, accountTransfers, balanceHistory,
} from '../services/accountsCore.ts'
import { zExtrinsicItem } from './extrinsicsShared.ts'
import { UNSEEN_IS_EMPTY, requireParsedAddress, windowKey, zAccountFeedQuery, zAccountParams } from './accountsShared.ts'

const zSummary = z.object({
  account: zAccountRef,
  identity: z.object({
    display: z.string(),
    verified: z.boolean(),
    chain: z.string().describe('Which identity chain the display name comes from (hydration, polkadot-people, …).'),
  }).nullable(),
  tags: z.array(z.object({ labelId: z.string(), name: z.string() }))
    .describe('Code-defined system tags (exchanges, treasuries, protocol accounts). Chain-derived; user tags are never exposed.'),
  firstSeen: zIsoTimestamp.nullable().describe('Time of the first indexed event naming the account — any pallet, any asset.'),
  firstSeenBlock: z.number().int().nullable(),
  lastSeen: zIsoTimestamp.nullable().describe('Time of the newest indexed event naming the account.'),
  lastSeenBlock: z.number().int().nullable(),
})

const zBalanceItem = z.object({
  assetId: zAssetId,
  symbol: z.string(),
  decimals: z.number().int(),
  kind: z.enum(['substrate', 'erc20', 'atoken', 'vdebt'])
    .describe('substrate: pallet balances/tokens. erc20: EVM wallet balance (HOLLAR & co). atoken: money-market supply, stated in redeemable underlying. vdebt: money-market variable debt owed, in underlying units.'),
  amount: z.string().describe('Raw integer in the asset\'s native decimals. For atoken/vdebt: the CURRENT underlying value (scaled balance × live reserve index).'),
  free: z.string().nullable(),
  reserved: z.string().nullable(),
  valueUsd: z.string().nullable().describe('At the CURRENT price (balances are positions, not flows); null when the asset has no fresh price.'),
})

const zBalanceTotals = z.object({
  assetsUsd: z.string().describe('Everything held (substrate, ERC-20, supplied money-market positions) at current prices, priced items only.'),
  debtUsd: z.string().describe('Variable debt owed, at current prices.'),
  netUsd: z.string().describe('assetsUsd − debtUsd; negative when the debt exceeds the priced holdings.'),
})

const zHistoryPoint = z.object({
  intervalStart: zIsoTimestamp,
  balance: z.string().describe('Raw integer balance at the end of the interval.'),
  lastBlock: z.number().int(),
})

const zAccountEvent = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  eventName: z.string().describe('`Pallet.Event`.'),
  timestamp: zIsoTimestamp,
  assetId: zAssetId,
  amount: z.string().nullable(),
})

const zTransfer = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  direction: z.enum(['in', 'out', 'self']),
  from: zAccountRef.nullable(),
  to: zAccountRef.nullable(),
  assetId: zAssetId,
  amount: z.string(),
  valueUsd: z.string().nullable().describe('EVENT-TIME USD (the last closed hourly candle before the transfer, ≤30 days stale); null when the asset had no usable price then.'),
})

export const accountsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/accounts/:address', {
    schema: {
      tags: ['accounts'],
      summary: 'Account summary',
      description: [
        'On-chain identity (highest-priority display across the identity chains the index snapshots), code-defined system tags, and the first/last indexed event naming the account across every pallet and asset. Input accepts SS58 (any prefix), H160, or 0x-prefixed public-key hex; the response carries the canonical form.',
        'A 404 means the address is VALID but nothing in the index has ever named it — the context carries the indexed head. An unparseable address is a 400.',
      ].join('\n\n'),
      params: zAccountParams,
      response: { 200: zSummary, 400: zError, 404: zError },
    },
  }, async (request, reply) => {
    const parsed = requireParsedAddress(request.params.address)
    const summary = await cached(`data:accounts:summary:${parsed.accountId}`, 10_000, () => accountSummary(opts.client, parsed))
    if (!summary) {
      return reply.code(404).send(errorEnvelope('not_found', `${parsed.address} is a valid address but has never been seen on Hydration`,
        await notFoundContext(opts.client, { hint: 'list endpoints under /v1/accounts/{address}/ answer 200 with empty items for such an address' })))
    }
    return summary
  })

  app.get('/v1/accounts/:address/balances', {
    schema: {
      tags: ['accounts'],
      summary: 'Current balances: substrate, ERC-20, and money-market positions',
      description: [
        'Three composed sources, deliberately separate kinds: substrate pallet balances, EVM wallet (ERC-20) balances, and money-market positions reconstructed from the scaled-balance anchor plus indexed deltas times the live reserve index (integer arithmetic end to end). A supplied asset does NOT appear as a substrate balance — it appears as its `atoken` row; variable debt appears as `vdebt`.',
        'USD values are at the current price (the same freshness rule as /v1/assets: a feed older than 30 days prices nothing), and `totals` sums the priced items exactly. ' + UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      response: { 200: z.object({ items: z.array(zBalanceItem), totals: zBalanceTotals }), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    return cached(`data:accounts:balances:${parsed.accountId}`, 5_000, () => accountBalances(opts.client, parsed))
  })

  app.get('/v1/accounts/:address/balances/history', {
    schema: {
      tags: ['accounts'],
      summary: 'Balance history of one asset, hourly or weekly',
      description: [
        'End-of-interval balances from the hourly/weekly aggregates. `asset` is required — the backing keys are (account, asset, interval), so one asset\'s history is a key-range read.',
        'Intervals with no observation are absent, not zero: the balance only changes when an observation lands, so a consumer should carry the last seen value forward. ' + UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: z.object({
        asset: zAssetId,
        bucket: z.enum(['hour', 'week']).default('hour'),
        limit: zLimit,
        cursor: zCursor,
        order: zOrder,
        fromTime: zTimeParam.optional(),
        toTime: zTimeParam.optional(),
      }),
      response: { 200: zFeedPage(zHistoryPoint), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { asset, bucket, limit, order, fromTime, toTime } = request.query
    const cursorTime = requireCursor(request.query.cursor, ['t'])?.t ?? null
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:balhist:${parsed.accountId}:${asset}:${bucket}:${order}:${fromTime ?? ''}:${toTime ?? ''}:${cursorTime ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 60_000, () => balanceHistory(opts.client, parsed, { bucket, assetId: asset, limit, order, cursorTime, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ t: Math.floor(Date.parse(last.intervalStart) / 1000) }))
  })

  app.get('/v1/accounts/:address/events', {
    schema: {
      tags: ['accounts'],
      summary: 'Raw event references naming the account',
      description: [
        '**Unclassified raw references**: every indexed event whose arguments name this account, exactly as emitted. One economic action commonly appears as SEVERAL events (a swap emits per-hop fills, transfers, fee events), so this feed over-counts "actions" by design — it exists for completeness and custom classification. For classified domain views use the domain feeds (/transfers, /trades, /liquidity, …).',
        'Filters: `name=` (exact Pallet.Event), `asset=`. ' + UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery.extend({
        name: z.string().max(80).optional(),
        asset: zAssetId.optional(),
      }),
      response: { 200: zFeedPage(zAccountEvent), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, name, asset, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:events:${parsed.accountId}:${order}:${name ?? ''}:${asset ?? ''}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountEvents(opts.client, parsed, { limit, order, cursor, name, assetId: asset, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/extrinsics', {
    schema: {
      tags: ['accounts'],
      summary: 'Extrinsics signed by the account',
      description: 'The account-first projection indexes the signatory AND the effective signer, so an EVM account\'s transactions appear under both identities. Same row shape as /v1/extrinsics. ' + UNSEEN_IS_EMPTY,
      params: zAccountParams,
      querystring: zAccountFeedQuery.extend({
        success: z.enum(['true', 'false']).optional(),
        call: z.string().max(80).optional().describe('Filter by `Pallet.call` — key-pruned here, no window needed.'),
      }),
      response: { 200: zFeedPage(zExtrinsicItem), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, success, call, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:extrinsics:${parsed.accountId}:${order}:${success ?? ''}:${call ?? ''}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => extrinsicsFeed(opts.client, {
      limit, order, cursor, signer: parsed,
      success: success == null ? undefined : success === 'true',
      call: call || undefined,
      fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.extrinsicIndex }))
  })

  app.get('/v1/accounts/:address/transfers', {
    schema: {
      tags: ['accounts'],
      summary: 'Token transfers touching the account',
      description: [
        'Balances/Tokens/Currencies transfer events where the account is sender or receiver, account-first at any depth. `direction=in|out` filters on the account\'s side; a self-transfer reports `self` and matches either filter. `valueUsd` is event-time (a later price change never rewrites it).',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery.extend({
        direction: z.enum(['in', 'out']).optional(),
        asset: zAssetId.optional(),
      }),
      response: { 200: zFeedPage(zTransfer), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, direction, asset, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:transfers:${parsed.accountId}:${order}:${direction ?? ''}:${asset ?? ''}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountTransfers(opts.client, parsed, { limit, order, cursor, direction, assetId: asset, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })
}
