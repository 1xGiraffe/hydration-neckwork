import type { ClickHouseClient } from '../db/client.ts'
import { currentPriceOf } from './explorerAssets.ts'
import { withStableswapSharePrices, type StableswapSharePool } from './lpMath.ts'
import { BIL_ASSET_ID, UBIL_ASSET_ID } from './bil.ts'
import { JUICER_VAULTS } from './juicer.ts'

// A strategy share token's CURRENT price: what one share converts to in the strategy's
// underlying (its vault's exchange rate, WAD) at that underlying's current price — the
// way a stableswap share is priced at what it redeems for. One rule for every strategy,
// read from every strategy's rate table the same way (STRATEGY_RATE_TABLES: share,
// underlying, the assets minted 1:1 over the share, the rate):
//  - Juicer's jETH at CollateralVault.exchangeRate in its collateral (juicer_vault_state);
//  - BIL's uBIL at BILVault.exchangeRate in HOLLAR, and BIL — its money market's aToken,
//    minted 1:1 over uBIL — at the same price (bil_vault_state). BIL's own market feed
//    (the BIL/HOLLAR pool's) stays its HISTORICAL series and the Data API's market price.
// Each rate is its refresher's pinned read, published so every process states the same
// figure: the explorer's ensurePrices, the public API's currentPrices and the Data API's
// freshPriceMap. A rate older than STRATEGY_RATE_MAX_AGE_SECONDS states nothing, and the
// share then falls back to its historical alias (explorerAssets PRICE_ALIAS_ID).

export const STRATEGY_RATE_MAX_AGE_SECONDS = 15 * 60
/** Every strategy's published rate table (same columns). */
export const STRATEGY_RATE_TABLES: readonly string[] = ['price_data.juicer_vault_state', 'price_data.bil_vault_state']
/** Every asset priced at a strategy vault's rate (the rate tables' share and wrapper assets). */
export const STRATEGY_SHARE_ASSET_IDS: ReadonlySet<number> = new Set([...JUICER_VAULTS.map(v => v.shareAssetId), UBIL_ASSET_ID, BIL_ASSET_ID])
export interface StrategyShareRate { shareAssetId: number; collateralAssetId: number; rateWad: bigint; block: number }

export async function loadStrategyShareRates(client: ClickHouseClient): Promise<StrategyShareRate[]> {
  const res = await client.query({
    query: STRATEGY_RATE_TABLES.map(t => `SELECT arrayJoin(arrayConcat([share_asset_id], wrapper_asset_ids)) AS share_asset_id, collateral_asset_id,
              toString(exchange_rate_wad) AS rate, block_height
            FROM ${t} FINAL
            WHERE computed_at >= now() - INTERVAL {age:UInt32} SECOND AND share_asset_id > 0`).join('\nUNION ALL\n'),
    query_params: { age: STRATEGY_RATE_MAX_AGE_SECONDS }, format: 'JSONEachRow',
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
export function withStrategySharePrices(feeds: ReadonlyMap<number, bigint>, rates: readonly StrategyShareRate[]): Map<number, bigint> {
  const out = new Map(feeds)
  for (const r of rates) {
    const collateral = currentPriceOf(feeds, r.collateralAssetId)
    if (collateral == null || collateral <= 0n) { out.delete(r.shareAssetId); continue }
    out.set(r.shareAssetId, collateral * r.rateWad / 10n ** 18n)
  }
  return out
}

/**
 * The derived current prices every surface applies over its feeds, in the ONE order that
 * is right both ways round: strategy shares first (BIL at NAV, so a pool holding it —
 * 2-Pool-BIL — redeems at NAV), then stableswap shares at what they redeem for, then the
 * strategy shares again (jETH's underlying IS a pool share, 2-Pool-GETH, priced by the
 * second step). Each step is a pure function of the map before it, so the third pass
 * only refines the shares whose underlying the second priced.
 */
export function withDerivedSharePrices(
  feeds: ReadonlyMap<number, bigint>,
  pools: Iterable<StableswapSharePool> | null,
  rates: readonly StrategyShareRate[],
  decimalsOf: (assetId: number) => number | null | undefined,
  isShare: (assetId: number) => boolean,
): Map<number, bigint> {
  const strategies = withStrategySharePrices(feeds, rates)
  const shares = withStableswapSharePrices(strategies, pools, id => currentPriceOf(strategies, id), decimalsOf, isShare)
  return withStrategySharePrices(shares, rates)
}
