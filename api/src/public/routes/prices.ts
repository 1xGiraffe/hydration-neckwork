import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { ATOKEN_UNDERLYING_ID, assetDescriptor } from '../../services/explorerAssets.ts'
import type { OHLCVInterval } from '../../services/ohlcvService.ts'
import { queryOHLCV } from '../../services/ohlcvService.ts'
import { CROSS_SCALE, CrossWindowTooWideError, queryCrossPairCandles, type CrossCandle } from '../../services/crossPair.ts'
import type { OHLCVCandle } from '../../types.ts'
import { iso, zAssetId, zBucket, zIsoTimestamp } from '../schemas/common.ts'
import { KRAKEN_PAIRS, ONE_CLICK_PLATFORMS, loadForeignCandles, platformForOneClickAsset, type ForeignCandle } from '../../services/foreignCandles.ts'

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
 * is outside the public API's import allow-list, so it is restated here — and the
 * two must agree, which tests/public/prices.test.ts pins.
 *
 * Membership is earned by holding par tightly enough that substituting the dollar
 * is below the noise of the series, because this branch publishes the BASE asset's
 * raw USD candles: whatever the quote is worth other than $1 becomes a silent,
 * one-directional error in every rate it quotes. USDT and USDC clear that bar
 * (0.0039 %-0.0345 % across their five listed ids, measured 2026-09-17).
 *
 * `HOLLAR` and `DAI` do not, and are quoted through the cross path instead. HOLLAR
 * is protocol-minted and floats on its own stablepools — 0.9983 on 2026-09-17, so
 * a HOLLAR-quoted pair read 0.172 % low, drifting 0.05 % over 26 h — and DAI is an
 * outside peg this project does not defend. `HUSDT`/`HUSDC`/`HUSDS`/`HUSDe` fail the
 * bar by construction: interest-bearing money-market wrappers whose price leaves par
 * and keeps going (0.9993 -> 1.0195 and 0.9992 -> 1.0159 between 2025-09-22 and
 * 2026-08-12, ~2 %/yr, unbounded).
 *
 * Crossing costs history rather than accuracy: a cross bucket needs BOTH legs, so a
 * quote drops every bucket it predates (HOLLAR's first candle is 2025-09-22) or is
 * missing. Nothing can recover those — there was no quote price to divide by — and
 * the alternative is publishing a rate nobody could have traded at.
 */
const USD_PEGGED_SYMBOLS = new Set(['USDT', 'USDC'])


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
 * A shared cross candle on this route's wire. Both carry exact decimal text, so
 * this only renames fields and drops the per-side volumes the pair wire has never
 * published — `volumeUsd` is the base asset's dollar volume, not a pair figure.
 */
function crossToPairCandle(row: CrossCandle): PairCandle {
  return {
    timestamp: new Date(row.intervalStart * 1000).toISOString(),
    open: trimDecimal(row.open),
    high: trimDecimal(row.high),
    low: trimDecimal(row.low),
    close: trimDecimal(row.close),
    volumeUsd: trimDecimal(row.volumeTotal),
  }
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


// ---------------------------------------------------------------------------
// Cross-chain pair candles
// ---------------------------------------------------------------------------

/** The base leg's USD bucket, as the cross-chain fold reads it. */
export interface CrossChainBase { time: number; close: string; high: string; low: string }

/** A USD-pegged base has no series of its own: every one of its values is 1. */
const USD_BASE: CrossChainBase = { time: 0, close: '1', high: '1', low: '1' }

/**
 * The Hydration asset's USD bucket at or BEFORE a moment — never after it.
 *
 * The two series are independent: Hydration's buckets are the candle model's, the
 * destination's are Kraken's, and neither is a subset of the other. Scaling a
 * foreign candle by the Hydration bucket that CONTAINS or precedes it keeps the
 * rule the rest of the price model follows (a bucket is priced by what had closed
 * by its boundary, never by a future price). A foreign candle older than the
 * first Hydration close has no price to scale by at all and is dropped — carrying
 * the oldest close backwards would invent history.
 *
 * BOTH legs' ranges enter `high`/`low`, which is what makes them the upper bound
 * the endpoint documents: pricing the base at a single close would report an
 * envelope narrower than the two series admit, and a narrower range on a pair is
 * an underestimate, not a conservative one. `open`/`close` stay on the base's
 * close, the one value the "at or before" rule makes exact at a boundary.
 */
export function crossChainCandles(
  foreign: readonly ForeignCandle[],
  hydration: readonly CrossChainBase[],
  scale: number,
  baseIsUsd: boolean,
): PairCandle[] {
  const out: PairCandle[] = []
  if (!foreign.length) return out
  if (!baseIsUsd && !hydration.length) return out
  const ordered = [...foreign].sort((a, b) => a.time - b.time)
  const first = hydration[0]
  let cursor = 0
  let base: CrossChainBase = baseIsUsd ? USD_BASE : first!
  for (const candle of ordered) {
    while (cursor < hydration.length && hydration[cursor]!.time <= candle.time) {
      base = hydration[cursor]!
      cursor++
    }
    if (!baseIsUsd && candle.time < first!.time) continue
    const baseClose = scaled(base.close, scale)
    if (baseClose <= 0n) continue
    // A base bucket that carries no usable extreme falls back to its close, which
    // is the pre-range behaviour and never widens the envelope the wrong way.
    const baseHigh = scaled(base.high, scale) > baseClose ? scaled(base.high, scale) : baseClose
    const baseLowRaw = scaled(base.low, scale)
    const baseLow = baseLowRaw > 0n && baseLowRaw < baseClose ? baseLowRaw : baseClose
    // assetIn quoted in the destination asset: how much of the destination one
    // unit of assetIn buys, i.e. usd(base) / usd(destination). Integer division
    // on the same scale both legs were lifted to, so nothing passes through a
    // float.
    const rate = (numerator: bigint, field: string): string | null => {
      const quote = scaled(field, scale)
      if (quote <= 0n) return null
      return fromScaled((numerator * BigInt(10) ** BigInt(scale)) / quote, scale)
    }
    // `high` of the pair is the base's best against the destination's WORST, so
    // the base's HIGH over the destination's LOW. An envelope is all this pair can
    // be: the destination's candles come from another venue on its own grid, so
    // there is no shared instant to pair the two legs at. The on-chain cross pair
    // does have one and states the real range instead (services/crossPair.ts).
    const open = rate(baseClose, candle.open), high = rate(baseHigh, candle.low)
    const low = rate(baseLow, candle.high), close = rate(baseClose, candle.close)
    if (open == null || high == null || low == null || close == null) continue
    out.push({ timestamp: iso(new Date(candle.time * 1000)), open, high, low, close, volumeUsd: '0' })
  }
  return out
}

export const pricesRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/prices/pair', {
    schema: {
      tags: ['prices'],
      summary: 'OHLCV candles for one pair',
      description: [
        'ORIENTATION: the price is `assetIn` quoted in `assetOut` — how much assetOut one assetIn buys — matching the UI\'s pair orientation. `assetIn` and `assetOut` must differ: an asset\'s price in itself is 1, not a series, and the endpoint answers markets.',
        '`referenceAsset` is `usd` when assetOut is a USD-pegged token (USDT, USDC), because the candle model is USD-denominated and that IS the pair. **USD-quoted pairs are the asset\'s own candles, unmodified — everything in the next paragraph is about cross pairs only.** Otherwise `referenceAsset` is assetOut\'s registry id and the candles are the cross rate, composed from the two assets\' USD candles. Only a quote that holds par tightly enough for the substitution to sit below the series\' own noise qualifies: HOLLAR floats on its own stablepools (0.9983 on 2026-09-17, so quoting it as a dollar read 0.172 % low), DAI is an outside peg, and the interest-bearing `Hydrated *` wrappers (HUSDT, HUSDC, HUSDS, HUSDe) accrue about 2 %/yr away from par — all of them quote through the cross path like any other asset. A bucket the quote asset has no candle for is omitted rather than priced at an older rate, so a cross series starts no earlier than the quote asset\'s own first candle.',
        'CROSS-PAIR ACCURACY: every field is the pair\'s OWN rate. `open`, `high`, `low` and `close` are the first, largest, smallest and last value of the ratio taken per BLOCK, with both legs read at the same block — so `high` and `low` are rates that were really quoted, and `high - low` is the realised range rather than a bound on it. Composing them from the two assets\' stored candles instead cannot do this: those aggregate each asset separately, so `max(base)/min(quote)` pairs observations from different moments and only ever widens the candle — by an unbounded factor on a pair whose ratio is near-constant (BIL quoted in HOLLAR measured a 0.0134 % hourly wick against a true range of zero). `volumeUsd` stays the base asset\'s dollar volume, not a pair figure.',
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
      // A cross rate is the per-block ratio aggregated, never the two assets'
      // stored candles divided: min and max do not survive division, so the stored
      // form can only bound the rate, not state it (see services/crossPair.ts).
      if (!quoteIsUsd) {
        const rows = await queryCrossPairCandles(opts.client, {
          baseId,
          quoteId,
          startTime: new Date(fromSeconds * 1000),
          // `toSeconds` names the last closed bucket's START; the cross window is a
          // half-open span of instants, so it has to reach that bucket's CLOSE for
          // the bucket to be in it at all.
          endTime: new Date((toSeconds + seconds) * 1000),
          interval,
        }).catch((error: unknown) => {
          if (error instanceof CrossWindowTooWideError) throw badRequest(error.message)
          throw error
        })
        return { referenceAsset, items: rows.map(crossToPairCandle) }
      }
      const base = await queryOHLCV(opts.client, {
        assetId: baseId, startTime: new Date(fromSeconds * 1000), endTime: new Date(toSeconds * 1000), interval,
      })
      // The view's window is inclusive of `end_time`, and a replayed head could
      // still hand back a bucket that has not closed; drop it here too so the
      // closed-candle rule holds whatever the model returns.
      const closed = base.filter(candle => Date.parse(`${candle.interval_start.replace(' ', 'T')}Z`) / 1000 + seconds <= Math.floor(Date.now() / 1000))
      return { referenceAsset, items: usdCandles(closed) }
    })
  })

  app.get('/v1/prices/cross-chain-pair', {
    schema: {
      tags: ['prices'],
      summary: 'Reference candles for a cross-chain swap pair',
      description: [
        'Candles for a pair whose destination does NOT trade on Hydration — the assets a cross-chain swap delivers on their own chains (NEAR, Zcash). There is no native pair data for these and never will be, so this composes two independent USD series: the Hydration asset\'s own candles, and the destination\'s from a venue that does list it.',
        `ORIENTATION matches GET /v1/prices/pair: the price is \`assetIn\` quoted in the destination — how much of the destination asset one \`assetIn\` buys. The Hydration UI's cross-chain chart uses the INVERSE convention (how much assetIn one destination unit costs), so a client reproducing that chart inverts these candles.`,
        `REFERENCE PRICE, NOT AN EXECUTED ONE. \`referenceSource\` names the venue the destination leg is priced from (\`kraken\`, pair \`${Object.values(KRAKEN_PAIRS).join('\`/\`')}\`). A cross-chain swap's realised rate is a property of the order itself — the solver network's fill, plus both bridge rails' fees — and is typically several percent away from this. Do not present these candles as what a swap would get.`,
        `\`destinationAsset\` is a 1Click asset id and must be one this deployment can price: ${Object.keys(ONE_CLICK_PLATFORMS).map(id => `\`${id}\``).join(', ')}. Anything else is a 400 rather than being priced off an adjacent market.`,
        'WINDOW: the destination venue serves a fixed recent tail per interval (roughly 720 candles) and takes no start bound, so the series begins where that tail begins — `from` narrows it but cannot extend it. Buckets older than the Hydration asset\'s first candle are dropped rather than scaled by a price that did not exist yet.',
        '`open`/`close` are rates taken from each leg at the ends of the bucket; `high`/`low` are the conservative envelope the two independent series admit — the Hydration leg\'s high over the destination\'s low, and its low over the destination\'s high. Unlike the on-chain pair route, this one cannot do better: the destination trades on another venue with its own bucket grid, so the two legs share no instant to be paired at. Both legs\' ranges enter, so the envelope is an upper bound on realised range, never an underestimate. `volumeUsd` is always `"0"`: the two legs\' volumes are on different venues and summing them would describe no market.',
        'Each Hydration bucket is priced by the close that had already happened at or before it — never a future price (AGENTS.md).',
        'A money-market aToken `assetIn` is priced through its reserve, which is 1:1 with it and is what carries the candles (aUSDC is USDC). `pricedAsset` reports which asset the base leg was read from, so the substitution is visible rather than silent.',
      ].join('\n\n'),
      querystring: z.object({
        assetIn: zAssetId,
        destinationAsset: z.string().min(3).max(128).describe('1Click asset id of the destination, e.g. nep141:wrap.near.'),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        bucket: zPriceBucket.default('1h'),
      }),
      response: {
        200: z.object({
          referenceAsset: z.string().describe('The 1Click asset id the candles are quoted in.'),
          referenceSource: z.string().describe('The venue the destination leg is priced from.'),
          pricedAsset: zAssetId.describe('The Hydration asset the base leg was actually priced from. Differs from `assetIn` when it is a money-market aToken, which is 1:1 with its reserve and has no candles of its own.'),
          items: z.array(zCandle),
        }),
      },
    },
  }, async request => {
    const { assetIn, destinationAsset, bucket } = request.query
    const { interval, seconds, anchor } = BUCKETS[bucket]
    const platform = platformForOneClickAsset(destinationAsset)
    if (!platform) {
      throw badRequest(`no reference price for destination asset '${destinationAsset}'; priced destinations are ${Object.keys(ONE_CLICK_PLATFORMS).join(', ')}`)
    }
    const requestedId = Number(assetIn)
    // A money-market aToken is 1:1 with its reserve and carries no USD candles of
    // its own, so it is priced through the reserve — which is what the pair
    // actually is (aUSDC is USDC). Without this the endpoint is empty for exactly
    // the assets cross-chain swaps are most often paid in: every order placed so
    // far sold aUSDC. `pricedAsset` reports the substitution rather than hiding it.
    const baseId = ATOKEN_UNDERLYING_ID[requestedId] ?? requestedId
    const baseIsUsd = USD_PEGGED_SYMBOLS.has(assetDescriptor(baseId).symbol.toUpperCase())

    const floor = (ms: number) => Math.max(Math.floor((ms / 1000 - anchor) / seconds) * seconds + anchor, anchor)
    const parsedFrom = request.query.from == null ? null : Date.parse(request.query.from)
    const parsedTo = request.query.to == null ? null : Date.parse(request.query.to)
    if (parsedFrom != null && parsedTo != null && parsedFrom > parsedTo) {
      throw badRequest('from must be earlier than to')
    }
    const lastClosedStart = floor(Date.now()) - seconds
    const toSeconds = Math.min(parsedTo == null ? lastClosedStart : floor(parsedTo), lastClosedStart)
    const fromSeconds = parsedFrom == null ? toSeconds - (DEFAULT_CANDLES - 1) * seconds : floor(parsedFrom)
    const empty = { referenceAsset: destinationAsset, referenceSource: 'kraken', pricedAsset: String(baseId), items: [] as PairCandle[] }
    if (fromSeconds > toSeconds) return empty

    const points = Math.floor((toSeconds - fromSeconds) / seconds) + 1
    if (points > MAX_CANDLES) {
      throw badRequest(`the requested window is ${points} ${bucket} candles; at most ${MAX_CANDLES} are served per request`)
    }

    const key = `pub:prices-xc-pair:${baseId}:${destinationAsset}:${bucket}:${fromSeconds}-${toSeconds}`
    return cached(key, 5_000, async () => {
      const [base, foreign] = await Promise.all([
        // A dollar-pegged base needs no series of its own: its USD price IS 1,
        // so the pair is the destination's own USD candles inverted.
        baseIsUsd
          ? Promise.resolve<OHLCVCandle[]>([])
          : queryOHLCV(opts.client, { assetId: baseId, startTime: new Date(fromSeconds * 1000), endTime: new Date(toSeconds * 1000), interval }),
        loadForeignCandles(platform, bucket, seconds),
      ])
      const nowSeconds = Math.floor(Date.now() / 1000)
      const hydration = base
        .filter(candle => Date.parse(`${candle.interval_start.replace(' ', 'T')}Z`) / 1000 + seconds <= nowSeconds)
        .map(candle => ({
          time: Math.floor(Date.parse(`${candle.interval_start.replace(' ', 'T')}Z`) / 1000),
          close: decimalText(candle.close),
          high: decimalText(candle.high),
          low: decimalText(candle.low),
        }))
      // The foreign series carries its venue's whole tail; clamp it to the window
      // the caller asked for and to the closed-bucket rule both sides obey.
      const windowed = foreign.filter(c => c.time >= fromSeconds && c.time <= toSeconds && c.time + seconds <= nowSeconds)
      return {
        referenceAsset: destinationAsset,
        referenceSource: 'kraken',
        pricedAsset: String(baseId),
        items: crossChainCandles(windowed, hydration, CROSS_SCALE, baseIsUsd),
      }
    })
  })
}
