import { useState } from 'react'
import type React from 'react'
import { Link, paths } from '../router'
import { signAndTrack } from './chainWrite'
import { planKey, signGate, useReview } from './useReview'
import type { Review, TxStage, WritePlan } from './chainWrite'
import { formatHdx, formatUnits } from './voteMath'
import { GovDetails } from '../components/gov/Disclosure'

// The last step of every signed action: what the chain says it would do (a dry-run
// with the signer as origin) in one line, every reason it cannot go through in full,
// and the Sign button with its fee, which stays disabled while anything says it
// would fail. The sheet's explanations, the fee in detail and the exact call sit in
// one closed "Details" at the end. After signing it follows the transaction to
// finality and reports the outcome in words; once the call is in a block, Sign stays
// off for that plan (`signGate`).

function feeAmount(rv: Review): string {
  const f = rv.fee
  if (!f) return 'unknown'
  return f.path === 'evm-dispatch'
    ? `${formatUnits(f.amount, 18, 8)} WETH`
    : `${formatUnits(f.amount, f.currency.decimals, f.currency.decimals > 6 ? 4 : f.currency.decimals)} ${f.currency.symbol}`
}

function feeText(rv: Review): string {
  const f = rv.fee
  if (!f) return 'fee unknown'
  return `${f.estimate ? 'up to ≈' : '≈'} ${feeAmount(rv)}`
}

const SOURCE_WORDS: Record<string, string> = {
  native: 'The chain’s own fee quote (TransactionPaymentApi.query_info), in HDX.',
  oracle: 'The chain’s own fee quote in HDX, converted at the price the fee payment itself applies (the 10-minute oracle price, read through XcmPaymentApi).',
  fallback: 'The chain’s fee quote in HDX, converted at the stored fallback price because the oracle has none for this asset — an estimate; the real charge can differ.',
  gas: 'An upper bound: the signed gas limit × the gas price (+5%). The chain charges the gas actually used, converted to the fee currency.',
}

/** One fact in a sheet's Details: a short name and what it says. */
export function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return <div><dt>{k}</dt><dd>{children}</dd></div>
}

/** The review's own facts for the sheet's Details: the fee in full, how it is signed, and the exact call. */
function ReviewFacts({ rv }: { rv: Review }) {
  const f = rv.fee
  return (
    <>
      {f && <Fact k="Fee">{feeText(rv)}{rv.simulation.paysFee === false ? ', refunded: the chain gives the fee back for this call, so it costs nothing (the signer still needs it for a moment)' : ''}{f.hdx != null && f.currency.id !== 0 ? <span className="muted"> (≈ {formatHdx(f.hdx, 6)} HDX)</span> : null}, paid by {rv.plan.proxy ? 'the signing account (the proxy)' : 'the voting account'}{f.path === 'evm-dispatch' ? ' in WETH (gas)' : f.currency.id !== 0 ? ` in ${f.currency.symbol} (asset ${f.currency.id})` : ''}. {SOURCE_WORDS[f.priceSource]}</Fact>}
      {f?.gasLimit != null && <Fact k="Gas limit">{f.gasLimit.toString()}</Fact>}
      <Fact k="How">{pathText(rv)}</Fact>
      <Fact k="Call"><code className="vote-callhex" data-callhex={rv.callHex}>{rv.callHex.length > 66 ? `${rv.callHex.slice(0, 34)}…${rv.callHex.slice(-30)}` : rv.callHex}</code> <span className="muted">({(rv.callHex.length - 2) / 2} bytes, exactly what the wallet is asked to sign)</span></Fact>
    </>
  )
}

function pathText(rv: Review): string {
  const f = rv.fee
  const who = rv.plan.signer.walletName
  if (!f || f.path === 'substrate') return `${who} signs the transaction.`
  if (f.path === 'evm-permit') return `${who} signs a call permit, which the explorer submits; the gas it uses is charged as a fee in ${f.currency.symbol} to your Hydration account.`
  return `${who} sends it as an EVM transaction to Hydration’s dispatch precompile; gas is paid in WETH, your account’s fee currency.`
}

export function StageView({ stage, successText, onRetry }: { stage: TxStage; successText: string; onRetry?: () => void }) {
  const link = (b: number, i: number | null | undefined) => (i != null ? <Link to={paths.extrinsic(`${b}-${i}`)} className="hash">#{b}-{i}</Link> : <Link to={paths.block(b)} className="hash">block #{b}</Link>)
  switch (stage.phase) {
    case 'checking': return <div className="vote-stage pending" role="status"><span className="vote-spinner" aria-hidden="true" />Checking it against the chain once more…</div>
    case 'wallet': return <div className="vote-stage pending" role="status"><span className="vote-spinner" aria-hidden="true" />Confirm in your wallet…</div>
    case 'submitted': return <div className="vote-stage pending" role="status"><span className="vote-spinner" aria-hidden="true" />Sent. Waiting for the next block…</div>
    case 'in-block': return <div className="vote-stage pending" role="status"><span className="vote-spinner" aria-hidden="true" />In {link(stage.blockNumber, stage.txIndex)}. Waiting for finality…</div>
    case 'unconfirmed': return (
      <div className="vote-stage done" role="status">
        <strong>{successText} — included, not yet seen final</strong>
        <span>In {link(stage.blockNumber, stage.txIndex)}, which finality had not reached after three minutes. It is very likely final soon; check the block before trying again.</span>
      </div>
    )
    case 'finalized': return (
      <div className="vote-stage done" role="status">
        <strong>{successText}</strong>
        <span>Final in {link(stage.blockNumber, stage.txIndex)}.{stage.outcome.length ? ` ${stage.outcome.join(' · ')}.` : ''} The page updates as the explorer indexes it.</span>
      </div>
    )
    case 'failed':
      if (stage.declined) return <div className="vote-stage failed" role="alert"><strong>Not sent — your wallet declined.</strong> <span>Nothing changed.</span>{onRetry && <> <button type="button" className="link-btn" onClick={onRetry}>Try again</button></>}</div>
      return <div className="vote-stage failed" role="alert"><strong>Not done.</strong> <span>{stage.message}</span>{stage.blockNumber != null && <> {link(stage.blockNumber, stage.txIndex)}</>}</div>
  }
}

const REVIEW_MAX_AGE_MS = 5_000

export function ReviewPanel({ plan, blocked, signLabel, successText, onFinal, onSigned, details, aboveSign, belowSign, tone = 'primary', outcome = true }: {
  plan: WritePlan | null
  /** A reason the plan cannot be reviewed yet (no amount, no direction…). */
  blocked: string | null
  signLabel: string
  successText: string
  onFinal?: (stage: TxStage, rv: Review) => void
  onSigned?: (rv: Review) => void
  /** The sheet's own explanations as `<Fact>` rows, first inside its one closed "Details" (the review's fee and call follow). */
  details?: React.ReactNode
  /** One-line facts that must be read before signing (a vote that flips the outcome, what a clean-up does). */
  aboveSign?: React.ReactNode
  /** Secondary actions as text links under Sign. */
  belowSign?: React.ReactNode
  /** The lavender primary, or a neutral outline for an action that frees or changes nothing visible. */
  tone?: 'primary' | 'neutral'
  /** Say what the dry-run did on the check line (off where the sheet states it itself). */
  outcome?: boolean
}) {
  // "Pay this fee in HDX": the same plan with set_currency(HDX) first, offered when the
  // signer cannot pay in its own fee currency but holds enough unlocked HDX.
  // The choice belongs to one signer and one account: picking another resets it, and
  // an EVM signer never gets it (its fee is charged by the EVM path).
  const [feeChoice, setFeeChoice] = useState<{ who: string; on: boolean }>({ who: '', on: false })
  const who = plan ? `${plan.signer.id}|${plan.proxy?.real ?? plan.signerId}` : ''
  const feeInHdx = feeChoice.on && feeChoice.who === who && plan?.signer.kind !== 'evm'
  const setFeeInHdx = (on: boolean) => setFeeChoice({ who, on })
  const effective = plan && feeInHdx ? { ...plan, feeInHdx: true } : plan
  const q = useReview(effective, blocked)
  const [stage, setStage] = useState<TxStage | null>(null)
  const [stageKey, setStageKey] = useState('')
  const key = planKey(effective)
  // A new plan clears a finished outcome; a running one keeps going until it settles.
  if (stage && stageKey !== key && (stage.phase === 'finalized' || stage.phase === 'failed' || stage.phase === 'unconfirmed')) { setStage(null); setStageKey(key) }
  const rv = q.data && !q.stale ? q.data : null
  // The stage belongs to this plan here (a new plan has cleared a settled one above).
  const { busy, done, recheck } = signGate(stage)
  const canSign = !!rv && !rv.blockers.length && !busy && !done && !blocked
  const short = rv?.feeShortfall ?? null

  async function sign() {
    if (!rv) return
    setStageKey(key)
    // A review older than a few seconds is redone first: a proxy removed, a referendum
    // closed or a balance moved since must stop the signature, not follow it.
    // So is one whose call was just included and failed on chain: the chain moved since.
    let fresh: Review = rv
    if (recheck || Date.now() - q.dataUpdatedAt > REVIEW_MAX_AGE_MS) {
      setStage({ phase: 'checking' })
      const r = await q.refetch()
      if (!r.data || r.data.blockers.length || r.data.callHex !== rv.callHex) {
        setStage({ phase: 'failed', message: r.data?.blockers[0] ?? (r.data ? 'The transaction changed since it was reviewed — check it again.' : 'The final check could not run. Try again.') })
        return
      }
      fresh = r.data
    }
    setStage({ phase: 'wallet' })
    onSigned?.(fresh)
    const final = await signAndTrack(fresh, s => {
      setStage(s)
      if (s.phase === 'in-block') onFinal?.(s, fresh)
    })
    if (final.phase === 'finalized' || final.phase === 'failed' || final.phase === 'unconfirmed') onFinal?.(final, fresh)
  }

  // One short line for screen readers, separate from the review itself, so a change
  // to the fee table or the button does not re-read the whole panel.
  const status = blocked ?? (!plan ? ''
    : q.isFetching || q.stale ? 'Checking it against the chain…'
    : q.error ? 'The check could not run.'
    : rv ? (short ? 'Won’t go through: this account can’t pay the fee.'
      : rv.simulation.status === 'failed' ? `Would fail: ${rv.simulation.message}`
      : rv.blockers.length ? rv.blockers[0]
      : rv.simulation.paysFee === false ? 'Ready to sign. Free: the fee is refunded.' : `Ready to sign. Fee ${feeText(rv)}.`)
    : '')

  // What the check found, in one line right above Sign; the fee rides on the button.
  const checkLine = blocked ? <p className="vote-review-wait">{blocked}</p>
    : !plan ? null
    : q.isFetching || q.stale ? <p className="vote-review-wait"><span className="vote-spinner" aria-hidden="true" />Checking it against the chain…</p>
    : q.error ? <p className="vote-review-bad">The check could not run: {q.error instanceof Error ? q.error.message : String(q.error)}. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></p>
    : !rv ? null
    : short ? null
    : rv.simulation.status === 'failed' ? <p className="vote-review-bad"><span aria-hidden="true">✕</span> Would fail: {rv.simulation.message}{rv.simulation.code ? <span className="vote-code"> ({rv.simulation.code})</span> : null}</p>
    : rv.simulation.status === 'ok' ? <p className="vote-review-ok"><span aria-hidden="true">✓</span> Checked on chain{outcome && rv.simulation.outcome.length ? `: ${rv.simulation.outcome.join('; ')}` : ''}{rv.simulation.paysFee === false ? ' · free (the fee is refunded)' : ''}</p>
    : <p className="vote-review-wait">Not checked on chain: {rv.simulation.message ?? 'the dry-run is unavailable'}.</p>

  return (
    <div className="vote-review">
      <p className="sr-only" role="status">{status}</p>
      {checkLine}
      {stage && <StageView stage={stage} successText={successText} onRetry={canSign ? () => void sign() : undefined} />}
      {rv && !blocked && !(q.isFetching || q.stale) && short && (
        <div className="vote-fee-short" role="alert">
          <strong>Won’t go through: this account can’t pay the fee.</strong>
          <p>{short.isHdx
            ? <>It pays fees in HDX and has about {formatUnits(short.has, short.decimals, 4)} HDX that isn’t locked; the fee is about {formatUnits(short.needs, short.decimals, 4)} HDX. Unlock some HDX or add some to this account first.</>
            : <>It pays fees in {short.symbol} and holds {short.has > 0n ? <>only {formatUnits(short.has, short.decimals, 4)} {short.symbol}</> : 'none'} that isn’t locked; the fee is about {formatUnits(short.needs, short.decimals, 4)} {short.symbol}. Add some {short.symbol}, or {short.hdxWouldWork ? 'pay this fee in HDX:' : <>switch its fee currency to HDX in the <a href="https://app.hydration.net" target="_blank" rel="noopener noreferrer">Hydration app</a>.</>}</>}</p>
          {short.hdxWouldWork && <label className="vote-fee-switch"><input type="checkbox" checked={feeInHdx} onChange={e => setFeeInHdx(e.target.checked)} /> Pay the fee in HDX. This also makes HDX the account’s fee currency for later transactions.</label>}
        </div>
      )}
      {rv && !blocked && feeInHdx && !short && <label className="vote-fee-switch on"><input type="checkbox" checked onChange={() => setFeeInHdx(false)} /> Paying the fee in HDX — this also makes HDX the account’s fee currency.</label>}
      {rv && !blocked && rv.blockers.length > (short ? 1 : 0) && <ul className="vote-blockers" role="alert">{rv.blockers.filter(b => !(short && b.startsWith('The signing account cannot pay the fee'))).map(b => <li key={b}>{b}</li>)}</ul>}
      {aboveSign}
      {/* Sign stays at the foot of the sheet on phones, however long the form above. */}
      <div className="vote-sign-bar">
        <button type="button" className={`vote-sign${tone === 'neutral' ? ' neutral' : ''}`} disabled={!canSign} onClick={() => void sign()}>
          {busy ? 'Signing…' : done ? `${signLabel} · signed` : rv?.fee ? (rv.simulation.paysFee === false ? `${signLabel} · free` : `${signLabel} · fee ${feeText(rv)}`) : signLabel}
        </button>
      </div>
      {belowSign}
      {(details || rv) && (
        <GovDetails summary="Details" className="vote-details">
          <dl className="vote-facts">
            {details}
            {rv && <ReviewFacts rv={rv} />}
          </dl>
        </GovDetails>
      )}
    </div>
  )
}
