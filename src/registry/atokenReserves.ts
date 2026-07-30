import { createClickHouseClient } from '../db/client.js'

export interface AtokenReserveRow {
  asset_address: string
  atoken: string
}

// A Hydration asset's ERC-20 precompile address is 0x…01 followed by the asset id
// in the low four bytes, so the reserve's underlying asset id is decodable from
// the address Aave was initialized with.
export function underlyingAssetIdFromReserveAddress(assetAddress: string): number | null {
  const hex = assetAddress.trim().toLowerCase()
  if (!/^0x0{31}1[0-9a-f]{8}$/.test(hex)) return null
  const assetId = Number.parseInt(hex.slice(-8), 16)
  return Number.isSafeInteger(assetId) ? assetId : null
}

// aToken contract address → the underlying asset id its reserve was initialized
// with. This is the authoritative wrapper↔base relation: symbols cannot express
// it, because several distinct assets share a symbol (four USDC ids, two EURC).
export function atokenUnderlyingsFromReserveRows(rows: AtokenReserveRow[]): Map<string, number> {
  const underlyings = new Map<string, number>()
  for (const row of rows) {
    const atoken = row.atoken?.trim().toLowerCase()
    const assetId = underlyingAssetIdFromReserveAddress(row.asset_address ?? '')
    if (!atoken || assetId == null) continue
    underlyings.set(atoken, assetId)
  }
  return underlyings
}

// The map the money-market anchor snapshot materializes from Aave's initialized
// reserves. Tiny (one row per reserve) and immutable once a reserve exists, so a
// read failure keeps the previously loaded map rather than dropping pairings.
export class AtokenReserveMap {
  private map = new Map<string, number>()

  get underlyings(): Map<string, number> {
    return this.map
  }

  async refresh(): Promise<void> {
    const client = createClickHouseClient()
    try {
      const res = await client.query({
        query: `SELECT asset_address, atoken FROM price_data.atoken_reserve_map FINAL`,
        format: 'JSONEachRow',
      })
      const loaded = atokenUnderlyingsFromReserveRows(await res.json<AtokenReserveRow>())
      if (loaded.size > 0 || this.map.size === 0) this.map = loaded
    } catch (error) {
      console.warn('[AtokenReserves] Failed to read atoken_reserve_map; keeping the previous mapping', error)
    } finally {
      await client.close()
    }
  }
}
