// The hourly volume read models (clickhouse/schema/006_public.sql):
//
//   price_data.pool_volume_hourly   (venue, pool_key, hour) → volume_usd, fills,
//                                   lp_fee_usd, protocol_fee_usd, unpriced_fills
//   price_data.asset_volume_hourly  (asset_id, hour, venue, pool_key) → volume_usd,
//                                   legs, unpriced_legs
//
// Both are folds of `pool_swap_legs` valued at event time, recomputed hour by
// hour — only the hours whose legs or registry inputs changed — by the
// derivations service (derivations/jobs.ts, the hourly folds). Their definitions are not restated here: every rule is
// the public volume surfaces' own (services/poolVolumes.ts), composed from the
// same fragments, so an hourly sum over a window IS what `/v1/pools/*/volumes`
// answers for it.
//
//  * Legs: the shared `legsCteSql` dedup (argMax per leg identity — the source is
//    a ReplacingMergeTree, so a replayed range must collapse BEFORE any sum),
//    every venue but `aave` (an aToken mint/redeem is a 1:1 money-market wrap,
//    never a swap).
//  * Valuation: `pricedCteSql` — `amount × close ÷ 10^decimals` at the 1h candle
//    that had CLOSED by the fill (`interval_start + 1 HOUR <= block_timestamp`),
//    the asset aliased through the one historical price rule (`priceAliasSql`,
//    `priceAssetId`), exact Decimal256 at the 1e-12 USD scale on the vectorised
//    operators. The candle window is the anchored one the public surfaces use,
//    anchored on the month's end (or the cut) and reaching back over the month
//    plus PRICE_LOOKBACK_DAYS — whichever of the month's hours are recomputed,
//    so a leg's value depends on its month alone, never on which hours were
//    folded beside it. An asset whose feed went quiet within that lookback of
//    the month still prices, and one quiet for longer is unpriced (0) rather
//    than valued at an arbitrarily old close. The lookback is the one
//    place a window sum can differ from a rolling `/v1/pools/*/volumes` read:
//    that read starts its lookback at ITS window's start, this fold at the
//    month's, so a leg whose feed's last candle is between 30 and ~61 days old
//    can be priced in one and not the other. The windows' boundaries differ too:
//    a model row is the half-open hour [hour, hour + 1 h), a rolling public read
//    the anchored (anchor − N h, anchor].
//  * Fill value (pool volume): FILL_USD, the out side falling back to the in
//    side. The Omnipool counts a user swap once (IS_OMNIPOOL_FIRST_HOP): its
//    `A → H2O` first hop adds 0 and the `H2O → B` fill that completes it carries
//    the swap, exactly `omnipoolVolumes`' venue total. A trade routed through two
//    pools counts in both — that is what pool volume means — so venue volumes sum
//    to MORE than routed (netted) volume.
//  * Asset value (asset volume): assetSideUsdSql, the asset's own in/out legs,
//    inheriting the fill's value when those are unpriced — exactly
//    `omnipoolVolumes`' per-asset rule, applied on every venue. The hub asset H2O
//    (id 1) is Omnipool plumbing, not an asset trade, and has no rows.
//  * Fees: never volume. lp_fee_usd is the fee legs `lpFeeLegSql` classifies as
//    accruing to the pool's LPs (the yield endpoints' numerators), LESS a Uniswap
//    v3 pool's protocol share; protocol_fee_usd is every other fee leg — the
//    Omnipool's H2O fee, its asset-fee share routed to staking, referrals or the
//    fee processor, any burned leg, OTC and LBP fees — PLUS that v3 share. A v3
//    fee leg is the whole swap fee (amount in × tier); where `SetFeeProtocol` is
//    on, 1/n of it stays in the pool for the protocol, n being the pool's
//    denominator for the fee's token side in force at the swap — the
//    uniswap_v3_fee revenue stream's accrual rule, read through the same
//    fragments (revenueStreams.ts V3_*), so the model's v3 protocol fee is that
//    stream's accrual (to the truncation: the stream divides the raw amount, this
//    the leg's USD). The two still partition every fee leg, so their sum is the
//    fee a trade paid, which is what `/v1/pools/*/volumes` publishes as `feeUsd`
//    (+ `protocolFeeUsd` on the Omnipool; that public figure stays GROSS on v3).
//    Legs before 2025-01-25 carry no recipient, and an empty Omnipool recipient
//    counts as LP (LP_FEE_LEG's known upward bias, stated there).
//
// A fill with no priced side at all is kept and counted (`unpriced_fills`, and
// `unpriced_legs` for an asset side that ended at 0), never dropped silently.
//
// Every row carries `registry_fp`, valuationRegistryFingerprintSql XOR-ed over the asset
// set of its hour's legs (pool_swap_hour_watermarks.assets) as it stood when the
// hour was folded: the staleness check recomputes it against the current
// registry, so a registry change re-folds the hours whose legs it re-values.
//
//   price_data.routed_volume_hourly (hour) → volume_usd, trades, unpriced_trades
//
// is the platform's ROUTED volume on the same hour/cut/candle machinery: every
// trade once, netted across its route (`routedNettedCteSql` + `nettedTradeSidesSql`,
// the definition of /v1/stats/platform totalRoutedUsd and the DefiLlama day
// series), at the larger of its two boundary sides, whole-trade aToken wraps
// dropped. A trade lives in one block, so it lands in exactly one hour. Venue
// volumes sum to more than this (a two-pool route is one trade, two fills).

import { H2O_ASSET_ID } from './explorerAssets.ts'
import {
  FILL_USD,
  IS_OMNIPOOL_FIRST_HOP,
  NEXT_FILL_WINDOW,
  assetSideUsdSql,
  legsCteSql,
  pricedCteSql,
  nettedTradeSidesSql,
  routedNettedCteSql,
} from './poolVolumes.ts'
import { lpFeeLegSql } from './poolYield.ts'
import {
  V3_FEE_PROTOCOL_CTE,
  V3_FEE_PROTOCOL_SIDES_SQL,
  V3_POOLS_CTE,
  V3_TOKEN_ASSETS_CTE,
  v3EventAtKeySql,
  v3FeeSideSql,
} from './revenueStreams.ts'

export const POOL_VOLUME_HOURLY_TABLE = 'price_data.pool_volume_hourly'
export const ASSET_VOLUME_HOURLY_TABLE = 'price_data.asset_volume_hourly'
export const ROUTED_VOLUME_HOURLY_TABLE = 'price_data.routed_volume_hourly'

const PARTITION_RE = /^\d{6}$/
const HOUR_RE = /^(\d{4})-(\d{2})-\d{2} \d{2}:00:00$/

/** One hour a fold recomputes: its start, and the registry fingerprint of its legs' assets. */
export interface FoldHour {
  /** 'YYYY-MM-DD HH:00:00', UTC. */
  hour: string
  /** valuationRegistryFingerprintSql XOR-ed over the hour's asset set, as a decimal UInt64. */
  fingerprint: string
}

/**
 * The legs of a set of hours of one month. The month is the source's own
 * partition expression, so a recompute reads exactly one partition of
 * pool_swap_legs; the hour bounds let ClickHouse skip that partition's parts
 * outside them (block_timestamp is the partition key, so every part carries its
 * min/max), and the hour set keeps exactly the hours being recomputed. Every
 * fold below works per block (a fill, the Omnipool hub-hop window, a routed
 * trade), and a block lies in one hour, so any set of whole hours folds exactly
 * as it would beside every other hour of its month.
 */
export function hourLegsPredicate(partition: string, hours: readonly string[]): string {
  if (!PARTITION_RE.test(partition)) throw new Error(`invalid partition ${JSON.stringify(partition)}`)
  if (!hours.length) throw new Error('no hours to fold')
  for (const hour of hours) {
    const m = HOUR_RE.exec(hour)
    if (!m || `${m[1]}${m[2]}` !== partition) throw new Error(`invalid hour ${JSON.stringify(hour)} for ${partition}`)
  }
  const sorted = [...hours].sort()
  return `toYYYYMM(block_timestamp) = ${partition}
      AND block_timestamp >= toDateTime('${sorted[0]}')
      AND block_timestamp < toDateTime('${sorted[sorted.length - 1]}') + INTERVAL 1 HOUR
      AND toStartOfHour(block_timestamp) IN (${sorted.map(h => `toDateTime('${h}')`).join(', ')})`
}

/**
 * A row's registry fingerprint, looked up from its hour: the value the staleness
 * check computed for that hour, so the next check compares like with like.
 */
export function hourFingerprintSql(hourColumn: string, hours: readonly FoldHour[]): string {
  for (const h of hours) if (!/^\d+$/.test(h.fingerprint)) throw new Error(`invalid fingerprint ${JSON.stringify(h.fingerprint)}`)
  return `transform(${hourColumn}, [${hours.map(h => `toDateTime('${h.hour}')`).join(', ')}],
                   [${hours.map(h => `toUInt64(${h.fingerprint})`).join(', ')}], toUInt64(0))`
}

/**
 * The protocol's share of each Uniswap v3 fee leg of the hours, as its divisor:
 * one row per (pool, swap) whose pool had `SetFeeProtocol` on for the fee's token
 * side at that swap — `fp` the denominator (1/fp of the fee is the protocol's).
 * The uniswap_v3_fee stream's rule on the same fragments (its swap_fees /
 * sided_fees / accrued_fees stages). It reads the hours' v3 fee legs on its own
 * rather than through `legs`, which a second reference would re-scan and
 * re-deduplicate whole: `pool_swap_legs` is venue-first, so this is a narrow
 * range, and its GROUP BY collapses a replayed swap to one row all the same.
 */
function v3FeeProtocolCtesSql(partition: string, hours: readonly string[]): string {
  return `${V3_TOKEN_ASSETS_CTE},
${V3_POOLS_CTE},
${V3_FEE_PROTOCOL_CTE},
v3_fee_sided AS (
  SELECT s.pool_key AS pool_key, s.pool AS pool, s.block_height AS block_height, s.event_index AS event_index,
         s.at_key AS at_key, ${v3FeeSideSql('s.fee_asset_id')} AS side
  FROM (
    SELECT l.pool_key AS pool_key, lower(l.pool_key) AS pool, l.block_height AS block_height, l.event_index AS event_index,
           ${v3EventAtKeySql('l')} AS at_key,
           argMax(l.asset_id, l.ingested_at) AS fee_asset_id
    FROM price_data.pool_swap_legs AS l
    WHERE l.venue = 'uniswapv3' AND l.leg_kind = 'fee'
      AND ${hourLegsPredicate(partition, hours)}
    GROUP BY l.pool_key, l.block_height, l.event_index
  ) AS s
  INNER JOIN pools AS p ON p.pool_address = s.pool
  LEFT JOIN token_assets AS t1 ON t1.addr = lower(p.token1)
),
v3_fee_div AS (
  SELECT f.pool_key AS pool_key, f.block_height AS block_height, f.event_index AS event_index, fp.fp AS fp
  FROM v3_fee_sided AS f
  ASOF INNER JOIN ${V3_FEE_PROTOCOL_SIDES_SQL} AS fp
    ON fp.pool = f.pool AND fp.side = f.side AND fp.at_key <= f.at_key
  WHERE fp.fp > 0
)`
}

/**
 * The hours' fills, one row per (venue, pool, fill), each carrying its hour, its
 * value, its fee split and the per-asset sides (non-hub assets with an in/out leg)
 * as an array, so the leg scan, the deduplication and the price join run once.
 *
 * Reads `{anchor:DateTime}` / `{hours:UInt32}` for the candle window
 * (ANCHORED_PRICE_WINDOW, through pricedCteSql's default source).
 */
export function volumeFillsCteSql(partition: string, hours: readonly string[]): string {
  const lpFee = lpFeeLegSql()
  return `${legsCteSql("venue != 'aave'", hourLegsPredicate(partition, hours), ['fee_recipient'])},
${pricedCteSql(['venue', 'pool_key', 'fee_dest', 'fee_recipient', 'block_time'])},
${v3FeeProtocolCtesSql(partition, hours)},
-- A v3 fee leg's protocol share in USD (0 everywhere else): the leg's value over
-- the pool's denominator for its side at the swap. LEFT JOIN onto a unique
-- (pool, swap) key, so no leg is repeated.
split AS (
  SELECT p.*,
         if(p.venue = 'uniswapv3' AND p.leg_kind = 'fee' AND d.fp > 0,
            p.usd / toDecimal256(d.fp, 0), toDecimal256(0, 12)) AS v3_protocol_usd
  FROM priced AS p
  LEFT JOIN v3_fee_div AS d
    ON d.pool_key = p.pool_key AND d.block_height = p.block_height AND d.event_index = p.event_index
),
fill_asset AS (
  SELECT venue, pool_key, block_height, event_index, asset_id,
         min(block_time) AS block_time,
         maxIf(1, leg_kind = 'in') AS has_in,
         maxIf(1, leg_kind = 'out') AS has_out,
         toUInt32(countIf(leg_kind != 'fee')) AS side_legs,
         sumIf(usd, leg_kind = 'in') AS leg_in_usd,
         sumIf(usd, leg_kind = 'out') AS leg_out_usd,
         sumIf(usd - v3_protocol_usd, leg_kind = 'fee' AND ${lpFee}) AS leg_lp_fee_usd,
         sumIf(usd, leg_kind = 'fee' AND NOT (${lpFee})) + sumIf(v3_protocol_usd, leg_kind = 'fee' AND ${lpFee}) AS leg_protocol_fee_usd
  FROM split
  GROUP BY venue, pool_key, block_height, event_index, asset_id
),
fill AS (
  SELECT venue, pool_key, block_height, event_index,
         toStartOfHour(min(block_time)) AS hour,
         sum(leg_out_usd) AS out_usd,
         sum(leg_in_usd) AS in_usd,
         ${FILL_USD} AS fill_usd,
         maxIf(has_out, asset_id = ${H2O_ASSET_ID}) AS out_hub,
         maxIf(has_in, asset_id = ${H2O_ASSET_ID}) AS in_hub,
         sum(leg_lp_fee_usd) AS lp_fee_usd,
         sum(leg_protocol_fee_usd) AS protocol_fee_usd,
         groupArrayIf(tuple(asset_id, leg_in_usd + leg_out_usd, side_legs),
                      asset_id != ${H2O_ASSET_ID} AND side_legs > 0) AS asset_parts
  FROM fill_asset
  GROUP BY venue, pool_key, block_height, event_index
)`
}

/**
 * A set of hours of pool_volume_hourly, into `target` (the staging twin).
 *
 * `fills` counts the fills that carry volume — on the Omnipool that excludes the
 * first hop of a hub swap, so it counts user swaps the way the volume does.
 * Fees are counted on EVERY fill: a hub swap pays the H2O fee on its first hop
 * and the asset fee on its second.
 */
export function poolVolumeHourlyInsertSql(partition: string, hours: readonly FoldHour[], target: string): string {
  return `INSERT INTO ${target} (venue, pool_key, hour, volume_usd, fills, lp_fee_usd, protocol_fee_usd, unpriced_fills, registry_fp, computed_at)
WITH ${volumeFillsCteSql(partition, hours.map(h => h.hour))},
flagged AS (
  SELECT venue, pool_key, hour, event_index, fill_usd, out_hub, lp_fee_usd, protocol_fee_usd,
         any(in_hub) OVER nxt AS next_in_hub,
         any(event_index) OVER nxt AS next_event_index,
         any(venue) OVER nxt AS next_venue
  FROM fill
  ${NEXT_FILL_WINDOW}
),
counted AS (
  SELECT venue, pool_key, hour, fill_usd, lp_fee_usd, protocol_fee_usd,
         NOT (${IS_OMNIPOOL_FIRST_HOP}) AS carries
  FROM flagged
)
SELECT venue, pool_key, hour,
       toDecimal128(sumIf(fill_usd, carries), 12) AS volume_usd,
       toUInt32(countIf(carries)) AS fills,
       toDecimal128(sum(lp_fee_usd), 12) AS lp_fee_usd_sum,
       toDecimal128(sum(protocol_fee_usd), 12) AS protocol_fee_usd_sum,
       toUInt32(countIf(carries AND fill_usd = 0)) AS unpriced_fills,
       ${hourFingerprintSql('hour', hours)} AS registry_fp,
       now() AS computed_at
FROM counted
GROUP BY venue, pool_key, hour`
}

/**
 * A set of hours of asset_volume_hourly, into `target` (the staging twin).
 *
 * `legs` counts the asset's in/out legs; `unpriced_legs` those of a side whose
 * value ended at 0 — its own legs unpriced and the fill unpriced too.
 */
export function assetVolumeHourlyInsertSql(partition: string, hours: readonly FoldHour[], target: string): string {
  return `INSERT INTO ${target} (asset_id, venue, pool_key, hour, volume_usd, legs, unpriced_legs, registry_fp, computed_at)
WITH ${volumeFillsCteSql(partition, hours.map(h => h.hour))},
sides AS (
  SELECT venue, pool_key, hour,
         arrayJoin(arrayMap(p -> tuple(tupleElement(p, 1),
                                       ${assetSideUsdSql('1', 'tupleElement(p, 2)', 'fill_usd')},
                                       tupleElement(p, 3)), asset_parts)) AS side
  FROM fill
)
SELECT tupleElement(side, 1) AS side_asset, venue, pool_key, hour,
       toDecimal128(sum(tupleElement(side, 2)), 12) AS volume_usd,
       toUInt32(sum(tupleElement(side, 3))) AS legs,
       toUInt32(sumIf(tupleElement(side, 3), tupleElement(side, 2) = 0)) AS unpriced_legs,
       ${hourFingerprintSql('hour', hours)} AS registry_fp,
       now() AS computed_at
FROM sides
GROUP BY side_asset, venue, pool_key, hour`
}

/**
 * A set of hours of routed_volume_hourly, into `target` (the staging twin): the
 * routed trades of those hours' legs, per UTC hour. Reads the same
 * `{anchor:DateTime}` / `{hours:UInt32}` candle window as the two folds above.
 * The netted chain runs over EVERY venue (the aave legs included: a wrap inside a
 * route cancels in the per-asset net, and only whole-wrap trades are dropped, by
 * nettedTradeSidesSql's HAVING).
 */
export function routedVolumeHourlyInsertSql(partition: string, hours: readonly FoldHour[], target: string): string {
  return `INSERT INTO ${target} (hour, volume_usd, trades, unpriced_trades, registry_fp, computed_at)
WITH ${routedNettedCteSql(hourLegsPredicate(partition, hours.map(h => h.hour)), undefined, true, 'hour')}
SELECT day AS trade_hour,
       toDecimal128(sum(greatest(side_in, side_out)), 12) AS volume_usd,
       toUInt32(count()) AS trades,
       toUInt32(countIf(side_in = 0 AND side_out = 0)) AS unpriced_trades,
       ${hourFingerprintSql('trade_hour', hours)} AS registry_fp,
       now() AS computed_at
FROM (
  ${nettedTradeSidesSql(['day'])}
)
GROUP BY trade_hour
SETTINGS optimize_aggregation_in_order = 1`
}
