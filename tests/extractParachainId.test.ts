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

  it('trims a GeneralKey to its declared length instead of its zero padding', () => {
    expect(extractAssetOrigin({
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 2030 },
          { __kind: 'GeneralKey', length: 2, data: `0x0900${'00'.repeat(30)}` },
        ],
      },
    })).toEqual({ ecosystem: 'polkadot', chainId: '2030', assetId: '0x0900' })
  })

  // Wormhole-bridged assets carry no consensus junction at all: Hydration registers
  // them under `wh` + the Wormhole chain id + the 32-byte origin-chain token id.
  // A GeneralKey's `data` is always a padded 32 bytes; `length` says how much of it
  // is the key.
  const generalKey = (key: string) => {
    const body = key.replace(/^0x/, '')
    return { __kind: 'GeneralKey', length: body.length / 2, data: `0x${body.padEnd(64, '0')}` }
  }
  const wormholeLocation = (chainIndex: bigint, token: string) => ({
    parents: 0,
    interior: {
      __kind: 'X3',
      value: [
        generalKey('0x7768'),
        { __kind: 'GeneralIndex', value: chainIndex },
        generalKey(token),
      ],
    },
  })

  it('extracts an Ethereum origin from a Wormhole location, unpadded to 20 bytes', () => {
    expect(extractAssetOrigin(wormholeLocation(2n, '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')))
      .toEqual({ ecosystem: 'ethereum', chainId: '1', assetId: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })
  })

  it('maps the Wormhole chain id to the EVM chain id — Base, not 30', () => {
    expect(extractAssetOrigin(wormholeLocation(30n, '0x00000000000000000000000060a3e35cc302bfa44cb288bc5a4f316fdb1adb42')))
      .toEqual({ ecosystem: 'ethereum', chainId: '8453', assetId: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42' })
  })

  it('extracts a Solana origin with the mint in its canonical base58 form', () => {
    expect(extractAssetOrigin(wormholeLocation(1n, '0xfcd141e9832caf10ad917495ca0f271b5b293cd47027ea737007ed40eb39a0bd')))
      .toEqual({ ecosystem: 'solana', chainId: '101', assetId: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' })
  })

  it('extracts a Sui origin, whose token ids stay 32-byte hex', () => {
    expect(extractAssetOrigin(wormholeLocation(21n, '0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3')))
      .toEqual({ ecosystem: 'sui', chainId: '0x35834a8a', assetId: '0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3' })
  })

  it('returns null for a Wormhole chain with no known origin chain', () => {
    expect(extractAssetOrigin(wormholeLocation(9999n, '0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3'))).toBeNull()
  })

  it('ignores a local location whose leading GeneralKey is not the Wormhole marker', () => {
    expect(extractAssetOrigin({
      parents: 0,
      interior: {
        __kind: 'X3',
        value: [
          { __kind: 'GeneralKey', length: 2, data: '0x0001' },
          { __kind: 'GeneralIndex', value: 2n },
          { __kind: 'GeneralKey', length: 32, data: '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
        ],
      },
    })).toBeNull()
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
