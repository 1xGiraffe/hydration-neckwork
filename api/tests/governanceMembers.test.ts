import { describe, expect, it } from 'vitest'
import { foldMembersGovernance } from '../src/services/governanceRead.ts'
import type { ClassVoting, PollOutcome, UnlockPlan } from '../src/services/convictionState.ts'

const prior = { until: 0, amount: 0n }
const none = { votes: 0n, capital: 0n }
const plan = (locked: bigint, unlockableNow: bigint, schedule: { block: number; freeable: bigint }[], openEnded = 0n): UnlockPlan =>
  ({ locked, unlockableAsIs: unlockableNow, unlockableNow, unlockableCollect: unlockableNow, schedule, openEnded } as unknown as UnlockPlan)

// Polls 7 and 8 are running; 3 has ended.
const outcomeOf = (poll: number): PollOutcome => (poll === 3 ? { state: 'completed' } : { state: 'ongoing' }) as PollOutcome

const classes: Record<string, ClassVoting[]> = {
  a: [{ cls: 0, kind: 'casting', delegations: none, prior, votes: [
    { poll: 7, vote: { kind: 'Standard', aye: true, conviction: 1, balance: 100n } },
    { poll: 3, vote: { kind: 'Standard', aye: false, conviction: 1, balance: 999n } },
  ] }],
  b: [
    { cls: 0, kind: 'casting', delegations: none, prior, votes: [{ poll: 7, vote: { kind: 'SplitAbstain', aye: 10n, nay: 20n, abstain: 30n } }] },
    { cls: 1, kind: 'casting', delegations: none, prior, votes: [{ poll: 8, vote: { kind: 'Standard', aye: false, conviction: 0, balance: 50n } }] },
  ],
  // Delegates two tracks to d: the same HDX backs both, so it counts once.
  c: [
    { cls: 0, kind: 'delegating', target: 'd', balance: 400n, conviction: 1, delegations: none, prior },
    { cls: 1, kind: 'delegating', target: 'd', balance: 300n, conviction: 1, delegations: none, prior },
  ],
}

const fold = () => foldMembersGovernance(['a', 'b', 'c', 'a', 'e'], {
  classesOf: acc => classes[acc] ?? [],
  planOf: acc => acc === 'a' ? plan(1000n, 100n, [{ block: 50, freeable: 400n }])
    : acc === 'b' ? plan(500n, 0n, [{ block: 50, freeable: 200n }, { block: 90, freeable: 500n }])
      : acc === 'c' ? plan(400n, 0n, [], 400n) : null,
  outcomeOf,
  forumOf: acc => (acc === 'a' ? { posts: 1, comments: 2 } : acc === 'b' ? { posts: 0, comments: 5 } : null),
})

describe("a group's governance, summed over its members", () => {
  it('counts each member once, and who votes, delegates and holds a lock', () => {
    const f = fold()
    expect([f.members, f.voting, f.delegating, f.holders]).toEqual([4, 2, 1, 3])
  })

  it('sums the locks and dates the earliest next release, adding the members released then', () => {
    const f = fold()
    expect([f.locked, f.unlockableNow, f.openEnded]).toEqual([1900n, 100n, 400n])
    expect(f.next).toEqual({ block: 50, amount: 300n + 200n })
  })

  it('combines the votes on running referenda only, a split vote in each part', () => {
    const f = fold()
    expect([...f.running.keys()].sort()).toEqual([7, 8])
    const r7 = f.running.get(7)!
    expect([r7.voters, r7.aye, r7.nay, r7.abstain]).toEqual([2, 110n, 20n, 30n])
    // Locked1x counts the balance once; a split's parts count at 0.1x (no conviction).
    expect(r7.ayes).toBe(100n + 1n)
    expect(r7.nays).toBe(2n)
    expect(f.running.get(8)!.nay).toBe(50n)
  })

  it('counts a delegate once per member, at the largest balance delegated to it', () => {
    expect(fold().delegationsOut.get('d')).toEqual({ members: 1, tracks: 2, balance: 400n })
  })

  it('adds the members forum posts and comments', () => {
    const f = fold()
    expect([f.posts, f.comments]).toEqual([1, 7])
  })
})
