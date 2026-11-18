import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDocumentTitle, useNoindex } from '../hooks/useDocumentTitle'
import { useGovClock, useGovTracks } from '../hooks/useGovernance'
import { govApi } from '../api/explorer'
import { Link, paths } from '../router'
import { lazyWithReload } from '../lazyWithReload'
import { CopyTextButton, Crumbs, SkeletonRows } from '../components/ui'
import { MarkdownEditor } from '../markdown/MarkdownEditor'
import { GovDetails, InfoTip } from '../components/gov/Disclosure'
import { humanDate, trackLabel } from '../components/gov/GovUi'
import { TrackFacts } from '../components/gov/trackRules'
import { PURPOSE, days } from '../components/gov/trackRuleText'
import { SummaryView } from '../components/gov/Verdict'
import { ProposalCall } from '../components/ProposalCall'
import { summarizeProposal } from '../utils/whatThisDoes'
import { projectBlock } from '../governanceClock'
import { parseHdx, formatHdx } from '../vote/voteMath'
import {
  DRAFT_KEY, EMPTY_DRAFT, HASH_RE, SPEND_LIMITS, daysToBlock, depositToNote, discussionLine, readDraft, suggestSpendTrack, trackCanSpend,
  type CallDraft, type ProposeDraft,
} from '../proposeLogic'
import type { GovernanceTrackInfo } from '../governanceTypes'
import type { BuiltCall, PreimageInfo } from '../vote/proposeChain'
import '../components/gov/forum.css'
// The review lines (checked / would fail / waiting) read the same here as in the signing sheets.
import '../vote/vote.css'

// /governance/propose: a referendum from nothing, in five steps that follow the chain's
// own order — say what it is (the description, written here or started from a
// discussion), build the call (a treasury spend, a remark, pasted call data or a
// preimage already stored), see its preimage (hash, length, the deposit noting it
// holds), pick the track (suggested from the call: a spend goes to the smallest track
// whose origin may pay that much) and when it is enacted, then sign it all at once.
// The draft lives in this browser until the description is written. The call is
// built and checked against the live metadata, and the signing engine loads only for
// the last step; nothing is signed before the wallet asks.

const ProposeSigner = lazyWithReload(() => import('../vote/ProposeSigner').then(m => ({ default: m.ProposeSigner })))
const Submitted = lazyWithReload(() => import('../vote/ProposeSigner').then(m => ({ default: m.Submitted })))

const STEPS = ['Describe', 'The call', 'Preimage', 'Track', 'Submit'] as const
const TITLE_MAX = 160
const BODY_MAX = 50_000

function loadDraft(): ProposeDraft {
  try { return readDraft(localStorage.getItem(DRAFT_KEY)) } catch { return EMPTY_DRAFT }
}

function useDraft(): [ProposeDraft, (patch: Partial<ProposeDraft>) => void, () => void] {
  const [draft, setDraft] = useState<ProposeDraft>(loadDraft)
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* private window: kept for this visit only */ } }, 400)
    return () => clearTimeout(t)
  }, [draft])
  const clear = () => { try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ } setDraft(EMPTY_DRAFT) }
  return [draft, patch => setDraft(d => ({ ...d, ...patch })), clear]
}

/** The chain side of the wizard (dedot and the engine's client), loaded once a call is to be built. */
function useChain(enabled: boolean) {
  return useQuery({ queryKey: ['propose-chain-module'], queryFn: () => import('../vote/proposeChain'), enabled, staleTime: Infinity, retry: 1 })
}

function callKey(c: CallDraft): string {
  return JSON.stringify(c)
}

type BuildResult = { built: BuiltCall; preimage: PreimageInfo } | { error: string }

/**
 * The call the draft describes, built and decoded, plus what the chain stores under its
 * hash. Its key is the draft's call alone — never the head — so a call, once built,
 * keeps its bytes and its preimage hash while the chain moves on.
 */
function useBuiltCall(draft: ProposeDraft, enabled: boolean) {
  const chain = useChain(enabled)
  const clock = useGovClock().data
  // Built once typing pauses, not on every keystroke.
  const [call, setCall] = useState(draft.call)
  useEffect(() => { const t = setTimeout(() => setCall(draft.call), 400); return () => clearTimeout(t) }, [draft.call])
  const q = useQuery<BuildResult>({
    queryKey: ['propose-call', callKey(call)],
    enabled: enabled && !!chain.data && !!clock,
    staleTime: Infinity,
    retry: 0,
    placeholderData: keepPreviousData,
    queryFn: () => withTimeout(buildIt(), CHAIN_TIMEOUT_MS),
  })
  // While the debounce holds a newer draft, or a placeholder stands in for the new
  // answer, what is on screen is for an older call.
  const current = callKey(call) === callKey(draft.call) && !q.isPlaceholderData
  return { ...q, isFetching: q.isFetching || !current, data: (current ? q.data : undefined) as BuildResult | undefined }
  async function buildIt(): Promise<BuildResult> {
    const m = chain.data!
    if (call.kind === 'hash') {
      const hash = call.hash.trim().toLowerCase()
      if (!HASH_RE.test(hash)) return { error: 'Paste a preimage hash: 0x and 64 hex characters.' }
      const pre = await m.readPreimage(hash)
      if (!pre.noted) return { error: pre.len == null && pre.requested ? 'The chain has requested this preimage but does not store its bytes. Paste the call data instead.' : 'The chain stores no preimage under this hash. Paste the call data instead.' }
      return { built: await m.describeCall(pre.callHex!), preimage: pre }
    }
    const built = await m.buildTemplateCall(call, { headBlock: clock!.headBlock })
    if ('error' in built) return built
    return { built, preimage: await m.readPreimage(built.hash) }
  }
}

// The node answers in well under a second; past this the wizard says it cannot reach it
// instead of waiting on a connection that keeps retrying.
const CHAIN_TIMEOUT_MS = 15_000
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer from the node')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

function Stepper({ step, reached, onStep }: { step: number; reached: number; onStep: (i: number) => void }) {
  const ref = useRef<HTMLOListElement>(null)
  // On a phone the strip scrolls: keep the current step in view.
  useEffect(() => {
    const ol = ref.current, li = ol?.querySelector<HTMLLIElement>('li.on')
    if (!ol || !li) return
    const o = ol.getBoundingClientRect(), r = li.getBoundingClientRect()
    if (r.right > o.right || r.left < o.left) ol.scrollLeft += r.left - o.left - 8
  }, [step])
  return (
    // Focusable so a keyboard reader can scroll the strip on a phone, where it overflows.
    <ol className="pp-steps" aria-label="Steps" ref={ref} tabIndex={0}>
      {STEPS.map((label, i) => (
        <li key={label} className={i === step ? 'on' : i <= reached ? 'done' : ''}>
          {i <= reached && i !== step
            ? <button type="button" className="pp-step" onClick={() => onStep(i)}><span className="pp-step-n" aria-hidden="true">{i + 1}</span>{label}</button>
            : <span className="pp-step" aria-current={i === step ? 'step' : undefined}><span className="pp-step-n" aria-hidden="true">{i + 1}</span>{label}</span>}
        </li>
      ))}
    </ol>
  )
}

function StepFoot({ hint, next, onNext, onBack }: { hint: string | null; next: string; onNext: () => void; onBack?: () => void }) {
  return (
    <div className="pp-foot">
      {onBack && <button type="button" className="gov-btn" onClick={onBack}>Back</button>}
      <button type="button" className="gov-btn gov-btn-primary" disabled={!!hint} title={hint ?? undefined} onClick={onNext}>{next}</button>
      {hint && <span className="pp-hint" aria-live="polite">{hint}</span>}
    </div>
  )
}

/* ---- step 1: describe ---- */

function FromDiscussion({ onPick }: { onPick: (d: { postId: string; title: string; body: string }) => void }) {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 350); return () => clearTimeout(t) }, [q])
  const id = useId()
  const list = useQuery({
    queryKey: ['propose-discussions', term],
    queryFn: ({ signal }) => govApi.discussions({ sort: term ? 'active' : 'new', q: term || undefined, limit: 6 }, signal),
    staleTime: 60_000,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const pick = async (postId: string, title: string) => {
    setBusy(postId)
    try {
      const post = await govApi.post(postId)
      if ('body' in post) onPick({ postId, title: post.title || title, body: post.body })
    } finally { setBusy(null) }
  }
  const rows = list.data?.rows ?? []
  return (
    <div className="pp-from">
      <label htmlFor={`${id}-q`} className="pe-label">Find the discussion</label>
      <input id={`${id}-q`} className="pe-input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Words from its title" autoComplete="off" />
      {list.isLoading ? <SkeletonRows rows={3} /> : !rows.length ? <p className="gov-empty">No discussion matches.</p> : (
        <ul className="pp-from-list">
          {rows.map(r => (
            <li key={r.postId}>
              <button type="button" className="link-btn" disabled={!!busy} onClick={() => void pick(r.postId, r.title ?? '')}>{busy === r.postId ? 'Copying…' : r.title || `Discussion ${r.postId}`}</button>
              <span className="pp-meta">{r.commentsCount ?? 0} {r.commentsCount === 1 ? 'comment' : 'comments'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DescribeStep({ draft, set, onNext }: { draft: ProposeDraft; set: (p: Partial<ProposeDraft>) => void; onNext: () => void }) {
  const id = useId()
  const hint = !draft.title.trim() ? 'Give it a title' : draft.title.length > TITLE_MAX ? `Shorten the title to ${TITLE_MAX} characters` : !draft.body.trim() ? 'Write the description' : null
  return (
    <section className="pp-step-body" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="gov-h2">What it is and why</h2>
      <p className="pp-lede">This becomes the referendum’s description. It is published from your account once the referendum exists.</p>
      {draft.discussion && <p className="pp-meta">Started from <Link to={paths.discussion(draft.discussion.postId)} className="hash">{draft.discussion.title || `discussion ${draft.discussion.postId}`}</Link> · <button type="button" className="link-btn" onClick={() => set({ discussion: null })}>Unlink</button></p>}
      <label className="pe-field" htmlFor={`${id}-title`}>
        <span className="pe-label">Title</span>
        <input id={`${id}-title`} className="pe-input" value={draft.title} maxLength={TITLE_MAX + 20} onChange={e => set({ title: e.target.value })} placeholder="What this referendum does, in a few words" />
        <span className={`pe-count${draft.title.length > TITLE_MAX ? ' over' : ''}`}>{draft.title.length} / {TITLE_MAX}</span>
      </label>
      <MarkdownEditor value={draft.body} onChange={body => set({ body })} maxChars={BODY_MAX} label="Description" placeholder="What it does, why, and what it costs." minRows={10}
        canUpload={false} uploadBlockedReason="Images can be added from the referendum’s page once it exists." />
      {!draft.discussion && (
        <GovDetails summary="Start from a discussion">
          <FromDiscussion onPick={d => set({
            discussion: { postId: d.postId, title: d.title },
            title: draft.title || d.title,
            body: `${d.body.trim()}\n\n${discussionLine({ postId: d.postId, title: d.title })}`.trim(),
          })} />
        </GovDetails>
      )}
      <StepFoot hint={hint} next="Next: the call" onNext={onNext} />
    </section>
  )
}

/* ---- step 2: the call ---- */

const CALL_KINDS: { kind: CallDraft['kind']; label: string }[] = [
  { kind: 'spend', label: 'Treasury spend' },
  { kind: 'remark', label: 'Remark' },
  { kind: 'hex', label: 'Call data' },
  { kind: 'hash', label: 'Stored preimage' },
]

function blankCall(kind: CallDraft['kind']): CallDraft {
  switch (kind) {
    case 'spend': return { kind, amount: '', beneficiary: '', validFrom: { mode: 'now' } }
    case 'remark': return { kind, text: '' }
    case 'hex': return { kind, hex: '' }
    case 'hash': return { kind, hash: '' }
  }
}

/** "Pays exactly 1,000 HDX to 15U8…, claimable from Mon 9 Dec 2026": a spend in full, the account as the treasury pays it. */
function SpendLine({ spend }: { spend: NonNullable<BuiltCall['spend']> }) {
  const clock = useGovClock().data
  return (
    <>Pays exactly <strong className="mono">{formatHdx(BigInt(spend.amount), 12)} HDX</strong> to <span className="mono pp-break">{spend.beneficiary}</span>, {spend.validFrom == null
      ? 'claimable once the referendum is enacted'
      : <>claimable from block <span className="mono">{spend.validFrom.toLocaleString('en-US')}</span>{clock ? <> (≈ {humanDate(projectBlock(clock, spend.validFrom))})</> : null}</>}.</>
  )
}

function CallPreview({ built }: { built: BuiltCall }) {
  const summary = summarizeProposal(built.decoded)
  return (
    <div className="pp-preview" aria-label="What it does">
      <h3 className="gov-h3">What it does</h3>
      {built.spend && <p className="pp-spend"><SpendLine spend={built.spend} /></p>}
      {summary ? <div className="gov-wtd"><SummaryView line={summary} /></div> : <p className="gov-empty">{built.decoded.decodeError ?? 'It could not be summarised.'}</p>}
      <details className="gov-call-details">
        <summary>The full call, decoded{built.decoded.pallet ? ` · ${built.decoded.pallet}.${built.decoded.callName}` : ''}</summary>
        <ProposalCall call={built.decoded} hash={built.hash} />
      </details>
    </div>
  )
}

function CallStep({ draft, set, built, onNext, onBack }: {
  draft: ProposeDraft; set: (p: Partial<ProposeDraft>) => void; built: ReturnType<typeof useBuiltCall>; onNext: () => void; onBack: () => void
}) {
  const id = useId()
  const clock = useGovClock().data
  const c = draft.call
  const setCall = (patch: Partial<CallDraft>) => set({ call: { ...c, ...patch } as CallDraft })
  const result = built.data
  const error = result && 'error' in result ? result.error : built.error ? `The chain could not be reached: ${built.error instanceof Error ? built.error.message : String(built.error)}` : null
  const amount = c.kind === 'spend' ? parseHdx(c.amount) : null
  const vfBlock = c.kind === 'spend' && c.validFrom.mode === 'block' && /^\d+$/.test(c.validFrom.block) ? Number(c.validFrom.block) : null
  const blocksPerDay = clock ? 86_400_000 / clock.msPerBlock : 43_200
  // "Days from now" is turned into a block the moment it is set, so the call stays put as the head moves.
  const setDays = (days: string) => setCall({ validFrom: { mode: 'days', days, block: clock ? daysToBlock(days, clock.headBlock, blocksPerDay) : null } })
  const daysBlock = c.kind === 'spend' && c.validFrom.mode === 'days' ? c.validFrom.block : null
  const hint = built.isFetching && !result ? 'Building the call…' : error ? 'Fix the call first' : !result ? 'Building the call…' : null
  return (
    <section className="pp-step-body" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="gov-h2">The call</h2>
      <p className="pp-lede">What the chain runs if the referendum passes.</p>
      <div className="activity-chips" role="radiogroup" aria-label="Kind of call">
        {CALL_KINDS.map(k => (
          <button key={k.kind} type="button" role="radio" aria-checked={c.kind === k.kind} className={`activity-chip${c.kind === k.kind ? ' on' : ''}`} onClick={() => { if (c.kind !== k.kind) set({ call: blankCall(k.kind), track: null }) }}>{k.label}</button>
        ))}
      </div>

      {c.kind === 'spend' && (
        <div className="pp-form">
          <label className="pe-field" htmlFor={`${id}-amt`}>
            <span className="pe-label">Amount</span>
            <span className="pp-amount"><input id={`${id}-amt`} className="pe-input" inputMode="decimal" autoComplete="off" value={c.amount} onChange={e => setCall({ amount: e.target.value })} placeholder="0" /><span className="pp-unit">HDX</span></span>
            {amount != null && amount > 0n && <span className="pp-meta">{trackLabel(suggestSpendTrack(amount))} track · the treasury pays HDX only</span>}
          </label>
          <label className="pe-field" htmlFor={`${id}-ben`}>
            <span className="pe-label">Beneficiary</span>
            <input id={`${id}-ben`} className="pe-input mono" autoComplete="off" spellCheck={false} value={c.beneficiary} onChange={e => setCall({ beneficiary: e.target.value.trim() })} placeholder="Hydration address (SS58) or 0x… Ethereum address" />
          </label>
          <fieldset className="pe-field">
            <legend className="pe-label">Claimable from</legend>
            <div className="activity-chips" role="radiogroup" aria-label="Claimable from">
              {([['now', 'When enacted'], ['days', 'Days from now'], ['block', 'At a block']] as const).map(([mode, label]) => (
                <button key={mode} type="button" role="radio" aria-checked={c.validFrom.mode === mode} className={`activity-chip${c.validFrom.mode === mode ? ' on' : ''}`}
                  onClick={() => (mode === 'days' ? setDays('30') : setCall({ validFrom: mode === 'now' ? { mode } : { mode, block: clock ? String(clock.headBlock + Math.round(blocksPerDay * 30)) : '' } }))}>{label}</button>
              ))}
            </div>
            {c.validFrom.mode === 'days' && <span className="pp-inline"><input aria-label="Days from now" className="pe-input pp-narrow" inputMode="numeric" value={c.validFrom.days} onChange={e => setDays(e.target.value)} /> days from now{daysBlock != null && clock ? <span className="pp-meta">block {daysBlock.toLocaleString('en-US')} (≈ {humanDate(projectBlock(clock, daysBlock))})</span> : null}</span>}
            {c.validFrom.mode === 'block' && <span className="pp-inline"><input aria-label="Block" className="pe-input pp-narrow mono" inputMode="numeric" value={c.validFrom.block} onChange={e => setCall({ validFrom: { mode: 'block', block: e.target.value } })} />{clock && vfBlock && vfBlock > clock.headBlock ? <span className="pp-meta">≈ {humanDate(projectBlock(clock, vfBlock))}</span> : null}</span>}
            <span className="pp-meta">Anyone can claim the payout from then on, for a limited time.{c.validFrom.mode === 'now' ? ' Paid as soon as the referendum is enacted and someone claims it.' : ''}</span>
          </fieldset>
        </div>
      )}
      {c.kind === 'remark' && (
        <label className="pe-field" htmlFor={`${id}-rem`}>
          <span className="pe-label">Remark</span>
          <textarea id={`${id}-rem`} className="pe-input pp-area" rows={3} value={c.text} onChange={e => setCall({ text: e.target.value })} placeholder="A note written on chain; it changes nothing else" />
        </label>
      )}
      {c.kind === 'hex' && (
        <label className="pe-field" htmlFor={`${id}-hex`}>
          <span className="pe-label">Call data <InfoTip label="About call data">The encoded call (0x…), as other tools show it. It is decoded below against the chain’s current runtime; data that is not exactly one call is refused.</InfoTip></span>
          <textarea id={`${id}-hex`} className="pe-input pp-area mono" rows={4} spellCheck={false} value={c.hex} onChange={e => setCall({ hex: e.target.value.trim() })} placeholder="0x…" />
        </label>
      )}
      {c.kind === 'hash' && (
        <label className="pe-field" htmlFor={`${id}-hash`}>
          <span className="pe-label">Preimage hash</span>
          <input id={`${id}-hash`} className="pe-input mono" spellCheck={false} autoComplete="off" value={c.hash} onChange={e => setCall({ hash: e.target.value.trim() })} placeholder="0x… (64 hex characters)" />
          <span className="pp-meta">A call someone already stored on chain: its bytes are read from there.</span>
        </label>
      )}

      {built.isFetching && !result ? <p className="vote-review-wait"><span className="vote-spinner" aria-hidden="true" />Building the call against the chain…</p>
        : error ? <p className="vote-review-bad" role="alert">{error}</p>
          : result && 'built' in result ? <CallPreview built={result.built} /> : null}
      <StepFoot hint={hint} next="Next: the preimage" onNext={onNext} onBack={onBack} />
    </section>
  )
}

/* ---- step 3: the preimage ---- */

function PreimageStep({ built, preimage, onNext, onBack }: { built: BuiltCall; preimage: PreimageInfo; onNext: () => void; onBack: () => void }) {
  const id = useId()
  const deposit = depositToNote(built.len, preimage)
  return (
    <section className="pp-step-body" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="gov-h2">Its preimage</h2>
      <p className="pp-lede">A referendum names its call by hash; the call’s bytes are stored on chain as its preimage, so it can be read and enacted.</p>
      <dl className="pp-facts">
        <div><dt>Hash</dt><dd className="mono pp-break">{built.hash} <CopyTextButton label="Copy the hash" text={built.hash} /></dd></div>
        <div><dt>Length</dt><dd>{built.len.toLocaleString('en-US')} bytes</dd></div>
        <div><dt>On chain</dt><dd>{preimage.noted ? 'Already stored — nothing to store, no deposit' : preimage.requested ? 'Requested but not stored — it is stored with the submission, with no deposit' : 'Not stored yet — it is stored with the submission'}</dd></div>
        {deposit > 0n && (
          <div>
            <dt>Deposit</dt>
            <dd>≈ {formatHdx(deposit, 2)} HDX <InfoTip label="How the preimage deposit is set">The runtime’s storage price: 401.92 HDX plus 0.03 HDX a byte. It stays held while the preimage is stored; you get it back by removing the preimage once the referendum no longer needs it (My governance → Deposits).</InfoTip></dd>
          </div>
        )}
      </dl>
      {preimage.noted && preimage.owner && !preimage.requested && (
        <p className="pp-warn">Stored by <span className="mono pp-break">{preimage.owner}</span>, who can remove it until the referendum is approved (approval requests it, and then it stays). If it is removed first, the referendum has nothing to enact. Unless that account is yours, ask its owner to keep it, or propose a call of your own.</p>
      )}
      <StepFoot hint={null} next="Next: the track" onNext={onNext} onBack={onBack} />
    </section>
  )
}

/* ---- step 4: track and enactment ---- */

// A non-spend call's suggestion: the narrowest track whose origin the dry-run accepts, Root last.
const NARROW_FIRST = ['tipper', 'spender', 'treasurer', 'omnipool_admin', 'economic_parameters', 'general_admin', 'referendum_canceller', 'referendum_killer', 'whitelisted_caller', 'root']

/** Whether each track's origin may make the call, from the call dry-run as that origin. */
function useOriginChecks(built: BuiltCall, tracks: GovernanceTrackInfo[]) {
  const chain = useChain(true)
  return useQuery({
    queryKey: ['propose-origins', built.hash],
    enabled: !!chain.data && tracks.length > 0,
    staleTime: 60_000,
    retry: 0,
    queryFn: () => withTimeout(chain.data!.checkTrackOrigins(built.callHex, tracks.map(t => t.name)), CHAIN_TIMEOUT_MS),
  })
}

function TrackStep({ draft, set, built, tracks, onNext, onBack }: {
  draft: ProposeDraft; set: (p: Partial<ProposeDraft>) => void; built: BuiltCall; tracks: GovernanceTrackInfo[]; onNext: () => void; onBack: () => void
}) {
  const id = useId()
  const clock = useGovClock().data
  const msPerBlock = clock?.msPerBlock ?? 2000
  const checks = useOriginChecks(built, tracks)
  const res = checks.data
  const spend = draft.call.kind === 'spend' || (built.decoded.pallet === 'Treasury' && built.decoded.callName === 'spend')
  const amount = built.spend ? BigInt(built.spend.amount) : typeof built.decoded.args.amount === 'string' && /^\d+$/.test(built.decoded.args.amount) ? BigInt(built.decoded.args.amount) : null
  const passes = (n: string) => res?.[n]?.ok === true
  const suggested = spend
    ? (res ? SPEND_LIMITS.map(l => l.track).find(passes) : amount != null ? suggestSpendTrack(amount) : null) ?? 'root'
    : (res ? NARROW_FIRST.find(passes) : null) ?? 'root'
  const name = draft.track ?? suggested
  const t = tracks.find(x => x.name === name) ?? tracks.find(x => x.name === 'root') ?? tracks[0]
  const verdict = res?.[name]
  const en = draft.enactment
  const minEnact = t?.minEnactmentPeriod ?? 0
  const afterBlocks = en.mode === 'after' ? (en.blocks === '' ? minEnact : Number(en.blocks)) : null
  const atBlock = en.mode === 'at' ? Number(en.block) : null
  const enactHint = en.mode === 'after'
    ? (!Number.isInteger(afterBlocks) || afterBlocks! < minEnact ? `Enactment needs at least ${minEnact.toLocaleString('en-US')} blocks after it passes` : null)
    : (!Number.isInteger(atBlock) || !clock || atBlock! <= clock.headBlock ? 'Enter a block after the current one' : null)
  const spendTracks = SPEND_LIMITS.map(l => tracks.find(x => x.name === l.track)).filter((x): x is GovernanceTrackInfo => !!x)
  const hint = !t ? 'Loading the tracks…'
    : checks.isLoading ? 'Checking the track against the chain…'
      : checks.error ? 'The track could not be checked against the chain'
        : verdict && !verdict.ok ? 'Choose a track that may make this call'
          : enactHint
  const label = (x: GovernanceTrackInfo) => trackLabel(x.name)
  return (
    <section className="pp-step-body" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="gov-h2">Track and enactment</h2>
      <p className="pp-lede">{spend ? 'A spend goes to the smallest track whose origin may pay it; a larger track is allowed, but asks for more.' : 'The track sets who the call is dispatched as. Each track is checked by running the call as its origin.'}</p>
      {spend ? (
        <div className="pp-tracks" role="radiogroup" aria-label="Track">
          {spendTracks.map(x => {
            const limit = SPEND_LIMITS.find(l => l.track === x.name)!.max
            const can = res ? passes(x.name) : amount == null || trackCanSpend(x.name, amount) !== false
            return (
              <button key={x.name} type="button" role="radio" aria-checked={name === x.name} disabled={!can} className={`pp-track${name === x.name ? ' on' : ''}`} onClick={() => set({ track: x.name })}>
                <span className="pp-track-name">{label(x)}{x.name === suggested ? <span className="pp-tag">suggested</span> : null}</span>
                <span className="pp-meta">{limit == null ? 'any amount' : `up to ${formatHdx(limit, 0)} HDX`} · deposit {formatHdx(BigInt(x.decisionDeposit), 0)} HDX</span>
                {res && !can && <span className="pp-meta pp-cannot">Cannot make this call{res[x.name]?.code ? ` (${res[x.name]!.code})` : ''}</span>}
              </button>
            )
          })}
        </div>
      ) : (
        <label className="pe-field" htmlFor={`${id}-track`}>
          <span className="pe-label">Track</span>
          <select id={`${id}-track`} value={name} onChange={e => set({ track: e.target.value })}>
            {tracks.map(x => <option key={x.name} value={x.name} disabled={!!res && !passes(x.name)}>{label(x)}{res && !passes(x.name) ? ' — cannot make this call' : x.name === suggested ? ' — suggested' : ''}</option>)}
          </select>
        </label>
      )}
      {t && (
        checks.isLoading ? <p className="vote-review-wait"><span className="vote-spinner" aria-hidden="true" />Running the call as the {label(t)} track’s origin…</p>
          : checks.error ? <p className="vote-review-bad" role="alert">The call could not be checked against the chain ({checks.error instanceof Error ? checks.error.message : String(checks.error)}). <button type="button" className="link-btn" onClick={() => void checks.refetch()}>Try again</button></p>
            : verdict?.ok ? <p className="vote-review-ok"><span aria-hidden="true">✓</span> Checked: the {label(t)} track may make this call now. Balances and settings can still change before it is enacted.</p>
              : verdict ? <p className="vote-review-bad" role="alert"><span aria-hidden="true">✕</span> The {label(t)} track cannot make this call: {verdict.message}{verdict.code ? <span className="vote-code"> ({verdict.code})</span> : null}</p>
                : null
      )}
      {t && (
        <div className="pp-rules">
          <p className="pp-meta">{PURPOSE[t.name] ?? 'A governance track.'}{spend ? '' : ` Its decision deposit is ${formatHdx(BigInt(t.decisionDeposit), 0)} HDX.`}</p>
          <TrackFacts t={t} msPerBlock={msPerBlock} />
        </div>
      )}
      <fieldset className="pe-field">
        <legend className="pe-label">Enactment, once it passes</legend>
        <div className="activity-chips" role="radiogroup" aria-label="Enactment">
          <button type="button" role="radio" aria-checked={en.mode === 'after'} className={`activity-chip${en.mode === 'after' ? ' on' : ''}`} onClick={() => set({ enactment: { mode: 'after', blocks: String(minEnact) } })}>After a delay</button>
          <button type="button" role="radio" aria-checked={en.mode === 'at'} className={`activity-chip${en.mode === 'at' ? ' on' : ''}`} onClick={() => set({ enactment: { mode: 'at', block: clock ? String(clock.headBlock + Math.round(86_400_000 / msPerBlock * 14)) : '' } })}>At a block</button>
        </div>
        {en.mode === 'after'
          ? <span className="pp-inline"><input aria-label="Blocks after it passes" className="pe-input pp-narrow mono" inputMode="numeric" value={en.blocks === '' ? String(minEnact) : en.blocks} onChange={e => set({ enactment: { mode: 'after', blocks: e.target.value } })} /> blocks after it passes{Number.isInteger(afterBlocks) && afterBlocks! > 0 ? <span className="pp-meta">({days(afterBlocks!, msPerBlock)})</span> : null}</span>
          : <span className="pp-inline"><input aria-label="Enactment block" className="pe-input pp-narrow mono" inputMode="numeric" value={en.block} onChange={e => set({ enactment: { mode: 'at', block: e.target.value } })} />{clock && atBlock && atBlock > clock.headBlock ? <span className="pp-meta">≈ {humanDate(projectBlock(clock, atBlock))}</span> : null}</span>}
        {en.mode === 'at' && <span className="pp-meta">If it passes later than that block, it is enacted right away (no sooner than {days(minEnact, msPerBlock)} after passing).</span>}
      </fieldset>
      <StepFoot hint={hint} next="Next: review and submit" onNext={() => { if (!draft.track) set({ track: name }); onNext() }} onBack={onBack} />
    </section>
  )
}

/* ---- step 5: submit ---- */

function SubmitStep({ draft, set, built, preimage, tracks, undecidingTimeout, signing, onSigning, onBack }: {
  draft: ProposeDraft; set: (p: Partial<ProposeDraft>) => void; built: BuiltCall; preimage: PreimageInfo; tracks: GovernanceTrackInfo[]
  undecidingTimeout: number; signing: boolean; onSigning: (on: boolean) => void; onBack: () => void
}) {
  const id = useId()
  const clock = useGovClock().data
  const t = tracks.find(x => x.name === draft.track) ?? null
  const en = draft.enactment
  const enactment: { after: number } | { at: number } = en.mode === 'after' ? { after: en.blocks === '' ? t?.minEnactmentPeriod ?? 0 : Number(en.blocks) } : { at: Number(en.block) }
  const summary = summarizeProposal(built.decoded)
  // Handed to a wallet before (this tab or another), with no outcome seen since: say so
  // rather than offer a second submission of the same proposal.
  const unresolved = draft.signedAt != null && !signing
  return (
    <section className="pp-step-body" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="gov-h2">Review and submit</h2>
      <dl className="pp-facts">
        <div><dt>Title</dt><dd>{draft.title}</dd></div>
        {built.spend && <div><dt>Pays</dt><dd><SpendLine spend={built.spend} /></dd></div>}
        <div><dt>Does</dt><dd>{summary ? <SummaryView line={summary} /> : `${built.decoded.pallet}.${built.decoded.callName}`}</dd></div>
        <div><dt>Track</dt><dd>{t ? trackLabel(t.name) : '—'}</dd></div>
        <div><dt>Enactment</dt><dd>{'after' in enactment ? `${enactment.after.toLocaleString('en-US')} blocks after it passes` : `at block ${enactment.at.toLocaleString('en-US')}`}</dd></div>
        {t && <div><dt>Then</dt><dd>Place the decision deposit ({formatHdx(BigInt(t.decisionDeposit), 0)} HDX), a second signature once the referendum exists. Without it, it times out after {clock ? days(undecidingTimeout, clock.msPerBlock) : `${undecidingTimeout.toLocaleString('en-US')} blocks`} and keeps its submission deposit.</dd></div>}
      </dl>
      {unresolved ? (
        <div className="pp-warn" role="alert">
          <p>This proposal was handed to a wallet {new Date(draft.signedAt!).toLocaleString()} and its outcome was not seen here. Check the proposing account’s activity (or the referenda list) before signing again, or the same proposal is submitted twice.</p>
          <button type="button" className="gov-btn" onClick={() => set({ signedAt: null })}>It was not submitted — sign again</button>
        </div>
      ) : t ? (
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <ProposeSigner callHex={built.callHex} hash={built.hash} len={built.len} noted={preimage.noted} preimageDeposit={depositToNote(built.len, preimage)}
            track={{ id: t.id, name: t.name, decisionDeposit: t.decisionDeposit }} enactment={enactment}
            onSigning={onSigning} onSubmitted={index => set({ submitted: index, signedAt: null })} />
        </Suspense>
      ) : <p className="gov-empty">Choose a track first.</p>}
      <div className="pp-foot"><button type="button" className="gov-btn" onClick={onBack} disabled={signing}>Back</button></div>
    </section>
  )
}

/* ---- the page ---- */

export function GovernancePropose() {
  useDocumentTitle('New proposal')
  useNoindex(true)
  const [draft, set, clear] = useDraft()
  const tracks = useGovTracks()
  const step = draft.step
  const built = useBuiltCall(draft, step >= 1)
  const live = built.data && 'built' in built.data ? built.data : null
  // From the wallet request to the outcome, the call the signer was given is frozen:
  // nothing a refetch or the moving head does may rebuild it or remount the signer.
  const [signing, setSigning] = useState(false)
  const [frozen, setFrozen] = useState<{ built: BuiltCall; preimage: PreimageInfo } | null>(null)
  const result = (signing ? frozen : null) ?? live
  const onSigning = (on: boolean) => {
    setSigning(on)
    setFrozen(on ? live : null)
    set({ signedAt: on ? Date.now() : null })
  }
  // How far the reader may jump: every step up to the first one not complete.
  const reached = useMemo(() => {
    if (!draft.title.trim() || !draft.body.trim()) return 0
    if (!result) return Math.max(1, Math.min(step, 1))
    return Math.max(step, 2)
  }, [draft.title, draft.body, result, step])
  const go = (s: number) => { if (signing) return; set({ step: s }); window.scrollTo({ top: 0 }) }
  const callError = built.data && 'error' in built.data

  let body: ReactNode
  if (step === 0) body = <DescribeStep draft={draft} set={set} onNext={() => go(1)} />
  else if (step === 1 || (!result && (callError || built.error))) body = <CallStep draft={draft} set={set} built={built} onNext={() => go(2)} onBack={() => go(0)} />
  else if (!result || !tracks.data) body = <SkeletonRows rows={5} />
  else if (step === 2) body = <PreimageStep built={result.built} preimage={result.preimage} onNext={() => go(3)} onBack={() => go(1)} />
  else if (step === 3) body = <TrackStep draft={draft} set={set} built={result.built} tracks={tracks.data.tracks} onNext={() => go(4)} onBack={() => go(2)} />
  else body = <SubmitStep draft={draft} set={set} built={result.built} preimage={result.preimage} tracks={tracks.data.tracks} undecidingTimeout={tracks.data.undecidingTimeout} signing={signing} onSigning={onSigning} onBack={() => go(3)} />
  const decisionDeposit = tracks.data?.tracks.find(x => x.name === draft.track)?.decisionDeposit ?? null

  return (
    <div className="wrap gov-propose">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'New proposal' }]} />
        <h1 className="page-title">New proposal<span className="sub">describe it, build the call, submit</span></h1>
      </div>
      <Stepper step={step} reached={signing ? step : reached} onStep={go} />
      {draft.submitted != null ? (
        // Submitted: the description and the decision deposit are what is left. The draft
        // keeps the index (and the text) until the reader starts another proposal, so a
        // reload never offers to submit the same proposal twice.
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <Submitted index={draft.submitted} title={draft.title} body={draft.body} decisionDeposit={decisionDeposit} onWritten={() => undefined} />
          <p className="pp-meta pp-draft-note"><button type="button" className="link-btn" onClick={clear}>Start a new proposal</button></p>
        </Suspense>
      ) : body}
      {draft.submitted == null && !signing && (draft.title || draft.body || step > 0) && (
        <p className="pp-meta pp-draft-note">The draft is kept in this browser. <button type="button" className="link-btn" onClick={clear}>Discard it</button></p>
      )}
    </div>
  )
}
