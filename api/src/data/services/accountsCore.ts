import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { attachExtrinsicHashes, type WithExtrinsicHash } from './extrinsicHashes.ts'
import { assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { renderUsd } from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'
import { freshPriceMap } from './assetsData.ts'
import { accountRefFor, accountRefOrNull, h160For, type AccountRef, type ParsedAddress } from './address.ts'
import { eventTimePricer } from './eventTimePrices.ts'
import { DEDUP_SLACK, dedupPage, orderSql, positionCursorSql, windowSql, type Order, type PositionCursor, type WindowFilters } from './feed.ts'

// Account summary, balances, balance history, raw event references and
// transfers for /v1/accounts/{address}[…]. Every read is account-first: the
// backing tables all lead their sort key with the account, so a page costs one
// key-range read at any history depth.

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface AccountSummary {
  account: AccountRef
  identity: { display: string; verified: boolean; chain: string } | null
  tags: Array<{ labelId: string; name: string }>
  firstSeen: string | null
  firstSeenBlock: number | null
  lastSeen: string | null
  lastSeenBlock: number | null
}

// The summary 404s only when NOTHING anywhere names the account; each source
// is a bounded read (identities/tags are small tables; the activity bounds and
// the balance probe are key-pruned).
export async function accountSummary(client: ClickHouseClient, parsed: ParsedAddress): Promise<AccountSummary | null> {
  const [identityRes, tagsRes, boundsRes, balanceRes] = await Promise.all([
    client.query({
      query: `-- data:accounts:identity
          SELECT chain, argMax(display, updated_at) AS display, argMax(verified, updated_at) AS verified,
                 argMax(priority, updated_at) AS priority
          FROM price_data.account_identities
          WHERE account_id = {account:String}
          GROUP BY chain
          HAVING display != ''`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:tags
          SELECT label_id, argMax(label_name, updated_at) AS label_name, argMax(deleted, updated_at) AS deleted
          FROM price_data.account_tags
          WHERE account_id = {account:String}
          GROUP BY label_id`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
    // First and last indexed event naming the account, over EVERY asset and
    // pallet: one merged row of account_activity_bounds (009_data.sql).
    client.query({
      query: `-- data:accounts:activity-bounds
          SELECT minMerge(first_block_state) AS first_block, toString(minMerge(first_time_state)) AS first_ts,
                 maxMerge(last_block_state) AS last_block, toString(maxMerge(last_time_state)) AS last_ts
          FROM price_data.account_activity_bounds
          WHERE account = {account:String}
          GROUP BY account`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:has-balances
          SELECT 1 AS present FROM price_data.account_asset_latest_balances
          WHERE account_id = {account:String}
          LIMIT 1`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
  ])
  const identities = await identityRes.json<{ chain: string; display: string; verified: number; priority: number }>()
  const tags = (await tagsRes.json<{ label_id: string; label_name: string; deleted: number }>())
    .filter(row => Number(row.deleted) === 0)
    .map(row => ({ labelId: row.label_id, name: row.label_name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const [bounds] = await boundsRes.json<{ first_block: number; first_ts: string; last_block: number; last_ts: string }>()
  const hasBalances = (await balanceRes.json<{ present: number }>()).length > 0

  // Highest priority wins; the chain key is a deterministic tiebreak.
  const winner = identities
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.chain.localeCompare(b.chain))[0]

  if (!winner && tags.length === 0 && !bounds && !hasBalances) return null
  return {
    account: accountRefFor(parsed.accountId),
    identity: winner ? { display: winner.display, verified: Number(winner.verified) === 1, chain: winner.chain } : null,
    tags,
    firstSeen: bounds ? iso(bounds.first_ts) : null,
    firstSeenBlock: bounds ? Number(bounds.first_block) : null,
    lastSeen: bounds ? iso(bounds.last_ts) : null,
    lastSeenBlock: bounds ? Number(bounds.last_block) : null,
  }
}

// ---------------------------------------------------------------------------
// Balances: substrate + ERC-20 + aToken/vDebt, integer arithmetic end to end.
// ---------------------------------------------------------------------------

export interface BalanceItem {
  assetId: string
  symbol: string
  decimals: number
  kind: 'substrate' | 'erc20' | 'atoken' | 'vdebt'
  amount: string
  free: string | null
  reserved: string | null
  valueUsd: string | null
}

// The wallet's headline numbers: what it holds (substrate + ERC-20 + supplied
// money-market positions), what it owes (variable debt), and the difference —
// summed exactly in the valuation module's scaled integers, rendered once.
export interface BalanceTotals { assetsUsd: string; debtUsd: string; netUsd: string }

export interface AccountBalances { items: BalanceItem[]; totals: BalanceTotals }

const RAY = 10n ** 27n

// HOLLAR is the one deployed-token reserve; every other money-market reserve is
// the ERC-20 precompile of a registry asset (0x…01 + 8-hex asset id). Mirrors
// the explorer's assetIdFromMmAddress.
const MM_CONTRACT_ASSET: Record<string, number> = { '0x531a654d1696ed52e7275a8cede955e82620f99a': 222 }

export function assetIdFromMmAddress(addr: string): number | null {
  const h = (addr ?? '').toLowerCase().replace(/^0x/, '')
  if (MM_CONTRACT_ASSET[`0x${h}`] != null) return MM_CONTRACT_ASSET[`0x${h}`]
  if (h.length === 40 && /^0{30}01/.test(h)) return parseInt(h.slice(32), 16)
  return null
}

function bigIntOrZero(value: unknown): bigint {
  try { return BigInt(String(value ?? '0') || '0') } catch { return 0n }
}

// The money market's GLOBAL state every position read needs: the scaled-balance
// anchor block, the reserve map (asset ↔ aToken/vDebt/pool/market) and each
// reserve's current indices. None of it is per account, and the indices fold
// scans 1.8 M rows / 285 MiB — read once per TTL and shared across every
// balances and money-market request instead of once per request.
export interface MoneyMarketReserve { assetAddress: string; atoken: string; vdebt: string; poolProxy: string; marketKey: string }

export interface MoneyMarketReserveState {
  anchorBlock: number
  reserves: MoneyMarketReserve[]
  indices: Map<string, { liq: bigint; vbi: bigint }> // `${pool}:${reserve}`
  marketByPool: Map<string, string>
}

const RESERVE_STATE_TTL_MS = 10_000

export function moneyMarketReserveState(client: ClickHouseClient): Promise<MoneyMarketReserveState> {
  return cached('data:mm:reserve-state', RESERVE_STATE_TTL_MS, () => loadMoneyMarketReserveState(client))
}

async function loadMoneyMarketReserveState(client: ClickHouseClient): Promise<MoneyMarketReserveState> {
  const [anchorBlockRes, mapRes, indicesRes] = await Promise.all([
    client.query({
      query: `-- data:accounts:atoken-anchor-block
          SELECT max(anchor_block) AS b0 FROM price_data.atoken_scaled_anchor`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:atoken-map
          WITH (SELECT max(updated_at) FROM price_data.atoken_reserve_map) AS generation
          SELECT lower(asset_address) AS asset_address, lower(atoken) AS atoken, lower(vdebt) AS vdebt,
                 lower(pool_proxy) AS pool_proxy, market_key
          FROM price_data.atoken_reserve_map FINAL
          WHERE updated_at >= generation`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:reserve-indices
          SELECT pool_address, reserve_address,
                 toString(argMax(liquidity_index, (block_height, event_index))) AS liq,
                 toString(argMax(variable_borrow_index, (block_height, event_index))) AS vbi
          FROM price_data.money_market_reserve_indices
          GROUP BY pool_address, reserve_address`,
      format: 'JSONEachRow',
    }),
  ])
  const [{ b0 }] = await anchorBlockRes.json<{ b0: number }>().then(rows => (rows.length ? rows : [{ b0: 0 }]))
  const reserves = (await mapRes.json<{ asset_address: string; atoken: string; vdebt: string; pool_proxy: string; market_key: string }>())
    .map(row => ({ assetAddress: row.asset_address, atoken: row.atoken, vdebt: row.vdebt, poolProxy: row.pool_proxy, marketKey: row.market_key }))
  const indices = new Map<string, { liq: bigint; vbi: bigint }>()
  for (const row of await indicesRes.json<{ pool_address: string; reserve_address: string; liq: string; vbi: string }>()) {
    indices.set(`${row.pool_address.toLowerCase()}:${row.reserve_address.toLowerCase()}`, { liq: bigIntOrZero(row.liq), vbi: bigIntOrZero(row.vbi) })
  }
  const marketByPool = new Map<string, string>()
  for (const reserve of reserves) marketByPool.set(reserve.poolProxy, reserve.marketKey)
  return { anchorBlock: Number(b0) || 0, reserves, indices, marketByPool }
}

export async function accountBalances(client: ClickHouseClient, parsed: ParsedAddress): Promise<AccountBalances> {
  const h160 = h160For(parsed)
  const [substrateRes, erc20Res, reserveState, prices] = await Promise.all([
    client.query({
      query: `-- data:accounts:balances-substrate
          SELECT asset_id,
                 argMaxMerge(total_state) AS total,
                 argMaxMerge(free_state) AS free,
                 argMaxMerge(reserved_state) AS reserved
          FROM price_data.account_asset_latest_balances
          WHERE account_id = {account:String}
          GROUP BY account_id, asset_id`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:balances-erc20
          SELECT asset_id, argMax(total, updated_at) AS total
          FROM price_data.erc20_wallet_balances
          WHERE account_id = {account:String}
          GROUP BY asset_id`,
      query_params: { account: parsed.accountId },
      format: 'JSONEachRow',
    }),
    moneyMarketReserveState(client),
    // Balances are CURRENT holdings, valued at the current price under the
    // same freshness rule /v1/assets applies — a dead feed's final close never
    // values a position (the event-time rule applies to flows, not positions).
    freshPriceMap(client),
  ])

  const items: Array<Omit<BalanceItem, 'symbol' | 'decimals' | 'valueUsd'>> = []
  for (const row of await substrateRes.json<{ asset_id: string; total: string | null; free: string | null; reserved: string | null }>()) {
    const total = bigIntOrZero(row.total)
    if (total <= 0n) continue
    items.push({ assetId: String(row.asset_id), kind: 'substrate', amount: total.toString(), free: row.free ?? null, reserved: row.reserved ?? null })
  }
  // ERC-20 wallet balances (HOLLAR & co) live in their own snapshot — `free`
  // in the substrate table reads 0 for them.
  for (const row of await erc20Res.json<{ asset_id: string; total: string }>()) {
    const total = bigIntOrZero(row.total)
    if (total <= 0n) continue
    items.push({ assetId: String(row.asset_id), kind: 'erc20', amount: total.toString(), free: null, reserved: null })
  }

  // aToken/vDebt positions: anchor@B0 + Σ post-B0 scaled deltas, × the
  // reserve's current index / RAY — the explorer's own reconstruction, and the
  // reason a supplied DOT never shows in the substrate table.
  if (reserveState.anchorBlock) {
    const scaledRes = await client.query({
      query: `-- data:accounts:atoken-scaled
          SELECT contract, toString(sum(anchor) + sum(delta)) AS scaled FROM (
            SELECT lower(contract_address) AS contract, toInt256(scaled_balance) AS anchor, toInt256(0) AS delta
            FROM price_data.atoken_scaled_anchor FINAL WHERE holder = {h:String}
            UNION ALL
            SELECT contract_address AS contract, toInt256(0) AS anchor, sum(scaled_delta) AS delta
            FROM price_data.atoken_scaled_deltas FINAL
            WHERE holder = {h:String} AND block_height > {b0:UInt32}
            GROUP BY contract
          ) GROUP BY contract HAVING (sum(anchor) + sum(delta)) > 0`,
      query_params: { h: h160, b0: reserveState.anchorBlock },
      format: 'JSONEachRow',
    })
    const scaled = new Map<string, bigint>()
    for (const row of await scaledRes.json<{ contract: string; scaled: string }>()) scaled.set(row.contract, bigIntOrZero(row.scaled))
    for (const reserve of reserveState.reserves) {
      const index = reserveState.indices.get(`${reserve.poolProxy}:${reserve.assetAddress}`)
      if (!index) continue
      const underlyingId = assetIdFromMmAddress(reserve.assetAddress)
      if (underlyingId == null) continue
      const aScaled = scaled.get(reserve.atoken) ?? 0n
      const dScaled = scaled.get(reserve.vdebt) ?? 0n
      const supplied = aScaled > 0n ? (aScaled * index.liq) / RAY : 0n
      const debt = dScaled > 0n ? (dScaled * index.vbi) / RAY : 0n
      if (supplied > 0n) items.push({ assetId: String(underlyingId), kind: 'atoken', amount: supplied.toString(), free: null, reserved: null })
      if (debt > 0n) items.push({ assetId: String(underlyingId), kind: 'vdebt', amount: debt.toString(), free: null, reserved: null })
    }
  }

  let assetsUsd = 0n
  let debtUsd = 0n
  const priced = items.map(item => {
    const descriptor = assetDescriptor(Number(item.assetId))
    // An asset priced through another (aTokens, pool shares) falls back to its
    // price alias when it carries no feed of its own.
    const assetId = Number(item.assetId)
    const price = prices.get(assetId) ?? prices.get(priceAssetId(assetId))
    const usd = price != null && price > 0n ? (BigInt(item.amount) * price) / 10n ** BigInt(descriptor.decimals) : null
    if (usd != null) {
      if (item.kind === 'vdebt') debtUsd += usd
      else assetsUsd += usd
    }
    return { item: { ...item, symbol: descriptor.symbol, decimals: descriptor.decimals, valueUsd: usd == null ? null : renderUsd(usd) }, usd }
  })
  priced.sort((a, b) => {
    const av = a.usd ?? -1n
    const bv = b.usd ?? -1n
    return bv > av ? 1 : bv < av ? -1 : a.item.assetId.localeCompare(b.item.assetId)
  })
  return {
    items: priced.map(p => p.item),
    totals: { assetsUsd: renderUsd(assetsUsd), debtUsd: renderUsd(debtUsd), netUsd: renderUsd(assetsUsd - debtUsd) },
  }
}

// ---------------------------------------------------------------------------
// Balance history
// ---------------------------------------------------------------------------

export interface BalanceHistoryPoint { intervalStart: string; balance: string; lastBlock: number }

export interface BalanceHistoryOptions {
  bucket: 'hour' | 'week'
  assetId: string
  limit: number
  order: Order
  cursorTime: number | null // epoch seconds of the last served interval
  fromTime?: number
  toTime?: number
}

export async function balanceHistory(client: ClickHouseClient, parsed: ParsedAddress, options: BalanceHistoryOptions): Promise<{ items: BalanceHistoryPoint[]; hasMore: boolean }> {
  const hourly = options.bucket === 'hour'
  const table = hourly ? 'account_balance_hourly' : 'account_balance_weekly'
  const column = hourly ? 'interval_start' : 'week_start'
  const params: Record<string, unknown> = { account: parsed.accountId, asset: options.assetId, bound: options.limit + 1 }
  const clauses: string[] = ['account_id = {account:String}', 'asset_id = {asset:String}']
  if (options.fromTime != null) { clauses.push(`${column} >= toDateTime({fromTime:UInt32})`); params.fromTime = options.fromTime }
  if (options.toTime != null) { clauses.push(`${column} <= toDateTime({toTime:UInt32})`); params.toTime = options.toTime }
  if (options.cursorTime != null) {
    clauses.push(`${column} ${options.order === 'desc' ? '<' : '>'} toDateTime({cursor:UInt32})`)
    params.cursor = options.cursorTime
  }
  const res = await client.query({
    query: `-- data:accounts:balance-history
        SELECT toString(${column}) AS ts,
               argMaxMerge(balance_state) AS balance,
               maxMerge(last_block_state) AS last_block
        FROM price_data.${table}
        WHERE ${clauses.join(' AND ')}
        GROUP BY account_id, asset_id, ${column}
        ORDER BY ${column} ${options.order === 'desc' ? 'DESC' : 'ASC'}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ ts: string; balance: string; last_block: number }>()
  const hasMore = rows.length > options.limit
  return {
    items: rows.slice(0, options.limit).map(row => ({
      intervalStart: iso(row.ts),
      balance: String(row.balance || '0'),
      lastBlock: Number(row.last_block),
    })),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Raw event references
// ---------------------------------------------------------------------------

export interface AccountEventRef {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  eventName: string
  timestamp: string
  assetId: string
  amount: string | null
}

export interface AccountEventsOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  name?: string
  assetId?: string
}

export async function accountEvents(client: ClickHouseClient, parsed: ParsedAddress, options: AccountEventsOptions): Promise<{ items: Array<WithExtrinsicHash<AccountEventRef>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = ['account = {account:String}']
  if (options.name) { clauses.push('event_name = {name:String}'); params.name = options.name }
  if (options.assetId) { clauses.push('asset_id = {asset:UInt32}'); params.asset = Number(options.assetId) }
  const res = await client.query({
    query: `-- data:accounts:events
        SELECT block_height, event_index, extrinsic_index, event_name, toString(block_timestamp) AS ts,
               asset_id, toString(amount) AS amount, has_amount
        FROM price_data.account_activity_v3
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; ts: string; asset_id: number; amount: string; has_amount: number }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  return {
    items: await attachExtrinsicHashes(client, page.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      eventName: row.event_name,
      timestamp: iso(row.ts),
      assetId: String(row.asset_id),
      amount: Number(row.has_amount) === 1 ? String(row.amount) : null,
    }))),
    hasMore,
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface AccountTransfer {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  eventName: string
  direction: 'in' | 'out' | 'self'
  from: AccountRef | null
  to: AccountRef | null
  assetId: string
  amount: string
  valueUsd: string | null
}

export interface AccountTransfersOptions extends WindowFilters {
  limit: number
  order: Order
  cursor: PositionCursor | null
  direction?: 'in' | 'out'
  assetId?: string
}

export async function accountTransfers(client: ClickHouseClient, parsed: ParsedAddress, options: AccountTransfersOptions): Promise<{ items: Array<WithExtrinsicHash<AccountTransfer>>; hasMore: boolean }> {
  const params: Record<string, unknown> = { account: parsed.accountId, bound: options.limit + 1 + DEDUP_SLACK }
  const clauses: string[] = ['account = {account:String}']
  if (options.direction === 'in') clauses.push('to_account = {account:String}')
  if (options.direction === 'out') clauses.push('from_account = {account:String}')
  if (options.assetId) { clauses.push('asset_id = {asset:UInt32}'); params.asset = Number(options.assetId) }
  const res = await client.query({
    query: `-- data:accounts:transfers
        SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, event_name,
               from_account, to_account, amount, asset_id
        FROM price_data.account_transfer_activity
        WHERE ${clauses.join(' AND ')}${windowSql(options, params)}${positionCursorSql(options.order, 'event_index', params, options.cursor)}
        ORDER BY ${orderSql(options.order, 'event_index')}
        LIMIT {bound:UInt32}`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const { page, hasMore } = dedupPage(
    await res.json<{ block_height: number; event_index: number; extrinsic_index: number | null; ts: string; event_name: string; from_account: string; to_account: string; amount: string; asset_id: number }>(),
    row => `${row.block_height}:${row.event_index}`,
    options.limit,
  )
  // Event-time USD for the page: one closes read over its assets and span.
  const times = page.map(row => Math.floor(Date.parse(iso(row.ts)) / 1000))
  const pricer = page.length ? await eventTimePricer(client, page.map(row => Number(row.asset_id)), Math.min(...times), Math.max(...times)) : null
  return {
    items: await attachExtrinsicHashes(client, page.map((row, i) => {
      const isFrom = row.from_account.toLowerCase() === parsed.accountId
      const isTo = row.to_account.toLowerCase() === parsed.accountId
      const usd = pricer?.usdAt(Number(row.asset_id), BigInt(String(row.amount || '0') || '0'), times[i]) ?? null
      return {
        blockHeight: Number(row.block_height),
        eventIndex: Number(row.event_index),
        extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
        timestamp: iso(row.ts),
        eventName: row.event_name,
        direction: (isFrom && isTo ? 'self' : isFrom ? 'out' : 'in') as 'in' | 'out' | 'self',
        from: accountRefOrNull(row.from_account),
        to: accountRefOrNull(row.to_account),
        assetId: String(row.asset_id),
        amount: String(row.amount),
        valueUsd: usd == null ? null : renderUsd(usd),
      }
    })),
    hasMore,
  }
}
