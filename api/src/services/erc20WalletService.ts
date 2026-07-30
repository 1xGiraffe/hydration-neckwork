import type { ClickHouseClient } from '../db/client.ts'
import { SUBSTRATE_RPC_URL } from './substrateRpc.ts'
import { reservedH160AccountId } from './addressIdentity.ts'

// ERC-20-backed wallet assets: registry assets whose balances live (partly) in
// EVM contract storage rather than the Tokens pallet, so the indexed balance
// observations never see them. This service keeps a small ClickHouse table
// (`erc20_wallet_balances`) current so SQL consumers — the accounts list, the
// holders list, asset totals, and account pages can price them like any other balance.
//
// HOLLAR's canonical supply lives in the contract, with separate Tokens-side
// balances. GIGAHDX is excluded because the underlying staked HDX remains in the
// holder's wallet; aTokens are supplied by money-market reserve reconstruction.
export const ERC20_WALLET_ASSETS: { assetId: number; contract: string }[] = [
  { assetId: 222, contract: '0x531a654d1696ed52e7275a8cede955e82620f99a' },
]
export const ERC20_WALLET_ASSET_IDS = ERC20_WALLET_ASSETS.map(a => a.assetId)

// Hydration's per-asset ERC-20 precompile (0x…0001 + asset id) — balanceOf
// works for any currency without knowing the backing contract.
const erc20Precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const ERC20_BALANCE_OF = '70a08231' // keccak256("balanceOf(address)")[:4]

let client: ClickHouseClient

// Balances for the addresses the node actually answered for. A dropped batch or
// an unparseable item leaves its addresses out of the map — the caller must treat
// them as unknown, never as zero.
async function ethCallBalances(assetId: number, h160s: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const to = erc20Precompile(assetId)
  for (let start = 0; start < h160s.length; start += 80) {
    const chunk = h160s.slice(start, start + 80)
    const calls = chunk.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data: `0x${ERC20_BALANCE_OF}${'0'.repeat(24)}${h.slice(2).toLowerCase()}` }, 'latest'] }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(calls) })
      if (!res.ok) continue
      const json = await res.json() as unknown
      for (const item of Array.isArray(json) ? json : []) {
        if (!item || typeof item !== 'object') continue
        const { id, result } = item as { id?: unknown; result?: unknown }
        if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= chunk.length) continue
        if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) continue
        out.set(chunk[id as number], BigInt(result))
      }
    } catch { /* chunk skipped; next refresh retries */ } finally { clearTimeout(timer) }
  }
  return out
}

// Rows for one refresh cycle. A holder missing from `balances` could not be read
// this cycle — that is unknown, not zero — so it gets no row and keeps its last
// published one. Every holder's anchor still counts as current, so the stale-key
// pass only zeroes keys that no longer belong to any holder.
export function walletBalanceRows(
  assetId: number,
  h160s: string[],
  balances: Map<string, bigint>,
  anchorOf: (h160: string) => string,
  previousNonZeroAccounts: string[],
): { account_id: string; asset_id: string; total: string }[] {
  const asset_id = String(assetId)
  const rows = h160s
    .filter(h => balances.has(h))
    .map(h => ({ account_id: anchorOf(h), asset_id, total: balances.get(h)!.toString() }))
  const current = new Set(h160s.map(anchorOf))
  for (const account_id of previousNonZeroAccounts) {
    if (!current.has(account_id)) rows.push({ account_id, asset_id, total: '0' })
  }
  return rows
}

// Refresh candidates are every address that ever appeared in a Transfer log of
// the backing contract (~1.2k for HOLLAR); each H160 is anchored to its
// substrate account id via the alias table (falling back to the ETH-prefixed
// AccountId32 form) so rows group with the account's other balances.
async function refresh(): Promise<void> {
  for (const a of ERC20_WALLET_ASSETS) {
    const holderRes = await client.query({
      query: `SELECT DISTINCT holder AS h FROM price_data.erc20_transfer_deltas
           WHERE contract_address = {c:String} AND holder != '0x0000000000000000000000000000000000000000'`,
      query_params: { c: a.contract }, format: 'JSONEachRow',
    })
    const h160s = (await holderRes.json<{ h: string }>()).map(r => r.h.toLowerCase())
    if (!h160s.length) continue
    // Prefer the full substrate account so the balance lands on the profile the
    // rest of the explorer groups by: (1) an alias-linked substrate account,
    // (2) a known balance-holding substrate account whose truncated first 20
    // bytes ARE the H160 (aliases only exist once substrate-side activity was
    // observed), (3) the ETH-prefixed AccountId32 form (genuine EVM accounts).
    const [aliasRes, truncRes] = await Promise.all([
      client.query({
        // account_alias_directory holds one row per distinct alias identity (19,867)
        // instead of raw_account_aliases' one row per observation (16.2M).
        query: `SELECT DISTINCT evm_address AS evm, account_id FROM price_data.account_alias_directory
                WHERE evm_address IN ({evms:Array(String)}) AND account_id != ''`,
        query_params: { evms: h160s }, format: 'JSONEachRow',
      }),
      client.query({
        query: `SELECT DISTINCT concat('0x', substring(lower(account_id), 3, 40)) AS evm, lower(account_id) AS account_id
                FROM price_data.account_asset_latest_balances
                WHERE substring(lower(account_id), 3, 8) != '45544800'
                  AND concat('0x', substring(lower(account_id), 3, 40)) IN ({evms:Array(String)})`,
        query_params: { evms: h160s }, format: 'JSONEachRow',
      }),
    ])
    const anchor = new Map<string, string>()
    for (const r of await truncRes.json<{ evm: string; account_id: string }>()) anchor.set(r.evm, r.account_id)
    for (const r of await aliasRes.json<{ evm: string; account_id: string }>()) {
      const isEthPrefixed = r.account_id.startsWith('0x45544800') && r.account_id.endsWith('0000000000000000')
      if (!isEthPrefixed) anchor.set(r.evm, r.account_id.toLowerCase())
    }
    const balances = await ethCallBalances(a.assetId, h160s)
    if (!balances.size) continue // RPC down — keep previous rows
    if (balances.size < h160s.length) {
      console.warn(`[erc20-wallet] partial refresh for asset ${a.assetId}: ${balances.size}/${h160s.length} balances read; unread holders keep their previous rows`)
    }
    // Module/sovereign truncations resolve deterministically; then alias/
    // truncation anchors; genuine EVM accounts keep the ETH-prefixed form.
    const anchorOf = (h: string) => reservedH160AccountId(h.slice(2)) ?? anchor.get(h) ?? `0x45544800${h.slice(2)}0000000000000000`
    // Zero keys that no longer belong to the current account anchor so stale
    // rows cannot double count a wallet balance.
    const prevRes = await client.query({
      query: `SELECT account_id FROM price_data.erc20_wallet_balances WHERE asset_id = {a:String}
              GROUP BY account_id HAVING toUInt256OrZero(argMax(total, updated_at)) > 0`,
      query_params: { a: String(a.assetId) }, format: 'JSONEachRow',
    })
    const previous = (await prevRes.json<{ account_id: string }>()).map(r => r.account_id)
    await client.insert({
      table: 'price_data.erc20_wallet_balances',
      values: walletBalanceRows(a.assetId, h160s, balances, anchorOf, previous),
      format: 'JSONEachRow',
    })
  }
}

let refreshInflight: Promise<void> | null = null

// Cadence is owned by the coordinated background scheduler
// (backgroundRefresh.ts); this keeps only the single-flight guard.
export function refreshErc20Wallets(): Promise<void> {
  if (refreshInflight) return refreshInflight
  const request = refresh()
    .catch(err => console.error('[erc20-wallet] refresh failed', err))
    .finally(() => { if (refreshInflight === request) refreshInflight = null })
  refreshInflight = request
  return request
}

export function initErc20WalletService(c: ClickHouseClient): void {
  client = c
}
