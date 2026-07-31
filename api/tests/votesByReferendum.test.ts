import { describe, it, expect } from 'vitest'
import { aggregateVotesByReferendum, type VoteRow } from '../src/services/explorerService.ts'
import type { AccountRef, AssetRef } from '../src/services/explorerService.ts'

const HDX = { assetId: 0, iconAssetId: 0, symbol: 'HDX', name: 'Hydration', decimals: 12 } as AssetRef
const ref = (accountId: string) => ({ accountId, address: accountId, tag: null, identity: null, profile: null } as unknown as AccountRef)
const A = '0x' + '11'.repeat(32), B = '0x' + '22'.repeat(32)

function vote(over: Partial<VoteRow> & { blockHeight: number; eventIndex: number }): VoteRow {
  return {
    timestamp: '2026-07-01 00:00:00', extrinsicIndex: 1, account: ref(A),
    pallet: 'ConvictionVoting', action: 'Voted', referendum: '371', side: 'Aye', conviction: 'Locked3x',
    amount: '1000', weighted: '3000', voteRefPallet: 'opengov', voteRefTitle: 'Test ref',
    asset: HDX, valueUsd: 1,
    ...over,
  }
}

describe('aggregateVotesByReferendum', () => {
  it('folds members into one row per referendum with integer sums', () => {
    const page = aggregateVotesByReferendum([
      vote({ blockHeight: 100, eventIndex: 1, account: ref(A), amount: '1000', weighted: '6000', conviction: 'Locked6x' }),
      vote({ blockHeight: 90, eventIndex: 1, account: ref(B), amount: '500', weighted: '500', conviction: 'Locked1x' }),
      vote({ blockHeight: 80, eventIndex: 1, account: ref(A), referendum: '370', amount: '100', weighted: '100' }),
    ], 25, 0, true)
    expect(page.total).toBe(2)
    expect(page.complete).toBe(true)
    const r371 = page.rows[0]
    expect(r371.referendum).toBe('371')
    expect(r371.voters).toBe(2)
    expect(r371.weighted).toBe('6500')
    expect(r371.amount).toBe('1500')
    expect(r371.side).toBe('Aye')
    // Group moment = the newest member vote, so its link targets a real extrinsic.
    expect(r371.blockHeight).toBe(100)
  })

  it('counts only each member\'s latest vote — a re-vote replaces, never adds', () => {
    const page = aggregateVotesByReferendum([
      vote({ blockHeight: 100, eventIndex: 1, account: ref(A), weighted: '2000', amount: '1000', side: 'Nay' }),
      vote({ blockHeight: 90, eventIndex: 1, account: ref(A), weighted: '6000', amount: '1000', side: 'Aye' }),
    ], 25, 0, true)
    expect(page.rows[0].voters).toBe(1)
    expect(page.rows[0].weighted).toBe('2000')
    expect(page.rows[0].side).toBe('Nay')
  })

  it('reads Split when members diverge, keeps the cast side when they agree', () => {
    const split = aggregateVotesByReferendum([
      vote({ blockHeight: 100, eventIndex: 1, account: ref(A), side: 'Aye' }),
      vote({ blockHeight: 90, eventIndex: 1, account: ref(B), side: 'Nay' }),
    ], 25, 0, true)
    expect(split.rows[0].side).toBe('Split')
    const agree = aggregateVotesByReferendum([
      vote({ blockHeight: 100, eventIndex: 1, account: ref(A), side: 'Nay' }),
      vote({ blockHeight: 90, eventIndex: 1, account: ref(B), side: 'Nay' }),
    ], 25, 0, true)
    expect(agree.rows[0].side).toBe('Nay')
  })

  it('keeps collective and unattributable votes without weight, never a misleading zero', () => {
    const page = aggregateVotesByReferendum([
      vote({ blockHeight: 100, eventIndex: 1, account: ref(A), pallet: 'Council', referendum: '0x1234…abcd', voteRefPallet: null, conviction: null, amount: null, weighted: null, valueUsd: null }),
      vote({ blockHeight: 90, eventIndex: 2, account: null }),
      vote({ blockHeight: 90, eventIndex: 3, account: null }),
    ], 25, 0, true)
    const council = page.rows.find(r => r.pallet === 'Council')!
    expect(council.weighted).toBeNull()
    expect(council.amount).toBeNull()
    // Two unattributable votes on the same referendum stay two voters (keyed by
    // their own events) — they can never collapse into one phantom account.
    const gov = page.rows.find(r => r.referendum === '371')!
    expect(gov.voters).toBe(2)
  })

  it('paginates over the full grouped ordering', () => {
    const rows = [1, 2, 3].map(i => vote({ blockHeight: 100 - i, eventIndex: 1, referendum: String(400 - i) }))
    const p0 = aggregateVotesByReferendum(rows, 2, 0, true)
    const p1 = aggregateVotesByReferendum(rows, 2, 2, true)
    expect(p0.total).toBe(3)
    expect(p0.rows.map(r => r.referendum)).toEqual(['399', '398'])
    expect(p1.rows.map(r => r.referendum)).toEqual(['397'])
  })
})
