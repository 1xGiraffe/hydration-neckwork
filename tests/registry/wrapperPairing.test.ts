import { describe, expect, it } from 'vitest'
import { atokenEquivalencesFor, lpAliasesFor } from '../../src/registry/tracker.ts'
import type { AssetMetadata } from '../../src/registry/types.ts'
import {
  atokenUnderlyingsFromReserveRows,
  underlyingAssetIdFromReserveAddress,
} from '../../src/registry/atokenReserves.ts'

// A wrapper's pair decides which asset id receives its price and volume. Symbols
// cannot express it: the live registry has four assets called USDC and two called
// EURC, so matching by symbol alone resolved to whichever duplicate the registry
// cached first — an order that depends on the indexed range.
const token = (assetId: number, symbol: string, decimals = 6): [number, AssetMetadata] =>
  [assetId, { assetId, symbol, name: symbol, decimals, assetType: 'Token' }]
const erc20 = (assetId: number, symbol: string, evmAddress: string, decimals = 6): [number, AssetMetadata] =>
  [assetId, { assetId, symbol, name: symbol, decimals, assetType: 'Erc20', evmAddress }]

const A_USDC = '0x2ec4884088d84e5c2970a034732e5209b0acfa93'
const A_DOT = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'

// USDC(7) Acala Wormhole, USDC(21) Moonbeam Wormhole, USDC(22) AssetHub — only
// 22 is the reserve Aave initialized aUSDC against.
const usdcIds = [7, 21, 22, 1_000_766]

describe('reserve address decoding', () => {
  it('reads the underlying asset id out of the ERC-20 precompile address', () => {
    expect(underlyingAssetIdFromReserveAddress('0x0000000000000000000000000000000100000016')).toBe(22)
    expect(underlyingAssetIdFromReserveAddress('0x0000000000000000000000000000000100000005')).toBe(5)
  })

  it('rejects an address that is not a precompile', () => {
    expect(underlyingAssetIdFromReserveAddress(A_USDC)).toBeNull()
    expect(underlyingAssetIdFromReserveAddress('')).toBeNull()
  })

  it('maps aToken contracts to their underlying asset', () => {
    const map = atokenUnderlyingsFromReserveRows([
      { asset_address: '0x0000000000000000000000000000000100000016', atoken: A_USDC.toUpperCase() },
      { asset_address: 'not-an-address', atoken: '0xdead' },
    ])
    expect(map.get(A_USDC)).toBe(22)
    expect(map.has('0xdead')).toBe(false)
  })
})

describe('aToken equivalences', () => {
  const reserves = new Map([[A_USDC, 22], [A_DOT, 5]])
  const assets = (order: number[]): [number, AssetMetadata][] => {
    const all = new Map<number, [number, AssetMetadata]>([
      ...usdcIds.map(id => token(id, 'USDC')),
      token(5, 'DOT', 10),
      erc20(1003, 'aUSDC', A_USDC),
      erc20(1001, 'aDOT', A_DOT, 10),
    ].map(entry => [entry[0], entry]))
    return order.map(id => all.get(id)!)
  }
  const everyId = [...usdcIds, 5, 1003, 1001]

  it('pairs a wrapper with the reserve it was initialized against', () => {
    expect(atokenEquivalencesFor(assets(everyId), reserves)).toContainEqual([22, 1003])
  })

  it('is independent of registry insertion order', () => {
    const forward = atokenEquivalencesFor(assets(everyId), reserves)
    const reversed = atokenEquivalencesFor(assets([...everyId].reverse()), reserves)
    expect([...reversed].sort()).toEqual([...forward].sort())
  })

  it('leaves an ambiguous wrapper unpaired when no reserve maps it', () => {
    const reported: number[] = []
    const pairs = atokenEquivalencesFor(assets(everyId), new Map([[A_DOT, 5]]), id => reported.push(id))

    expect(pairs.find(([, wrapper]) => wrapper === 1003)).toBeUndefined()
    expect(reported).toEqual([1003])
  })

  it('still matches an unambiguous symbol without a reserve mapping', () => {
    expect(atokenEquivalencesFor(assets(everyId), new Map())).toContainEqual([5, 1001])
  })

  it('ignores a reserve mapping to an asset the registry does not know', () => {
    const pairs = atokenEquivalencesFor([erc20(1003, 'aUSDC', A_USDC)], reserves)
    expect(pairs).toEqual([])
  })
})

describe('LP aliases', () => {
  it('aliases a pool share to its unambiguous display asset', () => {
    const assets = [token(69, 'GDOT', 10), token(690, '2-Pool-GDOT', 18)]
    expect(lpAliasesFor(assets)).toEqual([[690, 69]])
  })

  it('leaves an ambiguous display symbol unaliased', () => {
    const reported: number[] = []
    const assets = [token(101, '2-Pool', 18), token(102, '2-Pool', 18), token(1010, '2-Pool-2-Pool', 18)]

    expect(lpAliasesFor(assets, id => reported.push(id))).toEqual([])
    expect(reported).toEqual([1010])
  })
})
