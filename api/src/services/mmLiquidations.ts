import type { ClickHouseClient } from '../db/client.ts'
import { assetIdFromMmAddress } from './explorerAssets.ts'
import { loadHourlyFlowPricer, type HourlyFlowPricer } from './eventTimeCloses.ts'
import { mmEthAccountForm } from './moneyMarketHistory.ts'
import { tagged } from './queryTag.ts'

// The holders' liquidations as the LIQUIDATED user: every LiquidationCall naming one
// of their H160s (price_data.money_market_liquidation_calls, account-first, keyed on
// the pools' ETH account form), filed under the market whose pool emitted it. The
// seized collateral comes from the projection; the debt the liquidator repaid is read
// from the event itself by primary key (raw_money_market_events, (block_height,
// event_index) prefix) for just these rows. Both legs are valued at the hourly candle
// fully closed by the liquidation's block (event time), integer 1e-12 USD.

export interface MmLiquidation {
  marketKey: string
  blockHeight: number
  eventIndex: number
  /** Unix seconds of the liquidation's block. */
  ts: number
  collateralAssetId: number | null
  collateralAmount: bigint
  collateralUsd: bigint | null
  debtAssetId: number | null
  debtAmount: bigint | null
  debtUsd: bigint | null
}

interface LiquidationRow { pool: string; block_height: number; event_index: number; ts: number; asset: string; amount: string }
interface DebtRow { block_height: number; event_index: number; debt_asset: string; debt: string }

/** Rows → liquidations, newest first. Pure. A pool outside the configured markets is left out. */
export function assembleMmLiquidations(
  rows: readonly LiquidationRow[],
  debts: ReadonlyMap<string, { asset: string; amount: string }>,
  marketOfPool: (pool: string) => string | undefined,
  pricer: Pick<HourlyFlowPricer, 'usd'>,
): MmLiquidation[] {
  const out: MmLiquidation[] = []
  for (const r of rows) {
    const marketKey = marketOfPool(r.pool.toLowerCase())
    if (!marketKey) continue
    const hour = Math.floor(Number(r.ts) / 3600) * 3600
    const collateralAssetId = assetIdFromMmAddress(r.asset)
    const collateralAmount = /^\d+$/.test(r.amount) ? BigInt(r.amount) : 0n
    const debt = debts.get(`${r.block_height}:${r.event_index}`)
    const debtAssetId = debt ? assetIdFromMmAddress(debt.asset) : null
    const debtAmount = debt && /^\d+$/.test(debt.amount) ? BigInt(debt.amount) : null
    out.push({
      marketKey, blockHeight: Number(r.block_height), eventIndex: Number(r.event_index), ts: Number(r.ts),
      collateralAssetId, collateralAmount,
      collateralUsd: collateralAssetId == null ? null : pricer.usd(collateralAssetId, collateralAmount, hour),
      debtAssetId, debtAmount,
      debtUsd: debtAssetId == null || debtAmount == null ? null : pricer.usd(debtAssetId, debtAmount, hour),
    })
  }
  return out.sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
}

export async function loadMmLiquidations(
  client: ClickHouseClient,
  h160s: readonly string[],
  pools: ReadonlyArray<{ poolProxy: string; marketKey: string }>,
): Promise<MmLiquidation[]> {
  const accs = [...new Set(h160s.map(h => h.toLowerCase()))].filter(h => /^0x[0-9a-f]{40}$/.test(h)).map(mmEthAccountForm)
  if (!accs.length) return []
  const res = await client.query(tagged({
    query: `-- mm:liquidations-of-user
            SELECT pool_address AS pool, block_height, event_index, toUInt32(toUnixTimestamp(block_timestamp)) AS ts,
                   asset_address AS asset, liquidated_collateral_amount AS amount
            FROM price_data.money_market_liquidation_calls FINAL
            WHERE account_id IN {accs:Array(String)}`,
    query_params: { accs },
    format: 'JSONEachRow',
  }))
  const rows = await res.json<LiquidationRow>()
  if (!rows.length) return []
  const debts = new Map<string, { asset: string; amount: string }>()
  const heights = [...new Set(rows.map(r => Number(r.block_height)))]
  const debtRes = await client.query(tagged({
    query: `-- mm:liquidation-debt-legs
            SELECT block_height, event_index,
                   lower(JSONExtractString(any(decoded_args_json), 'debtAsset')) AS debt_asset,
                   JSONExtractString(any(decoded_args_json), 'debtToCover') AS debt
            FROM price_data.raw_money_market_events
            WHERE block_height IN {heights:Array(UInt32)} AND event_name = 'LiquidationCall'
            GROUP BY block_height, event_index`,
    // By height only (the key's prefix): a block holds a handful of liquidations,
    // and the ones that are not this user's are dropped below. (An Array(Tuple)
    // parameter does not survive the client's serialisation.)
    query_params: { heights },
    format: 'JSONEachRow',
  }))
  const wanted = new Set(rows.map(r => `${r.block_height}:${r.event_index}`))
  for (const d of await debtRes.json<DebtRow>()) {
    const key = `${d.block_height}:${d.event_index}`
    if (wanted.has(key)) debts.set(key, { asset: d.debt_asset, amount: d.debt })
  }
  const marketOf = new Map(pools.map(p => [p.poolProxy.toLowerCase(), p.marketKey]))
  const flows: { assetId: number; hourSec: number }[] = []
  for (const r of rows) {
    const hourSec = Math.floor(Number(r.ts) / 3600) * 3600
    const c = assetIdFromMmAddress(r.asset)
    if (c != null) flows.push({ assetId: c, hourSec })
    const d = debts.get(`${r.block_height}:${r.event_index}`)
    const di = d ? assetIdFromMmAddress(d.asset) : null
    if (di != null) flows.push({ assetId: di, hourSec })
  }
  const pricer = await loadHourlyFlowPricer(client, flows)
  return assembleMmLiquidations(rows, debts, pool => marketOf.get(pool), pricer)
}
