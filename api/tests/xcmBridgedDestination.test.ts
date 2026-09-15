import { describe, expect, it } from 'vitest'
import { bridgedNetworkMeta, bridgedXcmNetwork, xcmFinalBeneficiary } from '../src/services/explorerService.ts'

// A send's top-level `destination` is the first hop only. A bridge hands the assets
// to an intermediary whose own program forwards them into another consensus system,
// and only the message names that target — so a Kusama transfer read as an AssetHub
// one until the message was walked.

const consensus = (network: string) => ({ __kind: 'GlobalConsensus', value: { __kind: network } })

describe('bridgedXcmNetwork', () => {
  // The real shape of block 14,603,534 event 11: Hydration -> Polkadot AssetHub,
  // reserve-withdrawing into Kusama AssetHub.
  it('reads the target consensus out of InitiateReserveWithdraw', () => {
    expect(bridgedXcmNetwork([
      { __kind: 'WithdrawAsset' },
      { __kind: 'ClearOrigin' },
      { __kind: 'BuyExecution' },
      { __kind: 'SetAppendix' },
      { __kind: 'InitiateReserveWithdraw', reserve: { parents: 2, interior: { __kind: 'X2', value: [consensus('Kusama'), { __kind: 'Parachain', value: 1000 }] } } },
    ] as never)).toBe('Kusama')
  })

  it('reads the other forwarding instructions and ExportMessage', () => {
    expect(bridgedXcmNetwork([{ __kind: 'DepositReserveAsset', dest: { interior: { __kind: 'X1', value: [consensus('Ethereum')] } } }] as never)).toBe('Ethereum')
    expect(bridgedXcmNetwork([{ __kind: 'InitiateTeleport', dest: { interior: { __kind: 'X1', value: [consensus('Westend')] } } }] as never)).toBe('Westend')
    expect(bridgedXcmNetwork([{ __kind: 'ExportMessage', network: { __kind: 'Kusama' } }] as never)).toBe('Kusama')
  })

  // X1 is a bare object in XCM v3 and an array in v4; both must resolve.
  it('handles both X1 encodings', () => {
    expect(bridgedXcmNetwork([{ __kind: 'InitiateReserveWithdraw', reserve: { interior: { __kind: 'X1', value: consensus('Kusama') } } }] as never)).toBe('Kusama')
  })

  it('stays null for a send that never leaves this consensus', () => {
    expect(bridgedXcmNetwork([
      { __kind: 'WithdrawAsset' },
      { __kind: 'DepositAsset', beneficiary: { interior: { __kind: 'X1', value: [{ __kind: 'AccountId32', id: '0x00' }] } } },
    ] as never)).toBeNull()
    expect(bridgedXcmNetwork(undefined)).toBeNull()
    expect(bridgedXcmNetwork([])).toBeNull()
  })

  // A hash-identified chain has no name to show; AGENTS.md wants an unresolved
  // destination left explicit rather than rendered as a hex blob.
  it('leaves a genesis-identified consensus unresolved', () => {
    expect(bridgedXcmNetwork([{ __kind: 'InitiateReserveWithdraw', reserve: { interior: { __kind: 'X1', value: [{ __kind: 'GlobalConsensus', value: { __kind: 'ByGenesis', value: '0xabcd' } }] } } }] as never)).toBeNull()
  })
})

// The account the send actually pays is on its LAST hop. A bridged send's top level
// carries no DepositAsset at all — the only one there belongs to SetAppendix, which
// is the refund path that fires when the hop FAILS and pays the sender back on the
// intermediary. Reading that as the destination names the wrong account on the wrong
// chain, which is worse than naming none.
describe('xcmFinalBeneficiary', () => {
  const beneficiary = (id: string) => ({ parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountId32', id }] } })
  const ALICE = '0x' + '11'.repeat(32)
  const REFUND = '0x' + '22'.repeat(32)

  // Block 14,637,298 event 11: the beneficiary sits inside InitiateReserveWithdraw's
  // own xcm, while a SetAppendix DepositAsset sits above it.
  it('reads the final hop’s DepositAsset, not the appendix refund', () => {
    expect(xcmFinalBeneficiary([
      { __kind: 'WithdrawAsset' },
      { __kind: 'ClearOrigin' },
      { __kind: 'BuyExecution' },
      { __kind: 'SetAppendix', value: [{ __kind: 'DepositAsset', beneficiary: beneficiary(REFUND) }] },
      { __kind: 'InitiateReserveWithdraw', xcm: [
        { __kind: 'BuyExecution' },
        { __kind: 'DepositAsset', beneficiary: beneficiary(ALICE) },
      ] },
    ] as never)).toBe(ALICE)
  })

  it('reads a plain single-hop send from the top level', () => {
    expect(xcmFinalBeneficiary([
      { __kind: 'WithdrawAsset' },
      { __kind: 'BuyExecution' },
      { __kind: 'DepositAsset', beneficiary: beneficiary(ALICE) },
    ] as never)).toBe(ALICE)
  })

  it('takes an AccountKey20 beneficiary too, and nothing when there is none', () => {
    const h160 = '0x' + 'ab'.repeat(20)
    expect(xcmFinalBeneficiary([{ __kind: 'DepositAsset', beneficiary: { parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountKey20', key: h160 }] } } }] as never)).toBe(h160)
    expect(xcmFinalBeneficiary([{ __kind: 'WithdrawAsset' }, { __kind: 'Transact' }] as never)).toBeUndefined()
  })
})

// A bridged target is named by its consensus, and its accounts are encoded and
// explored on THAT chain — a Kusama address rendered at Polkadot's prefix links to
// an account that does not exist there.
describe('bridgedNetworkMeta', () => {
  it('gives a known consensus its own prefix and explorer', () => {
    expect(bridgedNetworkMeta('Kusama')).toMatchObject({ name: 'Kusama', subscan: 'https://kusama.subscan.io', ss58: 2 })
    expect(bridgedNetworkMeta('Polkadot')).toMatchObject({ subscan: 'https://polkadot.subscan.io', ss58: 0 })
  })

  it('offers no link for a consensus it cannot place', () => {
    expect(bridgedNetworkMeta('Ethereum')?.subscan).toBeUndefined()
    expect(bridgedNetworkMeta(null)).toBeUndefined()
  })
})
