import { describe, expect, it } from 'vitest'
import { bridgedXcmNetwork } from '../src/services/explorerService.ts'

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
