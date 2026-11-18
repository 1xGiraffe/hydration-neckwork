import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
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

/** Code blocks past this many lines show their first lines and a "Show all N lines". */
const CODE_LINES = 16

/**
 * A long post stays readable: a code block over CODE_LINES lines is cut to its first
 * lines with a button for the rest, and each image (capped in height by forum.css)
 * opens full size in a new tab. Applied to the rendered body (re-applied whenever it
 * re-renders); the controls are built with DOM calls and text only, and an image
 * link points only at the image's own /ipfs/ address, which the renderer has already
 * vetted.
 */
function useLongBodyControls(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const apply = () => {
      for (const pre of Array.from(el.querySelectorAll<HTMLPreElement>('.gov-post-md pre'))) {
        if (pre.dataset.clamp) continue
        const lines = (pre.textContent ?? '').replace(/\n$/, '').split('\n').length
        if (lines <= CODE_LINES) { pre.dataset.clamp = 'none'; continue }
        pre.dataset.clamp = 'on'
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'gov-more md-pre-more'
        btn.setAttribute('aria-expanded', 'false')
        btn.textContent = `Show all ${lines} lines`
        btn.addEventListener('click', () => {
          const opening = pre.dataset.clamp === 'on'
          pre.dataset.clamp = opening ? 'off' : 'on'
          btn.setAttribute('aria-expanded', String(opening))
          btn.textContent = opening ? 'Show fewer lines' : `Show all ${lines} lines`
        })
        pre.after(btn)
      }
      for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('.gov-post-md img.md-img'))) {
        const src = img.getAttribute('src') ?? ''
        if (img.closest('a') || !/^\/ipfs\/[A-Za-z0-9]+$/.test(src)) continue
        const a = document.createElement('a')
        a.href = src
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.className = 'md-img-open'
        a.title = 'Open the full image'
        img.replaceWith(a)
        a.append(img)
      }
    }
    apply()
    const obs = new MutationObserver(apply)
    obs.observe(el, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [root])
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
          {u.body != null ? <Markdown body={u.body} format={u.bodyFormat} media={u.media} className="cmt-md" native={u.source == null} /> : <p className="cmt-stub">{u.deleted ? 'Deleted.' : 'Hidden by moderation.'}</p>}
        </article>
      ))}
      {canPost && (open
        ? <ForumComposer mode={{ kind: 'update', postId }} draftKey={`update:${postId}`} autoFocus label="Post an update" placeholder="What has happened since — milestones, changes, answers to questions" onCancel={() => setOpen(false)} onDone={() => setOpen(false)} />
        : <button type="button" className="gov-btn" onClick={() => setOpen(true)}>Post an update</button>)}
    </div>
  )
}

/** A clamped body that would hide less than this (about two lines) is shown whole instead. */
const CLAMP_SLACK_PX = 48

/**
 * `clamp`: a long body shows its opening under a fade (the height is in the CSS), and
 * the faded text itself is the control — a tap or click anywhere on it shows the rest.
 * A click that follows a link, presses a control in the text or ends a text selection
 * is left alone, so reading and copying work as on any page; a mouse sees the hint
 * on hover, a keyboard reaches the same expand through the fade's own button. Whether
 * the text overflows is measured, not guessed from its length, and re-measured as
 * images load or the width changes.
 */
function useBodyClamp(enabled: boolean) {
  const box = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState<boolean | null>(null)
  const active = enabled && !expanded
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('.gov-post-md')
    if (!active || !el) return
    const measure = () => setOverflows(el.scrollHeight - el.clientHeight > CLAMP_SLACK_PX)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [active])
  const clamped = active && overflows !== false
  const expand = () => {
    setExpanded(true)
    // The fade's button goes with the fold: keep the keyboard where the text continues.
    box.current?.focus({ preventScroll: true })
  }
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!clamped) return
    const t = e.target as HTMLElement
    if (t.closest('a, button, summary, input, textarea, select, label, [role="button"]')) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && box.current?.contains(sel.anchorNode)) return
    expand()
  }
  return { box, clamped, expand, onClick }
}

/**
 * `plain`: no card, the author and date in one meta line above the text (a
 * referendum's description, under its section heading). `title`: drop the text's
 * opening heading when it only repeats this title. `clamp`: see useBodyClamp.
 */
export function ForumPostBody({ post, showAuthor = true, plain = false, clamp = false, title }: { post: ForumPostDetail; showAuthor?: boolean; plain?: boolean; clamp?: boolean; title?: string | null }) {
  const session = useSession()
  const me = useForumMe()
  const perms = usePostPermissions(post.postId)
  const [revisionsOpen, setRevisionsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useLongBodyControls(root)
  const fold = useBodyClamp(clamp)
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
    <div ref={root} className={`gov-post${plain ? ' plain' : ''}`}>
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
          <div ref={fold.box} tabIndex={-1} className={`gov-post-fold${fold.clamped ? ' clamped' : ''}`} onClick={fold.onClick}>
            <Markdown body={body} format={post.bodyFormat} media={post.media} className="gov-post-md" native={post.source == null} />
            {fold.clamped && (
              <button type="button" className="gov-post-fold-more" aria-expanded={false} onClick={fold.expand}>
                <span className="sr-only">Show the full text</span>
                <svg aria-hidden viewBox="0 0 16 16" width="16" height="16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
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
