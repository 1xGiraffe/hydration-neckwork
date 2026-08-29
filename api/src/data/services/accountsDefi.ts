import type { ClickHouseClient } from '../../db/client.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { renderUsd, scaledUsd } from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'
import { accountRefOrNull, evmAccountForm, h160For, type AccountRef, type ParsedAddress } from './address.ts'
import { eventTimePricer } from './eventTimePrices.ts'
import { moneyMarketReserveState } from './accountsCore.ts'
import { otcEventType, type OtcEventType } from './otcData.ts'
import { stakingItem, type StakingEventItem, type StakingRow } from './stakingFeed.ts'
import {
  DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, versionedPageSql, windowSql,
  type Order, type PositionCursor, type WindowFilters,
} from './feed.ts'

// The per-account DeFi feeds: trades, DCA, OTC, staking, votes, liquidity,
// XCM, money market, liquidations, protocol fees. All account-first reads.

// ---------------------------------------------------------------------------
// Trades: pool_swap_legs_by_account netted per op_key.
// ---------------------------------------------------------------------------

export interface TradeAmount { assetId: string; amount: string }
// The same fee-leg shape the fill feeds publish (tradesShared.zFillFeeLeg).
export interface TradeFee extends TradeAmount { feeDest: string | null; feeRecipient: AccountRef | null }

export interface AccountTrade {
  opKey: string | null
  blockHeight: number
  eventIndex: number
  timestamp: string
  venues: string[]
  inputs: TradeAmount[]
  outputs: TradeAmount[]
  fees: TradeFee[]
  valueUsd: string | null
}

export interface AccountTradesOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

interface LegRow {
  venue: string
  block_height: number
  event_index: number
  leg_index: number
  leg_kind: 'in' | 'out' | 'fee'
  asset_id: number
  amount: string
  fee_dest: string
  fee_recipient: string
  op_key: string
  ts: string
}

interface TradeGroup {
  opKey: string
  block: number
  anchorEvent: number
  timeSec: number
  ts: string
  venues: Set<string>
  legs: LegRow[]
}

// A trade has 2-6 legs, so the leg bound is sized for a full page of chunky
// routed trades plus dedup slack; hitting the bound truncates at a block
// boundary so no trade is ever served half-netted.
function legBound(limit: number): number {
  return limit * 12 + 2 * DEDUP_SLACK
}

export async function accountTrades(client: ClickHouseClient, parsed: ParsedAddress, options: AccountTradesOptions): Promise<{ items: AccountTrade[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: legBound(options.limit) }
  // The cursor cuts at BLOCK granularity and drops already-served groups in
  // TS: a trade's legs share one block but not one event index, so an
  // event-level SQL cut could split a trade in half.
  let cursorSql = ''
  if (options.cursor) {
    params.cb = options.cursor.b
    cursorSql = ` AND block_height ${options.order === 'desc' ? '<=' : '>='} {cb:UInt32}`
  }
  // The key is (swapper, block, event, leg_kind, leg_index): reading it in ONE
  // direction is what lets ClickHouse stop at the bound (a mixed-direction
  // ORDER BY sorted the whole account — 8.1 M rows for one page of the
  // busiest swapper); legs are re-ordered per trade in TS anyway.
  const dir = options.order === 'desc' ? 'DESC' : 'ASC'
  const keyOrder = `block_height ${dir}, event_index ${dir}, leg_kind ${dir}, leg_index ${dir}`
  const res = await client.query({
    query: versionedPageSql(`-- data:accounts:trade-legs
        SELECT venue, block_height, event_index, leg_index, leg_kind, asset_id, amount,
               fee_dest, fee_recipient, op_key, toString(block_timestamp) AS ts, ingested_at
        FROM price_data.pool_swap_legs_by_account
        WHERE swapper = {account:String}${windowSql(options, params)}${cursorSql}
        ORDER BY ${keyOrder}
        LIMIT {bound:UInt32}`, keyOrder),
    query_params: params,
    format: 'JSONEachRow',
  })
  const raw = await res.json<LegRow>()
  const hitBound = raw.length >= legBound(options.limit)

  // Replay dedup on the leg identity, then group into trades.
  const seen = new Set<string>()
  const groups = new Map<string, TradeGroup>()
  for (const leg of raw) {
    const identity = `${leg.block_height}:${leg.event_index}:${leg.leg_kind}:${leg.leg_index}`
    if (seen.has(identity)) continue
    seen.add(identity)
    // op_key nets a routed trade across its per-venue fills; an unrouted fill
    // falls back to its own event identity.
    const key = leg.op_key !== '' ? `o:${leg.block_height}:${leg.op_key}` : `e:${leg.block_height}:${leg.event_index}`
    let group = groups.get(key)
    if (!group) {
      group = {
        opKey: leg.op_key, block: Number(leg.block_height), anchorEvent: Number(leg.event_index),
        timeSec: Math.floor(Date.parse(iso(leg.ts)) / 1000), ts: leg.ts, venues: new Set(), legs: [],
      }
      groups.set(key, group)
    }
    group.anchorEvent = Math.min(group.anchorEvent, Number(leg.event_index))
    group.venues.add(leg.venue)
    group.legs.push(leg)
  }

  let trades = [...groups.values()].sort((a, b) => (options.order === 'desc'
    ? b.block - a.block || b.anchorEvent - a.anchorEvent
    : a.block - b.block || a.anchorEvent - b.anchorEvent))
  // Drop groups the cursor page already served (same block, anchor at/past it).
  if (options.cursor) {
    const { b, i } = options.cursor
    trades = trades.filter(t => t.block !== b || (options.order === 'desc' ? t.anchorEvent < i : t.anchorEvent > i))
  }
  // When the leg read hit its bound, the boundary block may hold trades whose
  // remaining legs were cut off — drop that whole block from the page.
  if (hitBound && trades.length) {
    const boundaryBlock = trades[trades.length - 1].block
    trades = trades.filter(t => t.block !== boundaryBlock)
  }

  const hasMore = hitBound || trades.length > options.limit
  const page = trades.slice(0, options.limit)
  const priced = await priceTrades(client, page)
  return { items: priced, hasMore }
}

// Event-time USD for a page of trades (eventTimePrices.ts): the newest CLOSED
// 1h candle at each trade's time, share/aTokens aliased to their price feed.
// Fee legs are a revenue breakdown of value the in/out legs already carry —
// they are never added to the trade's value.
async function priceTrades(client: ClickHouseClient, trades: TradeGroup[]): Promise<AccountTrade[]> {
  const assetIds = new Set<number>()
  let minT = Infinity
  let maxT = -Infinity
  for (const trade of trades) {
    minT = Math.min(minT, trade.timeSec)
    maxT = Math.max(maxT, trade.timeSec)
    for (const leg of trade.legs) if (leg.leg_kind !== 'fee') assetIds.add(Number(leg.asset_id))
  }
  const pricer = trades.length ? await eventTimePricer(client, assetIds, minT, maxT) : null

  return trades.map(trade => {
    // Per-asset NET across the route's fills: a multi-hop trade's intermediate
    // assets (the hub, most often) appear as an out of one fill and the in of
    // the next, so summing sides without netting would count them into both
    // and roughly double `usdValue`. After the net, negative = what the
    // account truly paid, positive = what it truly received; intermediates
    // cancel to zero and disappear (the accountTradeVolume netting rule).
    const net = new Map<number, bigint>()
    const fees: TradeFee[] = []
    for (const leg of trade.legs) {
      const assetId = Number(leg.asset_id)
      const amount = BigInt(String(leg.amount || '0') || '0')
      if (leg.leg_kind === 'fee') {
        fees.push({
          assetId: String(assetId), amount: amount.toString(),
          feeDest: leg.fee_dest || null, feeRecipient: accountRefOrNull(leg.fee_recipient),
        })
        continue
      }
      net.set(assetId, (net.get(assetId) ?? 0n) + (leg.leg_kind === 'in' ? -amount : amount))
    }
    const sides: Record<'in' | 'out', { usd: bigint; priced: boolean }> = {
      in: { usd: 0n, priced: false },
      out: { usd: 0n, priced: false },
    }
    const inputs: TradeAmount[] = []
    const outputs: TradeAmount[] = []
    for (const [assetId, value] of [...net.entries()].sort((a, b) => a[0] - b[0])) {
      if (value === 0n) continue
      const amount = value < 0n ? -value : value
      const side = value < 0n ? 'in' as const : 'out' as const
      ;(side === 'in' ? inputs : outputs).push({ assetId: String(assetId), amount: amount.toString() })
      const usd = pricer?.usdAt(assetId, amount, trade.timeSec) ?? null
      if (usd != null) {
        sides[side].priced = true
        sides[side].usd += usd
      }
    }
    const valueUsd = sides.in.priced || sides.out.priced
      ? renderUsd(sides.in.usd > sides.out.usd ? sides.in.usd : sides.out.usd)
      : null
    return {
      opKey: trade.opKey || null,
      blockHeight: trade.block,
      eventIndex: trade.anchorEvent,
      timestamp: iso(trade.ts),
      venues: [...trade.venues].sort(),
      inputs,
      outputs,
      fees,
      valueUsd,
    }
  })
}

// ---------------------------------------------------------------------------
// DCA
// ---------------------------------------------------------------------------

export interface AccountDcaEvent {
  scheduleId: number
  eventName: string
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  plannedBlock: number | null
  error: string | null
}

export interface PositionFeedOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
}

export async function accountDcaEvents(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: Array<WithExtrinsicHash<AccountDcaEvent>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:dca-events
        SELECT id, event_name, block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts,
               amount_in, amount_out, planned_block, error
        FROM price_data.dca_events_by_account
        WHERE who = {account:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ id: string; event_name: string; block_height: number; event_index: number; extrinsic_index: number | null; ts: string; amount_in: string; amount_out: string; planned_block: number; error: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: await attachExtrinsicHashes(client, page.map(row => ({
      scheduleId: Number(row.id),
      eventName: row.event_name,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      timestamp: iso(row.ts),
      amountIn: row.amount_in || null,
      amountOut: row.amount_out || null,
      plannedBlock: Number(row.planned_block) > 0 ? Number(row.planned_block) : null,
      error: row.error || null,
    }))),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// OTC
// ---------------------------------------------------------------------------

export interface AccountOtcCall {
  blockHeight: number
  extrinsicIndex: number
  hash: string
  timestamp: string
  callName: string
  success: boolean
}

// An OTC order event (otcShared.zOtcEvent) plus the order it belongs to.
export interface AccountOtcFill {
  orderId: number
  type: OtcEventType
  blockHeight: number
  eventIndex: number
  timestamp: string
  amountIn: string | null
  amountOut: string | null
  filler: AccountRef | null
}

export async function accountOtcCalls(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: AccountOtcCall[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:otc-calls
        SELECT block_height, extrinsic_index, extrinsic_hash, toString(block_timestamp) AS ts, call_name, success
        FROM price_data.extrinsics_by_signer
        WHERE account = {account:String} AND startsWith(call_name, 'OTC.')${windowSql(options, params)}${positionCursorSql(options.order, 'extrinsic_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'extrinsic_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; extrinsic_index: number; extrinsic_hash: string; ts: string; call_name: string; success: number }>(),
    row => `${row.block_height}:${row.extrinsic_index}`,
    options.limit,
  )
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      extrinsicIndex: Number(row.extrinsic_index),
      hash: row.extrinsic_hash.toLowerCase(),
      timestamp: iso(row.ts),
      callName: row.call_name,
      success: Number(row.success) === 1,
    })),
    hasMore,
  }
}

// The fill events where this account is the FILLER, as a keyset page like
// every other account feed. otc_order_events is keyed order-first, so the
// filler predicate scans the table — 4.6k rows live, trivial — but the page
// contract (cursor, window, order) is the same one a consumer already speaks.
export async function accountOtcFills(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: AccountOtcFill[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:otc-fills
        SELECT order_id, event_name, block_height, event_index, toString(block_timestamp) AS ts, amount_in, amount_out
        FROM price_data.otc_order_events
        WHERE filler = {account:String} AND event_name IN ('Filled', 'PartiallyFilled')${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ order_id: number; event_name: string; block_height: number; event_index: number; ts: string; amount_in: string; amount_out: string }>(),
    row => `${row.order_id}:${row.block_height}:${row.event_index}`,
    options.limit,
  )
  const items: AccountOtcFill[] = []
  for (const row of page) {
    const type = otcEventType(row.event_name)
    if (!type) continue
    items.push({
      orderId: Number(row.order_id),
      type,
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      amountIn: /^\d+$/.test(String(row.amount_in)) ? String(row.amount_in) : null,
      amountOut: /^\d+$/.test(String(row.amount_out)) ? String(row.amount_out) : null,
      filler: accountRefOrNull(parsed.accountId),
    })
  }
  return { items, hasMore }
}

// ---------------------------------------------------------------------------
// Staking / liquidity / XCM feeds (uniform account-first cursor reads)
// ---------------------------------------------------------------------------

// The account's arm of the staking feed: the same item the global feed serves.
export async function accountStaking(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: Array<WithExtrinsicHash<StakingEventItem>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:staking
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, who, args_json
        FROM price_data.staking_activity_by_account
        WHERE who = {account:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(await res.json<StakingRow>(), row => `${row.block_height}:${row.event_index}`, options.limit)
  return { items: await attachExtrinsicHashes(client, page.map(stakingItem)), hasMore }
}

export interface AccountLiquidityEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  assetId: string
  amount: string | null
  amountA: string | null
  assetB: string | null
  poolAccount: string | null
  assetRefs: string[]
}

export async function accountLiquidity(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: Array<WithExtrinsicHash<AccountLiquidityEvent>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:liquidity
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name,
               asset_id, amount, amount_a, asset_b, pool_account, asset_refs
        FROM price_data.liquidity_activity_by_account
        WHERE who = {account:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; asset_id: number; amount: string; amount_a: string; asset_b: number; pool_account: string; asset_refs: number[] }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: await attachExtrinsicHashes(client, page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      timestamp: iso(row.ts),
      eventName: row.event_name,
      assetId: String(row.asset_id),
      amount: row.amount || null,
      amountA: row.amount_a || null,
      assetB: Number(row.asset_b) > 0 ? String(row.asset_b) : null,
      poolAccount: row.pool_account || null,
      assetRefs: (row.asset_refs ?? []).map(String),
    }))),
    hasMore,
  }
}

// The XCM feed's per-direction event families — exactly the
// xcm_event_activity_by_account MV's name list, split by what the event means
// for the account. Barrier/queue events carry no account and stay 'other'.
const XCM_IN_NAMES = ['Currencies.Deposited', 'Tokens.Deposited', 'Balances.Deposit', 'Balances.Issued', 'Balances.Endowed', 'Tokens.Endowed', 'Balances.Minted', 'System.NewAccount']
const XCM_OUT_NAMES = ['Currencies.Withdrawn', 'XTokens.TransferredAssets', 'XTokens.TransferredMultiAssets', 'PolkadotXcm.Sent']

export interface AccountXcmEvent {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  direction: 'in' | 'out' | 'other'
  assetId: string
  amount: string | null
}

export interface AccountXcmOptions extends PositionFeedOptions {
  direction?: 'in' | 'out'
  assetId?: string
}

export async function accountXcm(client: ClickHouseClient, parsed: ParsedAddress, options: AccountXcmOptions): Promise<{ items: Array<WithExtrinsicHash<AccountXcmEvent>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const clauses = ['who = {account:String}']
  if (options.direction) {
    clauses.push('event_name IN {names:Array(String)}')
    params.names = options.direction === 'in' ? XCM_IN_NAMES : XCM_OUT_NAMES
  }
  if (options.assetId) { clauses.push('asset_id = {asset:UInt32}'); params.asset = Number(options.assetId) }
  const res = await client.query({
    query: `-- data:accounts:xcm
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name, asset_id, amount
        FROM price_data.xcm_event_activity_by_account
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; asset_id: number; amount: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: await attachExtrinsicHashes(client, page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      timestamp: iso(row.ts),
      eventName: row.event_name,
      direction: (XCM_IN_NAMES.includes(row.event_name) ? 'in' : XCM_OUT_NAMES.includes(row.event_name) ? 'out' : 'other') as 'in' | 'out' | 'other',
      assetId: String(row.asset_id),
      amount: row.amount || null,
    }))),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Money market
// ---------------------------------------------------------------------------

export interface MoneyMarketPosition {
  poolAddress: string
  marketKey: string | null
  totalCollateralBase: string
  totalDebtBase: string
  availableBorrowsBase: string
  liquidationThreshold: string
  ltv: string
  healthFactor: string
  blockHeight: number
  timestamp: string
}

export async function moneyMarketPositions(client: ClickHouseClient, parsed: ParsedAddress): Promise<MoneyMarketPosition[]> {
  const h160 = h160For(parsed)
  const [positionsRes, reserveState] = await Promise.all([
    client.query({
      // Every UInt256 tuple element is stringified in SQL: ClickHouse renders
      // them as bare JSON numbers otherwise, and JSON.parse would round them.
      query: `-- data:accounts:mm-positions
          SELECT pool_address,
                 toString(tupleElement(s, 'total_collateral_base')) AS total_collateral_base,
                 toString(tupleElement(s, 'total_debt_base')) AS total_debt_base,
                 toString(tupleElement(s, 'available_borrows_base')) AS available_borrows_base,
                 toString(tupleElement(s, 'current_liquidation_threshold')) AS liquidation_threshold,
                 toString(tupleElement(s, 'ltv')) AS ltv,
                 toString(tupleElement(s, 'health_factor')) AS health_factor,
                 tupleElement(s, 'block_height') AS block_height,
                 toString(tupleElement(s, 'block_timestamp')) AS ts
          FROM (
            SELECT pool_address, argMaxMerge(position_state) AS s
            FROM price_data.money_market_latest_positions
            WHERE user_address = {h:String}
            GROUP BY user_address, pool_address
          )`,
      query_params: { h: h160 },
      format: 'JSONEachRow',
    }),
    moneyMarketReserveState(client),
  ])
  const markets = reserveState.marketByPool
  return (await positionsRes.json<{ pool_address: string; total_collateral_base: string; total_debt_base: string; available_borrows_base: string; liquidation_threshold: string; ltv: string; health_factor: string; block_height: number; ts: string }>())
    .filter(row => row.total_collateral_base !== '0' || row.total_debt_base !== '0')
    .map(row => ({
      poolAddress: row.pool_address,
      marketKey: markets.get(row.pool_address.toLowerCase()) ?? null,
      totalCollateralBase: row.total_collateral_base,
      totalDebtBase: row.total_debt_base,
      availableBorrowsBase: row.available_borrows_base,
      liquidationThreshold: row.liquidation_threshold,
      ltv: row.ltv,
      healthFactor: row.health_factor,
      blockHeight: Number(row.block_height),
      timestamp: iso(row.ts),
    }))
}

export interface MoneyMarketActivityItem {
  blockHeight: number
  eventIndex: number
  timestamp: string
  eventName: string
  assetAddress: string | null
  poolAddress: string | null
  amount: string | null
  liquidatedCollateralAmount: string | null
}

export async function moneyMarketActivity(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: MoneyMarketActivityItem[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:mm-activity
        SELECT block_height, event_index, toString(block_timestamp) AS ts, event_name,
               asset_address, pool_address, amount, liquidated_collateral_amount
        FROM price_data.account_money_market_activity
        WHERE account_id = {account:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; ts: string; event_name: string; asset_address: string; pool_address: string | null; amount: string | null; liquidated_collateral_amount: string }>(),
    row => `${row.block_height}:${row.event_index}:${row.event_name}`,
    options.limit,
  )
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      eventName: row.event_name,
      assetAddress: row.asset_address || null,
      poolAddress: row.pool_address || null,
      amount: row.amount ?? null,
      liquidatedCollateralAmount: row.liquidated_collateral_amount || null,
    })),
    hasMore,
  }
}

export interface AccountLiquidation {
  blockHeight: number
  eventIndex: number
  timestamp: string
  poolAddress: string
  assetAddress: string
  liquidatedCollateralAmount: string
}

export async function accountLiquidations(client: ClickHouseClient, parsed: ParsedAddress, options: PositionFeedOptions): Promise<{ items: AccountLiquidation[]; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const res = await client.query({
    query: `-- data:accounts:liquidations
        SELECT block_height, event_index, toString(block_timestamp) AS ts, pool_address, asset_address, liquidated_collateral_amount
        FROM price_data.money_market_liquidation_calls
        WHERE account_id = {account:String}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; ts: string; pool_address: string; asset_address: string; liquidated_collateral_amount: string }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(row.ts),
      poolAddress: row.pool_address,
      assetAddress: row.asset_address,
      liquidatedCollateralAmount: String(row.liquidated_collateral_amount),
    })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Protocol fees generated by the account
// ---------------------------------------------------------------------------

// One (stream, calendar month) of protocol revenue the account paid — the same
// row shape /v1/stats/revenue publishes, minus the destination split.
export interface AccountFeeRow { bucket: string; stream: string; amountUsd: string }

// The payer identity in revenue_events/account_revenue appears in the native
// form or the ETH-truncated form depending on the stream's source, so both are
// read and summed per (stream, month).
export async function accountFees(client: ClickHouseClient, parsed: ParsedAddress): Promise<AccountFeeRow[]> {
  const identities = [...new Set([parsed.accountId, evmAccountForm(parsed)])]
  const res = await client.query({
    query: `-- data:accounts:fees
        SELECT stream, month, toString(sum(revenue_usd)) AS revenue_usd
        FROM (
          SELECT account, stream, month, argMax(revenue_usd, computed_at) AS revenue_usd
          FROM price_data.account_revenue
          WHERE account IN {accounts:Array(String)}
          GROUP BY account, stream, month
        )
        GROUP BY stream, month
        ORDER BY month DESC, stream ASC`,
    query_params: { accounts: identities },
    format: 'JSONEachRow',
    clickhouse_settings: { output_format_json_quote_decimals: 1 },
  })
  return (await res.json<{ stream: string; month: number; revenue_usd: string }>()).map(row => {
    const yyyymm = String(row.month).padStart(6, '0')
    return {
      bucket: iso(`${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-01 00:00:00`),
      stream: row.stream,
      amountUsd: renderUsd(scaledUsd(row.revenue_usd)),
    }
  })
}
