import { describe, expect, it } from 'vitest'
import { atokenEquivalencesFor, lpAliasesFor, reserveAtokenIdsFor } from '../../src/registry/tracker.ts'
import type { AssetMetadata } from '../../src/registry/types.ts'
import {
  atokenReserveRefsFromRows,
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

  // The balance reader accrues an aToken's reserve index from the Pool's storage, so it
  // needs the pool proxy and the underlying address — including a non-precompile
  // underlying (HOLLAR) that the id map cannot express.
  it('maps aToken contracts to their reserve for the balance reader', () => {
    const refs = atokenReserveRefsFromRows([
      { asset_address: '0x531A654D1696ED52E7275A8CEDE955E82620F99A', atoken: '0x8C0F3B9602374198974D2B2679D14A386F5B108E', pool_proxy: '0x1B02E051683B5CFAC5929C25E84ADB26ECF87B38' },
      { asset_address: '0x0000000000000000000000000000000100000016', atoken: A_USDC },
    ])
    expect(refs.get('0x8c0f3b9602374198974d2b2679d14a386f5b108e')).toEqual({
      poolProxy: '0x1b02e051683b5cfac5929c25e84adb26ecf87b38',
      assetAddress: '0x531a654d1696ed52e7275a8cede955e82620f99a',
    })
    expect(refs.has(A_USDC)).toBe(false)
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
  const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
  const HUSDC = '0x35774c305aaf441a102d47988d35f0f5428471b3'
  const A2_POOL_PRIME = '0xc2b44f574b8c8440c0d5665f0039b49523139851'
  const BIL = '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'
  // The live registry and reserve map for every share that has a wrapper or whose
  // symbol names a registry asset (2026-09-29). The api pins the same fixture
  // (api/tests/shareWrapperRule.test.ts): both sides apply one rule.
  const live = [
    erc20(69, 'GDOT', GDOT, 18), token(690, '2-Pool-GDOT', 18),
    erc20(1110, 'HUSDC', HUSDC, 18), token(110, '2-Pool-HUSDC', 18),
    token(43, 'PRIME', 6), token(143, '2-Pool-PRIME', 18), erc20(1143, 'a2-Pool-PRIME', A2_POOL_PRIME, 18),
    erc20(55, 'BIL', BIL, 18), token(10055, '2-Pool-BIL', 18),
  ]
  const reserves = new Map([[GDOT, 690], [HUSDC, 110], [A2_POOL_PRIME, 143], [BIL, 550]])

  it('aliases a share to the aToken over it that carries its name', () => {
    expect(lpAliasesFor(live, reserves)).toEqual([[110, 1110], [690, 69]])
  })

  // 2-Pool-PRIME is PRIME + HOLLAR: the symbol names one of the pool's LEGS, not
  // its wrapper. Aliasing it published PRIME's price as the share's (1.0605 vs a
  // NAV of 1.019 on 2026-09-29; apyUSD 1.41 vs 1.009) and never wrote the share.
  it('never aliases a share to a token its symbol names but the reserve map does not', () => {
    expect(lpAliasesFor(live, reserves).some(([share]) => share === 143 || share === 10055)).toBe(false)
    // BIL is an aToken, but over uBIL (550), not over 2-Pool-BIL.
    expect(lpAliasesFor([erc20(55, 'BIL', BIL), token(10055, '2-Pool-BIL', 18)], new Map([[BIL, 550]]))).toEqual([])
  })

  // a2-Pool-PRIME IS the aToken over 2-Pool-PRIME, but it carries no product name:
  // it is an ordinary aToken, priced through the share (the aToken pairing).
  it('never aliases a share to an unnamed aToken over it', () => {
    expect(lpAliasesFor([token(143, '2-Pool-PRIME', 18), erc20(1143, 'a2-Pool-PRIME', A2_POOL_PRIME)], reserves)).toEqual([])
  })

  it('knows no wrapper without the reserve map', () => {
    expect(lpAliasesFor(live, new Map())).toEqual([])
  })

  it('leaves a wrapper whose symbol another asset also carries unaliased', () => {
    const reported: number[] = []
    const assets = [...live, token(9069, 'GDOT', 18)]
    expect(lpAliasesFor(assets, reserves, id => reported.push(id))).toEqual([[110, 1110]])
    expect(reported).toEqual([690])
  })
})

describe('reserve aTokens', () => {
  const BIL = '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'
  // BIL's symbol carries no `a` prefix, so neither pairing rule names it; only the
  // reserve map does. Unmarked, its pool balance was read from the ERC-20 slot as 0.
  it('marks every registry ERC-20 the reserve map lists as an aToken', () => {
    const assets = [erc20(55, 'BIL', BIL), erc20(1003, 'aUSDC', A_USDC), token(43, 'PRIME')]
    expect(reserveAtokenIdsFor(assets, new Map([[BIL, 550], [A_USDC, 22]]))).toEqual(new Set([55, 1003]))
  })
})
