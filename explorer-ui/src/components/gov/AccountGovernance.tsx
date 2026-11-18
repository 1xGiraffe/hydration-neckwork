import { useState } from 'react'
import { useAccountForum, useAccountGovernance, useGovClock, waitingForSnapshot } from '../../hooks/useGovernance'
import { useAccountListCount } from '../../hooks/useExplorerData'
import { voteListCount } from '../../utils/activityPaging'
import { GovDetails, GovTerms, InfoTip } from './Disclosure'
import { lockTotals, runningPolls, voteStateNote } from './govTotals'
import { useNow } from '../../hooks/useNow'
import { Link, paths } from '../../router'
import { AddrPill, Amt, F, SkeletonRows } from '../ui'
import { VotesTab } from '../VotesTab'
import { openVote } from '../../vote/voteBus'
import type { AccountGovernance as AccountGovernanceData, GovernanceVoteRow, ProxyRelation } from '../../governanceTypes'
import { delayText, proxyBlockReason, splitByVote } from '../../governanceProxies'
import { forumPostLabel, forumPostPath } from '../../governanceSubjects'
import { AccountDepositsSection } from './Deposits'
import { MomentText, NotReady, StatusBadge, convictionShort, humanDate, lockName, relativeTime, spendableNowOf, trackLabel } from './GovUi'

// An account's governance, in the order a holder asks about it: what am I voting on
// right now, how much HDX is locked and when does it come back, then, folded, who
// can vote for me (and for whom can I), what have I said in the forum and every vote
// ever cast. Used by the account page's Governance tab and by
// /governance/me, one section per account.
// The Unlock button opens the unlock sheet (vote/UnlockSheet.tsx), which reads the
// chain itself and signs with a connected wallet (the account or its proxy).

function afterEndText(v: GovernanceVoteRow, now: number, staker: boolean) {
  const a = v.afterEnd
  const until = a.until ? <MomentText at={a.until} now={now} /> : null
  switch (a.kind) {
    case 'if-wins':
      return <>if {v.vote.side === 'Aye' ? 'aye' : 'nay'} wins, locked until {until ?? 'its period ends'}{staker ? <span className="muted"> (the staked part either way)</span> : null}</>
    case 'won': return <>locked until {until ?? '—'}</>
    case 'lost-staker': return <>locked until {until ?? '—'} <span className="muted">(staked part, estimate)</span></>
    case 'none': return <span className="muted">no lock after it ended</span>
    default: return <span className="muted">outcome not indexed</span>
  }
}

function VoteSide({ v }: { v: GovernanceVoteRow }) {
  const side = v.vote.side
  const cls = side === 'Aye' ? 'aye' : side === 'Nay' ? 'nay' : 'split'
  return <span className={`gov-position ${cls}`}>{side === 'SplitAbstain' ? 'Abstain' : side}{v.vote.kind === 'Standard' ? ` ${convictionShort(v.vote.convictionName, v.vote.conviction)}` : ''}</span>
}

/** What removing a running vote forfeits, by what the account stakes (legacy staking: action points; GIGAHDX: its voting rewards). */
function forfeitText(staker: { staking: string; gigahdx: string } | null | undefined): string | null {
  if (!staker) return null
  const staking = BigInt(staker.staking || '0') > 0n, giga = BigInt(staker.gigahdx || '0') > 0n
  return staking && giga ? 'its staking and GIGAHDX voting rewards' : staking ? 'its staking rewards' : giga ? 'its GIGAHDX voting rewards' : null
}

// A list shows five votes until asked for the rest (the house list length).
const VOTES_SHOWN = 5

function CurrentVotes({ data, now }: { data: AccountGovernanceData; now: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? data.votes : data.votes.slice(0, VOTES_SHOWN)
  const stakers = new Set(data.locks.filter(l => l.staker).map(l => l.account))
  const forfeits = new Map(data.locks.map(l => [l.account, forfeitText(l.staker)]))
  return (
    <>
      <div className="panel"><table className="tbl gov-votes-tbl gov-list-tbl">
        <thead><tr><th>Referendum</th><th>Vote</th><th className="r">HDX</th><th>Status</th><th>After it ends</th></tr></thead>
        <tbody>
          {shown.map(v => (
            <tr key={`${v.account}:${v.cls}:${v.poll}`}>
              <td data-label="Referendum" className="gov-title-cell">
                <Link to={paths.referendum('opengov', v.poll)} className="gov-deadline-title"><span className="mono muted">#{v.poll}</span> {v.referendum?.title ?? ''}</Link>
                <div className="muted gov-cell-sub">{trackLabel(v.trackName)}</div>
              </td>
              <td data-label="Vote"><VoteSide v={v} /></td>
              <td data-label="HDX" className="r mono"><Amt raw={v.vote.balance} dec={12} /></td>
              <td data-label="Status">{v.referendum ? <StatusBadge status={v.referendum.status} /> : <span className="muted">—</span>}</td>
              <td data-label="After it ends" className="gov-after">{afterEndText(v, now, stakers.has(v.account))}{v.removalForfeitsRewards && forfeits.get(v.account) && <InfoTip label="What removing it forfeits">Removing this vote before the referendum ends forfeits {forfeits.get(v.account)}.</InfoTip>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {data.votes.length > shown.length && <button type="button" className="gov-more" onClick={() => setAll(true)}>Show all {data.votes.length} votes</button>}
    </>
  )
}

/** The big other lock that keeps released HDX frozen, in words — or null when nothing else holds it. */
function heldByOthers(l: AccountGovernanceData['locks'][number]): { name: string; amount: string } | null {
  if (!l.otherLocks?.length) return null
  const top = [...l.otherLocks].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))[0]
  return { name: lockName(top.name), amount: top.amount }
}

function Locks({ data, now, primary }: { data: AccountGovernanceData; now: number; primary: boolean }) {
  const asOf = `From indexed chain state as of ${data.asOfBlock != null ? `block ${F.int(data.asOfBlock)}` : 'the latest indexed block'}. The unlock screen reads the chain again and dry-runs the change before you sign.`
  const stakerTip = <InfoTip label="About staked HDX">This account stakes HDX, so on Hydration its votes lock the staked part even when they lose, and staked HDX stays locked until it is unstaked.</InfoTip>
  return (
    <div className="gov-locks">
      {data.locks.map(l => {
        const released = BigInt(l.unlockableNow)
        const spendable = spendableNowOf(l)
        const other = heldByOthers(l)
        const kept = released - spendable
        return (
          <div key={l.account} className="gov-lock-card">
            {data.locks.length > 1 && <div className="gov-cell-sub mono">{F.shortAddr(l.account)} · <Amt raw={l.locked} dec={12} /> HDX locked by votes</div>}
            {released > 0n && kept > 0n && other && (
              <p className="gov-lock-why">
                {spendable > 0n ? <>Unlocking frees <strong>{F.amount(spendable.toString(), 12)} HDX</strong>. </> : null}
                The vote lock on {spendable > 0n ? 'the other ' : ''}<strong>{F.amount(kept.toString(), 12)} HDX</strong> can be released now, but the same HDX is also locked by {other.name} ({F.amount(other.amount, 12)} HDX){spendable > 0n ? ', so that part stays locked' : ', so none of it becomes spendable'}.
                {other.name === 'HDX staking' || other.name === 'GIGAHDX' ? ' Staked HDX stays locked until you unstake it.' : null}
              </p>
            )}
            {BigInt(l.openEnded) > 0n && <p className="gov-lock-why"><Amt raw={l.openEnded} dec={12} /> HDX backs votes on {runningPolls(data.votes, l.account)}, still running; when it frees depends on how they end.</p>}
            {l.schedule.length > 0 && (
              <ul className="gov-unlock-steps">
                {l.schedule.map((s, i) => {
                  const v = s.spendable ?? s.freeable
                  return <li key={s.at.block}><MomentText at={s.at} now={now} />: {BigInt(v) > 0n ? <>up to {F.amount(v, 12)} HDX spendable</> : <>the vote lock releases further; the HDX stays locked by {other?.name ?? 'other locks'}</>}{i === 0 && l.staker && stakerTip}</li>
                })}
              </ul>
            )}
            {/* One action, two labels: "Unlock" (lavender, unless the page already leads with it) only when it frees HDX, else a neutral "Clean up votes". */}
            <div className="gov-lock-actions">
              {spendable > 0n
                ? <button type="button" className={`gov-btn${primary ? ' gov-btn-primary' : ''}`} title={asOf} onClick={() => openVote({ kind: 'unlock', address: l.account })}>Unlock {F.amount(spendable.toString(), 12)} HDX</button>
                : <button type="button" className="gov-btn" title={asOf} onClick={() => openVote({ kind: 'unlock', address: l.account })}>Clean up votes</button>}
              {l.staker && !l.schedule.length && stakerTip}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** "can vote" / "cannot vote", the same in both directions, with the reason on hover. */
function ProxyVoteBadge({ p, msPerBlock }: { p: ProxyRelation; msPerBlock: number | null }) {
  const why = proxyBlockReason(p, msPerBlock)
  return why ? <span className="gov-label gov-label-no" title={why}>cannot vote</span> : <span className="gov-label ok">can vote</span>
}

function ProxyRows({ rows, msPerBlock }: { rows: ProxyRelation[]; msPerBlock: number | null }) {
  return (
    <ul className="gov-proxy-list">{rows.map(p => (
      <li key={`${p.holder ?? ''}:${p.account.accountId}:${p.proxyType}:${p.delay}`}>
        <AddrPill account={p.account} noCopy />
        <span className="muted">{p.proxyType} proxy{p.delay ? `, delay ${delayText(p.delay, msPerBlock)}` : ''}</span>
        <ProxyVoteBadge p={p} msPerBlock={msPerBlock} />
      </li>
    ))}</ul>
  )
}

/** A group that cannot vote: folded, as it is there for completeness. */
function FoldedProxies({ title, rows, msPerBlock }: { title: string; rows: ProxyRelation[]; msPerBlock: number | null }) {
  if (!rows.length) return null
  return (
    <details className="gov-proxy-fold">
      <summary className="gov-h4">{title} <span className="muted">· {rows.length}</span></summary>
      <ProxyRows rows={rows} msPerBlock={msPerBlock} />
    </details>
  )
}

// Each direction split by whether the relation can vote, so a "can vote" heading never
// lists an account it cannot vote through.
function Proxies({ data }: { data: AccountGovernanceData }) {
  const { canActFor, actedForBy, pure } = data.proxies
  const msPerBlock = useGovClock().data?.msPerBlock ?? null
  const forOthers = splitByVote(canActFor)
  const forThis = splitByVote(actedForBy)
  return (
    <div className="gov-proxies">
      {forOthers.voting.length > 0 && (
        <div>
          <h4 className="gov-h4">This account can vote for</h4>
          <ProxyRows rows={forOthers.voting} msPerBlock={msPerBlock} />
        </div>
      )}
      {forThis.voting.length > 0 && (
        <div>
          <h4 className="gov-h4">Can vote for this account</h4>
          <ProxyRows rows={forThis.voting} msPerBlock={msPerBlock} />
        </div>
      )}
      <FoldedProxies title="Also a proxy for (cannot vote)" rows={forOthers.other} msPerBlock={msPerBlock} />
      <FoldedProxies title="Other proxies of this account (cannot vote)" rows={forThis.other} msPerBlock={msPerBlock} />
      {canActFor.length > 0 && actedForBy.length > 0 && <p className="gov-fineprint">An account can appear on both sides when two accounts are proxies of each other.</p>}
      {pure && <p className="gov-fineprint">A pure proxy created by <AddrPill account={pure.creator} noCopy /> ({pure.proxyType}).</p>}
    </div>
  )
}

function Delegations({ data }: { data: AccountGovernanceData }) {
  const { in: inbound, out } = data.delegations
  if (!inbound.length && !out.length) return null
  return (
    <section className="gov-section">
      <h3 className="gov-h3">Delegations<InfoTip label="About delegations">Shown for completeness: delegating earns no rewards on Hydration, and the explorer does not offer it.</InfoTip></h3>
      <ul className="gov-proxy-list gov-deleg-list">
        {out.map((d, i) => <li key={`o${i}`}>Delegates <Amt raw={d.balance} dec={12} /> HDX at {convictionShort(d.convictionName, d.conviction)} on {trackLabel(d.trackName)} to <AddrPill account={d.to} noCopy /></li>)}
        {inbound.map((d, i) => <li key={`i${i}`}><AddrPill account={d.from} noCopy /> delegates <Amt raw={d.balance} dec={12} /> HDX at {convictionShort(d.convictionName, d.conviction)} on {trackLabel(d.trackName)}</li>)}
      </ul>
    </section>
  )
}

function ForumActivity({ address, counts }: { address: string; counts: AccountGovernanceData['forum'] }) {
  const now = useNow(60_000)
  const q = useAccountForum(counts.posts + counts.comments > 0 ? address : null)
  const rows = q.data?.pages.flatMap(p => p.rows) ?? []
  return (
    <>
      {waitingForSnapshot(q) ? <NotReady what="forum" /> : (
        <ul className="gov-activity">
          {rows.map(r => {
            const path = forumPostPath(r.type === 'post' ? r.id : r.threadKey)
            const to = path ? (r.type === 'comment' ? `${path}#c-${r.id}` : path) : null
            return (
              <li key={r.id}>
                <span className="gov-activity-kind">{r.type === 'post' ? 'Started' : 'Commented on'}</span>{' '}
                {to ? <Link to={to} className="gov-activity-title">{r.title || forumPostLabel(r.threadKey)}</Link> : <span>{r.title || forumPostLabel(r.threadKey)}</span>}
                <span className="muted" title={humanDate(r.createdAt)}> · {relativeTime(r.createdAt, now)}</span>
                {r.excerpt && <p className="gov-disc-excerpt">{r.excerpt}</p>}
              </li>
            )
          })}
        </ul>
      )}
      {q.hasNextPage && <button type="button" className="gov-more" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
    </>
  )
}

/** "1 discussion · 91 comments" */
const plural = (n: number, one: string, many: string) => `${F.int(n)} ${n === 1 ? one : many}`

/**
 * An account's governance. On the account page (`showHistory`) it opens with its own
 * ribbon and Terms and closes with the vote history; on /governance/me the page
 * carries those for every account at once, and this is one account's section.
 * Sections with nothing in them are one muted line together, not a heading each.
 */
export function AccountGovernance({ address, showHistory = true }: { address: string; showHistory?: boolean }) {
  const now = useNow(30_000)
  const q = useAccountGovernance(address)
  const data = q.data
  const total = useAccountListCount(showHistory ? address : null, voteListCount()).data?.total
  if (waitingForSnapshot(q)) return <NotReady what="vote state" />
  if (q.isLoading) return <div className="detail-card"><SkeletonRows rows={5} /></div>
  if (!data) return <p className="gov-empty">This account’s governance could not be loaded. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></p>
  const t = lockTotals([data])
  const proxies = data.proxies.canActFor.length + data.proxies.actedForBy.length + (data.proxies.pure ? 1 : 0)
  const forum = data.forum.posts + data.forum.comments
  // Deposits: an older api sends none (say nothing); a preimage list still loading is
  // never read as "none", so then only the referendum deposits are said to be absent.
  const dep = data.deposits
  const noDeposits = !!dep && !dep.referenda.length && (dep.preimages == null || !dep.preimages.length)
  const empty = [
    !data.votes.length && 'no standing votes',
    !data.locks.length && 'no HDX locked by votes',
    noDeposits && (dep!.preimages == null ? 'no referendum deposits' : 'no deposits'),
    !proxies && 'no proxies',
    !forum && 'no forum posts',
  ].filter(Boolean) as string[]
  return (
    <div className="gov-account">
      {showHistory && (
        <>
          <div className="ribbon standalone gov-ribbon">
            <div className="cell"><span className="k">Voted on</span><span className="v">{F.int(data.history.referendaVoted)}</span><span className="s">{data.history.lastVote ? <>last <MomentText at={data.history.lastVote} now={now} relative /></> : 'no vote yet'}</span></div>
            <div className="cell"><span className="k">Locked by votes</span><span className="v"><Amt raw={t.locked} dec={12} /> HDX</span></div>
            <div className="cell"><span className="k">Unlockable now</span><span className={`v${t.unlockable > 0n ? ' good' : ''}`}><Amt raw={t.unlockable.toString()} dec={12} /> HDX</span></div>
            <div className="cell"><span className="k">Next unlock</span><span className="v">{t.next ? <MomentText at={t.next.at} now={now} withTime={false} /> : t.waiting ? `after ${t.waiting} end` : '—'}</span></div>
          </div>
          <GovTerms terms={['conviction', 'locks', 'delegation']} extra={[voteStateNote(data)]} />
        </>
      )}

      {data.votes.length > 0 && (
        <section className="gov-section">
          <h3 className="gov-h3">Current votes <span className="gov-h2-sub">· {data.votes.length}</span></h3>
          <CurrentVotes data={data} now={now} />
        </section>
      )}

      {data.locks.length > 0 && (
        <section className="gov-section">
          <h3 className="gov-h3">Unlocking</h3>
          <Locks data={data} now={now} primary={showHistory} />
        </section>
      )}

      {dep && <AccountDepositsSection deposits={dep} />}

      <Delegations data={data} />

      {empty.length > 0 && <p className="gov-empty gov-empty-line">{empty.join(' · ').replace(/^n/, 'N')}</p>}

      {proxies > 0 && <GovDetails summary={`Proxies (${proxies})`} className="gov-fold"><Proxies data={data} /></GovDetails>}
      {forum > 0 && (
        <GovDetails summary={`Forum activity (${[data.forum.posts && plural(data.forum.posts, 'discussion', 'discussions'), data.forum.comments && plural(data.forum.comments, 'comment', 'comments')].filter(Boolean).join(' · ')})`} className="gov-fold">
          <ForumActivity address={address} counts={data.forum} />
        </GovDetails>
      )}
      {showHistory && (
        <GovDetails summary={`Vote history${total != null ? ` (${F.int(total)})` : ''}`} className="gov-fold gov-history">
          <VotesTab scope={{ kind: 'account', address }} pageSize={10} />
        </GovDetails>
      )}
    </div>
  )
}
