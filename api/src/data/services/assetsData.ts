import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { allExplorerAssets, type ExplorerAsset } from '../../services/explorerAssets.ts'
import { scaledUsd } from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'
import { dataStatus } from './head.ts'

// Asset registry + price reads for /v1/assets*. The registry itself is the
// shared in-memory snapshot (explorerAssets, refreshed every 5 minutes); prices
// come from price_data.prices, asset-first keyed, so a per-asset read is a
// reverse key read and the all-assets fold is one grouped scan behind a 5-min
// cache.

export interface AssetItem {
  assetId: string
  symbol: string
  name: string | null
  decimals: number
  parachainId: number | null
  origin: { ecosystem: string; chainId: string; assetId: string | null } | null
  priceUsd: string | null
  priceUpdatedAt: string | null
}

interface PriceEntry { price: string; block: number; time: string | null }

// The staleness rule for a CURRENT price, matching the house valuation bound
// (PRICE_LOOKBACK_DAYS in services/valuation.ts): a feed whose last close is
// older than 30 days is unpriced, not priced at an arbitrarily old value.
// Rows from before the prices table carried timestamps report epoch 0; those
// fall back to a block-distance bound sized so no live asset can trip it.
const PRICE_STALE_SECONDS = 30 * 86_400
const PRICE_STALE_BLOCKS = 450_000

const EPOCH = '1970-01-01 00:00:00'

export async function currentPrices(client: ClickHouseClient): Promise<Map<number, PriceEntry>> {
  return cached('data:assets:current-prices', 300_000, async () => {
    // asset_price_latest (009_data.sql) is the argMax twin of prices keyed by
    // asset: the whole "newest price of every asset" is ~120 merged rows.
    const res = await client.query({
      query: `-- data:assets:current-prices
          SELECT asset_id, toString(argMaxMerge(price_state)) AS price,
                 maxMerge(block_state) AS block, toString(argMaxMerge(time_state)) AS ts
          FROM price_data.asset_price_latest
          GROUP BY asset_id`,
      format: 'JSONEachRow',
      clickhouse_settings: { output_format_json_quote_decimals: 1 },
    })
    const map = new Map<number, PriceEntry>()
    for (const row of await res.json<{ asset_id: number; price: string; block: number; ts: string }>()) {
      map.set(Number(row.asset_id), { price: row.price, block: Number(row.block), time: row.ts === EPOCH ? null : row.ts })
    }
    return map
  })
}

// The fresh current price per asset as a scaled USD integer (the valuation
// module's fixed-point form), for valuing CURRENT holdings: a feed outside the
// freshness bound is absent, never its final close.
export async function freshPriceMap(client: ClickHouseClient): Promise<Map<number, bigint>> {
  const [prices, status] = await Promise.all([currentPrices(client), dataStatus(client)])
  const out = new Map<number, bigint>()
  for (const [assetId, entry] of prices) {
    const { priceUsd } = freshPrice(entry, status.indexedHead)
    if (priceUsd != null) out.set(assetId, scaledUsd(priceUsd))
  }
  return out
}

function freshPrice(entry: PriceEntry | undefined, head: number): { priceUsd: string | null; priceUpdatedAt: string | null } {
  if (!entry) return { priceUsd: null, priceUpdatedAt: null }
  const fresh = entry.time != null
    ? Date.parse(iso(entry.time)) >= Date.now() - PRICE_STALE_SECONDS * 1000
    : entry.block >= head - PRICE_STALE_BLOCKS
  return {
    priceUsd: fresh ? entry.price : null,
    priceUpdatedAt: entry.time ? iso(entry.time) : null,
  }
}

function assetItem(asset: ExplorerAsset, prices: Map<number, PriceEntry>, head: number): AssetItem {
  return {
    assetId: String(asset.assetId),
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    parachainId: asset.parachainId,
    origin: asset.origin ? { ecosystem: asset.origin.ecosystem, chainId: asset.origin.chainId, assetId: asset.origin.assetId } : null,
    ...freshPrice(prices.get(asset.assetId), head),
  }
}

export async function listAssets(client: ClickHouseClient): Promise<AssetItem[]> {
  const [prices, status] = await Promise.all([currentPrices(client), dataStatus(client)])
  return allExplorerAssets()
    .sort((a, b) => a.assetId - b.assetId)
    .map(asset => assetItem(asset, prices, status.indexedHead))
}

export async function getAsset(client: ClickHouseClient, assetId: number): Promise<AssetItem | null> {
  const registered = allExplorerAssets().find(asset => asset.assetId === assetId)
  if (!registered) return null
  const [prices, status] = await Promise.all([currentPrices(client), dataStatus(client)])
  return assetItem(registered, prices, status.indexedHead)
}

// ---------------------------------------------------------------------------
// Point-in-time price: ASOF ≤ the requested block (or the newest block at or
// before the requested time). NO staleness bound here, deliberately and
// documented on the route: the answer is "the last price known at that point",
// and for an asset whose feed died that is its final close, however old.
// ---------------------------------------------------------------------------

export interface PriceAt {
  assetId: string
  priceUsd: string | null
  atBlock: number | null
  atTime: string | null
}

export async function priceAtBlock(client: ClickHouseClient, assetId: number, block: number): Promise<PriceAt> {
  const res = await client.query({
    query: `-- data:assets:price-at-block
        SELECT toString(usd_price) AS price, block_height, toString(block_timestamp) AS ts
        FROM price_data.prices
        WHERE asset_id = {assetId:UInt32} AND block_height <= {block:UInt32}
        ORDER BY block_height DESC
        LIMIT 1`,
    query_params: { assetId, block },
    format: 'JSONEachRow',
    clickhouse_settings: { output_format_json_quote_decimals: 1 },
  })
  const [row] = await res.json<{ price: string; block_height: number; ts: string }>()
  return {
    assetId: String(assetId),
    priceUsd: row?.price ?? null,
    atBlock: row ? Number(row.block_height) : null,
    atTime: row && row.ts !== EPOCH ? iso(row.ts) : null,
  }
}

// The newest block at or before a time. blocks is keyed by height, so the
// time predicate alone scans every earlier partition (12.6 M rows for a recent
// time); a one-day window before the time finds the block in a few thousand
// rows, and only a time inside a longer gap (or before the chain) falls back
// to the unbounded read.
async function blockAtTime(client: ClickHouseClient, epochSeconds: number): Promise<number> {
  for (const bounded of [true, false]) {
    const res = await client.query({
      query: `-- data:assets:price-at-time
          SELECT max(block_height) AS block
          FROM price_data.blocks
          WHERE block_timestamp <= toDateTime({t:UInt32})${bounded ? ' AND block_timestamp > toDateTime({t:UInt32}) - INTERVAL 1 DAY' : ''}`,
      query_params: { t: epochSeconds },
      format: 'JSONEachRow',
    })
    const [row] = await res.json<{ block: number | null }>()
    const block = Number(row?.block ?? 0)
    if (block) return block
  }
  return 0
}

export async function priceAtTime(client: ClickHouseClient, assetId: number, epochSeconds: number): Promise<PriceAt> {
  const block = await blockAtTime(client, epochSeconds)
  if (!block) return { assetId: String(assetId), priceUsd: null, atBlock: null, atTime: null }
  return priceAtBlock(client, assetId, block)
}

export async function currentPrice(client: ClickHouseClient, assetId: number): Promise<PriceAt> {
  const [prices, status] = await Promise.all([currentPrices(client), dataStatus(client)])
  const entry = prices.get(assetId)
  const { priceUsd } = freshPrice(entry, status.indexedHead)
  return {
    assetId: String(assetId),
    priceUsd,
    atBlock: entry ? entry.block : null,
    atTime: entry?.time ? iso(entry.time) : null,
  }
}

// ---------------------------------------------------------------------------
// Candles, via the parameterized *_query views (002_views.sql). NOTE the
// naming trap the views inherit from the tables: `ohlc_1m` is MONTHLY
// (toStartOfMonth) — the minute-family tables are ohlc_5min/15min/30min. There
// are no 1-minute candles anywhere in the schema.
// ---------------------------------------------------------------------------

export const CANDLE_BUCKETS = {
  '5m': { view: 'ohlc_5min_query', maxSpanDays: 14 },
  '15m': { view: 'ohlc_15min_query', maxSpanDays: 30 },
  '30m': { view: 'ohlc_30min_query', maxSpanDays: 60 },
  '1h': { view: 'ohlc_1h_query', maxSpanDays: 120 },
  '4h': { view: 'ohlc_4h_query', maxSpanDays: 366 },
  '1d': { view: 'ohlc_1d_query', maxSpanDays: 1830 },
  '1w': { view: 'ohlc_1w_query', maxSpanDays: 3660 },
  '1M': { view: 'ohlc_1m_query', maxSpanDays: 3660 },
} as const

export type CandleBucket = keyof typeof CANDLE_BUCKETS

export interface Candle {
  time: string
  open: string
  high: string
  low: string
  close: string
  volumeBuy: string
  volumeSell: string
  volumeTotal: string
}

const chDateTime = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')

export async function assetCandles(client: ClickHouseClient, assetId: number, bucket: CandleBucket, fromTime: number, toTime: number): Promise<Candle[]> {
  const res = await client.query({
    query: `-- data:assets:candles
        SELECT * FROM price_data.${CANDLE_BUCKETS[bucket].view}(asset_id={assetId:UInt32}, start_time={start:DateTime}, end_time={end:DateTime})`,
    query_params: { assetId, start: chDateTime(fromTime), end: chDateTime(toTime) },
    format: 'JSONEachRow',
    // Decimal(38,12) values must arrive as strings or JSON.parse rounds them
    // through a double (the ohlcvService precedent).
    clickhouse_settings: { output_format_json_quote_decimals: 1 },
  })
  const rows = await res.json<{ interval_start: string; open: string; high: string; low: string; close: string; volume_buy: string; volume_sell: string; volume_total: string }>()
  return rows.map(row => ({
    time: iso(row.interval_start),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volumeBuy: row.volume_buy,
    volumeSell: row.volume_sell,
    volumeTotal: row.volume_total,
  }))
}

// ---------------------------------------------------------------------------
// Holders: top-N by current balance. Substrate balances come from the
// asset-first argMax projection (asset_account_latest_balances); an asset with
// no substrate rows falls back to the ERC-20 wallet snapshot (the aToken-form
// assets whose balances never touch the substrate table).
// ---------------------------------------------------------------------------

export interface HolderRow { accountId: string; amount: string; lastBlock: number | null }
export interface HoldersResult { rows: HolderRow[]; holderCount: number }

// The route's limit is 1-100; the ranking is computed once per asset for the
// full 100 and sliced, so limit=10 and limit=100 share one fold. The holder
// count rides on the same read as a window aggregate over the filtered set,
// so "how many hold it" costs nothing beyond the ranking.
export const HOLDERS_RANK_DEPTH = 100

export async function assetHolders(client: ClickHouseClient, assetId: number, limit: number): Promise<HoldersResult> {
  const res = await client.query({
    query: `-- data:assets:holders
        SELECT account_id, total, last_block, count() OVER () AS holder_count
        FROM (
          SELECT account_id, ifNull(argMaxMerge(total_state), '0') AS total, maxMerge(last_block_state) AS last_block
          FROM price_data.asset_account_latest_balances
          WHERE asset_id = {assetId:String}
          GROUP BY account_id
          HAVING toUInt256OrZero(total) > 0
        )
        ORDER BY toUInt256OrZero(total) DESC
        LIMIT {limit:UInt32}`,
    query_params: { assetId: String(assetId), limit },
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ account_id: string; total: string; last_block: number; holder_count: string | number }>()
  if (rows.length > 0) {
    return {
      rows: rows.map(row => ({ accountId: row.account_id, amount: row.total, lastBlock: Number(row.last_block) || null })),
      holderCount: Number(rows[0].holder_count),
    }
  }
  // ERC-20-form assets (their transfers never hit raw_balance_observations).
  const erc20 = await client.query({
    query: `-- data:assets:holders-erc20
        SELECT account_id, total, count() OVER () AS holder_count
        FROM price_data.erc20_wallet_balances FINAL
        WHERE asset_id = {assetId:String} AND toUInt256OrZero(total) > 0
        ORDER BY toUInt256OrZero(total) DESC
        LIMIT {limit:UInt32}`,
    query_params: { assetId: String(assetId), limit },
    format: 'JSONEachRow',
  })
  const erc20Rows = await erc20.json<{ account_id: string; total: string; holder_count: string | number }>()
  return {
    rows: erc20Rows.map(row => ({ accountId: row.account_id, amount: row.total, lastBlock: null })),
    holderCount: Number(erc20Rows[0]?.holder_count ?? 0),
  }
}
