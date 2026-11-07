import type { ClickHouseClient } from '../db/client.ts'
import { currentPriceOf } from './explorerAssets.ts'

// A Juicer share token's CURRENT price: what one share converts to in the vault's
// collateral (CollateralVault.exchangeRate, WAD) at the collateral's current price — the
// way a stableswap share is priced at what it redeems for. The rate is the juicer-state
// refresher's pinned read, published to juicer_vault_state (018_juicer.sql) so every
// process states the same figure: the explorer's ensurePrices, the public API's
// currentPrices and the Data API's freshPriceMap. A rate older than
// JUICER_RATE_MAX_AGE_SECONDS states nothing, and the share then falls back to its
// historical alias (one collateral unit; explorerAssets PRICE_ALIAS_ID).

export const JUICER_RATE_MAX_AGE_SECONDS = 15 * 60
export interface JuicerRate { shareAssetId: number; collateralAssetId: number; rateWad: bigint; block: number }

export async function loadJuicerRates(client: ClickHouseClient): Promise<JuicerRate[]> {
  const res = await client.query({
    query: `SELECT share_asset_id, collateral_asset_id, toString(exchange_rate_wad) AS rate, block_height
            FROM price_data.juicer_vault_state FINAL
            WHERE computed_at >= now() - INTERVAL {age:UInt32} SECOND`,
    query_params: { age: JUICER_RATE_MAX_AGE_SECONDS }, format: 'JSONEachRow',
  })
  return (await res.json<{ share_asset_id: number; collateral_asset_id: number; rate: string; block_height: number }>())
    .filter(r => /^\d+$/.test(r.rate) && BigInt(r.rate) > 0n)
    .map(r => ({ shareAssetId: Number(r.share_asset_id), collateralAssetId: Number(r.collateral_asset_id), rateWad: BigInt(r.rate), block: Number(r.block_height) }))
}

/**
 * A copy of `feeds` (integer prices at any one fixed scale) with each share token's
 * price set to rate × its collateral's price, the collateral read through the map's
 * own rule (currentPriceOf: a share's entry is its redeemable value). A share whose
 * collateral is unpriced is removed rather than left at a stale feed.
 */
export function withJuicerSharePrices(feeds: ReadonlyMap<number, bigint>, rates: readonly JuicerRate[]): Map<number, bigint> {
  const out = new Map(feeds)
  for (const r of rates) {
    const collateral = currentPriceOf(feeds, r.collateralAssetId)
    if (collateral == null || collateral <= 0n) { out.delete(r.shareAssetId); continue }
    out.set(r.shareAssetId, collateral * r.rateWad / 10n ** 18n)
  }
  return out
}
