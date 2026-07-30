const ASSET_REGISTRY_METADATA_EVENTS = new Set([
  'AssetRegistry.LocationSet',
  'AssetRegistry.MetadataSet',
  'AssetRegistry.Registered',
  'AssetRegistry.Updated',
])

export function isAssetRegistryMetadataEvent(eventName: string): boolean {
  return ASSET_REGISTRY_METADATA_EVENTS.has(eventName)
}

export function hasAssetRegistryMetadataEvent(events: Array<{ name?: string }>): boolean {
  return events.some(event => event.name != null && isAssetRegistryMetadataEvent(event.name))
}
