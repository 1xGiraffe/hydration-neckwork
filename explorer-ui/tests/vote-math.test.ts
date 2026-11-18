import { describe, expect, it } from 'vitest'
import {
  ONE_HDX, amountPresets, formatHdx, formatHdxInput, formatUnits, lockBlocks, parseHdx, roundUpTenth, spendableWith,
  suggestedReserve, tallyAfter, tallyDelta, tallyShares, voteByte, voteSpec, weighted, decodeVoteByte,
} from '../src/vote/voteMath'

describe('vote arithmetic', () => {
  it('encodes the Standard vote byte as aye bit over conviction', () => {
    expect(voteByte(true, 6)).toBe(0x86)
    expect(voteByte(false, 0)).toBe(0)
    expect(decodeVoteByte(0x84)).toEqual({ aye: true, conviction: 4 })
  })

  it('weighs 0.1× for no conviction and n× above, in integers', () => {
    expect(weighted(1000n, 0)).toBe(100n)
    expect(weighted(1000n, 1)).toBe(1000n)
    expect(weighted(1000n, 6)).toBe(6000n)
  })

  it('locks the doubling periods of the pallet', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(c => lockBlocks(c as 0, 302_400) / 302_400)).toEqual([0, 1, 2, 4, 8, 16, 32])
  })

  it('counts split capital fully toward support and abstain only there (Tally::add)', () => {
    expect(tallyDelta({ kind: 'Standard', aye: true, conviction: 2, balance: 100n })).toEqual({ ayes: 200n, nays: 0n, support: 100n })
    expect(tallyDelta({ kind: 'Standard', aye: false, conviction: 2, balance: 100n })).toEqual({ ayes: 0n, nays: 200n, support: 0n })
    expect(tallyDelta({ kind: 'SplitAbstain', aye: 0n, nay: 0n, abstain: 100n })).toEqual({ ayes: 0n, nays: 0n, support: 100n })
    expect(tallyDelta({ kind: 'Split', aye: 100n, nay: 50n })).toEqual({ ayes: 10n, nays: 5n, support: 100n })
  })

  it('replaces a standing vote rather than adding to it', () => {
    const t = { ayes: 1000n, nays: 500n, support: 400n }
    const prev = voteSpec('aye', 100n, 1)
    const next = voteSpec('nay', 100n, 1)
    expect(tallyAfter(t, next, prev)).toEqual({ ayes: 900n, nays: 600n, support: 300n })
    expect(tallyShares({ ayes: 3n, nays: 1n, support: 50n }, 100n)).toEqual({ approval: 0.75, support: 0.5 })
    // Delegated votes follow a Standard vote across sides, and leave with a switch to abstain.
    const del = { votes: 500n, capital: 300n }
    expect(tallyAfter({ ayes: 1000n, nays: 0n, support: 800n }, next, prev, del)).toEqual({ ayes: 400n, nays: 600n, support: 400n })
    expect(tallyAfter({ ayes: 1000n, nays: 0n, support: 800n }, voteSpec('abstain', 100n, 0), prev, del)).toEqual({ ayes: 400n, nays: 0n, support: 500n })
  })

  it('parses HDX decimals exactly and refuses more than 12', () => {
    expect(parseHdx('1,234.5')).toBe(1234n * ONE_HDX + ONE_HDX / 2n)
    expect(parseHdx('0.000000000001')).toBe(1n)
    expect(parseHdx('0.0000000000001')).toBeNull()
    expect(parseHdx('abc')).toBeNull()
    expect(formatHdxInput(1234n * ONE_HDX + ONE_HDX / 2n)).toBe('1234.5')
    expect(formatHdx(1234567n * ONE_HDX + 123456789n, 4)).toBe('1,234,567.0001')
    expect(formatUnits(1_500_000n, 6, 2)).toBe('1.5')
  })

  it('keeps what pallet balances keeps: frozen beyond reserved, at least the existential deposit', () => {
    const a = { free: 1000n * ONE_HDX, reserved: 0n, frozen: 0n }
    expect(spendableWith(a, 998n * ONE_HDX, ONE_HDX)).toBe(2n * ONE_HDX)
    expect(spendableWith(a, 1000n * ONE_HDX, ONE_HDX)).toBe(0n)
    expect(spendableWith(a, 0n, ONE_HDX)).toBe(999n * ONE_HDX)
    // Reserved HDX covers part of a freeze.
    expect(spendableWith({ free: 800n, reserved: 200n, frozen: 0n }, 900n, 1n)).toBe(100n)
  })

  it('takes the fee off "full" only when the voting account pays it in HDX, and rounds to 0.01 HDX', () => {
    const a = { free: 1000n * ONE_HDX + 123_456_789n, reserved: 0n, frozen: 0n }
    const fee = ONE_HDX / 3n
    const own = amountPresets(a, { feeInHdxFromActor: fee, reserve: 2n * ONE_HDX })
    expect(own.full).toBe(999n * ONE_HDX + 33n * ONE_HDX / 100n)
    expect(own.almostFull).toBe(997n * ONE_HDX + 33n * ONE_HDX / 100n)
    const viaProxy = amountPresets(a, { feeInHdxFromActor: 0n, reserve: 2n * ONE_HDX })
    expect(viaProxy.full).toBe(1000n * ONE_HDX)
    expect(viaProxy.almostFull).toBe(998n * ONE_HDX)
  })

  it('suggests a reserve of 2 HDX or three rounds of fees, whichever is more', () => {
    expect(suggestedReserve(ONE_HDX / 10n, ONE_HDX / 5n)).toBe(2n * ONE_HDX)
    expect(suggestedReserve(ONE_HDX / 2n, ONE_HDX)).toBe(45n * ONE_HDX / 10n)
    expect(roundUpTenth(2_740_000_000_000n)).toBe(2_800_000_000_000n)
  })
})
