import type { ClickHouseClient } from '../../db/client.ts'
import type { BlockClock } from '../../services/blockClock.ts'
import { cached } from '../../services/cache.ts'
import { renderUsd, scaledUsd } from '../../services/valuation.ts'
import { iso } from '../schemas/common.ts'
import { evmAccountForm, type ParsedAddress } from './address.ts'
import { windowBucketing, type BucketHistoryWindow, type HistoryBucket } from './lpHistory.ts'

// USD volume reads for /v1/stats/volume/usd and /v1/accounts/{address}/volume.
//
// Both read derived read models the derivations service publishes — never raw
// legs at request time — and restate none of their definitions: those live once,
// in services/volumeHourly.ts (the three hourly folds) and
// services/accountTradeVolume.ts (the per-account netted trades). What is here is
// a plain GROUP BY over the published rows.
//
//   price_data.routed_volume_hourly  (hour) → volume_usd, trades, unpriced_trades
//   price_data.pool_volume_hourly    (venue, pool_key, hour) → volume_usd, fills,
//                                    lp_fee_usd, protocol_fee_usd, unpriced_fills
//   price_data.asset_volume_hourly   (asset_id, hour, venue, pool_key) → volume_usd,
//                                    legs, unpriced_legs
//   price_data.account_trade_volume  (account, block_height, trade_key) → volume_usd,
//                                    trade_count
//
// The hourly folds' partitions and the account model's are published whole
// (staging twin + REPLACE PARTITION), so a partition never holds two versions of
// a row and no FINAL or dedup is needed.

export const VOLUME_USD_GROUPS = ['routed', 'venue', 'pool', 'asset'] as const
export type VolumeUsdGroupBy = (typeof VOLUME_USD_GROUPS)[number]

/** The venues the hourly folds hold: every pool_swap_legs venue but `aave` (aToken wraps are never volume). */
export const VOLUME_USD_VENUES = ['omnipool', 'stableswap', 'xyk', 'uniswapv3', 'otc', 'hsm', 'lbp'] as const

const TABLE: Record<VolumeUsdGroupBy, string> = {
  routed: 'price_data.routed_volume_hourly',
  venue: 'price_data.pool_volume_hourly',
  pool: 'price_data.pool_volume_hourly',
  asset: 'price_data.asset_volume_hourly',
}

export interface VolumeUsdRow {
  bucket: string
  group: string
  volumeUsd: string
  trades?: number
  fills?: number
  legs?: number
  unpriced: number
  lpFeeUsd?: string
  protocolFeeUsd?: string
}

export interface VolumeUsdOptions {
  groupBy: VolumeUsdGroupBy
  bucket: 'hour' | 'day'
  from: number
  to: number
  venue?: string
  assetId?: number
  poolKey?: string
}

/**
 * The first hour a fold has NOT published: its newest hour + 1 h (null on an
 * empty fold). The derivations service folds each hour on the first cycle after
 * it closes and is priced, so this trails the chain by the hour in progress plus
 * at most one cycle. max(hour)
 * resolves from the parts' minmax metadata; cached for a minute per fold.
 */
export function publishedCut(client: ClickHouseClient, groupBy: VolumeUsdGroupBy): Promise<string | null> {
  const table = TABLE[groupBy]
  return cached(`data:stats:volume-usd:cut:${table}`, 60_000, async () => {
    const res = await client.query({
      query: `-- data:stats:volume-usd:cut
        SELECT toString(max(hour) + INTERVAL 1 HOUR) AS cut, count() AS n FROM ${table}`,
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ cut: string; n: string | number }>())[0]
    return row && Number(row.n) > 0 ? iso(row.cut) : null
  })
}

export async function volumeUsdStats(client: ClickHouseClient, options: VolumeUsdOptions): Promise<VolumeUsdRow[]> {
  const { groupBy } = options
  const bucketExpr = options.bucket === 'day' ? 'toDateTime(toDate(hour))' : 'hour'
  const params: Record<string, unknown> = { fromTime: options.from, toTime: options.to }
  const clauses = ['hour >= toDateTime({fromTime:UInt32})', 'hour < toDateTime({toTime:UInt32})']
  if (options.venue) { clauses.push('venue = {venue:String}'); params.venue = options.venue }
  if (options.poolKey != null) { clauses.push('pool_key = {poolKey:String}'); params.poolKey = options.poolKey }
  if (options.assetId != null) { clauses.push('asset_id = {assetId:UInt32}'); params.assetId = options.assetId }

  const groupExpr = groupBy === 'routed' ? `'routed'`
    : groupBy === 'venue' ? 'toString(venue)'
    : groupBy === 'pool' ? `concat(toString(venue), ':', pool_key)`
    : 'toString(asset_id)'
  const measures = groupBy === 'routed'
    ? 'toUInt64(sum(trades)) AS n, toUInt64(sum(unpriced_trades)) AS unpriced'
    : groupBy === 'asset'
      ? 'toUInt64(sum(legs)) AS n, toUInt64(sum(unpriced_legs)) AS unpriced'
      : `toUInt64(sum(fills)) AS n, toUInt64(sum(unpriced_fills)) AS unpriced,
               toString(sum(lp_fee_usd)) AS lp_fee, toString(sum(protocol_fee_usd)) AS protocol_fee`
  const res = await client.query({
    query: `-- data:stats:volume-usd
        SELECT toString(${bucketExpr}) AS bkt, ${groupExpr} AS grp,
               toString(sum(volume_usd)) AS usd, ${measures}
        FROM ${TABLE[groupBy]}
        WHERE ${clauses.join(' AND ')}
        GROUP BY bkt, grp
        ORDER BY bkt, grp`,
    query_params: params,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ bkt: string; grp: string; usd: string; n: string; unpriced: string; lp_fee?: string; protocol_fee?: string }>()
  const countKey = groupBy === 'routed' ? 'trades' : groupBy === 'asset' ? 'legs' : 'fills'
  return rows.map(row => ({
    bucket: iso(row.bkt),
    group: row.grp,
    volumeUsd: renderUsd(scaledUsd(row.usd)),
    [countKey]: Number(row.n),
    unpriced: Number(row.unpriced),
    ...(row.lp_fee != null ? { lpFeeUsd: renderUsd(scaledUsd(row.lp_fee)), protocolFeeUsd: renderUsd(scaledUsd(row.protocol_fee)) } : {}),
  }))
}

// ---------------------------------------------------------------------------
// One account's trading volume on a fixed bucket grid
// ---------------------------------------------------------------------------

export interface AccountVolumeResponse {
  bucket: HistoryBucket
  from: string
  to: string
  points: Array<{ bucket: string; blockHeight: number; volumeUsd: string; trades: number }>
  totals: { windowUsd: string; windowTrades: number; allTimeUsd: string; allTimeTrades: number }
  firstTradeBlock: number | null
  asOfBlock: number | null
}

/**
 * The identities one address's trades are filed under: the account itself and
 * its ETH-truncated form (`0x45544800…`), under which the model files the swaps
 * the account made from its EVM side — one holder, two storage keys. An EVM
 * address's truncated id folds to itself.
 */
function accountVolumeIdentities(parsed: ParsedAddress): string[] {
  return [...new Set([parsed.accountId, evmAccountForm(parsed)])]
}

/**
 * The newest block the model holds a trade for (any account): the freshness
 * bound of every figure here. The partition key is a function of block_height,
 * so the lower bound prunes to the newest partitions.
 */
function accountVolumeAsOfBlock(client: ClickHouseClient, headBlock: number): Promise<number | null> {
  return cached('data:accounts:volume:as-of', 60_000, async () => {
    const res = await client.query({
      query: `-- data:accounts:volume:as-of
        SELECT max(block_height) AS top, count() AS n FROM price_data.account_trade_volume
        WHERE block_height >= {since:UInt32}`,
      query_params: { since: Math.max(0, Math.floor(headBlock) - 432_000) },
      format: 'JSONEachRow',
    })
    const row = (await res.json<{ top: number | string; n: number | string }>())[0]
    return row && Number(row.n) > 0 ? Number(row.top) : null
  })
}

export async function accountVolume(
  client: ClickHouseClient,
  parsed: ParsedAddress,
  opts: { bucket: HistoryBucket; window: BucketHistoryWindow; clock: BlockClock; headBlock: number },
): Promise<AccountVolumeResponse> {
  const { window, bucket, clock } = opts
  const bk = windowBucketing(window, clock)
  const accounts = accountVolumeIdentities(parsed)
  // Buckets are (start, end] in blocks: a trade at the block dated at or before
  // the window's start belongs to the bucket before it.
  const fromHeight = bk.floorHeight
  const toHeight = bk.endHeight(bk.N)
  const [bucketRes, totalRes, asOfBlock] = await Promise.all([
    client.query({
      query: `-- data:accounts:volume
        SELECT ${bk.ofHeight('block_height')} AS b, toString(sum(volume_usd)) AS usd, toUInt64(sum(trade_count)) AS n
        FROM price_data.account_trade_volume
        WHERE account IN {accounts:Array(String)} AND block_height > {fromHeight:UInt32} AND block_height <= {toHeight:UInt32}
        GROUP BY b
        ORDER BY b`,
      query_params: { accounts, fromHeight, toHeight },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- data:accounts:volume:totals
        SELECT toString(sum(volume_usd)) AS usd, toUInt64(sum(trade_count)) AS n, min(block_height) AS first_block, count() AS rows_n
        FROM price_data.account_trade_volume
        WHERE account IN {accounts:Array(String)}`,
      query_params: { accounts },
      format: 'JSONEachRow',
    }),
    accountVolumeAsOfBlock(client, opts.headBlock),
  ])
  const usd = Array.from({ length: bk.N + 1 }, () => 0n)
  const trades = Array.from({ length: bk.N + 1 }, () => 0)
  for (const row of await bucketRes.json<{ b: number | string; usd: string; n: string }>()) {
    const b = Number(row.b)
    if (!(b >= 0 && b <= bk.N)) continue
    usd[b] += scaledUsd(row.usd)
    trades[b] += Number(row.n)
  }
  const total = (await totalRes.json<{ usd: string; n: string; first_block: number | string; rows_n: string | number }>())[0]
  const hasTrades = total != null && Number(total.rows_n) > 0
  const startIso = (b: number) => iso((bk.endSec(b) - bk.step) * 1000)
  return {
    bucket,
    from: iso(window.from * 1000),
    to: iso(window.to * 1000),
    points: usd.map((v, b) => ({ bucket: startIso(b), blockHeight: bk.endHeight(b), volumeUsd: renderUsd(v), trades: trades[b] })),
    totals: {
      windowUsd: renderUsd(usd.reduce((a, v) => a + v, 0n)),
      windowTrades: trades.reduce((a, v) => a + v, 0),
      allTimeUsd: renderUsd(hasTrades ? scaledUsd(total.usd) : 0n),
      allTimeTrades: hasTrades ? Number(total.n) : 0,
    },
    firstTradeBlock: hasTrades ? Number(total.first_block) : null,
    asOfBlock,
  }
}
