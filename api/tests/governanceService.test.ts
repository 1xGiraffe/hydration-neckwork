import { describe, expect, it } from 'vitest'
import {
  convictionName,
  convictionTenths,
  decodeVoteByte,
  indirectTallyFrom,
  isAfter,
  isConcludingEvent,
  latestVotePerAccount,
  parseReferendumPallet,
  referendumStatusFrom,
  subsquareUrl,
  tallyFromArgs,
  tallyVoters,
  toVoter,
  weightedVotePower,
  type ReferendumVoter,
  type VoteEventRow,
  type VotePosition,
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
// votes can only ever sum to at most the on-chain figure. Live check on OpenGov 39:
// on-chain ayes 1374035885979727209137 against 1371548208681485335833 direct.
describe('indirectTallyFrom', () => {
  it('reports the residual instead of hiding it', () => {
    const direct = tallyVoters([voter({ weightedAye: '1371548208681485335833', weighted: '1371548208681485335833' })])

    expect(indirectTallyFrom({ ayes: '1374035885979727209137', nays: '0', support: null }, direct))
      .toEqual({ ayes: '2487677298241873304', nays: '0', support: null })
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

// A Split/SplitAbstain vote carries no conviction, and in both pallets "no conviction"
// means Conviction::None — the 0.1x class, not an unweighted balance. `Tally::add` runs
// each leg through `Conviction::None.votes(balance)` (capital / 10).
//
// Checked against the chain: Democracy 151's split voter put 150000000000000000 on each
// side, and the chain's nay tally at block 5270399 (the last block before the close) is
// 794600000000000000 — reachable only with the nay leg at 15000000000000000.
describe('split vote weighting', () => {
  const row = (over: Partial<VoteEventRow>): VoteEventRow => ({
    block_height: 5_270_300, event_index: 4, extrinsic_index: 2, ts: '2024-01-01 00:00:00',
    who: '0x'.padEnd(66, 'a'), kind: 'Standard', vote_byte: 129,
    balance: '0', aye: '0', nay: '0', abstain: '0', removed: 0, ...over,
  })
  const none = new Map<string, VotePosition>()

  it('weights each leg at 0.1x', () => {
    const split = toVoter(row({ kind: 'Split', aye: '150000000000000000', nay: '150000000000000000' }), none, null, 12)

    expect(split.weightedAye).toBe('15000000000000000')
    expect(split.weightedNay).toBe('15000000000000000')
    // The capital behind the vote is the full balance either way — only the VOTES scale.
    expect(split.balance).toBe('300000000000000000')
    expect(split.conviction).toBeNull()
  })

  it('leaves the abstain leg backing neither side but inside the capital', () => {
    const vote = toVoter(row({ kind: 'SplitAbstain', aye: '10000000000000', nay: '0', abstain: '990000000000000' }), none, null, 12)

    expect(vote.weightedAye).toBe('1000000000000')
    expect(vote.weightedNay).toBe('0')
    expect(vote.balance).toBe('1000000000000000')
  })

  it('is the same arithmetic weightedVotePower does for the None class', () => {
    const split = toVoter(row({ kind: 'Split', aye: '1000000000000000000', nay: '7' }), none, null, 12)

    expect(split.weightedAye).toBe(weightedVotePower(1_000_000_000_000_000_000n, 0).toString())
    // Floors, like every other 0.1x vote: 7 planck at 0.1x is 0, not 0.7.
    expect(split.weightedNay).toBe('0')
  })

  it('still weights a Standard vote by its own conviction class', () => {
    const aye = toVoter(row({ vote_byte: 134, balance: '222222000000000000' }), none, null, 12)

    expect(aye.side).toBe('Aye')
    expect(aye.conviction).toBe('Locked6x')
    expect(aye.weightedAye).toBe('1333332000000000000')
  })
})

// A withdrawal only cancels a vote cast BEFORE it. Democracy 206 has an account that
// removed its vote at block 7435528 and voted again at 7435531; the chain counted that
// second vote, and a set of "accounts that ever removed" would have dropped it. Six of the
// seven removers on that referendum did not come back, and excluding exactly those six
// reproduces the chain's tally at block 7451999 to the planck.
describe('withdrawal ordering', () => {
  const at = (blockHeight: number, extrinsicIndex: number | null): VotePosition => ({ blockHeight, extrinsicIndex })

  it('orders by block first, then by extrinsic within the block', () => {
    expect(isAfter(at(7_435_531, 1), at(7_435_528, 9))).toBe(true)
    expect(isAfter(at(7_435_528, 9), at(7_435_531, 1))).toBe(false)
    expect(isAfter(at(100, 4), at(100, 2))).toBe(true)
    expect(isAfter(at(100, 2), at(100, 4))).toBe(false)
    // The same extrinsic is not "after" itself, so a vote is never withdrawn by its own.
    expect(isAfter(at(100, 2), at(100, 2))).toBe(false)
  })

  it('treats a missing extrinsic index as earliest rather than as zero', () => {
    expect(isAfter(at(100, 0), at(100, null))).toBe(true)
    expect(isAfter(at(100, null), at(100, 0))).toBe(false)
  })

  const voteRow: VoteEventRow = {
    block_height: 7_435_531, event_index: 12, extrinsic_index: 2, ts: '2025-01-01 00:00:00',
    who: '0x5a1f7c909eadcc9eb86038d95f2317201198fc55298f4ef3a26b09e46fb09c4a',
    kind: 'Standard', vote_byte: 129, balance: '1000000000000000', aye: '0', nay: '0', abstain: '0', removed: 0,
  }

  it('keeps a vote recast after the removal', () => {
    const withdrawals = new Map([[voteRow.who, at(7_435_528, 2)]])

    expect(toVoter(voteRow, withdrawals, null, 12).removed).toBe(false)
  })

  it('drops a vote whose removal came later', () => {
    const withdrawals = new Map([[voteRow.who, at(7_437_561, 2)]])

    expect(toVoter(voteRow, withdrawals, null, 12).removed).toBe(true)
    // ...and a withdrawn vote is listed but not tallied.
    expect(tallyVoters([toVoter(voteRow, withdrawals, null, 12)]).ayes).toBe('0')
  })

  it('ignores a removal by some other account', () => {
    const withdrawals = new Map([['0x'.padEnd(66, 'b'), at(9_999_999, 0)]])

    expect(toVoter(voteRow, withdrawals, null, 12).removed).toBe(false)
  })
})

// Democracy.Executed is the ENACTMENT, `delay` blocks after Democracy.Passed (600 for
// referendum 0). Counting it as the conclusion dated the referendum to its enactment and
// stretched the withdrawal window past the close, where a remove_vote is only an unlock.
describe('democracy lifecycle', () => {
  it('reads the most final status, enactment included', () => {
    expect(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.Passed', 'Democracy.Executed'])).toBe('executed')
    expect(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.NotPassed'])).toBe('not passed')
    expect(referendumStatusFrom('democracy', ['Democracy.Started', 'Democracy.Cancelled'])).toBe('cancelled')
    expect(referendumStatusFrom('democracy', ['Democracy.Started'])).toBe('started')
  })

  it('does not treat the enactment as the end of the vote', () => {
    expect(isConcludingEvent('Democracy.Passed')).toBe(true)
    expect(isConcludingEvent('Democracy.NotPassed')).toBe(true)
    expect(isConcludingEvent('Democracy.Cancelled')).toBe(true)
    expect(isConcludingEvent('Democracy.Executed')).toBe(false)
  })
})

// No Democracy event carries a tally. Started is {refIndex, threshold}, Passed/NotPassed/
// Cancelled are {refIndex}, Executed is {refIndex, result} — the pallet keeps its Tally
// inside Democracy::ReferendumInfoOf while Ongoing and replaces it with Finished at the
// close. OpenGov's Referenda.* events carry one, which is why only OpenGov has an
// authoritative figure to show.
describe('on-chain tally extraction', () => {
  it('reads the tally OpenGov puts on its lifecycle events', () => {
    expect(tallyFromArgs(JSON.stringify({
      index: 368, tally: { ayes: '1779098767527936185457', nays: '102519899710184616184', support: '414293233712084572090' },
    }))).toEqual({ ayes: '1779098767527936185457', nays: '102519899710184616184', support: '414293233712084572090' })
  })

  it('finds none on any Democracy event', () => {
    for (const args of [
      { refIndex: 206, threshold: { __kind: 'SuperMajorityApprove' } },
      { refIndex: 206 },
      { refIndex: 0, result: { __kind: 'Ok' } },
    ]) expect(tallyFromArgs(JSON.stringify(args))).toBeNull()
  })

  it('rejects a malformed tally rather than coercing it', () => {
    expect(tallyFromArgs('{"tally":{"ayes":"1e21","nays":"0"}}')).toBeNull()
    expect(tallyFromArgs('{"tally":{"ayes":12,"nays":0}}')).toBeNull()
    expect(tallyFromArgs('not json')).toBeNull()
  })
})
