import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { feedPage, requirePositionCursor, zAssetId, zError, zFeedPage, zIsoTimestamp } from '../schemas/common.ts'
import { liveHeadTag } from '../services/head.ts'
import {
  accountDcaEvents, accountFees, accountLiquidations, accountLiquidity,
  accountOtcCalls, accountOtcFills, accountStaking, accountTrades, accountXcm,
  moneyMarketActivity, moneyMarketPositions,
} from '../services/accountsDefi.ts'
import { dcaSchedules } from '../services/dcaData.ts'
import { votesForVoter } from '../services/governance.ts'
import { liquidityPositions } from '../services/lpPositions.ts'
import { UNSEEN_IS_EMPTY, inWindow, requireParsedAddress, windowKey, zAccountFeedQuery, zAccountParams } from './accountsShared.ts'
import { PRE_ROUTER_NOTE, zSchedule } from './dcaShared.ts'
import { zOtcEvent } from './otcShared.ts'
import { zStakingEvent } from './stakingShared.ts'
import { zFillFeeLeg } from './tradesShared.ts'
import { VOTES_DESCRIPTION, voteCursorPage, zVoteItem } from './votesShared.ts'

// The account fold lists the newest schedules whole; an owner with more than
// this (DCA bots run thousands — the largest owns 1,810, which at 1000 made a
// 400 KB response) is told so and pointed at the paged listing.
const ACCOUNT_SCHEDULES_CAP = 100

const zTradeAmount = z.object({ assetId: zAssetId, amount: z.string() })

const zTrade = z.object({
  opKey: z.string().nullable().describe('The Router operation id grouping a multi-hop route\'s fills; null for a direct pallet swap, which nets by its own event.'),
  blockHeight: z.number().int(),
  eventIndex: z.number().int().describe('The first fill event of the trade — with blockHeight, its stable identity.'),
  timestamp: zIsoTimestamp,
  venues: z.array(z.string()),
  inputs: z.array(zTradeAmount).describe('What the account paid, netted per asset across the route\'s fills.'),
  outputs: z.array(zTradeAmount),
  fees: z.array(zFillFeeLeg).describe('Fee legs RESTATE value the in/out legs already carry — a revenue breakdown, never extra flow. Do not add them to the trade\'s value. The same leg shape the fill feeds publish.'),
  valueUsd: z.string().nullable().describe('Event-time USD: max of the priced in-side and out-side at the last closed hourly candle (≤30 days stale); null when no leg had a usable price.'),
})

const zDcaEvent = z.object({
  scheduleId: z.number().int(),
  eventName: z.string(),
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  amountIn: z.string().nullable(),
  amountOut: z.string().nullable(),
  plannedBlock: z.number().int().nullable(),
  error: z.string().nullable().describe('DCA.TradeFailed\'s dispatch error as raw JSON.'),
})

const zOtcCall = z.object({
  blockHeight: z.number().int(),
  extrinsicIndex: z.number().int(),
  hash: z.string(),
  timestamp: zIsoTimestamp,
  callName: z.string(),
  success: z.boolean(),
})

// An OTC order event as /v1/otc/orders/{id} publishes it, plus its order.
const zOtcFill = zOtcEvent.extend({ orderId: z.number().int() })

const zLiquidityItem = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  assetId: zAssetId,
  amount: z.string().nullable(),
  amountA: z.string().nullable(),
  assetB: zAssetId.nullable(),
  poolAccount: z.string().nullable(),
  assetRefs: z.array(zAssetId),
})

const zLpLeg = z.object({
  assetId: zAssetId,
  amount: z.string().describe('Raw integer units of assetId the position redeems to at the snapshot\'s pool state.'),
  valueUsd: z.string().nullable().describe('At the current price; null when the asset has no fresh price.'),
})

const zLpPosition = z.object({
  venue: z.enum(['omnipool', 'stableswap', 'xyk']),
  farmed: z.boolean().describe('Held through a liquidity-mining deposit (Omnipool: collection-2584 deposit NFT; XYK: farm principal) rather than directly.'),
  positionId: z.string().nullable().describe('The Omnipool position NFT id; null for fungible pool shares.'),
  poolKey: z.string().describe("The venue's own pool key, as on the fill feeds: 'omnipool', a stableswap pool id, an XYK pool account."),
  shareAssetId: zAssetId.nullable().describe('The LP share token (a stableswap pool\'s share asset is its pool id; an XYK pool\'s its LP asset); null for an Omnipool position.'),
  shares: z.string().describe('Raw shares held (Omnipool: the position\'s shares; stableswap/XYK: the share-token amount or farmed principal).'),
  legs: z.array(zLpLeg).describe('What redeeming the whole position now returns: Omnipool positions carry their asset leg plus an H2O (asset 1) leg when the pool price moved against the entry price; stableswap and XYK redeem pro-rata over every reserve.'),
  valueUsd: z.string().nullable().describe('Sum of the legs at current prices; null when any leg is unpriced.'),
})

const zXcmItem = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  extrinsicIndex: z.number().int().nullable(),
  extrinsicHash: z.string().nullable().describe('Hash of the carrying extrinsic; null for a block-hook row.'),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  direction: z.enum(['in', 'out', 'other']),
  assetId: zAssetId,
  amount: z.string().nullable(),
})

const zMmPosition = z.object({
  poolAddress: z.string(),
  marketKey: z.string().nullable().describe("'core' (primary), 'gigahdx', 'bil', … Markets are ISOLATED: never combine health factors or totals across pools."),
  totalCollateralBase: z.string(),
  totalDebtBase: z.string(),
  availableBorrowsBase: z.string(),
  liquidationThreshold: z.string(),
  ltv: z.string(),
  healthFactor: z.string().describe('1e18-scaled; the max-uint sentinel means "no debt".'),
  blockHeight: z.number().int(),
  timestamp: zIsoTimestamp,
})

const zMmActivity = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  eventName: z.string(),
  assetAddress: z.string().nullable(),
  poolAddress: z.string().nullable(),
  amount: z.string().nullable(),
  liquidatedCollateralAmount: z.string().nullable(),
})

const zLiquidation = z.object({
  blockHeight: z.number().int(),
  eventIndex: z.number().int(),
  timestamp: zIsoTimestamp,
  poolAddress: z.string(),
  assetAddress: z.string(),
  liquidatedCollateralAmount: z.string(),
})

const zFeeRow = z.object({
  bucket: zIsoTimestamp.describe('The calendar month start (UTC).'),
  stream: z.string(),
  amountUsd: z.string().describe('Event-time-valued USD, 2 decimals — the same row shape /v1/stats/revenue publishes.'),
})

export const accountsDefiRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/accounts/:address/trades', {
    schema: {
      tags: ['accounts'],
      summary: 'Trades the account made, netted per routed operation',
      description: [
        'One item per TRADE: a multi-hop route\'s per-venue fills are grouped by their Router operation id and netted per asset, so intermediate hops cancel; a direct pallet swap stands alone. Swaps dispatched FOR the account by a block hook (DCA executions, scheduled trades) are attributed to the account, not the dispatcher.',
        '`valueUsd` is EVENT-TIME (the last closed hourly candle before the fill, ≤30 days stale) — a later price change never rewrites it. Fee legs restate value the in/out legs already carry; they are itemized for fee analysis and never counted into `valueUsd`.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zTrade), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:trades:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountTrades(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/dca', {
    schema: {
      tags: ['accounts'],
      summary: 'The account\'s DCA schedules and execution events',
      description: [
        `The account's newest schedules (the same objects /v1/dca/schedules lists; at most ${ACCOUNT_SCHEDULES_CAP} — \`hasMoreSchedules\` says when the account has more, and /v1/dca/schedules?owner= pages the full set), plus a cursor feed of its DCA events (executions, failures, completions, terminations). Execution history per schedule is also addressable as /v1/dca/schedules/{id}/executions.`,
        PRE_ROUTER_NOTE,
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: {
        200: z.object({
          schedules: z.array(zSchedule),
          hasMoreSchedules: z.boolean().describe(`True when the account has more than the ${ACCOUNT_SCHEDULES_CAP} schedules listed; page them via /v1/dca/schedules?owner=.`),
          events: zFeedPage(zDcaEvent),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const [schedules, events] = await Promise.all([
      cached(`data:accounts:dca-schedules:${parsed.accountId}:${head}`, 5_000,
        () => dcaSchedules(opts.client, { limit: ACCOUNT_SCHEDULES_CAP, order: 'desc', cursorId: null, ownerAccountId: parsed.accountId })),
      cached(`data:accounts:dca-events:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`, 5_000,
        () => accountDcaEvents(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime })),
    ])
    return {
      schedules: schedules.items,
      hasMoreSchedules: schedules.hasMore,
      events: feedPage(events.items, events.hasMore, last => ({ b: last.blockHeight, i: last.eventIndex })),
    }
  })

  app.get('/v1/accounts/:address/otc', {
    schema: {
      tags: ['accounts'],
      summary: 'The account\'s signed OTC calls',
      description: [
        'The cursor feed of the account\'s signed OTC.* extrinsics (placements, fills, cancels — "Pull" in product copy). The fills this account executed as the taker are the /otc/fills feed beside this one.',
        'Order MAKER attribution is deliberately not offered: OTC.Placed does not name the maker on chain, and the indexed models do not restate it here. Resolve an order\'s lifecycle via /v1/otc/orders/{id}.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zOtcCall), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:otc-calls:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountOtcCalls(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.extrinsicIndex }))
  })

  app.get('/v1/accounts/:address/otc/fills', {
    schema: {
      tags: ['accounts'],
      summary: 'The OTC fills the account executed as taker',
      description: [
        'Every OTC.Filled / OTC.PartiallyFilled event where this account was the FILLER — the same order-event object /v1/otc/orders/{id} carries, plus its `orderId` — as a cursor feed with the window quartet.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zOtcFill), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:otc-fills:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountOtcFills(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/staking', {
    schema: {
      tags: ['accounts'],
      summary: 'Staking events naming the account',
      description: 'HDX staking and GIGAHDX events (Staking.*, GigaHdx.*, GigaHdxRewards.*, CollatorRewards.*) where the event names this account, with decoded `args` — the same items /v1/staking/events serves, scoped to one account. ' + UNSEEN_IS_EMPTY,
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zStakingEvent), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:staking:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 10_000, () => accountStaking(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/votes', {
    schema: {
      tags: ['accounts'],
      summary: 'Governance votes cast by the account',
      description: `${VOTES_DESCRIPTION}\n\nThe same feed as /v1/governance/votes?voter=, addressed under the account. ${UNSEEN_IS_EMPTY}`,
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zVoteItem), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const head = await liveHeadTag(opts.client)
    // One cached read per voter, shared with /v1/governance/votes.
    const votes = await cached(`data:governance:voter:${parsed.accountId}:${head}`, 10_000, () => votesForVoter(opts.client, parsed.accountId))
    const windowed = votes.filter(vote => inWindow(vote.item, request.query))
    return voteCursorPage(opts.client, windowed, request.query.cursor, request.query.limit, request.query.order)
  })

  app.get('/v1/accounts/:address/liquidity', {
    schema: {
      tags: ['accounts'],
      summary: 'Liquidity actions by the account',
      description: 'Omnipool/Stableswap/XYK liquidity adds and removals plus liquidity-mining reward claims, account-first. `assetRefs` names every asset the event references (both pool sides included). ' + UNSEEN_IS_EMPTY,
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zLiquidityItem), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:liquidity:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountLiquidity(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/liquidity/positions', {
    schema: {
      tags: ['accounts'],
      summary: 'Current liquidity positions, valued at what they redeem to now',
      description: [
        'Every open position the account holds across the three AMM venues, stated as the underlying it would receive by redeeming the whole position at the pool state of the per-block snapshot (`asOfBlock`): Omnipool position NFTs held directly or through a liquidity-mining deposit (the node\'s full-position removal, zero withdrawal fee), stableswap share tokens redeemed pro-rata over the pool\'s reserves, and XYK LP tokens (direct balance and open farm-deposit principal) redeemed pro-rata against the pool\'s reserves and total shares.',
        'USD is at CURRENT prices (positions are holdings, not flows); a leg whose asset has no fresh price is null and makes the position\'s `valueUsd` null. Omnipool and stableswap positions are read from live materialized views; XYK farm principal comes from the LP reconstruction the derivations service refreshes, so a deposit made in the last minutes may not show yet. Liquidity ACTIONS (adds, removals, reward claims) are the /liquidity feed.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      response: {
        200: z.object({
          items: z.array(zLpPosition),
          asOfBlock: z.number().int().describe('The pool-state snapshot block the legs were computed at.'),
          totals: z.object({ valueUsd: z.string().describe('Sum of every priced position, 2 decimals.') }),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    return cached(`data:accounts:lp-positions:${parsed.accountId}`, 10_000, () => liquidityPositions(opts.client, parsed))
  })

  app.get('/v1/accounts/:address/xcm', {
    schema: {
      tags: ['accounts'],
      summary: 'Cross-chain (XCM) events naming the account',
      description: [
        'The account\'s arm of the XCM event feed: deposit-family events landing on the account (`in`), withdraw/send events leaving it (`out`), and queue/barrier context (`other`). This is the per-source event record — cross-chain origins and destinations are NOT resolved on this surface, so a row says what happened on Hydration, not which chain it came from.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery.extend({
        direction: z.enum(['in', 'out']).optional(),
        asset: zAssetId.optional(),
      }),
      response: { 200: zFeedPage(zXcmItem), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, direction, asset, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:xcm:${parsed.accountId}:${order}:${direction ?? ''}:${asset ?? ''}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => accountXcm(opts.client, parsed, { limit, order, cursor, direction, assetId: asset, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/money-market', {
    schema: {
      tags: ['accounts'],
      summary: 'Money-market positions and activity',
      description: [
        'Aggregate position per pool (the chain\'s own getUserAccountData observation, newest indexed) and the account\'s money-market event feed. Base amounts are the pool\'s base-currency units as reported; `healthFactor` is 1e18-scaled.',
        'The primary market and the isolated GIGAHDX/BIL markets are separate pools with separate positions — never blend their health factors or sum their totals.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: {
        200: z.object({ positions: z.array(zMmPosition), activity: zFeedPage(zMmActivity) }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const [positions, activity] = await Promise.all([
      cached(`data:accounts:mm-positions:${parsed.accountId}:${head}`, 5_000, () => moneyMarketPositions(opts.client, parsed)),
      cached(`data:accounts:mm-activity:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`, 5_000,
        () => moneyMarketActivity(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime })),
    ])
    return { positions, activity: feedPage(activity.items, activity.hasMore, last => ({ b: last.blockHeight, i: last.eventIndex })) }
  })

  app.get('/v1/accounts/:address/liquidations', {
    schema: {
      tags: ['accounts'],
      summary: 'Liquidations of the account\'s positions',
      description: 'Money-market LiquidationCall events where this account was the liquidated borrower. ' + UNSEEN_IS_EMPTY,
      params: zAccountParams,
      querystring: zAccountFeedQuery,
      response: { 200: zFeedPage(zLiquidation), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:liquidations:${parsed.accountId}:${order}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 10_000, () => accountLiquidations(opts.client, parsed, { limit, order, cursor, fromBlock, toBlock, fromTime, toTime }))
    return feedPage(items, hasMore, last => ({ b: last.blockHeight, i: last.eventIndex }))
  })

  app.get('/v1/accounts/:address/fees', {
    schema: {
      tags: ['accounts'],
      summary: 'Protocol revenue the account generated, by stream and month',
      description: [
        'Monthly protocol-revenue attribution (trade fees, network fees, borrow interest, liquidation penalties, …) with the account as PAYER, in USD at event time. Rows under the account\'s native and ETH-mapped identities are combined.',
        'This is the protocol\'s revenue FROM the account — not the account\'s income. ' + UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      response: { 200: z.object({ items: z.array(zFeeRow) }), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    return { items: await cached(`data:accounts:fees:${parsed.accountId}`, 60_000, () => accountFees(opts.client, parsed)) }
  })
}
