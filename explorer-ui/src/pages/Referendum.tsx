import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useReferendum } from '../hooks/useExplorerData'
import { REFERENDUM_VOTES_PAGE, useForumPost, useForumThread, useGovClock, useGovConvictions, useNeedsVote, useReferendumVotes, useTallyHistory, waitingForSnapshot } from '../hooks/useGovernance'
import { ApiError } from '../api/explorer'
import { clockAsStats, clockEta, projectBlock, type GovClock } from '../governanceClock'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { lazyWithReload } from '../lazyWithReload'
import { AddrPill, Amt, ChartSkeleton, Crumbs, F, Pager, SkeletonRows, MomentLink } from '../components/ui'
import { VoteBubbles } from '../components/VoteBubbles'
import { VotesTable, type VoteTableRow } from '../components/VotesTable'
import { ProposalCall } from '../components/ProposalCall'
import { ReferendumProgressCard, ReferendumTimeline } from '../components/ReferendumProgress'
import { CommentThread } from '../components/gov/CommentThread'
import { ForumPostBody } from '../components/gov/ForumPostBody'
import { usePostPermissions } from '../forumSession'
import { PostEditor } from '../components/gov/PostEditor'
import { NotReady, convictionShort, humanDate, perbillPct, relativeTime, trackLabel } from '../components/gov/GovUi'
import { GovDetails, GovTerms } from '../components/gov/Disclosure'
import { tallyChartLegend, type TermKey } from '../components/gov/terms'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { SummaryView, referendumVerdict, type FinalFigures, type Verdict } from '../components/gov/Verdict'
import { CardClock, Meter } from '../components/gov/LiveCard'
import { fmtDuration } from '../utils/dca'
import { VoteEntry } from '../components/gov/VoteEntry'
import { DepositFacts, ReferendumDepositsLine } from '../components/gov/Deposits'
import { summarizeProposal } from '../utils/whatThisDoes'
import { useMyGovernanceAccounts } from '../governanceAccounts'
import { useRecentVotes } from '../vote/voteBus'
import { ayeSharePct, selectTally, type DisplayTally } from '../utils/referendumVotes'
import type { ReferendumDetail } from '../types'
import type { TallyHistory } from '../governanceTypes'

// The chart (SVG + its hover layer) is its own chunk: it loads with this page's
// Status section, never with the landing bundle.
const TallyChart = lazyWithReload(() => import('../components/gov/CurveChart').then(m => ({ default: m.TallyChart })))

const PALLET_LABEL: Record<string, string> = { opengov: 'OpenGov', democracy: 'Democracy' }

function TallyBar({ ayes, nays }: { ayes: string; nays: string }) {
  const ayePct = ayeSharePct(ayes, nays)
  if (ayePct == null) return <div className="empty-note">No votes counted yet</div>
  return (
    <div className="tally-bar" title={`${ayePct.toFixed(2)}% AYE`}>
      <div className="tally-aye" style={{ width: `${ayePct}%` }} />
      <div className="tally-nay" style={{ width: `${100 - ayePct}%` }} />
    </div>
  )
}

// The tally, with the bar and the AYE/NAY amounts both pallets get — and a label that
// says which figure this is. A concluded OpenGov referendum carries the chain's own
// final tally on its concluding event; a Democracy referendum carries none anywhere,
// and a RUNNING OpenGov referendum carries only the decision-start snapshot, which the
// votes since have left behind. The last two can show nothing but what their indexed
// votes add up to (see selectTally).
export function TallySummary({ tally, voters, decimals, ayeVoters, nayVoters, electorate }: { tally: DisplayTally; voters: number; decimals: number; ayeVoters?: number; nayVoters?: number; electorate?: string | null }) {
  const votesWord = voters === 1 ? 'vote' : 'votes'
  return (
    <>
      <div className="dt">{tally.source === 'chain' ? (tally.live ? 'On-chain tally · live' : 'On-chain tally') : 'Attributed votes'}</div>
      {/* dd-stack: .dd is a flex ROW, which would put the bar beside the numbers and
          collapse it to zero width (its children are percentages). */}
      <div className="dd dd-stack">
        <TallyBar ayes={tally.ayes} nays={tally.nays} />
        <div className="tally-lines">
          <div><span className="vb-aye-text">Aye</span>{ayeVoters != null && <> · {F.int(ayeVoters)} {ayeVoters === 1 ? 'voter' : 'voters'}</>} · <span className="mono"><Amt raw={tally.ayes} dec={decimals} /></span> votes</div>
          <div><span className="vb-nay-text">Nay</span>{nayVoters != null && <> · {F.int(nayVoters)} {nayVoters === 1 ? 'voter' : 'voters'}</>} · <span className="mono"><Amt raw={tally.nays} dec={decimals} /></span> votes</div>
          {tally.support && <div className="muted">Support · <span className="mono"><Amt raw={tally.support} dec={decimals} /></span> HDX{electorate ? <> of <span className="mono"><Amt raw={electorate} dec={decimals} /></span> issuance</> : null}</div>}
        </div>
        {tally.source === 'attributed' && !tally.snapshot && <div className="tally-note">
          Not the chain’s own tally: the Democracy pallet publishes its tally only in storage while a
          referendum is open, so this sums the {F.int(voters)} indexed {votesWord} —
          the chain’s direct tally, without delegated power.
        </div>}
      </div>
    </>
  )
}

/**
 * The reader's own votes on this referendum, from their signed-in, connected and
 * followed accounts: one entry per account that voted (a vote signed in this tab
 * shows at once; the indexed one replaces it as it lands).
 */
function useMyPositions(index: number, open: boolean): { side: string; conviction: string | null }[] {
  const mine = useMyGovernanceAccounts()
  const q = useNeedsVote(open ? mine.map(m => m.address).slice(0, 20) : [])
  const recent = useRecentVotes()
  const out: { side: string; conviction: string | null }[] = []
  for (const a of q.data?.accounts ?? []) {
    if (!a.accountId) continue
    const fresh = recent.filter(r => r.index === index && r.actorId.toLowerCase() === a.accountId!.toLowerCase()).pop()
    if (fresh) { out.push({ side: fresh.direction === 'aye' ? 'Aye' : fresh.direction === 'nay' ? 'Nay' : fresh.direction === 'split' ? 'Split' : 'Abstain', conviction: fresh.conviction != null ? convictionShort(null, fresh.conviction) : null }); continue }
    const v = a.voted?.find(x => x.index === index)
    if (v) out.push({ side: v.side === 'SplitAbstain' ? 'Abstain' : v.side, conviction: v.side === 'Aye' || v.side === 'Nay' ? convictionShort(null, v.conviction) : null })
  }
  return out
}

/** "2 of your accounts voted Aye (6×)." — the same count the vote composer states. */
function positionsLine(positions: { side: string; conviction: string | null }[], accounts: number): ReactNode {
  if (!positions.length) return null
  const label = (p: { side: string; conviction: string | null }) => `${p.side}${p.conviction ? ` (${p.conviction})` : ''}`
  const kinds = [...new Set(positions.map(label))]
  const who = accounts <= 1 ? 'Your account' : positions.length === 1 ? 'One of your accounts' : `${positions.length} of your accounts`
  return <>{who} voted {kinds.length === 1 ? <strong>{kinds[0]}</strong> : <>{kinds.map((k, i) => <span key={k}>{i ? ', ' : ''}<strong>{k}</strong></span>)}</>}.</>
}

/** What a concluded referendum ended on, from its tally history: the last point and the bars at its conclusion. */
function finalFigures(history: TallyHistory | undefined): FinalFigures | null {
  if (!history || history.concludedBlock == null || !Array.isArray(history.points) || !history.points.length) return null
  const last = history.points[history.points.length - 1]
  const bars = Array.isArray(history.thresholds) && history.thresholds.length ? history.thresholds[history.thresholds.length - 1] : null
  return { approvalPerbill: last.approval ?? null, approvalNeededPerbill: bars?.approval ?? null, support: history.chain?.support ?? last.support ?? null }
}

/** The moments ahead of a running referendum, at the governance clock's pace: projected, so drawn in grey. */
function upcomingMoments(data: ReferendumDetail, clock: GovClock | undefined): { label: string; block: number; ms: number }[] {
  const p = data.progress
  if (!p || !clock) return []
  const out: { label: string; block: number | null }[] = []
  if (p.phase === 'preparing') out.push(p.decisionDepositPlaced ? { label: 'Decision can start', block: p.earliestDecisionBlock } : { label: 'Times out without a decision deposit', block: p.timeoutBlock })
  if (p.phase === 'deciding' && p.projection?.state === 'on-track') out.push({ label: 'Confirmation can start', block: p.projection.confirmableAtBlock })
  if (p.phase === 'confirming') out.push({ label: 'Passes if it holds', block: p.confirmEndBlock })
  if (p.phase !== 'preparing') out.push({ label: 'Decision period ends', block: p.decisionEndBlock })
  return out.flatMap(m => (m.block != null && m.block > clock.headBlock ? [{ label: m.label, block: m.block, ms: projectBlock(clock, m.block) }] : []))
}

/**
 * The desktop status column: the verdict, the countdown, both sides with their
 * voters and votes, the two bars and the Vote button — sticky beside the page, so
 * where the referendum stands stays in view while reading. Phones keep the bottom bar.
 */
function StatusColumn({ data, verdict, tally, clock, now, open, mine, final }: {
  data: ReferendumDetail; verdict: Verdict; tally: DisplayTally; clock: GovClock | undefined; now: number; open: boolean
  mine: ReactNode; final: FinalFigures | null
}) {
  const p = data.progress
  const dec = data.asset.decimals
  const a = p?.approval, s = p?.support
  const short = p?.projection?.state
  const meet = short === 'on-track' && s && s.currentPerbill != null && s.currentPerbill < s.thresholdPerbill ? clockEta(clock, p?.projection?.confirmableAtBlock, now) : null
  const myVote = useMyPositions(data.index, open && data.pallet === 'opengov')[0] ?? null
  return (
    <aside className={`gov-ref-aside tone-${verdict.tone}`} aria-label="Status">
      <div className="gov-aside-word">{verdict.word}</div>
      {p && clock ? <div className="gov-aside-clock"><CardClock card={{ progress: p }} clock={clock} now={now} /></div>
        : data.concludedAt ? <div className="gov-aside-clock muted">{humanDate(data.concludedAt.timestamp, false)}</div> : null}
      <div className="gov-aside-sides">
        <div className="gov-aside-side aye"><span className="k">Aye <span className="muted">({F.int(data.directTally.ayeVoters)})</span></span><span className="v mono"><Amt raw={tally.ayes} dec={dec} /> <span className="muted">votes</span></span></div>
        <div className="gov-aside-side nay"><span className="k">Nay <span className="muted">({F.int(data.directTally.nayVoters)})</span></span><span className="v mono"><Amt raw={tally.nays} dec={dec} /> <span className="muted">votes</span></span></div>
      </div>
      {(a || s) ? (
        <div className="gov-aside-meters">
          {a && <Meter label="Approval" current={a.currentPerbill} threshold={a.thresholdPerbill} projection={short} />}
          {/* What support is a share of, on hover: the HDX behind it and the issuance it is measured against. */}
          {s && <div title={tally.support ? `Support ${F.amount(tally.support, dec)} HDX${data.liveTally?.electorate ? ` of ${F.amount(data.liveTally.electorate, dec)} HDX issuance` : ''}` : undefined}>
            <Meter label="Support" current={s.currentPerbill} threshold={s.thresholdPerbill} projection={short} />
          </div>}
          {meet && <p className="gov-aside-note below">Support is below today’s bar · the bar falls to meet it in ~{fmtDuration(meet.secondsUntil)}</p>}
        </div>
      ) : final && final.approvalPerbill != null ? (
        <p className="gov-aside-note">Approval {perbillPct(final.approvalPerbill, final.approvalNeededPerbill)}{final.approvalNeededPerbill != null ? <> (needed {perbillPct(final.approvalNeededPerbill, final.approvalPerbill)})</> : null}{final.support ? <> · support <Amt raw={final.support} dec={dec} /> HDX</> : null}</p>
      ) : null}
      {open && <VoteEntry pallet={data.pallet} index={data.index} open={open} current={myVote} title={data.title} track={data.track} />}
      {mine && <p className="gov-aside-mine">{mine}</p>}
    </aside>
  )
}

function SectionNav({ items }: { items: { id: string; label: string; count?: number }[] }) {
  return (
    <nav className="gov-section-nav" aria-label="On this page">
      {items.map(i => (
        <a key={i.id} href={`#${i.id}`} className="gov-section-link" onClick={i.id === 'details' ? openDetails : undefined}>{i.label}{i.count != null && i.count > 0 ? <span className="gov-section-count">{F.count(i.count)}</span> : null}</a>
      ))}
    </nav>
  )
}

function Description({ pallet, index, forum, title }: { pallet: 'opengov' | 'democracy'; index: number; forum: ReferendumDetail['forum']; title: string | null }) {
  // Read by the referendum's own post id, so it loads beside the detail rather than after it.
  const post = useForumPost(`${pallet}:${index}`)
  const perms = usePostPermissions(`${pallet}:${index}`)
  const [writing, setWriting] = useState(false)
  if (forum === null || waitingForSnapshot(post)) return <NotReady what="forum" />
  if (post.isLoading) return <div className="detail-card"><SkeletonRows rows={4} /></div>
  const p = post.data
  if (post.error instanceof ApiError && post.error.status === 404) {
    // No description yet: its proposer (or an account that speaks for it) can write the first one here.
    if (writing) return <PostEditor mode={{ kind: 'describe', postId: `${pallet}:${index}` }} onCancel={() => setWriting(false)} onDone={() => setWriting(false)} />
    return (
      <p className="gov-empty">
        The proposer has not written a description for this referendum.
        {perms.data?.edit && <> <button type="button" className="link-btn" onClick={() => setWriting(true)}>Write the description</button></>}
      </p>
    )
  }
  if (!p) return <p className="gov-empty">The description could not be loaded. <button type="button" className="link-btn" onClick={() => post.refetch()}>Try again</button></p>
  if (p.hidden) return <p className="gov-empty cmt-stub">The description is hidden by moderation.</p>
  return (
    <div className="gov-desc">
      {/* No card: the author and date are a meta line under the section's heading, the
          text's own opening heading goes when it only repeats the page title, and a long
          text fades out until it is tapped. */}
      <ForumPostBody post={p} plain clamp title={title} />
    </div>
  )
}

function Curves({ data, clock }: { data: ReferendumDetail; clock: GovClock | undefined }) {
  const live = !data.concludedAt
  const history = useTallyHistory(data.pallet, data.index, live)
  const headBlock = clock?.headBlock ?? null
  const msPerBlock = clock?.msPerBlock ?? 2000
  if (history.isLoading) return <ChartSkeleton h={208} />
  if (!history.data || !Array.isArray(history.data.points) || !Array.isArray(history.data.thresholds)) return <p className="gov-empty">The tally history could not be loaded.</p>
  if (!history.data.thresholds.length && !history.data.points.length) return <p className="gov-empty">No votes yet, and the decision period has not started — there is nothing to chart.</p>
  return (
    <Suspense fallback={<ChartSkeleton h={208} />}>
      <TallyChart history={history.data} headBlock={headBlock} headMs={clock ? Date.parse(clock.headTs) : null} msPerBlock={msPerBlock} legend={false} />
    </Suspense>
  )
}

type VoterSortKey = 'power' | 'time'

function VotesSortHead({ label, value, sort, onSort }: { label: string; value: VoterSortKey; sort: VoterSortKey; onSort: (v: VoterSortKey) => void }) {
  return (
    <button type="button" className={`th-sort${sort === value ? ' on' : ''}`} aria-pressed={sort === value} onClick={() => onSort(value)}>
      {label}{sort === value ? ' ▼' : ''}
    </button>
  )
}

/** Every voter, a page at a time from the api: by power or by time, by side, or found by address or name. */
function VotesSection({ data, now, phone }: { data: ReferendumDetail; now: number; phone: boolean }) {
  const [sort, setSort] = useState<VoterSortKey>('power')
  const [side, setSide] = useState<'all' | 'aye' | 'nay' | 'abstain'>('all')
  const convictions = useGovConvictions()
  const lockDays = convictions.data?.convictions?.map(c => c.lockDays)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => {
    if (draft.trim() === q) return
    const t = setTimeout(() => { setQ(draft.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [draft, q])
  const votes = useReferendumVotes(data.pallet, data.index, { sort, side, q, page }, !data.concludedAt)
  const rows = useMemo(() => (votes.data?.rows ?? []).map(voter => ({
    key: `${voter.blockHeight}-${voter.eventIndex}`,
    account: voter.account,
    referendum: null, referendumPallet: null, referendumTitle: null,
    side: voter.side,
    conviction: voter.conviction,
    weighted: voter.weighted,
    capital: voter.balance,
    blockHeight: voter.blockHeight,
    extrinsicIndex: voter.extrinsicIndex,
    timestamp: voter.timestamp,
    withdrawn: voter.removed,
  } satisfies VoteTableRow)), [votes.data])
  const total = votes.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / REFERENDUM_VOTES_PAGE))
  const pick = (fn: () => void) => { fn(); setPage(0) }
  return (
    <>
      <div className="gov-votes-bar">
        <div className="activity-chips" role="group" aria-label="Filter votes by side">
          {(['all', 'aye', 'nay', 'abstain'] as const).map(value => (
            <button key={value} type="button" aria-pressed={side === value} className={`activity-chip${side === value ? ' on' : ''}`} onClick={() => pick(() => setSide(value))}>
              {value === 'all' ? 'All' : value.charAt(0).toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <label className="gov-search">
          <span className="sr-only">Find a voter by address or name</span>
          <input type="search" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Find a voter: address or name" />
        </label>
        <span className="cmt-count" aria-live="polite">{votes.data ? `${F.int(total)}${total !== votes.data.totalAll ? ` of ${F.int(votes.data.totalAll)}` : ''} ${votes.data.totalAll === 1 ? 'voter' : 'voters'}` : ''}</span>
      </div>
      {votes.isError ? <p className="gov-empty">The votes could not be loaded. <button type="button" className="link-btn" onClick={() => votes.refetch()}>Try again</button></p> : (
        <VotesTable
          rows={rows}
          asset={data.asset}
          now={now}
          showAccount
          oneLine={phone}
          lockDays={lockDays}
          sortHeads={{
            votes: <VotesSortHead label="Voting power" value="power" sort={sort} onSort={v => pick(() => setSort(v))} />,
            time: <VotesSortHead label="Time" value="time" sort={sort} onSort={v => pick(() => setSort(v))} />,
          }}
        />
      )}
      {votes.data && !rows.length && <p className="gov-empty">{q ? 'No voter matches.' : 'No votes yet.'}</p>}
      <Pager page={page} totalPages={totalPages} hasNext={page + 1 < totalPages} onPage={setPage} />
    </>
  )
}

/**
 * The votes: the vote map (on phones behind "Vote map"), then every voter in the
 * paged table with its side filter, search and sorting.
 */
function VotesBlock({ data, now }: { data: ReferendumDetail; now: number }) {
  const phone = useMediaQuery('(max-width: 720px)')
  const mapNote = data.votesShown < data.votesTotal ? `The map shows the ${F.int(data.votesShown)} heaviest of ${F.int(data.votesTotal)} voters; the list below has every one.` : undefined
  const map = (
    <div className="gov-bubbles" title={mapNote}>
      <VoteBubbles voters={data.voters} decimals={data.asset.decimals} symbol={data.asset.symbol} />
    </div>
  )
  if (!data.votesTotal) return <p className="gov-empty">No votes yet.</p>
  return (
    <>
      {data.voters.length > 0 && (phone ? <GovDetails summary="Vote map" className="gov-votemap">{map}</GovDetails> : map)}
      <VotesSection data={data} now={now} phone={phone} />
    </>
  )
}

/**
 * Where it stands, in one line: the verdict word and its clause (the exact moment in
 * its tooltip). A running OpenGov referendum adds its phases; beside the status
 * column (wide screens) the two charts follow, since the column already holds the
 * meters and the Vote button; without it, the meters stand here and the charts fold
 * away. A concluded one adds its deposits and folds its charts. Democracy referenda
 * have neither phases nor charts.
 */
function StatusSection({ data, verdict, clock, now, open, mine, myPosition, lockDays }: {
  data: ReferendumDetail; verdict: Verdict; clock: GovClock | undefined; now: number; open: boolean
  mine: ReactNode; myPosition: { side: string; conviction: string | null } | null; lockDays: number[] | undefined
}) {
  const wide = useMediaQuery('(min-width: 1100px)')
  const p = data.progress
  const opengov = data.pallet === 'opengov'
  const charts = opengov ? <Curves data={data} clock={clock} /> : null
  const chartsInline = open && wide
  const terms: TermKey[] = open ? ['approval', 'support', 'confirming', 'conviction', ...(p?.phase === 'preparing' ? ['deposit' as const] : [])] : ['approval', 'support']
  const glossary = opengov ? <GovTerms terms={terms} days={lockDays} extra={[{ dt: 'The charts', dd: tallyChartLegend(open) }]} /> : null
  return (
    <section id="verdict" className={`gov-section gov-ref-status tone-${verdict.tone}`} aria-labelledby="status-h">
      <div className="gov-ref-status-head">
        <div className="gov-ref-status-text">
          <h2 id="status-h" className="gov-h2">Status</h2>
          <p className="gov-ref-status-line">
            <span className="gov-ref-status-dot" aria-hidden="true" />
            <strong className="gov-ref-status-word">{verdict.word}</strong>
            {verdict.clause && <><span aria-hidden="true"> · </span><span className={verdict.exact ? 'gov-ref-status-when' : undefined} title={verdict.exact}>{verdict.clause}</span></>}
          </p>
        </div>
        {/* Between phone and wide widths neither the status column nor the bottom bar is
            there, so the Vote button stands here. */}
        {open && !wide && <div className="gov-ref-status-vote"><VoteEntry pallet={data.pallet} index={data.index} open={open} current={myPosition} title={data.title} track={data.track} /></div>}
      </div>
      {opengov ? <ReferendumDepositsLine data={data} fallback={verdict.deposits} /> : verdict.deposits && <div className="gov-ref-status-deposits">{verdict.deposits}</div>}
      {mine && !wide && <p className="gov-ref-status-mine">{mine}</p>}
      {p && data.trackInfo && clock && (
        <ReferendumProgressCard progress={p} track={data.trackInfo} stats={clockAsStats(clock)} now={now} gauges={!wide} bare />
      )}
      {chartsInline ? <>{charts}{glossary}</> : (
        <>
          {glossary}
          {charts && <GovDetails summary={open ? 'Approval and support over time' : 'Over time'}>{charts}</GovDetails>}
        </>
      )}
    </section>
  )
}

/** Everything else about it, closed: the tally and where it comes from, deposits, dates and the proposal hash. */
function MoreDetails({ data, tally, now }: { data: ReferendumDetail; tally: DisplayTally; now: number }) {
  return (
    <GovDetails>
      <div className="dl gov-more-dl">
        <TallySummary tally={tally} voters={data.directTally.voters} decimals={data.asset.decimals} ayeVoters={data.directTally.ayeVoters} nayVoters={data.directTally.nayVoters} electorate={data.liveTally?.electorate ?? null} />
        {/* Delegated power casts no vote of its own, so it can only appear as
            the gap between the chain's tally and the votes we can attribute. */}
        {data.indirectTally && <>
          <div className="dt">Delegated / unattributed</div>
          <div className="dd mono">
            <Amt raw={data.indirectTally.ayes} dec={data.asset.decimals} /> AYE · <Amt raw={data.indirectTally.nays} dec={data.asset.decimals} /> NAY
            <span className="muted"> — in the chain tally, with no Voted event of its own</span>
          </div>
        </>}
        {data.deposits ? <DepositFacts data={data} now={now} /> : data.trackInfo && <>
          <div className="dt">Decision deposit</div>
          <div className="dd"><span className="mono"><Amt raw={data.trackInfo.decisionDeposit} dec={data.asset.decimals} /></span> HDX <span className="muted">on the {trackLabel(data.trackInfo.name)} track</span></div>
        </>}
        {data.submittedAt && <>
          <div className="dt">Submitted</div>
          <div className="dd mono"><MomentLink at={data.submittedAt} now={now} /></div>
        </>}
        {data.concludedAt && <>
          <div className="dt">Concluded</div>
          <div className="dd mono"><MomentLink at={data.concludedAt} now={now} /></div>
        </>}
        {data.proposalHash && <>
          <div className="dt">Proposal hash</div>
          <div className="dd mono gov-break">{data.proposalHash}</div>
        </>}
      </div>
    </GovDetails>
  )
}

/** "Details" (the section nav's link, or a #details link opened cold) opens the fold it points at. */
function openDetails() {
  const d = document.querySelector<HTMLDetailsElement>('#details > details')
  if (d) d.open = true
}

/** A #section deep link opened cold: bring it into view once the page has rendered it. */
function useScrollToHash(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (!id || id.startsWith('c-')) return // comment permalinks: the thread does its own
    // Sections above the target (the description, the thread) are still filling in,
    // so it is placed again once they have, unless the reader has scrolled meanwhile.
    let placedAt = -1
    if (id === 'details') openDetails()
    const place = () => { document.getElementById(id)?.scrollIntoView({ block: 'start' }); placedAt = window.scrollY }
    const first = setTimeout(place, 60)
    const second = setTimeout(() => { if (window.scrollY === placedAt) place() }, 1200)
    return () => { clearTimeout(first); clearTimeout(second) }
  }, [ready])
}

// One referendum, read top to bottom: the proposer's description, its timeline,
// where it stands (the verdict, its phases and charts), what it does, the
// discussion, every vote, and the rest folded under More details. On wide screens the status column beside it
// keeps the verdict, the meters and the vote button in view throughout, so the
// Status section does not repeat them there.
export function Referendum({ pallet, index }: { pallet: 'opengov' | 'democracy'; index: number }) {
  const { data, isLoading, isError } = useReferendum(pallet, index)
  // Started beside the detail, not after it: the post, the thread and the tally
  // history are all addressed by the referendum's own id (the api resolves a merged
  // thread), so none of them waits on the detail's answer.
  useForumPost(`${pallet}:${index}`)
  useForumThread(`${pallet}:${index}`, 'old', null)
  const clock = useGovClock().data
  const convictions = useGovConvictions()
  const now = useNow()
  const open = !!data && !data.concludedAt && !!data.progress
  const positions = useMyPositions(index, open && pallet === 'opengov')
  const myPosition = positions[0] ?? null
  const myAccounts = useMyGovernanceAccounts().length
  const mineLine = positionsLine(positions, myAccounts)
  const history = useTallyHistory(pallet, index, !data?.concludedAt, pallet === 'opengov')
  const final = data?.concludedAt ? finalFigures(history.data) : null
  const tally = data ? selectTally(data) : null
  useScrollToHash(!!data)
  const summary = useMemo(() => summarizeProposal(data?.proposalCall ?? null), [data?.proposalCall])

  const label = `${PALLET_LABEL[pallet] ?? pallet} #${index}`
  useDocumentTitle(data?.title ? `${data.title} · ${label}` : label)
  const verdict = data ? referendumVerdict({
    status: data.status, progress: data.progress, enactment: data.enactment, concludedAt: data.concludedAt,
    decisionDeposit: data.trackInfo?.decisionDeposit, decimals: data.asset.decimals, timeline: data.timeline, final,
    tally: tally ? { ayes: tally.ayes, nays: tally.nays } : null,
  }, clock, now) : null
  const lockDays = convictions.data?.convictions?.map(c => c.lockDays)
  const commentsCount = data?.forum?.commentsCount ?? 0

  return (
    <div className="wrap gov-ref">
      <div className="page-head">
        <Crumbs items={[
          { label: 'Home', to: paths.dashboard() },
          { label: 'Governance', to: paths.governance() },
          { label: label },
        ]} />
        {/* While the detail loads, the title and the line under it hold their usual room
            (two title lines on a phone), so the page does not drop when they arrive. */}
        <h1 className="page-title gov-ref-title">
          {data ? (data.title ?? label) : isLoading ? <><span className="sr-only">{label}</span><span className="skeleton gov-ref-title-sk" aria-hidden="true" /></> : label}
        </h1>
        {!data && isLoading && <div className="gov-ref-sub gov-ref-sub-sk" aria-hidden="true"><span className="skeleton" /></div>}
        {data && (
          // One muted line: which referendum, its track, who proposed it and when.
          <div className="gov-ref-sub gov-ref-meta">
            <span className="gov-ref-meta-line">
              <span className="mono">{pallet === 'opengov' ? `#${index}` : label}</span>
              {data.trackInfo
                ? <><Sep />{trackLabel(data.trackInfo.name)}</>
                : data.track != null ? <><Sep />track {data.track}</> : null}
              {data.proposer && <><Sep /><span className="gov-ref-proposer">by <AddrPill account={data.proposer} noCopy /></span></>}
              {data.submittedAt && <><Sep /><SubmittedLink at={data.submittedAt} now={now} /></>}
            </span>
          </div>
        )}
      </div>

      {isError ? <div className="detail-card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-medium)' }}>Referendum not found</div>
        : isLoading || !data || !tally || !verdict ? <div className="detail-card"><SkeletonRows rows={5} /></div> : (
          <>
            <SectionNav items={[
              { id: 'description', label: 'Description' },
              ...((data.timeline?.length ?? 0) > 0 ? [{ id: 'timeline', label: 'Timeline' }] : []),
              { id: 'verdict', label: 'Status' },
              ...(data.proposalCall || data.proposalHash ? [{ id: 'what', label: 'What it does' }] : []),
              { id: 'discussion', label: 'Discussion', count: commentsCount },
              { id: 'votes', label: 'Votes', count: data.votesTotal },
              { id: 'details', label: 'Details' },
            ]} />

            <div className="gov-ref-layout">
            <div className="gov-ref-main">

            <section id="description" className="gov-section">
              <h2 className="gov-h2">Description</h2>
              <Description pallet={pallet} index={index} forum={data.forum} title={data.title} />
            </section>

            {(data.timeline?.length ?? 0) > 0 && (
              <section id="timeline" className="gov-section" aria-labelledby="timeline-h">
                <h2 id="timeline-h" className="gov-h2">Timeline</h2>
                <ReferendumTimeline timeline={data.timeline} truncated={data.timelineTruncated} now={now} upcoming={upcomingMoments(data, clock)} />
              </section>
            )}

            <StatusSection data={data} verdict={verdict} clock={clock} now={now} open={open} mine={mineLine} myPosition={myPosition} lockDays={lockDays} />

            {(data.proposalCall || data.proposalHash) && (
              <section id="what" className="gov-section">
                <h2 className="gov-h2">What it does</h2>
                {summary
                  ? <div className="gov-wtd"><SummaryView line={summary} /></div>
                  : <p className="gov-empty">{data.proposalCall?.decodeError ? 'The proposal could not be decoded.' : 'The proposal’s preimage is not indexed yet, so its call is unknown.'}</p>}
                {data.proposalCall
                  ? (
                    <details className="gov-call-details">
                      <summary>The full call, decoded{data.proposalCall && !data.proposalCall.decodeError ? ` · ${data.proposalCall.pallet}.${data.proposalCall.callName}` : ''}</summary>
                      <ProposalCall call={data.proposalCall} hash={data.proposalHash} />
                    </details>
                  )
                  : data.proposalHash && <div className="pc-hash mono gov-fineprint">{data.proposalHash}</div>}
              </section>
            )}

            <section id="discussion" className="gov-section" aria-labelledby="discussion-h">
              {data.forum === null ? <><h2 id="discussion-h" className="gov-h2">Discussion</h2><NotReady what="forum" /></>
                : <CommentThread threadKey={`${pallet}:${index}`} onReferendum decimals={data.asset.decimals} title={data.title ?? `Referendum #${index}`} collapse
                    heading={<h2 id="discussion-h" className="gov-h2">Discussion{commentsCount > 0 ? <span className="gov-h2-sub">{F.int(commentsCount)} {commentsCount === 1 ? 'comment' : 'comments'}</span> : null}</h2>} />}
            </section>

            <section id="votes" className="gov-section">
              <h2 className="gov-h2">Votes <span className="gov-h2-sub">{F.int(data.votesTotal)} {data.votesTotal === 1 ? 'account' : 'accounts'}</span></h2>
              <VotesBlock data={data} now={now} />
            </section>

            <section id="details" className="gov-section gov-ref-details" aria-label="Details">
              <MoreDetails data={data} tally={tally} now={now} />
            </section>

            </div>
            <StatusColumn data={data} verdict={verdict} tally={tally} clock={clock} now={now} open={open} mine={mineLine} final={final} />
            </div>

            {/* Phones: the verdict and the Vote entry stay in reach at the bottom. Portaled to
                <body> — an animated ancestor would otherwise become its containing block. */}
            {open && createPortal(
              <aside className="gov-mobile-bar" aria-label="Status and vote">
                <a href="#verdict" className={`gov-mobile-word tone-${verdict.tone}`}>{verdict.word}</a>
                <VoteEntry pallet={pallet} index={index} open={open} current={myPosition} title={data.title} track={data.track} compact />
              </aside>,
              document.body,
            )}
          </>
        )}
    </div>
  )
}

/**
 * "submitted 2d 9h ago", linking to the extrinsic whose Referenda.Submitted event
 * started it — the submit call itself, or the batch or proxy call wrapping it —
 * or to its block when the event has no extrinsic.
 */
function SubmittedLink({ at, now }: { at: NonNullable<ReferendumDetail['submittedAt']>; now: number }) {
  const to = at.extrinsicIndex != null ? paths.extrinsicAt(at.blockHeight, at.extrinsicIndex) : paths.block(at.blockHeight)
  return <Link to={to} className="hash gov-ref-submitted" title={`Submitted ${humanDate(at.timestamp)} — open the submitting transaction`}>submitted {relativeTime(at.timestamp, now)}</Link>
}

function Sep() {
  return <span className="gov-ref-sep" aria-hidden="true">·</span>
}
