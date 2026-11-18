import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Markdown } from '../../markdown/Markdown'
import { useForumThread, waitingForSnapshot } from '../../hooks/useGovernance'
import { useNow } from '../../hooks/useNow'
import { forumApi } from '../../api/explorer'
import { useSession } from '../../session'
import { requestConnect } from '../../connectDialog'
import { errorText, threadIsWritable, useActionGate, useAfterForumWrite, useForumMe } from '../../forumSession'
import type { ForumComment, ThreadFilter, ThreadSort } from '../../governanceTypes'
import { ForumAuthorName, NotReady, PositionBadge, humanDate, relativeTime } from './GovUi'
import { ForumComposer } from './ForumComposer'
import { FollowThread } from './FollowThread'
import { ModerateButtons, ReportButton, RevisionList } from './ForumActions'
import './forum.css'

// A forum thread: top-level comments with their replies (two levels, as Subsquare
// has), keyset-paged with "Show more", sortable, and — on a referendum's thread —
// each commenter's own vote on it ("Aye 4× · 53 HDX") with a "voters only" filter. A
// hidden or deleted comment keeps its place as a stub so replies still read in
// context. Every comment has a permalink (#c-<id>).
//
// Read lightly by default: a long comment shows its first eight lines, a thread its
// first two replies, and a referendum page its first three threads, each with a
// "Show more" for the rest; a permalink opens whatever it points into.
//
// Comments written here and comments mirrored from Subsquare (every ten minutes)
// share one thread in time order, shown alike: the page names no source.
// Writing: a composer at the top, Reply under any comment (a reply to a reply files
// under its top-level comment and names whom it answers), and on your own comments
// Edit and Delete; reports, and for moderators Hide/Restore.

const SORTS: { key: ThreadSort; label: string }[] = [
  { key: 'old', label: 'Oldest' },
  { key: 'new', label: 'Newest' },
]

/** A comment taller than this (about eight lines) shows its first eight lines until the reader asks for the rest. */
const CLAMP_PX = 186
/** …unless the rest is only a line or two, which reads better shown than folded. */
const CLAMP_SLACK_PX = 64

/** A comment's text, clamped to its first lines when it is long. */
function ClampedBody({ c }: { c: ForumComment }) {
  const ref = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const [expanded, setExpanded] = useState(() => window.location.hash === `#c-${c.commentId}`)
  useEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    // The text renders (and its images load) after this mounts, so it is measured
    // whenever it resizes; scrollHeight is its full height, clamped or not.
    const check = () => setOver(el.scrollHeight > CLAMP_PX + CLAMP_SLACK_PX)
    check()
    const ro = new ResizeObserver(check)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [expanded, c.body])
  return (
    <>
      <div ref={ref} className={`cmt-body${over && !expanded ? ' clamped' : ''}`}><CommentBody c={c} /></div>
      {(over || expanded) && (
        <button type="button" className="gov-more cmt-more" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>{expanded ? 'Show less' : 'Show more'}</button>
      )}
    </>
  )
}

function CommentBody({ c }: { c: ForumComment }) {
  if (c.deleted) return <p className="cmt-stub">Deleted by its author.</p>
  if (c.hiddenReason === 'purged') return <p className="cmt-stub">Removed by moderators.</p>
  if (c.hidden || c.body == null) return <p className="cmt-stub">Hidden by moderation{c.hiddenReason === 'imported-hidden' ? ' (hidden where it was first written)' : c.hiddenReason === 'reported' ? ' after several reports — a moderator will review it' : ''}.</p>
  return <Markdown body={c.body} format={c.bodyFormat} media={c.media} className="cmt-md" native={c.source == null} />
}

/** ▲ n — a toggle when signed in (drawn filled when it is yours), a sign-in prompt when not. */
/** Who wrote a comment, in words, for the names of its controls ("Reply to Alice"). */
function authorWords(a: ForumComment['author']): string {
  const acct = a?.account
  const named = acct?.profile?.name || acct?.identity?.display || acct?.displayName || a?.legacyName
  return named || (acct ? `${acct.address.slice(0, 6)}…${acct.address.slice(-4)}` : 'an unknown author')
}

function DeleteComment({ c, onDone }: { c: ForumComment; onDone: () => void }) {
  const after = useAfterForumWrite()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!confirm) return <button type="button" className="fa-link" onClick={() => setConfirm(true)}>Delete</button>
  return (
    <span className="fa-confirm" role="group" aria-label="Confirm delete">
      <span>Delete this comment and every earlier version of it?</span>
      <button type="button" className="fa-link fa-danger" disabled={busy} onClick={async () => {
        setBusy(true); setError(null)
        try { const r = await forumApi.deleteComment(c.commentId); after(r.generation); onDone() } catch (e) { setError(errorText(e)); setBusy(false) }
      }}>{busy ? 'Deleting…' : 'Yes, delete'}</button>
      <button type="button" className="fa-link" disabled={busy} onClick={() => setConfirm(false)}>Keep it</button>
      {error && <span className="fa-error" role="alert">{error}</span>}
    </span>
  )
}

interface CommentCtx {
  now: number
  decimals: number
  threadKey: string
  writable: boolean
  locked: boolean
  moderator: boolean
  replyingTo: string | null
  setReplyingTo: (id: string | null) => void
}

function Comment({ c, ctx, reply }: { c: ForumComment; ctx: CommentCtx; reply?: boolean }) {
  const session = useSession()
  const [editing, setEditing] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const anchor = `c-${c.commentId}`
  const shown = !(c.hidden || c.deleted)
  const own = !!session && !!c.author?.account && c.author.account.accountId === session.accountId
  const canReply = ctx.writable && !ctx.locked && shown
  const replyGate = useActionGate('comment')
  // A reply to a reply files under the top-level comment; the composer opens under the one you clicked.
  const replyOpen = ctx.replyingTo === c.commentId
  // Two replies, then "Show N more" — unless a permalink points at one of the rest.
  const [allReplies, setAllReplies] = useState(() => c.replies.slice(REPLIES_SHOWN).some(r => window.location.hash === `#c-${r.commentId}`))
  const replies = allReplies ? c.replies : c.replies.slice(0, REPLIES_SHOWN)
  const moreReplies = c.replies.length - replies.length
  return (
    <article id={anchor} className={`cmt${reply ? ' cmt-reply' : ''}${shown ? '' : ' cmt-hidden'}`} aria-label={`Comment from ${humanDate(c.createdAt)}`}>
      <header className="cmt-head">
        {shown && <ForumAuthorName author={c.author} />}
        {c.position && <PositionBadge position={c.position} decimals={ctx.decimals} />}
        <a href={`#${anchor}`} className="cmt-time" title={`${humanDate(c.createdAt)} — link to this comment`}>{Date.parse(c.createdAt) > ctx.now - 60_000 ? 'just now' : relativeTime(c.createdAt, ctx.now)}</a>
        {/* Earlier versions open only when there are some on record; an edit made where the
            comment was first written left none, so it is only said. */}
        {c.editedAt && shown && (c.revision > 0
          ? <button type="button" className="cmt-edited fa-link" aria-expanded={historyOpen} onClick={() => setHistoryOpen(o => !o)} title={`Edited ${humanDate(c.editedAt)} — show earlier versions`}>edited</button>
          : <span className="cmt-edited muted" title={`Edited ${humanDate(c.editedAt)}`}>edited {humanDate(c.editedAt, false)}</span>)}
      </header>
      {editing ? (
        <ForumComposer
          mode={{ kind: 'edit-comment', commentId: c.commentId }}
          initialBody={c.body ?? ''}
          draftKey={null}
          autoFocus
          label="Edit your comment"
          onCancel={() => setEditing(false)}
          onDone={() => setEditing(false)}
        />
      ) : <ClampedBody c={c} />}
      {historyOpen && <div className="gov-post-panel"><RevisionList targetId={c.commentId} format={c.bodyFormat} media={c.media} /></div>}
      {shown && !editing && (
        <footer className="cmt-actions">
          {canReply && (
            <button
              type="button" className="fa-link" aria-expanded={replyOpen} aria-label={`Reply to ${authorWords(c.author)}`}
              disabled={!!session && !replyGate.ok} title={session && !replyGate.ok ? replyGate.reason ?? undefined : undefined}
              onClick={() => (session ? ctx.setReplyingTo(replyOpen ? null : c.commentId) : requestConnect())}
            >Reply</button>
          )}
          {own && <button type="button" className="fa-link" onClick={() => setEditing(true)}>Edit</button>}
          {own && <DeleteComment c={c} onDone={() => undefined} />}
          {!own && session && <ReportButton targetId={c.commentId} what="comment" />}
          {ctx.moderator && <ModerateButtons targetId={c.commentId} hidden={c.hidden} />}
        </footer>
      )}
      {!shown && ctx.moderator && !c.deleted && <footer className="cmt-actions"><ModerateButtons targetId={c.commentId} hidden={c.hidden} /></footer>}
      {replyOpen && (
        <div className="cmt-reply-box">
          <ForumComposer
            mode={{ kind: 'reply', threadKey: ctx.threadKey, parentId: c.commentId }}
            draftKey={`reply:${ctx.threadKey}:${c.commentId}`}
            autoFocus
            label={`Reply to this comment`}
            placeholder="Write a reply"
            onCancel={() => ctx.setReplyingTo(null)}
            onDone={() => ctx.setReplyingTo(null)}
          />
        </div>
      )}
      {c.replies.length > 0 && (
        <div className="cmt-replies">
          {replies.map(r => <Comment key={r.commentId} c={r} ctx={ctx} reply />)}
          {moreReplies > 0 && (
            <button type="button" className="gov-more" onClick={() => setAllReplies(true)}>Show {moreReplies} more {moreReplies === 1 ? 'reply' : 'replies'}</button>
          )}
        </div>
      )}
    </article>
  )
}

const COLLAPSED_THREADS = 3
const REPLIES_SHOWN = 2

/**
 * "Oldest ▾": the thread's order, and on a referendum the "voters only" filter, in
 * one small popover (closes on a choice, Escape, or a click elsewhere).
 */
function SortMenu({ sort, onSort, filter, onFilter, voters }: {
  sort: ThreadSort; onSort: (s: ThreadSort) => void
  filter: ThreadFilter; onFilter: (f: ThreadFilter) => void
  voters: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus() } }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const label = `${SORTS.find(x => x.key === sort)?.label ?? 'Oldest'}${filter === 'voters' ? ' · voters only' : ''}`
  return (
    <div ref={ref} className="cmt-menu" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button ref={btn} type="button" className="cmt-menu-btn" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`Order of comments: ${label}`} onClick={() => setOpen(o => !o)}>
        {label}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div id={id} className="cmt-menu-pop" role="group" aria-label="Order and filter comments">
          {SORTS.map(x => (
            <button key={x.key} type="button" className="cmt-menu-item" aria-pressed={sort === x.key} onClick={() => { onSort(x.key); setOpen(false); btn.current?.focus() }}>{x.label}</button>
          ))}
          {voters && (
            <label className="cmt-menu-check">
              <input type="checkbox" checked={filter === 'voters'} onChange={e => onFilter(e.target.checked ? 'voters' : null)} />
              Voters only
            </label>
          )}
        </div>
      )}
    </div>
  )
}

export function CommentThread({ threadKey, onReferendum, decimals = 12, title, collapse, heading, intro }: {
  threadKey: string
  /** A referendum's thread: show the commenters' votes and offer "voters only". */
  onReferendum?: boolean
  decimals?: number
  /** What the thread is about, for the Follow button's alert name. */
  title?: string
  /** Show the first few threads and a "Show all" button (a referendum page, where the thread sits mid-page). */
  collapse?: boolean
  /** The section's heading, set in the thread's header row beside its order menu and Follow bell. */
  heading?: ReactNode
  /** A note under the header row (where the comments come from, say). */
  intro?: ReactNode
}) {
  const now = useNow(30_000)
  const session = useSession()
  const me = useForumMe()
  const [sort, setSort] = useState<ThreadSort>('old')
  const [filter, setFilter] = useState<ThreadFilter>(null)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [posted, setPosted] = useState<ForumComment[]>([])
  // A comment permalink opened cold shows the whole thread, so its target is there to scroll to.
  const [collapsed, setCollapsed] = useState(() => !!collapse && !window.location.hash.startsWith('#c-'))
  const q = useForumThread(threadKey, sort, filter)
  const pages = q.data?.pages ?? []
  const rows = pages.flatMap(p => p.rows)
  const first = pages[0]
  const total = first?.total ?? 0
  const writable = threadIsWritable(threadKey)
  const locked = !!first?.locked

  const ids = useMemo(() => {
    const out: string[] = []
    const walk = (list: ForumComment[]) => { for (const c of list) { out.push(c.commentId); walk(c.replies) } }
    walk(rows)
    return out
  }, [rows])
  // What you just posted stays in view until the refetched thread carries it.
  const seen = new Set(ids)
  const pending = posted.filter(c => !seen.has(c.commentId))

  // A permalink (#c-<id>) opened cold: once the thread has rendered, bring it into view.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#c-') || !rows.length) return
    const el = document.getElementById(hash.slice(1))
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('cmt-target') }
  }, [rows.length])

  const ctx: CommentCtx = {
    now, decimals, threadKey, writable, locked, moderator: !!me.data?.moderator, replyingTo, setReplyingTo,
  }

  return (
    <section className="cmt-thread" aria-label="Comments">
      <div className="cmt-toolbar">
        {heading}
        <span className="cmt-toolbar-end">
          <SortMenu sort={sort} onSort={setSort} filter={filter} onFilter={setFilter} voters={!!onReferendum} />
          {first && writable && <FollowThread threadKey={first.threadKey} title={title ?? 'this discussion'} variant="icon" />}
        </span>
      </div>
      {intro}

      {!writable ? (
        <div className="cmt-compose-placeholder">
          The pre-OpenGov archive is read-only: its threads are kept as they were written.
        </div>
      ) : locked ? (
        <div className="cmt-compose-placeholder" role="note">A moderator locked this thread. It stays readable but takes no new comments.</div>
      ) : (
        <div className="cmt-compose">
          <ForumComposer
            mode={{ kind: 'comment', threadKey: first?.threadKey ?? threadKey }}
            draftKey={session ? `comment:${threadKey}` : null}
            collapsible
            label="Write a comment"
            placeholder={onReferendum ? 'Share what you think about this referendum' : 'Add to the discussion'}
            onDone={c => { setPosted(p => [...p, c]); if (sort !== 'old') setSort('new') }}
          />
        </div>
      )}

      {waitingForSnapshot(q) ? <NotReady what="forum" />
        : q.isError ? <div className="gov-empty">The comments could not be loaded. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></div>
          : q.isLoading ? <div className="cmt-skeleton" aria-busy="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
            : !rows.length && !pending.length ? <div className="gov-empty">{filter === 'voters' ? 'No one who voted on this has commented.' : writable && !locked ? 'No comments yet — be the first.' : 'No comments.'}</div>
              : (
                <div className={`cmt-list${q.isPlaceholderData ? ' rows-pending' : ''}`}>
                  {(collapsed ? rows.slice(0, COLLAPSED_THREADS) : rows).map(c => <Comment key={c.commentId} c={c} ctx={ctx} />)}
                  {!q.hasNextPage && pending.filter(c => !c.parentId).map(c => <Comment key={c.commentId} c={c} ctx={ctx} />)}
                </div>
              )}

      {onReferendum && first?.positionsComplete === false && (
        <p className="gov-fineprint">Vote badges cover this referendum’s largest voters only; a smaller voter’s comment shows none.</p>
      )}
      {collapsed && total > COLLAPSED_THREADS && (
        <button type="button" className="gov-more" onClick={() => setCollapsed(false)}>Show all {total} threads</button>
      )}
      {!collapsed && q.hasNextPage && (
        <button type="button" className="gov-more" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : `Show more (${total - rows.length} more ${total - rows.length === 1 ? 'thread' : 'threads'})`}
        </button>
      )}
    </section>
  )
}
