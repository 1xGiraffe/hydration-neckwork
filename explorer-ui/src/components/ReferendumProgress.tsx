import type { ReactNode } from 'react'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, fmtDuration } from '../utils/dca'
import { MomentLink } from './ui'
import type { ExplorerStats, ReferendumProgress, ReferendumTimelineEntry, ReferendumTrackRef } from '../types'

// Where a running OpenGov referendum stands on its track — the Subsquare-style
// progress view: the three lifecycle phases with their clocks, and the two
// threshold gauges (approval and support against the track's decaying curves).
//
// Every future moment here is a BLOCK the runtime will act on, so it is shown
// the way the DCA page shows its next execution: estimateBlockCountdown against
// the live head, at the chain's measured pace. Durations of whole track periods
// (a 100,800-block decision period) are runtime constants derived from the
// nominal slot time, so those convert through blockSeconds' nominal fallback.

const PERBILL = 1_000_000_000

function pctText(perbill: number): string {
  const pct = perbill / (PERBILL / 100)
  const text = pct >= 99.995 ? '100' : pct.toFixed(pct >= 10 ? 1 : 2)
  return `${text}%`
}

// "Tue 26 Aug · 14:32 UTC" — F.datetime without the seconds, for moments that
// are estimates to begin with.
function fmtEta(ms: number): string {
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]} ${p(d.getUTCDate())} ${mon[d.getUTCMonth()]} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value))
}

interface Segment {
  key: string
  label: string
  state: 'done' | 'current' | 'future'
  pct: number
  note: ReactNode
}

function Countdown({ target, stats, now, prefix }: { target: number; stats: ExplorerStats; now: number; prefix: string }) {
  const eta = estimateBlockCountdown(target, stats.headBlock, stats.headTime, now, blockSeconds(stats.avgBlockSec))
  if (!eta) return <>{prefix} soon</>
  return <>{prefix} in ~{fmtDuration(eta.secondsUntil)} <span className="ref-eta-date">· {fmtEta(eta.etaMs)}</span></>
}

export function ReferendumProgressCard({ progress, track, stats, now }: {
  progress: ReferendumProgress
  track: ReferendumTrackRef
  stats: ExplorerStats
  now: number
}) {
  const head = stats.headBlock
  // Two clocks, deliberately distinct (see ExplorerStats): a track period is a
  // runtime BLOCK-COUNT constant, so its duration converts at the nominal slot
  // time — at today's ~5s measured pace the 7,200-block confirm period would
  // otherwise read 9h49m instead of the 12 hours the runtime means. Countdowns
  // to a specific future block are the opposite case and use the measured pace
  // (inside Countdown, via estimateBlockCountdown).
  const periodLabel = (blocks: number) => fmtDuration(blocks * blockSeconds(stats.nominalBlockSec))

  const segments: Segment[] = []

  // Prepare — from submission until the decision period opens. Shown only while
  // it is the current phase: once deciding, the prepare wait is history the
  // timeline already tells, and a third bar was noise. The track's
  // preparePeriod is only the MINIMUM: deciding also needs the decision deposit
  // and a free slot (maxDeciding per track), so an overdue prepare phase names
  // what it is waiting for instead of showing a stuck countdown.
  if (progress.decisionStartBlock == null) {
    const target = progress.earliestDecisionBlock ?? progress.submittedBlock
    segments.push({
      key: 'prepare', label: 'Prepare', state: 'current',
      pct: clampPct(((head - progress.submittedBlock) / Math.max(target - progress.submittedBlock, 1)) * 100),
      note: !progress.decisionDepositPlaced
        ? <>awaiting decision deposit{progress.timeoutBlock != null && <> · <Countdown target={progress.timeoutBlock} stats={stats} now={now} prefix="times out" /></>}</>
        : head < target
          ? <Countdown target={target} stats={stats} now={now} prefix="decision opens" />
          : <>waiting for a free track slot</>,
    })
  }

  // Decide — the decision-period clock keeps running while a confirmation is in
  // progress (an aborted confirm falls back into it), so this bar fills on
  // elapsed time whichever phase is current.
  if (progress.decisionStartBlock == null) {
    segments.push({ key: 'decide', label: 'Decide', state: 'future', pct: 0, note: <>{periodLabel(track.decisionPeriod)}</> })
  } else {
    const pct = clampPct(((head - progress.decisionStartBlock) / track.decisionPeriod) * 100)
    segments.push({
      key: 'decide', label: 'Decide',
      state: progress.phase === 'deciding' ? 'current' : 'done',
      pct,
      note: progress.phase === 'deciding'
        ? (progress.decisionEndBlock != null && head < progress.decisionEndBlock
          ? <Countdown target={progress.decisionEndBlock} stats={stats} now={now} prefix="ends" />
          : <>ending…</>)
        : <>in confirmation</>,
    })
  }

  // Confirm — approval and support must hold above their curves for the whole
  // confirm period; a dip aborts it back into deciding.
  if (progress.phase === 'confirming' && progress.confirmStartBlock != null && progress.confirmEndBlock != null) {
    segments.push({
      key: 'confirm', label: 'Confirm', state: 'current',
      pct: clampPct(((head - progress.confirmStartBlock) / Math.max(progress.confirmEndBlock - progress.confirmStartBlock, 1)) * 100),
      note: <Countdown target={progress.confirmEndBlock} stats={stats} now={now} prefix="confirms" />,
    })
  } else {
    segments.push({ key: 'confirm', label: 'Confirm', state: 'future', pct: 0, note: <>{periodLabel(track.confirmPeriod)}</> })
  }

  return (
    <div className="detail-card ref-progress">
      <div className="ref-phases">
        {segments.map(seg => (
          <div key={seg.key} className={`ref-phase ${seg.state}`}>
            <div className="ref-phase-head">
              <span className="ref-phase-label">{seg.label}</span>
              <span className="ref-phase-note">{seg.note}</span>
            </div>
            <div className="ref-phase-bar"><div className="ref-phase-fill" style={{ width: `${seg.pct}%` }} /></div>
          </div>
        ))}
      </div>
      {(progress.approval || progress.support) && (
        <div className="ref-gauges">
          {progress.approval && <Gauge label="Approval" hint="conviction-weighted ayes as a share of all votes" gauge={progress.approval} />}
          {progress.support && <Gauge label="Support" hint="pre-conviction capital behind the referendum, as a share of active issuance" gauge={progress.support} />}
        </div>
      )}
    </div>
  )
}

// One threshold gauge: the referendum's current share against the bar the track
// curve sets at this moment of the decision period. The tick is the threshold;
// it slides toward zero (support) or 50% (approval) as the period elapses.
function Gauge({ label, hint, gauge }: { label: string; hint: string; gauge: NonNullable<ReferendumProgress['approval']> }) {
  const current = gauge.currentPerbill
  const state = gauge.passing == null ? 'unknown' : gauge.passing ? 'pass' : 'fail'
  return (
    <div className={`ref-gauge ${state}`} title={hint}>
      <div className="ref-gauge-head">
        <span className="ref-gauge-label">{label}</span>
        <span className="ref-gauge-nums mono">
          {current != null ? <span className="ref-gauge-current">{pctText(current)}</span> : <span className="muted">not measurable</span>}
          <span className="muted"> · needs ≥ {pctText(gauge.thresholdPerbill)}</span>
        </span>
      </div>
      <div className="ref-gauge-bar">
        {current != null && <div className="ref-gauge-fill" style={{ width: `${clampPct(current / (PERBILL / 100))}%` }} />}
        <div className="ref-gauge-tick" style={{ left: `${clampPct(gauge.thresholdPerbill / (PERBILL / 100))}%` }} />
      </div>
      {gauge.source === 'attributed' && (
        <div className="ref-gauge-note">from attributed votes — delegated power not included</div>
      )}
    </div>
  )
}

// ---- timeline ----

// Product names for the lifecycle events. Anything unmapped falls back to its
// event name with the pallet prefix stripped.
const EVENT_LABELS: Record<string, string> = {
  'Referenda.Submitted': 'Submitted',
  'Referenda.DecisionDepositPlaced': 'Decision deposit placed',
  'Referenda.DecisionDepositRefunded': 'Decision deposit refunded',
  'Referenda.SubmissionDepositRefunded': 'Submission deposit refunded',
  'Referenda.DecisionStarted': 'Decision started',
  'Referenda.ConfirmStarted': 'Confirmation started',
  'Referenda.ConfirmAborted': 'Confirmation aborted',
  'Referenda.Confirmed': 'Confirmed',
  'Referenda.Approved': 'Approved',
  'Referenda.Rejected': 'Rejected',
  'Referenda.Cancelled': 'Cancelled',
  'Referenda.TimedOut': 'Timed out',
  'Referenda.Killed': 'Killed',
  'Referenda.MetadataSet': 'Metadata set',
  'Referenda.MetadataCleared': 'Metadata cleared',
  'Democracy.Started': 'Started',
  'Democracy.Passed': 'Passed',
  'Democracy.NotPassed': 'Not passed',
  'Democracy.Cancelled': 'Cancelled',
  'Democracy.Vetoed': 'Vetoed',
  'Democracy.Executed': 'Executed',
}

const GOOD_EVENTS = new Set(['Referenda.Confirmed', 'Referenda.Approved', 'Democracy.Passed', 'Democracy.Executed'])
const BAD_EVENTS = new Set(['Referenda.Rejected', 'Referenda.Cancelled', 'Referenda.TimedOut', 'Referenda.Killed', 'Referenda.ConfirmAborted', 'Democracy.NotPassed', 'Democracy.Cancelled', 'Democracy.Vetoed'])
const PHASE_EVENTS = new Set(['Referenda.Submitted', 'Referenda.DecisionStarted', 'Referenda.ConfirmStarted', 'Democracy.Started'])

// An OpenGov enactment is a Scheduler event, so its name says only that a scheduled task ran
// — the referendum's own events stop at Confirmed. What it MEANS is in the outcome, which is
// why these two read off that and not off the event name: a dispatch that errored and a call
// that was gone by enactment time are both "confirmed but never took effect".
const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Executed',
  failed: 'Execution failed',
  unavailable: 'Call unavailable',
}

function entryLabel(entry: ReferendumTimelineEntry): string {
  if (entry.outcome) return OUTCOME_LABELS[entry.outcome] ?? entry.outcome
  return EVENT_LABELS[entry.event] ?? entry.event.replace(/^[^.]+\./, '')
}

function dotClass(entry: ReferendumTimelineEntry): string {
  if (entry.outcome) return entry.outcome === 'ok' ? 'good' : 'bad'
  if (GOOD_EVENTS.has(entry.event)) return 'good'
  if (BAD_EVENTS.has(entry.event)) return 'bad'
  if (PHASE_EVENTS.has(entry.event)) return 'phase'
  return 'admin'
}

export function ReferendumTimeline({ timeline, now }: { timeline: ReferendumTimelineEntry[]; now: number }) {
  return (
    <div className="panel ref-timeline">
      {timeline.map(entry => (
        <div className="ref-tl-row" key={`${entry.blockHeight}-${entry.event}`}>
          <span className={`ref-tl-dot ${dotClass(entry)}`} />
          <span className="ref-tl-label">{entryLabel(entry)}</span>
          <span className="ref-tl-when mono">
            <MomentLink at={entry} now={now} />
            <span className="ref-tl-block muted"> · #{entry.blockHeight.toLocaleString('en-US')}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
