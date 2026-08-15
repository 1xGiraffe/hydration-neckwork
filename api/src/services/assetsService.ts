import type { ClickHouseClient } from '../db/client.ts'
import type { Asset } from '../types.ts'

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
  origin_ecosystem: string | null
  origin_chain_id: string | null
  origin_asset_id: string | null
}

// Stablecoin symbols — all variants of these symbols are treated as stablecoins.
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'HOLLAR', 'DAI', 'HUSDT', 'HUSDC', 'EURC', 'HEURC'])
// Being a stablecoin is not the same as being worth a dollar: EURC tracks the euro.
// Only these can stand in for USD when a pair is denominated, since indexed prices
// are USD — a EURC-quoted series has to be computed as a ratio of the two.
//
// The `Hydrated *` money-market wrappers (HUSDT/HUSDC/HUSDS/HUSDe) are stablecoins
// but not dollars: they accrue interest, so their price leaves par and keeps going.
// Measured against their own USD candles, HUSDT went 0.9993 → 1.0195 and HUSDC
// 0.9992 → 1.0159 between 2025-09-22 and 2026-08-12, roughly 2 %/yr and unbounded.
// While HUSDT/HUSDC were listed here a pair quoted in one of them published the
// base asset's raw USD price, understating the rate by exactly that accrued
// interest (1.9 %/1.6 % as of 2026-08-12, worsening daily) — and their siblings
// HUSDS/HUSDe, same family and same drift, were never listed, so two of four got
// real cross rates and two did not. All four now take the cross path, where the
// quote's own price divides the base's. They trade against everything they quote,
// so the ratio is a real market rate, not an approximation.
const USD_PEGGED_SYMBOLS = new Set(['USDT', 'USDC', 'HOLLAR', 'DAI'])

const assetCache = new Map<number, Asset>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

async function loadAssetsUncached(client: ClickHouseClient): Promise<void> {
  const result = await client.query({
    query: `
      SELECT asset_id, symbol, name, decimals, parachain_id, origin_ecosystem, origin_chain_id, origin_asset_id
      FROM price_data.assets FINAL
      WHERE asset_id IN (
        SELECT DISTINCT asset_id FROM price_data.ohlc_1h
        WHERE interval_start >= (SELECT max(interval_start) FROM price_data.ohlc_1h) - INTERVAL 30 DAY
      )
      AND asset_id NOT IN (
        SELECT asset_id FROM (
          SELECT asset_id,
            argMax(hops, block_height) AS latest_hops,
            sum(native_volume_buy + native_volume_sell) AS total_volume
          FROM price_data.prices
          WHERE block_height >= (
            SELECT min(block_height) FROM price_data.blocks
            WHERE block_timestamp >= now() - INTERVAL 30 DAY
          )
          GROUP BY asset_id
        ) WHERE latest_hops > 0 AND total_volume = 0
      )
    `,
    format: 'JSONEachRow',
  })
  const rows = await result.json<AssetRow>()
  // Build symbol set to detect aTokens (aX → X pattern)
  const allSymbols = new Set(rows.map(r => r.symbol))
  function isAToken(symbol: string): boolean {
    if (symbol.length <= 1 || symbol[0] !== 'a') return false
    return allSymbols.has(symbol.slice(1))
  }

  assetCache.clear()
  for (const row of rows) {
    // Skip unnamed assets, LP tokens, and aTokens
    if (row.symbol.startsWith('Asset')) continue
    if (row.symbol.includes('-Pool')) continue
    if (isAToken(row.symbol)) continue

    assetCache.set(row.asset_id, {
      assetId: row.asset_id,
      symbol: row.symbol,
      name: row.name === row.symbol ? null : row.name,
      decimals: row.decimals,
      isStablecoin: STABLECOIN_SYMBOLS.has(row.symbol),
      isUsdPegged: USD_PEGGED_SYMBOLS.has(row.symbol),
      parachainId: row.parachain_id ?? null,
      origin: row.origin_ecosystem && row.origin_chain_id
        ? { ecosystem: row.origin_ecosystem, chainId: row.origin_chain_id, assetId: row.origin_asset_id ?? null }
        : null,
    })
  }
  console.log(`[Assets] Loaded ${assetCache.size} assets into cache`)

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadAssets(client).catch(err =>
        console.error('[Assets] Cache refresh failed:', err)
      )
    }, 60_000)
    refreshTimer.unref()
  }
}

export function loadAssets(client: ClickHouseClient): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadAssetsUncached(client).finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

export function stopAssetsRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function getAssetById(assetId: number): Asset | undefined {
  return assetCache.get(assetId)
}

export function getAllAssets(): Asset[] {
  return Array.from(assetCache.values())
}
