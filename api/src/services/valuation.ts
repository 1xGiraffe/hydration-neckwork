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

/**
 * How a value carrying more precision than the requested scale is reduced to it.
 * Named at every call site rather than defaulted per helper: the two answers
 * differ in the last published digit, and which one a surface is on is part of
 * its frozen wire.
 */
export type DecimalRounding = 'truncate' | 'half-up'

/**
 * A decimal string (or ClickHouse number) as an integer count of 10^-scale.
 *
 * The one parser: every fixed-point surface (USD at 1e-12, CoinGecko quantities
 * at 1e-18, percentages at 1e-4, candle closes) reads its decimals through this,
 * so a rounding rule cannot drift between two copies of the same three lines.
 * Empty is 0; anything that is not a decimal throws rather than reading as 0,
 * because a silent 0 is a published number.
 */
export function scaledDecimal(value: string | number | null | undefined, scale: number, rounding: DecimalRounding): bigint {
  const input = String(value ?? '').trim()
  if (!input) return 0n
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(input)
  if (!match) throw new RangeError(`not a decimal: ${input}`)
  const fraction = match[3] ?? ''
  const kept = fraction.slice(0, scale).padEnd(scale, '0')
  // The first dropped digit decides a half-up rounding; truncation ignores it.
  const next = rounding === 'half-up' ? fraction.charCodeAt(scale) : Number.NaN
  const magnitude = BigInt(`${match[2] || '0'}${kept}`) + (next >= 0x35 && next <= 0x39 ? 1n : 0n)
  return match[1] === '-' ? -magnitude : magnitude
}

/** A decimal string (or ClickHouse number) as an integer count of 10^-USD_SCALE. */
export function scaledUsd(value: string | number | null | undefined): bigint {
  return scaledDecimal(value, USD_SCALE, 'truncate')
}

/**
 * A raw on-chain integer amount as a decimal string in token units, trailing
 * fractional zeros dropped.
 *
 * BigInt throughout: an 18-decimal amount passes 2^64 routinely and the 25-digit
 * stableswap share issuances this renders are past a double's 2^53 of exact
 * integers, so any float step would silently round the value. The input must be
 * an integer — a value that already carries a decimal point has been through a
 * scale somewhere and is not a raw amount.
 */
export function formatUnits(raw: string, decimals: number): string {
  const input = (raw ?? '').trim()
  if (!input) return '0'
  if (!/^-?\d+$/.test(input)) throw new RangeError(`not a raw integer amount: ${raw}`)
  const negative = input.startsWith('-')
  const digits = negative ? input.slice(1) : input
  if (decimals <= 0) return `${negative && digits !== '0' ? '-' : ''}${BigInt(digits)}`
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '')
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  const sign = negative && (whole !== '0' || fraction) ? '-' : ''
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`
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
 *
 * `extraColumns` widens the projection for a consumer that needs a column this
 * base set does not carry (`swapper` and `extrinsic_index` for the DexScreener
 * feed, `fee_recipient` for the LP fee APR). Each is folded with the same
 * argMax(…, ingested_at) as the rest, so widening the read never means restating
 * the deduplication.
 */
export function legsCteSql(venuePredicate: string, timePredicate: string = ANCHORED_LEG_WINDOW, extraColumns: string[] = []): string {
  const extra = extraColumns.map(column => `\n           argMax(${column}, ingested_at) AS ${column},`).join('')
  return `legs AS (
    SELECT venue, pool_key, block_height, event_index, leg_kind,${extra}
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

/**
 * A leg's event-time USD value: `amount × close ÷ 10^decimals`, at the 1e-12
 * scale, with 0 standing in for an asset that had no closed candle.
 *
 * The plain decimal OPERATORS, not `multiplyDecimal`/`divideDecimal`. The two
 * forms are the same integer arithmetic — `Decimal256(0) * Decimal256(12)` is a
 * `Decimal256(12)` by scale addition, so the product is exact and never rounded,
 * and dividing it by a `Decimal256(0)` keeps the dividend's scale and truncates
 * toward zero exactly as `divideDecimal(…, 12)` does — but the adaptive-scale
 * functions are a per-row code path where the operators are vectorised, and on
 * this expression that is the difference between 42 and 2.9 CPU-seconds per
 * 2.7 M legs (MEASURED; the 30-day netted-volume query went 48.7 → 9.0).
 *
 * The equality is not an argument, it is a measurement: over 12.2 M legs spanning
 * 2023-01 to the live head, the two forms produced the same Decimal(76,12) type
 * and bit-identical per-leg values (0 mismatches, identical `sum` and identical
 * `sum(cityHash64(toString(usd)))`). Any change here must be re-proved the same
 * way — this value is the input to every published volume, fee and APR figure.
 */
export function pricedCteSql(extraColumns: string[] = [], priceSource: string = priceSourceSql()): string {
  const extra = extraColumns.length ? `${extraColumns.map(c => `l.${c} AS ${c}`).join(', ')}, ` : ''
  return `priced AS (
    SELECT ${extra}l.block_height AS block_height, l.event_index AS event_index, l.leg_kind AS leg_kind,
           l.asset_id AS asset_id,
           toDecimal256(l.amount, 0) * toDecimal256(p.close, 12) / ${amountUnitSql('l.asset_id')} AS usd
    FROM legs l
    ASOF LEFT JOIN ${priceSource} p
      ON p.asset_id = ${priceAliasSql('l.asset_id')} AND p.price_time <= l.block_time
  )`
}
