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

/**
 * Extract EVM contract address from an AssetLocation.
 * Matches: { parents: 0, interior: X1(AccountKey20 { key }) }
 * Handles both V3 (X1 = single junction) and V5 (X1 = array of junctions).
 */
function extractEvmAddress(location: any): string | null {
  if (!location || location.parents !== 0) return null
  const interior = location.interior
  if (!interior || interior.__kind !== 'X1') return null

  // V5: X1 is an array, V3: X1 is a single junction
  const junction = Array.isArray(interior.value) ? interior.value[0] : interior.value
  if (!junction || junction.__kind !== 'AccountKey20') return null
  const key = junction.key
  if (!key) return null
  // key may be Uint8Array or hex string
  if (typeof key === 'string') {
    return key.startsWith('0x') ? key.toLowerCase() : ('0x' + key).toLowerCase()
  }
  return '0x' + Buffer.from(key).toString('hex').toLowerCase()
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

    // Read AssetLocations to discover EVM contract addresses for Erc20 assets.
    // Location with parents=0, interior=X1(AccountKey20{key}) → key is the EVM address.
    const erc20AssetIds = [...discoveredAssets.entries()]
      .filter(([, m]) => m.assetType === 'Erc20')
      .map(([id]) => id)

    if (erc20AssetIds.length > 0) {
      try {
        let locationPairs: [number, any][] = []
        if (storage.assetRegistry.assetLocations.v394.is(block)) {
          locationPairs = await storage.assetRegistry.assetLocations.v394.getMany(block, erc20AssetIds)
            .then(locs => erc20AssetIds.map((id, i) => [id, locs[i]] as [number, any]))
        } else if (storage.assetRegistry.assetLocations.v244.is(block)) {
          locationPairs = await storage.assetRegistry.assetLocations.v244.getMany(block, erc20AssetIds)
            .then(locs => erc20AssetIds.map((id, i) => [id, locs[i]] as [number, any]))
        } else if (storage.assetRegistry.assetLocations.v160.is(block)) {
          locationPairs = await storage.assetRegistry.assetLocations.v160.getMany(block, erc20AssetIds)
            .then(locs => erc20AssetIds.map((id, i) => [id, locs[i]] as [number, any]))
        } else if (storage.assetRegistry.assetLocations.v108.is(block)) {
          locationPairs = await storage.assetRegistry.assetLocations.v108.getMany(block, erc20AssetIds)
            .then(locs => erc20AssetIds.map((id, i) => [id, locs[i]] as [number, any]))
        }

        for (const [assetId, location] of locationPairs) {
          const evmAddr = extractEvmAddress(location)
          if (evmAddr) {
            const meta = discoveredAssets.get(assetId)
            if (meta) meta.evmAddress = evmAddr
          }
        }
        const resolved = [...discoveredAssets.values()].filter(m => m.evmAddress)
        if (resolved.length > 0) {
          console.log(`[AssetRegistry] ERC20 addresses resolved: ${resolved.map(m => `${m.symbol}(${m.assetId})=${m.evmAddress!.slice(0, 10)}…`).join(', ')}`)
        }
      } catch (error) {
        console.warn(`[AssetRegistry] Failed to read asset locations:`, error)
      }
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
   * Auto-detect aToken ↔ base token equivalences (1:1 pairs).
   * Matches assets whose symbol starts with "a" to a base asset with the
   * remaining symbol (e.g. aDOT → DOT, aUSDT → USDT, avDOT → vDOT).
   */
  getAtokenEquivalences(): [number, number][] {
    // Build symbol → assetId lookup (first match wins for duplicate symbols)
    const symbolToId = new Map<string, number>()
    for (const [assetId, meta] of this.cache) {
      if (!symbolToId.has(meta.symbol)) {
        symbolToId.set(meta.symbol, assetId)
      }
    }

    const equivalences: [number, number][] = []
    for (const [assetId, meta] of this.cache) {
      if (meta.symbol.startsWith('a') && meta.symbol.length > 1) {
        const baseSymbol = meta.symbol.slice(1)
        const baseId = symbolToId.get(baseSymbol)
        if (baseId !== undefined && baseId !== assetId) {
          equivalences.push([baseId, assetId])
        }
      }
    }

    return equivalences
  }

  /**
   * Get the set of aToken asset IDs (derived from equivalences).
   * These are wrapper tokens whose prices should not be indexed separately.
   */
  getAtokenIds(): Set<number> {
    return new Set(this.getAtokenEquivalences().map(([, aTokenId]) => aTokenId))
  }

  /**
   * Get all ERC20 asset ID → contract address mappings.
   */
  getErc20Contracts(): Map<number, string> {
    const contracts = new Map<number, string>()
    for (const [assetId, meta] of this.cache) {
      if (meta.assetType === 'Erc20' && meta.evmAddress) {
        contracts.set(assetId, meta.evmAddress)
      }
    }
    return contracts
  }

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
