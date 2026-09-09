/**
 * Concentrated-liquidity (Uniswap v3) pools on Hydration's EVM as price-graph
 * edges and volume sources.
 *
 * The pools speak only through `EVM.Log` events the block stream already carries
 * (`{ log: { address, topics, data } }`), so everything here is a topic-keyed
 * decode of those logs plus the arithmetic that turns a pool's current state into
 * a constant-product edge:
 *
 *   x = L · 2^96 / √P        y = L · √P / 2^96        (raw token units)
 *
 * — the virtual reserves of the tangent constant-product pool at the current
 * price, which is exactly the spot price the graph needs and a liquidity weight
 * that scales with the in-range depth. `Initialize`/`Swap` set √P, tick and L
 * (a Swap's `liquidity` is the in-range liquidity AFTER the swap); `Mint`/`Burn`
 * whose `[tickLower, tickUpper)` contains the current tick adjust L between
 * swaps, mirroring the pool contract's own `_modifyPosition` rule.
 *
 * Discovery is by topic, never by address: any factory's `PoolCreated` announces
 * a pool. Tokens resolve to registry asset ids through the registry tracker's
 * ERC-20 map (a deployed contract such as HOLLAR or an aToken) and the asset
 * precompile rule (`0x…01` + asset id in the low four bytes); a pool with an
 * unresolved token or zero liquidity is no edge at all.
 *
 * Shapes pinned against the first deployment (2026-09-08, runtime 443), see
 * clickhouse/schema/010_uniswap_v3.sql for the same ABI layout in SQL.
 */

import { createClickHouseClient } from '../db/client.js'
import { underlyingAssetIdFromReserveAddress } from '../registry/atokenReserves.js'
import { evmAccountForm } from '../raw/json.js'
import type { UniswapV3PoolEdge } from './types.ts'

export const UNISWAP_V3_TOPICS = {
  // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
  poolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  // Initialize(uint160 sqrtPriceX96, int24 tick)
  initialize: '0x98636036cb66a9c19a37435efc1e90142190214e8abeb821bdba3f2990dd4c95',
  // Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
  swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  // Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
  mint: '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  // Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
  burn: '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
} as const

/** The pool-family signatures, in the form the processor's log filter and the decoder key on. */
export const UNISWAP_V3_POOL_TOPIC0S: readonly string[] = Object.values(UNISWAP_V3_TOPICS)

/** `fillerType.__kind` of a router-routed v3 fill in `Broadcast.Swapped3` (runtime 443+). */
export const UNISWAP_V3_FILLER = 'UniswapV3'

export const EVM_LOG_EVENT_NAME = 'EVM.Log'

const Q96 = 2n ** 96n
const TWO_255 = 2n ** 255n
const TWO_256 = 2n ** 256n
const INT24_SIGN = 2n ** 23n
const INT24_SPAN = 2n ** 24n

export interface EvmLog {
  address: string
  topics: string[]
  data: string
}

export interface UniswapV3Pool {
  address: string
  token0: string
  token1: string
  fee: number
  tickSpacing: number
}

export interface UniswapV3PoolState {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
}

export type UniswapV3LogEvent =
  | { kind: 'poolCreated'; factory: string; pool: UniswapV3Pool }
  | { kind: 'initialize'; pool: string; sqrtPriceX96: bigint; tick: number }
  | { kind: 'swap'; pool: string; sender: string; recipient: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number }
  | { kind: 'mint'; pool: string; owner: string; tickLower: number; tickUpper: number; amount: bigint; amount0: bigint; amount1: bigint }
  | { kind: 'burn'; pool: string; owner: string; tickLower: number; tickUpper: number; amount: bigint; amount0: bigint; amount1: bigint }

/** A pool whose two tokens resolved to registry asset ids — what the volume arm keys on. */
export interface UniswapV3PoolTokens {
  token0AssetId: number
  token1AssetId: number
}

export type UniswapV3PoolIndex = ReadonlyMap<string, UniswapV3PoolTokens>

function hexBody(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const body = value.startsWith('0x') ? value.slice(2) : value
  return /^[0-9a-fA-F]*$/.test(body) ? body.toLowerCase() : null
}

export function normalizeEvmAddress(value: unknown): string | null {
  const body = hexBody(value)
  return body != null && body.length === 40 ? `0x${body}` : null
}

/** The `log` payload of an `EVM.Log` event's args, or null when the shape is not a log. */
export function evmLogOf(args: unknown): EvmLog | null {
  const log = (args as { log?: unknown } | null)?.log as Record<string, unknown> | undefined
  if (log == null || typeof log !== 'object') return null
  const address = normalizeEvmAddress(log.address)
  const data = hexBody(log.data)
  if (address == null || data == null || !Array.isArray(log.topics)) return null
  const topics: string[] = []
  for (const topic of log.topics) {
    const body = hexBody(topic)
    if (body == null || body.length !== 64) return null
    topics.push(`0x${body}`)
  }
  return { address, topics, data: `0x${data}` }
}

// ABI words: 32 bytes each, big-endian, at data offset 64·i hex chars.
function abiWord(data: string, index: number): bigint | null {
  const body = data.startsWith('0x') ? data.slice(2) : data
  const start = index * 64
  if (body.length < start + 64) return null
  return BigInt(`0x${body.slice(start, start + 64)}`)
}

function signedWord(data: string, index: number): bigint | null {
  const value = abiWord(data, index)
  if (value == null) return null
  return value >= TWO_255 ? value - TWO_256 : value
}

function addressFromWord(word: string | bigint): string {
  const body = typeof word === 'bigint' ? word.toString(16).padStart(64, '0') : word.replace(/^0x/, '').padStart(64, '0')
  return `0x${body.slice(24).toLowerCase()}`
}

function int24(value: bigint): number {
  // An indexed int24 is sign-extended to 256 bits in its topic; a data word is
  // an int256 whose value fits int24. Either way the low 24 bits carry it.
  const low = value & (INT24_SPAN - 1n)
  return Number(low >= INT24_SIGN ? low - INT24_SPAN : low)
}

function topicWord(topics: string[], index: number): bigint | null {
  const topic = topics[index]
  return topic == null ? null : BigInt(topic)
}

/** Decode a pool-family log by its topic0. Null for anything that is not one of the five events. */
export function decodeUniswapV3Log(log: EvmLog): UniswapV3LogEvent | null {
  const topic0 = log.topics[0]
  if (topic0 == null) return null

  if (topic0 === UNISWAP_V3_TOPICS.poolCreated) {
    if (log.topics.length !== 4) return null
    const fee = topicWord(log.topics, 3)
    const tickSpacing = abiWord(log.data, 0)
    const pool = abiWord(log.data, 1)
    if (fee == null || tickSpacing == null || pool == null) return null
    return {
      kind: 'poolCreated',
      factory: log.address,
      pool: {
        address: addressFromWord(pool),
        token0: addressFromWord(log.topics[1]),
        token1: addressFromWord(log.topics[2]),
        fee: Number(fee),
        tickSpacing: int24(tickSpacing),
      },
    }
  }

  if (topic0 === UNISWAP_V3_TOPICS.initialize) {
    const sqrtPriceX96 = abiWord(log.data, 0)
    const tick = abiWord(log.data, 1)
    if (sqrtPriceX96 == null || tick == null) return null
    return { kind: 'initialize', pool: log.address, sqrtPriceX96, tick: int24(tick) }
  }

  if (topic0 === UNISWAP_V3_TOPICS.swap) {
    if (log.topics.length !== 3) return null
    const amount0 = signedWord(log.data, 0)
    const amount1 = signedWord(log.data, 1)
    const sqrtPriceX96 = abiWord(log.data, 2)
    const liquidity = abiWord(log.data, 3)
    const tick = abiWord(log.data, 4)
    if (amount0 == null || amount1 == null || sqrtPriceX96 == null || liquidity == null || tick == null) return null
    return {
      kind: 'swap',
      pool: log.address,
      sender: addressFromWord(log.topics[1]),
      recipient: addressFromWord(log.topics[2]),
      amount0,
      amount1,
      sqrtPriceX96,
      liquidity,
      tick: int24(tick),
    }
  }

  if (topic0 === UNISWAP_V3_TOPICS.mint || topic0 === UNISWAP_V3_TOPICS.burn) {
    if (log.topics.length !== 4) return null
    const tickLower = topicWord(log.topics, 2)
    const tickUpper = topicWord(log.topics, 3)
    // Mint's data leads with the non-indexed `sender` word; Burn's starts at `amount`.
    const offset = topic0 === UNISWAP_V3_TOPICS.mint ? 1 : 0
    const amount = abiWord(log.data, offset)
    const amount0 = abiWord(log.data, offset + 1)
    const amount1 = abiWord(log.data, offset + 2)
    if (tickLower == null || tickUpper == null || amount == null || amount0 == null || amount1 == null) return null
    return {
      kind: topic0 === UNISWAP_V3_TOPICS.mint ? 'mint' : 'burn',
      pool: log.address,
      owner: addressFromWord(log.topics[1]),
      tickLower: int24(tickLower),
      tickUpper: int24(tickUpper),
      amount,
      amount0,
      amount1,
    }
  }

  return null
}

/** The pool contract's in-range rule: a position is active while tickLower <= tick < tickUpper. */
export function tickInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tickLower <= tick && tick < tickUpper
}

/**
 * Virtual reserves of the constant-product pool tangent to the curve at √P with
 * in-range liquidity L, in raw token units. Null when either input is zero: an
 * uninitialised pool or one with nothing in range has no price to offer.
 */
export function virtualReserves(sqrtPriceX96: bigint, liquidity: bigint): { reserve0: bigint; reserve1: bigint } | null {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) return null
  const reserve0 = (liquidity * Q96) / sqrtPriceX96
  const reserve1 = (liquidity * sqrtPriceX96) / Q96
  if (reserve0 === 0n || reserve1 === 0n) return null
  return { reserve0, reserve1 }
}

export function emptyPoolState(): UniswapV3PoolState {
  return { sqrtPriceX96: 0n, tick: 0, liquidity: 0n }
}

/**
 * Fold one pool event into the pool's state. Returns whether anything the edge
 * depends on moved. A Swap is authoritative for all three fields; a Mint/Burn
 * adjusts liquidity only while its range holds the current tick, which is the
 * approximation of in-range liquidity between swaps (the next Swap resyncs it).
 */
export function applyPoolEvent(state: UniswapV3PoolState, event: UniswapV3LogEvent): boolean {
  switch (event.kind) {
    case 'initialize':
      state.sqrtPriceX96 = event.sqrtPriceX96
      state.tick = event.tick
      return true
    case 'swap':
      state.sqrtPriceX96 = event.sqrtPriceX96
      state.tick = event.tick
      state.liquidity = event.liquidity
      return true
    case 'mint':
      if (event.amount === 0n || !tickInRange(state.tick, event.tickLower, event.tickUpper)) return false
      state.liquidity += event.amount
      return true
    case 'burn': {
      if (event.amount === 0n || !tickInRange(state.tick, event.tickLower, event.tickUpper)) return false
      state.liquidity = state.liquidity > event.amount ? state.liquidity - event.amount : 0n
      return true
    }
    default:
      return false
  }
}

/** Contract address (lowercase) → asset id, inverted from the registry tracker's asset id → contract map. */
export function invertErc20Contracts(contracts: ReadonlyMap<number, string>): Map<string, number> {
  const byContract = new Map<string, number>()
  for (const [assetId, contract] of contracts) {
    const address = normalizeEvmAddress(contract)
    if (address != null) byContract.set(address, assetId)
  }
  return byContract
}

/**
 * A pool token's registry asset id: a deployed ERC-20 the registry knows by its
 * location (HOLLAR, the aTokens), else the asset precompile whose address spells
 * the id. Null when neither applies — the pool then prices nothing.
 */
export function resolveEvmTokenAssetId(address: string, assetsByContract: ReadonlyMap<string, number>): number | null {
  const normalized = normalizeEvmAddress(address)
  if (normalized == null) return null
  return assetsByContract.get(normalized) ?? underlyingAssetIdFromReserveAddress(normalized)
}

export interface UniswapV3SwapTrade {
  /** The recipient the log names, in its AccountId32 form (0x45544800 + H160 + zero pad). */
  account: string | null
  filler: typeof UNISWAP_V3_FILLER
  inputs: Array<{ assetId: number; amount: bigint }>
  outputs: Array<{ assetId: number; amount: bigint }>
}

/**
 * A Swap log on a known pool as a one-in/one-out trade: the positive amount was
 * paid into the pool (the trader's input), the negative one paid out. Null when
 * the pool is unknown or the amounts do not describe an exchange.
 */
export function uniswapV3SwapTrade(
  event: Extract<UniswapV3LogEvent, { kind: 'swap' }>,
  pools: UniswapV3PoolIndex,
): UniswapV3SwapTrade | null {
  const tokens = pools.get(event.pool)
  if (tokens == null) return null
  const legs = [
    { assetId: tokens.token0AssetId, amount: event.amount0 },
    { assetId: tokens.token1AssetId, amount: event.amount1 },
  ]
  const inputs = legs.filter(leg => leg.amount > 0n)
  const outputs = legs.filter(leg => leg.amount < 0n).map(leg => ({ assetId: leg.assetId, amount: -leg.amount }))
  if (inputs.length !== 1 || outputs.length !== 1) return null
  return { account: evmAccountForm(event.recipient), filler: UNISWAP_V3_FILLER, inputs, outputs }
}

/** The extrinsics of one block whose Broadcast fills already book a v3 hop, so its Swap log must not be booked again. */
export function routedUniswapV3Extrinsics(
  trades: Iterable<{ filler?: string | null; extrinsicIndex?: number | null }>,
): Set<number> {
  const routed = new Set<number>()
  for (const trade of trades) {
    if (trade.filler === UNISWAP_V3_FILLER && trade.extrinsicIndex != null) routed.add(trade.extrinsicIndex)
  }
  return routed
}

export interface UniswapV3EventChanges {
  /** Swap logs on known pools, routed or not — a block with one holds swap volume. */
  swaps: number
  /** Whether any pool's edge (price, liquidity, existence) moved. */
  changed: boolean
}

interface EventLike {
  name: string
  args: unknown
}

interface TrackedPool {
  pool: UniswapV3Pool
  state: UniswapV3PoolState
}

interface StoredPoolRow {
  pool_address: string
  token0: string
  token1: string
  fee: number
  tick_spacing: number
}

interface StoredPoolEventRow {
  pool: string
  event_name: string
  tick: number
  tick_lower: number
  tick_upper: number
  liquidity_raw: string
  sqrt_price_raw: string
}

/**
 * The pools the indexer knows and their current state. Fed every block's events
 * (whether or not the block is otherwise processed, so a Mint in a quiet block
 * still counts), seeded at startup from the pools and pool events indexed so
 * far, so a restart does not blind the edge until the next Swap.
 *
 * Not an edge today: a Gamma vault's share token (a registry `Erc20` asset whose
 * `evm_address` is a `HypervisorCreated` vault, e.g. "aDOT-HOLLAR" once
 * referendum 403 registers 0xa206d095…). Its NAV is
 * (total0·p0 + total1·p1) / totalSupply, and the honest inputs are:
 *   - positions: pool Mint/Burn whose `owner` is the vault, per (tickLower,
 *     tickUpper) → L; a range's token amounts at √P need TickMath
 *     (getSqrtRatioAtTick, ~20 fixed-point constants) and the three-case
 *     amount0/amount1 formulas — NOT the whole-curve virtual reserves above,
 *     which overstate a narrow range by orders of magnitude;
 *   - idle balances: ERC-20 Transfer logs on token0/token1 to and from the vault
 *     (collected fees and un-deployed deposits sit there between rebalances);
 *   - totalSupply: the vault's own ERC-20 Transfer logs from/to the zero address
 *     (Deposit/Withdraw `shares` are the same numbers);
 *   - uncollected fees: unknowable from logs (feeGrowth state), the one accepted gap.
 * Then price it after the graph pass like computeLpNavPrices does for stableswap
 * shares (hop = max of the two legs), keyed on the registry so it activates at
 * registration. Using the Rebalance totals instead would freeze the composition
 * between rebalances and mis-value a narrow position by the price move since —
 * plausible-looking rather than right, which is why it is not done here.
 * Estimated at ~300 lines with tests (TickMath pinned against the Swap logs'
 * (tick, sqrtPriceX96) pairs); the vault holds nothing yet.
 */
export class UniswapV3PoolTracker {
  private readonly pools = new Map<string, TrackedPool>()
  private assetsByContract: ReadonlyMap<string, number> = new Map()

  setErc20Contracts(contracts: ReadonlyMap<number, string>): void {
    this.assetsByContract = invertErc20Contracts(contracts)
  }

  addPool(pool: UniswapV3Pool): boolean {
    const address = normalizeEvmAddress(pool.address)
    if (address == null || this.pools.has(address)) return false
    this.pools.set(address, {
      pool: { ...pool, address, token0: normalizeEvmAddress(pool.token0) ?? pool.token0, token1: normalizeEvmAddress(pool.token1) ?? pool.token1 },
      state: emptyPoolState(),
    })
    return true
  }

  get size(): number {
    return this.pools.size
  }

  applyEvent(event: UniswapV3LogEvent): { changed: boolean; swap: boolean } {
    if (event.kind === 'poolCreated') {
      const added = this.addPool(event.pool)
      if (added) {
        console.log(`[UniswapV3] Pool ${event.pool.address} created by ${event.factory}: ${event.pool.token0}/${event.pool.token1} fee ${event.pool.fee}`)
      }
      // A new pool has no liquidity yet, so nothing an edge depends on moved.
      return { changed: false, swap: false }
    }
    const tracked = this.pools.get(event.pool)
    if (tracked == null) return { changed: false, swap: false }
    const changed = applyPoolEvent(tracked.state, event)
    return { changed, swap: event.kind === 'swap' }
  }

  processEvents(events: Iterable<EventLike>): UniswapV3EventChanges {
    let swaps = 0
    let changed = false
    for (const event of events) {
      if (event.name !== EVM_LOG_EVENT_NAME) continue
      const log = evmLogOf(event.args)
      if (log == null) continue
      const decoded = decodeUniswapV3Log(log)
      if (decoded == null) continue
      const result = this.applyEvent(decoded)
      if (result.changed) changed = true
      if (result.swap) swaps += 1
    }
    return { swaps, changed }
  }

  private resolveTokens(pool: UniswapV3Pool): UniswapV3PoolTokens | null {
    const token0AssetId = resolveEvmTokenAssetId(pool.token0, this.assetsByContract)
    const token1AssetId = resolveEvmTokenAssetId(pool.token1, this.assetsByContract)
    if (token0AssetId == null || token1AssetId == null || token0AssetId === token1AssetId) return null
    return { token0AssetId, token1AssetId }
  }

  /** Pools whose tokens both resolve, keyed by address — what the volume arm needs. */
  poolIndex(): Map<string, UniswapV3PoolTokens> {
    const index = new Map<string, UniswapV3PoolTokens>()
    for (const [address, { pool }] of this.pools) {
      const tokens = this.resolveTokens(pool)
      if (tokens) index.set(address, tokens)
    }
    return index
  }

  /** Every resolved pool with liquidity in range, as a constant-product edge at its current price. */
  edges(): UniswapV3PoolEdge[] {
    const edges: UniswapV3PoolEdge[] = []
    for (const [address, { pool, state }] of this.pools) {
      const tokens = this.resolveTokens(pool)
      const reserves = virtualReserves(state.sqrtPriceX96, state.liquidity)
      if (tokens == null || reserves == null) continue
      edges.push({
        poolAddress: address,
        assetA: tokens.token0AssetId,
        assetB: tokens.token1AssetId,
        reserveA: reserves.reserve0,
        reserveB: reserves.reserve1,
      })
    }
    return edges
  }

  /**
   * Seed pools and state from what is indexed up to `blockHeight`: the pools table
   * and, per pool, its pool events from the newest Initialize/Swap at or below that
   * block onward (the Swap pins all three fields, the Mints/Burns after it adjust
   * liquidity) — the same fold the live path makes, over the same rows the MVs
   * decoded. Both reads are small (one row per pool, a handful of events per
   * pool). A failure logs and leaves the tracker empty: the pools then reappear
   * from their next log, which is late rather than wrong.
   */
  async loadFromClickHouse(blockHeight: number): Promise<void> {
    const client = createClickHouseClient()
    try {
      const poolResult = await client.query({
        query: `
          SELECT pool_address, token0, token1, fee, tick_spacing
          FROM price_data.uniswap_v3_pools FINAL
          WHERE block_height <= {height:UInt32}
          ORDER BY pool_address
        `,
        query_params: { height: blockHeight },
        format: 'JSONEachRow',
      })
      const poolRows = await poolResult.json<StoredPoolRow>()
      for (const row of poolRows) {
        this.addPool({
          address: row.pool_address,
          token0: row.token0,
          token1: row.token1,
          fee: Number(row.fee),
          tickSpacing: Number(row.tick_spacing),
        })
      }
      if (poolRows.length === 0) return

      const eventResult = await client.query({
        query: `
          WITH anchors AS (
            SELECT contract_address, max(block_height) AS anchor_block
            FROM price_data.uniswap_v3_events
            WHERE kind = 'pool' AND event_name IN ('Initialize', 'Swap') AND block_height <= {height:UInt32}
            GROUP BY contract_address
          )
          SELECT
            e.contract_address AS pool,
            e.event_name AS event_name,
            e.tick AS tick,
            e.tick_lower AS tick_lower,
            e.tick_upper AS tick_upper,
            toString(e.liquidity) AS liquidity_raw,
            toString(e.sqrt_price_x96) AS sqrt_price_raw
          FROM price_data.uniswap_v3_events AS e FINAL
          INNER JOIN anchors AS a ON a.contract_address = e.contract_address
          WHERE e.kind = 'pool'
            AND e.event_name IN ('Initialize', 'Swap', 'Mint', 'Burn')
            AND e.block_height >= a.anchor_block
            AND e.block_height <= {height:UInt32}
          ORDER BY e.block_height, e.event_index
        `,
        query_params: { height: blockHeight },
        format: 'JSONEachRow',
      })
      let replayed = 0
      for (const row of await eventResult.json<StoredPoolEventRow>()) {
        const event = storedPoolEventToLogEvent(row)
        if (event == null) continue
        this.applyEvent(event)
        replayed += 1
      }
      // Counted on state alone: the registry's ERC-20 map, which token
      // resolution needs, is scanned only once the first block is processed.
      let priced = 0
      for (const { state } of this.pools.values()) {
        if (virtualReserves(state.sqrtPriceX96, state.liquidity) != null) priced += 1
      }
      console.log(`[UniswapV3] Loaded ${poolRows.length} pools, replayed ${replayed} pool events up to block ${blockHeight}; ${priced} with in-range liquidity`)
    } catch (error) {
      console.warn('[UniswapV3] Failed to load pools from ClickHouse; pools will be learned from their next logs', error)
    } finally {
      await client.close()
    }
  }
}

function storedPoolEventToLogEvent(row: StoredPoolEventRow): UniswapV3LogEvent | null {
  const pool = normalizeEvmAddress(row.pool)
  if (pool == null) return null
  const liquidity = BigInt(row.liquidity_raw)
  switch (row.event_name) {
    case 'Initialize':
      return { kind: 'initialize', pool, sqrtPriceX96: BigInt(row.sqrt_price_raw), tick: Number(row.tick) }
    case 'Swap':
      return {
        kind: 'swap',
        pool,
        sender: '',
        recipient: '',
        amount0: 0n,
        amount1: 0n,
        sqrtPriceX96: BigInt(row.sqrt_price_raw),
        liquidity,
        tick: Number(row.tick),
      }
    case 'Mint':
      return { kind: 'mint', pool, owner: '', tickLower: Number(row.tick_lower), tickUpper: Number(row.tick_upper), amount: liquidity, amount0: 0n, amount1: 0n }
    case 'Burn':
      return { kind: 'burn', pool, owner: '', tickLower: Number(row.tick_lower), tickUpper: Number(row.tick_upper), amount: liquidity, amount0: 0n, amount1: 0n }
    default:
      return null
  }
}
