import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { type MmReserveState, moneyMarketSupply } from './moneyMarketReserves.ts'

// GET /lending/v1/caps — per-reserve supply/borrow caps, current supply/borrow and
// utilization for every money-market reserve (spec § Phase 2 → "hydration.net
// stats + lending caps").
//
// WHERE THE CAPS COME FROM. The incumbent endpoint read them live: a GraphQL
// lookup of the HOLLAR facilitator's bucket capacity plus an `eth_call` of the
// HOLLAR variable-debt token's `totalSupply`. Neither is needed — both quantities
// are already indexed, and both were verified against that endpoint's live output:
//
//  * CAPS. The Aave fork's PoolConfigurator emits `SupplyCapChanged` and
//    `BorrowCapChanged` (asset indexed, old/new cap in data). They are in
//    `raw_evm_logs` as UNDECODED rows — no ABI is registered for the configurator
//    — so they are decoded here from topics and data: 87 cap events plus 27
//    `ReserveInitialized` across the chain's whole history, read by topic in
//    ~0.18 s. Aave stores caps in WHOLE TOKENS, not raw units.
//  * HOLLAR HAS NO AAVE CAP, because HOLLAR is minted by a facilitator rather than
//    supplied by lenders. Its limit is the facilitator's bucket capacity, from
//    `FacilitatorAdded` / `FacilitatorBucketCapacityUpdated` in
//    `raw_money_market_reserves`. On 2026-08-12 the newest capacity for
//    facilitator 0x8c0f3b96… was 12,000,000 — exactly the `borrowCap` the
//    incumbent endpoint served.
//  * A FACILITATOR IS A MARKET'S HOLLAR ATOKEN. Verified against
//    `atoken_reserve_map`: 0x8c0f3b96… is the core market's HOLLAR aToken,
//    0x116d7bb8… GIGAHDX's and 0xef313c2b… BIL's. That is what attributes a
//    capacity to a market without a hardcoded list. The remaining two
//    facilitators (the HSM pallet and one other) are no market's aToken and are
//    ignored here — they mint HOLLAR outside the money market.
//  * CURRENT BORROW is the reserve's debt from `money_market_reserve_state_current`
//    — scaled debt × the variable borrow index, which IS the variable-debt token's
//    `totalSupply`. Measured 10,735,924.996 HOLLAR against the incumbent's
//    10,735,924.955 read over RPC seconds later: the same number, drifting only by
//    the interest that accrued between the two reads.
//
// Like the other inherited facades this one publishes JSON numbers, not the /v1
// decimal strings, because the incumbent's consumers parse numbers. Every
// computation before the wire is integer.

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
const CAP_EVENTS_SQL = `-- pub:caps:aave
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
const FACILITATOR_CAPS_SQL = `-- pub:caps:facilitator
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

interface CapEventRow {
  configurator: string
  kind: 'supply' | 'borrow' | 'init'
  asset: string
  atoken: string
  new_cap: string
  block_height: string | number
  block_timestamp: string
}

interface FacilitatorRow {
  facilitator: string
  capacity: string
  last_block: string | number
  last_time: string
}

export interface LendingCap {
  /** The reserve asset's registry name — the incumbent's field, e.g. "Hydrated Dollar". */
  asset: string
  /** Maximum borrowable, in whole tokens. Null when no cap has ever been set for the reserve. */
  borrowCap: number | null
  /** Currently borrowed, in whole tokens. */
  currentBorrow: number
  /** `borrowCap - currentBorrow`, or null when there is no cap to be available against. */
  available: number | null
  /** Which model set `borrowCap`: the market's HOLLAR facilitator, or the pool configurator. */
  borrowCapSource: 'facilitator' | 'poolConfigurator' | null
  /** The isolated market this reserve belongs to ('core', 'gigahdx', 'bil'). */
  market: string | null
  /** Registry id as a decimal string, or null for a reserve outside the registry. */
  assetId: string | null
  symbol: string | null
  /** Maximum suppliable, in whole tokens. Null when no cap has ever been set. */
  supplyCap: number | null
  /** Currently supplied, in whole tokens. */
  currentSupply: number
  /** `currentBorrow / currentSupply`, 0–1. Null when nothing is supplied. */
  utilization: number | null
  /** The indexed block whose state this row reports. */
  asOf: string
}

/**
 * A raw on-chain amount as a whole-token JSON number.
 *
 * The division happens on the integer, and `Number` is applied ONCE to the
 * resulting decimal string — so a 27-digit HOLLAR debt loses only the precision a
 * double cannot hold, rather than the precision a float division would have thrown
 * away before rounding. The incumbent's own numbers are doubles, so this matches
 * what its consumers already parse.
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

/** The latest cap of one kind per (pool, reserve), from the decoded configurator log. */
interface CapIndex {
  supply: Map<string, bigint>
  borrow: Map<string, bigint>
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

function capIndex(events: CapEventRow[], configuratorPool: Map<string, string>, assetPools: Map<string, string[]>): CapIndex {
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
    const key = `${pools[0]}:${event.asset}`
    ;(event.kind === 'supply' ? supply : borrow).set(key, BigInt(event.new_cap))
  }
  return { supply, borrow }
}

/**
 * The reserve rows, legacy row first.
 *
 * The incumbent endpoint returned exactly ONE element — the core market's HOLLAR
 * borrow cap — so a consumer reading `body[0].borrowCap` must keep reading the same
 * number here. That row is therefore pinned to index 0; everything else follows in
 * a stable (market, symbol) order so the payload is diffable.
 */
export function orderCaps(rows: LendingCap[]): LendingCap[] {
  const isLegacy = (row: LendingCap): boolean => row.market === 'core' && row.borrowCapSource === 'facilitator'
  const legacy = rows.filter(isLegacy)
  const rest = rows.filter(row => !isLegacy(row))
  rest.sort((a, b) => (a.market ?? '').localeCompare(b.market ?? '') || (a.symbol ?? '').localeCompare(b.symbol ?? ''))
  return [...legacy, ...rest]
}

function capRow(
  reserve: MmReserveState,
  caps: CapIndex,
  facilitatorCaps: Map<string, bigint>,
): LendingCap {
  const key = `${reserve.poolAddress}:${reserve.reserveAddress}`
  const facilitator = reserve.aTokenAddress ? facilitatorCaps.get(reserve.aTokenAddress) : undefined
  const configuredBorrow = caps.borrow.get(key)
  // A facilitator-minted reserve's real limit is its bucket capacity; the pool
  // configurator never sets a borrow cap for it. Where both exist the facilitator
  // wins, because it is the constraint the chain actually enforces on minting.
  const borrowCapRaw = facilitator ?? configuredBorrow
  const borrowCapSource = facilitator != null ? 'facilitator' : configuredBorrow != null ? 'poolConfigurator' : null
  // A facilitator capacity is a raw token amount; an Aave cap is already in whole
  // tokens. Both reach the wire as whole tokens.
  const borrowCap = borrowCapRaw == null ? null
    : facilitator != null ? tokenAmount(borrowCapRaw, reserve.decimals) : Number(borrowCapRaw)
  const supplyCapRaw = caps.supply.get(key)
  const currentBorrow = tokenAmount(reserve.debt, reserve.decimals)
  return {
    asset: reserve.name ?? reserve.symbol ?? reserve.reserveAddress,
    borrowCap,
    currentBorrow,
    available: borrowCap == null ? null : borrowCap - currentBorrow,
    borrowCapSource,
    market: reserve.market,
    assetId: reserve.assetId == null ? null : String(reserve.assetId),
    symbol: reserve.symbol,
    supplyCap: supplyCapRaw == null ? null : Number(supplyCapRaw),
    currentSupply: tokenAmount(reserve.supplied, reserve.decimals),
    utilization: utilizationRatio(reserve.supplied, reserve.debt),
    asOf: reserve.asOf,
  }
}

export async function lendingCaps(client: ClickHouseClient): Promise<LendingCap[]> {
  return cachedSwr('pub:lending:caps', 60_000, 300_000, async () => {
    const [supply, capEventsRes, facilitatorRes] = await Promise.all([
      moneyMarketSupply(client),
      client.query({ query: CAP_EVENTS_SQL, format: 'JSONEachRow' }),
      client.query({ query: FACILITATOR_CAPS_SQL, format: 'JSONEachRow' }),
    ])
    const capEvents = await capEventsRes.json<CapEventRow>()
    const facilitatorRows = await facilitatorRes.json<FacilitatorRow>()

    const aTokenPool = new Map<string, string>()
    const assetPools = new Map<string, string[]>()
    for (const reserve of supply.reserves) {
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
    return orderCaps(supply.reserves.map(reserve => capRow(reserve, caps, facilitatorCaps)))
  })
}
