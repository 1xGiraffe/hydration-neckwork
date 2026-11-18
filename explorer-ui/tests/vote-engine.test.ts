import { describe, expect, it } from 'vitest'
import { innerFailure, isEvmMapped, isUserRefusal, judgeEvents, lockEffects, outcomeLines, permitGasLimit } from '../src/vote/chainWrite'
import type { ActorState, PollOutcome, SimEvent } from '../src/vote/chainWrite'
import { chooseVoter, finishedVotes, lockAfterRemoval, mergedPriors, unlockActions } from '../src/vote/voteLogic'

const registry0 = {
  findErrorMeta: (err: unknown) => {
    const v = (err as { value?: { index?: number } })?.value
    return v?.index === 36 ? { pallet: 'ConvictionVoting', name: 'NotOngoing', docs: ['Poll is not ongoing.'] } : undefined
  },
}
const registry = { registry: registry0 } as never
const NOT_ONGOING = { type: 'Module', value: { index: 36, error: '0x00000000' } }

describe('the signing engine', () => {
  it('sizes a permit gas limit like the Hydration app, raised to the estimate, with 30% headroom', () => {
    expect(permitGasLimit(1_000_000_000n, null)).toBe(130_000n)            // 40k → floor 100k
    expect(permitGasLimit(1_720_478_000n, 352_356n)).toBe(458_062n)        // estimate wins
    expect(permitGasLimit(10n ** 15n, null)).toBe(19_500_000n)             // ceiling 15M
  })

  it('recognises the ETH\\0 accounts unbound EVM addresses map to', () => {
    expect(isEvmMapped('0x45544800fe5563cd4a9528a472584ef49ed66faf4d4848560000000000000000')).toBe(true)
    expect(isEvmMapped('0xaca4eacc706ad252d23a5e6ae8e05ea74253367ee80209d117a0574b6c444824')).toBe(false)
  })

  it('reads the inner result a proxy wrapper hides behind an Ok', () => {
    const events: SimEvent[] = [{ pallet: 'Proxy', name: 'ProxyExecuted', data: { result: { isOk: false, isErr: true, err: NOT_ONGOING } } }]
    expect(innerFailure(registry, events)).toEqual({ code: 'ConvictionVoting.NotOngoing', message: 'Voting on this referendum has closed.' })
    expect(innerFailure(registry, [{ pallet: 'Proxy', name: 'ProxyExecuted', data: { result: { isOk: true } } }])).toBeNull()
  })

  it('names the batch item that interrupted a batch', () => {
    const events: SimEvent[] = [{ pallet: 'Utility', name: 'BatchInterrupted', data: { index: 1, error: NOT_ONGOING } }]
    expect(innerFailure(registry, events)?.message).toBe('Action 2: Voting on this referendum has closed.')
  })

  it('says what a run did, counting removals from the plan (the pallet emits no event for them)', () => {
    const events: SimEvent[] = [
      { pallet: 'ConvictionVoting', name: 'VoteUnlocked', data: { class: 0 } },
      { pallet: 'Balances', name: 'Unlocked', data: { amount: 1_500_000_000_000_000n } },
    ]
    const lines = outcomeLines(events, [{ kind: 'remove-vote', poll: 1, cls: 0 }, { kind: 'remove-vote', poll: 2, cls: 0 }, { kind: 'unlock', cls: 0, target: '0x' }])
    expect(lines).toEqual(['Removes 2 votes', 're-checks the lock of 1 track', 'frees 1,500 HDX'])
    expect(outcomeLines([{ pallet: 'ConvictionVoting', name: 'Voted', data: null }, { pallet: 'Balances', name: 'Locked', data: { amount: 2_000_000_000_000n } }]))
      .toEqual(['Records 1 vote', 'locks 2 HDX more'])
  })

  it('fails a permit that ran no EVM call instead of calling it a success', () => {
    const raw = [{ event: { pallet: 'System', palletEvent: { name: 'ExtrinsicSuccess', data: {} } } }]
    expect(judgeEvents(registry, raw as never, 'evm-permit').ok).toBe(false)
    expect(judgeEvents(registry, raw as never, 'substrate').ok).toBe(true)
    const failed = [{ event: { pallet: 'System', palletEvent: { name: 'ExtrinsicFailed', data: { dispatchError: NOT_ONGOING } } } }]
    expect(judgeEvents(registry, failed as never, 'substrate')).toMatchObject({ ok: false, message: 'Voting on this referendum has closed.' })
  })

  it('builds the clean-up batch: stale priors unlocked first, finished votes earliest first, every locked track, then the claim', () => {
    const V = 302_400
    const std = (aye: boolean, conviction: number, balance: bigint) => ({ kind: 'Standard' as const, aye, conviction: conviction as 1, balance })
    const actor = {
      accountId: '0xaa',
      voting: [
        // Track 0: an expired stored prior (ended at 100) — removing a still-locked vote must not re-arm it.
        { cls: 0, kind: 'casting', votes: [{ poll: 9, vote: std(true, 1, 50n) }, { poll: 3, vote: std(true, 2, 70n) }], prior: { until: 100, amount: 999n }, delegatingTo: null, delegations: { votes: 0n, capital: 0n } },
        { cls: 5, kind: 'casting', votes: [{ poll: 7, vote: std(false, 0, 10n) }, { poll: 12, vote: std(true, 1, 10n) }], prior: { until: 0, amount: 0n }, delegatingTo: null, delegations: { votes: 0n, capital: 0n } },
      ],
      classLocks: [{ cls: 5, amount: 10n }, { cls: 0, amount: 999n }, { cls: 1, amount: 0n }],
      gigahdx: { stakedHdx: 1n, pendingRewards: 0n, votedPolls: [9, 3], records: new Map([[9, { stakedVoteAmount: 50n, weighted: 0n }], [3, { stakedVoteAmount: 70n, weighted: 140n }]]) },
      staking: null,
    } as unknown as ActorState
    const head = 2 * V
    // #3 approved at block 10: aye 2× → locked until 10 + 2V (expired at head = 2V? no: 10 + 2V > 2V, still locked).
    // #9 approved at 0: aye 1× → until V (expired). #7 rejected: nay 0.1× → no lock. #12 still running.
    const outcomes = new Map<number, PollOutcome>([
      [3, { state: 'completed', end: 10, approved: true, rewardPool: false }],
      [9, { state: 'completed', end: 0, approved: true, rewardPool: false }],
      [7, { state: 'completed', end: 0, approved: false, rewardPool: false }],
      [12, { state: 'ongoing' }],
    ])
    const fin = finishedVotes(actor, outcomes, head, V)
    expect(fin.map(f => [f.poll, f.expired, f.credits])).toEqual([[3, false, true], [7, true, false], [9, true, false]])
    // Default: only the expired ones; no stale-prior unlock needed (nothing accumulates).
    const def = unlockActions(actor, fin.filter(f => f.expired), head, { claim: false })
    expect(def).toEqual([
      { kind: 'remove-vote', poll: 7, cls: 5 },
      { kind: 'remove-vote', poll: 9, cls: 0 },
      { kind: 'unlock', cls: 0, target: '0xaa' },
      { kind: 'unlock', cls: 5, target: '0xaa' },
    ])
    // Opting in to the still-locked #3: track 0's expired prior is unlocked BEFORE it merges.
    const all = unlockActions(actor, fin, head, { claim: true })
    expect(all[0]).toEqual({ kind: 'unlock', cls: 0, target: '0xaa' })
    expect(all.slice(1, 4).map(a => (a as { poll: number }).poll)).toEqual([3, 7, 9])
    expect(all.at(-1)).toEqual({ kind: 'claim-gigahdx-rewards' })
    // The merged lock it leaves: #3's own (the stale 999 is gone).
    expect(mergedPriors(actor, fin.filter(f => f.poll === 3), head).get(0)).toEqual({ amount: 70n, until: 10 + 2 * V })
  })

  it('locks a losing staker vote for the hook amount, a winner for its balance, nothing for 0.1× or a cancelled referendum', () => {
    const actor = { gigahdx: { records: new Map([[1, { stakedVoteAmount: 40n, weighted: 1n }]]) }, staking: null } as unknown as ActorState
    const v = { kind: 'Standard' as const, aye: true, conviction: 3 as const, balance: 100n }
    expect(lockAfterRemoval(v, 1, { state: 'completed', end: 5, approved: true, rewardPool: false }, actor, 10)).toEqual({ amount: 100n, until: 45 })
    expect(lockAfterRemoval(v, 1, { state: 'completed', end: 5, approved: false, rewardPool: false }, actor, 10)).toEqual({ amount: 40n, until: 45 })
    expect(lockAfterRemoval(v, 2, { state: 'completed', end: 5, approved: false, rewardPool: false }, actor, 10)).toBeNull()
    expect(lockAfterRemoval({ ...v, conviction: 0 }, 1, { state: 'completed', end: 5, approved: true, rewardPool: false }, actor, 10)).toBeNull()
    expect(lockAfterRemoval(v, 1, { state: 'none', rewardPool: false }, actor, 10)).toBeNull()
  })

  it('reports a GIGAHDX claim as the claim, not as a new lock', () => {
    const events: SimEvent[] = [
      { pallet: 'Balances', name: 'Locked', data: { amount: 41_832_307_137_642n } },
      { pallet: 'GigaHdxRewards', name: 'RewardsClaimed', data: { totalHdx: 41_832_307_137_642n } },
      { pallet: 'ConvictionVoting', name: 'VoteUnlocked', data: { class: 5 } },
    ]
    expect(lockEffects(events)).toEqual({ freed: 0n, lockedMore: 0n, claimed: 41_832_307_137_642n })
    expect(outcomeLines(events, [{ kind: 'remove-vote', poll: 1, cls: 5 }])).toEqual([
      'Removes 1 vote', 're-checks the lock of 1 track', 'claims 41.83 HDX of GIGAHDX voting rewards, staked into GIGAHDX',
      'frees no HDX yet (running votes or unexpired locks still need it)',
    ])
  })

  it('counts VoteRemoved for running referenda and the plan for finished ones', () => {
    const lines = outcomeLines([{ pallet: 'ConvictionVoting', name: 'VoteRemoved', data: null }], [])
    expect(lines[0]).toBe('Removes 1 vote')
  })

  it('treats only the wallet’s own refusal as a cancel', () => {
    expect(isUserRefusal(Object.assign(new Error('anything'), { code: 4001 }))).toBe(true)
    expect(isUserRefusal(new Error('Cancelled'))).toBe(true)
    expect(isUserRefusal(new Error('Rejected by user'))).toBe(true)
    expect(isUserRefusal(new Error('Rejected by the wallet extension'))).toBe(true)
    expect(isUserRefusal(new Error('User rejected the request.'))).toBe(true)
    expect(isUserRefusal(new Error('The chain rejected the permit: EvmPermitInvalid'))).toBe(false)
    expect(isUserRefusal(new Error('Invalid Transaction: Payment, rejected'))).toBe(false)
  })
})

describe('whom the sheet votes as', () => {
  const signer = { id: 'w|me', walletId: 'w', walletName: 'W', walletIcon: '', kind: 'substrate' as const, address: 'me', name: 'Me' }
  const voter = (actorId: string, proxy: boolean) => ({
    key: `${actorId}|me`, actorId, actorAddress: actorId, ref: null, signer, signerId: 'me', proxy: proxy ? { proxyType: 'Governance' as const } : null, via: null, disabled: null,
  })
  const state = (balance: bigint, votedOn: number[] = []) => ({
    hdx: { free: balance, reserved: 0n, frozen: 0n },
    voting: [{ cls: 0, kind: 'casting', votes: votedOn.map(poll => ({ poll, vote: { kind: 'Standard', aye: true, conviction: 1, balance: 1n } })), prior: { until: 0, amount: 0n }, delegatingTo: null, delegations: { votes: 0n, capital: 0n } }],
  }) as unknown as ActorState
  const me = voter('me', false), stranger = voter('stranger', true)
  const states = new Map<string, ActorState | undefined>([['me', state(10n)], ['stranger', state(1_000_000n, [450])]])
  const noPrefs = { signer: null, actorBySigner: {} }

  it('never picks an account reached through a proxy on its own, however rich, and does not count its vote as yours', () => {
    expect(chooseVoter([stranger, me], states, noPrefs, null, 450, false)).toEqual({ chosen: me, alreadyVoted: 0 })
  })

  it('restores a proxied account only after the reader picked it', () => {
    const remembered = { signer: 'w|me', actorBySigner: { 'w|me': 'stranger' } }
    expect(chooseVoter([stranger, me], states, remembered, null, null, false).chosen).toBe(me)
    expect(chooseVoter([stranger, me], states, { ...remembered, pickedProxies: [stranger.key] }, null, null, false).chosen).toBe(stranger)
    expect(chooseVoter([stranger, me], states, noPrefs, stranger.key, null, false).chosen).toBe(stranger)
  })

  describe('follows the button that opened the sheet', () => {
    const main = voter('main', false), savings = voter('savings', false), staker = voter('staker', false), empty = voter('empty', false)
    const s = new Map<string, ActorState | undefined>([
      ['main', state(500n)], ['savings', state(50n)], ['staker', state(9_000n, [450])], ['empty', state(0n)], ['stranger', state(1_000_000n)],
    ])
    const all = [staker, savings, main, empty, stranger]

    it('"Vote" opens on the own account with the most HDX that has not voted yet, never a proxied one', () => {
      expect(chooseVoter(all, s, noPrefs, null, 450, false, 'vote')).toEqual({ chosen: main, alreadyVoted: 1 })
      // No intent on a referendum reads as "Vote".
      expect(chooseVoter(all, s, noPrefs, null, 450, false, null).chosen).toBe(main)
    })

    it('"Vote" passes over a remembered account that already voted', () => {
      const remembered = { signer: 'w|me', actorBySigner: { 'w|me': 'staker' } }
      expect(chooseVoter(all, s, remembered, null, 450, false, 'vote').chosen).toBe(main)
    })

    it('"Change vote" opens on the account that voted', () => {
      expect(chooseVoter(all, s, noPrefs, null, 450, false, 'change').chosen).toBe(staker)
    })

    it('"Vote" falls back to an account that voted when every own account has (or holds no HDX)', () => {
      expect(chooseVoter([staker, empty, stranger], s, noPrefs, null, 450, false, 'vote').chosen).toBe(staker)
    })

    it('waits for an account\'s state before calling it unvoted', () => {
      const unread = new Map<string, ActorState | undefined>([['staker', state(9_000n, [450])]])
      expect(chooseVoter([main, staker], unread, noPrefs, null, 450, false, 'vote').chosen).toBe(staker)
    })

    it('an explicit pick wins over both rules', () => {
      expect(chooseVoter(all, s, noPrefs, savings.key, 450, false, 'change').chosen).toBe(savings)
    })
  })
})
