import type { ClickHouseClient } from '../db/client.ts'
import { cachedSwr } from './cache.ts'
import { assetDescriptor, knownExplorerAsset } from './explorerAssets.ts'

// The money-market cap model, shared by the public `/lending/v1/caps` facade and
// the explorer's cap alert (notifications/evaluator.ts). One reader for each of
// the three indexed sources and ONE composition of them into per-reserve caps, so
// the number a subscriber is paged about is the number the public route serves.
// This module is an import leaf the public tree is allowed to reach (see
// api/tests/public/isolation.test.ts): it depends on nothing but the client, the
// cache and the asset registry.
//
// WHERE THE CAPS COME FROM. Nothing here reads the chain:
//
//  * CAPS. The Aave fork's PoolConfigurator emits `SupplyCapChanged` and
//    `BorrowCapChanged` (asset indexed, old/new cap in data). They are in
//    `raw_evm_logs` as UNDECODED rows — no ABI is registered for the configurator
//    — so they are decoded here from topics and data: 87 cap events plus 27
//    `ReserveInitialized` across the chain's whole history, read by topic in
//    ~0.18 s. Aave stores caps in WHOLE TOKENS, not raw units; `reserveCaps`
//    scales them to raw so every consumer compares like with like.
//  * HOLLAR HAS NO AAVE CAP, because HOLLAR is minted by a facilitator rather than
//    supplied by lenders. Its limit is the facilitator's bucket capacity, from
//    `FacilitatorAdded` / `FacilitatorBucketCapacityUpdated` in
//    `raw_money_market_reserves`. On 2026-08-12 the newest capacity for
//    facilitator 0x8c0f3b96… was 12,000,000 — exactly the `borrowCap` the
//    incumbent endpoint served. Unlike an Aave cap, a bucket has no zero
//    exemption (GHO's `level + amount <= capacity`): capacity 0 is a frozen
//    facilitator, not "no cap".
//  * A FACILITATOR IS A MARKET'S HOLLAR ATOKEN. Verified against
//    `atoken_reserve_map`: 0x8c0f3b96… is the core market's HOLLAR aToken,
//    0x116d7bb8… GIGAHDX's and 0xef313c2b… BIL's. That is what attributes a
//    capacity to a market without a hardcoded list. The remaining facilitators
//    (the HSM pallet and one other) are no market's aToken and are ignored —
//    they mint HOLLAR outside the money market.
//  * CURRENT SUPPLY AND BORROW are the reserve's totals from
//    `money_market_reserve_state_current` — scaled balances × the reserve's
//    indices, which IS the aToken's / variable-debt token's `totalSupply`.

/** keccak256('SupplyCapChanged(address,uint256,uint256)'). */
const SUPPLY_CAP_TOPIC = '0x0263602682188540a2d633561c0b4453b7d8566285e99f9f6018b8ef2facef49'
/** keccak256('BorrowCapChanged(address,uint256,uint256)'). */
const BORROW_CAP_TOPIC = '0xc51aca575985d521c5072ad11549bad77013bb786d57f30f94b40ed8f8dc9bc4'
/** keccak256('ReserveInitialized(address,address,address,address,address)') — asset and aToken indexed. */
const RESERVE_INITIALIZED_TOPIC = '0x3a0ca721fc364424566385a1aa271ed508cc2c0949c2272575fb3013a163a45f'

/**
 * Every configurator event that carries a cap, plus the initializations that say
 * which market each configurator configures.
 *
 * `raw_evm_logs` is a ReplacingMergeTree over a replayable range, so the rows are
 * collapsed on their (block_height, event_index) identity before decoding rather
 * than trusted as unique. The topic filter is selective enough to read in ~0.18 s
 * over 34 M rows.
 *
 * The inner aggregates are named `log_*` and the filter is table-qualified for one
 * reason: ClickHouse resolves a bare column in WHERE (and inside another
 * aggregate) against the SELECT's own aliases FIRST, so `argMax(topic0, …) AS
 * topic0` next to `WHERE topic0 IN (…)` fails with "aggregate function found in
 * WHERE" — the same alias-shadowing trap 007_money_market_history.sql documents.
 */
const CAP_EVENTS_SQL = `-- mm:caps:aave
SELECT log_configurator AS configurator,
       multiIf(log_topic0 = '${SUPPLY_CAP_TOPIC}', 'supply', log_topic0 = '${BORROW_CAP_TOPIC}', 'borrow', 'init') AS kind,
       concat('0x', right(log_topics[2], 40)) AS asset,
       if(length(log_topics) >= 3, concat('0x', right(log_topics[3], 40)), '') AS atoken,
       toString(reinterpretAsUInt256(reverse(unhex(right(log_data, 64))))) AS new_cap,
       block_height,
       toString(log_time) AS block_timestamp
FROM (
  SELECT block_height, event_index,
         argMax(lower(contract_address), ingested_at) AS log_configurator,
         argMax(ifNull(topic0, ''), ingested_at) AS log_topic0,
         argMax(arrayMap(t -> lower(t), topics), ingested_at) AS log_topics,
         argMax(data, ingested_at) AS log_data,
         argMax(block_timestamp, ingested_at) AS log_time
  FROM price_data.raw_evm_logs
  WHERE raw_evm_logs.topic0 IN ('${SUPPLY_CAP_TOPIC}', '${BORROW_CAP_TOPIC}', '${RESERVE_INITIALIZED_TOPIC}')
  GROUP BY block_height, event_index
)
ORDER BY block_height, event_index`

/**
 * The newest bucket capacity per HOLLAR facilitator. `FacilitatorAdded` carries the
 * opening capacity and `FacilitatorBucketCapacityUpdated` every later one, so both
 * feed one argMax over the events' full ordering key — a replayed row resolves to
 * the same winner without a FINAL pass.
 *
 * The block columns are aliased `last_*`, not to their own names: an alias that
 * shadows a source column is resolved before the column inside the sibling
 * argMax's ordering tuple, which fails as "aggregate function found inside another
 * aggregate function".
 */
const FACILITATOR_CAPS_SQL = `-- mm:caps:facilitator
SELECT lower(JSONExtractString(decoded_args_json, 'facilitatorAddress')) AS facilitator,
       argMax(if(event_name = 'FacilitatorAdded',
                 JSONExtractString(decoded_args_json, 'bucketCapacity'),
                 JSONExtractString(decoded_args_json, 'newCapacity')),
              tuple(block_height, event_index, ingested_at)) AS capacity,
       max(block_height) AS last_block,
       toString(max(block_timestamp)) AS last_time
FROM price_data.raw_money_market_reserves
WHERE raw_money_market_reserves.event_name IN ('FacilitatorAdded', 'FacilitatorBucketCapacityUpdated')
GROUP BY facilitator`

/**
 * Current per-reserve state joined to the reserve map that names its market.
 *
 * The map is a ReplacingMergeTree the anchor snapshotter REWRITES IN FULL every
 * cycle and never deletes from, so a reserve dropped from a pool's `reservesList`
 * keeps its last row — and its last balance — forever. The honest tell for a
 * delisting is the map's own refresh generation: every cycle inserts the WHOLE
 * current reserves list under a single `updated_at`, so a still-listed reserve
 * carries the newest generation and a delisted one is frozen at an older stamp.
 * `listed` reports that comparison; readers drop `listed = 0` rows rather than
 * report them as current state.
 *
 * The generation is resolved INSIDE the query rather than passed in from a cached
 * read: a generation resolved a moment ago can already have been superseded.
 */
const RESERVE_STATE_SQL = `-- mm:reserve-state
WITH (SELECT max(updated_at) FROM price_data.atoken_reserve_map) AS map_generation
SELECT s.pool_address                                AS pool_address,
       s.reserve_address                             AS reserve_address,
       m.market_key                                  AS market_key,
       m.atoken                                      AS atoken,
       s.block_height                                AS block_height,
       toString(s.block_timestamp)                   AS block_timestamp,
       toString(s.supplied)                          AS supplied,
       toString(s.debt)                              AS debt,
       toUInt8(m.updated_at >= map_generation)       AS listed
FROM price_data.money_market_reserve_state_current AS s
LEFT JOIN (
  SELECT DISTINCT lower(asset_address) AS reserve_address, lower(pool_proxy) AS pool_address,
                  market_key, lower(atoken) AS atoken, updated_at
  FROM price_data.atoken_reserve_map FINAL
) AS m ON m.reserve_address = s.reserve_address AND m.pool_address = s.pool_address
ORDER BY market_key, reserve_address`

export interface CapEventRow {
  configurator: string
  kind: 'supply' | 'borrow' | 'init'
  asset: string
  atoken: string
  new_cap: string
  block_height: string | number
  block_timestamp: string
}

export interface FacilitatorRow {
  facilitator: string
  capacity: string
  last_block: string | number
  last_time: string
}

export interface ReserveStateRow {
  pool_address: string
  reserve_address: string
  market_key: string | null
  atoken: string | null
  block_height: string | number
  block_timestamp: string
  supplied: string
  debt: string
  listed: string | number
}

export async function readCapEvents(client: ClickHouseClient): Promise<CapEventRow[]> {
  const res = await client.query({ query: CAP_EVENTS_SQL, format: 'JSONEachRow' })
  return res.json<CapEventRow>()
}

export async function readFacilitatorCaps(client: ClickHouseClient): Promise<FacilitatorRow[]> {
  const res = await client.query({ query: FACILITATOR_CAPS_SQL, format: 'JSONEachRow' })
  return res.json<FacilitatorRow>()
}

export async function readReserveStateRows(client: ClickHouseClient): Promise<ReserveStateRow[]> {
  const res = await client.query({ query: RESERVE_STATE_SQL, format: 'JSONEachRow' })
  return res.json<ReserveStateRow>()
}

/**
 * A raw on-chain amount as a whole-token JSON number.
 *
 * The division happens on the integer, and `Number` is applied ONCE to the
 * resulting decimal string — so a 27-digit HOLLAR debt loses only the precision a
 * double cannot hold, rather than the precision a float division would have thrown
 * away before rounding.
 */
export function tokenAmount(raw: bigint, decimals: number): number {
  const unit = 10n ** BigInt(decimals)
  const negative = raw < 0n
  const magnitude = negative ? -raw : raw
  const whole = magnitude / unit
  const fraction = (magnitude % unit).toString().padStart(decimals, '0')
  return Number(`${negative ? '-' : ''}${whole}${decimals > 0 ? `.${fraction}` : ''}`)
}

/**
 * Borrowed over supplied, to six decimal places, computed on the integers.
 *
 * Null when nothing is supplied: a reserve with debt and no supply (HOLLAR, which
 * is minted rather than deposited) has no utilization ratio, and 0 or Infinity
 * would both be a claim this data does not make.
 */
export function utilizationRatio(supplied: bigint, debt: bigint): number | null {
  if (supplied <= 0n) return null
  return Number((debt * 1_000_000n) / supplied) / 1_000_000
}

/**
 * Attribute each configurator to the market it configures, via the aTokens its
 * `ReserveInitialized` events created.
 *
 * A configurator that never initialized a reserve this reserve map knows — a market
 * added since the map was last refreshed — resolves nothing, and its caps fall back
 * to the asset's own market below. Doing it this way rather than by asset alone
 * matters because HOLLAR is a reserve of all three markets at once.
 */
export function configuratorMarkets(events: CapEventRow[], aTokenPool: Map<string, string>): Map<string, string> {
  const byConfigurator = new Map<string, string>()
  for (const event of events) {
    if (event.kind !== 'init') continue
    const pool = aTokenPool.get(event.atoken)
    if (pool) byConfigurator.set(event.configurator, pool)
  }
  return byConfigurator
}

/** The latest cap of one kind per `${pool}:${reserve}`, in Aave's WHOLE tokens. */
function capIndex(events: CapEventRow[], configuratorPool: Map<string, string>, assetPools: Map<string, string[]>): { supply: Map<string, bigint>; borrow: Map<string, bigint> } {
  const supply = new Map<string, bigint>()
  const borrow = new Map<string, bigint>()
  // Events arrive in block order, so a later one simply overwrites an earlier one.
  for (const event of events) {
    if (event.kind === 'init') continue
    const pools = configuratorPool.has(event.configurator)
      ? [configuratorPool.get(event.configurator) as string]
      // Fallback: no initialization tied this configurator to a market. The cap
      // still applies to the asset, and it is unambiguous whenever the asset is a
      // reserve of exactly one pool. An asset shared by several (HOLLAR) is left
      // alone rather than attributed to a guess.
      : (assetPools.get(event.asset) ?? [])
    if (pools.length !== 1) continue
    if (!/^\d+$/.test(event.new_cap)) continue
    const key = `${pools[0]}:${event.asset}`
    ;(event.kind === 'supply' ? supply : borrow).set(key, BigInt(event.new_cap))
  }
  return { supply, borrow }
}

/** What `reserveCaps` needs to know about one reserve of one pool. */
export interface ReserveCapInput {
  poolAddress: string
  reserveAddress: string
  /** The market's aToken for this reserve — also its HOLLAR facilitator address. */
  aTokenAddress: string | null
  /** The asset's decimals, or null when the registry does not know the asset — an Aave cap cannot be scaled then. */
  decimals: number | null
}

/** The `${pool}:${reserve}` key every cap map is addressed by. The readers already lowercase both; this keeps a caller that did not honest. */
export const reserveKey = (poolAddress: string, reserveAddress: string): string =>
  `${poolAddress.toLowerCase()}:${reserveAddress.toLowerCase()}`

/** One reserve's caps, in RAW units. */
export interface ReserveCaps {
  /** Null when no cap was ever set. Aave's 0 ("no cap") stays 0n — the consumer decides what it means. */
  borrowCap: bigint | null
  /** Which control set `borrowCap`: the market's HOLLAR facilitator bucket, or the pool configurator. */
  borrowCapSource: 'facilitator' | 'poolConfigurator' | null
  supplyCap: bigint | null
}

/**
 * The one composition of the three sources: per `${pool}:${reserve}`, the caps a
 * reserve is subject to, scaled to raw units so a cap and a balance compare
 * directly.
 *
 * A facilitator-minted reserve's real limit is its bucket capacity; the pool
 * configurator never sets a borrow cap for it. Where both exist the facilitator
 * wins, because it is the constraint the chain actually enforces on minting. A
 * facilitator capacity is already a raw amount; an Aave cap is whole tokens and
 * is scaled by the reserve's decimals here — and withheld (null) for a reserve
 * whose decimals are unknown, since a guessed scale would compare a cap in one
 * unit against a balance in another.
 */
export function reserveCaps(reserves: readonly ReserveCapInput[], capEvents: CapEventRow[], facilitatorRows: FacilitatorRow[]): Map<string, ReserveCaps> {
  const aTokenPool = new Map<string, string>()
  const assetPools = new Map<string, string[]>()
  for (const reserve of reserves) {
    if (reserve.aTokenAddress) aTokenPool.set(reserve.aTokenAddress, reserve.poolAddress)
    assetPools.set(reserve.reserveAddress, [...(assetPools.get(reserve.reserveAddress) ?? []), reserve.poolAddress])
  }
  // Only a facilitator that IS a market's aToken describes a reserve of this
  // market; the HSM pallet's facilitator mints HOLLAR outside it.
  const facilitatorCaps = new Map<string, bigint>()
  for (const row of facilitatorRows) {
    if (!aTokenPool.has(row.facilitator)) continue
    if (!/^\d+$/.test(row.capacity)) continue
    facilitatorCaps.set(row.facilitator, BigInt(row.capacity))
  }
  const caps = capIndex(capEvents, configuratorMarkets(capEvents, aTokenPool), assetPools)

  const out = new Map<string, ReserveCaps>()
  for (const reserve of reserves) {
    const key = reserveKey(reserve.poolAddress, reserve.reserveAddress)
    const unit = reserve.decimals == null ? null : 10n ** BigInt(reserve.decimals)
    const facilitator = reserve.aTokenAddress ? facilitatorCaps.get(reserve.aTokenAddress) : undefined
    const configuredBorrow = unit == null ? undefined : caps.borrow.get(key)
    const configuredSupply = unit == null ? undefined : caps.supply.get(key)
    out.set(key, {
      borrowCap: facilitator ?? (configuredBorrow == null ? null : configuredBorrow * unit!),
      borrowCapSource: facilitator != null ? 'facilitator' : configuredBorrow != null ? 'poolConfigurator' : null,
      supplyCap: configuredSupply == null ? null : configuredSupply * unit!,
    })
  }
  return out
}

/* ============ the cap alert's reading of a reserve ============ */

/** Headroom under which a reserve reads as FULL, in basis points of its cap. */
export const CAP_FULL_BPS = 10n
/** Headroom at or above which a reserve reads as OPEN again, in basis points of its cap. */
export const CAP_OPEN_BPS = 50n

/**
 * Whether a reserve side is full, read through a hysteresis band.
 *
 * "Full" is not `used >= cap`: interest accrual carries a borrowed HOLLAR bucket
 * past its capacity and every small repay brings it a few tokens under, so a
 * plain comparison would flip on every tick around the line. Under 0.1 % of the
 * cap there is nothing anybody can meaningfully borrow or supply, so that reads
 * as full; at 0.5 % or more it reads as open; in between, the previous reading
 * stands. First sight inside the band is "open", so the fill that follows is
 * still reported.
 *
 * Null for an uncapped side: a cap never set, or — where `zeroIsNoCap` — Aave's
 * own 0 sentinel, which means "no cap" rather than "frozen" (stHDX ships
 * supplyCap 0 against 1.23 B supplied). There is no state to keep for it. A
 * HOLLAR facilitator bucket has no such exemption: capacity 0 is a frozen
 * facilitator that nothing can be minted against, so the caller passes
 * `zeroIsNoCap = false` for it and 0 reads as full.
 */
export function capIsFull(prevFull: boolean | null, used: bigint, cap: bigint | null, zeroIsNoCap = true): boolean | null {
  if (cap == null || cap < 0n) return null
  if (cap === 0n) return zeroIsNoCap ? null : true
  const headroomBps = ((cap - used) * 10_000n) / cap
  if (headroomBps < CAP_FULL_BPS) return true
  if (headroomBps >= CAP_OPEN_BPS) return false
  return prevFull ?? false
}

/** One listed reserve of one isolated market, with its current totals and caps, all in raw units. */
export interface ReserveCapState {
  /** The isolated market's pool proxy — the identity a market is matched on (see explorerService's MM_MARKET_BY_POOL). */
  poolAddress: string
  reserveAddress: string
  /** Registry id of the reserve's asset, or null when the address is neither the precompile nor a known deployment. */
  assetId: number | null
  symbol: string | null
  /** For rendering. 18 when the registry does not know the asset — its Aave caps are then null, so nothing is compared at that scale. */
  decimals: number
  supplied: bigint
  debt: bigint
  borrowCap: bigint | null
  /** Decides what a borrow cap of 0 means: a facilitator bucket of 0 is frozen, an Aave 0 is "no cap". */
  borrowCapSource: ReserveCaps['borrowCapSource']
  supplyCap: bigint | null
}

/** A ClickHouse integer column as a bigint; anything that is not a plain integer string reads as 0. */
export const rawUnits = (value: string | number | null | undefined): bigint => {
  const input = String(value ?? '').trim()
  return /^-?\d+$/.test(input) ? BigInt(input) : 0n
}

/**
 * Every listed reserve's current totals and caps, for the cap alert.
 *
 * `assetIdOf` maps a reserve's EVM address to its registry id; it is passed in
 * because the two surfaces keep their own copy of that mapping (the explorer's is
 * env-extensible, the public API's is not) and this leaf may import neither.
 * Delisted reserves are dropped, as the public facade drops them: a reserve the
 * map no longer lists is not a reserve anybody can fill.
 *
 * Cached stale-while-revalidate: the reserve view costs ~0.6 s, and a cap is
 * current state read every snapshot tick, not a row lane with a cursor.
 */
export function moneyMarketCapStates(client: ClickHouseClient, assetIdOf: (reserveAddress: string) => number | null): Promise<ReserveCapState[]> {
  return cachedSwr('mm:cap-states', 60_000, 300_000, async () => {
    const [rows, capEvents, facilitators] = await Promise.all([
      readReserveStateRows(client), readCapEvents(client), readFacilitatorCaps(client),
    ])
    const listed = rows.filter(row => Number(row.listed) === 1).map(row => {
      const assetId = assetIdOf(row.reserve_address)
      // Only a registry-known asset has decimals to scale an Aave cap by; the
      // descriptor's fallback would be a guess, and a guess here is a wrong comparison.
      const registry = assetId != null && knownExplorerAsset(assetId) ? assetDescriptor(assetId) : null
      return { row, assetId, symbol: registry?.symbol ?? null, decimals: registry?.decimals ?? null }
    })
    const caps = reserveCaps(listed.map(r => ({
      poolAddress: r.row.pool_address, reserveAddress: r.row.reserve_address, aTokenAddress: r.row.atoken || null, decimals: r.decimals,
    })), capEvents, facilitators)
    return listed.map(({ row, assetId, symbol, decimals }): ReserveCapState => {
      const cap = caps.get(reserveKey(row.pool_address, row.reserve_address))
      return {
        poolAddress: row.pool_address,
        reserveAddress: row.reserve_address,
        assetId, symbol, decimals: decimals ?? 18,
        supplied: rawUnits(row.supplied),
        debt: rawUnits(row.debt),
        borrowCap: cap?.borrowCap ?? null,
        borrowCapSource: cap?.borrowCapSource ?? null,
        supplyCap: cap?.supplyCap ?? null,
      }
    })
  })
}
