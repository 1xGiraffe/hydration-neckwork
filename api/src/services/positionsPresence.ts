import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { historyH160, listTagMembers, moneyMarketIdentities, resolveRelatedAccounts, tagHistoryAccountSet } from './explorerService.ts'
import { stableswapPoolIdList, xykLpAssetIdList } from './lpHistory.ts'
import { accountSetKey, cachedLiquidityRewardsClaimed, type LiquidityRewardsClaimed } from './lpRewardClaims.ts'
import { mmHistoryStart } from './moneyMarketHistory.ts'
import { orderHistoryCount, orderHistoryPage, type OrderHistoryKindFilter, type OrderHistoryPage } from './orderHistory.ts'
import { tagged } from './queryTag.ts'
import { getTag as getTagRecord } from './tagService.ts'

// The account/tag Orders · Liquidity · Borrow tabs' history reads, resolved per scope,
// and the cheap probe that decides whether a tab with no CURRENT position still has
// history to show.
//
// Scopes are the ones the neighbouring reads use, so a tab and its history agree:
//  - orders: an address's related set (what activeDcas / openLimitOrders read), a
//    tag's members;
//  - liquidity (claimed rewards, LP-history presence): the set the LP history route
//    covers — the related set, or the members plus their EVM twins
//    (tagHistoryAccountSet);
//  - money market: moneyMarketIdentities over the same accounts.

let client: ClickHouseClient
export function initPositionsPresence(c: ClickHouseClient): void { client = c }

export interface PositionsPresence { orderHistory: number; liquidityHistory: boolean; moneyMarketHistory: boolean }

interface PositionScope {
  /** Cache scope name (addr:<id>, tag:<id>, list-tag:<list>:<tag>). */
  scope: string
  orderAccounts: string[]
  lpAccounts: string[]
  mmH160s: string[]
}

async function addressScope(address: string): Promise<PositionScope | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const related = [...new Set(resolved.related)]
  return {
    scope: `addr:${resolved.norm.accountId}`,
    orderAccounts: related,
    lpAccounts: related,
    mmH160s: moneyMarketIdentities(related, resolved.norm).h160s,
  }
}
function membersScope(scope: string, members: string[]): PositionScope {
  return { scope, orderAccounts: members, lpAccounts: tagHistoryAccountSet(members), mmH160s: moneyMarketIdentities(members).h160s }
}
function tagScope(tagId: string): PositionScope | null {
  const tag = getTagRecord(tagId)
  return tag && tag.members.length ? membersScope(`tag:${tagId}`, tag.members) : null
}
function listTagScope(listId: string, tagId: string, members: string[]): PositionScope | null {
  const valid = listTagMembers(members)
  return valid.length ? membersScope(`list-tag:${listId}:${tagId}`, valid) : null
}

/**
 * Whether the LP history route would find anything for the accounts: an Omnipool
 * position ownership interval (direct or farmed), an XYK farm principal interval, a
 * positive balance of any XYK or stableswap share token, or a Uniswap v3 position /
 * Gamma vault share transfer of one of their H160s. Every probe is account-first
 * (or the tiny v3 venue) and stops at its first row; it is a superset of the
 * sources loadLpHistory reads, so a history with positions always probes true.
 */
async function hasLiquidityHistory(accountsIn: readonly string[]): Promise<boolean> {
  const accs = [...new Set(accountsIn.map(a => a.toLowerCase()))].filter(a => /^0x[0-9a-f]{64}$/.test(a))
  if (!accs.length) return false
  const hs = [...new Set(accs.map(historyH160).filter((h): h is string => h != null))]
  const [xykIds, poolIds] = await Promise.all([xykLpAssetIdList(client), stableswapPoolIdList(client)])
  const shareIds = [...new Set([...xykIds, ...poolIds])].map(String)
  const res = await client.query(tagged({
    query: `-- positions:lp-presence
            SELECT
              (SELECT count() FROM (SELECT 1 FROM price_data.omnipool_position_owner_intervals WHERE account_id IN {accs:Array(String)} LIMIT 1)) AS omnipool,
              (SELECT count() FROM (SELECT 1 FROM price_data.xyk_farm_principal_intervals WHERE account_id IN {accs:Array(String)} LIMIT 1)) AS xyk_farm,
              (SELECT count() FROM (SELECT 1 FROM price_data.account_balance_history
                 WHERE account_id IN {accs:Array(String)} AND asset_id IN {shares:Array(String)} AND toUInt256OrZero(total) > 0 LIMIT 1)) AS shares,
              (SELECT count() FROM (SELECT 1 FROM price_data.uniswap_v3_events
                 WHERE event_name = 'Transfer' AND ((kind = 'manager' AND counterparty IN {hs:Array(String)})
                    OR (kind = 'vault' AND (actor IN {hs:Array(String)} OR counterparty IN {hs:Array(String)}))) LIMIT 1)) AS v3`,
    query_params: { accs, shares: shareIds.length ? shareIds : ['-1'], hs: hs.length ? hs : [''] },
    format: 'JSONEachRow',
  }))
  const row = (await res.json<Record<string, string | number>>())[0] ?? {}
  return Object.values(row).some(v => Number(v) > 0)
}

async function presenceFor(s: PositionScope): Promise<PositionsPresence> {
  const key = `explorer:positions-presence:${s.scope}:${accountSetKey([...s.orderAccounts, '|', ...s.lpAccounts])}`
  return cached(key, 60_000, async () => {
    const [orderHistory, liquidityHistory, mmStart] = await Promise.all([
      orderHistoryCount(s.orderAccounts),
      hasLiquidityHistory(s.lpAccounts),
      mmHistoryStart(client, s.mmH160s),
    ])
    return { orderHistory, liquidityHistory, moneyMarketHistory: mmStart != null }
  })
}

export async function getAddressPositionsPresence(address: string): Promise<PositionsPresence | null> {
  const s = await addressScope(address)
  return s ? presenceFor(s) : null
}
export async function getTagPositionsPresence(tagId: string): Promise<PositionsPresence | null> {
  const s = tagScope(tagId)
  return s ? presenceFor(s) : null
}
export async function getListTagPositionsPresence(listId: string, tagId: string, members: string[]): Promise<PositionsPresence | null> {
  const s = listTagScope(listId, tagId, members)
  return s ? presenceFor(s) : null
}

export interface OrderHistoryQuery { kind: OrderHistoryKindFilter; offset: number; limit: number }

export async function getAddressOrderHistory(address: string, q: OrderHistoryQuery): Promise<OrderHistoryPage | null> {
  const s = await addressScope(address)
  return s ? orderHistoryPage(s.orderAccounts, q.kind, q.offset, q.limit) : null
}
export async function getTagOrderHistory(tagId: string, q: OrderHistoryQuery): Promise<OrderHistoryPage | null> {
  const s = tagScope(tagId)
  return s ? orderHistoryPage(s.orderAccounts, q.kind, q.offset, q.limit) : null
}
export async function getListTagOrderHistory(listId: string, tagId: string, members: string[], q: OrderHistoryQuery): Promise<OrderHistoryPage | null> {
  const s = listTagScope(listId, tagId, members)
  return s ? orderHistoryPage(s.orderAccounts, q.kind, q.offset, q.limit) : null
}

export async function getAddressLiquidityRewards(address: string): Promise<LiquidityRewardsClaimed | null> {
  const s = await addressScope(address)
  return s ? cachedLiquidityRewardsClaimed(s.scope, s.lpAccounts) : null
}
export async function getTagLiquidityRewards(tagId: string): Promise<LiquidityRewardsClaimed | null> {
  const s = tagScope(tagId)
  return s ? cachedLiquidityRewardsClaimed(s.scope, s.lpAccounts) : null
}
export async function getListTagLiquidityRewards(listId: string, tagId: string, members: string[]): Promise<LiquidityRewardsClaimed | null> {
  const s = listTagScope(listId, tagId, members)
  return s ? cachedLiquidityRewardsClaimed(s.scope, s.lpAccounts) : null
}
