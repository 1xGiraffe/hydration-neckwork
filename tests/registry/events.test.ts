import { describe, expect, it } from 'vitest'
import {
  hasAssetRegistryMetadataEvent,
  isAssetRegistryMetadataEvent,
} from '../../src/registry/events.ts'

describe('asset registry metadata event detection', () => {
  it('matches events that can change asset metadata used for pricing', () => {
    expect(isAssetRegistryMetadataEvent('AssetRegistry.Registered')).toBe(true)
    expect(isAssetRegistryMetadataEvent('AssetRegistry.Updated')).toBe(true)
    expect(isAssetRegistryMetadataEvent('AssetRegistry.MetadataSet')).toBe(true)
    expect(isAssetRegistryMetadataEvent('AssetRegistry.LocationSet')).toBe(true)
  })

  it('ignores registry events that do not change pricing metadata', () => {
    expect(isAssetRegistryMetadataEvent('AssetRegistry.ExistentialDepositPaid')).toBe(false)
  })

  it('detects metadata events in block event lists', () => {
    expect(hasAssetRegistryMetadataEvent([
      { name: 'Balances.Transfer' },
      { name: 'AssetRegistry.Updated' },
    ])).toBe(true)
    expect(hasAssetRegistryMetadataEvent([{ name: 'Balances.Transfer' }])).toBe(false)
  })
})
