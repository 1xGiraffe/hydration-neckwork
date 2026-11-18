import { Fragment, useRef, type ReactNode } from 'react'
import { useForumPost, useForumThread, waitingForSnapshot } from '../hooks/useGovernance'
import { useDocumentTitle, useNoindex } from '../hooks/useDocumentTitle'
import { Link, navigate, paths } from '../router'
import { Crumbs, F, SkeletonRows } from '../components/ui'
import { CommentThread } from '../components/gov/CommentThread'
import { ForumPostBody, PostToc } from '../components/gov/ForumPostBody'
import { CopyLinkButton } from '../components/gov/CopyLink'
import { PostEditor } from '../components/gov/PostEditor'
import { NotReady, forumLabelText, humanDate } from '../components/gov/GovUi'
import { forumPostLabel, forumPostPath, subjectPostId, type SubjectRoute } from '../governanceSubjects'
import type { ForumPostDetail } from '../governanceTypes'
import { ApiError } from '../api/explorer'

// The forum's post pages: /discussions/new, /discussions/<id> (one discussion with
// its thread), plus the archive records' pages (/governance/<route>/<id>), which are
// the same post-and-thread reading of an on-chain subject's imported record. The
// list (/discussions) is pages/Discussions.tsx, its own chunk, so it never loads
// the markdown renderer it does not use.

/** /discussions/new — the editor for a new discussion. */
export function NewDiscussion() {
  useDocumentTitle('Start a discussion')
  return (
    <div className="wrap gov-forum gov-new-disc">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'Discussions', to: paths.discussions() }, { label: 'New' }]} />
        <h1 className="page-title">Start a discussion<span className="sub">An idea before it becomes a referendum, a question for the community, or a debate</span></h1>
      </div>
      <PostEditor mode={{ kind: 'new' }} onCancel={() => navigate(paths.discussions())} />
      <p className="gov-fineprint">Your draft is kept in this browser until you publish. Everyone can read what you publish; you can edit it later (each version stays readable) or delete it.</p>
    </div>
  )
}

/**
 * One post and its thread — a discussion, or an archive subject's imported record.
 * Under the title, one muted line: what the record is (an archive record; a
 * discussion's crumb already says so), its topics and the items it is linked to,
 * with a copy-link button at its end.
 */
function PostPage({ postId, crumbs, kindLabel, showKind }: { postId: string; crumbs: { label: string; to?: string }[]; kindLabel: string; showKind?: boolean }) {
  const q = useForumPost(postId)
  const bodyRef = useRef<HTMLDivElement>(null)
  const post = q.data
  // A post's thread is almost always keyed by the post itself, so its first page
  // (CommentThread's default order) is requested alongside the post rather than
  // after it renders; a post whose thread lives on a linked item stops asking.
  useForumThread(postId, 'old', null, !post || ('threadKey' in post && post.threadKey === postId))
  const visible: ForumPostDetail | null = post && post.hidden === false ? post : null
  useDocumentTitle(visible ? visible.title || kindLabel : kindLabel)
  useNoindex(!!post?.hidden || (q.error instanceof ApiError && q.error.status === 404))
  return (
    <div className="wrap gov-forum gov-post-page">
      <div className="page-head">
        <Crumbs items={[...crumbs, { label: visible?.title ? (visible.title.length > 48 ? `${visible.title.slice(0, 46)}…` : visible.title) : kindLabel }]} />
        <h1 className="page-title gov-post-title">{visible ? visible.title || 'Untitled' : kindLabel}</h1>
        {visible && (
          <div className="gov-ref-sub gov-ref-meta">
            <PostMeta post={visible} kind={showKind ? kindLabel : null} />
            <span className="gov-ref-actions">
              <CopyLinkButton url={`${window.location.origin}${window.location.pathname}`} what={showKind ? 'this record' : 'this discussion'} />
            </span>
          </div>
        )}
      </div>
      {waitingForSnapshot(q) ? <NotReady what="forum" />
        : q.isLoading ? <div className="detail-card"><SkeletonRows rows={6} /></div>
          : !post ? (q.error instanceof ApiError && q.error.status === 404
            ? <div className="detail-card gov-missing">There is no {kindLabel.toLowerCase()} at this address. <Link to={paths.discussions()} className="hash">Back to discussions</Link></div>
            : <div className="detail-card gov-missing" role="alert">This could not be loaded right now. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></div>)
            : post.hidden ? (
              <>
                <div className="detail-card gov-missing" role="note">
                  {post.deleted
                    ? <><strong>Deleted by its author.</strong> Its text and every earlier version were removed.</>
                    : <><strong>Hidden by moderation.</strong> {post.hiddenReason === 'imported-hidden' ? 'It was hidden before it was imported (spam or abuse), so its text is not shown here.' : post.hiddenReason === 'reported' ? 'Several readers reported it; a moderator will review it.' : 'Its text is not shown.'} <Link to={paths.governanceModeration()} className="hash">Moderation log</Link></>}
                  <div className="muted" style={{ marginTop: 6 }}>Posted {humanDate(post.createdAt)}. <Link to={paths.discussions()} className="hash">Back to discussions</Link></div>
                </div>
                {post.deleted && (
                  <section className="gov-section" aria-labelledby="post-discussion">
                    <CommentThread threadKey={post.postId} heading={<h2 id="post-discussion" className="gov-h2">Discussion</h2>} />
                  </section>
                )}
              </>
            ) : (
              <>
                <div className="gov-post-layout">
                  <section ref={bodyRef} className="gov-section gov-post-section"><ForumPostBody post={post} /></section>
                  <aside className="gov-post-aside"><PostToc root={bodyRef} /></aside>
                </div>
                <section className="gov-section" aria-labelledby="post-discussion">
                  <CommentThread threadKey={post.threadKey} title={post.title || kindLabel}
                    intro={post.threadKey !== post.postId ? <p className="gov-fineprint">These comments were written on the linked {forumPostLabel(post.threadKey).toLowerCase()}, which shares this thread.</p> : null}
                    heading={<h2 id="post-discussion" className="gov-h2">Discussion{post.commentsCount > 0 ? <span className="gov-h2-sub">{F.int(post.commentsCount)} {post.commentsCount === 1 ? 'comment' : 'comments'}</span> : null}</h2>} />
                </section>
              </>
            )}
    </div>
  )
}

function PostMeta({ post, kind }: { post: ForumPostDetail; kind: string | null }) {
  const linked = post.linked.flatMap(id => {
    const path = forumPostPath(id)
    return path ? [<Link key={id} to={path} className="hash">{forumPostLabel(id)}</Link>] : []
  })
  const parts: ReactNode[] = [
    ...(kind ? [<span key="kind">{kind}</span>] : []),
    ...post.labels.map(l => <span key={`l:${l}`}>{forumLabelText(l)}</span>),
    ...(linked.length ? [<span key="linked">Linked: {linked.map((l, i) => <Fragment key={i}>{i ? ', ' : ''}{l}</Fragment>)}</span>] : []),
  ]
  return <div className="gov-post-sub">{parts.map((p, i) => <Fragment key={i}>{i ? <span aria-hidden="true"> · </span> : null}{p}</Fragment>)}</div>
}

export function Discussion({ id }: { id: string }) {
  return <PostPage postId={id} kindLabel="Discussion" crumbs={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'Discussions', to: paths.discussions() }]} />
}

export function GovernanceSubject({ subject, id }: { subject: SubjectRoute; id: string }) {
  const label = /^0x/.test(id) ? `${subject.label} ${id.slice(0, 10)}…` : `${subject.label} #${id}`
  return (
    <PostPage
      postId={subjectPostId(subject, id)}
      kindLabel={label}
      showKind
      crumbs={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'Archive', to: `${paths.governance('archive')}${subject.kind === 'council' ? '' : `&kind=${subject.kind}`}` }]}
    />
  )
}
