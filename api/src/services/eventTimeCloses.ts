import type { ClickHouseClient } from '../db/client.ts'
import { assetDescriptor, priceAssetId } from './explorerAssets.ts'
import { tagged } from './queryTag.ts'
import { PRICE_LOOKBACK_DAYS, scaledUsd } from './valuation.ts'

// Event-time USD for a set of historical flows grouped by the hour they happened in.
// A flow at time t is worth the newest hourly candle fully CLOSED by t, carried at
// most PRICE_LOOKBACK_DAYS — the rule lpHistory's bucketPricerFrom states for bucket
// ends. Every flow inside [H, H+1h) sees the same candle, the one closing at H, so
// callers sum their raw amounts per (asset, hour) in SQL and value each hour once:
// exact, because Σ raw_i × close = (Σ raw_i) × close.
//
// The closes are matched in ClickHouse (ASOF over the assets' ohlc_1h rows in the
// hours' span plus the lookback), so the response is one close per requested
// (feed, hour) however long the span is; integer 1e-12 USD throughout.

const PRICE_LOOKBACK_SEC = PRICE_LOOKBACK_DAYS * 86_400
// (feed, hour) pairs per ASOF read: keeps the literal well under max_query_size and
// the answer under the client's result-row cap.
const FLOW_CHUNK = 20_000

export interface HourlyFlowPricer {
  /** USD (1e-12 integer) of `amount` raw units of `assetId` moved during the hour starting at `hourSec`, or null when unpriced. */
  usd(assetId: number, amount: bigint, hourSec: number): bigint | null
}

export interface MatchedClose { closedAt: number; close: bigint }
export const flowCloseKey = (feedId: number, hourSec: number): string => `${feedId}:${hourSec}`

/**
 * A pricer over already-matched closes (key: flowCloseKey(price feed, hour); value:
 * the newest candle with closedAt ≤ hour, or absent). Pure. A close older than the
 * lookback, or non-positive, is no price.
 */
export function hourlyFlowPricerFrom(closes: ReadonlyMap<string, MatchedClose>): HourlyFlowPricer {
  return {
    usd(assetId, amount, hourSec) {
      const hit = closes.get(flowCloseKey(priceAssetId(assetId), hourSec))
      if (!hit || hit.closedAt <= 0 || hit.closedAt > hourSec || hourSec - hit.closedAt > PRICE_LOOKBACK_SEC || hit.close <= 0n) return null
      return (amount * hit.close) / 10n ** BigInt(assetDescriptor(assetId).decimals)
    },
  }
}

export async function loadHourlyFlowPricer(
  client: ClickHouseClient,
  flows: ReadonlyArray<{ assetId: number; hourSec: number }>,
): Promise<HourlyFlowPricer> {
  const closes = new Map<string, MatchedClose>()
  const pairs = new Map<string, [number, number]>()
  for (const f of flows) {
    if (!Number.isFinite(f.hourSec) || f.hourSec <= 0) continue
    const feed = priceAssetId(f.assetId)
    pairs.set(flowCloseKey(feed, f.hourSec), [feed, f.hourSec])
  }
  const all = [...pairs.values()]
  for (let i = 0; i < all.length; i += FLOW_CHUNK) {
    const chunk = all.slice(i, i + FLOW_CHUNK)
    const ids = [...new Set(chunk.map(p => p[0]))]
    let minT = Infinity, maxT = -Infinity
    for (const [, h] of chunk) { if (h < minT) minT = h; if (h > maxT) maxT = h }
    const res = await client.query(tagged({
      query: `-- flows:event-time-closes
              SELECT f.feed AS feed, f.h AS h, p.closed_at AS closed_at, toString(p.px) AS px
              FROM (
                SELECT tupleElement(t, 1) AS feed, tupleElement(t, 2) AS h
                FROM (SELECT arrayJoin(arrayZip({feeds:Array(UInt32)}, {hours:Array(UInt32)})) AS t)
              ) AS f
              ASOF LEFT JOIN (
                SELECT asset_id, toUInt32(toUnixTimestamp(interval_start)) + 3600 AS closed_at, argMaxMerge(close_state) AS px
                FROM price_data.ohlc_1h
                WHERE asset_id IN {ids:Array(UInt32)}
                  AND interval_start >= toDateTime({minT:UInt32})
                  AND interval_start <= toDateTime({maxT:UInt32})
                GROUP BY asset_id, interval_start
              ) AS p ON p.asset_id = f.feed AND p.closed_at <= f.h`,
      query_params: { feeds: chunk.map(p => p[0]), hours: chunk.map(p => p[1]), ids, minT: Math.max(0, minT - PRICE_LOOKBACK_SEC - 3_600), maxT: Math.max(0, maxT - 3_600) },
      format: 'JSONEachRow',
      clickhouse_settings: { output_format_json_quote_decimals: 1 },
    }))
    for (const r of await res.json<{ feed: number; h: number; closed_at: number; px: string }>()) {
      if (!Number(r.closed_at)) continue
      closes.set(flowCloseKey(Number(r.feed), Number(r.h)), { closedAt: Number(r.closed_at), close: scaledUsd(r.px) })
    }
  }
  return hourlyFlowPricerFrom(closes)
}
