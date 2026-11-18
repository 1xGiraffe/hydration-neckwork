import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, forumApi } from '../api/explorer'
import { Link, paths } from '../router'
import { useSession } from '../session'
import { errorText, useAfterForumWrite } from '../forumSession'
import { ForumSignIn } from '../components/gov/ForumComposer'
import { trackLabel } from '../components/gov/GovUi'
import { originOfTrack, submittedIndex, SUBMISSION_DEPOSIT } from '../proposeLogic'
import type { TxStage, VoteAction, WritePlan } from './chainWrite'
import { useVoters } from './useVoting'
import { VoterPicker } from './VoterPicker'
import { Fact, ReviewPanel } from './ReviewPanel'
import { usePickedVoter } from './voteLogic'
import { NoWallet } from './WalletDialog'
import { openVote } from './voteBus'
import { formatHdx } from './voteMath'
import './vote.css'

// The wizard's last step: one signature that stores the call's preimage (unless the
// chain already stores it) and submits the referendum — utility.batchAll([
// preimage.note_preimage, referenda.submit]) — through the signing engine (built
// exactly as signed, fee quote, dry-run as the signer). Every deposit it takes is listed
// above Sign. The new referendum's number comes from the transaction's own
// Referenda.Submitted once it is final; the decision deposit is then a second, separate
// signature on that number, and the description is published to the forum as the
// referendum's (a signed-in message, no transaction).
//
// The page hands it a frozen call: from the moment the wallet is asked until the
// outcome is known (`onSigning`) nothing upstream may rebuild or remount it.

export interface ProposeSignerProps {
  callHex: string
  hash: string
  len: number
  /** The chain already stores this preimage: nothing to note. */
  noted: boolean
  /** The deposit noting it holds (0 when stored, or already requested). */
  preimageDeposit: bigint
  track: { id: number; name: string; decisionDeposit: string }
  enactment: { after: number } | { at: number }
  /** True from the wallet request until the outcome (in a block, final or failed). */
  onSigning: (signing: boolean) => void
  /** Called with the new referendum's index once the submission is final (the wizard keeps it with its draft). */
  onSubmitted: (index: number) => void
}

function originName(track: string): string {
  const o = originOfTrack(track)
  return o.kind === 'root' ? 'Root' : o.name
}

export function ProposeSigner(props: ProposeSignerProps) {
  const { callHex, hash, len, noted, track, enactment, preimageDeposit } = props
  const { voters, loading, accounts } = useVoters()
  // The reader's own accounts by default; proposing for an account they are a proxy of
  // only when they pick it.
  const [voter, setVoter] = usePickedVoter(voters, null, false)

  const actions: VoteAction[] = [
    ...(noted ? [] : [{ kind: 'note-preimage' as const, bytes: callHex }]),
    { kind: 'submit', origin: originOfTrack(track.name), proposal: { hash, len }, enactment },
  ]
  const plan: WritePlan | null = voter && !voter.disabled
    ? { signer: voter.signer, signerId: voter.signerId, proxy: voter.proxy ? { real: voter.actorId, proxyType: voter.proxy.proxyType } : null, via: voter.via, actions }
    : null

  if (!accounts.length) return <NoWallet reason="Connect the wallet of the account that proposes. It pays the deposits and the fee." />

  const blocked = !voter ? (loading ? 'Reading your accounts…' : 'Connect a wallet to sign.') : voter.disabled
  const total = preimageDeposit + SUBMISSION_DEPOSIT
  const final = (stage: TxStage) => {
    if (stage.phase === 'failed') { props.onSigning(false); return }
    if (stage.phase !== 'finalized' && stage.phase !== 'unconfirmed') return
    const i = submittedIndex(stage.events)
    if (i != null) props.onSubmitted(i)
    props.onSigning(false)
  }

  return (
    <div className="vote-composer pp-sign">
      <section className="vote-block vote-as" aria-label="Sign as">
        {loading && !voter ? <div className="skeleton" style={{ height: 52 }} /> : voter && <VoterPicker voters={voters} value={voter} onChange={setVoter} label="Sign as" />}
        <p className="vote-note">{voter?.proxy
          ? 'The account you act for becomes the proposer and pays the deposits; the signing wallet (its proxy) pays the fee.'
          : 'This account becomes the proposer: it pays the deposits and the fee, and publishes the description.'}</p>
      </section>
      <section className="vote-block" aria-label="Deposits">
        <dl className="pp-deposits">
          <div><dt>Preimage</dt><dd>{preimageDeposit === 0n ? <span className="muted">{noted ? 'already stored, no deposit' : 'requested on chain, no deposit'}</span> : <><span className="mono">≈ {formatHdx(preimageDeposit, 2)} HDX</span> <span className="muted">· back when you remove the preimage</span></>}</dd></div>
          <div><dt>Submission</dt><dd><span className="mono">{formatHdx(SUBMISSION_DEPOSIT, 0)} HDX</span> <span className="muted">· back if it passes or is cancelled</span></dd></div>
          <div className="pp-deposits-total"><dt>Held in all</dt><dd><span className="mono">{formatHdx(total, 2)} HDX</span> <span className="muted">plus the fee</span></dd></div>
        </dl>
      </section>
      <ReviewPanel
        plan={blocked ? null : plan}
        blocked={blocked}
        signLabel={noted ? 'Submit the referendum' : 'Store the call and submit'}
        successText="Referendum submitted"
        onSigned={() => props.onSigning(true)}
        details={
          <>
            <Fact k="Signs">{actions.map(a => (a.kind === 'note-preimage' ? 'preimage.note_preimage' : 'referenda.submit')).join(' → ')}{actions.length > 1 ? ', in one utility.batchAll: all of it or none' : ''}.</Fact>
            <Fact k="Track">{trackLabel(track.name)} ({track.id}) — dispatched as {originName(track.name)}.</Fact>
            <Fact k="Preimage">{hash} · {len.toLocaleString('en-US')} bytes. The preimage deposit is the runtime’s storage price: 401.92 HDX plus 0.03 HDX a byte.</Fact>
          </>
        }
        onFinal={final}
      />
    </div>
  )
}

/** After finality: the new referendum, and its description written natively once the explorer has indexed it. */
export function Submitted({ index, title, body, onWritten, decisionDeposit }: { index: number; title: string; body: string; onWritten: () => void; decisionDeposit: string | null }) {
  const session = useSession()
  const after = useAfterForumWrite()
  const [state, setState] = useState<{ phase: 'idle' | 'writing' | 'done' | 'failed'; error?: string }>({ phase: 'idle' })
  // The api knows the referendum once its block is indexed; the proposer's authority over its description is read from there.
  const detail = useQuery({
    queryKey: ['propose-indexed', index],
    queryFn: ({ signal }) => api.referendum('opengov', index, signal, 1),
    retry: false,
    refetchInterval: q => (q.state.data ? false : 4_000),
  })
  const write = async () => {
    setState({ phase: 'writing' })
    try {
      const r = await forumApi.editPost(`opengov:${index}`, { ...(title.trim() ? { title } : {}), body })
      after(r.generation)
      setState({ phase: 'done' })
      onWritten()
    } catch (e) {
      setState({ phase: 'failed', error: errorText(e) })
    }
  }
  const hasText = body.trim().length > 0
  const dep = detail.data?.deposits
  const needsDeposit = !dep || dep.needsDecisionDeposit
  const placeDeposit = () => openVote({
    kind: 'actions',
    title: `Decision deposit for #${index}`,
    items: [{ kind: 'place-decision-deposit', index, label: `Place the decision deposit on #${index}`, amount: decisionDeposit }],
  })
  return (
    <div className="pp-done" role="status">
      <p><strong>Referendum #{index} is submitted.</strong> <Link to={paths.referendum('opengov', index)}>Open #{index}</Link></p>
      {needsDeposit && decisionDeposit && (
        <div className="pp-deposit-next">
          <button type="button" className={`gov-btn${!hasText || state.phase === 'done' ? ' gov-btn-primary' : ''}`} onClick={placeDeposit}>Place decision deposit on #{index} ({formatHdx(BigInt(decisionDeposit), 0)} HDX)</button>
          <p className="pp-meta">A separate signature, so it can only ever land on #{index}: its number was certain only once the referendum existed.</p>
        </div>
      )}
      {!hasText ? <p className="pp-meta">No description was written; its proposer can add one on the referendum’s page.</p>
        : state.phase === 'done' ? <p className="pp-meta">The description is published on its page.</p>
          : !detail.data ? <p className="vote-review-wait pp-meta"><span className="vote-spinner" aria-hidden="true" />Waiting for the explorer to index #{index} before publishing the description…</p>
            : !session ? <ForumSignIn action="publish the description" />
              : (
                <>
                  <button type="button" className="gov-btn gov-btn-primary" disabled={state.phase === 'writing'} onClick={() => void write()}>{state.phase === 'writing' ? 'Publishing…' : 'Publish the description'}</button>
                  {state.phase === 'failed' && <p className="fc-error" role="alert">{state.error} Your draft is kept in this browser; you can also write it on the referendum’s page.</p>}
                </>
              )}
    </div>
  )
}
