import type { ClickHouseClient } from '../../db/client.ts'
import { assetDescriptor, priceAssetId } from '../../services/explorerAssets.ts'
import { PRICE_LOOKBACK_DAYS, scaledUsd } from '../../services/valuation.ts'

// Event-time USD for a PAGE of historical flows (trades, transfers): the newest
// CLOSED hourly candle at or before each row's time, at most PRICE_LOOKBACK_DAYS
// stale, with share/aTokens aliased to their price feed. One ohlc_1h read per
// page covers every asset and the page's whole time span; a later price change
// never rewrites a historical value (the valuation rule for flows).

export const PRICE_LOOKBACK_SEC = PRICE_LOOKBACK_DAYS * 86_400

export interface EventTimePricer {
  // USD (the valuation module's scaled integer) of `amount` raw units of
  // `assetId` at `timeSec`, or null when no usable close exists.
  usdAt(assetId: number, amount: bigint, timeSec: number): bigint | null
}

export async function eventTimePricer(client: ClickHouseClient, assetIds: Iterable<number>, minTimeSec: number, maxTimeSec: number): Promise<EventTimePricer> {
  const aliasIds = new Set<number>()
  for (const id of assetIds) aliasIds.add(priceAssetId(id))
  const closes = new Map<number, Array<{ t: number; close: bigint }>>()
  if (aliasIds.size && Number.isFinite(minTimeSec) && Number.isFinite(maxTimeSec)) {
    const res = await client.query({
      query: `-- data:prices:event-time-closes
          SELECT asset_id, toUnixTimestamp(interval_start) + 3600 AS price_time, toString(argMaxMerge(close_state)) AS close
          FROM price_data.ohlc_1h
          WHERE asset_id IN {ids:Array(UInt32)}
            AND interval_start >= toDateTime({minT:UInt32}) - INTERVAL ${PRICE_LOOKBACK_DAYS} DAY
            AND interval_start < toDateTime({maxT:UInt32})
          GROUP BY asset_id, interval_start
          ORDER BY asset_id, price_time`,
      query_params: { ids: [...aliasIds], minT: minTimeSec, maxT: maxTimeSec },
      format: 'JSONEachRow',
      clickhouse_settings: { output_format_json_quote_decimals: 1 },
    })
    for (const row of await res.json<{ asset_id: number; price_time: number; close: string }>()) {
      const list = closes.get(Number(row.asset_id)) ?? []
      list.push({ t: Number(row.price_time), close: scaledUsd(row.close) })
      closes.set(Number(row.asset_id), list)
    }
  }

  // Newest close at or before t, within the staleness bound (lists are sorted).
  function closeAt(aliasId: number, t: number): bigint | null {
    const list = closes.get(aliasId)
    if (!list) return null
    let lo = 0
    let hi = list.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].t <= t) { best = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (best < 0) return null
    const hit = list[best]
    return t - hit.t <= PRICE_LOOKBACK_SEC && hit.close > 0n ? hit.close : null
  }

  return {
    usdAt(assetId, amount, timeSec) {
      const close = closeAt(priceAssetId(assetId), timeSec)
      if (close == null) return null
      return (amount * close) / 10n ** BigInt(assetDescriptor(assetId).decimals)
    },
  }
}
