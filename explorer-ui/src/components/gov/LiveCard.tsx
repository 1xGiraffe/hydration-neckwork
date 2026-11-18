import type { ReactNode } from 'react'
import { clockEta, type GovClock } from '../../governanceClock'
import { Link, paths } from '../../router'
import { fmtDuration } from '../../utils/dca'
import { ayeSharePct } from '../../utils/referendumVotes'
import type { ActiveReferendumCard } from '../../types'
import { humanDate, perbillPct, trackLabel } from './GovUi'
import { referendumVerdict } from './Verdict'

// A live referendum as a card: its verdict and countdown, title, approval and
// support meters against today's bars, and its number and track (the proposer is on
// the referendum page). The governance hub lists every live one this way, with the
// reader's own state in the corner.

/** The next moment a live referendum reaches, as "passes in ~3h 57m" — read from its progress alone. */
export function CardClock({ card, clock, now }: { card: Pick<ActiveReferendumCard, 'progress'>; clock: GovClock; now: number }) {
  const progress = card.progress
  if (!progress) return null
  const projection = progress.projection
  const [target, verb] = progress.phase === 'confirming' ? [progress.confirmEndBlock, 'passes']
    : progress.phase === 'deciding'
      ? (projection?.state === 'on-track' ? [projection.confirmableAtBlock, 'can confirm']
        : projection?.state === 'passing' ? [null, 'entering confirmation'] : [progress.decisionEndBlock, 'closes'])
      : progress.decisionDepositPlaced ? [progress.earliestDecisionBlock, 'decision opens'] : [progress.timeoutBlock, 'times out']
  if (target == null) return <span className="gov-card-clock muted">{verb}</span>
  const eta = clockEta(clock, target, now)
  if (!eta) return <span className="gov-card-clock muted">{progress.phase}</span>
  return <span className="gov-card-clock" title={humanDate(eta.etaMs)}>{verb} in ~{fmtDuration(eta.secondsUntil)}</span>
}

/**
 * One measure against today's bar. Approval is green and support blue on every
 * surface (the referendum page's gauges, these cards, the curve charts); a measure
 * under its bar turns amber while the falling bar is projected to meet it, red when
 * it is not.
 */
export function Meter({ label, current, threshold, projection }: { label: string; current: number | null; threshold: number; projection?: 'passing' | 'on-track' | 'short' | null }) {
  if (current == null) return null
  const pct = Math.min(100, current / 1e7)
  const bar = Math.min(100, threshold / 1e7)
  const ok = current >= threshold
  const state = ok ? '' : projection === 'on-track' ? ' below' : ' short'
  return (
    <div className="gov-meter" title={`${label} ${perbillPct(current, threshold)} — needs ${perbillPct(threshold, current)} right now`}>
      <span className="gov-meter-label">{label}</span>
      <span className={`gov-meter-track ${label.toLowerCase()}${state}`} aria-hidden="true"><span className="gov-meter-fill" style={{ width: `${pct}%` }} /><span className="gov-meter-bar" style={{ left: `${bar}%` }} /></span>
      <span className={`gov-meter-num${ok ? '' : ' short'}`}>{perbillPct(current, threshold)}</span>
    </div>
  )
}

/**
 * A live referendum as a card. The title is the link (stretched over the whole card),
 * so `mine`, the reader's own state in the corner ("Voted Aye 6×" or a Vote button),
 * can hold a control of its own.
 */
export function ActiveCard({ card, clock, now, mine }: { card: ActiveReferendumCard; clock: GovClock | undefined; now: number; mine?: ReactNode }) {
  const ayePct = card.tally ? ayeSharePct(card.tally.ayes, card.tally.nays) : null
  // The referendum page's own verdict, so the card and the page never disagree.
  const v = referendumVerdict({ status: card.status, progress: card.progress }, clock, now)
  const a = card.progress?.approval, s = card.progress?.support
  return (
    <div className={`gov-card verdict-${v.tone}`}>
      <div className="gov-card-head">
        <span className={`gov-card-verdict tone-${v.tone}`}>{v.word}</span>
        {clock && <CardClock card={card} clock={clock} now={now} />}
      </div>
      <Link to={paths.referendum('opengov', card.index)} className="gov-card-title gov-card-link">{card.title ?? `Referendum #${card.index}`}</Link>
      {a || s ? (
        <div className="gov-card-meters">
          {a && <Meter label="Approval" current={a.currentPerbill} threshold={a.thresholdPerbill} projection={card.progress?.projection?.state} />}
          {s && <Meter label="Support" current={s.currentPerbill} threshold={s.thresholdPerbill} projection={card.progress?.projection?.state} />}
        </div>
      ) : ayePct != null && (
        <span className="gov-card-tally"><span className="gov-tallybar" aria-hidden="true"><span style={{ width: `${ayePct}%` }} /></span><span className="mono muted">{ayePct.toFixed(1)}% aye</span></span>
      )}
      <div className="gov-card-foot">
        <span className="gov-card-where">#{card.index}{card.track ? ` · ${trackLabel(card.track.name)}` : ''}</span>
        {mine && <span className="gov-card-mine">{mine}</span>}
      </div>
    </div>
  )
}
