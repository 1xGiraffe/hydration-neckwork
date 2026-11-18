import { describe, expect, it } from 'vitest'
import {
  classRequirement, lockIdName, lockPeriods, parseAccountVote, parseOtherLocks, spendableAfterRelease, parseVotingFor, stateAsOf, unlockPlan, voteAfterLock, voteBalance, voteTally,
  type ClassVoting, type PollOutcome,
} from '../src/services/convictionState.ts'

// The conviction-voting state the governance routes read: the decoding of the raw
// indexer's VotingFor JSON, and the pallet's lock rules (galacticcouncil polkadot-sdk
// fork, conviction-voting/src/lib.rs) with Hydration's losing-side staker lock.

const V = 302_400 // VoteLockingPeriod, spec 458
const HDX = 10n ** 12n

// Shapes exactly as raw_account_state_observations stores them (live rows).
const CASTING = JSON.stringify({
  0: { __kind: 'Casting', value: { delegations: { capital: '0', votes: '0' }, prior: [21144685, '4073453069574626747'], votes: [[437, { __kind: 'Standard', balance: '4073453069574626747', vote: 133 }], [448, { __kind: 'Standard', balance: '4081272037061179561', vote: 132 }]] } },
  6: { __kind: 'Casting', value: { delegations: { capital: '0', votes: '0' }, prior: [0, '0'], votes: [] } },
  9: { __kind: 'Casting', value: { delegations: { capital: '5', votes: '50' }, prior: [20606070, '4063433397077394221'], votes: [[450, { __kind: 'SplitAbstain', aye: '1', nay: '2', abstain: '3' }]] } },
})
const DELEGATING = JSON.stringify({
  1: { __kind: 'Delegating', value: { balance: '477770000000000000', conviction: { __kind: 'Locked2x' }, delegations: { capital: '0', votes: '0' }, prior: [0, '0'], target: '0x36A164B432BF22574439119851C8A243C1CBB6FC50D0BAF4A52A9F1AEA1C835F' } },
})

describe('parseVotingFor', () => {
  it('decodes Casting classes, every AccountVote kind and the prior', () => {
    const classes = parseVotingFor(CASTING)!
    expect(classes.map(c => c.cls)).toEqual([0, 6, 9])
    const c0 = classes[0] as Extract<ClassVoting, { kind: 'casting' }>
    expect(c0.prior).toEqual({ until: 21144685, amount: 4073453069574626747n })
    expect(c0.votes[0]).toEqual({ poll: 437, vote: { kind: 'Standard', aye: true, conviction: 5, balance: 4073453069574626747n } })
    expect(c0.votes[1].vote).toMatchObject({ aye: true, conviction: 4 })
    const c9 = classes[2] as Extract<ClassVoting, { kind: 'casting' }>
    expect(c9.votes[0].vote).toEqual({ kind: 'SplitAbstain', aye: 1n, nay: 2n, abstain: 3n })
    expect(c9.delegations).toEqual({ votes: 50n, capital: 5n })
  })

  it('decodes Delegating with its target lower-cased and its conviction index', () => {
    const [d] = parseVotingFor(DELEGATING)!
    expect(d).toMatchObject({ cls: 1, kind: 'delegating', balance: 477770000000000000n, conviction: 2, target: '0x36a164b432bf22574439119851c8a243c1cbb6fc50d0baf4a52a9f1aea1c835f' })
  })

  it('reads an emptied state as no classes, and refuses a shape the pallet never produces', () => {
    expect(parseVotingFor('{}')).toEqual([])
    expect(parseVotingFor('not json')).toBeNull()
    expect(parseVotingFor(JSON.stringify({ 0: { __kind: 'Casting', value: { votes: [], prior: [0, '0'] } } }))).toBeNull() // no delegations
    expect(parseVotingFor(JSON.stringify({ 0: { __kind: 'Mystery', value: { delegations: { votes: '0', capital: '0' }, prior: [0, '0'] } } }))).toBeNull()
    expect(parseAccountVote({ __kind: 'Standard', vote: 7, balance: '1' })).toBeNull() // conviction 7 does not exist
  })
})

describe('vote arithmetic', () => {
  it('locks a vote at its balance, a split at the sum of its legs', () => {
    expect(voteBalance({ kind: 'Standard', aye: false, conviction: 3, balance: 7n })).toBe(7n)
    expect(voteBalance({ kind: 'Split', aye: 2n, nay: 3n })).toBe(5n)
    expect(voteBalance({ kind: 'SplitAbstain', aye: 2n, nay: 3n, abstain: 4n })).toBe(9n)
  })

  it('tallies conviction-weighted power, delegated power on a Standard vote only, support from aye and abstain capital', () => {
    expect(voteTally({ kind: 'Standard', aye: true, conviction: 6, balance: 10n * HDX }, { votes: 5n * HDX, capital: 2n * HDX }))
      .toEqual({ ayes: 65n * HDX, nays: 0n, support: 12n * HDX })
    expect(voteTally({ kind: 'Standard', aye: false, conviction: 0, balance: 10n * HDX }, { votes: 5n, capital: 2n }))
      .toEqual({ ayes: 0n, nays: HDX + 5n, support: 0n })
    // Split legs are 0.1x and never carry delegations.
    expect(voteTally({ kind: 'SplitAbstain', aye: 10n * HDX, nay: 20n * HDX, abstain: 30n * HDX }, { votes: 99n, capital: 99n }))
      .toEqual({ ayes: HDX, nays: 2n * HDX, support: 40n * HDX })
  })

  it('lock periods double per conviction, none for 0.1x', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(lockPeriods)).toEqual([0, 1, 2, 4, 8, 16, 32])
  })
})

describe('voteAfterLock (what removeVote moves into prior)', () => {
  const won: PollOutcome = { state: 'completed', end: 1_000, approved: true }
  const lost: PollOutcome = { state: 'completed', end: 1_000, approved: false }
  const aye3x = { kind: 'Standard' as const, aye: true, conviction: 3, balance: 100n }

  it('a winning Standard vote locks for its conviction after the end', () => {
    expect(voteAfterLock(aye3x, won, V, 0n)).toEqual({ kind: 'won', amount: 100n, untilBlock: 1_000 + 4 * V, estimate: false })
  })

  it('a losing vote locks nothing — unless the account stakes (Hydration), then the staked part', () => {
    expect(voteAfterLock(aye3x, lost, V, 0n).kind).toBe('none')
    expect(voteAfterLock(aye3x, lost, V, 40n)).toEqual({ kind: 'lost-staker', amount: 40n, untilBlock: 1_000 + 4 * V, estimate: true })
    expect(voteAfterLock(aye3x, lost, V, 500n).amount).toBe(100n) // capped at the vote
  })

  it('a split vote, a 0.1x vote and a cancelled poll lock nothing after the end', () => {
    expect(voteAfterLock({ kind: 'Split', aye: 1n, nay: 1n }, won, V, 0n).kind).toBe('none')
    expect(voteAfterLock({ ...aye3x, conviction: 0 }, won, V, 0n).kind).toBe('none')
    expect(voteAfterLock(aye3x, { state: 'none' }, V, 1_000n).kind).toBe('none')
  })

  it('an ongoing vote is locked if it wins, dated from the expected end', () => {
    expect(voteAfterLock(aye3x, { state: 'ongoing', expectedEnd: 5_000 }, V, 0n)).toEqual({ kind: 'if-wins', amount: 100n, untilBlock: 5_000 + 4 * V, estimate: true })
  })
})

describe('class requirement and the unlock plan', () => {
  const head = 10_000
  const outcomes: Record<number, PollOutcome> = {
    1: { state: 'completed', end: 1_000, approved: true },   // won 1x: locked until 1_000 + V (> head)
    2: { state: 'completed', end: 1_000, approved: false },  // lost: nothing for a non-staker
    3: { state: 'ongoing', expectedEnd: 20_000 },
    4: { state: 'none' },
  }
  const outcomeOf = (p: number) => outcomes[p] ?? { state: 'unknown' as const }
  const small = 3_000 // a VoteLockingPeriod short enough that poll 1's lock has expired at head
  const cls = (votes: [number, bigint, boolean, number][], prior: [number, bigint] = [0, 0n]): ClassVoting => ({
    cls: 0, kind: 'casting', delegations: { votes: 0n, capital: 0n }, prior: { until: prior[0], amount: prior[1] },
    votes: votes.map(([poll, balance, aye, conviction]) => ({ poll, vote: { kind: 'Standard' as const, aye, conviction, balance } })),
  })

  it("as-is: every vote still listed counts at full balance, the prior while unexpired", () => {
    const c = cls([[1, 50n, true, 1], [2, 80n, true, 1]], [head + 1, 90n])
    expect(classRequirement(c, head, 'as-is', outcomeOf, V, 0n)).toBe(90n)
    expect(classRequirement(c, head + 1, 'as-is', outcomeOf, V, 0n)).toBe(80n) // prior expired AT its block
  })

  it('unlock: removes the finished votes whose lock has ended, keeps the still-locked ones at full balance', () => {
    const c = cls([[1, 50n, true, 1], [2, 80n, true, 1], [4, 70n, true, 6]])
    expect(classRequirement(c, head, 'unlock', outcomeOf, V, 0n)).toBe(50n) // 1 still locked; 2 lost, 4 cancelled → removable
    expect(classRequirement(c, head, 'unlock', outcomeOf, small, 0n)).toBe(0n) // 1's lock ended at 4_000
  })

  it('collect: removes every finished vote, its unexpired lock merged into prior; ongoing votes stay', () => {
    const c = cls([[1, 50n, true, 1], [2, 80n, true, 1], [3, 30n, true, 1]])
    expect(classRequirement(c, head, 'collect', outcomeOf, V, 0n)).toBe(50n)
    expect(classRequirement(c, head, 'collect', outcomeOf, small, 0n)).toBe(30n)
    // A staker's losing vote locks its staked part too.
    expect(classRequirement(c, head, 'collect', outcomeOf, V, 60n)).toBe(60n)
  })

  it('the plan frees the observed lock above the highest class requirement, and dates the rest', () => {
    const classes = [cls([[1, 50n, true, 1], [2, 80n, true, 1]], [head + 500, 20n]), { ...cls([[3, 30n, true, 2]]), cls: 9 }]
    const plan = unlockPlan(classes, 100n, head, outcomeOf, V, 0n)
    expect(plan.unlockableAsIs).toBe(20n)      // 100 − max(80 listed, 30)
    expect(plan.unlockableNow).toBe(50n)       // vote 2 removed: max(50 locked, 30, prior 20) = 50
    expect(plan.unlockableCollect).toBe(50n)
    expect(plan.openEnded).toBe(30n)           // the ongoing vote
    // Vote 1's lock ends at 1_000 + V: from then only the ongoing 30 holds.
    expect(plan.schedule).toEqual([{ block: 1_000 + V, freeable: 70n }])
  })

  it('what a release makes spendable is net of the other locks: Balances freezes the largest lock', () => {
    // A staker whose 3M vote lock fully releases while staking holds the same 3M: nothing frees.
    expect(spendableAfterRelease(3_000n, 3_000n, 3_000n)).toBe(0n)
    // Staking holds less than the vote lock: only the part above it frees.
    expect(spendableAfterRelease(3_000n, 3_000n, 1_000n)).toBe(2_000n)
    // A partial release that stays above the other locks frees all of it.
    expect(spendableAfterRelease(3_000n, 500n, 1_000n)).toBe(500n)
    // A partial release down into the other lock frees only down to it.
    expect(spendableAfterRelease(3_000n, 2_500n, 1_000n)).toBe(2_000n)
    expect(spendableAfterRelease(3_000n, 0n, 0n)).toBe(0n)
    const classes = [cls([], [0, 0n])]
    const plan = unlockPlan(classes, 3_000n, head, outcomeOf, V, 3_000n, 3_000n)
    expect(plan.unlockableNow).toBe(3_000n)
    expect(plan.spendableNow).toBe(0n)
    expect(unlockPlan(classes, 3_000n, head, outcomeOf, V, 0n).spendableNow).toBe(3_000n)
  })

  it('reads every non-vote lock of a Balances.Locks observation', () => {
    const json = '[{"id":"0x73746b5f73746b73","amount":"3000","reasons":"All"},{"id":"0x7079636f6e766f74","amount":"3000","reasons":"All"},{"id":"0x6f726d6c76657374","amount":"0","reasons":"All"}]'
    expect(parseOtherLocks(json)).toEqual([{ id: '0x73746b5f73746b73', amount: 3000n }])
    expect(parseOtherLocks('{}')).toBeNull()
    expect(parseOtherLocks('[{"id":"0x01","amount":"x"}]')).toBeNull()
    expect(lockIdName('0x73746b5f73746b73')).toBe('stk_stks')
    expect(lockIdName('0x0001')).toBe('0x0001')
  })

  it('a delegation holds its balance open-ended', () => {
    const [d] = parseVotingFor(DELEGATING)!
    const plan = unlockPlan([d], 477770000000000000n + 5n, head, outcomeOf, V, 0n)
    expect(plan.unlockableNow).toBe(5n)
    expect(plan.openEnded).toBe(477770000000000000n)
  })
})

describe('stateAsOf', () => {
  it('finds the newest observation at or below a block', () => {
    const h = [{ block: 10 }, { block: 20 }, { block: 30 }]
    expect(stateAsOf(h, 9)).toBeNull()
    expect(stateAsOf(h, 10)).toEqual({ block: 10 })
    expect(stateAsOf(h, 29)).toEqual({ block: 20 })
    expect(stateAsOf(h, 99)).toEqual({ block: 30 })
    expect(stateAsOf(undefined, 5)).toBeNull()
  })
})

describe('the incremental snapshot merge', () => {
  it('keeps each account\'s newest block, indexes delegations, and never lets a late row resurrect a released lock', async () => {
    const { __snapshotTest: t } = await import('../src/services/convictionState.ts')
    const states = new Map()
    t.mergeStates(states, [{ account_id: 'a', b: 10, v: CASTING }, { account_id: 'd', b: 10, v: DELEGATING }])
    t.mergeStates(states, [{ account_id: 'a', b: 9, v: '{}' }]) // a late, older row changes nothing
    expect(states.get('a').block).toBe(10)
    expect(states.get('a').classes.length).toBe(3)
    t.mergeStates(states, [{ account_id: 'a', b: 12, v: '{}' }])
    expect(states.get('a').classes).toEqual([])
    const idx = t.delegationIndex(states)
    expect(idx.get('0x36a164b432bf22574439119851c8a243c1cbb6fc50d0baf4a52a9f1aea1c835f')).toEqual([{ accountId: 'd', cls: 1, balance: 477770000000000000n, conviction: 2 }])
    const locks = new Map()
    t.mergeLocks(locks, [{ account_id: 'a', b: 5, cl: '7', sl: '0', gl: '0' }])
    expect(locks.get('a')).toMatchObject({ conviction: 7n })
    t.mergeLocks(locks, [{ account_id: 'a', b: 6, cl: '0', sl: '0', gl: '0' }])
    t.mergeLocks(locks, [{ account_id: 'a', b: 5, cl: '7', sl: '0', gl: '0' }]) // late and older: no resurrection
    expect(locks.get('a')).toMatchObject({ block: 6, conviction: 0n })
  })
})
