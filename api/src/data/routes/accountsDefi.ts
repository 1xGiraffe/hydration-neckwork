import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { badRequest, csv, feedPage, requirePositionCursor, zAssetId, zError, zFeedPage, zIsoTimestamp, zTimeParam, zWindowedFeedQuery } from '../schemas/common.ts'
import { bucketWindowIsClosed, windowKey } from '../services/feed.ts'
import { liveHeadTag } from '../services/head.ts'
import {
  accountDcaEvents, accountFees, accountLiquidations, accountLiquidity,
  accountOtcCalls, accountOtcFills, accountStaking, accountTrades, accountXcm,
  moneyMarketActivity, moneyMarketPositions,
} from '../services/accountsDefi.ts'
import { dcaSchedules } from '../services/dcaData.ts'
import { intentOrders } from '../services/intentData.ts'
import { votesForVoter } from '../services/governance.ts'
import { liquidityPositions } from '../services/lpPositions.ts'
import {
  BUCKET_HISTORY_CLOSED_TTL_MS, BUCKET_HISTORY_DEFAULT_BUCKETS, BUCKET_HISTORY_FINALITY_SEC, BUCKET_HISTORY_MAX_BUCKETS, BUCKET_HISTORY_SETTLING_TTL_MS,
  liquidityHistory, resolveBucketHistoryWindow,
} from '../services/lpHistory.ts'
import { knownMarketKeys, moneyMarketCurrentPositions, moneyMarketHistory } from '../services/moneyMarket.ts'
import { LP_HISTORY_POSITION_CAP, LP_VENUES, type LpVenue } from '../../services/lpHistory.ts'
import { LIQUIDITY_ACTIONS, type LiquidityAction } from '../services/uniswapV3Liquidity.ts'
import { UNSEEN_IS_EMPTY, inWindow, requireParsedAddress, zAccountParams } from './accountsShared.ts'
import { PRE_ROUTER_NOTE, zSchedule } from './dcaShared.ts'
import { INTENT_NOTE, zIntent, zIntentKind } from './intentsShared.ts'
import { zOtcEvent } from './otcShared.ts'
import { zStakingEvent } from './stakingShared.ts'
import { zLpLeg, zLpPositionIdentity, zLpRewardIdentity } from './liquidityShared.ts'
import { zMmMarketRef, zMmObservation, zMmPosition, zMmReserveIdentity, zMmRewardCurrent, zMmRewardPoint } from './moneyMarketShared.ts'
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
  eventName: z.string().describe('The pallet event (`Omnipool.LiquidityAdded`, …) or, for a concentrated-liquidity act, the contract class and log (`UniswapV3PositionManager.IncreaseLiquidity`, `UniswapV3Vault.Deposit`, `UniswapV3Pool.Mint`, …).'),
  action: z.enum(LIQUIDITY_ACTIONS as [LiquidityAction, ...LiquidityAction[]]).nullable().describe('The act: Add, Remove, CollectFees (a Uniswap v3 collect beyond the principal a same-extrinsic decrease/burn booked), Claim (a liquidity-mining reward), Create/Destroy (an XYK pool).'),
  assetId: zAssetId,
  amount: z.string().nullable(),
  amountA: z.string().nullable(),
  amountB: z.string().nullable().describe('The `assetB` side of a concentrated-liquidity act (token1); null for pallet events, which carry at most one amount.'),
  assetB: zAssetId.nullable(),
  poolAccount: z.string().nullable(),
  assetRefs: z.array(zAssetId),
  poolAddress: z.string().nullable().describe('The Uniswap v3 pool contract the act is in (the poolKey of the uniswapv3 venue); null for pallet events.'),
  tokenId: z.string().nullable().describe('The position NFT id for an act through the NonfungiblePositionManager.'),
  tickLower: z.number().int().nullable().describe('The position\'s tick range (manager and pool-direct acts).'),
  tickUpper: z.number().int().nullable(),
  vault: z.string().nullable().describe('The Gamma vault contract for a vault deposit/withdrawal.'),
  shares: z.string().nullable().describe('Vault shares minted or burned by the deposit/withdrawal, raw units.'),
})

const zLpPosition = zLpPositionIdentity.extend({
  shares: z.string().describe('Raw shares held (Omnipool: the position\'s shares; stableswap/XYK: the share-token amount or farmed principal; uniswapv3: the position\'s liquidity L; gamma: the vault-share balance).'),
  legs: z.array(zLpLeg).describe('What redeeming the whole position now returns: Omnipool positions carry their asset leg plus an H2O (asset 1) leg when the pool price moved against the entry price; stableswap and XYK redeem pro-rata over every reserve; a Uniswap v3 position states the principal left in it (increases − decreases of both tokens, uncollected fees excluded); a Gamma share redeems pro-rata over the vault\'s totals (its newest rebalance plus the deposits and withdrawals since).'),
  valueUsd: z.string().nullable().describe('Sum of the legs at current prices; null when any leg is unpriced. Unclaimed farm rewards are NOT in it (see unclaimedRewards).'),
  unclaimedRewards: z.array(zLpRewardIdentity.extend({
    amount: z.string().describe('Raw units one claim_rewards(depositId, yieldFarmId) would pay at `rewardsAsOfBlock`: the loyalty-adjusted reward less what the entry already claimed, and less any claim indexed since that block (a withdrawn entry reads 0).'),
    valueUsd: z.string().nullable().describe('At the current price; null when the reward asset has no fresh price, directly or through its underlying. "0.00" for an entry that is not `payable`.'),
    belowExistentialDeposit: z.boolean().describe('true when 0 < amount < the reward asset\'s existential deposit. Such a claim is paid only to an account that already holds at least that deposit of the asset; otherwise the runtime sends it to the treasury and the account receives nothing — and withdrawing the deposit forfeits it the same way. See `payable`.'),
    projected: z.boolean().describe('true when the amount is exact at `rewardsAsOfBlock`. false only for an ACTIVE farm whose projection to that block failed in the snapshot cycle: the amount is then as of the farm\'s last on-chain sync — a firm lower bound, never an estimate.'),
    payable: z.boolean().describe('Whether a claim now pays the account: false exactly when `belowExistentialDeposit` and the account\'s free balance of the reward asset at `rewardsAsOfBlock` is below that deposit too — the runtime would send the reward to the treasury. Such an entry keeps its `amount` but values at "0.00" and adds nothing to the totals.'),
  })).describe('Farmed positions only ([] otherwise): each farm entry of the deposit(s) behind the position. An Omnipool position carries its own deposit\'s entries; an XYK farmed position — the pool\'s whole farmed principal — every deposit of that pool. A separate claim, in a different asset, paid from the farm\'s pot: never folded into `legs` or `valueUsd`.'),
})

const zLpSpan = z.object({
  fromBlock: z.number().int().describe('First block the account held the position this way (ownership is [fromBlock, toBlock)).'),
  fromTime: zIsoTimestamp.nullable(),
  toBlock: z.number().int().nullable().describe('The block it stopped being held this way; null while it still is at the index head.'),
  toTime: zIsoTimestamp.nullable(),
  kind: z.enum(['direct', 'farmed']).describe('direct: the position NFT itself; farmed: through a liquidity-mining deposit.'),
})

const zLpHistoryPosition = zLpPositionIdentity.extend({
  farmed: z.boolean().describe('How the position was held at its LAST held bucket in the window. An Omnipool position moving between bare and farmed is one position whose `spans` carry every flip, so join it to /liquidity/positions without `farmed`; an XYK pool\'s direct and farmed holdings are two positions, told apart by it.'),
  spans: z.array(zLpSpan).describe('The exact ownership stretches overlapping the window (Omnipool NFTs bare and farmed, XYK farm deposits, Uniswap v3 position NFTs). Empty for fungible holdings — stableswap shares, direct XYK LP tokens, Gamma vault shares — whose record is the balance history.'),
  points: z.array(z.object({
    bucket: zIsoTimestamp.describe('The bucket\'s start; the value is as at its end.'),
    blockHeight: z.number().int().describe('The last block at or before the bucket end — the position and pool state the point is stated at.'),
    shares: z.string().describe('Raw shares held at the bucket end (Omnipool: the position\'s shares; stableswap/XYK: share-token balance or farmed principal; uniswapv3: liquidity L; gamma: vault-share balance).'),
    legs: z.array(zLpLeg),
    valueUsd: z.string().nullable().describe('Sum of the legs at the bucket\'s closed candle; null when any leg is unpriced. Unclaimed farm rewards are NOT in it (see unclaimedRewards).'),
    unclaimedRewards: z.array(zLpRewardIdentity.extend({
      amount: z.string().describe('Raw units one claim_rewards(depositId, yieldFarmId) would have paid at the bucket end, SETTLED: against the yield farm as of its last on-chain sync at or before blockHeight — the loyalty-adjusted reward since the entry, less what it had claimed by then. 0 once the yield farm is terminated.'),
      valueUsd: z.string().nullable().describe('At the reward asset\'s closed candle at the bucket end; null when it has none.'),
    })).describe('Farmed positions only ([] otherwise): each farm entry of the deposit(s) behind the position held at the bucket end. A separate claim, in a different asset, paid from the farm\'s pot: never folded into `legs` or `valueUsd`.'),
  })).describe('Only the buckets at whose end the position was held, ascending.'),
})

const zLpHistoryQuery = z.object({
  bucket: z.enum(['hour', 'day', 'week']).default('day').describe('`hour`, `day` (UTC days) or `week` (UTC weeks starting Monday, as on /balances/history).'),
  fromTime: zTimeParam.optional().describe('The first bucket is the first one STARTING at or after this instant (ISO-8601).'),
  toTime: zTimeParam.optional().describe('The last bucket is the one containing this instant, if it has ended (ISO-8601). A bucket contains its start and not its end, so a toTime exactly on a boundary selects the bucket STARTING there (toTime=2026-08-05T00:00:00Z with bucket=day ends the window at 2026-08-06T00:00:00Z).'),
  venue: z.string().max(80).optional().describe(`Comma-separated venues to include (${LP_VENUES.join(', ')}); default all.`),
  groupBy: z.enum(['position', 'account']).default('position').describe('`account` returns only the account line (`points`), without `positions`.'),
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
      querystring: zWindowedFeedQuery,
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
      querystring: zWindowedFeedQuery,
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

  app.get('/v1/accounts/:address/intents', {
    schema: {
      tags: ['accounts'],
      summary: 'The account\'s ICE intents (limit orders and DCA intents)',
      description: [
        INTENT_NOTE,
        'A cursor feed of the account\'s own submissions, read from the owner-first projection, newest first. These are the orders AS SUBMITTED — fold one order\'s status and fill totals from /v1/intents/{id}, and walk its life through /v1/intents/{id}/events.',
        'A dca intent placed by the pallet-DCA migration also appears here; its pre-migration history stays under /v1/dca/schedules.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zWindowedFeedQuery.extend({ kind: zIntentKind.optional() }),
      response: { 200: zFeedPage(zIntent), 400: zError },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { limit, order, kind, fromBlock, toBlock, fromTime, toTime } = request.query
    const cursor = requirePositionCursor(request.query.cursor)
    const head = await liveHeadTag(opts.client)
    const key = `data:accounts:intents:${parsed.accountId}:${order}:${kind ?? ''}:${windowKey(request.query)}:${cursor?.b ?? ''}:${cursor?.i ?? ''}:${limit}:${head}`
    const { items, hasMore } = await cached(key, 5_000, () => intentOrders(opts.client, {
      limit, order, cursor, ownerAccountId: parsed.accountId, kind, fromBlock, toBlock, fromTime, toTime,
    }))
    return feedPage(items, hasMore, last => ({ b: last.createdAtBlock, i: last.createdAtEventIndex }))
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
      querystring: zWindowedFeedQuery,
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
      querystring: zWindowedFeedQuery,
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
      querystring: zWindowedFeedQuery,
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
      querystring: zWindowedFeedQuery,
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
      description: [
        'Omnipool/Stableswap/XYK liquidity adds and removals plus liquidity-mining reward claims, account-first. `assetRefs` names every asset the event references (both pool sides included). ' + UNSEEN_IS_EMPTY,
        'Concentrated-liquidity (Uniswap v3) acts are in the same feed, restated from the pools\' EVM logs with the explorer\'s act rules: a position opened or closed through the NonfungiblePositionManager (`IncreaseLiquidity` → Add, `DecreaseLiquidity` → Remove, attributed to the NFT\'s holder at that moment, with the pool and tick range read from the pool log beside it), a manager `Collect` as CollectFees for what it paid BEYOND the principal a DecreaseLiquidity in the same extrinsic booked (a collect that only settled principal is not an act; a collect made in a later transaction than its decrease reports its whole payout), a Gamma vault `Deposit`/`Withdraw` for the beneficiary, and a pool\'s own `Mint`/`Burn`/`Collect` only when the owner is no announced manager or vault (a burn(0) poke never is). `assetId`/`amount` are token0, `assetB`/`amountB` token1; an act whose tokens the registry cannot name is omitted rather than published with an invented asset. A vault Rebalance is the operator\'s act and names no account.',
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zWindowedFeedQuery,
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
        'Every open position the account holds across the liquidity venues, stated as the underlying it would receive by redeeming the whole position: Omnipool position NFTs held directly or through a liquidity-mining deposit (the node\'s full-position removal, zero withdrawal fee), stableswap share tokens redeemed pro-rata over the pool\'s reserves, and XYK LP tokens (direct balance and open farm-deposit principal) redeemed pro-rata against the pool\'s reserves and total shares — these three at the pool state of the per-block snapshot (`asOfBlock`) — plus Uniswap v3 position NFTs (`uniswapv3`, the principal left in the position) and Gamma vault shares (`gamma`, pro-rata over the vault\'s totals), read from their own event projection.',
        'USD is at CURRENT prices (positions are holdings, not flows); a leg whose asset has no fresh price is null and makes the position\'s `valueUsd` null. Omnipool and stableswap positions are read from live materialized views; XYK farm principal comes from the LP reconstruction the derivations service refreshes, so a deposit made in the last minutes may not show yet. Liquidity ACTIONS (adds, removals, reward claims) are the /liquidity feed.',
        'Unclaimed liquidity-mining rewards ride on the farmed positions (`unclaimedRewards`) and sum into `totals.unclaimedRewardsUsd`, a figure SEPARATE from `totals.valueUsd`. The amount is the CLAIMABLE-NOW reward — what one claim would pay at `rewardsAsOfBlock` (loyalty multiplier applied, already-claimed rewards subtracted), not the full-loyalty maximum. It comes from a chain-state snapshot the explorer refreshes about every two minutes at a finalized block (active farms brought to that block by the runtime\'s own dry-run of a claim), so it trails the chain by that much; a stopped farm still pays what accrued before it stopped, a terminated one pays nothing. A claim indexed after `rewardsAsOfBlock` is subtracted from its entry (floored at zero) and a withdrawn entry reads 0, so a reward already moved into the wallet is not counted again. A claim smaller than the reward asset\'s existential deposit goes to the treasury, not the owner, when the owner holds less than that deposit of the asset: such an entry is flagged `belowExistentialDeposit` and `payable: false`, keeps its `amount`, and counts 0. A snapshot older than 15 minutes (the refresher failing for several cycles) is not served: `rewardsAsOfBlock` is then null.',
        'Rewards stay out of every position\'s `valueUsd` because they are a separate claim in a different asset, not part of the position. They ARE part of the account\'s value: the Explorer\'s account value, its directory ranking and the public `/v1/accounts/balances` `totalUsd` all count the claimable rewards, so the LP share of that value is `totals.valueUsd + totals.unclaimedRewardsUsd`. A reward is not a balance until claimed; a claim moves what it pays into the wallet (`/balances`), so the two never double count.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      response: {
        200: z.object({
          items: z.array(zLpPosition),
          asOfBlock: z.number().int().describe('The pool-state snapshot block the Omnipool, stableswap and XYK legs were computed at; concentrated-liquidity positions are read at the head of their own event projection.'),
          rewardsAsOfBlock: z.number().int().nullable().describe('The finalized block the unclaimed-reward snapshot was read at. null when no snapshot is available (none published yet, or it could not be read): every `unclaimedRewards` is then [] and says nothing about the account\'s rewards.'),
          totals: z.object({
            valueUsd: z.string().describe('Sum of every priced position, 2 decimals. Principal only.'),
            unclaimedRewardsUsd: z.string().describe('Sum of the account\'s priced, payable unclaimed farm rewards at current prices, 2 decimals — every farm entry of the account\'s deposits, including one whose position this response does not list yet ("0.00" when none or when `rewardsAsOfBlock` is null). Not part of valueUsd.'),
          }),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    return cached(`data:accounts:lp-positions:${parsed.accountId}`, 10_000, () => liquidityPositions(opts.client, parsed))
  })

  app.get('/v1/accounts/:address/liquidity/history', {
    schema: {
      tags: ['accounts'],
      summary: 'Liquidity positions per hour, day or week, valued at the bucket end',
      description: [
        `The account's liquidity positions across every venue on a fixed bucket grid, and their USD sum per bucket (\`points\`). A point is what redeeming the positions the account ECONOMICALLY held at the bucket's END would have returned — the same leg definitions as /liquidity/positions (Omnipool full-position removal with an H2O (asset 1) leg when the hub leg is non-zero; stableswap and XYK pro-rata over the reserves; a Uniswap v3 position's principal; a Gamma share pro-rata over the vault's totals) — at the pool state sampled at or before that end. Pool state history is a 600-block grid, so a point's pool state can be up to 600 blocks older than \`blockHeight\`, and it is never a state from after the bucket end. Economic ownership follows position-NFT transfers and liquidity-mining deposits: a farmed position is the account's even though the deposit NFT, not the position, is in its wallet.`,
        'Valuation: every leg at the newest candle that had fully CLOSED by the bucket end (hourly candles for `bucket=hour`, daily for `day`/`week`), carried forward at most 30 days, integer to the cent. It is NEVER back-filled from a later price: a leg with no close is null, its position\'s `valueUsd` is null, and the position is left out of the bucket\'s `valueUsd` and counted in its `unpriced` — never valued at zero. A position held at the bucket end whose legs cannot be stated at all — no pool state sampled at or before the end, or a Uniswap v3 token with no registry asset — is counted in `unpriced` too, with no point in `positions` at that bucket. So the last point is NOT the account\'s current LP value: that is /liquidity/positions (the per-block pool snapshot and current prices). Uniswap v3 fees earned but not collected are in no leg and in no figure here.',
        'Unclaimed farm rewards are a SEPARATE figure (`unclaimedRewards` on farmed position points, `unclaimedRewardsUsd` per account point), never in `legs` or `valueUsd`: what one claim_rewards would have paid at the bucket end — the loyalty-adjusted reward since entry less what the entry had claimed (claiming early forfeits nothing; only withdrawing does). They are SETTLED: each yield farm as of its last on-chain sync at or before the bucket end, which every deposit, claim or withdrawal on the farm performs, so an active farm\'s accrual since then is not yet in them. That is why the newest point can sit below /liquidity/positions\' `unclaimedRewards`, which the runtime projects to its snapshot block. Rewards are valued at the reward asset\'s closed candle like every leg; an entry whose reward cannot be stated or priced is counted in `rewardsIncomplete`, never valued at zero.',
        'Sources: Omnipool ownership and XYK farm principal come from the LP reconstruction the derivations service refreshes (about every ten minutes), so the newest bucket can lag a very recent deposit by one cycle. The exact per-event amount record — every add, removal and claim — is the /liquidity feed; this surface is the valued series.',
        `Window: \`fromTime\`/\`toTime\` select whole buckets (default the newest ${BUCKET_HISTORY_DEFAULT_BUCKETS} ENDED buckets); a bucket still open is never returned, and "ended" is judged by the INDEX: a bucket is returned once the indexed head block (/v1/status \`indexedHeadTime\`) is at or past its end, so while ingestion lags the newest bucket waits for it. At most ${BUCKET_HISTORY_MAX_BUCKETS} buckets per request — a longer span is a 400 naming the maximum; the window is the page (no cursor). \`from\`/\`to\` echo the resolved, step-aligned window. \`positions\` lists at most ${LP_HISTORY_POSITION_CAP} positions held at some bucket end in the window, largest value at its last held bucket first (unpriced last); \`positionsOmitted\` counts the rest, whose value is still in \`points\`. \`venue=\` narrows both.`,
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zLpHistoryQuery,
      response: {
        200: z.object({
          bucket: z.enum(['hour', 'day', 'week']),
          from: zIsoTimestamp.describe('Start of the first bucket.'),
          to: zIsoTimestamp.describe('End of the last bucket.'),
          points: z.array(z.object({
            bucket: zIsoTimestamp.describe('The bucket\'s start; the value is as at its end.'),
            blockHeight: z.number().int().describe('The last block at or before the bucket end.'),
            valueUsd: z.string().describe('Sum of every priced position held at the bucket end, 2 decimals.'),
            unpriced: z.number().int().describe('Positions held at the bucket end left out of valueUsd: a leg had no price, or the position\'s legs could not be stated (no pool state at or before the end, an unresolvable Uniswap v3 token).'),
            unclaimedRewardsUsd: z.string().describe('Sum of the priced unclaimed liquidity-mining rewards of every farm entry the account held at the bucket end (Omnipool and XYK farms, settled as in `unclaimedRewards`), 2 decimals — including entries whose position this response does not list. NOT part of valueUsd; a client wanting principal plus rewards adds the two.'),
            rewardsIncomplete: z.number().int().describe('Farm entries held at the bucket end left out of unclaimedRewardsUsd: the reward could not be stated (the entry\'s storage capture is not indexed yet, or its farm\'s inputs are incomplete), or the reward asset had no price. Never valued at zero.'),
          })),
          positions: z.array(zLpHistoryPosition).optional().describe('Absent for groupBy=account.'),
          positionsOmitted: z.number().int().optional().describe('Positions beyond the listed cap; absent for groupBy=account.'),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { bucket, fromTime, toTime, groupBy } = request.query
    const venueList = csv(request.query.venue)
    const unknown = venueList.filter(v => !(LP_VENUES as readonly string[]).includes(v))
    if (unknown.length) throw badRequest(`unknown venue: ${unknown.join(', ')} (expected ${LP_VENUES.join(', ')})`)
    const venues = venueList.length ? new Set(venueList as LpVenue[]) : undefined
    const { window, clock, headSec } = await resolveBucketHistoryWindow(opts.client, bucket, fromTime, toTime)
    // The key is the window, never the live head. The window cannot reach the
    // head — resolveBucketHistoryWindow returns only buckets the indexed head has
    // passed the end of, and a newly ended bucket is a new window, so a new key —
    // so no row it reads can still arrive at the head: it is not a live window.
    // What can still move it for a while is restatement of rows at or before its
    // end by sources on their own cadence: the derivations reconstructions (about
    // every ten minutes) and the closing candle's late rows. Those are the
    // closed-cadence sources a head key never hits on (a new key every ~6 s block
    // for a source that moves every ten minutes), so they take a plain short TTL,
    // equal to the route's own max-age: at most a minute behind a restatement.
    // Once the head is BUCKET_HISTORY_FINALITY_SEC past the end nothing restates it
    // short of a backfill, and it holds for ten minutes.
    const closed = bucketWindowIsClosed(window.to, headSec, BUCKET_HISTORY_FINALITY_SEC)
    const venueKey = venues ? [...venues].sort().join('+') : 'all'
    const key = `data:accounts:lp-history:${parsed.accountId}:${bucket}:${window.from}:${window.to}:${venueKey}:${groupBy}`
    return cached(key, closed ? BUCKET_HISTORY_CLOSED_TTL_MS : BUCKET_HISTORY_SETTLING_TTL_MS, () => liquidityHistory(opts.client, parsed, { bucket, window, clock, venues, groupBy }))
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
      querystring: zWindowedFeedQuery.extend({
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
        'Per-reserve supplied and borrowed amounts per market are /money-market/positions (current) and /money-market/history (per hour, day or week).',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: zWindowedFeedQuery,
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

  app.get('/v1/accounts/:address/money-market/positions', {
    schema: {
      tags: ['accounts'],
      summary: 'Current money-market positions per isolated market, per reserve',
      description: [
        'Every money market the account is in (the primary `core` market and the isolated ones — `gigahdx`, `bil` today; the set is per market, not a closed list), each with the account\'s reserves in it — what it supplies and what it owes, per underlying asset — beside the chain\'s own getUserAccountData for that market (`observation`: health factor, collateral/debt/available-borrows in the pool\'s base currency, LTV and liquidation threshold, as last indexed) and its E-mode category.',
        'Reserve amounts are the same rows /balances publishes as `atoken`/`vdebt`: the scaled principal (the chain\'s scaled balance at the anchor block B0 plus every indexed Mint/Burn/transfer since) times the reserve\'s LAST EMITTED index, truncating. They therefore trail the chain\'s balanceOf by the interest accrued since that reserve\'s last update — minutes on an active reserve, a tiny fraction of the amount; /money-market/history states amounts exact at each bucket\'s block instead. USD is at CURRENT prices (positions are holdings), null when the asset has no fresh price. `collateral` is the account\'s usage-as-collateral flag for the reserve (supplying is not collateralising); it is false while nothing is supplied.',
        'Markets are ISOLATED pools: each `observation` and each health factor belongs to its market alone — never blend, average or sum them. `totals` sums the priced reserve legs ACROSS markets for convenience only; it carries no health factor. `stakingBacked` marks a market (GIGAHDX) whose supplied collateral restates HDX locked in the owner\'s wallet: the Explorer leaves that side out of account value, and a client summing value should too.',
        'The `observation` is the chain\'s figure at its own `observedAtBlock` (read after each of the account\'s money-market events, and periodically for every borrower), never recomputed for the head: its base amounts use the Aave oracle, not our prices, so it does not equal the reserve rows\' USD.',
        'Unclaimed lending incentives ride on each market (`unclaimedRewards`) and sum into `totals.unclaimedRewardsUsd`, SEPARATE from the reserve totals. The amount is the CLAIMABLE-NOW reward per reward asset — the chain\'s own RewardsController.getAllUserRewards at `rewardsAsOfBlock`, read by a snapshot the explorer refreshes about every five minutes at the indexed head, so it trails the chain by that much. Beside it, `reconciled` says whether the indexed log arithmetic reproduces it to the unit, and `legs` gives that arithmetic\'s pending part per incentivized aToken. A RewardsClaimed indexed after `rewardsAsOfBlock` is subtracted from the amount (floored at zero), so an incentive already moved into the wallet is not counted again. An amount below the reward asset\'s existential deposit is flagged `belowExistentialDeposit` (a claim including it reverts until the account holds that deposit) and still counted. A reward whose programmes span several markets is listed under each market with that market\'s own amount. A snapshot older than 15 minutes is not served: `rewardsAsOfBlock` is then null and every `unclaimedRewards` is [].',
        'Rewards stay out of every reserve\'s USD: they are a claim in a different asset, not part of the position. They ARE part of the account\'s value: the Explorer\'s account value, its directory ranking and the public `/v1/accounts/balances` `totalUsd` count them. A reward is not a balance until claimed; a claim moves what it pays into the wallet (`/balances`), so the two never double count.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      response: {
        200: z.object({
          asOfBlock: z.number().int().describe('The indexed head the reserve rows were folded at: every Mint/Burn/transfer and every reserve index indexed at or before it.'),
          rewardsAsOfBlock: z.number().int().nullable().describe('The block the unclaimed-incentive snapshot was read at. null when no fresh snapshot is available (none published yet, older than 15 minutes, or unreadable): every `unclaimedRewards` is then [] and says nothing about the account\'s incentives.'),
          markets: z.array(zMmMarketRef.extend({
            role: z.enum(['primary', 'supplemental']).describe('`primary` for the core market; every isolated market is `supplemental`.'),
            observation: zMmObservation.nullable().describe('The newest indexed getUserAccountData for this market; null when none is indexed.'),
            eModeCategoryId: z.number().int().nullable().describe('The E-mode category the account last set in this market (0 = none); null when it never set one in the indexed history (events from 2024-11, with the pre-B0 EVM-log gaps /money-market/history names).'),
            reserves: z.array(zMmReserveIdentity.extend({
              supplied: z.string().describe('aToken balance at the settled index, raw units of assetId; "0" when only owed.'),
              borrowed: z.string().describe('Variable debt at the settled index, raw units of assetId; "0" when only supplied.'),
              suppliedUsd: z.string().nullable().describe('At the current price; null when unpriced ("0.00" when nothing is supplied).'),
              borrowedUsd: z.string().nullable().describe('At the current price; null when unpriced ("0.00" when nothing is owed).'),
              collateral: z.boolean().describe('Usage as collateral: the reserve\'s flag as last observed (the pool\'s Enabled/Disabled events and the swept bitmap read, whichever is newer); false while nothing is supplied.'),
            })).describe('Reserves the account supplies or owes in this market, largest current USD first, unpriced last.'),
            unclaimedRewards: z.array(zMmRewardCurrent).describe('Claimable lending incentives accruing on this market\'s aTokens, per reward asset (ascending id); [] when none or when `rewardsAsOfBlock` is null.'),
          })).describe('Markets with a reserve held, an observation showing collateral or debt, or a claimable incentive, primary first.'),
          totals: z.object({
            suppliedUsd: z.string().describe('Sum of the priced supplied legs across ALL markets (staking-backed included), 2 decimals — a sum of isolated positions, not a combined position.'),
            borrowedUsd: z.string().describe('Sum of the priced borrowed legs across all markets, 2 decimals.'),
            unclaimedRewardsUsd: z.string().describe('Sum of the priced claimable incentives at current prices, 2 decimals ("0.00" when none or when `rewardsAsOfBlock` is null). Not part of suppliedUsd.'),
          }),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const head = await liveHeadTag(opts.client)
    return cached(`data:accounts:mm-current:${parsed.accountId}:${head}`, 10_000, () => moneyMarketCurrentPositions(opts.client, parsed))
  })

  app.get('/v1/accounts/:address/money-market/history', {
    schema: {
      tags: ['accounts'],
      summary: 'Money-market positions per hour, day or week, exact at the bucket end',
      description: [
        'The account\'s money-market reserves on a fixed bucket grid, per isolated market, with the market\'s own getUserAccountData beside them. A reserve point is what the aToken\'s and the variable-debt token\'s balanceOf returned at `blockHeight` (the last block at or before the bucket end), interest accrued to that block: the scaled principal — the chain\'s scaled balance at the anchor block B0 plus every indexed Mint/Burn/BalanceTransfer since — times the reserve\'s last emitted index compounded to the block\'s timestamp with Aave\'s own interest arithmetic (linear for supply, the three-term compounded approximation for debt). An index update executed in a block\'s Initialization phase (a scheduled or DCA call) accrued to the PARENT block\'s timestamp, as on chain; a reserve whose last update cannot be resolved is left out of that bucket and counted in `unpriced`, never guessed. So the last point differs from /money-market/positions (settled index, current prices) by the interest since each reserve\'s last update and by price.',
        '`reserveHistoryFrom` is the coverage floor B0 (the scaled anchor): indexed EVM logs before it are incomplete, so a bucket ending before it has NO reserve figures — its `suppliedUsd`/`borrowedUsd` are null, never zero — while the observations run from their own first row (2024-11). null when no anchor is published: every reserve figure is then null.',
        'Valuation: every leg at the newest candle that had fully CLOSED by the bucket end (hourly candles for `bucket=hour`, daily for `day`/`week`), carried forward at most 30 days, integer to the cent, NEVER back-filled from a later price. A leg without a close is null, left out of the sums and counted in `unpriced`, never valued at zero. A market point\'s `netUsd` (supplied − borrowed) is published only when every held leg is priced.',
        '`observation` is the chain\'s getUserAccountData for that market as of its own `observedAtBlock` at or before the bucket end — health factor, collateral/debt/available-borrows in the pool\'s base currency, LTV, liquidation threshold — carried forward between reads (event-driven, plus a periodic re-read every borrower gets, typically every ~9–10k blocks). It is NEVER recomputed or interpolated for the bucket end: its prices are the Aave oracle\'s, not our candles, so it does not equal the reserve legs\' USD. Markets are ISOLATED: a health factor belongs to its market alone; never blend, average or sum them. An address is ONE holder here: its reserve legs, incentives and observations are all that one EVM identity\'s (the explorer\'s twin serves an account\'s whole related set, summing the legs and incentives of every identity while each market\'s observation stays ONE identity\'s — the account\'s primary H160 where it has one in that market — so a health factor is never a blend of positions). The account `points` sum priced legs ACROSS markets and carry no health factor; `stakingBacked` marks a market (GIGAHDX) whose supplied side restates HDX locked in the owner\'s wallet, which a client summing value filters out (the Explorer\'s account-value rule).',
        '`collateral` is the reserve\'s usage-as-collateral flag as last observed at or before the bucket end (the pool\'s Enabled/Disabled events and the swept bitmap read) — null when nothing had observed it by then, because the chain does not emit an event for every way the flag moves; false while nothing is supplied. `eModeCategoryId` is the last UserEModeSet at or before the end (0 = none), null before any. Both inherit the pre-B0 EVM-log gaps.',
        `Window: \`fromTime\`/\`toTime\` select whole buckets (default the newest ${BUCKET_HISTORY_DEFAULT_BUCKETS} ENDED buckets); a bucket still open is never returned, and "ended" is judged by the INDEX (/v1/status \`indexedHeadTime\`), exactly as on /liquidity/history. At most ${BUCKET_HISTORY_MAX_BUCKETS} buckets per request — a longer span is a 400 naming the maximum; the window is the page (no cursor). \`from\`/\`to\` echo the resolved window. \`market=\` narrows every figure to those markets. \`groupBy=market\` omits the per-reserve series, \`groupBy=account\` returns only \`points\`. A market carries a point only at buckets where it held a reserve, its observation showed collateral or debt, or it had unclaimed incentives; a reserve only where something was supplied or owed.`,
        'Unclaimed lending incentives are a SEPARATE figure (`unclaimedRewards` on market points, `unclaimedRewardsUsd` per account point), never inside suppliedUsd/borrowedUsd: what claimAllRewards would have paid at the bucket end, SETTLED — the RewardsController\'s stored accrual (its value at B0, read from the chain, plus every indexed Accrued less every RewardsClaimed) plus each incentivized aToken\'s pending accrual up to the programme\'s last on-chain index update at or before the end (every accrual, claim or transfer on the aToken updates it). An active programme\'s emission since that update is not yet in it, so the newest point can sit below /money-market/positions\' `unclaimedRewards` (the chain\'s own view at its snapshot block). Valued at the reward asset\'s closed candle like every leg. A reward the arithmetic cannot state — or one that does not reconcile with the chain in the current snapshot (an indexed log or balance gap for that account), or one without a price — is counted in `rewardsIncomplete`, never valued at zero. Before `reserveHistoryFrom` (B0, the incentive anchor\'s block too) `unclaimedRewardsUsd` is null.',
        'The exact per-event record — every supply, withdrawal, borrow, repayment and liquidation — is /money-market\'s activity feed and /liquidations; this surface is the valued series.',
        UNSEEN_IS_EMPTY,
      ].join('\n\n'),
      params: zAccountParams,
      querystring: z.object({
        bucket: z.enum(['hour', 'day', 'week']).default('day').describe('`hour`, `day` (UTC days) or `week` (UTC weeks starting Monday, as on /balances/history).'),
        fromTime: zTimeParam.optional().describe('The first bucket is the first one STARTING at or after this instant (ISO-8601).'),
        toTime: zTimeParam.optional().describe('The last bucket is the one containing this instant, if it has ended (ISO-8601). A bucket contains its start and not its end.'),
        market: z.string().max(120).optional().describe('Comma-separated market keys to include (`core`, `gigahdx`, `bil` today — every market the reserve map lists); default all. An unknown key is a 400 naming the known ones.'),
        groupBy: z.enum(['reserve', 'market', 'account']).default('reserve').describe('`reserve` (default): markets with their per-reserve series; `market`: markets without reserves; `account`: only the account line.'),
      }),
      response: {
        200: z.object({
          bucket: z.enum(['hour', 'day', 'week']),
          from: zIsoTimestamp.describe('Start of the first bucket.'),
          to: zIsoTimestamp.describe('End of the last bucket.'),
          reserveHistoryFrom: z.object({
            blockHeight: z.number().int(),
            time: zIsoTimestamp.nullable(),
          }).nullable().describe('The coverage floor B0 for reserve figures; null when no anchor is published.'),
          points: z.array(z.object({
            bucket: zIsoTimestamp.describe('The bucket\'s start; the figures are as at its end.'),
            blockHeight: z.number().int().describe('The last block at or before the bucket end — the block every reserve amount is stated at.'),
            suppliedUsd: z.string().nullable().describe('Sum of the priced supplied legs across the selected markets, 2 decimals; null for a bucket ending before reserveHistoryFrom.'),
            borrowedUsd: z.string().nullable().describe('Sum of the priced borrowed legs across the selected markets, 2 decimals; null before reserveHistoryFrom.'),
            unpriced: z.number().int().describe('Held legs (a reserve\'s supplied or owed side) left out of the sums: no closed candle, or an amount that could not be stated.'),
            unclaimedRewardsUsd: z.string().nullable().describe('Sum of the priced unclaimed incentives across the selected markets (settled, see above), 2 decimals; null before reserveHistoryFrom. NOT part of suppliedUsd.'),
            rewardsIncomplete: z.number().int().describe('(Holder, reward asset) incentive amounts owed at the bucket end but left out of unclaimedRewardsUsd: not statable, not reconciled with the chain now, or unpriced. Never valued at zero.'),
          })),
          markets: z.array(zMmMarketRef.extend({
            points: z.array(z.object({
              bucket: zIsoTimestamp,
              blockHeight: z.number().int(),
              suppliedUsd: z.string().nullable().describe('This market\'s priced supplied legs; null before reserveHistoryFrom.'),
              borrowedUsd: z.string().nullable().describe('This market\'s priced borrowed legs; null before reserveHistoryFrom.'),
              netUsd: z.string().nullable().describe('suppliedUsd − borrowedUsd, only when every held leg is priced and stated; else null.'),
              unpriced: z.number().int(),
              observation: zMmObservation.nullable().describe('The newest getUserAccountData at or before the bucket end; null when none is indexed by then.'),
              eModeCategoryId: z.number().int().nullable(),
              unclaimedRewards: z.array(zMmRewardPoint).describe('Unclaimed incentives listed under this market at the bucket end, per reward asset; [] when none.'),
            })),
            reserves: z.array(zMmReserveIdentity.extend({
              points: z.array(z.object({
                bucket: zIsoTimestamp,
                blockHeight: z.number().int(),
                supplied: z.string().describe('aToken balanceOf at blockHeight, raw units of assetId.'),
                borrowed: z.string().describe('Variable-debt balanceOf at blockHeight, raw units of assetId.'),
                suppliedUsd: z.string().nullable().describe('At the closed candle; null when unpriced ("0.00" when nothing is supplied).'),
                borrowedUsd: z.string().nullable().describe('At the closed candle; null when unpriced ("0.00" when nothing is owed).'),
                collateral: z.boolean().nullable(),
              })).describe('Only the buckets at whose end something was supplied or owed, ascending.'),
            })).optional().describe('Largest value at its last point first, unpriced last; absent for groupBy=market.'),
          })).optional().describe('Primary market first; absent for groupBy=account.'),
        }),
        400: zError,
      },
    },
  }, async request => {
    const parsed = requireParsedAddress(request.params.address)
    const { bucket, fromTime, toTime, groupBy } = request.query
    const marketList = csv(request.query.market)
    const known = await knownMarketKeys(opts.client)
    const unknown = marketList.filter(m => !known.includes(m))
    if (unknown.length) throw badRequest(`unknown market: ${unknown.join(', ')} (expected ${known.join(', ')})`)
    const markets = marketList.length ? new Set(marketList) : undefined
    const { window, clock, headSec } = await resolveBucketHistoryWindow(opts.client, bucket, fromTime, toTime, Date.now(), 'money-market history')
    // Keyed on the window, never the live head — /liquidity/history's rule and
    // reasoning: the window cannot reach the head, and what can restate it (late
    // candle rows) settles within BUCKET_HISTORY_FINALITY_SEC; the scaled anchor and
    // the MV-fed event tables restate nothing at or before an ended bucket. The one
    // input that moves after that is `rewardsIncomplete`'s reconciliation source:
    // which (holder, reward) pairs the NEWEST mm-incentives generation
    // (mm_incentive_snapshots, republished every few minutes) fails to reconcile.
    // A closed window follows a change to it within its TTL.
    const closed = bucketWindowIsClosed(window.to, headSec, BUCKET_HISTORY_FINALITY_SEC)
    const marketKey = markets ? [...markets].sort().join('+') : 'all'
    const key = `data:accounts:mm-history:${parsed.accountId}:${bucket}:${window.from}:${window.to}:${marketKey}:${groupBy}`
    return cached(key, closed ? BUCKET_HISTORY_CLOSED_TTL_MS : BUCKET_HISTORY_SETTLING_TTL_MS, () => moneyMarketHistory(opts.client, parsed, { bucket, window, clock, markets, groupBy }))
  })

  app.get('/v1/accounts/:address/liquidations', {
    schema: {
      tags: ['accounts'],
      summary: 'Liquidations of the account\'s positions',
      description: 'Money-market LiquidationCall events where this account was the liquidated borrower. ' + UNSEEN_IS_EMPTY,
      params: zAccountParams,
      querystring: zWindowedFeedQuery,
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
