import { useEffect, useState, type RefObject } from 'react'
import { Markdown } from '../../markdown/Markdown'
import { forumApi } from '../../api/explorer'
import { useForumThread } from '../../hooks/useGovernance'
import { useSession } from '../../session'
import { errorText, useAfterForumWrite, useForumMe, usePostPermissions } from '../../forumSession'
import { navigate, paths } from '../../router'
import type { ForumComment, ForumPostDetail } from '../../governanceTypes'
import { ForumAuthorName, humanDate } from './GovUi'
import { ForumComposer } from './ForumComposer'
import { ModerateButtons, ReportButton, RevisionList } from './ForumActions'
import { PostEditor } from './PostEditor'
import { PollCard } from './PollCard'
import { BodyFold } from './BodyFold'
import { stripLeadingTitle } from '../../utils/leadingTitle'
import './forum.css'

// A post's body (a discussion, or an on-chain subject's description) with what a
// reader needs to trust it: who wrote it, whether it was edited — with every
// earlier revision readable. Its author edits or deletes it in
// place; an OpenGov referendum's proposer (or an account that speaks for it) edits
// the description and posts Updates under it.

/** Below this many entries a post has no contents list. */
const TOC_MIN_HEADINGS = 3

/**
 * "Contents" for a long post: its top two heading levels (the renderer moves a post's
 * headings one level down, so they arrive as h2–h6; the top level is whichever is the
 * highest the post uses), read from the rendered body inside `root` (re-read whenever
 * the body re-renders), each a button that scrolls to it. Heading text is read as
 * plain text. Shown beside the post on wide screens only, scrolling inside itself when
 * it is longer than the screen (forum.css); nothing renders below TOC_MIN_HEADINGS entries.
 */
export function PostToc({ root }: { root: RefObject<HTMLElement | null> }) {
  const [heads, setHeads] = useState<{ el: HTMLElement; text: string; level: number }[]>([])
  useEffect(() => {
    const el = root.current
    if (!el) return
    const read = () => {
      const all = Array.from(el.querySelectorAll<HTMLElement>('.gov-post-md :is(h2, h3, h4, h5, h6)'))
        .map(h => ({ el: h, text: (h.textContent ?? '').replace(/\s+/g, ' ').trim(), level: Number(h.tagName.slice(1)) }))
        .filter(h => h.text)
      const top = Math.min(...all.map(h => h.level))
      const found = all.filter(h => h.level <= top + 1)
      setHeads(prev => (prev.length === found.length && prev.every((p, i) => p.el === found[i].el && p.text === found[i].text) ? prev : found))
    }
    read()
    const obs = new MutationObserver(read)
    obs.observe(el, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [root])
  if (heads.length < TOC_MIN_HEADINGS) return null
  const top = Math.min(...heads.map(h => h.level))
  return (
    <nav className="gov-post-toc" aria-label="Contents">
      <div className="gov-post-toc-title">Contents</div>
      <ol>
        {heads.map((h, i) => (
          <li key={i} className={`toc-l${Math.min(h.level - top, 1)}`}>
            <button type="button" onClick={() => h.el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>
              {h.text.length > 90 ? `${h.text.slice(0, 88)}…` : h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function DeletePost({ post }: { post: ForumPostDetail }) {
  const after = useAfterForumWrite()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!confirm) return <button type="button" className="fa-link" onClick={() => setConfirm(true)}>Delete</button>
  return (
    <span className="fa-confirm" role="group" aria-label="Confirm delete">
      <span>Delete this {post.kind === 'discussion' ? 'discussion' : 'description'} and every earlier version of it? Comments stay, under “deleted”.</span>
      <button type="button" className="fa-link fa-danger" disabled={busy} onClick={async () => {
        setBusy(true); setError(null)
        try {
          const r = await forumApi.deletePost(post.postId)
          after(r.generation)
          if (post.kind === 'discussion') navigate(paths.discussions())
        } catch (e) { setError(errorText(e)); setBusy(false) }
      }}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
      <button type="button" className="fa-link" disabled={busy} onClick={() => setConfirm(false)}>Keep it</button>
      {error && <span className="fa-error" role="alert">{error}</span>}
    </span>
  )
}

/** A proposer's Updates under a description, oldest first, and the box to add one. */
function PostUpdates({ postId, canPost }: { postId: string; canPost: boolean }) {
  const q = useForumThread(postId, 'old', null)
  const updates: ForumComment[] = q.data?.pages[0]?.updates ?? []
  const [open, setOpen] = useState(false)
  if (!updates.length && !canPost) return null
  return (
    <div className="gov-updates">
      {updates.length > 0 && <h3 className="gov-h3">Updates from the proposer</h3>}
      {updates.map(u => (
        <article key={u.commentId} id={`c-${u.commentId}`} className="gov-update">
          <header className="cmt-head"><ForumAuthorName author={u.author} /><span className="cmt-time">{humanDate(u.createdAt, false)}</span></header>
          {u.body != null
            ? <BodyFold size="inline" open={window.location.hash === `#c-${u.commentId}`}><Markdown body={u.body} format={u.bodyFormat} media={u.media} className="cmt-md" native={u.source == null} /></BodyFold>
            : <p className="cmt-stub">{u.deleted ? 'Deleted.' : 'Hidden by moderation.'}</p>}
        </article>
      ))}
      {canPost && (open
        ? <ForumComposer mode={{ kind: 'update', postId }} draftKey={`update:${postId}`} autoFocus label="Post an update" placeholder="What has happened since — milestones, changes, answers to questions" onCancel={() => setOpen(false)} onDone={() => setOpen(false)} />
        : <button type="button" className="gov-btn" onClick={() => setOpen(true)}>Post an update</button>)}
    </div>
  )
}

/**
 * `plain`: no card, the author and date in one meta line above the text (a
 * referendum's description, under its section heading). `title`: drop the text's
 * opening heading when it only repeats this title. `clamp`: a long text is folded (BodyFold).
 */
export function ForumPostBody({ post, showAuthor = true, plain = false, clamp = false, title }: { post: ForumPostDetail; showAuthor?: boolean; plain?: boolean; clamp?: boolean; title?: string | null }) {
  const session = useSession()
  const me = useForumMe()
  const perms = usePostPermissions(post.postId)
  const [revisionsOpen, setRevisionsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const body = stripLeadingTitle(post.body, post.bodyFormat, title)
  const hasText = post.body.trim().length > 0
  const own = !!session && post.author.account?.accountId === session.accountId
  const subject = post.kind !== 'discussion'
  // The footer is left out when there is nothing to offer.
  const actions = post.revision > 0 || !!perms.data?.edit || (post.kind === 'discussion' && !!perms.data?.delete && hasText)
    || (!!session && !own && hasText) || !!me.data?.moderator

  if (editing) {
    return (
      <PostEditor
        mode={{ kind: 'edit', post }}
        onCancel={() => setEditing(false)}
        onDone={() => setEditing(false)}
      />
    )
  }

  return (
    <div className={`gov-post${plain ? ' plain' : ''}`}>
      {showAuthor && hasText && (
        <div className="gov-post-meta">
          <ForumAuthorName author={post.author} />
          <span className="muted" title={humanDate(post.createdAt)}>{plain ? humanDate(post.createdAt, false) : `wrote on ${humanDate(post.createdAt, false)}`}</span>
        </div>
      )}
      {post.banner && /^\/ipfs\/[A-Za-z0-9]{46,121}$/.test(post.banner) && <img className="gov-post-banner" src={post.banner} alt="" decoding="async" />}
      {post.tldr && <p className="gov-tldr"><strong>In short:</strong> {post.tldr}</p>}
      {hasText
        ? (
          <BodyFold fold={clamp}>
            <Markdown body={body} format={post.bodyFormat} media={post.media} className="gov-post-md" native={post.source == null} />
          </BodyFold>
        )
        : <p className="gov-empty">No description was written for this.{perms.data?.edit ? ' As its proposer, you can write one.' : ''}</p>}
      {post.poll != null && <PollCard poll={post.poll} />}
      {actions && <div className="gov-post-foot">
        {post.revision > 0 && (
          <button type="button" className="fa-link" aria-expanded={revisionsOpen} onClick={() => setRevisionsOpen(o => !o)}>
            edited{post.editedAt ? ` ${humanDate(post.editedAt, false)}` : ''} · {revisionsOpen ? 'hide' : 'show'} versions
          </button>
        )}
        {perms.data?.edit && <button type="button" className="fa-link" onClick={() => setEditing(true)}>{hasText ? 'Edit' : 'Write the description'}</button>}
        {post.kind === 'discussion' && perms.data?.delete && hasText && <DeletePost post={post} />}
        {session && !own && hasText && <ReportButton targetId={post.postId} what={subject ? 'description' : 'discussion'} />}
        {me.data?.moderator && <ModerateButtons targetId={post.postId} hidden={false} thread locked={!!post.locked} />}
      </div>}
      {revisionsOpen && <div className="gov-post-panel"><RevisionList targetId={post.postId} format={post.bodyFormat} media={post.media} /></div>}
      {post.kind === 'opengov' && <PostUpdates postId={post.postId} canPost={!!perms.data?.update} />}
    </div>
  )
}
