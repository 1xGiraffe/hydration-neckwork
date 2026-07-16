import type { ClickHouseClient } from '../db/client.ts'
import type { OmniwatchCandleSummary, OmniwatchTrader } from '../types.ts'
import { accountIcon, ensureSnakewatchEmojiSourceLoaded, polkadotAddress, shortAccount } from './omniwatchIdentity.ts'
import { toClickHouseDateTime, type OHLCVInterval } from './ohlcvService.ts'

const INTERVAL_BUCKET: Record<OHLCVInterval, string> = {
  '5min':  'toStartOfFiveMinute(b.block_timestamp)',
  '15min': 'toStartOfInterval(b.block_timestamp, INTERVAL 15 MINUTE)',
  '30min': 'toStartOfInterval(b.block_timestamp, INTERVAL 30 MINUTE)',
  '1h':    'toStartOfHour(b.block_timestamp)',
  '4h':    'toStartOfInterval(b.block_timestamp, INTERVAL 4 HOUR)',
  '1d':    'toStartOfDay(b.block_timestamp)',
  '1w':    'toStartOfWeek(b.block_timestamp, 1)',
  '1M':    'toStartOfMonth(b.block_timestamp)',
}

const INTERVAL_SECONDS: Record<OHLCVInterval, number> = {
  '5min': 300,
  '15min': 900,
  '30min': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
  '1M': 2592000,
}

interface SummaryRow {
  interval_start: string
  account: string
  account_count: string
  total_trade_count: string
  total_volume_buy: string
  total_volume_sell: string
  total_volume_total: string
  total_net_volume: string
  trade_count: string
  volume_buy: string
  volume_sell: string
  volume_total: string
  net_volume: string
}

interface DetailRow {
  account: string
  volume_buy: string
  volume_sell: string
  volume_total: string
  net_volume: string
  trade_count: string
}

export interface TradeVolumeDetails {
  accounts: OmniwatchTrader[]
  accountCount: number
  tradeCount: number
  volumeBuy: number
  volumeSell: number
  volumeTotal: number
  netVolume: number
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
}

interface DetailTotalsRow {
  account_count: string
  trade_count: string
  volume_buy: string
  volume_sell: string
  volume_total: string
  net_volume: string
}

function isMissingTradeVolumeTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('trade_volume_by_account')
}

function toUnixSeconds(clickhouseDateTime: string): number {
  return Math.floor(new Date(`${clickhouseDateTime.replace(' ', 'T')}Z`).getTime() / 1000)
}

function parseNumber(value: string | number | null | undefined): number {
  return Number(value) || 0
}

function toTrader(row: {
  account: string
  volume_buy: string
  volume_sell: string
  volume_total: string
  net_volume: string
  trade_count: string
}): OmniwatchTrader {
  const address = polkadotAddress(row.account)
  const icon = accountIcon(row.account)
  return {
    account: address,
    shortAccount: shortAccount(address),
    emoji: icon.emoji,
    ...(icon.emojiName ? { emojiName: icon.emojiName } : {}),
    ...(icon.emojiUrl ? { emojiUrl: icon.emojiUrl } : {}),
    volumeBuy: parseNumber(row.volume_buy),
    volumeSell: parseNumber(row.volume_sell),
    volumeTotal: parseNumber(row.volume_total),
    netVolume: parseNumber(row.net_volume),
    tradeCount: Number(row.trade_count) || 0,
  }
}

export async function queryTradeVolumeSummaries(
  client: ClickHouseClient,
  options: { assetId: number; startTime: Date; endTime: Date; interval: OHLCVInterval }
): Promise<Map<number, OmniwatchCandleSummary>> {
  const bucket = INTERVAL_BUCKET[options.interval]
  const startTime = toClickHouseDateTime(options.startTime)
  const endTime = toClickHouseDateTime(options.endTime)

  try {
    const emojiSourceReady = ensureSnakewatchEmojiSourceLoaded()
    const result = await client.query({
      query: `
        WITH
          (SELECT min(block_height) FROM price_data.blocks
            WHERE block_timestamp >= {start_time:DateTime}
              AND block_timestamp < {end_time:DateTime}) AS from_block,
          (SELECT max(block_height) FROM price_data.blocks
            WHERE block_timestamp >= {start_time:DateTime}
              AND block_timestamp < {end_time:DateTime}) AS to_block
        SELECT
          interval_start,
          tupleElement(top_trader, 1) AS account,
          toString(tupleElement(top_trader, 2)) AS volume_buy,
          toString(tupleElement(top_trader, 3)) AS volume_sell,
          toString(tupleElement(top_trader, 4)) AS volume_total,
          toString(tupleElement(top_trader, 5)) AS net_volume,
          toString(tupleElement(top_trader, 6)) AS trade_count,
          toString(account_count) AS account_count,
          toString(total_trade_count) AS total_trade_count,
          toString(total_volume_buy) AS total_volume_buy,
          toString(total_volume_sell) AS total_volume_sell,
          toString(total_volume_total) AS total_volume_total,
          toString(total_net_volume) AS total_net_volume
        FROM (
          SELECT
            interval_start,
            argMax(tuple(account, volume_buy, volume_sell, volume_total, net_volume, trade_count), volume_total) AS top_trader,
            count() AS account_count,
            sum(trade_count) AS total_trade_count,
            sum(volume_buy) AS total_volume_buy,
            sum(volume_sell) AS total_volume_sell,
            sum(volume_total) AS total_volume_total,
            sum(net_volume) AS total_net_volume
          FROM (
            SELECT
              ${bucket} AS interval_start,
              tv.account AS account,
              sum(tv.usd_volume_buy) AS volume_buy,
              sum(tv.usd_volume_sell) AS volume_sell,
              sum(tv.usd_volume_buy) + sum(tv.usd_volume_sell) AS volume_total,
              sum(tv.usd_volume_buy) - sum(tv.usd_volume_sell) AS net_volume,
              sum(tv.trade_count) AS trade_count
            FROM price_data.trade_volume_by_account AS tv
            INNER JOIN price_data.blocks b ON tv.block_height = b.block_height
            WHERE tv.asset_id = {asset_id:UInt32}
              AND tv.block_height BETWEEN from_block AND to_block
              AND b.block_timestamp >= {start_time:DateTime}
              AND b.block_timestamp < {end_time:DateTime}
            GROUP BY interval_start, tv.account
          )
          GROUP BY interval_start
        )
        ORDER BY interval_start ASC
      `,
      query_params: {
        asset_id: options.assetId,
        start_time: startTime,
        end_time: endTime,
      },
      format: 'JSONEachRow',
    })

    const rows = await result.json<SummaryRow>()
    await emojiSourceReady
    const summaries = new Map<number, OmniwatchCandleSummary>()

    for (const row of rows) {
      const intervalStart = toUnixSeconds(row.interval_start)
      summaries.set(intervalStart, {
        topTrader: toTrader(row),
        accountCount: Number(row.account_count) || 0,
        tradeCount: Number(row.total_trade_count) || 0,
        volumeBuy: parseNumber(row.total_volume_buy),
        volumeSell: parseNumber(row.total_volume_sell),
        volumeTotal: parseNumber(row.total_volume_total),
        netVolume: parseNumber(row.total_net_volume),
      })
    }

    return summaries
  } catch (error) {
    if (isMissingTradeVolumeTable(error)) return new Map()
    throw error
  }
}

function intervalEnd(start: Date, interval: OHLCVInterval): Date {
  if (interval === '1M') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()))
  }
  return new Date(start.getTime() + INTERVAL_SECONDS[interval] * 1000)
}

export async function queryTradeVolumeDetails(
  client: ClickHouseClient,
  options: { assetId: number; intervalStart: Date; interval: OHLCVInterval; limit?: number; offset?: number }
): Promise<TradeVolumeDetails> {
  const startTime = toClickHouseDateTime(options.intervalStart)
  const endTime = toClickHouseDateTime(intervalEnd(options.intervalStart, options.interval))
  const limit = options.limit ?? 200
  const offset = options.offset ?? 0
  const perAccountQuery = `
    WITH
      (SELECT min(block_height) FROM price_data.blocks
        WHERE block_timestamp >= {start_time:DateTime}
          AND block_timestamp < {end_time:DateTime}) AS from_block,
      (SELECT max(block_height) FROM price_data.blocks
        WHERE block_timestamp >= {start_time:DateTime}
          AND block_timestamp < {end_time:DateTime}) AS to_block
    SELECT
      tv.account AS account,
      sum(tv.usd_volume_buy) AS volume_buy,
      sum(tv.usd_volume_sell) AS volume_sell,
      sum(tv.usd_volume_buy) + sum(tv.usd_volume_sell) AS volume_total,
      sum(tv.usd_volume_buy) - sum(tv.usd_volume_sell) AS net_volume,
      sum(tv.trade_count) AS trade_count
    FROM price_data.trade_volume_by_account AS tv
    INNER JOIN price_data.blocks b ON tv.block_height = b.block_height
    WHERE tv.asset_id = {asset_id:UInt32}
      AND tv.block_height BETWEEN from_block AND to_block
      AND b.block_timestamp >= {start_time:DateTime}
      AND b.block_timestamp < {end_time:DateTime}
    GROUP BY tv.account
  `

  try {
    const emojiSourceReady = ensureSnakewatchEmojiSourceLoaded()
    const queryParams = {
      asset_id: options.assetId,
      start_time: startTime,
      end_time: endTime,
      limit,
      offset,
    }

    const [pageResult, totalsResult] = await Promise.all([
      client.query({
        query: `
          SELECT
            account,
            volume_buy,
            volume_sell,
            volume_total,
            net_volume,
            trade_count
          FROM (${perAccountQuery})
          ORDER BY volume_total DESC, account ASC
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        `,
        query_params: queryParams,
        format: 'JSONEachRow',
      }),
      client.query({
        query: `
          SELECT
            toString(count()) AS account_count,
            toString(sum(trade_count)) AS trade_count,
            toString(sum(volume_buy)) AS volume_buy,
            toString(sum(volume_sell)) AS volume_sell,
            toString(sum(volume_total)) AS volume_total,
            toString(sum(net_volume)) AS net_volume
          FROM (${perAccountQuery})
        `,
        query_params: queryParams,
        format: 'JSONEachRow',
      }),
    ])

    const [rows, totalsRows] = await Promise.all([
      pageResult.json<DetailRow>(),
      totalsResult.json<DetailTotalsRow>(),
    ])
    await emojiSourceReady
    const accounts = rows.map(toTrader)
    const totals = totalsRows[0]
    const accountCount = Number(totals?.account_count) || 0
    const hasMore = offset + accounts.length < accountCount

    return {
      accounts,
      accountCount,
      tradeCount: Number(totals?.trade_count) || 0,
      volumeBuy: parseNumber(totals?.volume_buy),
      volumeSell: parseNumber(totals?.volume_sell),
      volumeTotal: parseNumber(totals?.volume_total),
      netVolume: parseNumber(totals?.net_volume),
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + accounts.length : null,
    }
  } catch (error) {
    if (isMissingTradeVolumeTable(error)) {
      return {
        accounts: [],
        accountCount: 0,
        tradeCount: 0,
        volumeBuy: 0,
        volumeSell: 0,
        volumeTotal: 0,
        netVolume: 0,
        limit,
        offset,
        hasMore: false,
        nextOffset: null,
      }
    }
    throw error
  }
}
