import { describe, expect, it } from 'vitest'
import { buildXykFarmIntervals, type XykFarmLifecycleEvent } from '../src/services/xykFarmIntervals.ts'

const USER = `0x${'11'.repeat(32)}`
const USER2 = `0x${'22'.repeat(32)}`
const ev = (o: Partial<XykFarmLifecycleEvent>): XykFarmLifecycleEvent =>
  ({ kind: 'nft_issue', depositId: '', block: 0, extrinsic: 0, event: 0, ts: 0, ...o } as XykFarmLifecycleEvent)

describe('buildXykFarmIntervals', () => {
  it('opens on 5389 issue + SharesDeposited and closes on DepositDestroyed', () => {
    const out = buildXykFarmIntervals([
      ev({ kind: 'nft_issue', depositId: '907', owner: USER, block: 100, event: 116 }),
      ev({ kind: 'shares_deposited', depositId: '907', owner: USER, lpAssetId: 1000227, principalShares: '1332604317070', block: 100, event: 117 }),
      ev({ kind: 'deposit_destroyed', depositId: '907', owner: USER, block: 200, event: 5 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ accountId: USER, depositId: '907', lpAssetId: 1000227, principalShares: '1332604317070' })
    expect(out[0].validFrom.block).toBe(100)
    expect(out[0].validTo?.block).toBe(200)
  })

  it('does not open an interval before SharesDeposited establishes the principal', () => {
    const out = buildXykFarmIntervals([
      ev({ kind: 'nft_issue', depositId: '9', owner: USER, block: 10, event: 1 }),
    ])
    expect(out).toHaveLength(0)
  })

  it('redeposit into a second yield farm does not open a new interval or add principal', () => {
    const out = buildXykFarmIntervals([
      ev({ kind: 'nft_issue', depositId: '907', owner: USER, block: 100, event: 116 }),
      ev({ kind: 'shares_deposited', depositId: '907', owner: USER, lpAssetId: 1000227, principalShares: '1332604317070', block: 100, event: 117 }),
      ev({ kind: 'shares_redeposited', depositId: '907', owner: USER, lpAssetId: 1000227, principalShares: '1332604317070', block: 100, event: 122 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].principalShares).toBe('1332604317070')
    expect(out[0].validTo).toBeNull()
  })

  it('follows the 5389 deposit NFT to a new owner (transfer), same principal', () => {
    const out = buildXykFarmIntervals([
      ev({ kind: 'nft_issue', depositId: '5', owner: USER, block: 10, event: 1 }),
      ev({ kind: 'shares_deposited', depositId: '5', owner: USER, lpAssetId: 42, principalShares: '1000', block: 10, event: 2 }),
      ev({ kind: 'nft_transfer', depositId: '5', from: USER, to: USER2, block: 50, event: 1 }),
    ])
    const a = out.find(o => o.accountId === USER)!
    const b = out.find(o => o.accountId === USER2)!
    expect(a.validTo?.block).toBe(50)
    expect(b.validFrom.block).toBe(50)
    expect(b.principalShares).toBe('1000')
    expect(b.lpAssetId).toBe(42)
  })

  it('is deterministic under event reordering (replay-safe)', () => {
    const events = [
      ev({ kind: 'nft_issue', depositId: '5', owner: USER, block: 10, event: 1 }),
      ev({ kind: 'shares_deposited', depositId: '5', owner: USER, lpAssetId: 42, principalShares: '1000', block: 10, event: 2 }),
      ev({ kind: 'nft_burn', depositId: '5', owner: USER, block: 20, event: 1 }),
    ]
    expect(buildXykFarmIntervals(events)).toEqual(buildXykFarmIntervals([...events].reverse()))
  })
})
