import { describe, expect, it } from 'vitest'
import {
  buildOmnipoolAccountClaims,
  type OmnipoolAssetState,
  type OwnedDecodedLpPosition,
} from '../src/services/explorerService.ts'

const FIXED = 10n ** 18n

function position(positionId: string, venue: 'Omnipool' | 'Omnipool Farm' = 'Omnipool'): OwnedDecodedLpPosition {
  return {
    positionId,
    accountId: `0x${'12'.repeat(32)}`,
    venue,
    dec: { assetId: 0, amount: 100n, shares: 100n, priceNum: FIXED, priceDen: FIXED },
  }
}

function state(hub: bigint): Map<number, OmnipoolAssetState> {
  return new Map([[0, { reserve: 1_000n, hub, shares: 1_000n }]])
}

describe('buildOmnipoolAccountClaims', () => {
  it('uses the exact integer withdrawal claim for bare and farmed positions', () => {
    const balanced = buildOmnipoolAccountClaims([position('1')], state(1_000n))[0]
    expect(balanced).toMatchObject({ positionId: '1', amount: 100n, hubAmount: 0n })

    const farmed = buildOmnipoolAccountClaims([position('2', 'Omnipool Farm')], state(2_000n))[0]
    expect(farmed).toMatchObject({ positionId: '2', venue: 'Omnipool Farm', amount: 100n, hubAmount: 66n })

    const assetShort = buildOmnipoolAccountClaims([position('3')], state(500n))[0]
    expect(assetShort).toMatchObject({ positionId: '3', amount: 66n, hubAmount: 0n })
  })

  it('rejects duplicate custody and beneficial-owner representations', () => {
    expect(() => buildOmnipoolAccountClaims([
      position('7'),
      position('7', 'Omnipool Farm'),
    ], state(1_000n))).toThrow('duplicate current Omnipool position 7')
  })

  it('rejects incomplete pool-state coverage', () => {
    expect(() => buildOmnipoolAccountClaims([position('9')], new Map()))
      .toThrow('missing current Omnipool state for asset 0')
  })
})
