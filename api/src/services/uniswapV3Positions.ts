// The concentrated-liquidity (Uniswap v3) positions an account holds — now, or at
// the end of any block — folded from the uniswap_v3_events projection
// (clickhouse/schema/010_uniswap_v3.sql) by one definition (v3AccountPositionsRawAt):
//
//  * Manager positions — one per NonfungiblePositionManager NFT the account owns.
//    Ownership is the newest ERC-721 Transfer of that token id (a burnt NFT's last
//    transfer goes to the zero address, so a closed position drops out); what is
//    left in it is the manager's IncreaseLiquidity minus DecreaseLiquidity, for the
//    liquidity and for both token principals. Fees the position has earned but not
//    collected are NOT part of this — they live in pool state no log restates.
//  * Gamma vault shares — the account's balance of a vault's ERC-20 share token
//    (share Transfers in minus out), redeemed pro-rata over what the vault holds:
//    the newest Rebalance's totals plus every deposit and withdrawal since
//    (v3VaultTotals — the same definition the pool page's vault card uses).
//
// Four surfaces read this: the explorer's account page (LpPosition rows, valued at
// current prices), the explorer's value-history chart (the fold stopped at each
// bucket's end block, valued at that bucket's prices), the Data API's
// /v1/accounts/{address}/liquidity/positions and the public API's account balances.
// Both APIs are import leaves, so this module takes its ClickHouse client as an
// argument, imports nothing that reaches explorerService, and resolves a pool's
// token contracts to registry asset ids on its own: the `0x…01 + id` asset
// precompile rule, else the registry tracker's `assets.evm_address` (aTokens,
// HOLLAR). The explorer overlays its richer registry resolution on top.
//
// Amounts stay bigint end to end; pro-rata legs floor, so the sum of every
// holder's legs never exceeds the vault's totals.

import type { ClickHouseClient } from '../db/client.ts'

// ---------------------------------------------------------------------------
// pure math
// ---------------------------------------------------------------------------

/** The registry asset id an ERC-20 precompile address (`0x…01` + 8 hex id) encodes, else null. */
export function precompileAssetId(addr: string): number | null {
  const h = addr.toLowerCase().replace(/^0x/, '')
  return h.length === 40 && /^0{30}01/.test(h) ? parseInt(h.slice(32), 16) : null
}

/** What `shares` of a vault's `totalShares` redeem to, floor pro-rata over its totals. */
export function vaultShareLegs(shares: bigint, totalShares: bigint, total0: bigint, total1: bigint): { amount0: bigint; amount1: bigint } {
  if (shares <= 0n || totalShares <= 0n) return { amount0: 0n, amount1: 0n }
  const pos = (v: bigint) => (v > 0n ? v : 0n)
  return { amount0: (pos(total0) * shares) / totalShares, amount1: (pos(total1) * shares) / totalShares }
}

export interface V3ManagerPositionRow {
  manager: string
  tokenId: string
  /** The pool the position's first Mint went into (null when no Mint sits beside its IncreaseLiquidity). */
  pool: string | null
  token0: string
  token1: string
  fee: number | null
  tickLower: number
  tickUpper: number
  /** Net values, increases − decreases, as decimal strings (may be negative in a malformed history). */
  liquidity: string
  amount0: string
  amount1: string
  openedBlock: number
  lastBlock: number
}

export interface V3VaultHoldingRow {
  vault: string
  pool: string | null
  token0: string
  token1: string
  fee: number
  /** The account's share balance (transfers in − out). */
  shares: string
  /** The vault's outstanding shares and the totals they redeem against. */
  totalShares: string
  total0: string
  total1: string
}

export interface V3AccountPositionsRaw {
  positions: V3ManagerPositionRow[]
  vaults: V3VaultHoldingRow[]
  /** Token contract (lowercase) → registry asset id, for every token the rows above name. */
  tokenAssets: ReadonlyMap<string, number>
}

export interface V3AccountPosition {
  kind: 'position' | 'vault'
  pool: string | null
  fee: number | null
  token0: string
  token1: string
  asset0: number | null
  asset1: number | null
  amount0: bigint
  amount1: bigint
  /** A manager position's liquidity L; a vault holding's share balance. */
  shares: bigint
  /** Vault holdings: the vault's shares outstanding, so a reader can state the fraction. */
  totalShares?: bigint
  manager?: string
  tokenId?: string
  tickLower?: number
  tickUpper?: number
  vault?: string
}

function big(s: string | number | null | undefined): bigint {
  try { return BigInt(String(s ?? '0')) } catch { return 0n }
}

/**
 * The account's open positions from the raw rows: a manager position with
 * liquidity left, a vault holding with shares left. Pure and pinned by
 * api/tests/uniswapV3Positions.test.ts.
 */
export function v3AccountPositions(raw: V3AccountPositionsRaw, resolveToken: (addr: string) => number | null = () => null): V3AccountPosition[] {
  const assetOf = (addr: string): number | null => {
    const a = addr.toLowerCase()
    return resolveToken(a) ?? raw.tokenAssets.get(a) ?? precompileAssetId(a)
  }
  const out: V3AccountPosition[] = []
  for (const p of raw.positions) {
    const liquidity = big(p.liquidity)
    if (liquidity <= 0n) continue
    const pos = (v: bigint) => (v > 0n ? v : 0n)
    out.push({
      kind: 'position', pool: p.pool, fee: p.fee, token0: p.token0, token1: p.token1,
      asset0: p.token0 ? assetOf(p.token0) : null, asset1: p.token1 ? assetOf(p.token1) : null,
      amount0: pos(big(p.amount0)), amount1: pos(big(p.amount1)), shares: liquidity,
      manager: p.manager, tokenId: p.tokenId, tickLower: p.tickLower, tickUpper: p.tickUpper,
    })
  }
  for (const v of raw.vaults) {
    const shares = big(v.shares)
    if (shares <= 0n) continue
    const totalShares = big(v.totalShares)
    const legs = vaultShareLegs(shares, totalShares, big(v.total0), big(v.total1))
    out.push({
      kind: 'vault', pool: v.pool, fee: v.fee, token0: v.token0, token1: v.token1,
      asset0: assetOf(v.token0), asset1: assetOf(v.token1),
      amount0: legs.amount0, amount1: legs.amount1, shares, totalShares, vault: v.vault,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const H160_RE = /^0x[0-9a-f]{40}$/

function h160List(addrs: readonly string[]): string[] {
  return [...new Set(addrs.map(a => a.toLowerCase()).filter(a => H160_RE.test(a)))]
}

// `await` on the client's result rather than `.then`, the form every Data API
// service uses: its contract-test fake answers synchronously.
async function rows<T>(client: ClickHouseClient, query: string, query_params: Record<string, unknown>): Promise<T[]> {
  const res = await client.query({ query, query_params, format: 'JSONEachRow' })
  return res.json<T>()
}

/**
 * Shares outstanding and the token totals they redeem against, per vault: the
 * newest Rebalance restates the whole vault, and the deposits and withdrawals
 * after it move it (net deposits when no rebalance has run). Shared by the pool
 * page's vault card and the account-position readers so the two never disagree.
 */
export async function v3VaultTotals(client: ClickHouseClient, vaults: readonly string[]): Promise<Map<string, { shares: bigint; total0: bigint; total1: bigint }>> {
  const out = new Map<string, { shares: bigint; total0: bigint; total1: bigint }>()
  const list = h160List(vaults)
  if (!list.length) return out
  const totals = await rows<{ vault: string; shares_out: string; total0: string; total1: string }>(client, `-- lp:v3-vault-totals
      WITH reb AS (
        SELECT contract_address AS vault,
               max((block_height, event_index)) AS pos,
               argMax(amount0, (block_height, event_index)) AS reb0,
               argMax(amount1, (block_height, event_index)) AS reb1
        FROM price_data.uniswap_v3_events FINAL
        WHERE kind = 'vault' AND event_name = 'Rebalance' AND contract_address IN {vaults:Array(String)}
        GROUP BY vault
      )
      SELECT f.contract_address AS vault,
             toString(sumIf(toInt256(f.liquidity), f.event_name = 'Deposit') - sumIf(toInt256(f.liquidity), f.event_name = 'Withdraw')) AS shares_out,
             toString(any(r.reb0) + sumIf(f.amount0, f.event_name = 'Deposit' AND (f.block_height, f.event_index) > r.pos) - sumIf(f.amount0, f.event_name = 'Withdraw' AND (f.block_height, f.event_index) > r.pos)) AS total0,
             toString(any(r.reb1) + sumIf(f.amount1, f.event_name = 'Deposit' AND (f.block_height, f.event_index) > r.pos) - sumIf(f.amount1, f.event_name = 'Withdraw' AND (f.block_height, f.event_index) > r.pos)) AS total1
      FROM price_data.uniswap_v3_events AS f FINAL
      LEFT JOIN reb AS r ON r.vault = f.contract_address
      WHERE f.kind = 'vault' AND f.event_name IN ('Deposit', 'Withdraw') AND f.contract_address IN {vaults:Array(String)}
      GROUP BY vault`, { vaults: list })
  for (const r of totals) out.set(r.vault, { shares: big(r.shares_out), total0: big(r.total0), total1: big(r.total1) })
  return out
}

// ---------------------------------------------------------------------------
// the account's venue history, and the fold that states it at any block
// ---------------------------------------------------------------------------

export interface V3ManagerEventRow {
  manager: string
  tokenId: string
  block: number
  index: number
  event: 'Transfer' | 'IncreaseLiquidity' | 'DecreaseLiquidity'
  /** A Transfer's recipient; empty on the liquidity events. */
  holder: string
  liquidity: string
  amount0: string
  amount1: string
}

export interface V3ManagerRangeRow {
  manager: string
  tokenId: string
  pool: string | null
  token0: string
  token1: string
  fee: number | null
  tickLower: number
  tickUpper: number
  openedBlock: number
}

export interface V3VaultShareEventRow { vault: string; block: number; index: number; from: string; to: string; value: string }

export interface V3VaultFlowRow {
  vault: string
  block: number
  index: number
  event: 'Deposit' | 'Withdraw' | 'Rebalance'
  /** Shares minted (Deposit) or burnt (Withdraw); unused on a Rebalance. */
  shares: string
  amount0: string
  amount1: string
}

export interface V3VaultMetaRow { vault: string; pool: string | null; token0: string; token1: string; fee: number }

/**
 * Every row of the venue that bears on what `accounts` held, at any block: the
 * events of each position NFT they were ever sent, the pool range each position
 * opened into, the share transfers of every vault they touched, and those vaults'
 * whole deposit/withdraw/rebalance record (a holder's redeemable legs depend on
 * every other holder's flows).
 */
export interface V3AccountHistoryRaw {
  accounts: string[]
  managerEvents: V3ManagerEventRow[]
  ranges: V3ManagerRangeRow[]
  shareEvents: V3VaultShareEventRow[]
  vaultFlows: V3VaultFlowRow[]
  vaults: V3VaultMetaRow[]
  tokenAssets: ReadonlyMap<string, number>
}

const upTo = (atBlock: number) => (r: { block: number }) => r.block <= atBlock
const after = (a: { block: number; index: number }, b: { block: number; index: number }) => a.block > b.block || (a.block === b.block && a.index > b.index)

/**
 * What the accounts held at the END of block `atBlock` (Infinity: at the head of
 * the projection), in the raw form v3AccountPositions redeems. The same definition
 * at every block:
 *
 *  * a position NFT is the accounts' when its newest Transfer up to the block went
 *    to one of them; what is in it is IncreaseLiquidity minus DecreaseLiquidity up
 *    to the block (liquidity and both principals);
 *  * a vault holding is the accounts' share transfers in minus out; the shares
 *    outstanding are deposits minus withdrawals, and the totals they redeem against
 *    are the newest Rebalance's plus the deposits and withdrawals after it (net
 *    deposits before the first rebalance) — v3VaultTotals, stopped at the block.
 *
 * A transfer between two of the accounts nets to nothing, so a tag's members are
 * one holder. Pure and pinned by api/tests/uniswapV3Positions.test.ts.
 */
export function v3AccountPositionsRawAt(history: V3AccountHistoryRaw, atBlock = Infinity): V3AccountPositionsRaw {
  const accounts = new Set(history.accounts)
  const seen = upTo(atBlock)
  const rangeOf = new Map(history.ranges.map(r => [`${r.manager}:${r.tokenId}`, r]))

  const byToken = new Map<string, { holder: string; liquidity: bigint; amount0: bigint; amount1: bigint; lastBlock: number; manager: string; tokenId: string }>()
  for (const e of history.managerEvents) {
    if (!seen(e)) continue
    const key = `${e.manager}:${e.tokenId}`
    const t = byToken.get(key) ?? { holder: '', liquidity: 0n, amount0: 0n, amount1: 0n, lastBlock: 0, manager: e.manager, tokenId: e.tokenId }
    // Rows arrive in (block, event) order, so the last Transfer seen names the holder.
    if (e.event === 'Transfer') t.holder = e.holder
    const sign = e.event === 'IncreaseLiquidity' ? 1n : e.event === 'DecreaseLiquidity' ? -1n : 0n
    t.liquidity += sign * big(e.liquidity)
    t.amount0 += sign * big(e.amount0)
    t.amount1 += sign * big(e.amount1)
    t.lastBlock = Math.max(t.lastBlock, e.block)
    byToken.set(key, t)
  }
  const positions: V3ManagerPositionRow[] = []
  for (const [key, t] of byToken) {
    if (!accounts.has(t.holder)) continue
    const r = rangeOf.get(key)
    positions.push({
      manager: t.manager, tokenId: t.tokenId, pool: r?.pool ?? null, token0: r?.token0 ?? '', token1: r?.token1 ?? '',
      fee: r?.pool ? r.fee : null, tickLower: r?.tickLower ?? 0, tickUpper: r?.tickUpper ?? 0,
      liquidity: t.liquidity.toString(), amount0: t.amount0.toString(), amount1: t.amount1.toString(),
      openedBlock: r?.openedBlock ?? 0, lastBlock: t.lastBlock,
    })
  }
  positions.sort((a, b) => a.openedBlock - b.openedBlock || (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1))

  const held = new Map<string, bigint>()
  for (const e of history.shareEvents) {
    if (!seen(e)) continue
    const value = big(e.value)
    held.set(e.vault, (held.get(e.vault) ?? 0n) + (accounts.has(e.to) ? value : 0n) - (accounts.has(e.from) ? value : 0n))
  }
  const metaOf = new Map(history.vaults.map(v => [v.vault, v]))
  const vaults: V3VaultHoldingRow[] = []
  for (const [vault, shares] of held) {
    const meta = metaOf.get(vault)
    if (shares <= 0n || !meta) continue
    const flows = history.vaultFlows.filter(f => f.vault === vault && seen(f))
    let rebalance: V3VaultFlowRow | null = null
    for (const f of flows) if (f.event === 'Rebalance' && (!rebalance || after(f, rebalance))) rebalance = f
    let totalShares = 0n
    let total0 = rebalance ? big(rebalance.amount0) : 0n
    let total1 = rebalance ? big(rebalance.amount1) : 0n
    for (const f of flows) {
      if (f.event === 'Rebalance') continue
      const sign = f.event === 'Deposit' ? 1n : -1n
      totalShares += sign * big(f.shares)
      if (!rebalance || after(f, rebalance)) { total0 += sign * big(f.amount0); total1 += sign * big(f.amount1) }
    }
    vaults.push({
      vault, pool: meta.pool, token0: meta.token0, token1: meta.token1, fee: meta.fee,
      shares: shares.toString(), totalShares: totalShares.toString(), total0: total0.toString(), total1: total1.toString(),
    })
  }
  return { positions, vaults, tokenAssets: history.tokenAssets }
}

/**
 * The venue history behind v3AccountPositionsRawAt, for the H160s an account (or
 * a tag's members) acts through. Account-first and tiny: the venue's whole history
 * is a few thousand rows, and an account's share of it a handful.
 */
export async function loadV3AccountHistory(client: ClickHouseClient, accountsH160: readonly string[]): Promise<V3AccountHistoryRaw> {
  const accounts = h160List(accountsH160)
  const empty: V3AccountHistoryRaw = { accounts, managerEvents: [], ranges: [], shareEvents: [], vaultFlows: [], vaults: [], tokenAssets: new Map() }
  if (!accounts.length) return empty
  // A manager is any contract that ever emitted IncreaseLiquidity, so an ERC-721
  // collection that merely transfers 4-topic Transfers (the projection admits
  // them) cannot pose as a position.
  const touched = `
        managers AS (
          SELECT DISTINCT contract_address FROM price_data.uniswap_v3_events
          WHERE kind = 'manager' AND event_name = 'IncreaseLiquidity'
        ),
        touched AS (
          SELECT DISTINCT contract_address, token_id FROM price_data.uniswap_v3_events
          WHERE kind = 'manager' AND event_name = 'Transfer' AND counterparty IN {accounts:Array(String)}
            AND contract_address IN (SELECT contract_address FROM managers)
        )`
  const [managerRows, rangeRows, shareRows] = await Promise.all([
    rows<{ mgr: string; tid: string; b: number; i: number; ev: V3ManagerEventRow['event']; holder: string; liq: string; a0: string; a1: string }>(client, `-- lp:v3-manager-history
        WITH ${touched}
        SELECT contract_address AS mgr, toString(token_id) AS tid, block_height AS b, event_index AS i, event_name AS ev,
               if(event_name = 'Transfer', counterparty, '') AS holder,
               toString(liquidity) AS liq, toString(amount0) AS a0, toString(amount1) AS a1
        FROM price_data.uniswap_v3_events FINAL
        WHERE kind = 'manager' AND event_name IN ('Transfer', 'IncreaseLiquidity', 'DecreaseLiquidity')
          AND (contract_address, token_id) IN (SELECT contract_address, token_id FROM touched)
        ORDER BY b, i`, { accounts }),
    // The pool and range come from the pool Mint the manager's first
    // IncreaseLiquidity sits beside in the same extrinsic.
    rows<{ mgr: string; tid: string; pool_addr: string; t0: string; t1: string; pool_fee: number; lo: number; hi: number; opened: number }>(client, `-- lp:v3-manager-ranges
        WITH ${touched},
        ranges AS (
          SELECT m.contract_address AS manager, m.token_id AS token_id,
                 argMin(p.contract_address, (m.block_height, m.event_index)) AS pool,
                 argMin(p.tick_lower, (m.block_height, m.event_index)) AS tick_lower,
                 argMin(p.tick_upper, (m.block_height, m.event_index)) AS tick_upper,
                 min(m.block_height) AS opened_block
          FROM price_data.uniswap_v3_events AS m
          INNER JOIN price_data.uniswap_v3_events AS p
            ON p.block_height = m.block_height AND p.extrinsic_index = m.extrinsic_index
           AND p.kind = 'pool' AND p.event_name = 'Mint' AND p.owner = m.contract_address
          WHERE m.kind = 'manager' AND m.event_name = 'IncreaseLiquidity'
            AND (m.contract_address, m.token_id) IN (SELECT contract_address, token_id FROM touched)
          GROUP BY manager, token_id
        )
        SELECT r.manager AS mgr, toString(r.token_id) AS tid, r.pool AS pool_addr, pl.token0 AS t0, pl.token1 AS t1, pl.fee AS pool_fee,
               r.tick_lower AS lo, r.tick_upper AS hi, r.opened_block AS opened
        FROM ranges AS r
        LEFT JOIN (SELECT pool_address, token0, token1, fee FROM price_data.uniswap_v3_pools FINAL) AS pl ON pl.pool_address = r.pool`, { accounts }),
    // The vault's ERC-20 share Transfers: a mint comes from the zero address, a
    // burn goes to it.
    rows<{ vault: string; b: number; i: number; src: string; dst: string; value: string }>(client, `-- lp:v3-vault-share-history
        SELECT contract_address AS vault, block_height AS b, event_index AS i, actor AS src, counterparty AS dst, toString(liquidity) AS value
        FROM price_data.uniswap_v3_events FINAL
        WHERE kind = 'vault' AND event_name = 'Transfer'
          AND (actor IN {accounts:Array(String)} OR counterparty IN {accounts:Array(String)})
        ORDER BY b, i`, { accounts }),
  ])
  const touchedVaults = [...new Set(shareRows.map(r => r.vault))]
  const [metaRows, flowRows] = touchedVaults.length
    ? await Promise.all([
        // A vault names its pool by (token0, token1, fee); the pool row with the same triple is it.
        rows<{ vault: string; token0: string; token1: string; fee: number; pool: string }>(client, `-- lp:v3-vault-pools
            SELECT v.vault_address AS vault, v.token0 AS token0, v.token1 AS token1, v.fee AS fee, p.pool_address AS pool
            FROM price_data.uniswap_v3_vaults AS v FINAL
            LEFT JOIN (SELECT pool_address, token0, token1, fee FROM price_data.uniswap_v3_pools FINAL) AS p
              ON p.token0 = v.token0 AND p.token1 = v.token1 AND p.fee = v.fee
            WHERE v.vault_address IN {vaults:Array(String)}`, { vaults: touchedVaults }),
        rows<{ vault: string; b: number; i: number; ev: V3VaultFlowRow['event']; shares: string; a0: string; a1: string }>(client, `-- lp:v3-vault-flow-history
            SELECT contract_address AS vault, block_height AS b, event_index AS i, event_name AS ev,
                   toString(liquidity) AS shares, toString(amount0) AS a0, toString(amount1) AS a1
            FROM price_data.uniswap_v3_events FINAL
            WHERE kind = 'vault' AND event_name IN ('Deposit', 'Withdraw', 'Rebalance') AND contract_address IN {vaults:Array(String)}
            ORDER BY b, i`, { vaults: touchedVaults }),
      ])
    : [[], []]
  const ranges: V3ManagerRangeRow[] = rangeRows.map(r => ({
    manager: r.mgr, tokenId: String(r.tid), pool: r.pool_addr || null, token0: r.t0 ?? '', token1: r.t1 ?? '',
    fee: r.pool_addr ? Number(r.pool_fee) : null, tickLower: Number(r.lo), tickUpper: Number(r.hi), openedBlock: Number(r.opened),
  }))
  const vaults: V3VaultMetaRow[] = metaRows.map(m => ({ vault: m.vault, pool: m.pool || null, token0: m.token0, token1: m.token1, fee: Number(m.fee) }))
  // Token contracts → asset ids. The precompile rule needs no lookup; a deployed
  // ERC-20 (an aToken, HOLLAR) is whatever the registry tracker persisted for it.
  const tokens = [...new Set([...ranges.flatMap(p => [p.token0, p.token1]), ...vaults.flatMap(v => [v.token0, v.token1])].map(t => t.toLowerCase()).filter(t => H160_RE.test(t)))]
  const unresolved = tokens.filter(t => precompileAssetId(t) == null)
  const tokenAssets = new Map<string, number>()
  for (const t of tokens) { const id = precompileAssetId(t); if (id != null) tokenAssets.set(t, id) }
  if (unresolved.length) {
    const found = await rows<{ asset_id: number; addr: string }>(client, `-- lp:v3-token-assets
        SELECT asset_id, lower(evm_address) AS addr FROM price_data.assets FINAL
        WHERE evm_address != '' AND lower(evm_address) IN {addrs:Array(String)}`, { addrs: unresolved })
    for (const r of found) tokenAssets.set(r.addr, Number(r.asset_id))
  }
  return {
    accounts,
    managerEvents: managerRows.map(r => ({
      manager: r.mgr, tokenId: String(r.tid), block: Number(r.b), index: Number(r.i), event: r.ev, holder: r.holder ?? '',
      liquidity: r.liq, amount0: r.a0, amount1: r.a1,
    })),
    ranges,
    shareEvents: shareRows.map(r => ({ vault: r.vault, block: Number(r.b), index: Number(r.i), from: r.src, to: r.dst, value: r.value })),
    vaultFlows: flowRows.map(r => ({ vault: r.vault, block: Number(r.b), index: Number(r.i), event: r.ev, shares: r.shares, amount0: r.a0, amount1: r.a1 })),
    vaults,
    tokenAssets,
  }
}

/** What the H160s an account acts through hold now: the history folded at its head. */
export async function loadV3AccountPositions(client: ClickHouseClient, accountsH160: readonly string[]): Promise<V3AccountPositionsRaw> {
  return v3AccountPositionsRawAt(await loadV3AccountHistory(client, accountsH160))
}
