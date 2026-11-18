import { useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, paths } from '../router'
import { chainConstants, estimateFeeHdx, readReferendum } from './chainWrite'
import type { VoteAction, WritePlan } from './chainWrite'
import { CONVICTIONS, ONE_HDX, amountPresets, formatHdx, formatHdxInput, parseHdx, totalBalance, voteSpec } from './voteMath'
import type { Conviction } from './voteMath'
import { clearCart, removeFromCart, setCartDirection, useCart, useCartActions, rememberVote, removeCartActions, cartActionKey } from './voteBus'
import type { Direction } from './voteBus'
import { useActorState, useRefreshAfterWrite, useVoters } from './useVoting'
import { VoterPicker } from './VoterPicker'
import { Fact, ReviewPanel } from './ReviewPanel'
import { ConvictionRuler } from './VoteComposer'
import { describeVote, useLastVote, usePickedVoter } from './voteLogic'
import { NoWallet } from './WalletDialog'
import { RadioGroup } from '../components/RadioGroup'
import { ActionList, ActionSheet } from './ActionSheet'
import { toVoteAction, useRefreshAfterActions } from './actionLogic'
import { useGovClock } from '../hooks/useGovernance'
import { projectBlock } from '../governanceClock'

// The vote cart: several referenda, one amount and conviction, one signature
// (utility.batchAll, wrapped in proxy.proxy when voting for another account).
// batchAll is all-or-nothing, so the dry-run names the vote that would fail.
// The amount starts from the account's last vote when it has one ("Same as last
// time"), else from nothing typed; keeping HDX back for fees is the single vote's
// "More options".

type AmountMode = 'last' | 'full' | 'custom'

export function CartSheet() {
  const cart = useCart()
  const cartActions = useCartActions()
  // Only deposit and refund actions: their own sheet, signed together.
  if (!cart.length && cartActions.length) return <ActionSheet items={cartActions} fromCart />
  return <VoteCart />
}

// The votes (and, when there are any, the cart's other actions in the same signature).
function VoteCart() {
  const cart = useCart()
  const cartActions = useCartActions()
  const refreshActions = useRefreshAfterActions()
  const { voters, loading, accounts } = useVoters()
  const [voter, setVoter] = usePickedVoter(voters)
  const actorQ = useActorState(voter?.actorId ?? null)
  const actor = actorQ.data
  const clock = useGovClock()
  const consts = useQuery({ queryKey: ['vote-consts'], queryFn: chainConstants, staleTime: Infinity })
  const lives = useQueries({ queries: cart.map(c => ({ queryKey: ['vote-referendum', c.index], queryFn: () => readReferendum(c.index), staleTime: 12_000 })) })
  const refresh = useRefreshAfterWrite()
  const last = useLastVote(voter?.actorId ?? null, voter?.actorAddress ?? null, actor, -1)
  // The amount mode defaults once the account is read: its last vote when it has one.
  const [chosenMode, setMode] = useState<AmountMode | null>(null)
  const mode: AmountMode = chosenMode ?? (last ? 'last' : 'custom')
  const [custom, setCustom] = useState('')
  const [conviction, setConviction] = useState<Conviction>(last?.vote.kind === 'Standard' ? last.vote.conviction : 1)
  const [convTouched, setConvTouched] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  if (!convTouched && last?.vote.kind === 'Standard' && last.vote.conviction !== conviction && mode === 'last') setConviction(last.vote.conviction)

  const proxy = voter?.proxy ? { real: voter.actorId, proxyType: voter.proxy.proxyType } : null
  const feeQ = useQuery({
    queryKey: ['vote-fee-est', voter?.key ?? '', cart.length],
    queryFn: () => estimateFeeHdx({ signer: voter!.signer, signerId: voter!.signerId, proxy, via: voter!.via, actions: cart.map(c => ({ kind: 'vote' as const, poll: c.index, vote: { kind: 'Standard' as const, aye: true, conviction: 1 as Conviction, balance: ONE_HDX } })) }),
    enabled: !!voter && !voter.disabled && cart.length > 0,
    staleTime: 60_000,
  })
  const fee = feeQ.data ?? null
  const feeFromActor = actor && !proxy && actor.feeCurrency === 0 ? (fee ?? ONE_HDX) : 0n
  const presets = actor ? amountPresets(actor.hdx, { feeInHdxFromActor: feeFromActor, reserve: 0n }) : null
  const lastAmount = last ? (last.vote.kind === 'Standard' ? last.vote.balance : null) : null
  const amount = mode === 'full' ? presets?.full ?? null
    : mode === 'last' ? lastAmount
    : parseHdx(custom)

  if (!accounts.length) return <NoWallet reason="Connect a wallet to sign the votes in your cart." />
  if (!cart.length && done) return <div className="vote-stage done" role="status"><strong>{done}</strong><span>Final on chain. The pages update as the explorer indexes it.</span></div>
  if (!cart.length) return <div className="vote-empty"><p>Your cart is empty. Add referenda from a referendum page or from “Needs your vote”, then sign them all at once.</p><Link to={paths.governanceMe()} className="link-btn">See what needs your vote</Link></div>

  const closed = cart.filter((_c, i) => lives[i]?.data && !lives[i].data!.ongoing).map(c => c.index)
  const trackOf = (i: number) => lives[i]?.data?.track ?? cart[i].track
  const perClass = new Map<number, number>()
  cart.forEach((c, i) => {
    const t = trackOf(i)
    if (t == null) return
    const standing = actor?.voting.find(v => v.cls === t)?.votes ?? []
    if (!perClass.has(t)) perClass.set(t, standing.length)
    if (!standing.some(v => v.poll === c.index)) perClass.set(t, (perClass.get(t) ?? 0) + 1)
  })
  const full = [...perClass.entries()].find(([, n]) => consts.data && n > consts.data.maxVotes)

  let blocked: string | null = null
  if (!voter) blocked = 'Connect a wallet to vote.'
  else if (voter.disabled) blocked = voter.disabled
  else if (closed.length) blocked = `Voting has closed on ${closed.map(i => `#${i}`).join(', ')}. Take ${closed.length === 1 ? 'it' : 'them'} out of the cart.`
  else if (amount == null || amount <= 0n) blocked = mode === 'last' ? 'This account has no earlier vote to copy. Choose another amount.' : 'Enter how much HDX to vote with.'
  else if (actor && amount > totalBalance(actor.hdx)) blocked = `That is more than this account holds (${formatHdx(totalBalance(actor.hdx), 2)} HDX).`
  else if (full) blocked = `This would put more than ${consts.data?.maxVotes} votes on one track. Remove votes on finished referenda first (Unlock & clean up).`
  // The staking pallet's own limit: every vote of a staking position, across all tracks.
  const stakingNew = actor?.staking ? cart.filter(c => !actor.staking!.votes.has(c.index)).length : 0
  if (!blocked && actor?.staking && actor.staking.votes.size + stakingNew > actor.staking.maxVotes) {
    blocked = `This account’s staking position tracks ${actor.staking.votes.size} votes; these ${stakingNew} new ones would pass the staking pallet’s limit of ${actor.staking.maxVotes} (across all tracks). Remove votes on finished referenda first — “Unlock & clean up” frees one slot for each vote it removes${actor.staking.votes.size < actor.staking.maxVotes ? `, or vote on at most ${actor.staking.maxVotes - actor.staking.votes.size} new referenda here` : ''}.`
  }

  // A vote only raises a track's lock: where a track holds more than this amount, the
  // batch ends by unlocking it so the difference is actually freed.
  const releaseTracks = amount && actor ? [...new Set(cart.map((_c, i) => trackOf(i)).filter((t): t is number => t != null && (actor.classLocks.find(l => l.cls === t)?.amount ?? 0n) > amount))] : []
  const actions: VoteAction[] = amount && amount > 0n ? [
    ...cart.map(c => ({ kind: 'vote' as const, poll: c.index, vote: voteSpec(c.direction, amount, c.direction === 'abstain' ? 0 : conviction) })),
    ...releaseTracks.map(cls => ({ kind: 'unlock' as const, cls, target: voter!.actorId })),
    ...cartActions.map(toVoteAction),
  ] : []
  const plan: WritePlan | null = voter && !voter.disabled && actions.length ? { signer: voter.signer, signerId: voter.signerId, proxy, via: voter.via, actions } : null
  const lockPeriod = consts.data?.voteLockingPeriod ?? 302_400

  return (
    <div className="vote-composer">
      <section className="vote-block vote-as" aria-label="Vote as">
        {loading && !voter ? <div className="skeleton" style={{ height: 52 }} /> : voter && <VoterPicker voters={voters} value={voter} onChange={setVoter} />}
      </section>

      <section className="vote-block">
        <div className="vote-label">{cart.length} {cart.length === 1 ? 'referendum' : 'referenda'}</div>
        <ul className="cart-list">
          {cart.map((c, i) => (
            <li key={c.index} className={closed.includes(c.index) ? 'off' : ''}>
              <Link to={paths.referendum('opengov', c.index)} className="cart-title"><span className="mono muted">#{c.index}</span> {c.title ?? `Referendum #${c.index}`}</Link>
              <RadioGroup className="cart-dirs" aria-label={`Vote on #${c.index}`}>
                {(['aye', 'nay', 'abstain'] as Direction[]).map(d => (
                  <button key={d} type="button" role="radio" aria-checked={c.direction === d} className={`vote-dir sm ${d}${c.direction === d ? ' on' : ''}`} onClick={() => setCartDirection(c.index, d)}>{d === 'aye' ? 'Aye' : d === 'nay' ? 'Nay' : 'Abstain'}</button>
                ))}
                <button type="button" className="cart-remove" aria-label={`Take #${c.index} out of the cart`} onClick={() => removeFromCart(c.index)}>Remove</button>
              </RadioGroup>
              {lives[i]?.data && !lives[i].data!.ongoing && <span className="vote-warn">Voting has closed.</span>}
            </li>
          ))}
        </ul>
      </section>

      {cartActions.length > 0 && (
        <section className="vote-block">
          <div className="vote-label">Also in this signature</div>
          <ActionList items={cartActions} onRemove={a => removeCartActions([cartActionKey(a)])} />
        </section>
      )}

      <section className="vote-block">
        <div className="vote-label" id="cart-amount">Amount, for each vote</div>
        <RadioGroup className="vote-chips" aria-labelledby="cart-amount">
          {last && <button type="button" role="radio" aria-checked={mode === 'last'} className={mode === 'last' ? 'on' : ''} title={`Your vote on #${last.poll}: ${describeVote(last.vote)}`} onClick={() => { setMode('last'); setConvTouched(false) }}>Same as last time</button>}
          <button type="button" role="radio" aria-checked={mode === 'full'} className={mode === 'full' ? 'on' : ''} title={presets ? `${formatHdx(presets.full, 2)} HDX` : undefined} onClick={() => setMode('full')}>Max</button>
          <button type="button" role="radio" aria-checked={mode === 'custom'} className={mode === 'custom' ? 'on' : ''} onClick={() => { setMode('custom'); if (!custom && amount) setCustom(formatHdxInput(amount)) }}>Other</button>
        </RadioGroup>
        {mode === 'custom' && <div className="vote-amount"><input aria-label="Amount in HDX" inputMode="decimal" autoComplete="off" value={custom} onChange={e => setCustom(e.target.value)} placeholder="0" /><span className="vote-unit">HDX</span></div>}
        <div className="vote-help">
          {amount != null && amount > 0n && <p>Each vote uses <strong>{formatHdx(amount, 2)} HDX</strong> · the same HDX backs them all</p>}
          {mode === 'last' && last && <p className="vote-prefill">Copied from your vote on #{last.poll}: {describeVote(last.vote)}{convTouched ? '' : ', conviction included'}</p>}
        </div>
      </section>

      {cart.some(c => c.direction !== 'abstain') && (
        <section className="vote-block">
          <ConvictionRuler value={conviction} onChange={c => { setConviction(c); setConvTouched(true) }} amount={amount ?? 0n} lockPeriod={lockPeriod} msPerBlock={clock.data?.msPerBlock ?? 2000} endBlock={null} endMs={b => (clock.data ? projectBlock(clock.data, b) : null)}
            side={cart.every(c => c.direction === 'aye') ? 'Aye' : cart.every(c => c.direction === 'nay') ? 'Nay' : null} />
          {cart.some(c => c.direction === 'abstain') && <p className="vote-note">Abstain votes count without conviction.</p>}
        </section>
      )}

      <ReviewPanel
        plan={blocked ? null : plan}
        blocked={blocked}
        details={amount != null && amount > 0n ? <Fact k="Amount">Each vote locks {formatHdx(amount, 2)} HDX in place. Locks overlap rather than add up: the same HDX backs every vote at once.{mode === 'full' ? ' Max keeps back only this signature’s fee; later fees (removing these votes, unlocking) need HDX left unlocked or another asset.' : ''}</Fact> : null}
        signLabel={`Sign ${cart.length} ${cart.length === 1 ? 'vote' : 'votes'}`}
        successText={amount ? `Voted on ${cart.map(c => `#${c.index}`).join(', ')} with ${formatHdx(amount, 2)} HDX at ${CONVICTIONS[conviction].label}` : 'Voted'}
        onFinal={(stage, rv) => {
          if (stage.phase === 'failed') return
          const actorId = rv.plan.proxy?.real ?? rv.plan.signerId
          for (const a of rv.plan.actions) if (a.kind === 'vote') rememberVote({ actorId, index: a.poll, direction: a.vote.kind === 'Standard' ? (a.vote.aye ? 'aye' : 'nay') : 'abstain', conviction: a.vote.kind === 'Standard' ? a.vote.conviction : null, balance: (a.vote.kind === 'Standard' ? a.vote.balance : 0n).toString(), at: Date.now() })
          refresh(rv.plan.actions.flatMap(a => (a.kind === 'vote' ? [a.poll] : [])))
          if (cartActions.length) refreshActions(cartActions)
          if (stage.phase === 'finalized') {
            setDone(`Voted on ${rv.plan.actions.flatMap(a => (a.kind === 'vote' ? [`#${a.poll}`] : [])).join(', ')}.`)
            clearCart(rv.plan.actions.flatMap(a => (a.kind === 'vote' ? [a.poll] : [])))
            removeCartActions(cartActions.map(cartActionKey))
          }
        }}
      />
    </div>
  )
}
