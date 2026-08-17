import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { assetDescriptor } from '../../services/explorerAssets.ts'
import { iso } from '../schemas/common.ts'
import { currentPrices, priceFor, usdScaled } from './accountBalances.ts'
import { assetIdFromReserveAddress } from './moneyMarketEvents.ts'

// Current per-reserve money-market state — supplied, debt, and their USD value —
// shared by every public surface that reports the money market as a whole:
// /v1/stats/platform's `moneyMarketSupplyUsd`, /hydration-web/v1/stats' TVL, and
// /lending/v1/caps' utilization. One reader, so the three cannot disagree.
//
// The state itself comes from `money_market_reserve_state_current`
// (clickhouse/schema/007_money_market_history.sql), which composes the aToken
// anchor, the post-anchor scaled deltas and the reserve's liquidity/borrow index
// with the same integer arithmetic the explorer's account pages use.
//
// TWO SEMANTICS THIS SERVICE ADDS ON TOP OF THE VIEW.
//
//  * EMPTY IS NOT ZERO. The view returns no rows at all when
//    `atoken_scaled_anchor` holds no snapshot — a fresh database, or
//    snapshot-atoken-anchors.ts unable to reach its RPC, which is a one-way
//    failure that never un-sets itself. `suppliedUsd` is then null: null says
//    "no model here", while 0 would report the money market as empty.
//
//  * A DELISTED RESERVE IS DROPPED. `atoken_reserve_map` is a
//    ReplacingMergeTree the anchor snapshotter REWRITES IN FULL every cycle and
//    never deletes from, so a reserve dropped from a pool's `reservesList` keeps
//    its last row — and its last supplied balance — forever. The 007 header names
//    the symptom ("treat a reserve whose block_timestamp has stopped advancing as
//    delisted, not as idle") but a timestamp cannot tell delisted from idle: on
//    the live chain, reserve 0x…0067 (3-Pool) had not moved for seven weeks while
//    holding $1.04 M of real, still-listed supply.
//
//    The honest tell is the map's own refresh generation. Every cycle inserts the
//    WHOLE current reserves list in one batch under a single `updated_at`
//    (src/scripts/snapshot-atoken-anchors.ts), so a reserve still listed carries
//    the newest generation and a delisted one is frozen at an older stamp.
//    Verified on the live map: all 27 rows share one `updated_at`. Rows behind it
//    are excluded here — from the totals AND from the per-reserve lists — rather
//    than reported as current state.
//
// The generation is resolved INSIDE the query rather than passed in from a cached
// read, for the same reason the account snapshots are (accountBalances.ts): a
// generation resolved a moment ago can already have been superseded.
const RESERVE_STATE_SQL = `-- pub:mm:reserve-state
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

interface ReserveStateRow {
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

/** One reserve of one isolated money market, at the newest indexed state. */
export interface MmReserveState {
  /** The market's key ('core', 'gigahdx', 'bil'), or null for a pool the map does not name. */
  market: string | null
  poolAddress: string
  reserveAddress: string
  /** The market's aToken for this reserve — also its HOLLAR facilitator address. */
  aTokenAddress: string | null
  /** Registry id of the reserve's asset, or null when the address is neither the precompile nor a known deployment. */
  assetId: number | null
  symbol: string | null
  name: string | null
  decimals: number
  /** Raw on-chain units. */
  supplied: bigint
  debt: bigint
  /** USD at current prices, as an integer count of 10^-12 USD; null when the asset is unpriced. */
  suppliedUsd: bigint | null
  debtUsd: bigint | null
  /** The block whose ReserveDataUpdated set the indices this state was built with. */
  blockHeight: number
  asOf: string
}

export interface MoneyMarketSupply {
  reserves: MmReserveState[]
  /**
   * Every reserve's supplied side at current prices, scaled 10^-12 — or null when
   * the model has no rows (no anchor) or nothing in it could be priced. Unpriced
   * reserves among priced ones contribute nothing, exactly as an unpriced pool does
   * to its venue in platformStats.
   */
  suppliedUsd: bigint | null
  /** Reserves the reserve map no longer lists, dropped from `reserves` and the total. */
  delistedCount: number
}

function rawUnits(value: string | number | null | undefined): bigint {
  const input = String(value ?? '').trim()
  return /^-?\d+$/.test(input) ? BigInt(input) : 0n
}

/**
 * A venue whose every asset is unpriced is unknown rather than empty — the rule
 * platformStats.venueTvlUsd applies to a pool venue, applied here to the money
 * market. Nothing else in a 200 would say the price feed is dead.
 */
function totalSuppliedUsd(reserves: MmReserveState[]): bigint | null {
  if (reserves.length === 0) return null
  const priced = reserves.filter(r => r.suppliedUsd != null)
  const holding = reserves.filter(r => r.supplied > 0n)
  if (holding.length > 0 && priced.length === 0) return null
  return priced.reduce((sum, r) => sum + (r.suppliedUsd ?? 0n), 0n)
}

/**
 * The money market's current state, per reserve and in total.
 *
 * Cached because three endpoints read it and the underlying view costs ~0.6 s —
 * one FINAL pass over the post-anchor delta table, flat in the number of callers.
 */
export function moneyMarketSupply(client: ClickHouseClient): Promise<MoneyMarketSupply> {
  return cachedSwr('pub:mm:supply', 60_000, 300_000, async () => {
    const [res, prices] = await Promise.all([
      client.query({ query: RESERVE_STATE_SQL, format: 'JSONEachRow' }),
      currentPrices(client),
    ])
    const rows = await res.json<ReserveStateRow>()
    const reserves: MmReserveState[] = []
    let delistedCount = 0
    for (const row of rows) {
      if (Number(row.listed) !== 1) { delistedCount += 1; continue }
      const assetId = assetIdFromReserveAddress(row.reserve_address)
      const registry = assetId == null ? null : assetDescriptor(assetId)
      const decimals = registry?.decimals ?? 18
      const price = assetId == null ? 0n : priceFor(prices, assetId)
      const supplied = rawUnits(row.supplied)
      const debt = rawUnits(row.debt)
      reserves.push({
        market: row.market_key || null,
        poolAddress: row.pool_address,
        reserveAddress: row.reserve_address,
        aTokenAddress: row.atoken || null,
        assetId,
        symbol: registry?.symbol ?? null,
        name: registry?.name ?? registry?.symbol ?? null,
        decimals,
        supplied,
        debt,
        suppliedUsd: price > 0n ? usdScaled(supplied, price, decimals) : null,
        debtUsd: price > 0n ? usdScaled(debt, price, decimals) : null,
        blockHeight: Number(row.block_height),
        asOf: iso(row.block_timestamp),
      })
    }
    if (reserves.length === 0) {
      console.warn('[public-api] money-market reserve state is empty — atoken_scaled_anchor holds no snapshot, '
        + 'so every money-market total reports null (check snapshot-atoken-anchors)')
    }
    // Dropping a reserve is the RIGHT answer for a delisting and the WRONG one for
    // a half-written refresh, and the two are indistinguishable from the map alone.
    // Nothing in a 200 would say a reserve disappeared, so this is the only signal:
    // a steady count after a real delisting is expected, a count that appears at a
    // refresh boundary and then clears is a partial generation.
    if (delistedCount > 0) {
      console.warn(`[public-api] ${delistedCount} money-market reserve(s) are behind atoken_reserve_map's newest `
        + 'refresh generation and were dropped from every money-market total and from /lending/v1/caps — '
        + 'expected after a delisting, otherwise a partial map refresh (check snapshot-atoken-anchors)')
    }
    return { reserves, suppliedUsd: totalSuppliedUsd(reserves), delistedCount }
  })
}
