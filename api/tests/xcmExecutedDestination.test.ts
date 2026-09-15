import { describe, expect, it } from 'vitest'
import { xcmDestinationFromCallArgs } from '../src/services/explorerService.ts'

// Hydration sets `XcmEventEmitter = ()`, so a message the xcm EXECUTOR dispatches
// leaves only XcmpQueue.XcmpMessageSent — a bare hash. Those sends get a row from
// their withdrawal, and the row had NO destination at all: no chain, no account, no
// message id. Measured above block 14,500,000: 15 of 153 outbound sends (~10%).
//
// The destination is not lost, only elsewhere — the extrinsic's own call args carry
// it, and this reads it from there.

const ALICE = '0x091cbd233fb39516ff1e26a64af98cd466e8a502c0536508cb01e9143a10519c'
const versioned = (value: unknown) => ({ __kind: 'V4', value })
const account = (id: string) => ({ parents: 0, interior: { __kind: 'X1', value: [{ __kind: 'AccountId32', id }] } })

describe('xcmDestinationFromCallArgs', () => {
  // The real shape of block 14,648,943 extrinsic 2: 9,785 DOT to Bifrost, reserve-
  // routed through AssetHub, whose beneficiary sits in customXcmOnDest.
  it('reads a transfer_assets_using_type_and_then, beneficiary and all', () => {
    expect(xcmDestinationFromCallArgs({
      dest: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 2030 }] } }),
      assetsTransferType: { __kind: 'RemoteReserve', value: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } }) },
      customXcmOnDest: versioned([{ __kind: 'DepositAsset', beneficiary: account(ALICE) }]),
    })).toMatchObject({
      destChain: 'Bifrost',
      destParachainId: 2030,
      destAccount: expect.objectContaining({ subscanUrl: expect.stringContaining('bifrost.subscan.io') }),
    })
  })

  // The older call names its beneficiary directly.
  it('reads a limited_reserve_transfer_assets’ top-level beneficiary', () => {
    expect(xcmDestinationFromCallArgs({
      dest: versioned({ parents: 1, interior: { __kind: 'X1', value: [{ __kind: 'Parachain', value: 1000 }] } }),
      beneficiary: versioned(account(ALICE)),
    })).toMatchObject({ destChain: 'AssetHub', destParachainId: 1000 })
  })

  // The version envelope is not always there, and the relay is parents:1 with no
  // Parachain junction at all.
  it('takes an unversioned location, and the relay', () => {
    expect(xcmDestinationFromCallArgs({
      dest: { parents: 1, interior: { __kind: 'Here' } },
      beneficiary: account(ALICE),
    })).toMatchObject({ destChain: 'Polkadot', destParachainId: null })
  })

  it('is null for a call that names no destination', () => {
    expect(xcmDestinationFromCallArgs({ value: '1' })).toBeNull()
    expect(xcmDestinationFromCallArgs(null)).toBeNull()
  })
})
