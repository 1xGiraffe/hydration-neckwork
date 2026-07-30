import { describe, it, expect } from 'vitest'
import { extractAssetOrigin, extractParachainId, isPlaceholderAssetMetadata } from '../src/registry/tracker'

describe('extractParachainId', () => {
  it('returns null for null/undefined location', () => {
    expect(extractParachainId(null)).toBeNull()
    expect(extractParachainId(undefined)).toBeNull()
  })

  it('returns null for native Hydration assets (parents: 0)', () => {
    expect(extractParachainId({ parents: 0, interior: { __kind: 'Here' } })).toBeNull()
  })

  it('returns null for native parachain token — X1(Parachain(id)) only', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: { __kind: 'Parachain', value: 1000 }
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('returns null for native parachain token — X1 array format (V5)', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'Parachain', value: 2004 }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('extracts parachainId from X2(Parachain(id), GeneralKey(...))', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 1000 },
          { __kind: 'GeneralKey', value: { length: 2, data: '0x0001' } }
        ]
      }
    }
    expect(extractParachainId(location)).toBe(1000)
  })

  it('returns null when interior is Here', () => {
    expect(extractParachainId({ parents: 1, interior: { __kind: 'Here' } })).toBeNull()
  })

  it('returns null when no Parachain junction exists', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'AccountKey20', value: '0xabc' }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })
})

describe('extractAssetOrigin', () => {
  it('extracts an Ethereum chain and canonical ERC-20 contract', () => {
    expect(extractAssetOrigin({
      parents: 2,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'GlobalConsensus', value: { __kind: 'Ethereum', value: { chainId: 1n } } },
          { __kind: 'AccountKey20', key: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
        ],
      },
    })).toEqual({
      ecosystem: 'ethereum',
      chainId: '1',
      assetId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    })
  })

  it('extracts a Polkadot parachain origin and GeneralIndex', () => {
    expect(extractAssetOrigin({
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 1000 },
          { __kind: 'GeneralIndex', value: 1337n },
        ],
      },
    })).toEqual({ ecosystem: 'polkadot', chainId: '1000', assetId: '1337' })
  })
})

describe('isPlaceholderAssetMetadata', () => {
  it('identifies generated external placeholder metadata', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'Asset1000085',
      name: 'Asset 1000085',
      assetType: 'External',
    })).toBe(true)
  })

  it('identifies generated placeholder metadata without an asset type', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'Asset1000085',
      name: 'Asset 1000085',
    })).toBe(true)
  })

  it('keeps resolved metadata even for external assets', () => {
    expect(isPlaceholderAssetMetadata({
      assetId: 1000085,
      symbol: 'WUD',
      name: 'Gavun Wud',
      assetType: 'External',
    })).toBe(false)
  })
})
