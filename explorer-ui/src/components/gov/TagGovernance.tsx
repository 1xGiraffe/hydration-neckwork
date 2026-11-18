import { useTagGovernance, waitingForSnapshot } from '../../hooks/useGovernance'
import { useListTagGovernance } from '../../hooks/useUser'
import { useNow } from '../../hooks/useNow'
import { Link, paths } from '../../router'
import { AddrPill, Amt, F, SkeletonRows } from '../ui'
import { VotesTab } from '../VotesTab'
import { GovTerms } from './Disclosure'
import { MomentText, NotReady, StatusBadge, trackLabel } from './GovUi'
import type { MembersGovernance } from '../../governanceTypes'

type TagScope = { kind: 'tag'; tagId: string } | { kind: 'list-tag'; listId: string; tagId: string }

// A tag's Governance tab: what its members hold in governance now, summed (votes on
// running referenda, the HDX their votes lock and when it comes back, delegations),
// then every vote they cast, by referendum or one by one.

function RunningVotes({ data }: { data: MembersGovernance }) {
  const abstain = data.running.some(r => r.abstain !== '0')
  return (
    <div className="panel"><table className="tbl gov-votes-tbl gov-list-tbl gov-members-tbl">
      <thead><tr><th>Referendum</th><th className="r">Members</th><th className="r">Aye HDX</th><th className="r">Nay HDX</th>{abstain && <th className="r">Abstain HDX</th>}<th>Status</th></tr></thead>
      <tbody>
        {data.running.map(r => (
          <tr key={r.index}>
            <td data-label="Referendum" className="gov-title-cell">
              <Link to={paths.referendum('opengov', r.index)} className="gov-deadline-title"><span className="mono muted">#{r.index}</span> {r.title ?? ''}</Link>
              <div className="muted gov-cell-sub">{trackLabel(r.trackName)}</div>
            </td>
            <td data-label="Members" className="r mono">{F.int(r.voters)}</td>
            <td data-label="Aye HDX" className="r mono">{r.aye === '0' ? <span className="muted">—</span> : <span className="gov-position aye"><Amt raw={r.aye} dec={12} /></span>}</td>
            <td data-label="Nay HDX" className="r mono">{r.nay === '0' ? <span className="muted">—</span> : <span className="gov-position nay"><Amt raw={r.nay} dec={12} /></span>}</td>
            {abstain && <td data-label="Abstain HDX" className="r mono">{r.abstain === '0' ? <span className="muted">—</span> : <Amt raw={r.abstain} dec={12} />}</td>}
            <td data-label="Status"><StatusBadge status={r.status} /></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  )
}

export function TagGovernance({ scope, votesCount }: { scope: TagScope; votesCount?: number }) {
  const now = useNow(30_000)
  const tagQ = useTagGovernance(scope.kind === 'tag' ? scope.tagId : null)
  const listQ = useListTagGovernance(scope.kind === 'list-tag' ? scope.listId : null, scope.kind === 'list-tag' ? scope.tagId : null)
  const q = scope.kind === 'tag' ? tagQ : listQ
  const data = q.data
  const l = data?.locks
  return (
    <div className="gov-account">
      {waitingForSnapshot(q) ? <NotReady what="vote state" />
        : q.isLoading ? <div className="detail-card"><SkeletonRows rows={3} /></div>
        : !data || !l ? <p className="gov-empty">The members’ governance could not be loaded. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></p>
        : (
          <>
            <div className="ribbon standalone gov-ribbon">
              <div className="cell"><span className="k">Voting now</span><span className="v">{F.int(data.voting)}</span><span className="s">of {F.int(data.members)} {data.members === 1 ? 'member' : 'members'}{data.delegating > 0 ? ` · ${F.int(data.delegating)} delegating` : ''}</span></div>
              <div className="cell"><span className="k">Locked by votes</span><span className="v"><Amt raw={l.locked} dec={12} /> HDX</span><span className="s">{l.holders > 0 ? `${F.int(l.holders)} ${l.holders === 1 ? 'member' : 'members'}` : 'none'}</span></div>
              <div className="cell"><span className="k">Unlockable now</span><span className={`v${l.unlockableNow !== '0' ? ' good' : ''}`}><Amt raw={l.unlockableNow} dec={12} /> HDX</span></div>
              <div className="cell"><span className="k">Next unlock</span><span className="v">{l.nextUnlock ? <MomentText at={l.nextUnlock.at} now={now} withTime={false} /> : l.openEnded !== '0' ? 'after running votes end' : '—'}</span>{l.nextUnlock && <span className="s"><Amt raw={l.nextUnlock.amount} dec={12} /> HDX</span>}</div>
            </div>
            <GovTerms terms={['conviction', 'locks']} />

            {data.running.length > 0
              ? (
                <section className="gov-section">
                  <h3 className="gov-h3">Running referenda <span className="gov-h2-sub">· {data.running.length}</span></h3>
                  <RunningVotes data={data} />
                </section>
              )
              : <p className="gov-empty gov-empty-line">No member votes on a running referendum</p>}

            {data.delegationsOut.length > 0 && (
              <section className="gov-section">
                <h3 className="gov-h3">Delegations</h3>
                <ul className="gov-proxy-list gov-deleg-list">
                  {data.delegationsOut.map(d => (
                    <li key={d.to.accountId}>
                      {F.int(d.members)} {d.members === 1 ? 'member delegates' : 'members delegate'} <Amt raw={d.balance} dec={12} /> HDX to <AddrPill account={d.to} noCopy /> on {F.int(d.tracks)} {d.tracks === 1 ? 'track' : 'tracks'}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.forum.posts + data.forum.comments > 0 && (
              <p className="gov-fineprint">Members wrote {F.int(data.forum.posts)} {data.forum.posts === 1 ? 'discussion' : 'discussions'} and {F.int(data.forum.comments)} {data.forum.comments === 1 ? 'comment' : 'comments'} in the forum.</p>
            )}
          </>
        )}

      {/* The vote history is the tab's main list, shown open rather than folded. */}
      <section className="gov-section">
        <h3 className="gov-h3">Votes{votesCount != null && votesCount > 0 ? <span className="gov-h2-sub"> · {F.int(votesCount)}</span> : null}</h3>
        {scope.kind === 'tag'
          ? <VotesTab scope={{ kind: 'tag', tagId: scope.tagId }} />
          : <VotesTab scope={{ kind: 'list-tag', listId: scope.listId, tagId: scope.tagId }} />}
      </section>
    </div>
  )
}
