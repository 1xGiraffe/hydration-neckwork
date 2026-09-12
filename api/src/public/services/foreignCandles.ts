import { config } from '../../config.ts'
import { cached } from '../../services/cache.ts'

// USD candles for assets that do NOT trade on Hydration.
//
// A cross-chain swap sells a Hydration asset and delivers NEAR or ZEC on their own
// chains (see clickhouse/schema/011_xcswap.sql). Neither is listed here, so the
// pair has no native candle model and no amount of Hydration data will produce
// one. The destination's USD price has to come from a venue that does trade it.
//
// Kraken's public OHLC is that venue: no key, a fixed set of intervals that the
// candle model's buckets happen to match exactly, and an allowlisted pair per
// destination platform. It is a REFERENCE price and never an executed one — what
// a cross-chain swap actually got is the realised rate of the order itself.
//
// This is the server-side half of a fold the Hydration UI currently does in every
// visitor's browser (apps/main/src/api/external/kraken.ts, whose own comment calls
// it a mirror of "the backend proxy proposal"). Moving it here makes it one cached
// upstream call for all readers instead of one per browser, keeps Kraken's
// rate limit off end users, and lets the same series answer from the API.

/** Destination platform -> Kraken USD pair. An explicit allowlist, never derived. */
export const KRAKEN_PAIRS: Record<string, string> = {
  near: 'NEARUSD',
  zec: 'ZECUSD',
}

/**
 * 1Click asset id -> the platform whose Kraken pair prices it. The swap SDK's two
 * destinations today; an id with no entry has no reference series and is refused
 * rather than priced off something adjacent.
 */
export const ONE_CLICK_PLATFORMS: Record<string, string> = {
  'nep141:wrap.near': 'near',
  'nep141:zec.omft.near': 'zec',
}

/** Kraken's OHLC intervals, in minutes, per candle bucket. */
export const KRAKEN_INTERVALS: Record<string, number> = {
  '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080,
}

export interface ForeignCandle {
  /** Bucket open, epoch seconds — the same label the candle model uses. */
  time: number
  open: string
  high: string
  low: string
  close: string
}

const KRAKEN_TIMEOUT_MS = 10_000

// Kraken serves a fixed tail per interval (about 720 candles) and no `from`, so a
// window older than that tail simply has no reference price. That bound is the
// endpoint's, not a choice we make here.
export function krakenPairFor(platform: string): string | undefined {
  return KRAKEN_PAIRS[platform]
}

export function platformForOneClickAsset(assetId: string): string | undefined {
  return ONE_CLICK_PLATFORMS[assetId]
}

// Kraken's candle tuple: [time, open, high, low, close, vwap, volume, count].
// Read positionally, with every numeric field kept as the TEXT Kraken sent so the
// cross-rate division downstream stays exact decimal arithmetic rather than
// passing through a float.
function candleFromTuple(row: unknown): ForeignCandle | null {
  if (!Array.isArray(row) || row.length < 5) return null
  const [time, open, high, low, close] = row as [unknown, unknown, unknown, unknown, unknown]
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  const text = (v: unknown): string | null => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? v : null
  const o = text(open), h = text(high), l = text(low), c = text(close)
  if (o == null || h == null || l == null || c == null) return null
  return { time: Math.trunc(time), open: o, high: h, low: l, close: c }
}

async function fetchKrakenOhlc(pair: string, interval: number): Promise<ForeignCandle[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), KRAKEN_TIMEOUT_MS)
  try {
    const url = `${config.krakenBaseUrl.replace(/\/+$/, '')}/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Kraken OHLC ${pair}/${interval} -> HTTP ${res.status}`)
    const body = await res.json() as { error?: unknown[]; result?: Record<string, unknown> }
    if (Array.isArray(body.error) && body.error.length) {
      throw new Error(`Kraken error: ${body.error.map(String).join(', ')}`)
    }
    // Kraken may key the series under a legacy name (ZECUSD comes back as
    // XZECZUSD), so the first array-valued entry is the series; `last` is a
    // cursor, not candles.
    const series = Object.entries(body.result ?? {}).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1]
    if (!Array.isArray(series)) return []
    const out: ForeignCandle[] = []
    for (const row of series) {
      const candle = candleFromTuple(row)
      if (candle) out.push(candle)
    }
    out.sort((a, b) => a.time - b.time)
    return out
  } finally {
    clearTimeout(timeout)
  }
}

// One upstream call per (pair, interval) for every reader. The TTL tracks the
// bucket — a 5-minute series is worth re-reading within the minute, a daily one
// is not — and is capped so a long bucket cannot pin a stale tail for an hour.
export function foreignCandleTtlMs(bucketSeconds: number): number {
  return Math.min(Math.max(bucketSeconds * 1000 / 5, 30_000), 300_000)
}

export function loadForeignCandles(platform: string, bucket: string, bucketSeconds: number): Promise<ForeignCandle[]> {
  const pair = krakenPairFor(platform)
  const interval = KRAKEN_INTERVALS[bucket]
  if (!pair || !interval) return Promise.resolve([])
  return cached(`pub:kraken-ohlc:${pair}:${interval}`, foreignCandleTtlMs(bucketSeconds), () => fetchKrakenOhlc(pair, interval))
}
