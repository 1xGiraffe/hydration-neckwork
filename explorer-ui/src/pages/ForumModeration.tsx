import { useEffect, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { forumApi, govApi } from '../api/explorer'
import { useDocumentTitle, useNoindex } from '../hooks/useDocumentTitle'
import { useNow } from '../hooks/useNow'
import { useSession } from '../session'
import { errorText, useAfterForumWrite, useForumMe } from '../forumSession'
import { Link, paths } from '../router'
import { AddrPill, Crumbs, SkeletonRows } from '../components/ui'
import { Markdown } from '../markdown/Markdown'
import { ForumAuthorName, humanDate, relativeTime } from '../components/gov/GovUi'
import { ModerateButtons } from '../components/gov/ForumActions'
import { forumPostLabel, forumPostPath } from '../governanceSubjects'
import type { ModerationItem, ModerationLogRow } from '../governanceTypes'
import '../components/gov/forum.css'

// /governance/moderation: the forum's public moderation log — every hide, restore,
// lock, purge, image removal and author deletion, with its reason and who did it —
// for everyone, and, for moderators (ADMIN_ACCOUNT_IDS ∪ FORUM_MODERATOR_ACCOUNT_IDS
// on the api), the queue: open reports with the reported text and the last two days
// of new writing, each with Hide / Restore, report dismissal, and muting an account.
// Reports and mutes are private; only the actions are logged publicly.

const ACTION_WORDS: Record<string, string> = {
  hide: 'Hidden', restore: 'Restored', 'lock-thread': 'Thread locked', 'unlock-thread': 'Thread unlocked', 'media-remove': 'Image removed',
  delete: 'Deleted by its author', purge: 'Purged',
}

const isComment = (targetId: string) => /^c[0-9A-Z]{26}$|^s[0-9a-f]{24}$/.test(targetId)

// A comment's own id is no address: it links into its thread, and a comment whose
// thread is unknown is named without a link rather than sent to /discussions/<id>.
function targetLink(targetId: string, threadKey?: string): { to: string | null; label: string } {
  if (isComment(targetId)) {
    if (!threadKey) return { to: null, label: 'Comment' }
    const base = forumPostPath(threadKey)
    return { to: base ? `${base}#c-${targetId}` : null, label: `Comment in ${forumPostLabel(threadKey)}` }
  }
  const label = /^b[a-z2-7]{50,}$|^Qm/.test(targetId) ? `Image ${targetId.slice(0, 10)}…` : forumPostLabel(targetId)
  return { to: forumPostPath(targetId), label: label === 'Discussion' ? `Discussion ${targetId}` : label }
}

function LogRow({ r, now }: { r: ModerationLogRow; now: number }) {
  const t = targetLink(r.targetId, r.threadKey)
  return (
    <li className="mod-log-row">
      <strong>{ACTION_WORDS[r.action] ?? r.action}</strong>{' '}
      {t.to ? <Link to={t.to} className="hash">{t.label}</Link> : <span className="mono">{r.targetId.length > 24 ? `${r.targetId.slice(0, 22)}…` : r.targetId}</span>}
      {' '}<span className="muted">· {r.reasonCode} · </span>
      {'source' in r.moderator ? <span className="muted">{r.moderator.source === 'subsquare' ? 'before import' : 'by reader reports'}</span> : <>by <ForumAuthorName author={r.moderator} /></>}
      {' '}<span className="muted" title={humanDate(r.at)}>{relativeTime(r.at, now)}</span>
    </li>
  )
}

/** A hide made before the item reached this forum (imported with it, never a moderator's action here). */
const isImportedHide = (r: ModerationLogRow) => 'source' in r.moderator && r.moderator.source === 'subsquare' && r.action === 'hide'

type LogEntry = { kind: 'row'; row: ModerationLogRow } | { kind: 'imported'; rows: ModerationLogRow[] }

/** The log with each run of imported hides folded into one entry. */
function foldImported(rows: ModerationLogRow[]): LogEntry[] {
  const out: LogEntry[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (!isImportedHide(row)) out.push({ kind: 'row', row })
    else if (last?.kind === 'imported') last.rows.push(row)
    else out.push({ kind: 'imported', rows: [row] })
  }
  return out
}

function ImportedHides({ rows, now }: { rows: ModerationLogRow[]; now: number }) {
  const comments = rows.filter(r => isComment(r.targetId)).length
  const posts = rows.length - comments
  const spam = rows.filter(r => r.reasonCode === 'spam').length
  const what = [posts ? `${posts} ${posts === 1 ? 'discussion' : 'discussions'}` : null, comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : null].filter(Boolean).join(' and ')
  return (
    <li className="mod-log-row mod-log-imported">
      <details>
        <summary><strong>{what}</strong> hidden before import{spam ? <span className="muted"> · {spam} of them marked as spam</span> : null}</summary>
        <ul className="mod-log">{rows.map(r => <LogRow key={`${r.actionId}:${r.targetId}`} r={r} now={now} />)}</ul>
      </details>
    </li>
  )
}

function MuteForm({ account }: { account: string }) {
  const [days, setDays] = useState('7')
  const [reason, setReason] = useState('')
  const [state, setState] = useState<string | null>(null)
  return (
    <form className="mod-mute" onSubmit={async e => {
      e.preventDefault()
      const d = Number(days)
      try {
        await forumApi.mute({ account, until: d > 0 ? new Date(Date.now() + d * 86_400_000).toISOString() : null, reason })
        setState(d > 0 ? `Muted for ${d} days.` : 'Mute lifted.')
      } catch (err) { setState(errorText(err)) }
    }}>
      <span>Mute this author for</span>
      <input type="number" min={0} max={3650} value={days} onChange={e => setDays(e.target.value)} aria-label="Days (0 lifts a mute)" style={{ width: 70 }} />
      <span>days</span>
      <input type="text" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Private note" aria-label="Private note" />
      <button type="submit" className="gov-btn">Apply</button>
      {state && <span className="muted" role="status">{state}</span>}
    </form>
  )
}

function QueueItem({ item, now }: { item: ModerationItem; now: number }) {
  const after = useAfterForumWrite()
  const [done, setDone] = useState<string | null>(null)
  const t = targetLink(item.targetId, item.threadKey)
  return (
    <article className={`mod-item${item.hidden ? ' is-hidden' : ''}`}>
      <div className="mod-item-head">
        {item.author ? <AddrPill account={item.author} noCopy /> : <span className="muted">no author account</span>}
        {t.to ? <Link to={t.to} className="hash">{item.title ? `“${item.title.slice(0, 60)}”` : t.label}</Link> : <span>{t.label}</span>}
        <span className="muted" title={humanDate(item.createdAt)}>{relativeTime(item.createdAt, now)}</span>
        {item.hidden && <span className="gov-label">hidden · {item.hiddenReason || 'moderation'}</span>}
      </div>
      <div className="mod-item-body"><Markdown body={item.body} format={item.bodyFormat} className="cmt-md" /></div>
      {item.reports.length > 0 && (
        <ul className="mod-reports">
          {item.reports.map(r => (
            <li key={r.reportId}>
              <strong>{r.reason}</strong>{r.note && <> — “{r.note}”</>} <span className="muted">· {r.reporter ? <AddrPill account={r.reporter} noCopy /> : 'unknown'} · {relativeTime(r.at, now)}</span>{' '}
              <button type="button" className="fa-link" onClick={async () => { try { await forumApi.setReport(r.reportId, 'dismissed'); setDone('Report dismissed.'); after(null) } catch (e) { setDone(errorText(e)) } }}>Dismiss</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mod-actions">
        <ModerateButtons targetId={item.targetId} hidden={item.hidden} thread={item.kind === 'post'} />
        {done && <span className="muted" role="status">{done}</span>}
      </div>
      {item.author && <MuteForm account={item.author.accountId} />}
    </article>
  )
}

function Queue() {
  const now = useNow(60_000)
  const q = useQuery({ queryKey: ['forum-mod-queue'], queryFn: ({ signal }) => forumApi.queue(signal), refetchInterval: 60_000 })
  if (q.isLoading) return <div className="detail-card"><SkeletonRows rows={4} /></div>
  if (q.isError) return <p className="gov-empty">The queue could not be loaded: {errorText(q.error)}</p>
  const data = q.data!
  return (
    <>
      <section className="gov-section">
        <h2 className="gov-h2">Open reports</h2>
        {data.reported.length ? <div className="mod-queue">{data.reported.map(i => <QueueItem key={i.targetId} item={i} now={now} />)}</div>
          : <p className="gov-empty">No open reports.</p>}
      </section>
      <section className="gov-section">
        <h2 className="gov-h2">Written here in the last two days</h2>
        {data.recent.length ? <div className="mod-queue">{data.recent.map(i => <QueueItem key={i.targetId} item={i} now={now} />)}</div>
          : <p className="gov-empty">Nothing new.</p>}
      </section>
    </>
  )
}

export function ForumModeration() {
  useDocumentTitle('Forum moderation')
  useNoindex(true)
  const now = useNow(60_000)
  const session = useSession()
  const me = useForumMe()
  const log = useInfiniteQuery({
    queryKey: ['forum-moderation-log'],
    queryFn: ({ signal, pageParam }) => govApi.moderationLog(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
  })
  const rows = log.data?.pages.flatMap(p => p.rows) ?? []
  const entries = foldImported(rows)
  // A run of imported hides is one entry, so its count must be whole: while the
  // loaded log ends inside such a run, the next page is read too.
  const tailImported = rows.length > 0 && isImportedHide(rows[rows.length - 1])
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = log
  useEffect(() => {
    if (tailImported && hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [tailImported, hasNextPage, isFetchingNextPage, fetchNextPage])
  return (
    <div className="wrap gov-forum">
      <div className="page-head">
        <Crumbs items={[{ label: 'Home', to: paths.dashboard() }, { label: 'Governance', to: paths.governance() }, { label: 'Discussions', to: paths.discussions() }, { label: 'Moderation' }]} />
        <h1 className="page-title">Forum moderation<span className="sub">Every hide, restore, lock, purge, image removal and deletion, with its reason — reports and reporters stay private</span></h1>
      </div>
      {session && me.data?.moderator && <Queue />}
      <section className="gov-section">
        <h2 className="gov-h2">Moderation log</h2>
        {log.isLoading ? <div className="detail-card"><SkeletonRows rows={5} /></div>
          : !rows.length ? <p className="gov-empty">Nothing has been moderated.</p>
            : <ul className="mod-log">{entries.map((e, i) => e.kind === 'row' ? <LogRow key={`${e.row.actionId}:${e.row.targetId}`} r={e.row} now={now} /> : <ImportedHides key={`imported-${i}`} rows={e.rows} now={now} />)}</ul>}
        {log.hasNextPage && !tailImported && <button type="button" className="gov-more" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>{log.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
      </section>
    </div>
  )
}
