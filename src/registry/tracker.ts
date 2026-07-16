import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import type { AssetMetadata } from './types.ts'
import type { AssetRow } from '../db/schema.ts'
import { config } from '../config.ts'

interface SnapshotOptions {
  force?: boolean
}

interface TrackerOptions {
  includeUnresolvedAssets?: boolean
}

const DEFAULT_ASSET_DECIMALS = 12

function assetRow(metadata: AssetMetadata): AssetRow {
  return {
    asset_id: metadata.assetId,
    symbol: metadata.symbol,
    name: metadata.name,
    decimals: metadata.decimals,
    parachain_id: metadata.parachainId ?? null,
    origin_ecosystem: metadata.originEcosystem ?? null,
    origin_chain_id: metadata.originChainId ?? null,
    origin_asset_id: metadata.originAssetId ?? null,
  }
}

function assetMetadataChanged(previous: AssetMetadata, current: AssetMetadata): boolean {
  return previous.symbol !== current.symbol
    || previous.name !== current.name
    || previous.decimals !== current.decimals
    || previous.parachainId !== current.parachainId
    || previous.originEcosystem !== current.originEcosystem
    || previous.originChainId !== current.originChainId
    || previous.originAssetId !== current.originAssetId
}

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
function formatAssetType(assetType: { __kind: string; value?: unknown }): string {
  if (assetType.__kind === 'PoolShare' && Array.isArray(assetType.value)) {
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
function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function locationJunctions(location: unknown): Record<string, unknown>[] {
  const locationRecord = objectRecord(location)
  const interior = objectRecord(locationRecord?.interior)
  if (interior == null || interior.__kind === 'Here') return []
  const valueRecord = objectRecord(interior.value)
  const values = Array.isArray(interior.value)
    ? interior.value
    : interior.__kind === 'X1'
      ? [interior.value]
      : valueRecord == null ? [] : Object.values(valueRecord)
  return values.map(objectRecord).filter((v): v is Record<string, unknown> => v != null)
}

function junctionPayload(junction: Record<string, unknown>): Record<string, unknown> | null {
  return objectRecord(junction.value)
}

function normalizedHex(value: unknown, bytes?: number): string | null {
  const direct = typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : null
  if (direct == null) return null
  const hex = direct.startsWith('0x') ? direct.toLowerCase() : `0x${direct.toLowerCase()}`
  return /^0x[0-9a-f]+$/.test(hex) && (bytes == null || hex.length === 2 + bytes * 2) ? hex : null
}

export interface AssetOrigin {
  ecosystem: 'polkadot' | 'ethereum'
  chainId: string
  assetId: string | null
}

// Decode the same generic origin tuple Hydration UI uses for icon lookup:
// ecosystem + chain + origin-chain asset key. This preserves Ethereum
// GlobalConsensus/AccountKey20 locations instead of reducing every origin to a
// nullable parachain id.
export function extractAssetOrigin(location: unknown): AssetOrigin | null {
  const junctions = locationJunctions(location)
  const consensus = junctions.find(j => j.__kind === 'GlobalConsensus')
  const network = consensus ? (junctionPayload(consensus) ?? consensus) : null
  const networkKind = String(network?.__kind ?? network?.type ?? '')
  if (networkKind === 'Ethereum') {
    const details = objectRecord(network?.value) ?? network
    const rawChainId = details?.chainId ?? details?.chain_id ?? details?.value
    const chainId = typeof rawChainId === 'bigint' || typeof rawChainId === 'number' || typeof rawChainId === 'string'
      ? String(rawChainId) : ''
    const account = junctions.find(j => j.__kind === 'AccountKey20')
    const accountDetails = account ? (junctionPayload(account) ?? account) : null
    const assetId = normalizedHex(accountDetails?.key, 20)
    return chainId && assetId ? { ecosystem: 'ethereum', chainId, assetId } : null
  }

  const parachainId = extractParachainId(location)
  if (parachainId == null) return null
  const originJunction = junctions.find(j => j.__kind !== 'Parachain')
  let assetId: string | null = null
  if (originJunction?.__kind === 'GeneralIndex') assetId = String(originJunction.value)
  else if (originJunction?.__kind === 'AccountKey20') {
    const details = junctionPayload(originJunction) ?? originJunction
    assetId = normalizedHex(details.key, 20)
  } else if (originJunction?.__kind === 'GeneralKey') {
    const details = junctionPayload(originJunction) ?? originJunction
    assetId = normalizedHex(details.data)
  }
  return { ecosystem: 'polkadot', chainId: String(parachainId), assetId }
}

function extractEvmAddress(location: unknown): string | null {
  const locationRecord = objectRecord(location)
  if (locationRecord?.parents !== 0) return null
  const interior = objectRecord(locationRecord.interior)
  if (interior?.__kind !== 'X1') return null

  // V5: X1 is an array, V3: X1 is a single junction
  const junction = objectRecord(Array.isArray(interior.value) ? interior.value[0] : interior.value)
  if (junction?.__kind !== 'AccountKey20') return null
  const key = junction.key
  // key may be Uint8Array or hex string
  if (typeof key === 'string') {
    const normalized = key.startsWith('0x') ? key.toLowerCase() : `0x${key.toLowerCase()}`
    return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null
  }
  if (!(key instanceof Uint8Array)) return null
  const normalized = `0x${Buffer.from(key).toString('hex').toLowerCase()}`
  return normalized.length === 42 ? normalized : null
}

/**
 * Extract parachainId from an AssetLocation.
 * Matches: { parents: 1, interior: X1(Parachain(id)) } or X2(Parachain(id), ...)
 * Native Hydration assets have no location -> returns null.
 */
export function extractParachainId(location: unknown): number | null {
  const locationRecord = objectRecord(location)
  if (locationRecord?.parents !== 1) return null
  const interior = objectRecord(locationRecord.interior)
  if (interior == null || interior.__kind === 'Here') return null

  // Normalize junctions: V5 uses arrays, V3 may use single value
  let junctions: unknown[]
  if (interior.__kind === 'X1') {
    junctions = Array.isArray(interior.value) ? interior.value : [interior.value]
  } else {
    // X2, X3, etc. — value is an array or tuple-like object
    const valueRecord = objectRecord(interior.value)
    junctions = Array.isArray(interior.value)
      ? interior.value
      : valueRecord == null
        ? []
        : Object.values(valueRecord)
  }

  const parachainJunction = junctions
    .map(objectRecord)
    .find(junction => junction?.__kind === 'Parachain')
  if (!parachainJunction) return null

  // If the only junction is Parachain, this is a native token of that chain — not bridged
  if (junctions.length === 1) return null

  return typeof parachainJunction.value === 'number' &&
    Number.isSafeInteger(parachainJunction.value) &&
    parachainJunction.value >= 0
    ? parachainJunction.value
    : null
}

async function readAssetLocations(block: Block, assetIds: number[]): Promise<Array<[number, unknown]>> {
  let locations: unknown[]
  if (storage.assetRegistry.assetLocations.v394.is(block)) {
    locations = await storage.assetRegistry.assetLocations.v394.getMany(block, assetIds)
  } else if (storage.assetRegistry.assetLocations.v244.is(block)) {
    locations = await storage.assetRegistry.assetLocations.v244.getMany(block, assetIds)
  } else if (storage.assetRegistry.assetLocations.v160.is(block)) {
    locations = await storage.assetRegistry.assetLocations.v160.getMany(block, assetIds)
  } else if (storage.assetRegistry.assetLocations.v108.is(block)) {
    locations = await storage.assetRegistry.assetLocations.v108.getMany(block, assetIds)
  } else {
    return []
  }

  return assetIds.map((assetId, index) => [assetId, locations[index]])
}

export function isPlaceholderAssetMetadata(metadata: Pick<AssetMetadata, 'assetId' | 'symbol' | 'name' | 'assetType'>): boolean {
  const hasGeneratedLabels = metadata.symbol === `Asset${metadata.assetId}` &&
    metadata.name === `Asset ${metadata.assetId}`
  return hasGeneratedLabels && (metadata.assetType == null || metadata.assetType === 'External')
}

export class AssetRegistryTracker {
  private cache: Map<number, AssetMetadata> = new Map()
  private lastSnapshotBlock: number = -1 // Force first scan
  private snapshotInterval: number
  private seededAssetRows: AssetRow[] = []
  private includeUnresolvedAssets: boolean

  constructor(snapshotInterval?: number, nativeAssetMetadata?: AssetMetadata, options: TrackerOptions = {}) {
    this.snapshotInterval = snapshotInterval ?? config.SNAPSHOT_INTERVAL
    this.includeUnresolvedAssets = options.includeUnresolvedAssets ?? true
    if (nativeAssetMetadata) {
      this.cache.set(nativeAssetMetadata.assetId, { ...nativeAssetMetadata })
      this.seededAssetRows.push({
        asset_id: nativeAssetMetadata.assetId,
        symbol: nativeAssetMetadata.symbol,
        name: nativeAssetMetadata.name,
        decimals: nativeAssetMetadata.decimals,
        parachain_id: nativeAssetMetadata.parachainId ?? null,
        origin_ecosystem: nativeAssetMetadata.originEcosystem ?? null,
        origin_chain_id: nativeAssetMetadata.originChainId ?? null,
        origin_asset_id: nativeAssetMetadata.originAssetId ?? null,
      })
    }
  }

  /**
   * Perform snapshot scan if interval has passed
   * Returns AssetRow[] for any new or changed assets (for ClickHouse persistence)
   */
  async maybeSnapshot(blockHeight: number, block: Block, options: SnapshotOptions = {}): Promise<AssetRow[]> {
    // Check if snapshot is needed
    if (!options.force && blockHeight - this.lastSnapshotBlock < this.snapshotInterval) {
      return []
    }

    console.log(`[AssetRegistry] Scanning at block ${blockHeight}${options.force ? ' (forced)' : ''}`)

    const newAssets: AssetRow[] = []
    const discoveredAssets = new Map<number, AssetMetadata>()
    let unresolvedAssetsSkipped = 0
    const addDiscoveredAsset = (metadata: AssetMetadata): void => {
      if (!this.includeUnresolvedAssets && isPlaceholderAssetMetadata(metadata)) {
        unresolvedAssetsSkipped++
        return
      }
      discoveredAssets.set(metadata.assetId, metadata)
    }
    const addModernAssets = (pairs: Array<[number, {
      symbol?: Uint8Array | string
      name?: Uint8Array | string
      decimals?: number | null
      assetType: { __kind: string; value?: unknown }
    } | undefined]>): void => {
      for (const [assetId, details] of pairs) {
        if (!details) continue
        if (details.decimals == null && !this.includeUnresolvedAssets) {
          unresolvedAssetsSkipped++
          continue
        }
        addDiscoveredAsset({
          assetId,
          symbol: decodeBytes(details.symbol).trim() || `Asset${assetId}`,
          name: decodeBytes(details.name).trim() || `Asset ${assetId}`,
          decimals: details.decimals ?? DEFAULT_ASSET_DECIMALS,
          assetType: formatAssetType(details.assetType),
        })
      }
    }

    // Strategy: Try newer versions first (v264 has everything in one place)
    // Fall back to older versions that split AssetDetails and AssetMetadata

    if (storage.assetRegistry.assets.v264.is(block)) {
      addModernAssets(await storage.assetRegistry.assets.v264.getPairs(block))
    } else if (storage.assetRegistry.assets.v222.is(block)) {
      addModernAssets(await storage.assetRegistry.assets.v222.getPairs(block))
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
        const metadataAssetIds = new Set<number>()

        for (const [assetId, metadata] of metadataPairs) {
          if (!metadata) continue
          metadataAssetIds.add(assetId)
          if (metadata.decimals == null) {
            if (!this.includeUnresolvedAssets) {
              unresolvedAssetsSkipped++
              continue
            }
          }

          const details = detailsMap.get(assetId)
          const assetMetadata: AssetMetadata = {
            assetId,
            symbol: decodeBytes(metadata.symbol).trim() || `Asset${assetId}`,
            name: details?.name || `Asset ${assetId}`,
            decimals: metadata.decimals ?? DEFAULT_ASSET_DECIMALS,
            assetType: details?.assetType,
          }

          addDiscoveredAsset(assetMetadata)
        }

        // Handle assets that have details but no metadata entry (shouldn't happen, but be defensive)
        for (const [assetId, details] of detailsMap) {
          if (!metadataAssetIds.has(assetId)) {
            if (!this.includeUnresolvedAssets) {
              console.warn(`[AssetRegistry] Asset ${assetId} has details but no metadata, skipping until decimals are known`)
              unresolvedAssetsSkipped++
            } else {
              console.warn(`[AssetRegistry] Asset ${assetId} has details but no metadata, using defaults`)
              addDiscoveredAsset({
                assetId,
                symbol: `Asset${assetId}`,
                name: details.name,
                decimals: DEFAULT_ASSET_DECIMALS,
                assetType: details.assetType,
              })
            }
          }
        }
      }
    } else {
      console.warn(`[AssetRegistry] No matching storage version at block ${blockHeight}`)
    }

    // Read every location once, then derive ERC-20 contracts and origin parachains.
    const allAssetIds = [...discoveredAssets.keys()]
    if (allAssetIds.length > 0) {
      try {
        for (const [assetId, location] of await readAssetLocations(block, allAssetIds)) {
          const metadata = discoveredAssets.get(assetId)
          if (metadata == null) continue

          if (metadata.assetType === 'Erc20') {
            metadata.evmAddress = extractEvmAddress(location) ?? undefined
          }
          metadata.parachainId = extractParachainId(location) ?? undefined
          const origin = extractAssetOrigin(location)
          metadata.originEcosystem = origin?.ecosystem
          metadata.originChainId = origin?.chainId
          metadata.originAssetId = origin?.assetId ?? undefined
        }

        const resolved = [...discoveredAssets.values()].filter(metadata => metadata.evmAddress != null)
        if (resolved.length > 0) {
          console.log(`[AssetRegistry] ERC20 addresses resolved: ${resolved.map(metadata => `${metadata.symbol}(${metadata.assetId})=${metadata.evmAddress!.slice(0, 10)}…`).join(', ')}`)
        }
      } catch (error) {
        console.warn('[AssetRegistry] Failed to read asset locations:', error)
      }
    }

    // Compare with cache and identify new/changed assets
    for (const [assetId, metadata] of discoveredAssets) {
      const existing = this.cache.get(assetId)

      if (!existing) {
        console.log(`[AssetRegistry] New asset discovered: ${assetId} (${metadata.symbol})`)
        newAssets.push(assetRow(metadata))
      } else if (assetMetadataChanged(existing, metadata)) {
        console.log(`[AssetRegistry] Asset ${assetId} metadata changed`)
        newAssets.push(assetRow(metadata))
      }

      this.cache.set(assetId, metadata)
    }

    if (this.seededAssetRows.length > 0) {
      const seenIds = new Set(newAssets.map(asset => asset.asset_id))
      for (const row of this.seededAssetRows) {
        if (!seenIds.has(row.asset_id)) {
          newAssets.push(row)
        }
      }
      this.seededAssetRows = []
    }

    this.lastSnapshotBlock = blockHeight

    const skippedSuffix = unresolvedAssetsSkipped > 0
      ? `, ${unresolvedAssetsSkipped} unresolved assets skipped`
      : ''
    console.log(`[AssetRegistry] Scan complete: ${discoveredAssets.size} total assets, ${newAssets.length} new/changed${skippedSuffix}`)

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
   * Detect stableswap LP → display token aliases via symbol pattern (e.g. 2-Pool-GDOT → GDOT).
   * Used to seed LP equivalences at startup; Aave EVM events refine at runtime.
   */
  getLpAliases(): [number, number][] {
    const symbolToId = new Map<string, number>()
    for (const [assetId, meta] of this.cache) {
      if (!symbolToId.has(meta.symbol)) {
        symbolToId.set(meta.symbol, assetId)
      }
    }

    const aliases: [number, number][] = []
    for (const [assetId, meta] of this.cache) {
      const match = meta.symbol.match(/^\d+-Pool-(.+)$/)
      if (match) {
        const displayId = symbolToId.get(match[1])
        if (displayId !== undefined && displayId !== assetId) {
          aliases.push([assetId, displayId])
        }
      }
    }

    return aliases
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

  getAssetRows(): AssetRow[] {
    return [...this.cache.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, metadata]) => ({
        asset_id: metadata.assetId,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        parachain_id: metadata.parachainId ?? null,
        origin_ecosystem: metadata.originEcosystem ?? null,
        origin_chain_id: metadata.originChainId ?? null,
        origin_asset_id: metadata.originAssetId ?? null,
      }))
  }

  getAssetsMetadata(): AssetMetadata[] {
    return [...this.cache.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, metadata]) => ({ ...metadata }))
  }

  /**
   * Update snapshot interval (used when switching between archive/live modes)
   */
  setSnapshotInterval(interval: number): void {
    this.snapshotInterval = interval
    console.log(`[AssetRegistry] Snapshot interval updated to ${interval} blocks`)
  }
}
