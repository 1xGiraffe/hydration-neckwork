import type { ClickHouseClient } from '../../db/client.ts'
import { cachedSwr } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'
import { PERC_DECIMALS, omnipoolFarmAprByAsset, renderPerc, scaled } from './farmApr.ts'
import {
  ANCHORED_LEG_WINDOW, DECIMAL_STRINGS, OMNIPOOL_ACCOUNT, WINDOW_DAYS, WINDOW_HOURS, amountUnitSql,
  legsCteSql, priceAliasSql, priceSourceSql, pricedCteSql, readAnchor, type VolumeWindow,
} from './poolVolumes.ts'

// Fee yield per Omnipool asset and per stableswap pool, over a rolling window
// anchored on the newest indexed swap fill. Normative definitions: spec
// § Semantics 3 (Omnipool) and 4 (stableswap).
//
// The two venues are deliberately NOT computed the same way:
//
//  * Omnipool is a RAW-UNIT ratio. The fee an asset accrues and the reserve it
//    accrues into are the same token, so `fee_amount_X / avg_reserve_X` needs no
//    price at all — and therefore cannot be distorted by a stale or missing feed.
//  * A stableswap pool's fees arrive in several assets, so the ratio only exists
//    in USD: `Σ fee_legs_usd / avg_pool_tvl_usd`, both sides valued event-time.
//    This is the spec's documented deviation from the data lake, which averages
//    per-asset raw ratios unweighted.
//
// The denominator is a simple mean over the state-history samples that fall
// INSIDE the window. The history tables are written on a uniform 600-block grid,
// so a simple mean IS the time-weighted average up to the grid's own jitter; and
// restricting to in-window samples is what keeps a delisted asset (whose last row
// stays in the table forever) from valuing today's fees against a months-old
// reserve. An asset with no in-window sample has no denominator and reports null
// rather than a number no measurement supports.

/** Windows the yield endpoints serve. An hour of fees says nothing about a year. */
export type YieldWindow = Exclude<VolumeWindow, '1h'>

export interface OmnipoolYieldItem {
  assetId: string
  feeAprPerc: string | null
  feeApyPerc: string | null
  /** Liquidity-mining APR, summed over the asset's farms (farmApr.ts). */
  farmAprPerc: string | null
  /** The assets those farms pay their rewards in. */
  farmRewardAssets: string[]
  protocolFeeAprPerc: string | null
}

export interface StableswapYieldItem {
  poolId: string
  feeAprPerc: string | null
  feeApyPerc: string | null
  /**
   * Always null. Liquidity mining incentivises Omnipool positions and XYK shares,
   * never a stableswap pool's own LPs; when a pool's share token is itself an
   * Omnipool asset, the farm on it is reported on the Omnipool item for that id.
   */
  farmAprPerc: string | null
}

const PERC_UNIT = 10n ** BigInt(PERC_DECIMALS)
/** Working scale for the fee/TVL ratio the queries return. */
const RATIO_DECIMALS = 18
/** Fixed-point scale for a fractional window length (1h = 1/24 day). */
const DAY_SCALE = 10n ** 9n

/**
 * A period return as a yearly percentage: `100 · feeOverTvl · 365/windowDays`,
 * rounded half up to four decimals.
 *
 * Integer arithmetic end to end (AGENTS.md): the ratio carries eighteen decimals —
 * more than a double's 15–17 significant digits — and the multiplication by
 * 365/windowDays would otherwise decide the published digit by rounding error.
 */
export function annualizeApr(feeOverTvl: string, windowDays: number): string {
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new RangeError(`windowDays must be a positive number of days, got ${windowDays}`)
  }
  const ratio = scaled(feeOverTvl, RATIO_DECIMALS)
  const days = BigInt(Math.round(windowDays * Number(DAY_SCALE)))
  const numerator = ratio * 100n * 365n * PERC_UNIT * DAY_SCALE
  const denominator = 10n ** BigInt(RATIO_DECIMALS) * days
  // Half up, on the magnitude, so -x and x round symmetrically.
  const negative = numerator < 0n
  const magnitude = (negative ? -numerator : numerator)
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n)
  return renderPerc(negative ? -rounded : rounded)
}

/**
 * The annualized rate compounded at the window's own frequency:
 * `100 · ((1 + aprPeriod)^(365/W) − 1)` with `aprPeriod = (aprPerc/100) · W/365`.
 *
 * This is the ONE place a float is allowed to touch a published number: a real
 * exponent has no exact integer form, and the result is rounded to four decimals,
 * far above a double's precision at these magnitudes. The APR it is derived from
 * is computed exactly — though this signature takes the ROUNDED APR string, so the
 * period return is reconstructed from four decimals and the APY inherits up to
 * 5e-5 of that rounding. Deliberate: the published APY is then exactly the APY of
 * the published APR, which is the pair a consumer can check.
 */
export function aprToApy(aprPerc: string, windowDays: number): string {
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new RangeError(`windowDays must be a positive number of days, got ${windowDays}`)
  }
  const periods = 365 / windowDays
  const periodReturn = (Number(aprPerc) / 100) / periods
  if (!Number.isFinite(periodReturn)) throw new RangeError(`not a percentage: ${aprPerc}`)
  // expm1/log1p keep the small-rate case (the normal one) accurate; a plain
  // pow(1 + x, n) loses most of its significant digits when x is ~1e-6.
  const apy = Math.expm1(Math.log1p(periodReturn) * periods) * 100
  if (!Number.isFinite(apy)) throw new RangeError(`apy is not finite for apr ${aprPerc} over ${windowDays} days`)
  // toFixed switches to exponent notation past 1e21, which no consumer of a
  // decimal-string contract should have to parse.
  return Math.abs(apy) < 1e15 ? apy.toFixed(PERC_DECIMALS) : `${BigInt(Math.round(apy))}.${'0'.repeat(PERC_DECIMALS)}`
}

/**
 * `legsCteSql` with `fee_recipient`, scoped to this file.
 *
 * The LP fee APR's numerator is a question about WHO RECEIVED a fee, which the
 * shared helper does not carry — it serves the volume and stableswap paths, where
 * what a trade PAID is the whole question, and adding an argMax there would cost
 * every one of them a column for nobody's benefit. Same departure, and the same
 * reason, as feesCharts' `feeLegsCteSql`.
 *
 * The GROUP BY is the destination table's ORDER BY (its ReplacingMergeTree
 * replacement key), so a replayed range cannot contribute a leg twice.
 */
function omnipoolYieldLegsCteSql(): string {
  return `legs AS (
    SELECT block_height, event_index, leg_kind,
           argMax(asset_id, ingested_at) AS asset_id,
           argMax(amount, ingested_at) AS amount,
           argMax(fee_dest, ingested_at) AS fee_dest,
           argMax(fee_recipient, ingested_at) AS fee_recipient
    FROM price_data.pool_swap_legs
    WHERE venue = 'omnipool'
      AND ${ANCHORED_LEG_WINDOW}
    GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index
  )`
}

/**
 * The fee legs that actually accrue to Omnipool liquidity providers.
 *
 * NOT simply "not burned". The runtime splits an asset fee across recipients and
 * emits one leg per recipient (OMNIPOOL_ACCOUNT in poolVolumes.ts), so roughly
 * HALF of the non-burned asset fee is routed away from the pool — to staking and
 * referrals until 2026-06-22, to the fee processor since. Measured over the 30-day
 * window at 2026-08-12: the pool's own share is 50.1–55.0 % of the non-burned
 * asset fee per asset (51.5 % across the top assets), so counting both legs
 * published an LP APR about 1.9× the rate an LP earns.
 *
 * An EMPTY recipient is counted. Those are the pre-2025-01-25 legacy legs, whose
 * per-pallet projections record no recipient at all; they are majority-LP-era, so
 * including them is the better of two wrong answers — but it is a KNOWN BIAS and
 * it points UP: a window reaching before 2025-01-25 OVERSTATES the LP APR by
 * whatever share of those fees was routed elsewhere. The windows this endpoint
 * serves (7d, 30d) contain no such leg, so the bias is inert here; it would matter
 * if a longer window were ever added.
 */
const LP_FEE_LEG = `leg_kind = 'fee' AND asset_id != 1 AND fee_dest != 'burned'
                      AND (fee_recipient = '${OMNIPOOL_ACCOUNT}' OR fee_recipient = '')`

/**
 * Per-asset fee and protocol-fee ratios for the Omnipool, in raw units.
 *
 * Numerator: the asset's LP-accruing fee legs (LP_FEE_LEG) — not burned, and
 * received by the pool itself. Denominator: the mean of the asset's in-window
 * `omnipool_pool_state_history` reserves, deduplicated per (asset, block) first
 * because that table replaces on ingestion time too.
 *
 * The protocol fee is charged in LRNA on the leg that sold an asset INTO the hub,
 * so it is attributed to the fill's non-hub in-asset and measured against that
 * asset's own hub reserve — reported separately, never blended into the LP APR.
 * It is NOT recipient-filtered: every destination it has is protocol revenue, and
 * the only split it has ever carried (burn vs treasury) is between two of them.
 */
export function buildOmnipoolYieldSql(): string {
  return `-- pub:yield:omnipool
WITH ${omnipoolYieldLegsCteSql()},
fill AS (
  SELECT block_height, event_index,
         anyIf(toNullable(asset_id), leg_kind = 'in' AND asset_id != 1) AS in_asset,
         anyIf(toNullable(asset_id), leg_kind = 'out' AND asset_id != 1) AS out_asset,
         sumIf(toDecimal256(amount, 0), leg_kind = 'fee' AND asset_id = 1 AND fee_dest != 'burned') AS hub_fee_raw,
         groupArrayIf(tuple(asset_id, toDecimal256(amount, 0)), ${LP_FEE_LEG}) AS asset_fees
  FROM legs
  GROUP BY block_height, event_index
),
emitted AS (
  SELECT arrayJoin(arrayConcat(
    arrayMap(f -> tuple(toNullable(tupleElement(f, 1)), tupleElement(f, 2), toDecimal256(0, 0)), asset_fees),
    [tuple(coalesce(in_asset, out_asset), toDecimal256(0, 0), hub_fee_raw)]
  )) AS part
  FROM fill
),
fee_by_asset AS (
  SELECT tupleElement(part, 1) AS asset_id,
         sum(tupleElement(part, 2)) AS fee_raw,
         sum(tupleElement(part, 3)) AS pfee_raw
  FROM emitted
  GROUP BY asset_id
),
samples AS (
  SELECT toUInt32(asset_id) AS asset_id, block_height,
         toDecimal256(argMax(reserve_raw, ingested_at), 0) AS reserve,
         toDecimal256(argMax(hub_reserve_raw, ingested_at), 0) AS hub
  FROM price_data.omnipool_pool_state_history
  WHERE block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
    AND block_timestamp <= {anchor:DateTime}
  GROUP BY asset_id, block_height
),
parts AS (
  SELECT asset_id, fee_raw, pfee_raw,
         toDecimal256(0, 0) AS reserve_sum, toDecimal256(0, 0) AS hub_sum, toUInt64(0) AS samples
  FROM fee_by_asset
  UNION ALL
  SELECT toNullable(asset_id), toDecimal256(0, 0), toDecimal256(0, 0),
         toDecimal256(sum(reserve), 0), toDecimal256(sum(hub), 0), toUInt64(count())
  FROM samples GROUP BY asset_id
)
SELECT ifNull(toString(asset), '') AS asset_id,
       toString(sample_count) AS samples,
       toString(if(reserves > 0,
                   divideDecimal(multiplyDecimal(fees, toDecimal256(sample_count, 0), 0), reserves, ${RATIO_DECIMALS}),
                   toDecimal256(0, ${RATIO_DECIMALS}))) AS fee_ratio,
       toString(if(hubs > 0,
                   divideDecimal(multiplyDecimal(pfees, toDecimal256(sample_count, 0), 0), hubs, ${RATIO_DECIMALS}),
                   toDecimal256(0, ${RATIO_DECIMALS}))) AS protocol_fee_ratio
FROM (
  SELECT asset_id AS asset, sum(fee_raw) AS fees, sum(pfee_raw) AS pfees,
         sum(reserve_sum) AS reserves, sum(hub_sum) AS hubs, sum(samples) AS sample_count
  FROM parts GROUP BY asset_id
)
WHERE asset IS NOT NULL
ORDER BY asset`
}

/**
 * Per-pool fee USD and the fee-over-TVL ratio for stableswap pools.
 *
 * A sample's TVL is the sum of its reserves valued at the candle that had closed
 * by the sample's own block, and a sample in which ANY leg is unpriced is dropped
 * whole: counting it would report a fraction of the pool's value as its value and
 * inflate the APR. Pools with no fully priced sample report null.
 */
export function buildStableswapYieldSql(): string {
  return `-- pub:yield:stableswap
WITH ${legsCteSql("venue = 'stableswap' AND leg_kind = 'fee'")},
${pricedCteSql(['pool_key', 'fee_dest'])},
samples AS (
  SELECT pool_id, block_height, min(block_timestamp) AS sample_time,
         argMax(asset_ids, ingested_at) AS ids, argMax(reserves_raw, ingested_at) AS reserves
  FROM price_data.stableswap_pool_state_history
  WHERE block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
    AND block_timestamp <= {anchor:DateTime}
  GROUP BY pool_id, block_height
),
sample_legs AS (
  SELECT s.pool_id AS pool_id, s.block_height AS block_height,
         divideDecimal(multiplyDecimal(toDecimal256(s.reserve_raw, 0), toDecimal256(p.close, 12), 12), ${amountUnitSql('s.leg_asset')}, 12) AS leg_usd,
         p.close AS close
  FROM (
    SELECT pool_id, block_height, sample_time,
           tupleElement(leg, 1) AS leg_asset, tupleElement(leg, 2) AS reserve_raw
    FROM samples ARRAY JOIN arrayZip(ids, reserves) AS leg
  ) s
  ASOF LEFT JOIN ${priceSourceSql()} p
    ON p.asset_id = ${priceAliasSql('s.leg_asset')} AND p.price_time <= s.sample_time
),
sample_tvl AS (
  SELECT pool_id, block_height, sum(leg_usd) AS tvl_usd, countIf(close = 0) AS unpriced
  FROM sample_legs
  GROUP BY pool_id, block_height
),
tvl AS (
  SELECT pool_id, count() AS samples, sum(tvl_usd) AS tvl_sum
  FROM sample_tvl WHERE unpriced = 0 GROUP BY pool_id
),
parts AS (
  SELECT pool_key AS pool_id, toDecimal256(sum(usd), 12) AS fee_usd, toDecimal256(0, 12) AS tvl_sum, toUInt64(0) AS samples
  FROM priced WHERE leg_kind = 'fee' AND fee_dest != 'burned' GROUP BY pool_key
  UNION ALL
  SELECT toString(pool_id), toDecimal256(0, 12), toDecimal256(tvl_sum, 12), toUInt64(samples) FROM tvl
)
SELECT pool AS pool_id,
       toString(sample_count) AS samples,
       toString(fees) AS fee_usd,
       toString(if(tvl_total > 0,
                   divideDecimal(multiplyDecimal(fees, toDecimal256(sample_count, 0), 12), tvl_total, ${RATIO_DECIMALS}),
                   toDecimal256(0, ${RATIO_DECIMALS}))) AS fee_ratio
FROM (
  SELECT pool_id AS pool, sum(fee_usd) AS fees, sum(tvl_sum) AS tvl_total, sum(samples) AS sample_count
  FROM parts GROUP BY pool_id
)
ORDER BY pool`
}

interface OmnipoolYieldRow { asset_id: string; samples: string; fee_ratio: string; protocol_fee_ratio: string }
interface StableswapYieldRow { pool_id: string; samples: string; fee_usd: string; fee_ratio: string }

/**
 * A venue whose every APR is null has no denominator anywhere — the state-history
 * grid stopped, or (for stableswap) not one TVL sample could be fully priced. The
 * nulls are the honest answer; this is what makes the outage visible.
 */
function warnIfNoDenominator(venue: string, window: string, aprs: Array<string | null>): void {
  if (aprs.length === 0 || aprs.some(apr => apr != null)) return
  console.warn(`[public-api] ${venue} ${window} yield has no denominator for any of ${aprs.length} entries — `
    + 'no in-window state-history sample could be used (check the pool state history and the price feed)')
}

/** APR and APY for a ratio, or null when the window held no denominator sample. */
function rates(ratio: string, samples: string, windowDays: number): { apr: string | null; apy: string | null } {
  if (Number(samples) <= 0) return { apr: null, apy: null }
  const apr = annualizeApr(ratio, windowDays)
  return { apr, apy: aprToApy(apr, windowDays) }
}

export async function omnipoolYield(client: ClickHouseClient, window: YieldWindow): Promise<{ asOf: string | null; items: OmnipoolYieldItem[] }> {
  return cachedSwr(`pub:yield:omnipool:${window}`, 600_000, 1_800_000, async () => {
    const at = await readAnchor(client)
    if (!at) return { asOf: null, items: [] }
    // The farm rate is current state, not a window quantity, so it is the same in
    // every window; it rides this cache entry rather than one of its own so a
    // window's response is one consistent read.
    const [res, farms] = await Promise.all([
      client.query({
        query: buildOmnipoolYieldSql(),
        query_params: { anchor: at.anchor, hours: WINDOW_HOURS[window] },
        format: 'JSONEachRow',
        clickhouse_settings: DECIMAL_STRINGS,
      }),
      omnipoolFarmAprByAsset(client, at.anchor),
    ])
    const days = WINDOW_DAYS[window]
    const items = (await res.json<OmnipoolYieldRow>())
      .filter(row => row.asset_id !== '')
      .map(row => {
        const fee = rates(row.fee_ratio, row.samples, days)
        const farm = farms.get(row.asset_id)
        return {
          assetId: row.asset_id,
          feeAprPerc: fee.apr,
          feeApyPerc: fee.apy,
          farmAprPerc: farm?.farmAprPerc ?? null,
          farmRewardAssets: farm?.rewardAssetIds ?? [],
          protocolFeeAprPerc: Number(row.samples) > 0 ? annualizeApr(row.protocol_fee_ratio, days) : null,
        }
      })
    warnIfNoDenominator('omnipool', window, items.map(i => i.feeAprPerc))
    return { asOf: iso(at.anchor), items }
  })
}

export async function stableswapYield(client: ClickHouseClient, window: YieldWindow): Promise<{ asOf: string | null; items: StableswapYieldItem[] }> {
  return cachedSwr(`pub:yield:stableswap:${window}`, 600_000, 1_800_000, async () => {
    const at = await readAnchor(client)
    if (!at) return { asOf: null, items: [] }
    const res = await client.query({
      query: buildStableswapYieldSql(),
      query_params: { anchor: at.anchor, hours: WINDOW_HOURS[window] },
      format: 'JSONEachRow',
      clickhouse_settings: DECIMAL_STRINGS,
    })
    const days = WINDOW_DAYS[window]
    const items = (await res.json<StableswapYieldRow>()).map(row => {
      const fee = rates(row.fee_ratio, row.samples, days)
      return { poolId: row.pool_id, feeAprPerc: fee.apr, feeApyPerc: fee.apy, farmAprPerc: null }
    })
    warnIfNoDenominator('stableswap', window, items.map(i => i.feeAprPerc))
    return { asOf: iso(at.anchor), items }
  })
}
