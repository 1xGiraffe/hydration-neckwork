// The concentrated-liquidity (Uniswap v3) positions an account holds RIGHT NOW,
// read from the uniswap_v3_events projection (clickhouse/schema/010_uniswap_v3.sql):
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
// Two surfaces read this: the explorer's account page (LpPosition rows, valued at
// current prices) and the Data API's /v1/accounts/{address}/liquidity/positions.
// The Data API is an import leaf, so this module takes its ClickHouse client as an
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

/**
 * Everything the account-position readers need, for the H160s an account acts
 * through: the manager positions those addresses currently own, the vault shares
 * they hold (with the vault totals to redeem them against), and the asset id of
 * every token contract involved. Account-first and tiny: the venue's whole
 * history is a few thousand rows.
 */
export async function loadV3AccountPositions(client: ClickHouseClient, accountsH160: readonly string[]): Promise<V3AccountPositionsRaw> {
  const accounts = h160List(accountsH160)
  const empty: V3AccountPositionsRaw = { positions: [], vaults: [], tokenAssets: new Map() }
  if (!accounts.length) return empty
  const [positionRows, heldRows] = await Promise.all([
    // A manager is any contract that ever emitted IncreaseLiquidity, so an ERC-721
    // collection that merely transfers 4-topic Transfers (the projection admits
    // them) cannot pose as a position. The pool and range come from the pool Mint
    // the manager's first IncreaseLiquidity sits beside in the same extrinsic.
    rows<{ mgr: string; tid: string; pool_addr: string; t0: string; t1: string; pool_fee: number; lo: number; hi: number; opened: number; net_liquidity: string; net0: string; net1: string; last_block: number }>(client, `-- lp:v3-manager-positions
        WITH managers AS (
          SELECT DISTINCT contract_address FROM price_data.uniswap_v3_events
          WHERE kind = 'manager' AND event_name = 'IncreaseLiquidity'
        ),
        owned AS (
          SELECT contract_address AS manager, token_id,
                 argMax(counterparty, (block_height, event_index)) AS holder
          FROM price_data.uniswap_v3_events FINAL
          WHERE kind = 'manager' AND event_name = 'Transfer'
            AND contract_address IN (SELECT contract_address FROM managers)
            AND (contract_address, token_id) IN (
              SELECT contract_address, token_id FROM price_data.uniswap_v3_events
              WHERE kind = 'manager' AND event_name = 'Transfer' AND counterparty IN {accounts:Array(String)})
          GROUP BY manager, token_id
          HAVING holder IN {accounts:Array(String)}
        ),
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
            AND (m.contract_address, m.token_id) IN (SELECT manager, token_id FROM owned)
          GROUP BY manager, token_id
        )
        SELECT o.manager AS mgr, toString(o.token_id) AS tid,
               r.pool AS pool_addr, pl.token0 AS t0, pl.token1 AS t1, pl.fee AS pool_fee,
               r.tick_lower AS lo, r.tick_upper AS hi, r.opened_block AS opened,
               toString(sumIf(toInt256(e.liquidity), e.event_name = 'IncreaseLiquidity') - sumIf(toInt256(e.liquidity), e.event_name = 'DecreaseLiquidity')) AS net_liquidity,
               toString(sumIf(e.amount0, e.event_name = 'IncreaseLiquidity') - sumIf(e.amount0, e.event_name = 'DecreaseLiquidity')) AS net0,
               toString(sumIf(e.amount1, e.event_name = 'IncreaseLiquidity') - sumIf(e.amount1, e.event_name = 'DecreaseLiquidity')) AS net1,
               max(e.block_height) AS last_block
        FROM owned AS o
        LEFT JOIN ranges AS r ON r.manager = o.manager AND r.token_id = o.token_id
        LEFT JOIN (SELECT pool_address, token0, token1, fee FROM price_data.uniswap_v3_pools FINAL) AS pl ON pl.pool_address = r.pool
        INNER JOIN price_data.uniswap_v3_events AS e FINAL
          ON e.contract_address = o.manager AND e.token_id = o.token_id AND e.kind = 'manager'
        GROUP BY mgr, tid, pool_addr, t0, t1, pool_fee, lo, hi, opened
        ORDER BY opened, tid`, { accounts }),
    // The vault's ERC-20 share Transfers: a mint comes from the zero address, a
    // burn goes to it, and a self-transfer nets to nothing.
    rows<{ vault: string; held: string }>(client, `-- lp:v3-vault-shares
        SELECT contract_address AS vault,
               toString(sumIf(toInt256(liquidity), counterparty IN {accounts:Array(String)}) - sumIf(toInt256(liquidity), actor IN {accounts:Array(String)})) AS held
        FROM price_data.uniswap_v3_events FINAL
        WHERE kind = 'vault' AND event_name = 'Transfer'
          AND (actor IN {accounts:Array(String)} OR counterparty IN {accounts:Array(String)})
        GROUP BY vault`, { accounts }),
  ])
  const heldVaults = heldRows.filter(r => big(r.held) > 0n)
  const [vaultMeta, totals] = heldVaults.length
    ? await Promise.all([
        // A vault names its pool by (token0, token1, fee); the pool row with the same triple is it.
        rows<{ vault: string; token0: string; token1: string; fee: number; pool: string }>(client, `-- lp:v3-vault-pools
            SELECT v.vault_address AS vault, v.token0 AS token0, v.token1 AS token1, v.fee AS fee, p.pool_address AS pool
            FROM price_data.uniswap_v3_vaults AS v FINAL
            LEFT JOIN (SELECT pool_address, token0, token1, fee FROM price_data.uniswap_v3_pools FINAL) AS p
              ON p.token0 = v.token0 AND p.token1 = v.token1 AND p.fee = v.fee
            WHERE v.vault_address IN {vaults:Array(String)}`, { vaults: heldVaults.map(r => r.vault) }),
        v3VaultTotals(client, heldVaults.map(r => r.vault)),
      ])
    : [[], new Map<string, { shares: bigint; total0: bigint; total1: bigint }>()]
  const metaByVault = new Map(vaultMeta.map(m => [m.vault, m]))
  const vaults: V3VaultHoldingRow[] = []
  for (const r of heldVaults) {
    const meta = metaByVault.get(r.vault)
    const total = totals.get(r.vault)
    if (!meta) continue
    vaults.push({
      vault: r.vault, pool: meta.pool || null, token0: meta.token0, token1: meta.token1, fee: Number(meta.fee),
      shares: r.held, totalShares: (total?.shares ?? 0n).toString(), total0: (total?.total0 ?? 0n).toString(), total1: (total?.total1 ?? 0n).toString(),
    })
  }
  const positions: V3ManagerPositionRow[] = positionRows.map(r => ({
    manager: r.mgr, tokenId: String(r.tid), pool: r.pool_addr || null, token0: r.t0 ?? '', token1: r.t1 ?? '',
    fee: r.pool_addr ? Number(r.pool_fee) : null, tickLower: Number(r.lo), tickUpper: Number(r.hi),
    liquidity: r.net_liquidity, amount0: r.net0, amount1: r.net1, openedBlock: Number(r.opened), lastBlock: Number(r.last_block),
  }))
  // Token contracts → asset ids. The precompile rule needs no lookup; a deployed
  // ERC-20 (an aToken, HOLLAR) is whatever the registry tracker persisted for it.
  const tokens = [...new Set([...positions.flatMap(p => [p.token0, p.token1]), ...vaults.flatMap(v => [v.token0, v.token1])].map(t => t.toLowerCase()).filter(t => H160_RE.test(t)))]
  const unresolved = tokens.filter(t => precompileAssetId(t) == null)
  const tokenAssets = new Map<string, number>()
  for (const t of tokens) { const id = precompileAssetId(t); if (id != null) tokenAssets.set(t, id) }
  if (unresolved.length) {
    const found = await rows<{ asset_id: number; addr: string }>(client, `-- lp:v3-token-assets
        SELECT asset_id, lower(evm_address) AS addr FROM price_data.assets FINAL
        WHERE evm_address != '' AND lower(evm_address) IN {addrs:Array(String)}`, { addrs: unresolved })
    for (const r of found) tokenAssets.set(r.addr, Number(r.asset_id))
  }
  return { positions, vaults, tokenAssets }
}
