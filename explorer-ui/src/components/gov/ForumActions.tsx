import { useState } from 'react'
import { Markdown } from '../../markdown/Markdown'
import { forumApi } from '../../api/explorer'
import { useForumRevisions } from '../../hooks/useGovernance'
import { errorText, useActionGate, useAfterForumWrite } from '../../forumSession'
import { humanDate } from './GovUi'

// Small per-item forum actions shared by posts and comments: the earlier versions of
// an edited item, reporting something to the moderators, and the moderators' own
// Hide / Restore (and Lock for a thread).

/** Every recorded version of a post or comment, newest first, each rendered by the one renderer. */
export function RevisionList({ targetId, format, media }: { targetId: string; format: string; media: Record<string, string> }) {
  const q = useForumRevisions(targetId, true)
  if (q.isLoading) return <div className="skeleton" style={{ height: 60 }} />
  const revs = q.data?.revisions ?? []
  if (!revs.length) return <p className="gov-fineprint">No earlier versions are on record (the earlier forum kept edit history only for wallet-signed posts).</p>
  return (
    <ol className="gov-revisions">
      {[...revs].reverse().map((r, i) => (
        <li key={r.revision}>
          <details open={i === 0 && revs.length === 1}>
            <summary>Version {r.revision + 1} · {humanDate(r.createdAt)}{r.source === 'subsquare' ? ' · before import' : r.source === 'native' ? ' · here' : ''}{i === 0 ? ' · current' : ''}</summary>
            {r.title && <div className="gov-revision-title">{r.title}</div>}
            <Markdown body={r.body} format={format} media={media} className="gov-revision-body" native={r.source === 'native'} />
          </details>
        </li>
      ))}
    </ol>
  )
}

const REPORT_REASONS: { key: string; label: string }[] = [
  { key: 'spam', label: 'Spam or advertising' },
  { key: 'abuse', label: 'Abuse or harassment' },
  { key: 'illegal', label: 'Illegal content' },
  { key: 'off-topic', label: 'Off-topic' },
  { key: 'duplicate', label: 'Duplicate' },
  { key: 'other', label: 'Something else' },
]

/** "Report" → a reason and an optional note for the moderators. Reports are private. */
export function ReportButton({ targetId, what }: { targetId: string; what: string }) {
  const gate = useActionGate('report')
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('spam')
  const [note, setNote] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  if (state === 'done') return <span className="fa-done" role="status">Reported — thank you. Moderators will look at it.</span>
  if (!open) return <button type="button" className="fa-link" disabled={!gate.ok} title={gate.ok ? undefined : gate.reason ?? undefined} onClick={() => setOpen(true)}>Report</button>
  return (
    <form className="fa-report" onSubmit={async e => {
      e.preventDefault()
      setState('busy'); setError(null)
      try { await forumApi.report({ targetId, reason, note: note.trim() || undefined }); setState('done') } catch (err) { setError(errorText(err)); setState('idle') }
    }}>
      <span className="fa-report-title">Report this {what} to the moderators</span>
      <label>
        <span className="sr-only">Reason</span>
        <select value={reason} onChange={e => setReason(e.target.value)}>
          {REPORT_REASONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </label>
      <label className="fa-report-note">
        <span className="sr-only">Note for the moderators (optional)</span>
        <input type="text" maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="Anything moderators should know (optional, private)" />
      </label>
      <span className="fa-report-actions">
        <button type="submit" className="gov-btn gov-btn-primary" disabled={state === 'busy'}>{state === 'busy' ? 'Sending…' : 'Send report'}</button>
        <button type="button" className="gov-btn" onClick={() => setOpen(false)} disabled={state === 'busy'}>Cancel</button>
      </span>
      {error && <span className="fa-error" role="alert">{error}</span>}
    </form>
  )
}

const MOD_REASONS = ['spam', 'abuse', 'illegal', 'off-topic', 'duplicate', 'author-request', 'other'] as const

/**
 * Moderators only: hide or restore an item (and lock or unlock a thread), with a public
 * reason code — and Purge, which erases the text and every version of it for good
 * (illegal content), behind an explicit confirm.
 */
export function ModerateButtons({ targetId, hidden, thread, locked }: { targetId: string; hidden: boolean; thread?: boolean; locked?: boolean }) {
  const after = useAfterForumWrite()
  const [reason, setReason] = useState<string>('spam')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [purging, setPurging] = useState(false)
  const act = async (action: string) => {
    setBusy(true); setError(null)
    const reasonCode = action === 'hide' ? reason : action === 'purge' ? (reason === 'spam' ? 'illegal' : reason) : 'other'
    try { const r = await forumApi.moderate({ targetId, action, reasonCode }); after(r.generation); setPurging(false) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <span className="fa-mod" role="group" aria-label="Moderation">
      {!hidden && (
        <select value={reason} onChange={e => setReason(e.target.value)} aria-label="Reason to hide" disabled={busy}>
          {MOD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      )}
      <button type="button" className="fa-link fa-danger" disabled={busy} onClick={() => void act(hidden ? 'restore' : 'hide')}>{hidden ? 'Restore' : 'Hide'}</button>
      {thread && <button type="button" className="fa-link" disabled={busy} onClick={() => void act(locked ? 'unlock-thread' : 'lock-thread')}>{locked ? 'Unlock thread' : 'Lock thread'}</button>}
      {!purging
        ? <button type="button" className="fa-link fa-danger" disabled={busy} onClick={() => setPurging(true)}>Purge</button>
        : (
          <span className="fa-confirm" role="group" aria-label="Confirm purge">
            <span>Purge erases this text and every earlier version for good, and removes images only it uses. It cannot be undone. The log will say it was purged ({reason === 'spam' ? 'illegal' : reason}).</span>
            <button type="button" className="fa-link fa-danger" disabled={busy} onClick={() => void act('purge')}>{busy ? 'Purging…' : 'Yes, purge for good'}</button>
            <button type="button" className="fa-link" disabled={busy} onClick={() => setPurging(false)}>Cancel</button>
          </span>
        )}
      {error && <span className="fa-error" role="alert">{error}</span>}
    </span>
  )
}
