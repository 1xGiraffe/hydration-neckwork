import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { assetDescriptor } from '../../services/explorerAssets.ts'
import type { OHLCVInterval } from '../../services/ohlcvService.ts'
import { queryOHLCV } from '../../services/ohlcvService.ts'
import type { OHLCVCandle } from '../../types.ts'
import { iso, zAssetId, zBucket, zIsoTimestamp } from '../schemas/common.ts'

// Pair candles. See spec section "Prices" and "Semantics" rule 8.

/**
 * The buckets this route serves: the shared wire enum MINUS `1m`. There is no
 * minute-level candle model (`ohlc_1m_query` is the MONTHLY view), so the bucket is
 * subtracted from the shared enum rather than re-declared here — a second list would
 * be free to drift from the one OpenAPI documents. A request for `1m` is a 400.
 */
const zPriceBucket = zBucket.exclude(['1m'])
type PriceBucket = z.infer<typeof zPriceBucket>

/**
 * The first Monday of the epoch, 1970-01-05T00:00:00Z, as a unix timestamp.
 *
 * The weekly candle model buckets by `toStartOfWeek(block_timestamp, 1)` (mode 1
 * = ISO weeks, Monday), so weekly `interval_start` values are Mondays. Flooring a
 * request to a plain multiple of 604800 would align it to 1970-01-01, a THURSDAY,
 * and no weekly candle ever starts on one: `from == to` returned an empty series
 * for every day of the week, the week containing `from` was dropped on 4 days in
 * 7, and the newest closed candle was missing from Monday to Wednesday. The
 * anchor makes the route's grid the model's grid.
 */
const FIRST_MONDAY = 345_600

/**
 * Each served bucket's candle view, its length in seconds, and the epoch offset
 * its grid is anchored at. Every sub-daily bucket and `1d` divide the day, so
 * ClickHouse's `toStartOf*` grid and a plain multiple of `seconds` agree; only
 * the Monday-aligned week needs an anchor.
 */
const BUCKETS: Record<PriceBucket, { interval: OHLCVInterval; seconds: number; anchor: number }> = {
  '5m': { interval: '5min', seconds: 300, anchor: 0 },
  '15m': { interval: '15min', seconds: 900, anchor: 0 },
  '30m': { interval: '30min', seconds: 1_800, anchor: 0 },
  '1h': { interval: '1h', seconds: 3_600, anchor: 0 },
  '4h': { interval: '4h', seconds: 14_400, anchor: 0 },
  '1d': { interval: '1d', seconds: 86_400, anchor: 0 },
  '1w': { interval: '1w', seconds: 604_800, anchor: FIRST_MONDAY },
}

/** The existing cap on candles per request; a wider window is a 400. */
const MAX_CANDLES = 5_000
/** Candles a request covers when `from` is omitted. */
const DEFAULT_CANDLES = 500

/**
 * Assets whose price IS the dollar, so a pair quoted in one of them is the base
 * asset's own USD series. The shared list lives in services/assetsService.ts, which
 * is outside the public API's import allow-list, so it is restated here.
 *
 * `HUSDT`/`HUSDC` are deliberately NOT on this list even though the shared one has
 * them. The `Hydrated *` tokens are interest-bearing money-market wrappers, not
 * pegs: measured against their own USD candles they went 0.9993 -> 1.0195 (HUSDT)
 * and 0.9992 -> 1.0159 (HUSDC) between 2025-09-22 and 2026-08-12, a ~2 %/yr drift
 * that grows without bound as interest accrues. Treating one as a dollar quoted
 * the pair at the base asset's raw USD price and understated the rate by exactly
 * that accrued interest. Their siblings `HUSDS`/`HUSDe` — same family, same drift —
 * were never on the list, so the list also contradicted itself. All four now take
 * the cross path, where the quote's own close prices the bucket.
 */
const USD_PEGGED_SYMBOLS = new Set(['USDT', 'USDC', 'HOLLAR', 'DAI'])

/** Digits kept on a cross-pair quotient — enough for a ratio of two 12-decimal prices. */
const CROSS_SCALE = 18

const zCandle = z.object({
  // The bucket's OPEN, the conventional candle label.
  timestamp: zIsoTimestamp,
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volumeUsd: z.string(),
})

export interface PairCandle {
  timestamp: string
  open: string
  high: string
  low: string
  close: string
  volumeUsd: string
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/**
 * Plain decimal text for a value in exponent notation, which every parser below
 * would otherwise read as 0 — silently pricing a bucket at nothing. ClickHouse now
 * quotes the Decimal(38,12) candle columns (ohlcvService sets
 * output_format_json_quote_decimals), so this is the guard on the one remaining way
 * an exponent can appear: a JS number, whose own rendering switches to 1e21 / 1e-7
 * at the extremes.
 */
export function expandExponent(text: string): string {
  const match = /^(-?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text)
  if (!match) return text
  const [, sign, whole, fraction = '', exponent] = match
  const digits = `${whole || '0'}${fraction}`
  const point = (whole || '0').length + Number(exponent)
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** The candle model's Decimal(38,12) columns as plain decimal text. */
function decimalText(value: string | number | null | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? expandExponent(String(value)) : '0'
  return expandExponent(String(value ?? '').trim())
}

/** A decimal string as an integer count of 10^-scale, without touching a float. */
function scaled(value: string | number, scale: number): bigint {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(decimalText(value))
  if (!match) return 0n
  const fraction = (match[3] ?? '').slice(0, scale).padEnd(scale, '0')
  const magnitude = BigInt(`${match[2] || '0'}${fraction}`)
  return match[1] === '-' ? -magnitude : magnitude
}

/** The same value with no trailing fractional zeros, so 4.500000000000 reads 4.5. */
export function trimDecimal(value: string | number): string {
  const input = decimalText(value)
  if (!/^-?\d*(\.\d*)?$/.test(input) || input === '') return input
  if (!input.includes('.')) return input || '0'
  const trimmed = input.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' || trimmed === '-' ? '0' : trimmed
}

/** An integer count of 10^-scale rendered back as a decimal string. */
function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale)
  return trimDecimal(`${negative ? '-' : ''}${whole}.${fraction}`)
}

const candleTimestamp = (candle: OHLCVCandle) => iso(candle.interval_start)

/**
 * The pair's candles when the quote asset does NOT carry its own USD feed: the two
 * USD series combined per field, each field against the quote field that makes it
 * true. There is no per-block ratio here — that query is O(blocks in the window)
 * and measured 6.8x–20x the wall time and 8x–192x the memory of these two
 * pre-aggregate reads, so this composes the same two candles the USD path already
 * reads.
 *
 * POINTS are quoted against the quote's matching point, which is the same instant:
 * `open` is each series' FIRST observation in the bucket and `close` its LAST, and
 * both assets are priced from the same blocks, so `bOpen/qOpen` and `bClose/qClose`
 * are the real rate — measured against the exact per-block ratio at 2.0e-16-2.7e-16,
 * i.e. exact to the published scale. (The one way this is approximate: on a bucket
 * where the two legs' first or last priced block differs, the quotient spans those
 * two instants. Measured 0 of 200 hourly buckets and 1 of 200 daily — 2026-07-06,
 * where HDX's last row is block 13,029,394 and DOT's is 13,029,480, giving a 1.5 %
 * gap. Detecting it needs the per-block join this function exists to avoid.)
 *
 * The RANGE is a conservative ENVELOPE, not an estimate: `high = bHigh/qLow` and
 * `low = bLow/qHigh` are the widest rates the two independent series admit, so the
 * band is GUARANTEED to contain every rate the pair actually traded at — measured
 * over 1,800 live buckets against the exact per-block band, the only two apparent
 * misses are the reference's own float64 rounding (3e-17 relative, 5.8e-14
 * absolute), so containment is 100 % to the precision the comparison can resolve.
 * It replaces `bHigh/qClose` and
 * `bLow/qClose`, which priced a range at a single instant and so produced a band
 * that was DISPLACED rather than wide: it contained the traded extremes in only
 * 0-78 % of buckets, and for HOLLAR/DOT — where HOLLAR's own hourly high and low
 * are equal at 12 decimals — it collapsed to a single point that essentially never
 * did. The cost is one-directional and documented on the route: the envelope
 * overstates the width, measured 1.0x-2.3x at 5m-4h and ~7.6x at 1d.
 *
 * The envelope necessarily contains the two points as well (`bHigh >= bOpen` and
 * `qLow <= qOpen` give `high >= open`, and symmetrically for `low`), so
 * `low <= open, close <= high` holds by construction — verified on 1,800 live
 * candles, 0 violations.
 *
 * Volume stays the base asset's USD volume — it is a dollar figure, not a pair one.
 *
 * A bucket the quote asset has no candle for, or whose quote LOW is not positive, is
 * DROPPED: there is no rate to quote the pair at, and carrying an older candle
 * forward would price a bucket at a rate that was not observed in it. The low is the
 * right guard because it is the smallest of the quote's four values, so a positive
 * low makes all four divisors positive.
 */
export function crossCandles(base: OHLCVCandle[], quote: OHLCVCandle[]): PairCandle[] {
  const quotes = new Map<string, OHLCVCandle>()
  for (const candle of quote) quotes.set(candle.interval_start, candle)
  const out: PairCandle[] = []
  for (const candle of base) {
    const counterpart = quotes.get(candle.interval_start)
    if (counterpart == null) continue
    const quoteLow = scaled(counterpart.low, CROSS_SCALE)
    if (quoteLow <= 0n) continue
    // Numerator pre-scaled by CROSS_SCALE so the integer division yields a
    // CROSS_SCALE-digit quotient — no float ever touches a price.
    const divide = (value: string, divisor: bigint) =>
      fromScaled((scaled(value, CROSS_SCALE) * 10n ** BigInt(CROSS_SCALE)) / divisor, CROSS_SCALE)
    out.push({
      timestamp: candleTimestamp(candle),
      open: divide(candle.open, scaled(counterpart.open, CROSS_SCALE)),
      high: divide(candle.high, quoteLow),
      low: divide(candle.low, scaled(counterpart.high, CROSS_SCALE)),
      close: divide(candle.close, scaled(counterpart.close, CROSS_SCALE)),
      volumeUsd: trimDecimal(candle.volume_total),
    })
  }
  return out
}

/** The USD-quoted candles, passed through as the exact decimal strings they are. */
function usdCandles(base: OHLCVCandle[]): PairCandle[] {
  return base.map(candle => ({
    timestamp: candleTimestamp(candle),
    open: trimDecimal(candle.open),
    high: trimDecimal(candle.high),
    low: trimDecimal(candle.low),
    close: trimDecimal(candle.close),
    volumeUsd: trimDecimal(candle.volume_total),
  }))
}

export const pricesRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/prices/pair', {
    schema: {
      tags: ['prices'],
      summary: 'OHLCV candles for one pair',
      description: [
        'ORIENTATION: the price is `assetIn` quoted in `assetOut` — how much assetOut one assetIn buys — matching the UI\'s pair orientation. `assetIn` and `assetOut` must differ: an asset\'s price in itself is 1, not a series, and the endpoint answers markets.',
        '`referenceAsset` is `usd` when assetOut is a USD-pegged token (USDT, USDC, HOLLAR, DAI), because the candle model is USD-denominated and that IS the pair. **USD-quoted pairs are the asset\'s own candles, unmodified — everything in the next paragraph is about cross pairs only.** Otherwise `referenceAsset` is assetOut\'s registry id and the candles are the cross rate, composed from the two assets\' USD candles. The interest-bearing `Hydrated *` wrappers (HUSDT, HUSDC, HUSDS, HUSDe) are NOT dollars — they accrue about 2 %/yr away from par — so they quote through the cross path like any other asset. A bucket the quote asset has no candle for is omitted rather than priced at an older rate.',
        'CROSS-PAIR ACCURACY, and the ONE thing to know before computing volatility from it: `open` and `close` are exact rates, `high` and `low` are a conservative ENVELOPE. `open` is assetIn\'s open over assetOut\'s open and `close` is close over close — each series\' first and last observation in the bucket, which is the same instant for both legs, so these are the real rate (measured against an exact per-block ratio: agreement to 2.7e-16, the published scale). `high` is assetIn\'s high over assetOut\'s LOW and `low` is assetIn\'s low over assetOut\'s HIGH: the widest rates the two independent series admit. That band is GUARANTEED to contain every rate the pair traded at in the bucket (verified on 1,800 live buckets against an exact per-block reference: 100 %, the only apparent misses being that reference\'s own float64 rounding at 3e-17 relative) but it OVERSTATES the width — measured 1.0x-2.3x at 5m-4h and about 7.6x at 1d, and by an unbounded factor on a pair whose ratio is near-constant (a peg-tracking pair such as GDOT/DOT has a true intra-hour range of ~0 while the envelope inherits both legs\' independent USD noise, median 0.56 % at 1h). So `high - low` is an UPPER BOUND on realised range, never an underestimate: the bias has one direction. Use `close` for a return series. An exact per-block high/low is not served because that query is O(blocks in the window) rather than O(candles), measured at 6.8x-20x the wall time and 8x-192x the memory of the two pre-aggregate reads this composes.',
        `\`timestamp\` is the bucket's OPEN, on the candle model's own grid: sub-daily buckets and \`1d\` are UTC-aligned, and \`1w\` is the ISO week, starting MONDAY 00:00 UTC. \`from\` and \`to\` are floored onto that grid, so the bucket containing each is the one you get (the sole exception is a \`1w\` bound inside 1970-01-01…04, which moves up to the epoch's first Monday). Only buckets that have fully closed are returned, so the series never ends on a partial candle (AGENTS.md). The window defaults to the most recent ${DEFAULT_CANDLES} buckets.`,
        `At most ${MAX_CANDLES} candles per request — a wider window is a 400, never a silently truncated series. The count is measured on the window actually READ, i.e. after \`to\` is clamped to the last closed bucket: passing a \`to\` far in the future is not a 400, it just reads up to now, and a window lying entirely beyond the last closed bucket reads nothing at all and returns empty \`items\` without reaching the cap.`,
        'A window that lies entirely after the last closed bucket (a future `from`, or a `from`/`to` pinned to the bucket still in progress) is answered with empty `items`, the same as a window before the asset was listed. Only a caller-inverted window is a 400 — and that test is on the timestamps you sent, not on the buckets they fall in, so swapping two same-day bounds is refused rather than silently read as one bucket.',
        'There is no minute-level candle model, so `bucket=1m` is rejected rather than rounded up to 5 minutes.',
        'PRECISION: the candle model stores Decimal(38,12), and the database client requests quoted decimals so no value passes through a JSON double. Cross-rate division is integer arithmetic on that exact decimal text.',
      ].join('\n\n'),
      querystring: z.object({
        assetIn: zAssetId,
        assetOut: zAssetId,
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        bucket: zPriceBucket.default('1h'),
      }),
      response: {
        200: z.object({
          referenceAsset: z.string(),
          items: z.array(zCandle),
        }),
      },
    },
  }, async request => {
    const { assetIn, assetOut, bucket } = request.query
    const { interval, seconds, anchor } = BUCKETS[bucket]
    // The start of the bucket a moment falls in, on the candle model's own grid.
    // Clamped at the anchor so the weekly grid cannot address a pre-epoch Monday,
    // which ClickHouse's DateTime cannot represent. The clamp is the one input that
    // does NOT land on the bucket containing it: a weekly bound in 1970-01-01…04
    // moves UP to 1970-01-05. Benign — the model's first candle is 2023 — and the
    // alternative is a negative DateTime the database rejects.
    const floor = (ms: number) => Math.max(Math.floor((ms / 1000 - anchor) / seconds) * seconds + anchor, anchor)

    const baseId = Number(assetIn)
    const quoteId = Number(assetOut)
    // An asset's price in itself is 1 by definition, never a series. Answering it
    // from the model divided the asset's USD OHLC by its own bucket close, which
    // returns the bucket's price DRIFT (measured HDX/HDX at 1d: open 0.9589, high
    // 1.0162) dressed up as a market rate. There is no market, so there is no
    // answer to give.
    if (baseId === quoteId) throw badRequest('assetIn and assetOut must be different assets')

    const parsedFrom = request.query.from == null ? null : Date.parse(request.query.from)
    const parsedTo = request.query.to == null ? null : Date.parse(request.query.to)
    if ((parsedFrom ?? 0) < 0 || (parsedTo ?? 0) < 0) throw badRequest('timestamps before 1970-01-01 are not supported')

    // A window the caller inverted is a bad request. A window that merely lies
    // after the last closed bucket is a fine request with nothing closed in it yet
    // — the same honest-empty answer a pre-listing window gets, not an error
    // claiming `from` is later than a `to` the caller never sent.
    //
    // The test is on the RAW instants, not the floored ones. Flooring first hid
    // every inversion that lands inside one bucket — `bucket=1d` with
    // from=…T20:00Z, to=…T04:00Z on one day floored to the same midnight and
    // answered 200 — so the published rule ("from later than a to you actually
    // sent is a 400") was false for exactly the inversions a caller is most likely
    // to make by swapping two same-day timestamps.
    if (parsedFrom != null && parsedTo != null && parsedFrom > parsedTo) {
      throw badRequest('from must be earlier than to')
    }
    const requestedFrom = parsedFrom == null ? null : floor(parsedFrom)
    const requestedTo = parsedTo == null ? null : floor(parsedTo)

    // `to` never exceeds the last CLOSED bucket's start, and the read window ends
    // there, so an in-progress bucket cannot enter the series at all.
    const lastClosedStart = floor(Date.now()) - seconds
    const toSeconds = Math.min(requestedTo ?? lastClosedStart, lastClosedStart)
    const fromSeconds = requestedFrom ?? toSeconds - (DEFAULT_CANDLES - 1) * seconds
    const quoteIsUsd = USD_PEGGED_SYMBOLS.has(assetDescriptor(quoteId).symbol.toUpperCase())
    // The registry id, not the caller's spelling of it: `assetOut=007` must not
    // publish a `referenceAsset` no other endpoint answers to.
    const referenceAsset = quoteIsUsd ? 'usd' : String(quoteId)
    if (fromSeconds > toSeconds) return { referenceAsset, items: [] }

    const points = Math.floor((toSeconds - fromSeconds) / seconds) + 1
    if (points > MAX_CANDLES) {
      throw badRequest(`the requested window is ${points} ${bucket} candles; at most ${MAX_CANDLES} are served per request`)
    }

    const key = `pub:prices-pair:${baseId}:${quoteId}:${bucket}:${fromSeconds}-${toSeconds}`
    return cached(key, 5_000, async () => {
      const window = { startTime: new Date(fromSeconds * 1000), endTime: new Date(toSeconds * 1000), interval }
      const [base, quote] = await Promise.all([
        queryOHLCV(opts.client, { assetId: baseId, ...window }),
        quoteIsUsd ? Promise.resolve<OHLCVCandle[]>([]) : queryOHLCV(opts.client, { assetId: quoteId, ...window }),
      ])
      // The view's window is inclusive of `end_time`, and a replayed head could
      // still hand back a bucket that has not closed; drop it here too so the
      // closed-candle rule holds whatever the model returns.
      const closed = base.filter(candle => Date.parse(`${candle.interval_start.replace(' ', 'T')}Z`) / 1000 + seconds <= Math.floor(Date.now() / 1000))
      return {
        referenceAsset,
        items: quoteIsUsd ? usdCandles(closed) : crossCandles(closed, quote),
      }
    })
  })
}
