// Concentrated-liquidity (Uniswap v3) pools on Hydration's EVM and the Gamma
// vaults that manage positions in them — the read side of clickhouse/schema/
// 010_uniswap_v3.sql.
//
// The chain announces a pool through its factory's PoolCreated log and a vault
// through HypervisorCreated, so everything here discovers itself from the tables
// those logs feed; nothing is hardcoded to the first deployment (aDOT/HOLLAR 0.3%,
// 2026-09-08). A pool's tokens are EVM addresses; they resolve to registry assets
// three ways — the `0x…01 + id` asset precompile, an aToken contract through
// atoken_reserve_map, or a deployed ERC-20 the money-market map already knows
// (HOLLAR) — and the caller supplies that last lookup so this module never imports
// explorerService (which imports it).
//
// What a reader gets is a V3Activity: the economic act behind a group of logs.
// The pool contract is not where users act — a position is opened through the
// NonfungiblePositionManager and a vault deposit through the Gamma Hypervisor,
// and both of those then Mint into the pool — so the pool's Mint/Burn/Collect are
// plumbing whenever a known manager or vault owns the position, and stand on their
// own only for a contract nobody announced. classifyV3Events is pure and pinned
// by api/tests/uniswapV3Service.test.ts.

import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import { UNDERLYING_TO_ATOKEN_ID } from './explorerAssets.ts'
import { precompileAssetId, v3VaultTotals } from './uniswapV3Positions.ts'
import { v3ActiveLiquidityAtTick } from './uniswapV3Ranges.ts'

let client: ClickHouseClient
export function initUniswapV3Service(c: ClickHouseClient): void { client = c }

// Await the query before reading its rows: the real client answers a Promise, the
// test fakes a plain result object, and `.then` on the latter is not a function.
async function queryRows<T>(params: Parameters<ClickHouseClient['query']>[0]): Promise<T[]> {
  const res = await client.query(params)
  return (await res.json<T>()) as T[]
}

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

const Q96 = 2 ** 96

/** token1 per token0, in whole tokens, from the pool's sqrtPriceX96 (uint160). */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Q96
  return ratio * ratio * 10 ** (decimals0 - decimals1)
}

/** token1 per token0 at a tick: 1.0001^tick, decimal-adjusted like the sqrt price. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1)
}

/** A pool fee in hundredths of a bip (3000 = 0.3%) as the product writes it. */
export function feeTierLabel(fee: number): string {
  return `${(fee / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
}

const H160_RE = /^0x[0-9a-fA-F]{40}$/

/** The AccountId32 the chain gives an EVM address: `ETH\0` + H160 + zeros. */
export function ethPrefixedAccountId(h160: string): string | null {
  return H160_RE.test(h160) ? '0x45544800' + h160.slice(2).toLowerCase() + '0000000000000000' : null
}

/**
 * An EVM token address → registry asset id. `aTokenReserve` maps an aToken
 * contract to its reserve's precompile address (atoken_reserve_map); the aToken
 * itself is the asset the pool holds (aDOT 1001, not DOT 5), found through the
 * registry's reserve→aToken map, with the reserve as the fallback for an aToken
 * the registry has not named. `contractAsset` is the deployed-ERC-20 lookup.
 */
export function resolveV3TokenAsset(
  addr: string,
  aTokenReserve: ReadonlyMap<string, string>,
  contractAsset: (addr: string) => number | null,
): number | null {
  const a = addr.toLowerCase()
  const direct = precompileAssetId(a)
  if (direct != null) return direct
  const reserve = aTokenReserve.get(a)
  if (reserve) {
    const reserveId = precompileAssetId(reserve) ?? contractAsset(reserve)
    if (reserveId != null) return UNDERLYING_TO_ATOKEN_ID[reserveId] ?? reserveId
  }
  return contractAsset(a)
}

// ---------------------------------------------------------------------------
// rows and classification
// ---------------------------------------------------------------------------

export interface V3EventRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  contract_address: string
  kind: 'pool' | 'manager' | 'vault'
  event_name: string
  actor: string
  counterparty: string
  owner: string
  token_id: string
  tick_lower: number
  tick_upper: number
  tick: number
  liquidity: string
  /** Signed for a Swap (positive = paid into the pool); unsigned elsewhere. */
  amount0: string
  amount1: string
  sqrt_price_x96: string
  aux0: string
  aux1: string
}

export interface V3PoolInfo {
  address: string
  token0: string
  token1: string
  asset0: number | null
  asset1: number | null
  fee: number
}

export interface V3ClassifyContext {
  pools: ReadonlyMap<string, V3PoolInfo>
  /** Position managers: every contract that ever emitted IncreaseLiquidity. */
  managers: ReadonlySet<string>
  /** Vault → the pool it manages. */
  vaults: ReadonlyMap<string, string>
  /** `${manager}:${tokenId}` → current owner (H160), from the ERC-721 transfers. */
  ownerOfToken: ReadonlyMap<string, string>
}

export type V3Action = 'Add' | 'Remove' | 'CollectFees' | 'Rebalance' | 'Create'

export interface V3Activity {
  kind: 'swap' | 'liquidity'
  action?: V3Action
  blockHeight: number
  timestamp: string
  eventIndex: number
  extrinsicIndex: number | null
  /** The pool the act is in (null only for a manager row whose pool never surfaced). */
  pool: string | null
  contract: string
  asset0: number | null
  asset1: number | null
  /** Unsigned raw amounts of token0/token1 the act moved. */
  amount0: string
  amount1: string
  assetIn?: number | null
  assetOut?: number | null
  amountIn?: string
  amountOut?: string
  /** ETH-prefixed AccountId32 of the actor the LOG names; null leaves it to the extrinsic signer. */
  whoAccountId: string | null
  tokenId?: string
  tickLower?: number
  tickUpper?: number
  tick?: number
  vault?: string
  shares?: string
  sqrtPriceX96?: string
  liquidity?: string
}

const ZERO = '0x0000000000000000000000000000000000000000'

function big(s: string): bigint {
  try { return BigInt(s || '0') } catch { return 0n }
}
function abs(n: bigint): bigint { return n < 0n ? -n : n }
function pos(n: bigint): string { return (n > 0n ? n : 0n).toString() }

/**
 * Turn the logs of one or more extrinsics into economic acts. Rows may span
 * extrinsics; they are grouped by (block, extrinsic) and each group is read in
 * event order. The output is ordered oldest→newest by (block, event index).
 */
export function classifyV3Events(rows: readonly V3EventRow[], ctx: V3ClassifyContext): V3Activity[] {
  const groups = new Map<string, V3EventRow[]>()
  for (const r of rows) {
    const key = `${r.block_height}:${r.extrinsic_index ?? 'hook'}`
    const g = groups.get(key)
    if (g) g.push(r); else groups.set(key, [r])
  }
  const out: V3Activity[] = []
  for (const group of groups.values()) out.push(...classifyGroup(group.sort((a, b) => a.event_index - b.event_index), ctx))
  return out.sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)
}

function classifyGroup(rows: V3EventRow[], ctx: V3ClassifyContext): V3Activity[] {
  const out: V3Activity[] = []
  const poolOf = (addr: string): V3PoolInfo | undefined => ctx.pools.get(addr.toLowerCase())
  const base = (r: V3EventRow, pool: V3PoolInfo | null): Pick<V3Activity, 'blockHeight' | 'timestamp' | 'eventIndex' | 'extrinsicIndex' | 'pool' | 'contract' | 'asset0' | 'asset1'> => ({
    blockHeight: r.block_height, timestamp: r.ts, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index,
    pool: pool?.address ?? null, contract: r.contract_address, asset0: pool?.asset0 ?? null, asset1: pool?.asset1 ?? null,
  })

  // The pool rows a manager or vault produced while acting: never acts themselves,
  // but the manager's rows read their pool and tick range off them.
  const poolRows = rows.filter(r => r.kind === 'pool' && poolOf(r.contract_address))
  const claimed = new Set<V3EventRow>()
  const claimPoolRow = (owner: string, names: string[], before: number): V3EventRow | undefined => {
    // Nearest preceding unclaimed pool row of that owner: the manager emits its own
    // event right after the pool's, so adjacency pairs them inside a batch too.
    let best: V3EventRow | undefined
    for (const r of poolRows) {
      if (claimed.has(r) || r.owner !== owner || !names.includes(r.event_name) || r.event_index > before) continue
      if (!best || r.event_index > best.event_index) best = r
    }
    if (best) claimed.add(best)
    return best
  }
  // A same-group ERC-721 transfer names a position's owner before the ownership
  // map (built from history) can know it.
  const ownerFromGroup = (manager: string, tokenId: string): string | undefined =>
    rows.filter(r => r.kind === 'manager' && r.event_name === 'Transfer' && r.contract_address === manager && r.token_id === tokenId)
      .sort((a, b) => b.event_index - a.event_index)[0]?.counterparty

  // Principal booked by DecreaseLiquidity per position: the following Collect pays
  // principal + fees, and only the fees are a new act.
  const decreased = new Map<string, { a0: bigint; a1: bigint }>()
  // Same idea for a pool-direct Burn (per owner + range).
  const burned = new Map<string, { a0: bigint; a1: bigint }>()

  for (const r of rows) {
    if (r.kind === 'manager' && ctx.managers.has(r.contract_address)) {
      const key = `${r.contract_address}:${r.token_id}`
      const owner = ownerFromGroup(r.contract_address, r.token_id) ?? ctx.ownerOfToken.get(key)
      const who = owner && owner !== ZERO ? ethPrefixedAccountId(owner) : null
      if (r.event_name === 'IncreaseLiquidity') {
        const mint = claimPoolRow(r.contract_address, ['Mint'], r.event_index)
        const pool = mint ? poolOf(mint.contract_address) ?? null : null
        out.push({
          kind: 'liquidity', action: 'Add', ...base(r, pool), amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
          whoAccountId: who, tokenId: r.token_id, liquidity: r.liquidity,
          ...(mint ? { tickLower: mint.tick_lower, tickUpper: mint.tick_upper } : {}),
        })
      } else if (r.event_name === 'DecreaseLiquidity') {
        const burn = claimPoolRow(r.contract_address, ['Burn'], r.event_index)
        const pool = burn ? poolOf(burn.contract_address) ?? null : null
        const prev = decreased.get(key) ?? { a0: 0n, a1: 0n }
        decreased.set(key, { a0: prev.a0 + big(r.amount0), a1: prev.a1 + big(r.amount1) })
        out.push({
          kind: 'liquidity', action: 'Remove', ...base(r, pool), amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
          whoAccountId: who, tokenId: r.token_id, liquidity: r.liquidity,
          ...(burn ? { tickLower: burn.tick_lower, tickUpper: burn.tick_upper } : {}),
        })
      } else if (r.event_name === 'Collect') {
        const collect = claimPoolRow(r.contract_address, ['Collect'], r.event_index)
        const pool = collect ? poolOf(collect.contract_address) ?? null : null
        const principal = decreased.get(key) ?? { a0: 0n, a1: 0n }
        const fee0 = big(r.amount0) - principal.a0
        const fee1 = big(r.amount1) - principal.a1
        // Fees are what the collect paid beyond the principal the decrease booked;
        // a collect that only settled principal is that decrease's plumbing.
        if (fee0 > 0n || fee1 > 0n) {
          const recipient = r.counterparty && r.counterparty !== ZERO ? ethPrefixedAccountId(r.counterparty) : null
          out.push({
            kind: 'liquidity', action: 'CollectFees', ...base(r, pool), amount0: pos(fee0), amount1: pos(fee1),
            whoAccountId: recipient ?? who, tokenId: r.token_id,
            ...(collect ? { tickLower: collect.tick_lower, tickUpper: collect.tick_upper } : {}),
          })
        }
      }
      continue
    }
    if (r.kind === 'vault') {
      const poolAddr = ctx.vaults.get(r.contract_address)
      if (!poolAddr) continue
      const pool = poolOf(poolAddr) ?? null
      // The vault's own pool rows are its plumbing whatever it did.
      for (const p of poolRows) if (p.owner === r.contract_address) claimed.add(p)
      if (r.event_name === 'Deposit' || r.event_name === 'Withdraw') {
        const to = r.counterparty && r.counterparty !== ZERO ? r.counterparty : r.actor
        out.push({
          kind: 'liquidity', action: r.event_name === 'Deposit' ? 'Add' : 'Remove', ...base(r, pool),
          amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
          whoAccountId: ethPrefixedAccountId(to), vault: r.contract_address, shares: r.liquidity,
        })
      } else if (r.event_name === 'Rebalance') {
        out.push({
          kind: 'liquidity', action: 'Rebalance', ...base(r, pool), amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
          whoAccountId: null, vault: r.contract_address, shares: r.liquidity, tick: r.tick,
        })
      }
      continue
    }
    if (r.kind !== 'pool') continue
    const pool = poolOf(r.contract_address)
    if (!pool) continue
    if (r.event_name === 'Swap') {
      const a0 = big(r.amount0), a1 = big(r.amount1)
      const zeroForOne = a0 > 0n
      out.push({
        kind: 'swap', ...base(r, pool), amount0: abs(a0).toString(), amount1: abs(a1).toString(),
        assetIn: zeroForOne ? pool.asset0 : pool.asset1, assetOut: zeroForOne ? pool.asset1 : pool.asset0,
        amountIn: abs(zeroForOne ? a0 : a1).toString(), amountOut: abs(zeroForOne ? a1 : a0).toString(),
        whoAccountId: r.counterparty && r.counterparty !== ZERO ? ethPrefixedAccountId(r.counterparty) : null,
        sqrtPriceX96: r.sqrt_price_x96, tick: r.tick, liquidity: r.liquidity,
      })
      continue
    }
    // A position owned by a known manager or vault is read from THEIR events above.
    if (ctx.managers.has(r.owner) || ctx.vaults.has(r.owner)) continue
    const rangeKey = `${r.owner}:${r.tick_lower}:${r.tick_upper}`
    if (r.event_name === 'Mint') {
      out.push({
        kind: 'liquidity', action: 'Add', ...base(r, pool), amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
        whoAccountId: null, tickLower: r.tick_lower, tickUpper: r.tick_upper, liquidity: r.liquidity,
      })
    } else if (r.event_name === 'Burn') {
      // burn(0) is the poke Uniswap requires before a collect can pay fees: no act.
      if (big(r.liquidity) === 0n) continue
      const prev = burned.get(rangeKey) ?? { a0: 0n, a1: 0n }
      burned.set(rangeKey, { a0: prev.a0 + big(r.amount0), a1: prev.a1 + big(r.amount1) })
      out.push({
        kind: 'liquidity', action: 'Remove', ...base(r, pool), amount0: pos(big(r.amount0)), amount1: pos(big(r.amount1)),
        whoAccountId: null, tickLower: r.tick_lower, tickUpper: r.tick_upper, liquidity: r.liquidity,
      })
    } else if (r.event_name === 'Collect') {
      const principal = burned.get(rangeKey) ?? { a0: 0n, a1: 0n }
      const fee0 = big(r.amount0) - principal.a0
      const fee1 = big(r.amount1) - principal.a1
      if (fee0 > 0n || fee1 > 0n) {
        out.push({
          kind: 'liquidity', action: 'CollectFees', ...base(r, pool), amount0: pos(fee0), amount1: pos(fee1),
          whoAccountId: r.counterparty && r.counterparty !== ZERO ? ethPrefixedAccountId(r.counterparty) : null,
          tickLower: r.tick_lower, tickUpper: r.tick_upper,
        })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export interface V3Vault {
  address: string
  factory: string
  token0: string
  token1: string
  fee: number
  index: number
  createdBlock: number
  createdAt: string
  pool: string | null
}
export interface V3Pool extends V3PoolInfo {
  factory: string
  tickSpacing: number
  createdBlock: number
  createdAt: string
  createdExtrinsic: number | null
  vault: V3Vault | null
}
export interface V3Registry {
  pools: Map<string, V3Pool>
  vaults: Map<string, V3Vault>
  managers: Set<string>
  /** asset id → the pools holding it (either side). */
  byAsset: Map<number, string[]>
  ctx: V3ClassifyContext
}

const EMPTY_REGISTRY: V3Registry = {
  pools: new Map(), vaults: new Map(), managers: new Set(), byAsset: new Map(),
  ctx: { pools: new Map(), managers: new Set(), vaults: new Map(), ownerOfToken: new Map() },
}

/**
 * Every pool, vault and position manager the chain has announced, with the
 * tokens resolved to assets. Small (a handful of rows) and SWR-cached: a pool
 * created a minute ago appears within the fresh window.
 */
export async function loadV3Registry(contractAsset: (addr: string) => number | null): Promise<V3Registry> {
  if (!client) return EMPTY_REGISTRY
  return cachedSwr('uniswap-v3:registry', 30_000, 600_000, async () => {
    const [poolRows, vaultRows, managerRows, reserveRows, ownerRows] = await Promise.all([
      queryRows<{ pool_address: string; factory: string; token0: string; token1: string; fee: number; tick_spacing: number; block_height: number; ts: string; extrinsic_index: number | null }>({
        query: `SELECT pool_address, factory, token0, token1, fee, tick_spacing, block_height, toString(block_timestamp) AS ts, extrinsic_index
                FROM price_data.uniswap_v3_pools FINAL ORDER BY block_height, event_index`,
        format: 'JSONEachRow',
      }),
      queryRows<{ vault_address: string; factory: string; token0: string; token1: string; fee: number; vault_index: string | number; block_height: number; ts: string }>({
        query: `SELECT vault_address, factory, token0, token1, fee, toUInt64(vault_index) AS vault_index, block_height, toString(block_timestamp) AS ts
                FROM price_data.uniswap_v3_vaults FINAL ORDER BY block_height, event_index`,
        format: 'JSONEachRow',
      }),
      queryRows<{ contract_address: string }>({
        query: `SELECT DISTINCT contract_address FROM price_data.uniswap_v3_events WHERE kind = 'manager' AND event_name = 'IncreaseLiquidity'`,
        format: 'JSONEachRow',
      }),
      queryRows<{ atoken: string; reserve: string }>({
        query: `SELECT lower(atoken) AS atoken, any(asset_address) AS reserve FROM price_data.atoken_reserve_map FINAL GROUP BY atoken`,
        format: 'JSONEachRow',
      }),
      // The last real holder: a closed position's NFT is burnt (Transfer to the zero
      // address), and the zero address is nobody's page.
      queryRows<{ contract_address: string; token_id: string; owner: string }>({
        query: `SELECT contract_address, toString(token_id) AS token_id,
                       argMaxIf(counterparty, (block_height, event_index), counterparty != '0x0000000000000000000000000000000000000000') AS owner
                FROM price_data.uniswap_v3_events WHERE kind = 'manager' AND event_name = 'Transfer'
                GROUP BY contract_address, token_id`,
        format: 'JSONEachRow',
      }),
    ])
    const aTokenReserve = new Map(reserveRows.map(r => [r.atoken.toLowerCase(), r.reserve.toLowerCase()]))
    const resolve = (addr: string) => resolveV3TokenAsset(addr, aTokenReserve, contractAsset)

    const pools = new Map<string, V3Pool>()
    for (const p of poolRows) {
      pools.set(p.pool_address, {
        address: p.pool_address, factory: p.factory, token0: p.token0, token1: p.token1,
        asset0: resolve(p.token0), asset1: resolve(p.token1), fee: Number(p.fee), tickSpacing: Number(p.tick_spacing),
        createdBlock: Number(p.block_height), createdAt: p.ts, createdExtrinsic: p.extrinsic_index, vault: null,
      })
    }
    const vaults = new Map<string, V3Vault>()
    for (const v of vaultRows) {
      const pool = [...pools.values()].find(p => p.token0 === v.token0 && p.token1 === v.token1 && p.fee === Number(v.fee)) ?? null
      const vault: V3Vault = {
        address: v.vault_address, factory: v.factory, token0: v.token0, token1: v.token1, fee: Number(v.fee),
        index: Number(v.vault_index), createdBlock: Number(v.block_height), createdAt: v.ts, pool: pool?.address ?? null,
      }
      vaults.set(v.vault_address, vault)
      if (pool) pool.vault = vault
    }
    const managers = new Set(managerRows.map(r => r.contract_address.toLowerCase()))
    // A manager only exists once someone opened a position through it; the first
    // deployment's manager is known from the chain, so an empty pool still labels
    // its manager rows.
    const byAsset = new Map<number, string[]>()
    for (const p of pools.values()) {
      for (const id of [p.asset0, p.asset1]) {
        if (id == null) continue
        byAsset.set(id, [...(byAsset.get(id) ?? []), p.address])
      }
    }
    const ownerOfToken = new Map(ownerRows.map(r => [`${r.contract_address}:${r.token_id}`, r.owner]))
    return {
      pools, vaults, managers, byAsset,
      ctx: {
        pools: new Map([...pools.values()].map(p => [p.address, p])),
        managers,
        vaults: new Map([...vaults.values()].filter(v => v.pool).map(v => [v.address, v.pool as string])),
        ownerOfToken,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

const EVENT_COLUMNS = `block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, contract_address, kind, event_name,
  actor, counterparty, owner, toString(token_id) AS token_id, tick_lower, tick_upper, tick, toString(liquidity) AS liquidity,
  toString(amount0) AS amount0, toString(amount1) AS amount1, toString(sqrt_price_x96) AS sqrt_price_x96, toString(aux0) AS aux0, toString(aux1) AS aux1`

/** The events that become rows; everything else is read only as their context. */
const ANCHOR_EVENTS: Record<'swap' | 'liquidity', string> = {
  swap: `(kind = 'pool' AND event_name = 'Swap')`,
  liquidity: `((kind = 'manager' AND event_name IN ('IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'))
    OR (kind = 'vault' AND event_name IN ('Deposit', 'Withdraw', 'Rebalance'))
    OR (kind = 'pool' AND event_name IN ('Mint', 'Burn', 'Collect')))`,
}

function sqlList(values: readonly string[]): string {
  return values.map(v => `'${v.toLowerCase().replace(/[^0-9a-fx]/g, '')}'`).join(',') || "''"
}

export interface V3FeedOptions {
  /** SQL predicate on block_height / block_timestamp for the window ('1' = everything). */
  bound?: string
  kind: 'swap' | 'liquidity' | 'all'
  /** H160s whose acts are wanted (a log naming them, or a position NFT they hold). */
  accountsH160?: string[]
  /** Pool addresses to narrow to (a vault's or manager's rows join through their pool). */
  pools?: string[]
  limit: number
  offset?: number
}

/**
 * Newest-first acts for a feed page. Anchors are paged in SQL; then every log of
 * the anchors' extrinsics is read so the classifier sees whole groups (a
 * manager's Mint and IncreaseLiquidity, a decrease and its collect).
 */
export async function v3FeedActivities(registry: V3Registry, opts: V3FeedOptions): Promise<V3Activity[]> {
  if (!client || !registry.pools.size) return []
  const where: string[] = [opts.bound ?? '1']
  const anchor = opts.kind === 'all' ? `(${ANCHOR_EVENTS.swap} OR ${ANCHOR_EVENTS.liquidity})` : ANCHOR_EVENTS[opts.kind]
  where.push(anchor)
  // A pool Mint/Burn/Collect owned by a manager or a vault is that contract's plumbing
  // (the classifier reads the act from the manager's or vault's own event), never an
  // act — and the vault's compounding pokes a Burn+Collect pair every few minutes, so
  // left in they crowd every real act out of a newest-first anchor page.
  const plumbingOwners = [...registry.managers, ...registry.vaults.keys()]
  if (plumbingOwners.length) {
    where.push(`NOT (kind = 'pool' AND event_name IN ('Mint', 'Burn', 'Collect') AND owner IN (${sqlList(plumbingOwners)}))`)
  }
  if (opts.pools) {
    const pools = opts.pools.map(p => p.toLowerCase())
    const vaults = [...registry.vaults.values()].filter(v => v.pool && pools.includes(v.pool)).map(v => v.address)
    // Manager rows carry no pool; the pool rows they sit beside do, so manager
    // anchors are kept when their extrinsic touched one of the pools.
    where.push(`(contract_address IN (${sqlList([...pools, ...vaults])})
      OR (kind = 'manager' AND (block_height, ifNull(extrinsic_index, 4294967295)) IN (
        SELECT block_height, ifNull(extrinsic_index, 4294967295) FROM price_data.uniswap_v3_events
        WHERE kind = 'pool' AND contract_address IN (${sqlList(pools)}) AND ${opts.bound ?? '1'})))`)
  }
  if (opts.accountsH160) {
    const list = sqlList(opts.accountsH160)
    where.push(`(actor IN (${list}) OR counterparty IN (${list}) OR owner IN (${list})
      OR (kind = 'manager' AND (contract_address, token_id) IN (
        SELECT contract_address, token_id FROM price_data.uniswap_v3_events
        WHERE kind = 'manager' AND event_name = 'Transfer' AND counterparty IN (${list}))))`)
  }
  const want = (opts.offset ?? 0) + opts.limit
  // Several logs collapse into one act (a decrease and its collect; a vault's
  // plumbing), so anchors over-fetch.
  const scan = Math.min(Math.max(want * 4, 100), 20_000)
  const anchors = await queryRows<{ block_height: number; extrinsic_index: number | null }>({
    query: `SELECT block_height, extrinsic_index FROM price_data.uniswap_v3_events FINAL
            WHERE ${where.join(' AND ')}
            ORDER BY block_height DESC, event_index DESC LIMIT {scan:UInt32}`,
    query_params: { scan }, format: 'JSONEachRow',
  })
  if (!anchors.length) return []
  const rows = await eventsOfExtrinsics(anchors.map(a => [a.block_height, a.extrinsic_index]))
  let acts = classifyV3Events(rows, registry.ctx).reverse()
  if (opts.kind !== 'all') acts = acts.filter(a => a.kind === opts.kind)
  if (opts.pools) {
    const pools = new Set(opts.pools.map(p => p.toLowerCase()))
    acts = acts.filter(a => a.pool && pools.has(a.pool))
  }
  if (opts.accountsH160) {
    const ids = new Set(opts.accountsH160.map(ethPrefixedAccountId).filter((x): x is string => x != null))
    acts = acts.filter(a => a.whoAccountId == null || ids.has(a.whoAccountId))
  }
  return acts.slice(opts.offset ?? 0, want)
}

async function eventsOfExtrinsics(pairs: [number, number | null][]): Promise<V3EventRow[]> {
  const keys = [...new Set(pairs.map(([h, e]) => `${h}:${e ?? 'hook'}`))]
  if (!keys.length) return []
  const tuples = keys.map(k => { const [h, e] = k.split(':'); return `(${h},${e === 'hook' ? 4294967295 : e})` }).join(',')
  return queryRows<V3EventRow>({
    query: `SELECT ${EVENT_COLUMNS} FROM price_data.uniswap_v3_events FINAL
            WHERE (block_height, ifNull(extrinsic_index, 4294967295)) IN (${tuples})
            ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
}

/** The acts of one extrinsic (its Activity section) or of a whole block. */
export async function v3ActivitiesAt(registry: V3Registry, height: number, extrinsicIndex?: number): Promise<V3Activity[]> {
  if (!client || !registry.pools.size) return []
  const rows = await queryRows<V3EventRow>({
    query: `SELECT ${EVENT_COLUMNS} FROM price_data.uniswap_v3_events FINAL
            WHERE block_height = {h:UInt32} ${extrinsicIndex == null ? '' : 'AND extrinsic_index = {i:UInt32}'}
            ORDER BY event_index`,
    query_params: { h: height, i: extrinsicIndex ?? 0 }, format: 'JSONEachRow',
  })
  return classifyV3Events(rows, registry.ctx)
}

/** One swap by its Swap log (the /swap/<block>-e<n> page). */
export async function v3SwapAt(registry: V3Registry, height: number, eventIndex: number): Promise<V3Activity | null> {
  const acts = await v3ActivitiesAt(registry, height)
  return acts.find(a => a.kind === 'swap' && a.eventIndex === eventIndex) ?? null
}

// ---------------------------------------------------------------------------
// pool state
// ---------------------------------------------------------------------------

export interface V3PoolStats {
  /** Token balances the pool's own events imply (mints + swaps in − collects − protocol collects + flash fees). */
  balance0: string
  balance1: string
  swapCount: number
  volume0: string
  volume1: string
  volume24h0: string
  volume24h1: string
  /** LP fees realised so far: what collects paid beyond the principal burns booked. */
  fees0: string
  fees1: string
  lastSqrtPriceX96: string | null
  lastTick: number | null
  lastLiquidity: string | null
  /** Liquidity of every range straddling the last tick, net of burns — current, unlike lastLiquidity, which predates any mint since the last swap. */
  inRangeLiquidity: string | null
  /** The pool's protocol-fee denominators after the newest SetFeeProtocol (0 = off): 1/n of each swap fee accrues to the protocol. */
  feeProtocol0: number
  feeProtocol1: number
  lastSwapBlock: number | null
  lastSwapAt: string | null
  firstSwapAt: string | null
  /** Positions ever opened / still holding liquidity, managers and vaults included. */
  positionsOpened: number
}

export async function v3PoolStats(pool: string): Promise<V3PoolStats | null> {
  if (!client) return null
  const rows = await queryRows<Record<string, string | number>>({
    query: `SELECT
              toString(sumIf(amount0, event_name = 'Mint') + sumIf(amount0, event_name = 'Swap') - sumIf(amount0, event_name IN ('Collect', 'CollectProtocol')) + sumIf(toInt256(aux0) - amount0, event_name = 'Flash')) AS balance0,
              toString(sumIf(amount1, event_name = 'Mint') + sumIf(amount1, event_name = 'Swap') - sumIf(amount1, event_name IN ('Collect', 'CollectProtocol')) + sumIf(toInt256(aux1) - amount1, event_name = 'Flash')) AS balance1,
              countIf(event_name = 'Swap') AS swap_count,
              toString(sumIf(abs(amount0), event_name = 'Swap')) AS volume0,
              toString(sumIf(abs(amount1), event_name = 'Swap')) AS volume1,
              toString(sumIf(abs(amount0), event_name = 'Swap' AND block_timestamp > now() - INTERVAL 1 DAY)) AS volume24h0,
              toString(sumIf(abs(amount1), event_name = 'Swap' AND block_timestamp > now() - INTERVAL 1 DAY)) AS volume24h1,
              toString(greatest(sumIf(amount0, event_name = 'Collect') - sumIf(amount0, event_name = 'Burn'), toInt256(0))) AS fees0,
              toString(greatest(sumIf(amount1, event_name = 'Collect') - sumIf(amount1, event_name = 'Burn'), toInt256(0))) AS fees1,
              toString(argMaxIf(sqrt_price_x96, (block_height, event_index), event_name IN ('Swap', 'Initialize'))) AS last_sqrt,
              argMaxIf(tick, (block_height, event_index), event_name IN ('Swap', 'Initialize')) AS last_tick,
              toString(argMaxIf(liquidity, (block_height, event_index), event_name = 'Swap')) AS last_liquidity,
              maxIf(block_height, event_name = 'Swap') AS last_swap_block,
              toString(maxIf(block_timestamp, event_name = 'Swap')) AS last_swap_at,
              toString(minIf(block_timestamp, event_name = 'Swap')) AS first_swap_at,
              countIf(event_name = 'Mint') AS mints,
              countIf(event_name IN ('Swap', 'Initialize')) AS priced,
              toUInt32(argMaxIf(aux0, (block_height, event_index), event_name = 'SetFeeProtocol')) AS fee_protocol0,
              toUInt32(argMaxIf(aux1, (block_height, event_index), event_name = 'SetFeeProtocol')) AS fee_protocol1
            FROM price_data.uniswap_v3_events FINAL
            WHERE kind = 'pool' AND contract_address = {pool:String}`,
    query_params: { pool: pool.toLowerCase() }, format: 'JSONEachRow',
  })
  const r = rows[0]
  if (!r) return null
  const swaps = Number(r.swap_count)
  const priced = Number(r.priced) > 0
  // The ranges straddling the current tick, net of burns: what a swap would trade
  // against now. One definition, in the range-book leaf (uniswapV3Ranges.ts), shared
  // with the public and Data APIs.
  const inRange = priced ? await v3ActiveLiquidityAtTick(client, pool, Number(r.last_tick)) : null
  return {
    balance0: String(r.balance0), balance1: String(r.balance1), swapCount: swaps,
    volume0: String(r.volume0), volume1: String(r.volume1), volume24h0: String(r.volume24h0), volume24h1: String(r.volume24h1),
    fees0: String(r.fees0), fees1: String(r.fees1),
    lastSqrtPriceX96: priced ? String(r.last_sqrt) : null,
    lastTick: priced ? Number(r.last_tick) : null,
    lastLiquidity: swaps > 0 ? String(r.last_liquidity) : null,
    inRangeLiquidity: inRange,
    feeProtocol0: Number(r.fee_protocol0 ?? 0), feeProtocol1: Number(r.fee_protocol1 ?? 0),
    lastSwapBlock: swaps > 0 ? Number(r.last_swap_block) : null,
    lastSwapAt: swaps > 0 ? String(r.last_swap_at) : null,
    firstSwapAt: swaps > 0 ? String(r.first_swap_at) : null,
    positionsOpened: Number(r.mints),
  }
}

export interface V3ManagerPosition {
  manager: string
  tokenId: string
  /** Current NFT owner (H160). */
  owner: string | null
  tickLower: number
  tickUpper: number
  liquidity: string
  /** Net principal still in the position (increases − decreases). */
  amount0: string
  amount1: string
  openedBlock: number
  openedAt: string
  lastBlock: number
}

/** Positions opened through a manager into `pool`, with what is left in them. */
export async function v3ManagerPositions(registry: V3Registry, pool: string): Promise<V3ManagerPosition[]> {
  if (!client || !registry.managers.size) return []
  const rows = await queryRows<{ manager: string; token_id: string; tick_lower: number; tick_upper: number; opened_block: number; opened_at: string; liquidity: string; amount0: string; amount1: string; last_block: number }>({
    query: `WITH ranges AS (
              -- A manager's IncreaseLiquidity sits right after the pool Mint it caused, in
              -- the same extrinsic; that Mint names the pool and the tick range.
              SELECT m.contract_address AS manager, m.token_id AS token_id,
                     argMin(p.tick_lower, (m.block_height, m.event_index)) AS tick_lower,
                     argMin(p.tick_upper, (m.block_height, m.event_index)) AS tick_upper,
                     min(m.block_height) AS opened_block, min(m.block_timestamp) AS opened_at
              FROM price_data.uniswap_v3_events m
              INNER JOIN price_data.uniswap_v3_events p
                ON p.block_height = m.block_height AND p.extrinsic_index = m.extrinsic_index
               AND p.kind = 'pool' AND p.event_name = 'Mint' AND p.owner = m.contract_address
              WHERE m.kind = 'manager' AND m.event_name = 'IncreaseLiquidity'
                AND m.contract_address IN (${sqlList([...registry.managers])})
                AND p.contract_address = {pool:String}
              GROUP BY manager, token_id
            )
            SELECT r.manager AS manager, toString(r.token_id) AS token_id, r.tick_lower AS tick_lower, r.tick_upper AS tick_upper,
                   r.opened_block AS opened_block, toString(r.opened_at) AS opened_at,
                   toString(sumIf(e.liquidity, e.event_name = 'IncreaseLiquidity') - sumIf(e.liquidity, e.event_name = 'DecreaseLiquidity')) AS liquidity,
                   toString(sumIf(e.amount0, e.event_name = 'IncreaseLiquidity') - sumIf(e.amount0, e.event_name = 'DecreaseLiquidity')) AS amount0,
                   toString(sumIf(e.amount1, e.event_name = 'IncreaseLiquidity') - sumIf(e.amount1, e.event_name = 'DecreaseLiquidity')) AS amount1,
                   max(e.block_height) AS last_block
            FROM ranges r
            INNER JOIN price_data.uniswap_v3_events e ON e.contract_address = r.manager AND e.token_id = r.token_id AND e.kind = 'manager'
            GROUP BY manager, token_id, tick_lower, tick_upper, opened_block, opened_at
            ORDER BY opened_block, token_id`,
    query_params: { pool: pool.toLowerCase() }, format: 'JSONEachRow',
  })
  return rows.map(r => ({
    manager: r.manager, tokenId: r.token_id, owner: registry.ctx.ownerOfToken.get(`${r.manager}:${r.token_id}`) ?? null,
    tickLower: Number(r.tick_lower), tickUpper: Number(r.tick_upper), liquidity: r.liquidity,
    amount0: r.amount0, amount1: r.amount1, openedBlock: Number(r.opened_block), openedAt: r.opened_at, lastBlock: Number(r.last_block),
  }))
}

export interface V3VaultStats {
  address: string
  /** Shares outstanding: deposits − withdrawals. */
  shares: string
  depositors: number
  deposits: number
  withdrawals: number
  rebalances: number
  /** The last Rebalance's totals plus the deposits and withdrawals since (net deposits when none ran). */
  total0: string
  total1: string
  /** Fees the vault's positions earned since inception (Rebalance feeAmounts + ZeroBurn fees). */
  fees0: string
  fees1: string
  lastRebalanceBlock: number | null
  lastRebalanceAt: string | null
  lastRebalanceTick: number | null
  /** The divisor of the vault's fee cut: 1/feeDivisor of earned fees goes to the fee recipient. */
  feeDivisor: number | null
  /** Live tick ranges of the vault's positions in the pool, from its most recent mints. */
  ranges: { tickLower: number; tickUpper: number; liquidity: string }[]
}

export async function v3VaultStats(vault: V3Vault): Promise<V3VaultStats | null> {
  if (!client) return null
  const [agg, totals, rangeRows] = await Promise.all([
    queryRows<Record<string, string | number>>({
      // Shares outstanding and the totals they redeem against come from v3VaultTotals
      // (the newest Rebalance restated plus the flows since), the one definition the
      // account-position readers use too.
      query: `SELECT
                uniqExactIf(counterparty, event_name = 'Deposit') AS depositors,
                countIf(event_name = 'Deposit') AS deposits, countIf(event_name = 'Withdraw') AS withdrawals, countIf(event_name = 'Rebalance') AS rebalances,
                toString(sumIf(toInt256(aux0), event_name = 'Rebalance') + sumIf(amount0, event_name = 'ZeroBurn')) AS fees0,
                toString(sumIf(toInt256(aux1), event_name = 'Rebalance') + sumIf(amount1, event_name = 'ZeroBurn')) AS fees1,
                maxIf(block_height, event_name = 'Rebalance') AS last_reb_block,
                toString(maxIf(block_timestamp, event_name = 'Rebalance')) AS last_reb_at,
                argMaxIf(tick, (block_height, event_index), event_name = 'Rebalance') AS last_reb_tick,
                toString(argMaxIf(aux0, (block_height, event_index), event_name = 'SetFee')) AS fee_divisor,
                countIf(event_name = 'SetFee') AS fee_sets
              FROM price_data.uniswap_v3_events FINAL
              WHERE kind = 'vault' AND contract_address = {vault:String}`,
      query_params: { vault: vault.address }, format: 'JSONEachRow',
    }),
    v3VaultTotals(client, [vault.address]),
    vault.pool
      ? queryRows<{ tick_lower: number; tick_upper: number; liquidity: string }>({
          // The vault re-mints its two ranges on every rebalance; the newest mint per
          // range is the live one, and a range whose liquidity was burnt since is gone.
          query: `SELECT tick_lower, tick_upper,
                         toString(sumIf(liquidity, event_name = 'Mint') - sumIf(liquidity, event_name = 'Burn')) AS liquidity,
                         max(block_height) AS last_block
                  FROM price_data.uniswap_v3_events FINAL
                  WHERE kind = 'pool' AND contract_address = {pool:String} AND owner = {vault:String} AND event_name IN ('Mint', 'Burn')
                  GROUP BY tick_lower, tick_upper
                  HAVING liquidity > '0'
                  ORDER BY last_block DESC LIMIT 4`,
          query_params: { pool: vault.pool, vault: vault.address }, format: 'JSONEachRow',
        })
      : Promise.resolve([]),
  ])
  const r = agg[0]
  if (!r) return null
  const rebalances = Number(r.rebalances)
  const total = totals.get(vault.address) ?? { shares: 0n, total0: 0n, total1: 0n }
  return {
    address: vault.address, shares: total.shares.toString(), depositors: Number(r.depositors), deposits: Number(r.deposits),
    withdrawals: Number(r.withdrawals), rebalances,
    total0: total.total0.toString(), total1: total.total1.toString(),
    fees0: String(r.fees0), fees1: String(r.fees1),
    lastRebalanceBlock: rebalances > 0 ? Number(r.last_reb_block) : null,
    lastRebalanceAt: rebalances > 0 ? String(r.last_reb_at) : null,
    lastRebalanceTick: rebalances > 0 ? Number(r.last_reb_tick) : null,
    feeDivisor: Number(r.fee_sets) > 0 ? Number(r.fee_divisor) : null,
    ranges: rangeRows.map(x => ({ tickLower: Number(x.tick_lower), tickUpper: Number(x.tick_upper), liquidity: String(x.liquidity) })),
  }
}

/** Swap-by-swap price points for a pool chart (token1 per token0, raw sqrt price kept for the caller's decimals). */
export async function v3PricePoints(pool: string, limit = 500): Promise<{ ts: string; blockHeight: number; sqrtPriceX96: string; liquidity: string }[]> {
  if (!client) return []
  return queryRows<{ ts: string; block_height: number; sqrtPriceX96: string; liquidity: string }>({
    query: `SELECT toString(block_timestamp) AS ts, block_height, toString(sqrt_price_x96) AS sqrtPriceX96, toString(liquidity) AS liquidity
            FROM price_data.uniswap_v3_events FINAL
            WHERE kind = 'pool' AND contract_address = {pool:String} AND event_name IN ('Swap', 'Initialize')
            ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}`,
    query_params: { pool: pool.toLowerCase(), limit }, format: 'JSONEachRow',
  })
    .then(rows => rows.reverse().map(r => ({ ts: r.ts, blockHeight: Number(r.block_height), sqrtPriceX96: r.sqrtPriceX96, liquidity: r.liquidity })))
}

// ---------------------------------------------------------------------------
// route hops
// ---------------------------------------------------------------------------

/**
 * The pool a Router route hop `PoolType::UniswapV3(fee)` trades through: the one
 * pool holding both assets at that fee tier (the factory allows one pool per
 * (token0, token1, fee), so the answer is unique when it exists). Null when the
 * registry knows no such pool — a hop then renders by its venue and fee alone.
 */
export function v3PoolForHop(registry: Pick<V3Registry, 'pools'>, assetIn: number, assetOut: number, fee: number): V3Pool | null {
  for (const pool of registry.pools.values()) {
    if (pool.fee !== fee) continue
    const pair = [pool.asset0, pool.asset1]
    if (pair.includes(assetIn) && pair.includes(assetOut) && assetIn !== assetOut) return pool
  }
  return null
}
