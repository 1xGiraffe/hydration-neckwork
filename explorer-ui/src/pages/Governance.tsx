import { Suspense, useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useGovernanceMotions, useGovernanceOverview, useGovernanceReferenda, useGovernanceTips, useTechCommittee } from '../hooks/useExplorerData'
import { snapshotRetry, useDiscussions, useGovCalendar, useGovClock, waitingForSnapshot } from '../hooks/useGovernance'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths, setQuery, useQuery, useQueryValue } from '../router'
import { AddrPill, Amt, ChartSkeleton, Crumbs, Dash, DetailTabs, EmptyRow, F, MomentLink, Pager, pendingRows, rowNav, TableSkeleton } from '../components/ui'
import { NotifyButton } from '../components/NotifyButton'
import { StatusBadge, NotReady, MomentText, humanDate, trackLabel, SubscribeUrl } from '../components/gov/GovUi'
import { DeadlineList, DiscussionItem, VoteSplit } from '../components/gov/GovLists'
import { useReaderVotes } from '../components/gov/readerVotes'
import { GovTerms, InfoTip } from '../components/gov/Disclosure'
import { ActiveCard, Meter } from '../components/gov/LiveCard'
import { govApi } from '../api/explorer'
import { SUBJECT_ROUTES, forumPostPath } from '../governanceSubjects'
import type { ListedPostKind } from '../governanceTypes'
import type { ActiveReferendumCard, CollectiveMotionRow, GovernanceReferendumRow, TreasuryTipRow } from '../types'
import { lazyWithReload } from '../lazyWithReload'

// The Stats view's charts are their own chunk: the other tabs never load them.
const GovStats = lazyWithReload(() => import('../components/gov/GovStats'))

// /governance — the hub. It is ordered by what needs attention: the referenda being
// decided now (each with its verdict and the reader's own state: how they voted, or
// a Vote button), the conversation, and what closes soonest or is scheduled ahead.
// The full directories (OpenGov, the technical committee, the pre-OpenGov archive)
// sit one tab away.

const PAGE = 25

/* ---- referenda table ---- */

const DEMOCRACY_STATUSES = ['started', 'passed', 'not passed', 'executed', 'cancelled', 'vetoed']

function ReferendaTable({ pallet, page, onPage, shortIndexes, live }: { pallet: 'opengov' | 'democracy'; page: number; onPage: (p: number) => void; shortIndexes?: Set<number>; live?: Map<number, ActiveReferendumCard> }) {
  const now = useNow()
  const reader = useReaderVotes()
  const showMine = pallet === 'opengov' && reader.mine.length > 0
  // The reader's accounts' votes on a live referendum: their sides, "not yet" while one still has to vote.
  const mineOn = (i: number) => reader.voted.get(i)?.size ? [...reader.voted.get(i)!].join(', ') : reader.missing.has(i) ? 'not yet' : null
  // Only the pre-OpenGov table (the archive's Democracy referenda) filters by status.
  const status = useQueryValue('status', '')
  const { data, isFetching, isPlaceholderData } = useGovernanceReferenda(pallet, pallet === 'democracy' && status ? status : undefined, page * PAGE)
  const rows = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  const cols = 4 + (showMine ? 1 : 0)
  return (
    <>
      <div className="filters gov-filters">
        {pallet === 'democracy' ? (
          <select aria-label="Status" value={status} onChange={e => setQuery({ status: e.target.value || null, page: null })}>
            <option value="">Any status</option>
            {DEMOCRACY_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        ) : <SubscribeUrl kind="feed" label="Referenda feed" url={`${window.location.origin}/feeds/referenda.atom`} note="Follow referenda in a feed reader; an entry is re-dated on every status change." />}
      </div>
      <div className="panel"><table className="tbl gov-list-tbl">
        <thead><tr><th style={{ width: 70 }}>#</th><th>Title</th><th>Status</th>{showMine && <th title="Your accounts' votes on live referenda">Your vote</th>}<th className="r">When</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isFetching && !rows.length ? <TableSkeleton cols={cols} rows={10} />
            : !rows.length ? <EmptyRow cols={cols}>No referenda match</EmptyRow>
              : rows.map(r => <RefRow key={`${r.pallet}:${r.index}`} r={r} now={now} failing={shortIndexes?.has(r.index) && r.status === 'deciding'} live={pallet === 'opengov' ? live?.get(r.index) : undefined} mine={showMine ? mineOn(r.index) : undefined} />)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={onPage} />
    </>
  )
}

function RefRow({ r, now, failing, live, mine }: { r: GovernanceReferendumRow; now: number; failing?: boolean; live?: ActiveReferendumCard; mine?: string | null }) {
  const a = live?.progress?.approval, s = live?.progress?.support
  return (
    <tr {...rowNav(paths.referendum(r.pallet, r.index))}>
      <td data-label="#" className="mono"><Link to={paths.referendum(r.pallet, r.index)} className="hash">#{r.index}</Link></td>
      <td data-label="Title" className="gov-title-cell">
        {r.title ?? <span className="muted">—</span>}
        {(r.commentsCount ?? 0) > 0 && <span className="gov-row-talk" title={`${r.commentsCount} ${r.commentsCount === 1 ? 'comment' : 'comments'} in its discussion`}> · 💬 {r.commentsCount}</span>}
        {r.track && <div className="gov-cell-sub">{trackLabel(r.track.name)}</div>}
        {(a || s) && (
          <div className="gov-row-meters">
            {a && <Meter label="Approval" current={a.currentPerbill} threshold={a.thresholdPerbill} projection={live?.progress?.projection?.state} />}
            {s && <Meter label="Support" current={s.currentPerbill} threshold={s.thresholdPerbill} projection={live?.progress?.projection?.state} />}
          </div>
        )}
      </td>
      <td data-label="Status"><StatusBadge status={r.status} failing={failing} failedCall={r.enactment === 'failed'} /></td>
      {mine !== undefined && <td data-label="Your vote" className={mine && mine !== 'not yet' ? 'gov-row-mine' : 'muted'}>{mine ?? '—'}</td>}
      <td data-label="When" className="r mono"><MomentLink at={{ blockHeight: r.blockHeight, extrinsicIndex: null, timestamp: r.timestamp }} now={now} /></td>
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
      <div className="panel"><table className="tbl gov-list-tbl">
        <thead><tr><th style={{ width: 60 }}>#</th><th>Proposes</th><th>Proposer</th><th className="r">Votes</th><th>Status</th><th className="r">When</th></tr></thead>
        <tbody {...pendingRows(isPlaceholderData)}>
          {isFetching && !rows.length ? <TableSkeleton cols={6} rows={10} />
            : !rows.length ? <EmptyRow cols={6}>No motions</EmptyRow>
              : rows.map(m => <MotionRow key={`${m.proposedAt.blockHeight}-${m.index}`} m={m} now={now} body={body} />)}
        </tbody>
      </table></div>
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={onPage} />
    </>
  )
}

function MotionRow({ m, now, body }: { m: CollectiveMotionRow; now: number; body: 'tc' | 'council' }) {
  // A council motion's imported record is addressed by its index; the row itself
  // stays its propose extrinsic, which decodes the full call.
  const record = body === 'council' && m.index >= 0 ? `/governance/motion/council/${m.index}` : null
  const to = m.proposedAt.extrinsicIndex != null ? paths.extrinsic(`${m.proposedAt.blockHeight}-${m.proposedAt.extrinsicIndex}`) : record
  return (
    <tr {...(to ? rowNav(to) : {})}>
      <td data-label="#" className="mono muted">{record ? <Link to={record} className="hash" title="Its discussion">{m.index}</Link> : m.index >= 0 ? m.index : '—'}</td>
      <td data-label="Proposes" className="gov-title-cell">
        {m.call ? <span className="mono gov-call">{m.call}</span> : <span className="mono muted">{m.hash.slice(0, 10)}…{m.hash.slice(-6)}</span>}
      </td>
      <td data-label="Proposer">{m.proposer ? <AddrPill account={m.proposer} noCopy /> : <Dash />}</td>
      <td data-label="Votes" className="r mono">{m.ayes}<span className="muted"> of {m.threshold}</span>{m.nays > 0 && <span className="vb-nay-text"> · {m.nays} nay</span>}</td>
      <td data-label="Status"><StatusBadge status={m.status} /></td>
      <td data-label="When" className="r mono"><MomentLink at={m.closedAt ?? m.proposedAt} now={now} /></td>
    </tr>
  )
}

/* ---- treasury tips ---- */

function TipsTable() {
  const now = useNow()
  const query = useQuery()
  const requested = Number.parseInt(query.get('tpage') ?? '', 10)
  const page = Number.isFinite(requested) && requested > 0 ? requested : 0
  const onPage = (next: number) => setQuery({ tpage: next > 0 ? String(next) : null })
  const { data, isFetching, isPlaceholderData } = useGovernanceTips(page * PAGE)
  const rows = data?.rows ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  return (
    <>
      <div className="panel"><table className="tbl gov-list-tbl">
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
  const isUrl = t.reason != null && /^https?:\/\/\S+$/.test(t.reason)
  return (
    <tr>
      <td data-label="Reason" className="gov-title-cell">
        {t.reason == null ? <Dash />
          : isUrl ? <a href={t.reason} target="_blank" rel="noopener noreferrer nofollow" className="hash">{t.reason.replace(/^https?:\/\//, '')}</a>
            : t.reason}
      </td>
      <td data-label="Beneficiary">{t.beneficiary ? <AddrPill account={t.beneficiary} noCopy /> : <Dash />}</td>
      <td data-label="Paid out" className="r mono">{t.payout ? <><Amt raw={t.payout} dec={12} /> HDX</> : <Dash />}</td>
      <td data-label="Status"><StatusBadge status={t.status} /></td>
      <td data-label="When" className="r mono"><MomentLink at={t.closedAt ?? t.openedAt} now={now} /></td>
    </tr>
  )
}

function TcMembers() {
  const { data, isLoading } = useTechCommittee()
  const tc = data?.techCommittee
  // The row's room is held while it loads, so the motions below do not jump when it lands.
  if (!tc) return isLoading ? <div className="skeleton gov-tc-card-sk" aria-hidden="true" /> : null
  return (
    <div className="gov-tc-members">
      <span className="gov-tc-label">
        Members{tc.size > 0 ? <span className="muted"> · {tc.majority} of {tc.size} to act</span> : <span className="muted"> · membership unavailable</span>}
        {tc.size > 0 && (
          <InfoTip label="About the committee's majorities">
            {tc.majority} of {tc.size} members pass an ordinary motion, {tc.superMajority} of {tc.size} one that opens or closes an XCM channel. It takes effect the moment the motion closes: no referendum, no waiting period.{' '}
            <Link to={paths.security('guardians')} className="hash">Which lever needs which majority</Link>
          </InfoTip>
        )}
      </span>
      {tc.members.length > 0 && <span className="sec-pills">{tc.members.map(m => <AddrPill key={m.accountId} account={m} />)}</span>}
      <NotifyButton variant="icon" label="Alert me about technical committee motions" title="Alert me when the technical committee proposes or resolves a motion" rule={{ kind: 'tc-motion', params: {}, name: 'TC motions' }} />
    </div>
  )
}

function CouncilMotions() {
  const query = useQuery()
  const requested = Number.parseInt(query.get('cpage') ?? '', 10)
  const page = Number.isFinite(requested) && requested > 0 ? requested : 0
  return <MotionsTable body="council" page={page} onPage={next => setQuery({ cpage: next > 0 ? String(next) : null })} />
}

/* ---- the archive ---- */

// The pre-OpenGov era (and the treasury), one collection at a time: each body's
// imported records (title, description, discussion) as a list, and where the chain
// keeps a table of it (Democracy referenda, Council and TC motions, tips) that table
// one toggle away. `?kind=` picks the collection, `?show=table` the table.
const COLLECTIONS: { key: string; label: string; kind?: ListedPostKind; table?: 'democracy' | 'council' | 'tc' | 'tips' }[] = [
  { key: 'democracy', label: 'Democracy referenda', table: 'democracy' },
  { key: 'council', label: 'Council motions', kind: 'council', table: 'council' },
  { key: 'tip', label: 'Treasury tips', kind: 'tip', table: 'tips' },
  { key: 'democracy_proposal', label: 'Democracy proposals', kind: 'democracy_proposal' },
  { key: 'external', label: 'External', kind: 'external' },
  { key: 'tc', label: 'TC motions', kind: 'tc', table: 'tc' },
  { key: 'treasury_proposal', label: 'Treasury proposals', kind: 'treasury_proposal' },
  { key: 'treasury_spend', label: 'Spends', kind: 'treasury_spend' },
]

function ArchiveRecords({ kind }: { kind: ListedPostKind }) {
  const now = useNow(60_000)
  const subject = SUBJECT_ROUTES.find(s => s.kind === kind) ?? SUBJECT_ROUTES[0]
  const q = useDiscussions({ sort: 'new', kind })
  const rows = q.data?.pages.flatMap(p => p.rows) ?? []
  if (waitingForSnapshot(q)) return <NotReady what="forum" />
  // Six rows of a row's own height, so the list's arrival moves nothing a reader is looking at.
  if (q.isLoading) return <div className="gov-skeleton-list gov-archive-sk" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" />)}</div>
  if (!rows.length) return <p className="gov-empty">No {subject.plural.toLowerCase()} were imported.</p>
  return (
    <>
      <ul className={`gov-discs${q.isPlaceholderData ? ' rows-pending' : ''}`}>{rows.map(r => <DiscussionItem key={r.postId} row={r} now={now} />)}</ul>
      {q.hasNextPage && <button type="button" className="gov-more" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
    </>
  )
}

function Archive({ counts, page, onPage }: { counts?: { democracy: number; councilMotions: number; tips: number; tcMotions: number }; page: number; onPage: (p: number) => void }) {
  const requested = useQueryValue('kind', 'democracy')
  const show = useQueryValue('show', '')
  const coll = COLLECTIONS.find(c => c.key === requested) ?? COLLECTIONS[0]
  // Each collection's size for its chip: the imported records' total (the chain table's count for Democracy referenda).
  const totals = useQueries({
    queries: COLLECTIONS.filter(c => c.kind).map(c => ({
      queryKey: ['forum-kind-total', c.kind],
      queryFn: ({ signal }: { signal: AbortSignal }) => govApi.discussions({ sort: 'new', kind: c.kind, limit: 1 }, signal),
      staleTime: 300_000,
      ...snapshotRetry,
    })),
  })
  const countOf = (key: string): number | undefined => {
    if (key === 'democracy') return counts?.democracy
    const i = COLLECTIONS.filter(c => c.kind).findIndex(c => c.key === key)
    return totals[i]?.data?.total
  }
  const asTable = coll.table != null && (!coll.kind || show === 'table')
  return (
    <>
      <div className="activity-chips gov-archive-chips" role="group" aria-label="Collection">
        {COLLECTIONS.map(c => {
          const n = countOf(c.key)
          return (
            <button key={c.key} type="button" aria-pressed={c.key === coll.key} className={`activity-chip${c.key === coll.key ? ' on' : ''}`}
              onClick={() => setQuery({ kind: c.key === 'democracy' ? null : c.key, show: null, page: null, cpage: null, tpage: null, status: null })}>
              {c.label}{n != null && <span className="gov-chip-n">{F.int(n)}</span>}
            </button>
          )
        })}
      </div>
      {coll.kind && coll.table && (
        <div className="gov-view-toggle" role="group" aria-label="View">
          <button type="button" aria-pressed={!asTable} className={!asTable ? 'on' : ''} onClick={() => setQuery({ show: null, page: null })}>List</button>
          <button type="button" aria-pressed={asTable} className={asTable ? 'on' : ''} onClick={() => setQuery({ show: 'table', page: null })}>Table</button>
        </div>
      )}
      {!asTable ? <ArchiveRecords kind={coll.kind!} />
        : coll.table === 'democracy' ? <ReferendaTable pallet="democracy" page={page} onPage={onPage} />
          : coll.table === 'council' ? <CouncilMotions />
            : coll.table === 'tc' ? <MotionsTable body="tc" page={page} onPage={onPage} />
              : <TipsTable />}
    </>
  )
}

/* ---- the overview ---- */

/** The scheduled dates ahead other than the referendum deadlines; null when there are none (the column is then hidden). */
function useComingUp(now: number) {
  const from = new Date(now - 86_400_000).toISOString().slice(0, 10)
  const to = new Date(now + 21 * 86_400_000).toISOString().slice(0, 10)
  const q = useGovCalendar(from, to)
  // The referendum deadlines are the cards' countdowns (or "closing soon"); this is the rest of what is scheduled.
  const upcoming = (q.data?.events ?? []).filter(e => !['concluded', 'decision-end', 'confirm-end', 'timeout'].includes(e.kind) && Date.parse(e.at.ts) >= now - 3_600_000).slice(0, 6)
  return { loading: q.isLoading, upcoming }
}

const CAL_WORD: Record<string, string> = {
  'decision-end': 'decision ends', 'confirm-end': 'confirmation ends', timeout: 'times out', 'prepare-end': 'decision can start',
  enactment: 'enacts', 'spend-valid': 'spend claimable', 'spend-expire': 'spend expires',
}

function ComingUp({ events, now }: { events: ReturnType<typeof useComingUp>['upcoming']; now: number }) {
  return (
    <ul className="gov-cal-strip">
      {events.map((e, i) => (
        <li key={i}>
          <span className="gov-cal-date">{humanDate(e.at.ts, false).replace(/ \d{4}$/, '')}</span>
          <span className="gov-cal-what">
            {e.referendum ? <Link to={paths.referendum('opengov', e.referendum.index)} className="hash">#{e.referendum.index}</Link> : e.spend ? <Link to={forumPostPath(`spend:${e.spend.index}`) ?? paths.governance()} className="hash">Spend #{e.spend.index}{/^\d+$/.test(e.spend.amount) ? <> · <Amt raw={e.spend.amount} dec={12} /> HDX</> : null}</Link> : null}
            {' '}{CAL_WORD[e.kind] ?? e.kind} <MomentText at={e.at} now={now} relative />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** "#450 and #448" */
const refList = (ids: number[]) => ids.length === 1 ? `#${ids[0]}` : `${ids.slice(0, -1).map(i => `#${i}`).join(', ')} and #${ids[ids.length - 1]}`

function Overview() {
  const now = useNow()
  const overview = useGovernanceOverview()
  const clock = useGovClock().data
  const reader = useReaderVotes()
  const coming = useComingUp(now)
  const active = useMemo(() => {
    const rows = overview.data?.active ?? []
    const urgency = (c: ActiveReferendumCard) =>
      c.progress?.phase === 'confirming' ? (c.progress.confirmEndBlock ?? 0)
        : c.progress?.phase === 'deciding' ? 1e9 + (c.progress.decisionEndBlock ?? 0)
          : 2e9
    return [...rows].sort((a, b) => urgency(a) - urgency(b))
  }, [overview.data])
  const discussions = overview.data?.discussions
  // The reader's state on each card: the Vote button while any of their accounts has
  // not voted, else how they voted.
  const mineOn = (c: ActiveReferendumCard) => {
    if (!reader.known.length) return undefined
    if (reader.missing.has(c.index)) return <VoteSplit index={c.index} title={c.title ?? null} track={c.track?.id ?? null} />
    const sides = reader.voted.get(c.index)
    return sides?.size ? <span className="gov-card-voted">Voted {[...sides].join(', ')}</span> : undefined
  }
  // With several accounts a card's Vote button can hide that only some of them voted: said once under the cards.
  const partial = reader.known.length > 1 ? active.filter(c => reader.missing.has(c.index)).map(c => c.index) : []
  const whose = reader.watchOnly ? 'the accounts you follow' : `your ${reader.known.length} accounts`
  const sideColumn = active.length > 3 || coming.loading || coming.upcoming.length > 0
  return (
    <>
      <section className="gov-hub-live" aria-labelledby="hub-live">
        <div className="gov-hub-head">
          <h2 id="hub-live" className="gov-h2">Being decided now{active.length > 0 && <span className="gov-count" aria-label={`${active.length} live`}>{active.length}</span>}</h2>
          <span className="gov-hub-head-actions">
            <Link to={paths.governancePropose()} className="gov-btn">New proposal</Link>
            <NotifyButton variant="icon" label="Alert me about new referenda" title="Alert me about new referenda" rule={{ kind: 'referendum', params: {}, name: 'New referenda' }} />
          </span>
        </div>
        {overview.isLoading ? <div className={`gov-cards n-2`}><div className="skeleton gov-card-sk" /><div className="skeleton gov-card-sk" /></div>
          : active.length === 0 ? <p className="gov-empty">Nothing is being decided right now.</p>
            : <div className={`gov-cards n-${Math.min(active.length, 3)}`}>{active.map(card => <ActiveCard key={card.index} card={card} clock={clock} now={now} mine={mineOn(card)} />)}</div>}
        {partial.length > 0 && (
          <p className="gov-hub-partial">
            {partial.length === 1 ? `${reader.missing.get(partial[0])} of ${whose} still need to vote on ${refList(partial)}` : `Not all of ${whose} have voted on ${refList(partial)}`}
            {' · '}<Link to={paths.governanceMe()}>My governance</Link>
          </p>
        )}
      </section>

      <div className={`gov-hub-grid${sideColumn ? '' : ' gov-hub-grid-one'}`}>
        <section className="gov-hub-col" aria-labelledby="hub-discussions">
          <div className="gov-hub-card-head"><h2 id="hub-discussions" className="gov-h3">Recent discussions</h2><Link to={paths.discussions()} className="gov-more-link">All discussions</Link></div>
          {discussions === null ? <NotReady what="forum" />
            : !discussions ? <div className="gov-skeleton-list" aria-busy="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
              : !discussions.length ? <p className="gov-empty">No discussions yet.</p>
                : <ul className="gov-discs">{discussions.slice(0, 4).map(d => <DiscussionItem key={d.postId} row={d} now={now} compact />)}</ul>}
        </section>
        {sideColumn && (
          <section className="gov-hub-col" aria-labelledby="hub-ending">
            {/* With three or fewer live referenda the cards above already are the closing order. */}
            {active.length > 3 && (
              <>
                <div className="gov-hub-card-head"><h2 id="hub-ending" className="gov-h3">Closing soon</h2></div>
                {!overview.data ? <p className="gov-empty">The deadlines could not be loaded.</p>
                  : <DeadlineList rows={(overview.data.endingSoon ?? []).slice(0, 4)} now={now} empty="No referendum is open, so nothing is closing." />}
              </>
            )}
            {coming.loading ? <div className="gov-skeleton-list" aria-busy="true"><div className="skeleton" /><div className="skeleton" /></div>
              : coming.upcoming.length > 0 && (
                <>
                  <div className="gov-hub-card-head">{active.length > 3 ? <h3 className="gov-h3">Coming up</h3> : <h2 id="hub-ending" className="gov-h3">Coming up</h2>}</div>
                  <ComingUp events={coming.upcoming} now={now} />
                </>
              )}
          </section>
        )}
      </div>

      <nav className="gov-hub-foot" aria-label="More governance">
        <Link to={paths.governanceMe()}>My governance</Link>
        <Link to={paths.discussions()}>Discussions</Link>
        <Link to={paths.governancePropose()}>New proposal</Link>
        <a href="/feeds/referenda.atom">Referenda feed</a>
      </nav>
    </>
  )
}

/* ---- the page ---- */

const TABS = ['overview', 'referenda', 'committee', 'archive', 'stats'] as const

export function Governance() {
  useDocumentTitle('Governance')
  const overview = useGovernanceOverview()
  const query = useQuery()
  const requestedTab = query.get('tab') ?? query.get('view') ?? 'overview'
  // Older links: ?view=opengov (the referenda table), ?view=tc, ?view=democracy.
  const legacy: Record<string, string> = { opengov: 'referenda', tc: 'committee', democracy: 'archive' }
  const tab = (TABS as readonly string[]).includes(legacy[requestedTab] ?? requestedTab) ? (legacy[requestedTab] ?? requestedTab) : 'overview'
  const requestedPage = Number.parseInt(query.get('page') ?? '', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 0
  const setPage = (next: number) => setQuery({ page: next > 0 ? String(next) : null })

  const counts = overview.data?.counts
  const tabs = useMemo(() => [
    { key: 'overview', label: 'Overview' },
    { key: 'referenda', label: 'Referenda', ...(counts ? { count: counts.opengov } : {}) },
    { key: 'committee', label: 'Committee', title: 'The technical committee', ...(counts ? { count: counts.tcMotions } : {}) },
    { key: 'archive', label: 'Archive', title: 'Democracy, Council and treasury tips before OpenGov' },
    { key: 'stats', label: 'Stats', title: 'Turnout, active voters, HDX locked in votes and pass rates' },
  ], [counts])

  const liveByIndex = useMemo(() => new Map((overview.data?.active ?? []).map(c => [c.index, c])), [overview.data])
  const shortIndexes = useMemo(() => new Set(
    (overview.data?.active ?? []).filter(c => c.progress?.projection?.state === 'short').map(c => c.index),
  ), [overview.data])

  return (
    <div className="wrap gov-hub">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance' }]} />
        <h1 className="page-title">
          Governance
          <span className="sub">referenda, the committee and the forum</span>
        </h1>
      </div>
      {(tab === 'overview' || tab === 'referenda') && <GovTerms terms={['approval', 'support', 'confirming', 'tracks']} className="gov-head-terms" />}
      {tab === 'stats' && <GovTerms terms={['turnout', 'locks', 'tracks']} className="gov-head-terms" />}

      <DetailTabs tabs={tabs} active={tab} onChange={k => setQuery({ tab: k === 'overview' ? null : k, view: null, page: null, status: null, kind: null, show: null, cpage: null, tpage: null })} />

      {tab === 'overview' && <Overview />}

      {tab === 'referenda' && <ReferendaTable pallet="opengov" page={page} onPage={setPage} shortIndexes={shortIndexes} live={liveByIndex} />}

      {tab === 'committee' && (
        <>
          <p className="gov-era-note">Fast-tracks upkeep the runtime trusts it with. A majority acts immediately. Each motion links to its propose transaction, where the call is decoded.</p>
          <TcMembers />
          <MotionsTable body="tc" page={page} onPage={setPage} />
        </>
      )}
      {tab === 'stats' && <Suspense fallback={<ChartSkeleton h={220} />}><GovStats /></Suspense>}
      {tab === 'archive' && (
        <>
          <p className="gov-era-note">Pre-OpenGov governance, July 2022 – August 2025, read-only.</p>
          <Archive counts={counts} page={page} onPage={setPage} />
        </>
      )}
    </div>
  )
}
