import { useDiscussions, waitingForSnapshot } from '../hooks/useGovernance'
import { useNow } from '../hooks/useNow'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { Link, paths } from '../router'
import { Crumbs, SkeletonRows } from '../components/ui'
import { useActionGate } from '../forumSession'
import { DiscussionItem } from '../components/gov/GovLists'
import { NotReady } from '../components/gov/GovUi'

// /discussions — the forum's list, most recently active first. It renders titles and
// plain-text excerpts only, so it lives apart from the post pages (pages/Forum.tsx)
// and never loads the markdown renderer. Finding a discussion is the global search's
// job; this page only lists them and offers Start a discussion.

export function Discussions() {
  useDocumentTitle('Discussions')
  const now = useNow(60_000)
  const list = useDiscussions({ sort: 'active' })
  const startGate = useActionGate('post')
  const rows = list.data?.pages.flatMap(p => p.rows) ?? []
  const total = list.data?.pages[0]?.total

  return (
    <div className="wrap gov-forum">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'Discussions' }]} />
        <h1 className="page-title">Discussions<span className="sub">Ideas before they become referenda, and the debate around them</span></h1>
      </div>

      <div className="gov-forum-bar">
        {startGate.ok || startGate.signIn
          ? <Link to={paths.discussionNew()} className="gov-btn gov-btn-primary">Start a discussion</Link>
          : <button type="button" className="gov-btn" disabled title={startGate.reason ?? undefined} aria-describedby="start-gate-note">Start a discussion</button>}
      </div>
      {!startGate.ok && !startGate.signIn && <p id="start-gate-note" className="gov-fineprint fc-gate-inline">{startGate.reason}</p>}

      {waitingForSnapshot(list) ? <NotReady what="forum" />
        : list.isError ? <p className="gov-empty">Discussions could not be loaded. <button type="button" className="link-btn" onClick={() => list.refetch()}>Try again</button></p>
          : list.isLoading ? <div className="detail-card"><SkeletonRows rows={6} /></div>
            : !rows.length ? <p className="gov-empty">No discussions yet.</p>
              : (
                <>
                  <ul className="gov-discs gov-discs-page">{rows.map(r => <DiscussionItem key={r.postId} row={r} now={now} />)}</ul>
                  {list.hasNextPage && <button type="button" className="gov-more" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : `Show more (${(total ?? 0) - rows.length} left)`}</button>}
                </>
              )}
      <p className="gov-fineprint">Moderators’ actions are public in the <Link to={paths.governanceModeration()} className="hash">moderation log</Link>.</p>
    </div>
  )
}
