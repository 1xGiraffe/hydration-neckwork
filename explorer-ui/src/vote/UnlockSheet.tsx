import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, paths } from '../router'
import { Amt, F } from '../components/ui'
import { trackLabel } from '../components/gov/GovUi'
import { useGovTracks } from '../hooks/useGovernance'
import { chainConstants, pollOutcomes, toAccountIdHex } from './chainWrite'
import type { WritePlan } from './chainWrite'
import { finishedVotes, mergedPriors, unlockActions } from './voteLogic'
import type { FinishedVote } from './voteLogic'
import { useGovClock } from '../hooks/useGovernance'
import { projectBlock } from '../governanceClock'
import { formatHdx } from './voteMath'
import { useActorState, useRefreshAfterWrite, useVoters } from './useVoting'
import type { Voter } from './useVoting'
import { VoterPicker } from './VoterPicker'
import { Fact, ReviewPanel } from './ReviewPanel'
import { describeVote, usePickedVoter } from './voteLogic'
import { useReview } from './useReview'
import { lockEffects } from './chainWrite'
import { useAccountGovernance } from '../hooks/useGovernance'
import { useNow } from '../hooks/useNow'
import { MomentText, lockName } from '../components/gov/GovUi'
import { NoWallet } from './WalletDialog'
import { GovDetails, InfoTip } from '../components/gov/Disclosure'
import { openWallets } from './voteBus'

// "Unlock & clean up": one signature that
//   1. removes the votes on finished referenda whose lock has ended (earliest first)
//      — on Hydration removing a finished vote is also what credits staking points
//      and the GIGAHDX voting reward;
//   2. optionally (an explicit choice) also removes finished votes still locked. The
//      pallet keeps ONE prior lock per track and merges every removed lock into it
//      (the largest amount, held to the latest date), so this can keep more HDX
//      locked for longer; the sheet shows the merged amount and date before asking;
//   3. unlocks every track that holds a vote lock (an expired stored prior is
//      unlocked BEFORE any removal adds to it, so its old amount never re-arms);
//   4. claims the GIGAHDX voting rewards when there are, or these removals credit, any.
// The dry-run then states the exact lock change before anything is signed, and the
// sheet leads with it: what frees now, what stays locked, when the next part frees.
// The button is the lavender primary ("Unlock N HDX") only when it frees HDX;
// otherwise it is a neutral "Clean up" with the one line of what it does instead.

function trackName(id: number, tracks: { id: number; name: string }[] | undefined) {
  return trackLabel(tracks?.find(t => t.id === id)?.name ?? `track ${id}`)
}

export function UnlockSheet({ address }: { address: string | null }) {
  const { voters, loading, accounts } = useVoters()
  const targetId = (() => { try { return address ? toAccountIdHex(address) : null } catch { return null } })()
  const matching = targetId ? voters.filter(v => v.actorId.toLowerCase() === targetId.toLowerCase()) : voters
  const [picked, setPicked] = usePickedVoter(matching, null, !!targetId)
  const voter: Voter | null = picked
  const actorQ = useActorState(voter?.actorId ?? null)
  const actor = actorQ.data
  const tracks = useGovTracks()
  const polls = actor ? actor.voting.flatMap(c => c.votes.map(v => v.poll)) : []
  const fin = useQuery({ queryKey: ['vote-outcomes', voter?.actorId, polls.join(',')], queryFn: () => pollOutcomes(polls), enabled: !!actor })
  const consts = useQuery({ queryKey: ['vote-consts'], queryFn: chainConstants, staleTime: Infinity })
  const clock = useGovClock()
  const refresh = useRefreshAfterWrite()
  const now = useNow(60_000)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [lockedIncluded, setLockedIncluded] = useState<Set<string>>(new Set())
  const [claimOff, setClaimOff] = useState(false)
  const [claimRefused, setClaimRefused] = useState(false)

  const head = actor?.readAtBlock ?? 0
  const all = actor && fin.data && consts.data ? finishedVotes(actor, fin.data, head, consts.data.voteLockingPeriod) : []
  const expiredVotes = all.filter(v => v.expired)
  const stillLocked = all.filter(v => !v.expired)
  const keyOf = (v: FinishedVote) => `${v.cls}:${v.poll}`
  const chosen = [...expiredVotes.filter(v => !excluded.has(keyOf(v))), ...stillLocked.filter(v => lockedIncluded.has(keyOf(v)))]
  const running = actor && fin.data ? actor.voting.flatMap(c => c.votes.filter(v => fin.data!.get(v.poll)?.state === 'ongoing').map(v => ({ cls: c.cls, ...v }))) : []
  const giga = actor?.gigahdx ?? null
  const rewardsComing = chosen.some(v => v.credits)
  const hasRewards = !!giga && (giga.pendingRewards > 0n || rewardsComing)
  // A Governance proxy may vote, remove votes and unlock (ConvictionVoting, Utility)
  // but not call GigaHdxRewards (the runtime's ProxyType::Governance filter), so the
  // claim is offered only to the account itself or an Any proxy.
  const proxyCanClaim = !voter?.proxy || voter.proxy.proxyType === 'Any'
  const canClaim = hasRewards && proxyCanClaim && !claimRefused
  const claim = canClaim && !claimOff
  const actions = actor && fin.data && consts.data ? unlockActions(actor, chosen, head, { claim }) : []
  // What removing the still-locked votes would merge, per track (vs leaving them in place).
  const merged = actor ? mergedPriors(actor, stillLocked.filter(v => lockedIncluded.has(keyOf(v))), head) : new Map()
  const dateOf = (block: number) => (clock.data ? <MomentText at={{ block, ts: new Date(projectBlock(clock.data, block)).toISOString(), exact: false }} now={now} /> : <>block #{block}</>)
  const locked = actor?.locks.find(l => l.id === 'pyconvot')?.amount ?? 0n
  const delegating = actor?.voting.filter(c => c.kind === 'delegating') ?? []

  let blocked: string | null = null
  if (!voter) blocked = 'Connect a wallet to continue.'
  else if (!actor || !fin.data || !consts.data) blocked = 'Reading this account’s votes and locks…'
  else if (!actions.length) blocked = 'Nothing to clean up: no finished votes, no track locks and no rewards to claim.'
  const plan: WritePlan | null = voter && !voter.disabled && actions.length
    ? { signer: voter.signer, signerId: voter.signerId, proxy: voter.proxy ? { real: voter.actorId, proxyType: voter.proxy.proxyType } : null, via: voter.via, actions }
    : null
  // The dry-run's own figures (the same review the Sign button uses): what frees now,
  // what stays locked, and the reward claimed into GIGAHDX.
  const rv = useReview(blocked ? null : plan, blocked)
  // A claim the dry-run shows would find nothing (the removals credited no reward) is
  // dropped rather than left to fail the whole batch.
  if (claim && rv.data && !rv.stale && rv.data.simulation.code === 'GigaHdxRewards.NoPendingRewards' && !claimRefused) setClaimRefused(true)
  const fx = rv.data && !rv.stale && rv.data.simulation.status === 'ok' ? lockEffects(rv.data.simulation.events) : null
  const indexed = useAccountGovernance(voter ? voter.actorAddress : null)
  const lockInfo = indexed.data?.locks.find(l => l.account.toLowerCase() === (voter?.actorId ?? '').toLowerCase()) ?? indexed.data?.locks[0] ?? null
  // Balances freezes the largest lock: what stays frozen after this is the account's
  // frozen balance less what the dry-run frees, and any part of it another lock
  // (staking, GIGAHDX, vesting) covers stays frozen however the vote lock changes.
  const frozenNow = actor?.hdx.frozen ?? 0n
  const staysLocked = fx ? (frozenNow > fx.freed ? frozenNow - fx.freed : 0n) : null
  const other = actor ? actor.locks.filter(l => l.id !== 'pyconvot' && l.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : -1))[0] ?? null : null
  const heldByVotes = staysLocked != null ? (other && other.amount >= staysLocked ? 0n : staysLocked - (other?.amount ?? 0n)) : null
  const nextAfter = lockInfo?.schedule.find(s => BigInt(s.spendable ?? s.freeable) > (fx?.freed ?? 0n)) ?? null
  const trackLocks = actor?.classLocks.filter(l => l.amount > 0n) ?? []
  const sameAmount = trackLocks.length > 1 && trackLocks.every(l => l.amount === trackLocks[0].amount)

  const removing = actions.filter(a => a.kind === 'remove-vote').length
  const claiming = actions.some(a => a.kind === 'claim-gigahdx-rewards')
  const frees = fx ? fx.freed : null
  // What a clean-up that frees nothing does instead, from the plan itself.
  const does = [
    removing ? `removes ${removing} finished ${removing === 1 ? 'vote' : 'votes'}` : null,
    claiming || (fx?.claimed ?? 0n) > 0n ? 'collects GIGAHDX rewards' : null,
  ].filter((x): x is string => !!x)
  const doesText = does.length ? does.join(' and ') : 're-checks the track locks'
  const reason = frees === 0n ? <p className="vote-note unlock-reason">Frees nothing yet. {doesText[0].toUpperCase()}{doesText.slice(1)}.</p> : null
  const stayCause = staysLocked && staysLocked > 0n
    ? heldByVotes === 0n && other ? <>Held by {lockName(other.id)} ({formatHdx(other.amount, 0)} HDX){other.id === 'stk_stks' || other.id === 'ghdxlock' ? ': staked HDX stays locked until you unstake it, even once its votes are gone.' : ', not by votes.'}</>
      : nextAfter ? <>Until <MomentText at={nextAfter.at} now={now} /> at the earliest{lockInfo && BigInt(lockInfo.openEnded) > 0n ? '; part backs votes on running referenda' : ''}.</>
      : lockInfo && BigInt(lockInfo.openEnded) > 0n ? 'It backs votes on referenda still running and frees after they end.' : 'Held by conviction locks still running.'
    : null

  if (!accounts.length) return <NoWallet reason="Connect the wallet that holds this account (or one of its Governance proxies) to unlock its HDX." />
  if (!loading && targetId && !matching.length) {
    return <div className="vote-empty"><p>None of your connected accounts is this account or a Governance/Any proxy of it, so none can sign its unlock. Connect the wallet that holds it.</p><button type="button" className="link-btn" onClick={openWallets}>Manage wallets</button></div>
  }

  const details = (
    <>
      {expiredVotes.length > 0 && (
        <Fact k="Finished">
          <ul className="unlock-list">
            {expiredVotes.map(r => {
              const k = keyOf(r)
              return (
                <li key={k}>
                  <label>
                    <input type="checkbox" checked={!excluded.has(k)} onChange={e => setExcluded(prev => { const n = new Set(prev); if (e.target.checked) n.delete(k); else n.add(k); return n })} />
                    <span><Link to={paths.referendum('opengov', r.poll)} className="hash">#{r.poll}</Link> · {describeVote(r.vote)} <span className="muted">· {trackName(r.cls, tracks.data?.tracks)}</span>{r.credits ? <span className="vote-tag">GIGAHDX reward</span> : null}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          Removing these adds no lock: theirs has ended.{running.length ? ` ${running.length} ${running.length === 1 ? 'vote is' : 'votes are'} on referenda still running; they stay.` : ''}
        </Fact>
      )}
      {trackLocks.length > 0 && (
        <Fact k="Track locks">
          {trackLocks.map((l, i) => <span key={l.cls}>{i ? ' · ' : ''}{trackName(l.cls, tracks.data?.tracks)}: <Amt raw={l.amount.toString()} dec={12} /> HDX</span>)}.
          {trackLocks.length > 1 && <> These overlap — {sameAmount ? <>it is the same <Amt raw={trackLocks[0].amount.toString()} dec={12} /> HDX, counted once</> : <>the HDX locked is the largest of them, <Amt raw={trackLocks.reduce((m, l) => (l.amount > m ? l.amount : m), 0n).toString()} dec={12} /> HDX, not their sum</>}.</>}
          {' '}Each is unlocked; HDX that a running vote or an unexpired conviction lock still needs stays locked.
        </Fact>
      )}
      {delegating.length > 0 && <Fact k="Delegation">This account delegates on {delegating.map(c => trackName(c.cls, tracks.data?.tracks)).join(', ')}. Delegation is managed in another app.</Fact>}
      {lockInfo && <Fact k="Dates">“Until” dates come from indexed vote state and the chain’s block pace — an estimate; the amounts come from the dry-run.</Fact>}
    </>
  )

  return (
    <div className="vote-composer">
      <section className="vote-block">
        {loading && !voter ? <div className="skeleton" style={{ height: 52 }} /> : voter && <VoterPicker voters={matching} value={voter} onChange={setPicked} />}
        {actor && <p className="vote-standing">Locked by votes now: <strong><Amt raw={locked.toString()} dec={12} /> HDX</strong>{giga?.pendingRewards ? <> · GIGAHDX rewards waiting: <strong>{formatHdx(giga.pendingRewards, 2)} HDX</strong></> : null}</p>}
      </section>

      <section className="vote-block" aria-label="What changes">
        {/* The answer first: what this frees, what stays, when the rest frees. */}
        <div className="unlock-summary">
          <div><span className="k">Frees now</span><span className={`v${frees && frees > 0n ? ' good' : ''}`}>{frees != null ? `${F.amount(frees.toString(), 12)} HDX` : blocked ? '—' : <span className="skeleton unlock-sk" />}</span></div>
          <div>
            <span className="k">Stays locked{stayCause && <InfoTip label="Why it stays locked">{stayCause}</InfoTip>}</span>
            <span className="v">{staysLocked != null ? `${F.amount(staysLocked.toString(), 12)} HDX` : blocked ? '—' : <span className="skeleton unlock-sk" />}</span>
          </div>
          {nextAfter ? <div><span className="k">Next release</span><span className="v"><MomentText at={nextAfter.at} now={now} withTime={false} /></span></div>
            : lockInfo && BigInt(lockInfo.openEnded) > 0n ? <div><span className="k">Next release</span><span className="v small">after its running votes end</span></div> : null}
          {fx && fx.claimed > 0n && <div><span className="k">Rewards claimed</span><span className="v good">{F.amount(fx.claimed.toString(), 12)} HDX</span></div>}
        </div>
        {expiredVotes.length > 0 && (
          <p className="vote-note">
            {expiredVotes.length - expiredVotes.filter(v => excluded.has(keyOf(v))).length} of {expiredVotes.length} finished {expiredVotes.length === 1 ? 'vote' : 'votes'} removed automatically
            <InfoTip label="Why remove finished votes">On Hydration, removing a finished vote is how its staking points and GIGAHDX voting reward are collected. Their locks have ended, so removing them adds none. Untick one under Details to keep it.</InfoTip>
          </p>
        )}
        {fx && fx.claimed > 0n && <p className="vote-note">Claimed rewards are staked into GIGAHDX: they show as locked there, not as a vote lock.</p>}
        {canClaim && <label className="unlock-claim"><input type="checkbox" checked={!claimOff} onChange={e => setClaimOff(!e.target.checked)} /> Claim the GIGAHDX voting rewards{giga && giga.pendingRewards > 0n ? ` (${formatHdx(giga.pendingRewards, 2)} HDX waiting${rewardsComing ? ', plus what these removals credit' : ''})` : ' these removals credit'}</label>}
        {hasRewards && !proxyCanClaim && <p className="vote-note">A Governance proxy cannot claim this account’s GIGAHDX rewards{giga && giga.pendingRewards > 0n ? ` (${formatHdx(giga.pendingRewards, 2)} HDX waiting)` : ''}: the account claims them itself, or through an Any proxy. The removals here still credit them.</p>}
        {claimRefused && hasRewards && proxyCanClaim && <p className="vote-note">The check showed these removals credit no GIGAHDX reward yet, so the claim is left out.</p>}
      </section>

      {stillLocked.length > 0 && (
        <GovDetails summary={`Also remove finished votes still locked (${stillLocked.length}), optional`} className="unlock-more" open={lockedIncluded.size > 0 ? true : undefined}>
          <p className="vote-note">Removing one now collects its rewards, but the chain keeps one lock per track and merges every removed lock into it — the largest amount, to the latest date.</p>
          <ul className="unlock-list">
            {stillLocked.map(r => {
              const k = keyOf(r)
              return (
                <li key={k}>
                  <label>
                    <input type="checkbox" checked={lockedIncluded.has(k)} onChange={e => setLockedIncluded(prev => { const n = new Set(prev); if (e.target.checked) n.add(k); else n.delete(k); return n })} />
                    <span><Link to={paths.referendum('opengov', r.poll)} className="hash">#{r.poll}</Link> · {describeVote(r.vote)} <span className="muted">· {trackName(r.cls, tracks.data?.tracks)} · locks {formatHdx(r.after!.amount, 0)} HDX until </span>{dateOf(r.after!.until)}{r.credits ? <span className="vote-tag">GIGAHDX reward</span> : null}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          {merged.size > 0 && (
            <div className="vote-warn">
              Removing the ticked ones leaves, per track:
              <ul className="unlock-list plain">
                {[...merged.entries()].map(([cls, m]) => <li key={cls}>{trackName(cls, tracks.data?.tracks)}: <strong>{formatHdx(m.amount, 2)} HDX</strong> locked until {dateOf(m.until)}</li>)}
              </ul>
            </div>
          )}
        </GovDetails>
      )}

      <ReviewPanel
        plan={blocked ? null : plan}
        blocked={blocked}
        tone={frees != null && frees > 0n ? 'primary' : 'neutral'}
        signLabel={frees == null ? 'Unlock & clean up' : frees > 0n ? `Unlock ${F.amount(frees.toString(), 12)} HDX` : 'Clean up'}
        successText={frees != null && frees > 0n ? `Unlocked ${F.amount(frees.toString(), 12)} HDX` : 'Cleaned up'}
        aboveSign={reason}
        outcome={false}
        details={expiredVotes.length || trackLocks.length || delegating.length || lockInfo ? details : null}
        onFinal={stage => { if (stage.phase !== 'failed') refresh(chosen.map(r => r.poll)) }}
      />
    </div>
  )
}
