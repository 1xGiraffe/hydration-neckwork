import { describe, it, expect } from 'vitest'
import { localAssetId, programFacts, sqdToCodecJson } from '../src/services/xcmTrappedArrivals.ts'

// The EWT transfer that motivated this (Energy Web X → Hydration, 2026-10-23): it
// offered EWT for BuyExecution after EWT stopped being a fee currency, and the whole
// 4,927 EWT was trapped. Decoded exactly as the runtime's XcmVersionedXcm renders it.
const EWT = { parents: 1, interior: { x1: [{ parachain: 3345 }] } }
const BENEFICIARY = '0xe6ae9de080e54efa391c582a3dfe9a40a7194b98ef008cd7e7690e02093c5538'
const program = [
  { reserveAssetDeposited: [{ id: EWT, fun: { fungible: '0x000000000000010b17dc4ba29d9c0000' } }] },
  { clearOrigin: null },
  { buyExecution: { fees: { id: EWT, fun: { fungible: '0x000000000000010b17dc4ba29d9c0000' } }, weightLimit: { unlimited: null } } },
  { depositAsset: { assets: { wild: { allCounted: 1 } }, beneficiary: { parents: 0, interior: { x1: [{ accountId32: { network: null, id: BENEFICIARY } }] } } } },
  { setTopic: '0x0aea574fb8ca13d8db6d2da2c46d149d929caa667027b5c0007fd833aad3470b' },
]

describe('programFacts', () => {
  it('names the beneficiary and the fee asset location of a reserve transfer', () => {
    expect(programFacts(program)).toEqual({ beneficiary: BENEFICIARY, feeLocation: EWT })
  })

  it('reads v3 shapes: a concrete asset id and a single junction as an object', () => {
    const v3 = [
      { buyExecution: { fees: { id: { concrete: { parents: 1, interior: { x1: { parachain: 3345 } } } } } } },
      { depositAsset: { beneficiary: { parents: 0, interior: { x1: { accountKey20: { key: '0x00302167F9597B9D90BD342311C5C4BE39BF0FA0' } } } } } },
    ]
    expect(programFacts(v3)).toEqual({
      beneficiary: '0x4554480000302167f9597b9d90bd342311c5c4be39bf0fa00000000000000000',
      feeLocation: EWT,
    })
  })

  it('reads a v5 PayFees as the fee asset', () => {
    expect(programFacts([{ payFees: { asset: { id: EWT, fun: { fungible: '0x01' } } } }]).feeLocation).toEqual(EWT)
  })

  it('names nobody when the program deposits nowhere local', () => {
    expect(programFacts([{ depositAsset: { beneficiary: { parents: 1, interior: { x1: [{ parachain: 1000 }] } } } }]).beneficiary).toBeNull()
  })
})

describe('sqdToCodecJson', () => {
  it('turns sqd enum variants into the keyed shape codecs take', () => {
    expect(sqdToCodecJson({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 3345 }] } })).toEqual(EWT)
    expect(sqdToCodecJson({ parents: 1, interior: { __kind: 'Here' } })).toEqual({ parents: 1, interior: { here: null } })
    expect(sqdToCodecJson({ __kind: 'AccountId32', network: null, id: '0x01' })).toEqual({ accountId32: { network: null, id: '0x01' } })
  })
})

describe('localAssetId', () => {
  // Bifrost sends native HDX back as GeneralIndex 0 — a location the registry, which
  // maps foreign assets only, has no entry for: 1,070 trapped arrivals read blank.
  it('reads Hydration-own assets by GeneralIndex, from here or via the relay', () => {
    expect(localAssetId({ parents: 0, interior: { x1: [{ generalIndex: 0 }] } })).toBe(0)
    expect(localAssetId({ parents: 0, interior: { x1: { generalIndex: '222' } } })).toBe(222)
    expect(localAssetId({ parents: 1, interior: { x2: [{ parachain: 2034 }, { generalIndex: 5 }] } })).toBe(5)
  })

  it('leaves foreign locations to the registry', () => {
    expect(localAssetId(EWT)).toBeNull()
    expect(localAssetId({ parents: 1, interior: { x2: [{ parachain: 1000 }, { generalIndex: 1984 }] } })).toBeNull()
    expect(localAssetId({ parents: 1, interior: { here: null } })).toBeNull()
  })
})
