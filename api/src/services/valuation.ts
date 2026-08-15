// Venue-neutral money and event-time valuation helpers shared by the public
// pool surfaces (public/services/poolVolumes.ts re-exports everything here so
// its consumers keep one import site) and the revenue read models
// (services/revenueStreams.ts). Moved out of the public tree because the
// public API is an import LEAF (api/tests/public/isolation.test.ts): shared
// code lives outside it and is allow-listed into it, never the reverse.
//
// The rules these helpers encode are the house valuation rules:
//  * USD is an integer count of 1e-12 USD end to end; the only float conversion
//    happens at a wire boundary, once.
//  * A flow is valued at the last 1h candle that had already CLOSED when it
//    happened (`interval_start + 1 HOUR <= block_timestamp`); the fill's own
//    hour is a future price and is never used.
//  * `pool_swap_legs` is ReplacingMergeTree — every reader collapses the leg
//    identity (the table's ORDER BY) BEFORE summing.

import { PRICE_ALIAS_ID, allExplorerAssets, priceAssetId } from './explorerAssets.ts'

/**
 * The Omnipool's own pallet account, `modl` + `omnipool` — the fee recipient that
 * means "the fee stayed in the pool", i.e. the liquidity providers' share.
 *
 * The Omnipool splits its asset fee across recipients and emits ONE FEE LEG PER
 * RECIPIENT, so who received a fee is a `fee_recipient` question and not a
 * `fee_dest` one: `fee_dest` only tells burned from routed-to-an-account. Measured
 * over the whole projection, the non-hub recipients are this account (5.01 M legs,
 * 2025-01-25 →), staking (2.34 M) and referrals (2.33 M) until 2026-06-22, and the
 * fee processor (336 k) that replaced both from 2026-06-22 — so roughly half of a
 * non-burned asset fee never reaches an LP.
 *
 * Legs before 2025-01-25 (2.26 M of them) carry an EMPTY recipient: the legacy
 * per-pallet projections have nothing to read. Surfaces that need the LP share
 * decide per surface how to treat that unknown, and say so where they do.
 */
export const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'

/**
 * How far before the window an asset's last candle may sit and still price its
 * legs. Past this the asset is treated as unpriced (contributing 0) rather than
 * valued at an arbitrarily old close — the same staleness bound the account
 * valuation applies, and the reason the price join stays a bounded read.
 */
export const PRICE_LOOKBACK_DAYS = 30

// USD is carried as an integer count of 1e-12 USD — the exact scale of the
// Decimal(38,12) columns the queries return, so every sum and comparison below
// happens at full precision and no JavaScript float ever touches money. The
// single rounding to the wire's 2 decimals happens once, in renderUsd.
const USD_SCALE = 12
const USD_UNIT = 10n ** BigInt(USD_SCALE)

/** A decimal string (or ClickHouse number) as an integer count of 10^-USD_SCALE. */
export function scaledUsd(value: string | number | null | undefined): bigint {
  const input = String(value ?? '').trim()
  if (!input) return 0n
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(input)
  if (!match) throw new RangeError(`not a decimal USD value: ${input}`)
  const fraction = (match[3] ?? '').slice(0, USD_SCALE).padEnd(USD_SCALE, '0')
  const magnitude = BigInt(`${match[2] || '0'}${fraction}`)
  return match[1] === '-' ? -magnitude : magnitude
}

/**
 * The wire form of a USD value: 2 decimals, rounded half-up (spec § Wire
 * conventions). Every `*Usd` field on the public surface carries this shape,
 * matching formatUsd in accountBalances.ts — the accounts and pool surfaces must
 * not publish the same kind of number in two different precisions.
 *
 * This is the ONLY rounding on the path: callers accumulate at the full 1e-12
 * scale and render once, so a sum of thousands of legs is not a sum of thousands
 * of already-rounded cents.
 */
export function renderUsd(scaled: bigint): string {
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const cents = (magnitude * 100n + USD_UNIT / 2n) / USD_UNIT
  const whole = cents / 100n
  const fraction = (cents % 100n).toString().padStart(2, '0')
  return `${negative && cents > 0n ? '-' : ''}${whole}.${fraction}`
}

/** A Decimal(38,12) column as it goes on the wire. */
export function usdString(value: string | number | null | undefined): string {
  return renderUsd(scaledUsd(value))
}

/**
 * A routed trade's single-counted value: the larger of what entered and what left
 * across the route's boundary assets (spec § Semantics 2, the
 * `account_trade_volume` netting rule). The two sides differ by fees and
 * slippage, and a multi-hop route's intermediate assets have already cancelled in
 * the per-asset net, so taking the max counts the trade exactly once.
 *
 * It answers at the full 1e-12 scale, not as a wire string: the caller sums
 * hundreds of thousands of these, and rounding each one to cents first would move
 * the platform total by the accumulated rounding error.
 */
export function nettedTradeScaled(inUsd: string, outUsd: string): bigint {
  const a = scaledUsd(inUsd)
  const b = scaledUsd(outUsd)
  return a > b ? a : b
}

/** Decimal columns arrive quoted, so a 38-digit value never passes through a double. */
export const DECIMAL_STRINGS = { output_format_json_quote_decimals: 1 } as const

// ---------------------------------------------------------------------------
// SQL fragments
// ---------------------------------------------------------------------------

/** asset id → 10^decimals, the divisor that turns a raw amount into token units. */
export function amountUnitSql(expr: string): string {
  const assets = allExplorerAssets()
  const ids = assets.map(a => a.assetId)
  const units = assets.map(a => `'${10n ** BigInt(a.decimals)}'`)
  // 12 decimals is the chain's most common scale and the registry's own default
  // for an asset this snapshot has not seen yet.
  return `toDecimal256(transform(toUInt32(${expr}), [${ids.join(',') || '0'}], [${units.join(',') || "'1'"}], '${10n ** 12n}'), 0)`
}

/**
 * asset id → the id whose ohlc feed prices it. aTokens price through their
 * reserve asset and pool-share tokens through their main underlying: unlike
 * accountTradeVolume.ts, share tokens are aliased here too, because their own
 * feeds are all but empty (2-Pool-GDOT has six candles, from April 2025) while
 * they appear as trade legs thousands of times a day, and leaving them unaliased
 * reports those fills as zero volume.
 */
export function priceAliasSql(expr: string): string {
  const from = Object.keys(PRICE_ALIAS_ID).map(Number).filter(id => priceAssetId(id) !== id)
  const to = from.map(id => priceAssetId(id))
  if (!from.length) return `toUInt32(${expr})`
  return `transform(toUInt32(${expr}), [${from.join(',')}], [${to.join(',')}], toUInt32(${expr}))`
}

/** Every asset id that can carry or supply a price, for the price join's key filter. */
function priceIdUniverse(): string {
  const ids = new Set<number>()
  for (const a of allExplorerAssets()) { ids.add(a.assetId); ids.add(priceAssetId(a.assetId)) }
  return [...ids].join(',') || '0'
}

/**
 * The rolling window every anchored surface reads: the last {hours} before the
 * anchor, half-open at the bottom so consecutive windows cannot both claim a
 * boundary block. The DefiLlama backfill passes an explicit calendar range
 * instead (see `public/services/defillama.ts`), which is why the predicate is a
 * parameter of the two CTE builders rather than baked into them.
 */
export const ANCHORED_LEG_WINDOW = `block_timestamp > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR
      AND block_timestamp <= {anchor:DateTime}`

/** The candle window that covers ANCHORED_LEG_WINDOW plus its staleness lookback. */
export const ANCHORED_PRICE_WINDOW = `interval_start > {anchor:DateTime} - INTERVAL {hours:UInt32} HOUR - INTERVAL ${PRICE_LOOKBACK_DAYS} DAY
        AND interval_start <= {anchor:DateTime}`

/**
 * The closed 1h closes available inside the window, keyed by the hour they became
 * usable (`interval_start + 1 HOUR`), so an ASOF join on `price_time <=
 * block_timestamp` picks the newest price that already existed at the fill.
 */
export function priceSourceSql(windowPredicate: string = ANCHORED_PRICE_WINDOW): string {
  return `(
      SELECT asset_id, interval_start + INTERVAL 1 HOUR AS price_time, argMaxMerge(close_state) AS close
      FROM price_data.ohlc_1h
      WHERE asset_id IN (${priceIdUniverse()})
        AND ${windowPredicate}
      GROUP BY asset_id, interval_start
    )`
}

/**
 * The window's legs, one row per leg identity. The GROUP BY is the destination
 * table's ORDER BY: the replacement key of a ReplacingMergeTree, collapsed here so
 * a replayed range cannot contribute a leg twice.
 */
export function legsCteSql(venuePredicate: string, timePredicate: string = ANCHORED_LEG_WINDOW): string {
  return `legs AS (
    SELECT venue, pool_key, block_height, event_index, leg_kind,
           argMax(asset_id, ingested_at) AS asset_id,
           argMax(amount, ingested_at) AS amount,
           argMax(fee_dest, ingested_at) AS fee_dest,
           argMax(op_key, ingested_at) AS op_key,
           min(block_timestamp) AS block_time
    FROM price_data.pool_swap_legs
    WHERE ${venuePredicate}
      AND ${timePredicate}
    GROUP BY venue, pool_key, block_height, event_index, leg_kind, leg_index
  )`
}

/** Each leg with its event-time USD value; 0 when the asset had no closed candle. */
export function pricedCteSql(extraColumns: string[] = [], priceSource: string = priceSourceSql()): string {
  const extra = extraColumns.length ? `${extraColumns.map(c => `l.${c} AS ${c}`).join(', ')}, ` : ''
  return `priced AS (
    SELECT ${extra}l.block_height AS block_height, l.event_index AS event_index, l.leg_kind AS leg_kind,
           l.asset_id AS asset_id,
           divideDecimal(multiplyDecimal(toDecimal256(l.amount, 0), toDecimal256(p.close, 12), 12), ${amountUnitSql('l.asset_id')}, 12) AS usd
    FROM legs l
    ASOF LEFT JOIN ${priceSource} p
      ON p.asset_id = ${priceAliasSql('l.asset_id')} AND p.price_time <= l.block_time
  )`
}
