import { describe, expect, it } from 'vitest'
import {
  convictionName,
  convictionTenths,
  decodeVoteByte,
  indirectTallyFrom,
  latestVotePerAccount,
  parseReferendumPallet,
  referendumStatusFrom,
  subsquareUrl,
  tallyVoters,
  weightedVotePower,
  type ReferendumVoter,
} from '../src/services/governanceService.ts'

// A Standard AccountVote packs the side into the high bit and the conviction class
// into the low 7 bits of a single byte. Verified against live rows: byte 129 is an
// Aye at Locked1x, 134 an Aye at Locked6x, 0 a Nay with no lock.
describe('vote byte decoding', () => {
  it('splits the side from the conviction class', () => {
    expect(decodeVoteByte(128)).toEqual({ side: 'Aye', convictionIndex: 0 })
    expect(decodeVoteByte(129)).toEqual({ side: 'Aye', convictionIndex: 1 })
    expect(decodeVoteByte(134)).toEqual({ side: 'Aye', convictionIndex: 6 })
    expect(decodeVoteByte(0)).toEqual({ side: 'Nay', convictionIndex: 0 })
    expect(decodeVoteByte(3)).toEqual({ side: 'Nay', convictionIndex: 3 })
  })

  it('names each conviction class', () => {
    expect([0, 1, 6].map(convictionName)).toEqual(['None', 'Locked1x', 'Locked6x'])
    expect(convictionName(9)).toBe('Conviction 9')
  })
})

// Conviction multipliers are 0.1x with no lock and 1x..6x locked. 0.1 has no exact
// binary representation and vote weight is a financial quantity, so the multiplier
// is carried in TENTHS as integers and divided once.
describe('conviction weighting', () => {
  it('uses tenths so 0.1x needs no float', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(convictionTenths)).toEqual([1n, 10n, 20n, 30n, 40n, 50n, 60n])
  })

  it('weights a balance by its class', () => {
    const balance = 1_000_000_000_000n   // 1 HDX at 12 decimals

    expect(weightedVotePower(balance, 0)).toBe(100_000_000_000n)     // 0.1x
    expect(weightedVotePower(balance, 1)).toBe(1_000_000_000_000n)   // 1x
    expect(weightedVotePower(balance, 6)).toBe(6_000_000_000_000n)   // 6x
  })

  // The live top voter on OpenGov 368: 64944092053624824131 planck at Locked5x
  // weighed 324720460268124120655 — a 21-digit product that a double would round.
  it('stays exact on values past 2^53', () => {
    const exact = weightedVotePower(64_944_092_053_624_824_131n, 5)

    expect(exact).toBe(324_720_460_268_124_120_655n)
    // The same arithmetic in doubles loses the low digits outright, which is why
    // these weights never leave BigInt/string form.
    expect(String(exact)).toBe('324720460268124120655')
    expect(String(64_944_092_053_624_824_131 * 5)).not.toBe('324720460268124120655')
  })

  it('floors rather than drifting on a 0.1x dust vote', () => {
    expect(weightedVotePower(9n, 0)).toBe(0n)
    expect(weightedVotePower(10n, 0)).toBe(1n)
  })
})

describe('referendum identity', () => {
  // Hydration voted through both pallets and both index from 0 (Democracy 0-206,
  // OpenGov 0-369), so pallet is part of the identity, not decoration.
  it('routes each pallet to its own SubSquare path', () => {
    expect(subsquareUrl('opengov', 369)).toMatch(/\/referenda\/369$/)
    expect(subsquareUrl('democracy', 206)).toMatch(/\/democracy\/referenda\/206$/)
    expect(subsquareUrl('opengov', 0)).not.toBe(subsquareUrl('democracy', 0))
  })

  it('accepts only the two known pallets', () => {
    expect(parseReferendumPallet('opengov')).toBe('opengov')
    expect(parseReferendumPallet('democracy')).toBe('democracy')
    for (const bad of ['Referenda', 'og', '', null, undefined, 7]) expect(parseReferendumPallet(bad)).toBeNull()
  })
})

describe('referendumStatusFrom', () => {
  it('reports the most final outcome reached', () => {
    expect(referendumStatusFrom('opengov', ['Referenda.Submitted'])).toBe('submitted')
    expect(referendumStatusFrom('opengov', ['Referenda.Submitted', 'Referenda.DecisionStarted'])).toBe('deciding')
    expect(referendumStatusFrom('opengov', ['Referenda.Submitted', 'Referenda.ConfirmStarted'])).toBe('confirming')
    expect(referendumStatusFrom('opengov', ['Referenda.Submitted', 'Referenda.Rejected'])).toBe('rejected')
  })

  // A referendum that was confirmed and later had its deposit refunded must not
  // regress to "deciding" because a later event happens to be less final.
  it('is not confused by trailing housekeeping events', () => {
    expect(referendumStatusFrom('opengov', [
      'Referenda.Submitted', 'Referenda.DecisionStarted', 'Referenda.ConfirmStarted',
      'Referenda.Confirmed', 'Referenda.DecisionDepositRefunded',
    ])).toBe('approved')
  })

  it('handles the Democracy lifecycle separately', () => {
    expect(referendumStatusFrom('democracy', ['Democracy.Started'])).toBe('started')
    expect(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.Passed'])).toBe('passed')
    expect(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.NotPassed'])).toBe('not passed')
    // OpenGov events must not resolve a Democracy referendum, or vice versa.
    expect(referendumStatusFrom('democracy', ['Referenda.Confirmed'])).toBe('unknown')
  })

  it('says unknown rather than guessing', () => {
    expect(referendumStatusFrom('opengov', [])).toBe('unknown')
  })
})

// 26 of 179 accounts changed their vote on Democracy 206, and only the last one
// counts — so the tally is per ACCOUNT, not per event.
describe('latestVotePerAccount', () => {
  const row = (who: string, block_height: number, event_index: number) =>
    ({ who, block_height, event_index }) as never

  it('keeps the newest vote per account', () => {
    const kept = latestVotePerAccount([
      row('0xaa', 100, 1), row('0xaa', 200, 1), row('0xbb', 150, 1),
    ])

    expect(kept).toHaveLength(2)
    expect(kept.find(r => (r as { who: string }).who === '0xaa')).toMatchObject({ block_height: 200 })
  })

  it('breaks a same-block tie on event index', () => {
    const kept = latestVotePerAccount([row('0xaa', 100, 5), row('0xaa', 100, 9)])

    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ event_index: 9 })
  })

  it('is case-insensitive on the account and drops empty voters', () => {
    expect(latestVotePerAccount([row('0xAA', 100, 1), row('0xaa', 200, 1)])).toHaveLength(1)
    expect(latestVotePerAccount([row('', 100, 1)])).toHaveLength(0)
  })
})

const voter = (over: Partial<ReferendumVoter>): ReferendumVoter => ({
  account: null, kind: 'Standard', side: 'Aye', conviction: 'Locked1x', convictionIndex: 1,
  balance: '0', ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
  weightedAye: '0', weightedNay: '0', weighted: '0', valueUsd: null,
  blockHeight: 1, eventIndex: 0, extrinsicIndex: 0, timestamp: '', removed: false, ...over,
})

describe('tallyVoters', () => {
  it('sums weighted power per side and counts voters', () => {
    const tally = tallyVoters([
      voter({ side: 'Aye', balance: '100', weightedAye: '100', weighted: '100' }),
      voter({ side: 'Nay', balance: '50', weightedNay: '300', weighted: '300' }),
    ])

    expect(tally).toMatchObject({ ayes: '100', nays: '300', rawAyes: '100', rawNays: '50', ayeVoters: 1, nayVoters: 1, voters: 2 })
  })

  // A withdrawn vote backs nothing, so it is listed on the page but not tallied.
  it('excludes a withdrawn vote from every total', () => {
    const tally = tallyVoters([
      voter({ side: 'Aye', balance: '100', weightedAye: '100', weighted: '100' }),
      voter({ side: 'Aye', balance: '999', weightedAye: '999', weighted: '999', removed: true }),
    ])

    expect(tally).toMatchObject({ ayes: '100', rawAyes: '100', ayeVoters: 1, voters: 1 })
  })

  // A Split vote backs both sides at once and has no conviction, so it must not be
  // forced onto one side.
  it('puts a split vote on both sides and counts it once', () => {
    const tally = tallyVoters([
      voter({ kind: 'Split', side: 'Split', conviction: null, convictionIndex: null, balance: '30', ayeBalance: '10', nayBalance: '20', weightedAye: '10', weightedNay: '20', weighted: '30' }),
    ])

    expect(tally).toMatchObject({ ayes: '10', nays: '20', rawAyes: '10', rawNays: '20', ayeVoters: 0, nayVoters: 0, splitVoters: 1, voters: 1 })
  })

  it('adds exactly on 21-digit values', () => {
    const tally = tallyVoters([
      voter({ weightedAye: '324720460268124120655', weighted: '324720460268124120655' }),
      voter({ weightedAye: '1', weighted: '1' }),
    ])

    expect(tally.ayes).toBe('324720460268124120656')
  })
})

// The chain's tally includes delegated power, which emits no Voted event, so direct
// votes can only ever sum to at most the on-chain figure. Live check on OpenGov 368:
// on-chain ayes 1779098767527936185457 against 1726862239116327685341 direct.
describe('indirectTallyFrom', () => {
  it('reports the residual instead of hiding it', () => {
    const direct = tallyVoters([voter({ weightedAye: '1726862239116327685341', weighted: '1726862239116327685341' })])

    expect(indirectTallyFrom({ ayes: '1779098767527936185457', nays: '0', support: null }, direct))
      .toEqual({ ayes: '52236528411608500116', nays: '0', support: null })
  })

  it('is null when the direct votes account for everything', () => {
    const direct = tallyVoters([voter({ weightedAye: '100', weighted: '100' })])

    expect(indirectTallyFrom({ ayes: '100', nays: '0', support: null }, direct)).toBeNull()
  })

  // A direct sum above the on-chain figure would mean over-counting; clamp at zero
  // rather than rendering a negative "delegated" figure.
  it('never reports a negative residual', () => {
    const direct = tallyVoters([voter({ weightedAye: '500', weighted: '500' })])

    expect(indirectTallyFrom({ ayes: '100', nays: '0', support: null }, direct)).toBeNull()
  })

  it('is null without an on-chain tally to compare against', () => {
    expect(indirectTallyFrom(null, tallyVoters([]))).toBeNull()
  })
})
