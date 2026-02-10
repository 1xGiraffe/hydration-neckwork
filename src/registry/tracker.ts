import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import type { AssetMetadata } from './types.ts'
import type { AssetRow } from '../db/schema.ts'
import { config } from '../config.ts'

/**
 * Decode hex-encoded bytes to UTF-8 string
 */
function decodeBytes(bytes: Uint8Array | string | undefined): string {
  if (!bytes) return ''

  if (typeof bytes === 'string') {
    if (bytes.startsWith('0x')) {
      try {
        return Buffer.from(bytes.slice(2), 'hex').toString('utf8')
      } catch {
        return bytes
      }
    }
    return bytes
  }

  // Uint8Array
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Format asset type discriminant as string
 */
function formatAssetType(assetType: { __kind: string, value?: any }): string {
  if (assetType.__kind === 'PoolShare' && assetType.value) {
    const [asset1, asset2] = assetType.value
    return `PoolShare(${asset1},${asset2})`
  }
  return assetType.__kind
}

export class AssetRegistryTracker {
  private cache: Map<number, AssetMetadata> = new Map()
  private lastSnapshotBlock: number = -1 // Force first scan
  private snapshotInterval: number

  constructor(snapshotInterval?: number) {
    this.snapshotInterval = snapshotInterval ?? config.SNAPSHOT_INTERVAL
  }

  /**
   * Perform snapshot scan if interval has passed
   * Returns AssetRow[] for any new or changed assets (for ClickHouse persistence)
   */
  async maybeSnapshot(blockHeight: number, block: Block): Promise<AssetRow[]> {
    // Check if snapshot is needed
    if (blockHeight - this.lastSnapshotBlock < this.snapshotInterval) {
      return []
    }

    console.log(`[AssetRegistry] Scanning at block ${blockHeight}`)

    const newAssets: AssetRow[] = []
    const discoveredAssets = new Map<number, AssetMetadata>()

    // Strategy: Try newer versions first (v264 has everything in one place)
    // Fall back to older versions that split AssetDetails and AssetMetadata

    if (storage.assetRegistry.assets.v264.is(block)) {
      // v264+: All metadata in AssetDetails (symbol, decimals, name all in one)
      const pairs = await storage.assetRegistry.assets.v264.getPairs(block)

      for (const [assetId, details] of pairs) {
        if (!details) continue

        const metadata: AssetMetadata = {
          assetId,
          symbol: decodeBytes(details.symbol).trim() || `Asset${assetId}`,
          name: decodeBytes(details.name).trim() || `Asset ${assetId}`,
          decimals: details.decimals ?? 12, // Default to 12 if missing
          assetType: formatAssetType(details.assetType),
        }

        discoveredAssets.set(assetId, metadata)
      }
    } else if (storage.assetRegistry.assets.v222.is(block)) {
      // v222: Similar to v264
      const pairs = await storage.assetRegistry.assets.v222.getPairs(block)

      for (const [assetId, details] of pairs) {
        if (!details) continue

        const metadata: AssetMetadata = {
          assetId,
          symbol: decodeBytes(details.symbol).trim() || `Asset${assetId}`,
          name: decodeBytes(details.name).trim() || `Asset ${assetId}`,
          decimals: details.decimals ?? 12,
          assetType: formatAssetType(details.assetType),
        }

        discoveredAssets.set(assetId, metadata)
      }
    } else if (
      storage.assetRegistry.assets.v176.is(block) ||
      storage.assetRegistry.assets.v160.is(block) ||
      storage.assetRegistry.assets.v108.is(block)
    ) {
      // v108-v176: AssetDetails has name/assetType, but symbol/decimals in separate AssetMetadataMap
      let assetDetailsPairs: [number, any][]

      if (storage.assetRegistry.assets.v176.is(block)) {
        assetDetailsPairs = await storage.assetRegistry.assets.v176.getPairs(block)
      } else if (storage.assetRegistry.assets.v160.is(block)) {
        assetDetailsPairs = await storage.assetRegistry.assets.v160.getPairs(block)
      } else {
        assetDetailsPairs = await storage.assetRegistry.assets.v108.getPairs(block)
      }

      // Build map of assetId -> name/assetType
      const detailsMap = new Map<number, { name: string, assetType: string }>()
      for (const [assetId, details] of assetDetailsPairs) {
        if (!details) continue
        detailsMap.set(assetId, {
          name: decodeBytes(details.name).trim() || `Asset ${assetId}`,
          assetType: formatAssetType(details.assetType),
        })
      }

      // Get symbol/decimals from AssetMetadataMap
      if (storage.assetRegistry.assetMetadataMap.v108.is(block)) {
        const metadataPairs = await storage.assetRegistry.assetMetadataMap.v108.getPairs(block)

        for (const [assetId, metadata] of metadataPairs) {
          if (!metadata) continue

          const details = detailsMap.get(assetId)
          const assetMetadata: AssetMetadata = {
            assetId,
            symbol: decodeBytes(metadata.symbol).trim() || `Asset${assetId}`,
            name: details?.name || `Asset ${assetId}`,
            decimals: metadata.decimals,
            assetType: details?.assetType,
          }

          discoveredAssets.set(assetId, assetMetadata)
        }

        // Handle assets that have details but no metadata entry (shouldn't happen, but be defensive)
        for (const [assetId, details] of detailsMap) {
          if (!discoveredAssets.has(assetId)) {
            console.warn(`[AssetRegistry] Asset ${assetId} has details but no metadata, using defaults`)
            discoveredAssets.set(assetId, {
              assetId,
              symbol: `Asset${assetId}`,
              name: details.name,
              decimals: 12, // Default
              assetType: details.assetType,
            })
          }
        }
      }
    } else {
      console.warn(`[AssetRegistry] No matching storage version at block ${blockHeight}`)
    }

    // Compare with cache and identify new/changed assets
    for (const [assetId, metadata] of discoveredAssets) {
      const existing = this.cache.get(assetId)

      if (!existing) {
        // New asset discovered
        console.log(`[AssetRegistry] New asset discovered: ${assetId} (${metadata.symbol})`)
        newAssets.push({
          asset_id: assetId,
          symbol: metadata.symbol,
          name: metadata.name,
          decimals: metadata.decimals,
        })
      } else if (
        existing.symbol !== metadata.symbol ||
        existing.name !== metadata.name ||
        existing.decimals !== metadata.decimals
      ) {
        // Asset metadata changed (rare, but possible)
        console.log(`[AssetRegistry] Asset ${assetId} metadata changed`)
        newAssets.push({
          asset_id: assetId,
          symbol: metadata.symbol,
          name: metadata.name,
          decimals: metadata.decimals,
        })
      }

      // Update cache
      this.cache.set(assetId, metadata)
    }

    this.lastSnapshotBlock = blockHeight

    console.log(`[AssetRegistry] Scan complete: ${discoveredAssets.size} total assets, ${newAssets.length} new/changed`)

    return newAssets
  }

  /**
   * Get decimals map for all assets (used by price calculation module)
   */
  getDecimals(): Map<number, number> {
    const decimalsMap = new Map<number, number>()
    for (const [assetId, metadata] of this.cache) {
      decimalsMap.set(assetId, metadata.decimals)
    }
    return decimalsMap
  }

  /**
   * Get metadata for a single asset
   */
  getMetadata(assetId: number): AssetMetadata | undefined {
    return this.cache.get(assetId)
  }

  /**
   * Get all cached assets
   */
  getAllAssets(): AssetMetadata[] {
    return Array.from(this.cache.values())
  }

  /**
   * Get number of assets in cache
   */
  getCacheSize(): number {
    return this.cache.size
  }

  /**
   * Update snapshot interval (used when switching between archive/live modes)
   */
  setSnapshotInterval(interval: number): void {
    this.snapshotInterval = interval
    console.log(`[AssetRegistry] Snapshot interval updated to ${interval} blocks`)
  }
}
