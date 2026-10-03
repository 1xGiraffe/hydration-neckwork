import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { priceAssetId } from './explorerAssets.ts'
import { nettedTradeSidesSql, routedNettedCteSql } from './poolVolumes.ts'
import { PRICE_LOOKBACK_DAYS, amountUnitSql, priceAliasSql, priceSourceSql, scaledDecimal, scaledUsd } from './valuation.ts'
import { hourFingerprintSql, hourLegsPredicate, type FoldHour } from './volumeHourly.ts'

// PAIR VOLUME — the dollar value of the trades between two assets, per 5-minute
// bucket: the volume a pair's candle carries on the three pair surfaces
// (/v1/prices/pair, the preis /candles cross pairs, the explorer's pair chart).
// It is NOT the base asset's volume (every trade that touched the base, against
// anything), which those surfaces published before and which the public route
// still carries as `baseVolumeUsd`.
//
// A trade is the netting chain the routed volume uses (routedNettedCteSql): fills
// grouped into their Router operation (or the Omnipool hub hop's partner), each
// asset's legs netted inside the trade, so a 3-hop route counts once, at its
// boundaries. A trade belongs to the pair {A, B} when its NET endpoints are
// exactly one asset paid in and one asset taken out, A and B in either direction.
// The endpoints are found by the sign of the RAW net amount (`net_amt`), not the
// USD net, so an unpriced endpoint is still an endpoint. Its value is the routed
// rule's: `greatest(side_in, side_out)` at event time (closed 1h candle at or
// before the fill, through the price aliases) — the number the volume models
// publish for the same trade. A route does not cancel its intermediates to the
// wei: an aToken hop leaves a rounding unit or two, an Omnipool hop a sliver of
// the hub asset (MEASURED 2026-09-29: 8,723 of 25,907 trades carried such a
// remainder, $0.07–0.50 of H2O on a few-hundred-dollar trade). So a side's
// endpoint is its one asset, or the asset holding all but DUST_SHARE (1 %) of
// the side's priced value. A side genuinely split between assets (a multi-asset
// withdrawal), or several unpriced assets nothing can rank, names no endpoint and
// the trade is no pair's. Whole-trade aToken wraps are dropped
// (nettedTradeSidesSql's HAVING), as everywhere else.
//
// ALIASES: each endpoint is keyed by the series the pair surfaces key a request
// on (priceAliasSql, the SQL face of priceAssetId): an aToken folds into its
// reserve and a Hydrated pool share into its wrapper. A DOT → aUSDT trade is
// DOT/USDT volume, exactly as `assetIn=DOT&assetOut=aUSDT` reads the DOT/USDT
// series; a trade whose two endpoints alias to one series (an aToken redeemed for
// its reserve) is no pair's trade.
//
// TOKEN AMOUNTS: each bucket also keeps the exact amounts of the two assets the
// pair's trades moved — per trade its netted endpoint amounts (what was paid in,
// what was taken out), raw integers turned into whole units by each raw asset's
// registry decimals — as `amount_lo` / `amount_hi`, the lower and higher id's
// side. No price enters them, so they are exact and defined where the USD value
// is not (an unpriced endpoint), and either orientation reads its base and quote
// from the same two numbers. An aliased endpoint (aUSDT for USDT) counts 1:1 in
// its series' units, which is what the alias asserts.
//
// The aggregator adapters (CoinGecko, DexScreener, DefiLlama) do NOT read this:
// their volume definitions are their own contracts and stay as they are.

export const PAIR_VOLUME_5MIN_TABLE = 'price_data.pair_volume_5min'

/** The share of a side's priced value its other assets may hold and still leave one endpoint: route dust (see pairVolumeRowsSql). */
export const DUST_SHARE = 0.01

/**
 * The trades of the legs `legPredicate` selects, as one row per (asset_lo,
 * asset_hi, 5-minute bucket): the pair volume, split by direction (`lo_in`: the
 * lower id paid in, the higher taken out), with the trade counts. Every price is
 * read from `priceSource`.
 */
export function pairVolumeRowsSql(legPredicate: string, priceSource?: string): string {
  const endpoint = priceAliasSql('asset_id')
  // A raw net amount in whole units of its own asset: the scale-18 dividend keeps
  // every digit of an asset of up to 18 decimals (the registry's widest).
  const units = (amt: string) => `toDecimal256(${amt}, 18) / ${amountUnitSql('asset_id')}`
  // A side names one endpoint when it holds one asset, or when one asset carries
  // all but DUST_SHARE of its priced value: a route leaves wei-scale remainders of
  // its intermediates (an aToken's rounding, the hub asset's fee remainder), which
  // are not a second endpoint. A side split between several real assets, or one
  // whose several assets are all unpriced, names none.
  const endpointClear = (side: 'in' | 'out') => `(length(${side}_ids) = 1
         OR (arrayMax(${side}_usds) > 0
             AND arraySum(${side}_usds) - arrayMax(${side}_usds) <= arraySum(${side}_usds) / ${1 / DUST_SHARE}))`
  return `WITH ${routedNettedCteSql(legPredicate, priceSource, true, '5min', { fees: false, amounts: true })},
trade_sides AS (
  ${nettedTradeSidesSql(['day'], [
    `sumMapIf([${endpoint}], [${units('-net_amt')}], [-net_usd], net_amt < 0) AS ins`,
    `sumMapIf([${endpoint}], [${units('net_amt')}], [net_usd], net_amt > 0) AS outs`,
  ])}
),
picked AS (
  SELECT day AS bucket, greatest(side_in, side_out) AS usd, side_in = 0 AND side_out = 0 AS unpriced,
         ins.1 AS in_ids, ins.2 AS in_amts, ins.3 AS in_usds,
         outs.1 AS out_ids, outs.2 AS out_amts, outs.3 AS out_usds,
         if(length(in_ids) = 1, 1, indexOf(in_usds, arrayMax(in_usds))) AS i_in,
         if(length(out_ids) = 1, 1, indexOf(out_usds, arrayMax(out_usds))) AS i_out
  FROM trade_sides
  WHERE ${endpointClear('in')} AND ${endpointClear('out')}
),
pair_trades AS (
  SELECT bucket, usd, unpriced, in_ids[i_in] AS a_in, out_ids[i_out] AS a_out, in_amts[i_in] AS amt_in, out_amts[i_out] AS amt_out
  FROM picked
  WHERE a_in != a_out
)
SELECT least(a_in, a_out) AS asset_lo, greatest(a_in, a_out) AS asset_hi, bucket AS interval_start,
       toDecimal128(sum(usd), 12) AS volume_usd,
       toDecimal128(sumIf(usd, a_in < a_out), 12) AS volume_lo_in_usd,
       toDecimal128(sum(if(a_in < a_out, amt_in, amt_out)), 18) AS amount_lo,
       toDecimal128(sum(if(a_in < a_out, amt_out, amt_in)), 18) AS amount_hi,
       toUInt32(count()) AS trades,
       toUInt32(countIf(unpriced)) AS unpriced_trades
FROM pair_trades
GROUP BY asset_lo, asset_hi, interval_start`
}

/**
 * A set of hours of pair_volume_5min, into `target` (the staging twin). Each
 * folded hour also gets a MARKER row (asset_lo = asset_hi = 0, interval_start =
 * the hour, zero volume): an hour with no pair trade at all is still folded, so
 * the staleness check sees it held and does not refold it every cycle. No real
 * pair has asset_lo = asset_hi, so no reader of a pair can meet one. Reads the
 * `{anchor:DateTime}` / `{hours:UInt32}` candle window like the volume folds.
 */
export function pairVolume5minInsertSql(partition: string, hours: readonly FoldHour[], target: string): string {
  const columns = 'asset_lo, asset_hi, interval_start, hour, volume_usd, volume_lo_in_usd, amount_lo, amount_hi, trades, unpriced_trades, registry_fp, computed_at'
  return `INSERT INTO ${target} (${columns})
SELECT asset_lo, asset_hi, interval_start, toStartOfHour(interval_start) AS hour, volume_usd, volume_lo_in_usd, amount_lo, amount_hi, trades, unpriced_trades,
       ${hourFingerprintSql('hour', hours)} AS registry_fp, now() AS computed_at
FROM (
${pairVolumeRowsSql(hourLegsPredicate(partition, hours.map(h => h.hour)))}
)
UNION ALL
SELECT toUInt32(0), toUInt32(0), h, h, toDecimal128(0, 12), toDecimal128(0, 12), toDecimal128(0, 18), toDecimal128(0, 18), toUInt32(0), toUInt32(0),
       ${hourFingerprintSql('h', hours)}, now()
FROM (SELECT arrayJoin([${hours.map(h => `toDateTime('${h.hour}')`).join(', ')}]) AS h)`
}

/* ---------------- the read ---------------- */

/** A pair-surface bucket grid: the candle model's intervals. */
export type PairVolumeInterval = '5min' | '15min' | '30min' | '1h' | '4h' | '1d' | '1w' | '1M'

const FIXED_SECONDS: Partial<Record<PairVolumeInterval, number>> = {
  '5min': 300, '15min': 900, '30min': 1_800, '1h': 3_600, '4h': 14_400, '1d': 86_400,
}
// 1970-01-05, the first Monday: the ISO week the candle model's 1w buckets use.
const MONDAY_ANCHOR = 345_600

/** The start of the `interval` bucket an instant falls in, UTC, on the candle model's grid. */
export function pairVolumeBucketStart(interval: PairVolumeInterval, t: number): number {
  const fixed = FIXED_SECONDS[interval]
  if (fixed) return Math.floor(t / fixed) * fixed
  if (interval === '1w') return Math.floor((t - MONDAY_ANCHOR) / 604_800) * 604_800 + MONDAY_ANCHOR
  const d = new Date(t * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}

/** The same bucketing in SQL, over a DateTime expression. */
export function pairVolumeBucketSql(interval: PairVolumeInterval, expr: string): string {
  switch (interval) {
    case '5min': return `toUnixTimestamp(${expr})`
    case '1w': return `toUnixTimestamp(toMonday(${expr}))`
    case '1M': return `toUnixTimestamp(toStartOfMonth(${expr}))`
    default: return `intDiv(toUnixTimestamp(${expr}), ${FIXED_SECONDS[interval]}) * ${FIXED_SECONDS[interval]}`
  }
}

/** The token amounts' fixed scale (the table's Decimal(38, 18)). */
export const AMOUNT_SCALE = 18

/**
 * One bucket of a pair's volume, oriented on the request: USD at the 1e-12 scale,
 * token amounts at the 1e-18 scale, in whole units of each side.
 */
export interface PairVolumeBucket {
  /** Every trade of the pair, both directions, in USD. */
  usd: bigint
  /** The part of `usd` whose trades took the base out (bought it). */
  baseBoughtUsd: bigint
  /** The base asset's amount the trades moved, both directions. */
  base: bigint
  /** The quote asset's amount the trades moved, both directions. */
  quote: bigint
}

interface VolumeRow { t: number | string; v: string; v_lo_in: string; a_lo: string; a_hi: string }
interface LiveRow extends VolumeRow { asset_lo: number | string; asset_hi: number | string }
interface LiveTail { from: number; rows: LiveRow[] }

/** How far behind the price head the live tail reaches: the fold keeps up within an hour or two; past this the gap is left unfilled rather than scanned. */
export const LIVE_TAIL_MAX_SECONDS = 4 * 3_600

/**
 * Whether a window ending at `endSec` can reach past the fold's rows — the hours
 * the tail covers — so a reader passes the head and reads them from the tail.
 * A window older than the tail's reach never builds it.
 */
export function reachesPairVolumeTail(endSec: number, headTime: number): boolean {
  return endSec > headTime - (headTime % 3_600) - LIVE_TAIL_MAX_SECONDS
}

const STORED_THROUGH_SQL = `SELECT toUnixTimestamp(max(hour)) + 3600 AS t FROM ${PAIR_VOLUME_5MIN_TABLE} WHERE asset_lo = 0 AND asset_hi = 0`

/**
 * Every pair's volume past the fold's last hour, up to the head block's time —
 * one build per price head shared by every pair read at that head (the fold is
 * hourly, so this is normally under an hour of legs; never more than
 * LIVE_TAIL_MAX_SECONDS).
 */
function liveTail(client: ClickHouseClient, head: { block: number; time: number }): Promise<LiveTail> {
  return cached(`pair-volume:tail:h${head.block}`, 30_000, async () => {
    const through = await client.query({ query: `-- pair-volume:stored-through\n${STORED_THROUGH_SQL}`, format: 'JSONEachRow' })
    const storedThrough = Number((await through.json<{ t: number | string }>())[0]?.t ?? 0)
    const from = Math.max(storedThrough, head.time - (head.time % 3_600) - LIVE_TAIL_MAX_SECONDS)
    if (from > head.time) return { from, rows: [] }
    const res = await client.query({
      query: `-- pair-volume:tail
SELECT asset_lo, asset_hi, toUnixTimestamp(interval_start) AS t, toString(volume_usd) AS v, toString(volume_lo_in_usd) AS v_lo_in,
       toString(amount_lo) AS a_lo, toString(amount_hi) AS a_hi
FROM (
${pairVolumeRowsSql(
  `block_timestamp >= toDateTime({from:UInt32}) AND block_timestamp <= toDateTime({to:UInt32})`,
  priceSourceSql(`interval_start > toDateTime({from:UInt32}) - INTERVAL ${PRICE_LOOKBACK_DAYS} DAY AND interval_start <= toDateTime({to:UInt32})`),
)}
)`,
      query_params: { from, to: head.time },
      format: 'JSONEachRow',
    })
    return { from, rows: await res.json<LiveRow>() }
  })
}

/**
 * The pair volume of `baseId`/`quoteId` (any ids: each is read through
 * priceAssetId, as the pair surfaces key their series) per `interval` bucket
 * whose start lies in [fromSec, toSec]: the fold's rows, plus — when `head` is
 * given — the unfolded tail up to the head block, so the open bucket carries the
 * volume built so far. A bucket with no trade of the pair is absent (read it as
 * zero). Both orientations read the same rows: `usd` is identical, `base` and
 * `quote` swap places.
 */
export async function queryPairVolume(
  client: ClickHouseClient,
  options: { baseId: number; quoteId: number; interval: PairVolumeInterval; fromSec: number; toSec: number; head?: { block: number; time: number } },
): Promise<Map<number, PairVolumeBucket>> {
  const baseSeries = priceAssetId(options.baseId)
  const quoteSeries = priceAssetId(options.quoteId)
  const out = new Map<number, PairVolumeBucket>()
  if (baseSeries === quoteSeries) return out
  const lo = Math.min(baseSeries, quoteSeries), hi = Math.max(baseSeries, quoteSeries)
  const baseIsLo = baseSeries === lo
  const add = (t: number, r: VolumeRow) => {
    if (t < options.fromSec || t > options.toSec) return
    const usd = scaledUsd(r.v), loIn = scaledUsd(r.v_lo_in)
    const aLo = scaledDecimal(r.a_lo, AMOUNT_SCALE, 'truncate'), aHi = scaledDecimal(r.a_hi, AMOUNT_SCALE, 'truncate')
    // lo paid in, hi taken out: the base is bought when it is hi.
    const bought = baseIsLo ? usd - loIn : loIn
    const prev = out.get(t) ?? { usd: 0n, baseBoughtUsd: 0n, base: 0n, quote: 0n }
    out.set(t, {
      usd: prev.usd + usd,
      baseBoughtUsd: prev.baseBoughtUsd + bought,
      base: prev.base + (baseIsLo ? aLo : aHi),
      quote: prev.quote + (baseIsLo ? aHi : aLo),
    })
  }
  const tail = options.head ? await liveTail(client, options.head) : null
  // The stored rows end where the tail starts, so no trade is counted twice.
  // Their reads are over 5-minute starts: a bucket starting at toSec runs at most
  // a month further.
  const readEnd = options.toSec + 32 * 86_400
  const res = await client.query({
    query: `-- pair-volume:stored
SELECT ${pairVolumeBucketSql(options.interval, 'interval_start')} AS t, toString(sum(volume_usd)) AS v, toString(sum(volume_lo_in_usd)) AS v_lo_in,
       toString(sum(amount_lo)) AS a_lo, toString(sum(amount_hi)) AS a_hi
FROM ${PAIR_VOLUME_5MIN_TABLE} FINAL
WHERE asset_lo = {lo:UInt32} AND asset_hi = {hi:UInt32}
  AND interval_start >= toDateTime({from:UInt32}) AND interval_start < toDateTime({end:UInt32})
GROUP BY t`,
    query_params: { lo, hi, from: options.fromSec, end: tail ? Math.min(readEnd, tail.from) : readEnd },
    format: 'JSONEachRow',
  })
  for (const r of await res.json<VolumeRow>()) add(Number(r.t), r)
  if (tail) {
    for (const r of tail.rows) {
      if (Number(r.asset_lo) !== lo || Number(r.asset_hi) !== hi) continue
      add(pairVolumeBucketStart(options.interval, Number(r.t)), r)
    }
  }
  return out
}

/** A fixed-scale integer as decimal text, trailing fractional zeros trimmed. */
export function scaledText(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}
