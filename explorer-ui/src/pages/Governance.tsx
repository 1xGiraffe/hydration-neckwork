import { useMemo } from 'react'
import { useGovernanceMotions, useGovernanceOverview, useGovernanceReferenda, useGovernanceTips, useSecurityDashboard, useStats } from '../hooks/useExplorerData'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, setQuery, useQuery, useQueryValue } from '../router'
import { AddrPill, Crumbs, Dash, DetailTabs, EmptyRow, F, MomentLink, Pager, pendingRows, rowNav, TableSkeleton } from '../components/ui'
import { NotifyButton } from '../components/NotifyButton'
import { estimateBlockCountdown } from '../utils/blockCountdown'
import { blockSeconds, fmtDuration } from '../utils/dca'
import { ayeSharePct } from '../utils/referendumVotes'
import type { ActiveReferendumCard, CollectiveMotionRow, ExplorerStats, GovernanceReferendumRow, TreasuryTipRow } from '../types'

// /governance — every way this chain decides, on one page. The live OpenGov
// referenda lead (they are what a visitor can still act on), the full OpenGov
// and Democracy directories sit behind exact-counted tabs, and the committee
// motions and pre-OpenGov archive stay one tab away rather than a menu tree
// deep: Hydration's governance history is small enough to be one page, so the
// page is the information architecture.

const PAGE = 25

// Track names come from the runtime snake_cased; the page prints them as words.
const trackLabel = (name: string) => name.replace(/_/g, ' ')

// One status vocabulary → one visual language, shared by referenda, motions and
// tips: green settled-yes, a second green for confirming (almost settled-yes),
// red settled-no, neutral for anything still open, grey for the rest. Nothing
// in flight is red — red is reserved for outcomes and for a tally that cannot
// pass (the caller says so via `failing`).
function statusTone(status: string): 'good' | 'almost' | 'bad' | 'neutral' | 'quiet' {
  if (/^(approved|executed|passed|closed)$/.test(status)) return 'good'
  if (status === 'confirming') return 'almost'
  if (/^(rejected|not passed|disapproved|failed|killed|vetoed|timed out|cancelled|retracted)$/.test(status)) return 'bad'
  if (/^(deciding|open|closing|submitted|started)$/.test(status)) return 'neutral'
  return 'quiet'
}
function StatusBadge({ status, failing }: { status: string; failing?: boolean }) {
  // A deciding referendum whose tally can never clear the decaying bars is the
  // one in-flight state worth a red word: it says where things are HEADED.
  if (failing) return <span className="badge gov-status bad" title={`Still ${status}, but as voted today it cannot pass`}>not passing</span>
  return <span className={`badge gov-status ${statusTone(status)}`}>{status}</span>
}

/* ---- the live cards ---- */

// Where the referendum is on its clock, in one line: the phase and the moment
// it resolves, at the chain's measured pace.
// The clock says what happens NEXT, in OpenGov's own logic: a confirming
// referendum confirms; a deciding one that trails the (decaying) bars names the
// moment those bars meet today's tally — trailing them is the healthy normal,
// not a warning; only a tally the bars can never meet is called out (in the
// card foot, not here).
function CardClock({ card, stats, now }: { card: ActiveReferendumCard; stats: ExplorerStats; now: number }) {
  const progress = card.progress
  if (!progress) return null
  const projection = progress.projection
  const [target, verb] = progress.phase === 'confirming' ? [progress.confirmEndBlock, 'confirms']
    : progress.phase === 'deciding'
      ? (projection?.state === 'on-track' ? [projection.confirmableAtBlock, 'can confirm']
        : projection?.state === 'passing' ? [null, 'entering confirmation'] : [progress.decisionEndBlock, 'decision ends'])
      : [progress.earliestDecisionBlock, 'decision opens']
  if (target == null) return <span className="gov-card-clock muted">{verb !== 'decision opens' ? verb : progress.phase}</span>
  const eta = estimateBlockCountdown(target, stats.headBlock, stats.headTime, now, blockSeconds(stats.avgBlockSec))
  if (!eta) return <span className="gov-card-clock muted">{progress.phase}</span>
  return <span className="gov-card-clock">{verb} in ~{fmtDuration(eta.secondsUntil)}</span>
}

// Calm by default: a card is an index, a title, and a clock. The one colored
// element is the exception — a referendum that would FAIL as things stand says
// so; a passing one needs no decoration. (The status badge went too: the
// clock's verb — "confirms in", "decision ends in" — already names the phase.)
function ActiveCard({ card, stats, now }: { card: ActiveReferendumCard; stats: ExplorerStats | undefined; now: number }) {
  const ayePct = card.tally ? ayeSharePct(card.tally.ayes, card.tally.nays) : null
  // Only a tally the decaying bars can never meet is a warning; a referendum
  // merely trailing them is on its normal path and stays undecorated.
  const short = card.progress?.projection?.state === 'short'
  const approval = card.progress?.approval
  const support = card.progress?.support
  const shortDetail = [
    approval?.passing === false ? `approval ${(approval.currentPerbill! / 1e7).toFixed(1)}% — the bar never falls below ${(approval.thresholdPerbill / 1e7).toFixed(1)}% enough` : null,
    support?.passing === false ? `support ${(support.currentPerbill! / 1e7).toFixed(2)}%` : null,
  ].filter(Boolean).join(' · ')
  return (
    <Link to={paths.referendum('opengov', card.index)} className="gov-card">
      <div className="gov-card-head">
        <span className="mono muted">#{card.index}{card.track ? ` · ${trackLabel(card.track.name)}` : ''}</span>
        {stats && <CardClock card={card} stats={stats} now={now} />}
      </div>
      <div className="gov-card-title">{card.title ?? `Referendum #${card.index}`}</div>
      <div className="gov-card-foot">
        {ayePct != null && (
          <span className="gov-card-tally" title={card.tally!.source === 'live' ? 'The pallet’s live tally' : 'The decision-start snapshot — votes since are not in it'}>
            <span className="gov-tallybar" aria-hidden="true"><span style={{ width: `${ayePct}%` }} /></span>
            <span className="mono muted">{ayePct.toFixed(1)}% aye</span>
          </span>
        )}
        {short && <span className="badge gov-status bad" title={`As voted today this cannot pass: ${shortDetail}`}>not passing</span>}
        {card.proposer && <span className="gov-card-proposer"><AddrPill account={card.proposer} noCopy /></span>}
      </div>
    </Link>
  )
}

/* ---- referenda table ---- */

function ReferendaTable({ pallet, page, onPage, shortIndexes }: { pallet: 'opengov' | 'democracy'; page: number; onPage: (p: number) => void; shortIndexes?: Set<number> }) {
  const now = useNow()
  const status = useQueryValue('status', '')
  const track = useQueryValue('track', '')
  const trackNum = /^\d+$/.test(track) ? Number(track) : undefined
  const { data, isFetching, isPlaceholderData } = useGovernanceReferenda(pallet, status || undefined, trackNum, page * PAGE)
  const rows = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  // The filter options come from the rows the directory actually contains —
  // an unfiltered first page fetch would be needed for exact option lists, but
  // the status vocabulary is small and fixed per pallet, so it is inlined.
  const statusOptions = pallet === 'opengov'
    ? ['submitted', 'deciding', 'confirming', 'approved', 'rejected', 'cancelled', 'timed out', 'killed']
    : ['started', 'passed', 'not passed', 'executed', 'cancelled', 'vetoed']
  const trackOptions = ['root', 'whitelisted_caller', 'referendum_canceller', 'referendum_killer', 'general_admin', 'treasurer', 'spender', 'tipper', 'omnipool_admin', 'economic_parameters']
  return (
    <>
      <div className="filters gov-filters">
        <select aria-label="Status" value={status} onChange={e => setQuery({ status: e.target.value || null, page: null })}>
          <option value="">Any status</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {pallet === 'opengov' && (
          <select aria-label="Track" value={track} onChange={e => setQuery({ track: e.target.value || null, page: null })}>
            <option value="">Any track</option>
            {trackOptions.map((name, id) => <option key={name} value={String(id)}>{trackLabel(name)}</option>)}
          </select>
        )}
      </div>
      <div className="panel"><table className="tbl">
        <thead><tr><th style={{ width: 70 }}>#</th><th>Title</th>{pallet === 'opengov' && <><th>Track</th><th>Proposer</th></>}<th>Status</th><th className="r">Last activity</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isFetching && !rows.length ? <TableSkeleton cols={pallet === 'opengov' ? 6 : 4} rows={10} />
            : !rows.length ? <EmptyRow cols={pallet === 'opengov' ? 6 : 4}>No referenda match</EmptyRow>
              : rows.map(r => <RefRow key={`${r.pallet}:${r.index}`} r={r} now={now} showTrack={pallet === 'opengov'} failing={shortIndexes?.has(r.index) && r.status === 'deciding'} />)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={onPage} />
    </>
  )
}

function RefRow({ r, now, showTrack, failing }: { r: GovernanceReferendumRow; now: number; showTrack: boolean; failing?: boolean }) {
  return (
    <tr {...rowNav(paths.referendum(r.pallet, r.index))}>
      <td data-label="#" className="mono"><Link to={paths.referendum(r.pallet, r.index)} className="hash">#{r.index}</Link></td>
      <td data-label="Title" className="gov-title-cell">{r.title ?? <span className="muted">—</span>}</td>
      {showTrack && <td data-label="Track" className="muted">{r.track ? trackLabel(r.track.name) : <Dash />}</td>}
      {showTrack && <td data-label="Proposer">{r.proposer ? <AddrPill account={r.proposer} noCopy /> : <Dash />}</td>}
      <td data-label="Status"><StatusBadge status={r.status} failing={failing} /></td>
      <td data-label="Last activity" className="r mono"><MomentLink at={{ blockHeight: r.blockHeight, extrinsicIndex: null, timestamp: r.timestamp }} now={now} /></td>
    </tr>
  )
}

/* ---- collective motions ---- */

function MotionsTable({ body, page, onPage }: { body: 'tc' | 'council'; page: number; onPage: (p: number) => void }) {
  const now = useNow()
  const { data, isFetching, isPlaceholderData } = useGovernanceMotions(body, page * PAGE)
  const rows = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  return (
    <>
      <div className="panel"><table className="tbl">
        <thead><tr><th style={{ width: 60 }}>#</th><th>Proposes</th><th>Proposer</th><th className="r">Votes</th><th>Status</th><th className="r">When</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isFetching && !rows.length ? <TableSkeleton cols={6} rows={10} />
            : !rows.length ? <EmptyRow cols={6}>No motions</EmptyRow>
              : rows.map(m => <MotionRow key={`${m.proposedAt.blockHeight}-${m.index}`} m={m} now={now} />)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={onPage} />
    </>
  )
}

function MotionRow({ m, now }: { m: CollectiveMotionRow; now: number }) {
  // The row IS its propose extrinsic — that page renders the full decoded call
  // tree, so a motion needs no detail page of its own.
  const to = m.proposedAt.extrinsicIndex != null ? paths.extrinsic(`${m.proposedAt.blockHeight}-${m.proposedAt.extrinsicIndex}`) : null
  return (
    <tr {...(to ? rowNav(to) : {})}>
      <td data-label="#" className="mono muted">{m.index >= 0 ? m.index : '—'}</td>
      <td data-label="Proposes" className="gov-title-cell">
        {m.call ? <span className="mono gov-call">{m.call}</span> : <span className="mono muted">{m.hash.slice(0, 10)}…{m.hash.slice(-6)}</span>}
      </td>
      <td data-label="Proposer">{m.proposer ? <AddrPill account={m.proposer} noCopy /> : <Dash />}</td>
      <td data-label="Votes" className="r mono">{m.ayes}<span className="muted">/{m.threshold}</span>{m.nays > 0 && <span className="vb-nay-text"> · {m.nays} nay</span>}</td>
      <td data-label="Status"><StatusBadge status={m.status} /></td>
      <td data-label="When" className="r mono"><MomentLink at={m.closedAt ?? m.proposedAt} now={now} /></td>
    </tr>
  )
}

/* ---- treasury tips ---- */

function TipsTable() {
  const now = useNow()
  const query = useQuery()
  // Tips page independently of the council table above them; two pagers on one
  // tab must not fight over one ?page.
  const requested = Number.parseInt(query.get('tpage') ?? '', 10)
  const page = Number.isFinite(requested) && requested > 0 ? requested : 0
  const onPage = (next: number) => setQuery({ tpage: next > 0 ? String(next) : null })
  const { data, isFetching, isPlaceholderData } = useGovernanceTips(page * PAGE)
  const rows = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  return (
    <>
      <div className="panel"><table className="tbl">
        <thead><tr><th>Reason</th><th>Beneficiary</th><th className="r">Paid out</th><th>Status</th><th className="r">When</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isFetching && !rows.length ? <TableSkeleton cols={5} rows={10} />
            : !rows.length ? <EmptyRow cols={5}>No tips</EmptyRow>
              : rows.map(t => <TipRow key={t.hash} t={t} now={now} />)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={onPage} />
    </>
  )
}

function TipRow({ t, now }: { t: TreasuryTipRow; now: number }) {
  // Tip reasons are URLs by convention (a forum/subsquare post); a reason that
  // is one opens in a new tab, anything else renders as the text it is.
  const isUrl = t.reason != null && /^https?:\/\/\S+$/.test(t.reason)
  return (
    <tr>
      <td data-label="Reason" className="gov-title-cell">
        {t.reason == null ? <Dash />
          : isUrl ? <a href={t.reason} target="_blank" rel="noopener" className="hash">{t.reason.replace(/^https?:\/\//, '')}</a>
            : t.reason}
      </td>
      <td data-label="Beneficiary">{t.beneficiary ? <AddrPill account={t.beneficiary} noCopy /> : <Dash />}</td>
      <td data-label="Paid out" className="r mono">{t.payout ? `${F.amount(t.payout, 12)} HDX` : <Dash />}</td>
      <td data-label="Status"><StatusBadge status={t.status} /></td>
      <td data-label="When" className="r mono"><MomentLink at={t.closedAt ?? t.openedAt} now={now} /></td>
    </tr>
  )
}

/* ---- the committee roster (the /security/guardians view, in brief) ---- */

// Who the committee IS, right above what it has done — the same roster and
// thresholds the security page's Guardians section shows, linking there for the
// full control matrix (which lever needs which majority).
function TcMembersCard() {
  const { data } = useSecurityDashboard()
  const tc = data?.guardians.techCommittee
  if (!tc) return null
  return (
    <div className="pf-card gov-tc-card">
      <div className="sec-meter-head">
        <span className="sec-sub" style={{ margin: 0 }}>Members</span>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {tc.size > 0 ? `${tc.majority} of ${tc.size} to act · ${tc.superMajority} of ${tc.size} for XCM channels` : 'membership unavailable'}
        </span>
      </div>
      {tc.members.length > 0 && <div className="sec-pills">{tc.members.map(m => <AddrPill key={m.accountId} account={m} />)}</div>}
      <div className="hdx-note" style={{ marginTop: 10 }}>
        A simple majority takes effect the moment a motion closes — no referendum, no waiting period.{' '}
        <Link to={paths.security('guardians')} className="hash">Which lever needs which majority →</Link>
      </div>
    </div>
  )
}

// Council motions page independently inside the archive tab — three tables on
// one tab must not fight over one ?page.
function CouncilMotions() {
  const query = useQuery()
  const requested = Number.parseInt(query.get('cpage') ?? '', 10)
  const page = Number.isFinite(requested) && requested > 0 ? requested : 0
  return <MotionsTable body="council" page={page} onPage={next => setQuery({ cpage: next > 0 ? String(next) : null })} />
}

/* ---- the page ---- */

export function Governance() {
  useDocumentTitle('Governance')
  const now = useNow()
  const overview = useGovernanceOverview()
  const { data: stats } = useStats(Boolean(overview.data?.active.length))
  const view = useQueryValue('view', 'opengov')
  const query = useQuery()
  const requestedPage = Number.parseInt(query.get('page') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const setPage = (next: number) => setQuery({ page: next > 0 ? String(next) : null })

  const counts = overview.data?.counts
  const tabs = useMemo(() => [
    { key: 'opengov', label: 'OpenGov', ...(counts ? { count: counts.opengov } : {}) },
    { key: 'tc', label: 'Tech Committee', ...(counts ? { count: counts.tcMotions } : {}) },
    { key: 'archive', label: 'Archive' },
  ], [counts])
  // Democracy folded into the archive; an old ?view=democracy link lands there.
  const activeView = view === 'democracy' ? 'archive' : tabs.some(t => t.key === view) ? view : 'opengov'

  // The deciding referenda whose tallies cannot pass as voted — the table's
  // status column says "not passing" for exactly these.
  const shortIndexes = useMemo(() => new Set(
    (overview.data?.active ?? []).filter(c => c.progress?.projection?.state === 'short').map(c => c.index),
  ), [overview.data])

  // Resolution order: what settles soonest leads — a confirming referendum is
  // hours from its verdict, a deciding one days.
  const active = useMemo(() => {
    const rows = overview.data?.active ?? []
    const urgency = (c: ActiveReferendumCard) =>
      c.progress?.phase === 'confirming' ? (c.progress.confirmEndBlock ?? 0)
        : c.progress?.phase === 'deciding' ? 1e9 + (c.progress.decisionEndBlock ?? 0)
          : 2e9
    return [...rows].sort((a, b) => urgency(a) - urgency(b))
  }, [overview.data])

  return (
    <div className="wrap">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance' }]} />
        <div className="page-title">
          Governance
          <span className="sub">OpenGov referenda · technical committee · the pre-OpenGov archive</span>
        </div>
      </div>

      {/* The same chain-wide watches the detail pages offer, where the reader
          actually is: referenda phase alerts here, committee motions on their
          own tab below. */}
      <div className="ext-link-row">
        <NotifyButton
          variant="link"
          label="Watch referenda"
          title="Alert me when a referendum enters a new phase"
          rule={{ kind: 'referendum', params: {}, name: 'New referenda' }}
        />
      </div>

      {active.length > 0 && (
        <>
          <div className="sec-title">Deciding now
            <span style={{ color: 'var(--text-low)', textTransform: 'none', letterSpacing: 0 }}> · {active.length} open {active.length === 1 ? 'referendum' : 'referenda'}, soonest to resolve first</span>
          </div>
          <div className="gov-cards">
            {active.map(card => <ActiveCard key={card.index} card={card} stats={stats} now={now} />)}
          </div>
        </>
      )}

      <DetailTabs tabs={tabs} active={activeView} onChange={k => setQuery({ view: k === 'opengov' ? null : k, page: null, status: null, track: null })} />

      {activeView === 'opengov' && <ReferendaTable pallet="opengov" page={page} onPage={setPage} shortIndexes={shortIndexes} />}

      {activeView === 'tc' && (
        <>
          <div className="ext-link-row" style={{ marginTop: 2 }}>
            <NotifyButton
              variant="link"
              label="Watch TC motions"
              title="Alert me when the technical committee proposes or resolves a motion"
              rule={{ kind: 'tc-motion', params: {}, name: 'TC motions' }}
            />
          </div>
          <p className="gov-era-note">The technical committee fast-tracks upkeep the runtime trusts it with — registry updates, parameter changes, emergency actions. Each motion links to its propose transaction, where the full call is decoded.</p>
          <TcMembersCard />
          <MotionsTable body="tc" page={page} onPage={setPage} />
        </>
      )}
      {activeView === 'archive' && (
        <>
          <p className="gov-era-note">The pre-OpenGov era, kept readable rather than just kept: Democracy referenda (July 2022 – August 2025), Council motions and treasury tips (both until January 2025).</p>
          <div className="sec-title" style={{ marginTop: 18 }}>Democracy referenda{counts ? ` · ${F.int(counts.democracy)}` : ''}</div>
          <ReferendaTable pallet="democracy" page={page} onPage={setPage} />
          <div className="sec-title" style={{ marginTop: 22 }}>Council motions{counts ? ` · ${F.int(counts.councilMotions)}` : ''}</div>
          <CouncilMotions />
          <div className="sec-title" style={{ marginTop: 22 }}>Treasury tips{counts ? ` · ${F.int(counts.tips)}` : ''}</div>
          <TipsTable />
        </>
      )}
    </div>
  )
}
