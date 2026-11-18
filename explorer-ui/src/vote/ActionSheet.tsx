import { useState } from 'react'
import { toSs58 } from './chainWrite'
import type { TxStage, WritePlan } from './chainWrite'
import { ACTIONS_PER_SIGNATURE, actionAmounts, actionSummary, signatureBatches, toVoteAction, useRefreshAfterActions } from './actionLogic'
import { useVoters } from './useVoting'
import { VoterPicker } from './VoterPicker'
import { Fact, ReviewPanel } from './ReviewPanel'
import { usePickedVoter } from './voteLogic'
import { NoWallet } from './WalletDialog'
import { CART_MAX, cartActionKey, closeVote, inCartActions, openWallets, removeCartActions, toggleCartAction, useCart, useCartActions } from './voteBus'
import type { CartAction } from './voteBus'
import { formatHdx } from './voteMath'
import { GovDetails } from '../components/gov/Disclosure'

// The sheet for every signed governance action that is not a vote: placing a
// referendum's decision deposit, refunding a decision or submission deposit, and
// unnoting a preimage (its owner's deposit back). The same engine as voting: the
// call is built exactly as signed, dry-run with the signer as origin, and Sign stays
// disabled while anything says it would fail.
//
// Several actions are signed together in one utility.batchAll, so a reader with five
// refundable deposits signs once; past ACTIONS_PER_SIGNATURE they are split into
// signatures signed in turn. Each step is its own dry-run and signature, the next
// opens once the last is final, and a failure stops the run and names the step.
//
// Refunds are anyone's to sign (they pay the depositor, never the signer); placing a
// deposit pays it from the account the sheet signs as; an unnote can only be signed
// by the preimage's owner (or its Any or Governance proxy), so the account picker is
// narrowed to that account.

/** Past this many actions the sheet says what they come to and keeps the list one step away. */
const LISTED = 5

/** What signing these does, in one line each, for the sheet's list. */
export function ActionList({ items, onRemove }: { items: CartAction[]; onRemove?: (a: CartAction) => void }) {
  return (
    <ul className="cart-list action-list">
      {items.map(a => (
        <li key={cartActionKey(a)}>
          <span className="cart-title">{a.label}{a.amount ? <span className="muted"> · {formatHdx(BigInt(a.amount), 2)} HDX</span> : null}</span>
          {onRemove && <button type="button" className="cart-remove" aria-label={`Take “${a.label}” out of the cart`} onClick={() => onRemove(a)}>Remove</button>}
        </li>
      ))}
    </ul>
  )
}

const SIGN_WORD: Record<CartAction['kind'], string> = {
  'place-decision-deposit': 'Place the deposit',
  'refund-decision-deposit': 'Refund',
  'refund-submission-deposit': 'Refund',
  'unnote-preimage': 'Refund',
}

type StepState = 'done' | 'current' | 'waiting' | 'stopped'

export function ActionSheet({ items, fromCart = false }: { items: CartAction[]; fromCart?: boolean }) {
  const { voters, loading, accounts } = useVoters()
  const cartActions = useCartActions()
  const cartVotes = useCart()
  const refresh = useRefreshAfterActions()
  const [step, setStep] = useState(0)
  const [stopped, setStopped] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)
  // An unnote is its owner's alone: only that account (or a proxy of it) may sign.
  const owners = [...new Set(items.filter(i => i.kind === 'unnote-preimage' && i.owner).map(i => i.owner!.toLowerCase()))]
  const ownerId = owners.length === 1 ? owners[0] : null
  const matching = ownerId ? voters.filter(v => v.actorId.toLowerCase() === ownerId) : voters
  const [voter, setVoter] = usePickedVoter(matching, null, !!ownerId)

  if (!accounts.length) return <NoWallet reason="Connect a wallet to sign this. Refunds are paid to the depositor, whoever signs." />
  if (owners.length > 1) return <div className="vote-empty"><p>These preimages belong to different accounts; each owner unnotes its own. Sign them one account at a time.</p></div>
  if (!loading && ownerId && !matching.length) {
    let shown = ownerId
    try { shown = toSs58(ownerId) } catch { /* keep the hex */ }
    return <div className="vote-empty"><p>Only the account that stored this preimage (<span className="mono">{shown.slice(0, 10)}…</span>) can remove it, or one of its Any or Governance proxies. Connect that wallet.</p><button type="button" className="link-btn" onClick={openWallets}>Manage wallets</button></div>
  }

  const steps = signatureBatches(items)
  const multi = steps.length > 1
  const current = steps[Math.min(step, steps.length - 1)]
  const actions = current.map(toVoteAction)
  const plan: WritePlan | null = voter && !voter.disabled && actions.length
    ? { signer: voter.signer, signerId: voter.signerId, proxy: voter.proxy ? { real: voter.actorId, proxyType: voter.proxy.proxyType } : null, via: voter.via, actions }
    : null
  const blocked = stopped ? 'Nothing more is signed.' : (!voter ? (loading ? 'Reading your accounts…' : 'Connect a wallet to sign.') : voter.disabled)
  const placing = items.find(i => i.kind === 'place-decision-deposit')
  const single = current.length === 1 ? current[0] : null
  const allInCart = items.every(i => inCartActions(i))
  // The cart holds at most CART_MAX items; a list that would not fit is signed from here only.
  const missing = items.filter(i => !inCartActions(i)).length
  const cartable = cartVotes.length + cartActions.length + missing <= CART_MAX
  const words = new Set(current.map(i => SIGN_WORD[i.kind]))
  const baseLabel = single ? SIGN_WORD[single.kind] : words.size === 1 ? `${[...words][0]} ${current.length}` : `Sign ${current.length} actions`
  const signLabel = multi ? `${baseLabel} (${step + 1} of ${steps.length})` : baseLabel
  // What this signature moves, by who pays it (never one sum: a placement and a refund are different accounts' HDX).
  const moves = actionAmounts(current)
  const of = multi ? ' in this signature' : ''
  const stepLabel = (s: CartAction[], i: number) => (s.length === 1 ? s[0].label : `Signature ${i + 1}: ${actionSummary(s).replace(/\.$/, '')}`)
  const stateOf = (i: number): StepState => (finished || i < step ? 'done' : i > step ? 'waiting' : stopped ? 'stopped' : 'current')

  const onFinal = (stage: TxStage) => {
    if (stage.phase === 'in-block') return
    if (stage.phase === 'failed') {
      // A wallet's refusal leaves the step to sign again; anything else ends the run here.
      if (multi && !stage.declined) setStopped(`Stopped at step ${step + 1} of ${steps.length} (${stepLabel(current, step)}): ${stage.message}${step ? ' The steps before it are done.' : ''}`)
      return
    }
    refresh(current)
    if (stage.phase === 'unconfirmed') {
      if (multi && step + 1 < steps.length) setStopped(`Step ${step + 1} was included but not yet seen final. Check it before continuing with the rest.`)
      return
    }
    removeCartActions(current.map(cartActionKey))
    if (step + 1 < steps.length) setStep(step + 1)
    else setFinished(true)
  }

  return (
    <div className="vote-composer">
      <section className="vote-block vote-as" aria-label="Sign as">
        {loading && !voter ? <div className="skeleton" style={{ height: 52 }} /> : voter && <VoterPicker voters={matching} value={voter} onChange={setVoter} label="Sign as" />}
      </section>
      <section className="vote-block">
        {items.length > LISTED ? (
          <>
            <p className="action-summary">{actionSummary(items)}</p>
            <GovDetails summary={`The ${items.length} actions`} className="action-all">
              <ActionList items={items} onRemove={fromCart ? a => removeCartActions([cartActionKey(a)]) : undefined} />
            </GovDetails>
          </>
        ) : <ActionList items={items} onRemove={fromCart ? a => removeCartActions([cartActionKey(a)]) : undefined} />}
        {multi && (
          <>
            <p className="vote-note">Too many for one signature: {steps.length} signatures of up to {ACTIONS_PER_SIGNATURE}, signed one after another.</p>
            <ol className="action-steps" aria-label="Progress">
              {steps.map((s, i) => {
                const st = stateOf(i)
                return (
                  <li key={i} className={`action-step ${st}`} aria-current={st === 'current' ? 'step' : undefined}>
                    <span className="action-step-mark" aria-hidden="true">{st === 'done' ? '✓' : st === 'stopped' ? '✕' : st === 'current' ? '›' : '·'}</span>
                    <span>{stepLabel(s, i)}</span>
                    <span className="sr-only">{st === 'done' ? ', done' : st === 'current' ? ', next to sign' : st === 'stopped' ? ', stopped' : ', waiting'}</span>
                  </li>
                )
              })}
            </ol>
          </>
        )}
        {stopped && <p className="vote-review-bad" role="alert">{stopped}</p>}
        {placing && <p className="vote-note">The deposit is reserved from the account you sign as and refunded to it once the referendum concludes (unless it is killed).</p>}
        {items.some(i => i.kind !== 'place-decision-deposit') && (
          <p className="vote-note">{items.every(i => i.kind === 'unnote-preimage') ? 'The deposit goes back to the preimage’s owner.' : placing ? 'Each refunded deposit goes back to whoever placed it.' : 'Each deposit goes back to whoever placed it; you only pay the fee.'}</p>
        )}
      </section>
      <ReviewPanel
        key={step}
        plan={blocked ? null : plan}
        blocked={blocked}
        signLabel={signLabel}
        successText={single ? `${single.label} — done` : `${current.length} actions done`}
        details={moves.reserved || moves.returned ? (
          <>
            {moves.reserved > 0n && <Fact k="Reserved">{formatHdx(moves.reserved, 2)} HDX{of}, from the account you sign as.</Fact>}
            {moves.returned > 0n && <Fact k="Returned">{formatHdx(moves.returned, 2)} HDX{of}, to whoever placed each deposit.</Fact>}
          </>
        ) : null}
        belowSign={!fromCart && cartable && !allInCart && !multi ? (
          <div className="vote-links"><button type="button" className="link-btn" onClick={() => { for (const i of items) if (!inCartActions(i)) toggleCartAction(i); closeVote() }}>Add to cart</button>{cartActions.length > 0 && <span className="muted">{cartActions.length} already there</span>}</div>
        ) : null}
        onFinal={onFinal}
      />
    </div>
  )
}
