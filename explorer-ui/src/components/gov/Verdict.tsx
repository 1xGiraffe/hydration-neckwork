/* eslint-disable react-refresh/only-export-components -- the verdict model and its views */
import type { ReactNode } from 'react'
import { fmtDuration } from '../../utils/dca'
import { clockEta, type GovClock } from '../../governanceClock'
import { Amt, ExactAmt, F } from '../ui'
import { Link, paths } from '../../router'
import { useQuery } from '@tanstack/react-query'
import { useAssetFilterOptions } from '../../hooks/useExplorerData'
import { api } from '../../api/explorer'
import type { ReferendumProgress, ReferendumTimelineEntry } from '../../types'
import { humanDate, perbillPct } from './GovUi'
import type { SummaryLine, SummaryPart } from '../../utils/whatThisDoes'

// The verdict: one word and one sentence that answer "is it passing, and what
// happens next?" before any gauge or chart. Live referenda say where they are
// headed (passing, on track, falling short, waiting for a deposit) with a
// countdown; concluded ones say how they ended and when.

export type VerdictTone = 'pass' | 'track' | 'fail' | 'wait' | 'done-good' | 'done-bad' | 'quiet'

export interface Verdict {
  word: string
  tone: VerdictTone
  sentence: ReactNode
  /** The verdict as one short clause after its word ("passes in 11h 32m if both bars hold"), for a one-line status. */
  clause: string
  /** The exact moment the clause counts down to ("Mon 9 Nov, 00:24 UTC"), for its tooltip. */
  exact?: string
  /** A concluded OpenGov referendum's deposits, one line each (absent elsewhere). */
  deposits?: ReactNode
}

/** What a verdict is read from: the referendum page passes its detail, the hub its live card. */
export interface VerdictInput {
  status: string
  progress: ReferendumProgress | null
  enactment?: 'ok' | 'failed' | 'unavailable' | null
  concludedAt?: { timestamp: string } | null
  decisionDeposit?: string | null
  decimals?: number
  timeline?: ReferendumTimelineEntry[]
  /** A concluded referendum's final figures (its tally history's last point and the bars it faced then). */
  final?: FinalFigures | null
  /** The aye and nay votes counted (planck). A Democracy referendum is read by these: it has no approval or support bars. */
  tally?: { ayes: string; nays: string } | null
}

export interface FinalFigures {
  approvalPerbill: number | null
  approvalNeededPerbill: number | null
  /** Support in planck (the electorate is not read after a referendum ends, so no share). */
  support: string | null
}

function eta(block: number | null | undefined, clock: GovClock | undefined, now: number): { in: string; at: string } | null {
  const e = clockEta(clock, block, now)
  return e ? { in: fmtDuration(e.secondsUntil), at: humanDate(e.etaMs) } : null
}

/**
 * Deposits are never returned by themselves: one line per deposit, saying whether it
 * was refunded, can still be reclaimed, or was kept. Which the outcome allows is the
 * pallet's: a timed-out referendum keeps its submission deposit, a killed one loses
 * both, otherwise both are refundable.
 */
function depositLines(input: VerdictInput, killed: boolean): ReactNode {
  if (killed) return <span className="gov-deposits"><span>Its deposits were slashed.</span></span>
  if (!input.timeline) return <span className="gov-deposits"><span>Deposits are not returned automatically; whoever placed them can reclaim the ones the outcome allows.</span></span>
  const events = new Set(input.timeline.map(t => t.event))
  const timedOut = input.status === 'timed out'
  const line = (name: string, refunded: boolean, refundable: boolean) =>
    <span key={name}>{name} deposit: {refunded ? 'refunded' : refundable ? 'reclaimable by whoever placed it' : 'kept by the chain'}.</span>
  return (
    <span className="gov-deposits">
      {line('Submission', events.has('Referenda.SubmissionDepositRefunded'), !timedOut)}
      {events.has('Referenda.DecisionDepositPlaced') && line('Decision', events.has('Referenda.DecisionDepositRefunded'), true)}
    </span>
  )
}

/** "Approval 26.4% (needed 50%) · support 162M HDX." — what a concluded referendum ended on. */
function finalLine(f: FinalFigures | null | undefined, decimals: number): ReactNode {
  if (!f || f.approvalPerbill == null) return null
  return <> Approval {perbillPct(f.approvalPerbill, f.approvalNeededPerbill)}{f.approvalNeededPerbill != null ? <> (needed {perbillPct(f.approvalNeededPerbill, f.approvalPerbill)})</> : null}{f.support != null ? <> · support <Amt raw={f.support} dec={decimals} /> HDX</> : null}.</>
}

/** "approval 26.4% of 50% needed" — the clause form of finalLine. */
function finalClause(f: FinalFigures | null | undefined): string | null {
  if (!f || f.approvalPerbill == null) return null
  return f.approvalNeededPerbill != null
    ? `approval ${perbillPct(f.approvalPerbill, f.approvalNeededPerbill)} of ${perbillPct(f.approvalNeededPerbill, f.approvalPerbill)} needed`
    : `approval ${perbillPct(f.approvalPerbill)}`
}

/** "0 aye, 147M nay votes" — what a Democracy referendum's vote came to (it has no bars to compare against). */
function tallyClause(t: VerdictInput['tally'], decimals: number): string | null {
  if (!t) return null
  return `${F.amount(t.ayes, decimals)} aye, ${F.amount(t.nays, decimals)} nay votes`
}

/**
 * One verdict for a referendum — the hub's cards and the referendum page read the
 * same function, so they always agree. Countdowns sit on the governance clock.
 */
export function referendumVerdict(input: VerdictInput, clock: GovClock | undefined, now: number): Verdict {
  const p = input.progress
  if (!p) {
    const v = concludedVerdict(input)
    const fin = finalLine(input.final, input.decimals ?? 12)
    // OpenGov's concluding statuses carry deposits; Democracy's (passed, not passed, vetoed) do not.
    const deposits = /^(approved|executed|rejected|timed out|cancelled|killed)$/.test(input.status) ? depositLines(input, input.status === 'killed') : null
    return { ...v, sentence: <>{v.sentence}{fin}{deposits}</>, deposits: deposits ?? undefined }
  }
  return liveVerdict(input, p, clock, now)
}

function concludedVerdict(input: VerdictInput): Verdict {
  const s = input.status
  const date = input.concludedAt ? humanDate(input.concludedAt.timestamp, false) : null
  const when = date ? ` on ${date}` : ''
  const dec = input.decimals ?? 12
  // A Democracy referendum (passed / not passed) is decided by its vote threshold over
  // the aye and nay votes, never by approval and support: it is read by its tally.
  const democracy = s === 'passed' || s === 'not passed'
  const votes = democracy ? tallyClause(input.tally, dec) : null
  const clause = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ')
  if (/^(approved|executed|passed)$/.test(s)) {
    return {
      word: 'Approved', tone: 'done-good',
      sentence: input.enactment === 'failed' ? <>It passed{when}, but the call it enacted failed when it ran.</>
        : <>It passed{when}{input.enactment === 'ok' ? ' and its call was enacted' : ''}{votes ? <>: {votes}</> : null}.</>,
      clause: clause(date && `on ${date}`, input.enactment === 'failed' ? 'its call failed when it ran' : input.enactment === 'ok' ? 'enacted' : null, votes),
    }
  }
  if (s === 'not passed') return { word: 'Rejected', tone: 'done-bad', sentence: <>It did not pass{when}{votes ? <>: {votes}</> : null}.</>, clause: clause(date && `on ${date}`, votes) }
  if (s === 'rejected') return { word: 'Rejected', tone: 'done-bad', sentence: <>It did not reach the approval and support it needed{when}.</>, clause: clause(date && `on ${date}`, finalClause(input.final)) }
  if (s === 'timed out') return { word: 'Timed out', tone: 'done-bad', sentence: <>No decision deposit was placed in time{when}, so it never went to a decision.</>, clause: clause(date && `on ${date}`, 'no decision deposit in time') }
  if (s === 'cancelled') return { word: 'Cancelled', tone: 'done-bad', sentence: <>It was cancelled by governance{when}.</>, clause: clause(date && `on ${date}`) }
  if (s === 'killed') return { word: 'Killed', tone: 'done-bad', sentence: <>It was killed by governance{when}.</>, clause: clause(date && `on ${date}`) }
  if (s === 'vetoed') return { word: 'Vetoed', tone: 'done-bad', sentence: <>It was vetoed{when}.</>, clause: clause(date && `on ${date}`) }
  return { word: s.charAt(0).toUpperCase() + s.slice(1), tone: 'quiet', sentence: <>This referendum is {s}.</>, clause: clause(date && `on ${date}`) }
}

function liveVerdict(input: VerdictInput, p: ReferendumProgress, clock: GovClock | undefined, now: number): Verdict {
  if (p.phase === 'preparing') {
    if (!p.decisionDepositPlaced) {
      const t = eta(p.timeoutBlock, clock, now)
      return {
        word: 'Needs a decision deposit', tone: 'wait',
        sentence: <>Voting is open, but the decision period only starts once someone places the decision deposit{input.decisionDeposit ? <> of <Amt raw={input.decisionDeposit} dec={input.decimals ?? 12} /> HDX</> : null}.{t && <> Without one it times out in {t.in} ({t.at}).</>}</>,
        clause: t ? `times out in ${t.in} without one` : 'nothing can pass until one is placed', exact: t?.at,
      }
    }
    const t = eta(p.earliestDecisionBlock, clock, now)
    return {
      word: 'Preparing', tone: 'wait',
      sentence: <>Voting is open. The decision period starts {t ? <>in {t.in} ({t.at})</> : 'as soon as the track has a free slot'}; until then nothing can pass.</>,
      clause: t ? `deciding starts in ${t.in}` : 'deciding starts when the track has a free slot', exact: t?.at,
    }
  }
  if (p.phase === 'confirming') {
    const t = eta(p.confirmEndBlock, clock, now)
    return {
      word: 'Confirming', tone: 'pass',
      sentence: <>Approval and support are both above their thresholds. It passes {t ? <>in {t.in} ({t.at})</> : 'at the end of confirmation'} if they stay there.</>,
      clause: t ? `passes in ${t.in} if both bars hold` : 'passes at the end of confirmation if both bars hold', exact: t?.at,
    }
  }
  const proj = p.projection
  const a = p.approval, s = p.support
  const numbers = <>Approval {perbillPct(a?.currentPerbill, a?.thresholdPerbill)} (needs {perbillPct(a?.thresholdPerbill, a?.currentPerbill)}) · support {perbillPct(s?.currentPerbill, s?.thresholdPerbill)} (needs {perbillPct(s?.thresholdPerbill, s?.currentPerbill)}).</>
  if (proj?.state === 'passing') return { word: 'Passing', tone: 'pass', sentence: <>Above both thresholds right now; it enters confirmation next. {numbers}</>, clause: 'above both bars; confirmation starts next' }
  if (proj?.state === 'on-track') {
    const t = eta(proj.confirmableAtBlock, clock, now)
    const short = a?.passing === false ? 'approval' : 'support'
    return {
      word: 'On track to pass', tone: 'track',
      sentence: <>{numbers} Its {short} is under today’s bar, but the bar keeps falling: if nothing changes it starts confirming {t ? <>in {t.in} ({t.at})</> : 'before the decision period ends'}.</>,
      clause: t ? `can start confirming in ${t.in}` : 'can start confirming before the decision period ends', exact: t?.at,
    }
  }
  if (proj?.state === 'short') {
    const t = eta(p.decisionEndBlock, clock, now)
    const which = a?.passing === false && s?.passing === false ? 'approval and support' : a?.passing === false ? 'approval' : 'support'
    return {
      word: 'Failing', tone: 'fail',
      sentence: <>{numbers} As voted, its {which} stays under the bar until the decision period ends{t ? <> in {t.in} ({t.at})</> : ''}. It needs more aye votes{which !== 'approval' ? ' or more HDX behind them' : ''} to pass.</>,
      clause: `${which} under the bar${t ? ` · decision ends in ${t.in}` : ''}`, exact: t?.at,
    }
  }
  return { word: 'Deciding', tone: 'track', sentence: numbers, clause: `approval ${perbillPct(a?.currentPerbill, a?.thresholdPerbill)} · support ${perbillPct(s?.currentPerbill, s?.thresholdPerbill)}` }
}

/** "What this does" rendered from its summary tree. */
export function SummaryView({ line, depth = 0 }: { line: SummaryLine; depth?: number }) {
  return (
    <>
      <span className="wtd-line">{line.parts.map((part, i) => <SummaryPartView key={i} part={part} />)}</span>
      {line.children && line.children.length > 0 && (
        <ol className={`wtd-children depth-${Math.min(depth, 3)}`}>
          {line.children.map((c, i) => <li key={i}><SummaryView line={c} depth={depth + 1} /></li>)}
        </ol>
      )}
    </>
  )
}

/** An asset id named by its registry symbol (the shared token directory, already cached by most pages). */
function AssetName({ id }: { id: number }) {
  const q = useAssetFilterOptions()
  const symbol = q.data?.find(a => a.assetId === id)?.symbol
  return <Link to={paths.asset(id)} className="hash" title={`Asset ${id}`}>{symbol ?? `asset ${id}`}</Link>
}

/** An amount of a registry asset at its own decimals ("12,000 USDT"), read once per asset. */
function AssetAmount({ id, raw }: { id: number; raw: string }) {
  const q = useQuery({ queryKey: ['asset-decimals', id], queryFn: ({ signal }) => api.asset(id, signal), staleTime: Infinity })
  const a = q.data?.asset
  if (!a) return <><AssetName id={id} /> <span className="muted">(amount {raw} in its smallest unit)</span></>
  return <strong><ExactAmt raw={raw} dec={a.decimals} /> <Link to={paths.asset(id)} className="hash">{a.symbol}</Link></strong>
}

function evmArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'string') return /^0x[0-9a-fA-F]{40}$/.test(v) ? F.shortAddr(v) : v.length > 24 ? `“${v.slice(0, 22)}…”` : /^0x/.test(v) ? v : `“${v}”`
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  return '…'
}

/**
 * An EVM call named from the target's verified ABI ("addFacilitator(0x5d…, “HOLLAR
 * PSM”, 10000) on GhoToken"), else from the codec's list of functions proposals
 * commonly call; a selector on neither is "an unverified function". The codec is the
 * contract tab's lazy chunk.
 */
function EvmCall({ target, input }: { target: string; input: string }) {
  const abi = useQuery({ queryKey: ['contract-abi-optional', target.toLowerCase()], queryFn: ({ signal }) => api.contractAbiIfAny(target, signal), staleTime: 3_600_000, retry: false })
  const decoded = useQuery({
    queryKey: ['evm-decode', target.toLowerCase(), input, !!abi.data?.abi],
    queryFn: async () => {
      const codec = await import('../../abiCodec')
      return (abi.data?.abi ? codec.decodeCalldata(abi.data.abi, input) : null) ?? codec.decodeKnownCalldata(input)
    },
    enabled: abi.isFetched,
    staleTime: Infinity,
  })
  const contract = <Link to={paths.account(target)} className="hash mono" title={target}>{abi.data?.contractName || F.shortAddr(target)}</Link>
  const d = decoded.data
  if (!d) return <>the EVM contract {contract}{decoded.isFetched && <span className="muted" title={`Selector ${input.slice(0, 10)}`}> (an unverified function)</span>}</>
  return (
    <>
      <code className="wtd-code" title={d.signature}>{d.name}({d.args.map(a => evmArg(a.value)).join(', ')})</code> on {contract}
    </>
  )
}

function SummaryPartView({ part }: { part: SummaryPart }) {
  switch (part.t) {
    case 'text': return <>{part.v}</>
    case 'code': return <code className="wtd-code">{part.v}</code>
    case 'account': return <Link to={paths.account(part.v)} className="hash mono">{F.shortAddr(part.v)}</Link>
    case 'asset': return <AssetName id={part.id} />
    case 'ref': return <Link to={paths.referendum('opengov', part.index)} className="hash">referendum #{part.index}</Link>
    case 'amount': return <strong><Amt raw={part.raw} dec={part.decimals} /> {part.symbol}</strong>
    case 'assetAmount': return <AssetAmount id={part.id} raw={part.raw} />
    case 'evm': return <EvmCall target={part.target} input={part.input} />
  }
}
