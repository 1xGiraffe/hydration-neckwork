import type { ClickHouseClient } from '../../db/client.ts'
import { ATOKEN_UNDERLYING_ID, UNDERLYING_TO_SHARE_IDS, allExplorerAssets } from '../../services/explorerAssets.ts'
import { iso } from '../schemas/common.ts'
import { resolveSingleAccountForms } from './accountBalances.ts'

// Per-account money-market activity for GET
// /v1/accounts/:account/money-market-events, read from
// `account_money_market_activity` — the account-first projection of the raw
// money-market event stream. Public-owned; the reserve-address mapping below is a
// deliberate restatement of the explorer's, which the isolation rule keeps out of
// reach (spec: "Isolation rule").

// The user-facing events this endpoint publishes, in the model's own pascal case.
// The table also carries the reserves' ERC-20 plumbing (Transfer, Approval, Mint,
// Burn, BalanceTransfer); those are internal legs, not a user's action, so they are
// excluded from both the page and its totalCount.
export const MM_EVENT_NAMES = [
  'Supply',
  'Withdraw',
  'Borrow',
  'Repay',
  'LiquidationCall',
  'ReserveUsedAsCollateralEnabled',
  'ReserveUsedAsCollateralDisabled',
  'UserEModeSet',
] as const

export type MmEventName = (typeof MM_EVENT_NAMES)[number]

// Events that reference a reserve but move nothing.
const AMOUNTLESS_EVENTS = new Set<string>([
  'ReserveUsedAsCollateralEnabled',
  'ReserveUsedAsCollateralDisabled',
  'UserEModeSet',
])

const LOWERCASE_EVENT_NAMES = new Map<string, MmEventName>(
  MM_EVENT_NAMES.map(name => [name.toLowerCase(), name]),
)

/** Resolve a lowercase wire event name, or null if it is not one of ours. */
export function mmEventName(input: string): MmEventName | null {
  return LOWERCASE_EVENT_NAMES.get(input.trim().toLowerCase()) ?? null
}

// Hydration exposes every registry asset at a per-asset ERC-20 precompile
// (0x…0001 followed by the 4-byte big-endian asset id), which is the address the
// money market files its reserve under.
const PRECOMPILE_PREFIX = `${'0'.repeat(30)}01`

/** The reserve address a registry asset is filed under at its ERC-20 precompile. */
export function precompileAddress(assetId: number): string {
  return `0x${PRECOMPILE_PREFIX}${assetId.toString(16).padStart(8, '0')}`
}

// Reserves backed by a deployed contract instead of the precompile. HOLLAR is the
// only one; the shared list lives in services/erc20WalletService.ts, outside the
// public API's import allow-list, so it is restated here.
const DEPLOYED_RESERVE_ASSET_ID = new Map<string, number>([
  ['0x531a654d1696ed52e7275a8cede955e82620f99a', 222], // HOLLAR
])

/**
 * Reserve EVM address → registry asset id, or null when the row references no
 * reserve (UserEModeSet carries an empty address).
 *
 * Verified against the live model: every `asset_address` on these events is either
 * the precompile or HOLLAR's contract, so no lookup through `atoken_reserve_map` is
 * needed — its `asset_address` column holds the very same reserve address.
 */
export function assetIdFromReserveAddress(address: string | null | undefined): number | null {
  const lower = (address ?? '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return null
  const deployed = DEPLOYED_RESERVE_ASSET_ID.get(lower)
  if (deployed != null) return deployed
  const body = lower.slice(2)
  return body.startsWith(PRECOMPILE_PREFIX) ? parseInt(body.slice(32), 16) : null
}

/**
 * Reserve addresses a `?search=` term selects.
 *
 * The term matches registry symbols and names, then each match is widened to the
 * ids the market can actually file rows under: an aToken's rows sit on its reserve
 * (aDOT → DOT) and a folded pool-share reserve's rows sit on the share token
 * (GDOT → 2-Pool-GDOT). Returns an empty array when nothing matches, which the
 * caller must treat as "match no rows" rather than "no filter".
 */
export function reserveAddressesForSearch(search: string): string[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return []
  const reserveIds = new Set<number>()
  for (const asset of allExplorerAssets()) {
    const haystack = `${asset.symbol} ${asset.name ?? ''}`.toLowerCase()
    if (!haystack.includes(needle)) continue
    const direct = ATOKEN_UNDERLYING_ID[asset.assetId] ?? asset.assetId
    for (const id of [asset.assetId, direct, ...(UNDERLYING_TO_SHARE_IDS[asset.assetId] ?? []), ...(UNDERLYING_TO_SHARE_IDS[direct] ?? [])]) {
      reserveIds.add(id)
    }
  }
  const addresses = new Set<string>()
  for (const id of reserveIds) {
    addresses.add(precompileAddress(id))
    for (const [address, assetId] of DEPLOYED_RESERVE_ASSET_ID) {
      if (assetId === id) addresses.add(address)
    }
  }
  return [...addresses].sort()
}

export interface MmEventRow {
  eventName: MmEventName
  assetId: string | null
  amount: string | null
  blockHeight: number
  eventIndex: number
  timestamp: string
  categoryId: number | null
}

export interface MoneyMarketEventsOptions {
  events: string[]
  search: string
  limit: number
  offset: number
}

interface ActivityRow {
  block_height: number
  event_index: number
  ts: number
  event_name: string
  asset_address: string
  amount: string | null
  liquidated_collateral_amount: string | null
}

function amountFor(row: ActivityRow): string | null {
  if (AMOUNTLESS_EVENTS.has(row.event_name)) return null
  // LiquidationCall's `amount` is debtToCover, denominated in the DEBT asset,
  // while the row's own asset_address is the COLLATERAL reserve. Publishing that
  // pair would report one asset's amount against another's id, so the seized
  // collateral is the amount here (spec: "Event names").
  const value = row.event_name === 'LiquidationCall' ? row.liquidated_collateral_amount : row.amount
  const trimmed = String(value ?? '').trim()
  return /^\d+$/.test(trimmed) ? trimmed : null
}

/**
 * One page of an account's money-market events, newest first, plus the total
 * matching the filters (independent of limit/offset).
 *
 * `categoryId` is always null: `account_money_market_activity` carries no eMode
 * category column. The value exists only in the raw event's decoded arguments, and
 * that table is block-first keyed, so recovering it per account is unbounded.
 */
export async function queryMoneyMarketEvents(
  client: ClickHouseClient,
  account: string,
  options: MoneyMarketEventsOptions,
): Promise<{ items: MmEventRow[]; totalCount: number }> {
  const events = options.events.length ? options.events : [...MM_EVENT_NAMES]
  const addresses = options.search.trim() ? reserveAddressesForSearch(options.search) : null
  // A search that resolves to no asset selects no rows. Returning every row here
  // would answer a narrowing filter with a widening result.
  if (addresses != null && !addresses.length) return { items: [], totalCount: 0 }

  const params: Record<string, unknown> = {
    // A bound EVM account files its money-market rows under the ETH-prefixed form
    // of its H160, so asking about its AccountId32 has to reach that form too.
    accounts: await resolveSingleAccountForms(client, account),
    events,
    limit: options.limit,
    offset: options.offset,
  }
  if (addresses) params.addresses = addresses
  // FINAL deduplicates replayed rows; account_id leads the primary key, so the
  // predicate keeps that merge bounded to one account's ranges.
  const where = `WHERE account_id IN ({accounts:Array(String)})
      AND event_name IN ({events:Array(String)})
      ${addresses ? 'AND lower(asset_address) IN ({addresses:Array(String)})' : ''}`

  const [pageRes, countRes] = await Promise.all([
    client.query({
      // (block_height, event_index, event_name, account_id) is the model's full
      // primary key, so this is a total order over the selected rows and
      // consecutive pages cannot overlap or leave a gap. account_id is part of it
      // because a bound EVM account is read under several stored forms at once.
      query: `
          SELECT
            toUInt32(block_height) AS block_height,
            toUInt32(event_index) AS event_index,
            toUnixTimestamp(block_timestamp) AS ts,
            event_name,
            lower(ifNull(asset_address, '')) AS asset_address,
            amount,
            liquidated_collateral_amount
          FROM price_data.account_money_market_activity FINAL
          ${where}
          ORDER BY block_height DESC, event_index DESC, event_name DESC, account_id DESC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT toString(count()) AS total
          FROM price_data.account_money_market_activity FINAL
          ${where}
        `,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ])

  const items = (await pageRes.json<ActivityRow>()).map(row => {
    const assetId = assetIdFromReserveAddress(row.asset_address)
    return {
      eventName: row.event_name as MmEventName,
      assetId: assetId == null ? null : String(assetId),
      amount: amountFor(row),
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      timestamp: iso(Number(row.ts) * 1000),
      categoryId: null,
    }
  })
  const [count] = await countRes.json<{ total: string }>()
  return { items, totalCount: Number(count?.total ?? 0) }
}
