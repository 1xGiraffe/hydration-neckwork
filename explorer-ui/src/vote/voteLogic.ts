import { useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { readActor } from './chainWrite'
import type { ActorState, ClassVote, PollOutcome, VoteAction } from './chainWrite'
import { CONVICTIONS, formatHdx, totalBalance } from './voteMath'
import type { Conviction, VoteSpec } from './voteMath'
import { setVotePrefs, useRecentVotes, useVotePrefs } from './voteBus'
import { useAccountGovernance } from '../hooks/useGovernance'
import type { Direction, VoteIntent } from './voteBus'
import type { Voter } from './useVoting'

// Shared, non-visual pieces of the vote sheets: reading an account's standing and
// last vote, describing a vote in words, and picking whom to vote as.

export function standingVote(actor: ActorState | undefined, index: number): (ClassVote & { cls: number }) | null {
  if (!actor) return null
  for (const c of actor.voting) for (const v of c.votes) if (v.poll === index) return { ...v, cls: c.cls }
  return null
}

/** The account's most recent Standard vote elsewhere (highest referendum index), for "same as last time". */
export function lastStandardVote(actor: ActorState | undefined, except: number): (ClassVote & { cls: number | null }) | null {
  if (!actor) return null
  let best: (ClassVote & { cls: number }) | null = null
  for (const c of actor.voting) for (const v of c.votes) {
    if (v.poll === except || v.vote.kind !== 'Standard') continue
    if (!best || v.poll > best.poll) best = { ...v, cls: c.cls }
  }
  return best
}

/**
 * "Same as last time": the account's newest Standard vote — one signed in this tab
 * first (the indexer may not have it yet), else the newest in the indexed history
 * (/explorer/address/:a/governance history.lastStandardVote, which survives the
 * vote's removal), else the highest-numbered Standard vote still on chain.
 */
export function useLastVote(actorId: string | null, actorAddress: string | null, actor: ActorState | undefined, except: number): (ClassVote & { cls: number | null }) | null {
  const recent = useRecentVotes()
  const indexed = useAccountGovernance(actorAddress)
  if (!actorId) return null
  const mine = recent.filter(r => r.actorId.toLowerCase() === actorId.toLowerCase() && r.index !== except && (r.direction === 'aye' || r.direction === 'nay') && r.conviction != null)
    .sort((a, b) => b.at - a.at)[0]
  if (mine) return { poll: mine.index, cls: null, vote: { kind: 'Standard', aye: mine.direction === 'aye', conviction: Math.min(6, mine.conviction!) as Conviction, balance: BigInt(mine.balance) } }
  const h = indexed.data?.history.lastStandardVote
  if (h && h.index !== except && /^\d+$/.test(h.balance)) return { poll: h.index, cls: null, vote: { kind: 'Standard', aye: h.aye, conviction: Math.min(6, h.conviction) as Conviction, balance: BigInt(h.balance) } }
  return lastStandardVote(actor, except)
}

/** A split vote (any aye or nay part) as opposed to a pure abstain. */
export function isSplit(v: VoteSpec): boolean { return v.kind === 'Split' || (v.kind === 'SplitAbstain' && (v.aye > 0n || v.nay > 0n)) }

export function directionOf(v: VoteSpec): Direction | 'split' { return v.kind === 'Standard' ? (v.aye ? 'aye' : 'nay') : isSplit(v) ? 'split' : 'abstain' }
export function capitalOf(v: VoteSpec): bigint { return v.kind === 'Standard' ? v.balance : v.kind === 'Split' ? v.aye + v.nay : v.aye + v.nay + v.abstain }

export function describeVote(v: VoteSpec): string {
  if (v.kind === 'Standard') return `${v.aye ? 'Aye' : 'Nay'} ${CONVICTIONS[v.conviction].label} with ${formatHdx(v.balance, 2)} HDX`
  if (v.kind === 'SplitAbstain' && v.aye === 0n && v.nay === 0n) return `Abstain with ${formatHdx(v.abstain, 2)} HDX`
  return `Split: aye ${formatHdx(v.aye, 2)}, nay ${formatHdx(v.nay, 2)}${v.kind === 'SplitAbstain' ? `, abstain ${formatHdx(v.abstain, 2)}` : ''} HDX`
}

/**
 * Pick the voter. Only the reader's OWN accounts are ever picked automatically: anyone
 * can make an account a proxy of theirs without asking (add_proxy needs no consent),
 * so an account reached through a proxy is used only after the reader picks it — then
 * remembered (prefs are written only by an explicit pick). On a referendum, the
 * sheet follows the button that opened it (`intent`): "Vote" opens on an own account
 * that has not voted on it yet (the one with the most HDX), "Change vote" on the
 * own account that voted (the largest, when several did). Otherwise — no referendum,
 * or no own account fits — the one chosen last time, else the one that can vote the
 * most HDX. `allowProxied` lifts the rule for a sheet opened FOR a named account (the
 * unlock button on that account's page). `alreadyVoted` counts own accounts only.
 */
export function usePickedVoter(voters: Voter[], poll: number | null = null, allowProxied = false, intent: VoteIntent | null = null): [Voter | null, (v: Voter) => void, { alreadyVoted: number }] {
  const prefs = useVotePrefs()
  const [picked, setPicked] = useState<string | null>(null)
  const actorIds = [...new Set(voters.filter(v => !v.disabled).map(v => v.actorId))]
  const states = useQueries({ queries: actorIds.map(id => ({ queryKey: ['vote-actor', id], queryFn: () => readActor(id), staleTime: 12_000, refetchInterval: 30_000 })) })
  const stateOf = new Map(actorIds.map((id, i) => [id, states[i]?.data]))
  const { chosen, alreadyVoted } = chooseVoter(voters, stateOf, prefs, picked, poll, allowProxied, intent)
  return [chosen, v => {
    setPicked(v.key)
    setVotePrefs({ signer: v.signer.id, actorBySigner: { [v.signer.id]: v.actorId }, ...(v.proxy ? { pickedProxies: [...new Set([...(prefs.pickedProxies ?? []), v.key])].slice(-20) } : {}) })
  }, { alreadyVoted }]
}

/** The choice usePickedVoter makes, pure (see its rules above). */
export function chooseVoter(
  voters: Voter[], stateOf: Map<string, ActorState | undefined>, prefs: { signer: string | null; actorBySigner: Record<string, string>; pickedProxies?: string[] },
  picked: string | null, poll: number | null, allowProxied: boolean, intent: VoteIntent | null = null,
): { chosen: Voter | null; alreadyVoted: number } {
  const usable = voters.filter(v => !v.disabled)
  const own = usable.filter(v => !v.proxy)
  const autoPool = allowProxied ? usable : own
  const balanceOf = (id: string) => { const s = stateOf.get(id); return s ? totalBalance(s.hdx) : 0n }
  const voted = poll == null ? [] : own.filter(v => !!standingVote(stateOf.get(v.actorId), poll))
  const byKey = new Map(voters.map(v => [v.key, v]))
  const largest = (pool: Voter[]) => [...pool].sort((a, b) => (balanceOf(b.actorId) > balanceOf(a.actorId) ? 1 : -1))[0] ?? null
  let chosen: Voter | null = picked ? byKey.get(picked) ?? null : null
  if (!chosen && poll != null && intent !== 'change') {
    // An account is known not to have voted only once its state is read; one with no
    // HDX to vote with is no place to start.
    const fresh = own.filter(v => { const s = stateOf.get(v.actorId); return !!s && !standingVote(s, poll) && totalBalance(s.hdx) > 0n })
    chosen = largest(fresh)
  }
  if (!chosen && voted.length) chosen = largest(voted)
  if (!chosen && prefs.signer) {
    const remembered = usable.filter(v => v.signer.id === prefs.signer)
    const actor = prefs.actorBySigner[prefs.signer]
    chosen = remembered.find(v => v.actorId === actor && (!v.proxy || !!prefs.pickedProxies?.includes(v.key))) ?? remembered.find(v => !v.proxy) ?? null
  }
  if (!chosen && autoPool.length) {
    let best = autoPool[0], bestBal = -1n
    for (const v of autoPool) { const b = balanceOf(v.actorId); if (b > bestBal) { best = v; bestBal = b } }
    chosen = best
  }
  return { chosen, alreadyVoted: new Set(voted.map(v => v.actorId)).size }
}

/**
 * What a vote on a finished referendum leaves locked once removed — the lock the
 * pallet moves into the track's `prior` (conviction-voting try_remove_vote):
 *   - Completed(end, approved), a Standard vote on the winning side with conviction:
 *     its balance until end + lock periods × VoteLockingPeriod;
 *   - the losing side, on Hydration, when a staking hook asks for it
 *     (lock_balance_on_unsuccessful_vote: GIGAHDX's recorded staked_vote_amount,
 *     legacy staking's tracked or rewarded vote amount; the larger of the two):
 *     that amount for the same periods;
 *   - nothing for 0.1× (no periods), Split/SplitAbstain, a cancelled, killed or
 *     timed-out referendum (PollStatus::None).
 */
export function lockAfterRemoval(vote: VoteSpec, poll: number, outcome: PollOutcome | undefined, actor: ActorState, voteLockingPeriod: number): { amount: bigint; until: number } | null {
  if (!outcome || outcome.state !== 'completed' || vote.kind !== 'Standard') return null
  const periods = CONVICTIONS[vote.conviction].periods
  if (!periods) return null
  const until = outcome.end + periods * voteLockingPeriod
  if (vote.aye === outcome.approved) return { amount: vote.balance, until }
  const giga = actor.gigahdx?.records.get(poll)?.stakedVoteAmount ?? 0n
  const staking = actor.staking?.rewarded.get(poll) ?? actor.staking?.votes.get(poll) ?? 0n
  const hook = giga > staking ? giga : staking
  if (hook <= 0n) return null
  return { amount: hook < vote.balance ? hook : vote.balance, until }
}

export interface FinishedVote {
  cls: number
  poll: number
  vote: VoteSpec
  /** The lock it leaves once removed (null: none). */
  after: { amount: bigint; until: number } | null
  /** Its lock has ended (or it never had one): removing it merges nothing into the track. */
  expired: boolean
  /** Removing it credits a GIGAHDX voting reward (a record with weight on an allocated or completed referendum). */
  credits: boolean
}

/** The account's votes on finished referenda, earliest first, each classified for the clean-up. */
export function finishedVotes(actor: ActorState, outcomes: Map<number, PollOutcome>, head: number, voteLockingPeriod: number): FinishedVote[] {
  const out: FinishedVote[] = []
  for (const c of actor.voting) for (const { poll, vote } of c.votes) {
    const o = outcomes.get(poll)
    if (!o || o.state === 'ongoing') continue
    const after = lockAfterRemoval(vote, poll, o, actor, voteLockingPeriod)
    // GigaHdxRewards::on_remove_vote credits only a record with weight, and only once
    // the referendum completed (allocation) or its pool already exists.
    const rec = actor.gigahdx?.records.get(poll)
    const credits = !!rec && rec.weighted > 0n && (o.state === 'completed' || o.rewardPool)
    out.push({ cls: c.cls, poll, vote, after, expired: !after || after.until <= head, credits })
  }
  return out.sort((a, b) => a.poll - b.poll)
}

/**
 * Per track, the single prior lock that removing `removed` leaves: PriorLock keeps one
 * (until, amount) and accumulate() takes the max of each, so removed locks MERGE — the
 * largest amount held to the latest date. An expired stored prior is cleared first (the
 * batch unlocks such a track before removing), so it never re-arms.
 */
export function mergedPriors(actor: ActorState, removed: FinishedVote[], head: number): Map<number, { amount: bigint; until: number }> {
  const out = new Map<number, { amount: bigint; until: number }>()
  for (const c of actor.voting) {
    const start = c.prior.until > head && c.prior.amount > 0n ? { ...c.prior } : null
    let m = start
    for (const r of removed) {
      if (r.cls !== c.cls || !r.after || r.after.until <= head) continue
      m = m ? { amount: m.amount > r.after.amount ? m.amount : r.after.amount, until: m.until > r.after.until ? m.until : r.after.until } : { ...r.after }
    }
    if (m && m !== start) out.set(c.cls, m)
  }
  return out
}

/**
 * The clean-up batch, in the order that frees the most:
 *   1. unlock every track whose stored prior has expired and that a removal will add a
 *      lock to — otherwise accumulate() would carry the stale amount to the new date;
 *   2. remove the chosen finished votes, earliest first;
 *   3. unlock every track that holds a vote lock (and every track a removal touched);
 *   4. claim the GIGAHDX rewards, when asked.
 */
export function unlockActions(actor: ActorState, chosen: FinishedVote[], head: number, opts: { claim: boolean }): VoteAction[] {
  const removes = [...chosen].sort((a, b) => a.poll - b.poll)
  const accumulating = new Set(removes.filter(r => r.after && r.after.until > head).map(r => r.cls))
  const stale = actor.voting.filter(c => accumulating.has(c.cls) && c.prior.amount > 0n && c.prior.until <= head).map(c => c.cls).sort((a, b) => a - b)
  const locked = new Set([...actor.classLocks.filter(l => l.amount > 0n).map(l => l.cls), ...removes.map(r => r.cls)])
  const out: VoteAction[] = [
    ...stale.map(cls => ({ kind: 'unlock' as const, cls, target: actor.accountId })),
    ...removes.map(r => ({ kind: 'remove-vote' as const, poll: r.poll, cls: r.cls })),
    ...[...locked].sort((a, b) => a - b).map(cls => ({ kind: 'unlock' as const, cls, target: actor.accountId })),
  ]
  if (opts.claim) out.push({ kind: 'claim-gigahdx-rewards' })
  return out
}
