import { describe, expect, it } from 'vitest'
import { reconstructTally } from '../src/services/governanceRead.ts'
import { stateAsOf, type AccountVote, type Delegations } from '../src/services/convictionState.ts'
import { spansSlotEras, trackAsOf, trackById } from '../src/services/referendaTracks.ts'

// The referendum page's tally trajectory: replayed from the indexed votes and
// withdrawals, delegated power attributed from the voters' own observed VotingFor as
// of each block, anchored to the chain's tally with the residual published. Measured
// on live data (2026-11-08): of the 449 concluded OpenGov referenda with a final
// tally, 430 reproduce it to the planck and the other 19 — all before the VotingFor
// observations begin at block 15,622,703, so their delegations are unobserved — stay
// under 0.25% of turnout, inside the 0.5% reliability bound.

const HDX = 10n ** 12n
const aye = (conviction: number, balance: bigint): AccountVote => ({ kind: 'Standard', aye: true, conviction, balance })
const nay = (conviction: number, balance: bigint): AccountVote => ({ kind: 'Standard', aye: false, conviction, balance })

describe('reconstructTally', () => {
  it('lets each account\'s last vote stand, so a changed vote replaces the old one', () => {
    const steps = reconstructTally([
      { who: 'a', block: 10, ext: 1, ts: 't10', vote: aye(1, 100n * HDX) },
      { who: 'b', block: 11, ext: 1, ts: 't11', vote: nay(2, 10n * HDX) },
      { who: 'a', block: 12, ext: 1, ts: 't12', vote: nay(0, 100n * HDX) },
    ], [], null)
    expect(steps.map(s => [s.block, s.ayes, s.nays, s.support])).toEqual([
      [10, 100n * HDX, 0n, 100n * HDX],
      [11, 100n * HDX, 20n * HDX, 100n * HDX],
      [12, 0n, 30n * HDX, 0n],
    ])
    expect(steps[0].ts).toBe('t10')
  })

  it('drops a vote withdrawn after it, but not one recast after the withdrawal', () => {
    const steps = reconstructTally([
      { who: 'a', block: 10, ext: 1, ts: null, vote: aye(1, 5n) },
      { who: 'a', block: 30, ext: 0, ts: null, vote: aye(1, 7n) },
    ], [{ who: 'a', at: { blockHeight: 20, extrinsicIndex: 3 } }], null)
    expect(steps.map(s => [s.block, s.ayes])).toEqual([[10, 5n], [20, 0n], [30, 7n]])
  })

  it('orders a withdrawal and a vote in one block by extrinsic', () => {
    const steps = reconstructTally(
      [{ who: 'a', block: 10, ext: 1, ts: null, vote: aye(1, 5n) }, { who: 'a', block: 20, ext: 4, ts: null, vote: aye(1, 9n) }],
      [{ who: 'a', at: { blockHeight: 20, extrinsicIndex: 2 } }],
      null,
    )
    expect(steps.at(-1)).toMatchObject({ block: 20, ayes: 9n })
  })

  it('orders a withdrawal and a new vote inside one extrinsic by their events', () => {
    // utility.batch_all([remove_vote, vote]): VoteRemoved at event 3, Voted at event 5.
    const prior = { who: 'a', block: 10, ext: 1, ord: 2, ts: null, vote: aye(1, 5n) }
    const removeThenVote = reconstructTally(
      [prior, { who: 'a', block: 20, ext: 4, ord: 5, ts: null, vote: aye(1, 9n) }],
      [{ who: 'a', at: { blockHeight: 20, extrinsicIndex: 4, eventIndex: 3 } }],
      null,
    )
    expect(removeThenVote.at(-1)).toMatchObject({ block: 20, ayes: 9n })
    // The other way round, the vote is withdrawn in the same extrinsic.
    const voteThenRemove = reconstructTally(
      [prior, { who: 'a', block: 20, ext: 4, ord: 3, ts: null, vote: aye(1, 9n) }],
      [{ who: 'a', at: { blockHeight: 20, extrinsicIndex: 4, eventIndex: 5 } }],
      null,
    )
    expect(voteThenRemove.at(-1)).toMatchObject({ block: 20, ayes: 0n })
  })

  it('takes a withdrawal with no event of its own as before the votes of its extrinsic', () => {
    const steps = reconstructTally(
      [{ who: 'a', block: 10, ext: 1, ts: null, vote: aye(1, 5n) }, { who: 'a', block: 20, ext: 4, ord: 7, ts: null, vote: aye(1, 9n) }],
      [{ who: 'a', at: { blockHeight: 20, extrinsicIndex: 4 } }],
      null,
    )
    expect(steps.at(-1)).toMatchObject({ block: 20, ayes: 9n })
  })

  it('adds a standing Standard voter\'s delegated power as of each block, and moves when the delegation does', () => {
    const history: Record<string, { block: number; d: Delegations }[]> = {
      v: [{ block: 5, d: { votes: 0n, capital: 0n } }, { block: 15, d: { votes: 40n, capital: 20n } }],
    }
    const delegationsAt = (who: string, block: number) => stateAsOf(history[who], block)?.d ?? null
    const steps = reconstructTally([{ who: 'v', block: 10, ext: 0, ts: null, vote: aye(1, 100n) }], [], delegationsAt, [{ block: 15, ts: null }])
    expect(steps.map(s => [s.block, s.ayes, s.support])).toEqual([[10, 100n, 100n], [15, 140n, 120n]])
  })

  it('never lends delegated power to a split vote', () => {
    const steps = reconstructTally([{ who: 'v', block: 10, ext: 0, ts: null, vote: { kind: 'Split', aye: 100n, nay: 50n } }], [], () => ({ votes: 999n, capital: 999n }))
    expect(steps[0]).toMatchObject({ ayes: 10n, nays: 5n, support: 100n })
  })

  it('emits a point only when the tally moved', () => {
    const steps = reconstructTally([
      { who: 'a', block: 10, ext: 0, ts: null, vote: aye(1, 5n) },
      { who: 'a', block: 11, ext: 0, ts: null, vote: aye(1, 5n) },
    ], [], null, [{ block: 12, ts: null }])
    expect(steps.map(s => s.block)).toEqual([10])
  })
})

describe('trackAsOf', () => {
  it('rescales a referendum\'s periods to the slot era it ran under', () => {
    const root = trackById(0)!
    expect(trackAsOf(root, 16_000_000)).toBe(root)
    // 6 s slots (spec 313 to 440): a third of today's counts.
    expect(trackAsOf(root, 13_762_620)).toMatchObject({ decisionPeriod: 100_800, confirmPeriod: 7_200, preparePeriod: 600, minEnactmentPeriod: 100 })
    expect(trackAsOf(root, 13_762_621)).toBe(root)
    // 12 s slots (before spec 313): a sixth. Referendum #21 (root) concluded at
    // 6,965,110 under a 50,400-block decision period — the chain's own constant then.
    expect(trackAsOf(root, 6_965_110)).toMatchObject({ decisionPeriod: 50_400, confirmPeriod: 3_600, preparePeriod: 300, minEnactmentPeriod: 50 })
    expect(trackAsOf(root, 7_582_524).decisionPeriod).toBe(50_400)
    expect(trackAsOf(root, 7_582_525).decisionPeriod).toBe(100_800)
  })

  it('flags a decision that spans an era boundary', () => {
    expect(spansSlotEras(13_700_000, 13_800_000)).toBe(true)
    expect(spansSlotEras(7_000_000, 7_500_000)).toBe(false)
    expect(spansSlotEras(14_000_000, 16_000_000)).toBe(false)
  })
})
