import { describe, expect, it } from 'vitest'
import {
  buildOmnipoolOwnerIntervals,
  LM_PALLET_ACCOUNT,
  type OwnerLifecycleEvent,
} from '../src/services/omnipoolOwnerIntervals.ts'

const USER = `0x${'11'.repeat(32)}`
const USER2 = `0x${'22'.repeat(32)}`

function ev(o: Partial<OwnerLifecycleEvent>): OwnerLifecycleEvent {
  return { kind: 'nft_issue', block: 0, extrinsic: 0, event: 0, ts: 0, ...o } as OwnerLifecycleEvent
}

describe('buildOmnipoolOwnerIntervals', () => {
  it('opens a bare interval on 1337 issue and closes it on burn', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '1337', item: '5', owner: USER, block: 10, event: 1 }),
      ev({ kind: 'nft_burn', collection: '1337', item: '5', owner: USER, block: 20, event: 1 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ accountId: USER, positionId: '5', ownershipKind: 'bare' })
    expect(out[0].validFrom.block).toBe(10)
    expect(out[0].validTo?.block).toBe(20)
  })

  it('leaves a still-held bare position open (validTo null)', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '1337', item: '7', owner: USER, block: 10, event: 1 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].validTo).toBeNull()
  })

  it('models a same-extrinsic bare->farmed handoff as two adjacent segments, same owner', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '1337', item: '72527', owner: USER, block: 100, extrinsic: 2, event: 5 }),
      ev({ kind: 'nft_transfer', collection: '1337', item: '72527', from: USER, to: LM_PALLET_ACCOUNT, block: 100, extrinsic: 2, event: 21 }),
      ev({ kind: 'nft_issue', collection: '2584', item: '76777', owner: USER, block: 100, extrinsic: 2, event: 22 }),
      ev({ kind: 'shares_deposited', depositId: '76777', positionId: '72527', owner: USER, block: 100, extrinsic: 2, event: 23 }),
    ])
    const bare = out.find(o => o.ownershipKind === 'bare')!
    const farmed = out.find(o => o.ownershipKind === 'farmed')!
    expect(bare.accountId).toBe(USER)
    expect(farmed.accountId).toBe(USER)
    expect(bare.validTo).toEqual(expect.objectContaining({ block: 100, event: 21 }))
    expect(farmed.validFrom.event).toBeGreaterThanOrEqual(22)
    expect(farmed.depositId).toBe('76777')
    // Exactly the farmed segment is active at END of block 100 (no temp zero / double count).
    const activeAtEnd = out.filter(o => o.validFrom.block <= 100 && (o.validTo === null || o.validTo.block > 100))
    expect(activeAtEnd).toEqual([farmed])
  })

  it('does not attribute a bare interval to the LM pallet custody address', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '1337', item: '8', owner: USER, block: 5, event: 1 }),
      ev({ kind: 'nft_transfer', collection: '1337', item: '8', from: USER, to: LM_PALLET_ACCOUNT, block: 10, event: 1 }),
    ])
    expect(out.every(o => o.accountId !== LM_PALLET_ACCOUNT)).toBe(true)
    const bare = out.find(o => o.accountId === USER)!
    expect(bare.validTo?.block).toBe(10)
  })

  it('redeposit into a second farm does not open a new interval', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '2584', item: '9', owner: USER, block: 5, event: 1 }),
      ev({ kind: 'shares_deposited', depositId: '9', positionId: '42', owner: USER, block: 5, event: 2 }),
      ev({ kind: 'shares_redeposited', depositId: '9', positionId: '42', owner: USER, block: 30, event: 2 }),
    ])
    expect(out.filter(o => o.positionId === '42')).toHaveLength(1)
    expect(out[0].validTo).toBeNull()
  })

  it('follows the deposit NFT to a new owner (deposit transfer)', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '2584', item: '9', owner: USER, block: 5, event: 1 }),
      ev({ kind: 'shares_deposited', depositId: '9', positionId: '42', owner: USER, block: 5, event: 2 }),
      ev({ kind: 'nft_transfer', collection: '2584', item: '9', from: USER, to: USER2, block: 40, event: 1 }),
    ])
    const forUser = out.find(o => o.accountId === USER && o.positionId === '42')!
    const forUser2 = out.find(o => o.accountId === USER2 && o.positionId === '42')!
    expect(forUser.validTo?.block).toBe(40)
    expect(forUser2.validFrom.block).toBe(40)
    expect(forUser2.ownershipKind).toBe('farmed')
  })

  it('closes the farmed interval on deposit destroyed', () => {
    const out = buildOmnipoolOwnerIntervals([
      ev({ kind: 'nft_issue', collection: '2584', item: '9', owner: USER, block: 5, event: 1 }),
      ev({ kind: 'shares_deposited', depositId: '9', positionId: '42', owner: USER, block: 5, event: 2 }),
      ev({ kind: 'deposit_destroyed', depositId: '9', owner: USER, block: 50, event: 3 }),
    ])
    const farmed = out.find(o => o.positionId === '42')!
    expect(farmed.validTo?.block).toBe(50)
  })

  it('is deterministic under event reordering (replay-safe)', () => {
    const events = [
      ev({ kind: 'nft_issue', collection: '1337', item: '5', owner: USER, block: 10, event: 1 }),
      ev({ kind: 'nft_burn', collection: '1337', item: '5', owner: USER, block: 20, event: 1 }),
    ]
    const a = buildOmnipoolOwnerIntervals(events)
    const b = buildOmnipoolOwnerIntervals([...events].reverse())
    expect(a).toEqual(b)
  })
})
