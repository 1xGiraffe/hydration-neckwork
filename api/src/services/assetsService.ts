import type { ClickHouseClient } from '../db/client.ts'
import type { Asset } from '../types.ts'

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
}

// Stablecoin symbols — all variants of these symbols are treated as stablecoins.
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'HOLLAR', 'DAI', 'HUSDT', 'HUSDC'])

const assetCache = new Map<number, Asset>()
const symbolToId = new Map<string, number>()
let refreshTimer: ReturnType<typeof setInterval> | null = null

export async function loadAssets(client: ClickHouseClient): Promise<void> {
  const result = await client.query({
    query: `
      SELECT asset_id, symbol, name, decimals, parachain_id
      FROM price_data.assets FINAL
      WHERE asset_id IN (
        SELECT DISTINCT asset_id FROM price_data.ohlc_1h
        WHERE interval_start >= (SELECT max(interval_start) FROM price_data.ohlc_1h) - INTERVAL 30 DAY
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
  symbolToId.clear()
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
      parachainId: row.parachain_id ?? null,
    })
    const key = row.symbol.toUpperCase()
    if (!symbolToId.has(key)) {
      symbolToId.set(key, row.asset_id)
    }
  }
  console.log(`[Assets] Loaded ${assetCache.size} assets into cache`)

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      loadAssets(client).catch(err =>
        console.error('[Assets] Cache refresh failed:', err)
      )
    }, 60_000)
  }
}

export function getAssetBySymbol(symbol: string): Asset | undefined {
  const id = symbolToId.get(symbol.toUpperCase())
  return id !== undefined ? assetCache.get(id) : undefined
}

export function getAssetById(assetId: number): Asset | undefined {
  return assetCache.get(assetId)
}

export function getAllAssets(): Asset[] {
  return Array.from(assetCache.values())
}
