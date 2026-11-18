import { useId, useState } from 'react'
import { MarkdownEditor } from '../../markdown/MarkdownEditor'
import { clearDraft, scopedDraftKey } from '../../markdown/drafts'
import { forumApi } from '../../api/explorer'
import { useSession } from '../../session'
import { actionGate, errorText, useAfterForumWrite, useForumMe } from '../../forumSession'
import { navigate, paths } from '../../router'
import type { ForumPostDetail } from '../../governanceTypes'
import { AddrPill } from '../ui'
import { ForumSignIn, GateNote } from './ForumComposer'
import './forum.css'

// Writing a whole post: a new discussion (title, topics, text), or editing one — a
// discussion by its author, an OpenGov referendum's description by its proposer's
// authority (title, a one-line summary, text). Every save is a new version readers
// can open from "edited".

export type PostEditorMode =
  | { kind: 'new' }
  | { kind: 'edit'; post: ForumPostDetail }
  /** A referendum with no description yet: its proposer writes the first one. */
  | { kind: 'describe'; postId: string }

const TITLE_MAX = 160
const TLDR_MAX = 300

export function PostEditor({ mode, onDone, onCancel }: { mode: PostEditorMode; onDone?: () => void; onCancel?: () => void }) {
  const session = useSession()
  const me = useForumMe()
  const after = useAfterForumWrite()
  const ids = useId()
  const post = mode.kind === 'edit' ? mode.post : null
  const isDiscussion = mode.kind === 'new' || post?.kind === 'discussion'
  const [title, setTitle] = useState(post?.title ?? '')
  const [tldr, setTldr] = useState(post?.tldr ?? '')
  const [labels, setLabels] = useState<string[]>(post?.labels ?? [])
  const [body, setBody] = useState(post?.body ?? '')
  const [uploading, setUploading] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftKey = mode.kind === 'new' ? 'discussion:new' : null

  const [askSignIn, setAskSignIn] = useState(false)

  const gate = actionGate(mode.kind === 'new' ? 'post' : 'comment', me.data, !!session)
  const upload = actionGate('upload', me.data, !!session)
  // A new discussion can be written signed out (the text is kept as a draft in this
  // browser); signing in is asked for at Publish. Editing needs the session first.
  const drafting = mode.kind === 'new' && !session
  if (!session && !drafting) return <div className="fc-box fc-box-quiet"><ForumSignIn action="edit" /></div>
  const gated = !gate.ok && !!me.data && !!session
  if (gated && mode.kind !== 'new') return <GateNote me={me.data!} reason={gate.reason} title="You cannot edit right now." />

  const max = me.data?.limits.postBodyChars ?? 50_000
  const topics = [...new Set([...(me.data?.topics ?? []), ...(post?.labels ?? [])])]
  const titleMissing = isDiscussion && !title.trim()
  const unchanged = post != null && title === post.title && body === post.body && tldr === post.tldr && labels.join('|') === post.labels.join('|')
  const blocked = busy || gated || uploading > 0 || titleMissing || !body.trim() || body.length > max || title.length > TITLE_MAX || tldr.length > TLDR_MAX || unchanged
  const hint = uploading > 0 ? 'Waiting for the image upload to finish'
    : titleMissing ? 'Give it a title' : !body.trim() ? 'Write the text' : body.length > max ? `Shorten the text to ${max.toLocaleString('en-US')} characters` : unchanged ? 'Nothing changed yet' : ''

  const toggleLabel = (l: string) => setLabels(cur => (cur.includes(l) ? cur.filter(x => x !== l) : cur.length >= 3 ? cur : [...cur, l]))

  const submit = async () => {
    if (blocked) return
    if (drafting) { setAskSignIn(true); return }
    setBusy(true); setError(null)
    try {
      if (mode.kind === 'new') {
        const r = await forumApi.createDiscussion({ title, body, labels })
        clearDraft(scopedDraftKey('discussion:new'))
        clearDraft(scopedDraftKey('discussion:new', null))
        after(r.generation)
        navigate(paths.discussion(r.post.postId))
      } else {
        const postId = mode.kind === 'edit' ? mode.post.postId : mode.postId
        const r = await forumApi.editPost(postId, isDiscussion ? { title, body, labels } : { ...(title.trim() ? { title } : {}), body, tldr })
        after(r.generation)
        onDone?.()
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="pe" onSubmit={e => { e.preventDefault(); void submit() }} aria-label={mode.kind === 'new' ? 'New discussion' : 'Edit'}>
      {gated && <GateNote me={me.data!} reason={gate.reason} title="You cannot start a discussion yet." />}
      <label className="pe-field" htmlFor={`${ids}-title`}>
        <span className="pe-label">Title{!isDiscussion && <span className="muted"> (optional — the referendum’s own name is used without one)</span>}</span>
        <input id={`${ids}-title`} className="pe-input" value={title} maxLength={TITLE_MAX + 20} onChange={e => setTitle(e.target.value)}
          placeholder={isDiscussion ? 'What should people discuss?' : 'What this referendum does, in a few words'} autoFocus={mode.kind === 'new'} />
        <span className={`pe-count${title.length > TITLE_MAX ? ' over' : ''}`} aria-live="polite">{title.length} / {TITLE_MAX}</span>
      </label>

      {isDiscussion ? (
        <fieldset className="pe-field">
          <legend className="pe-label">Topics <span className="muted">(up to 3, optional)</span></legend>
          <div className="activity-chips" role="group">
            {topics.map(t => (
              <button key={t} type="button" aria-pressed={labels.includes(t)} className={`activity-chip${labels.includes(t) ? ' on' : ''}`} onClick={() => toggleLabel(t)} disabled={!labels.includes(t) && labels.length >= 3}>{t}</button>
            ))}
          </div>
        </fieldset>
      ) : (
        <label className="pe-field" htmlFor={`${ids}-tldr`}>
          <span className="pe-label">In short <span className="muted">(optional, one sentence shown above the text)</span></span>
          <input id={`${ids}-tldr`} className="pe-input" value={tldr} maxLength={TLDR_MAX + 20} onChange={e => setTldr(e.target.value)} placeholder="Pays 300k USDC for the next audit round" />
          <span className={`pe-count${tldr.length > TLDR_MAX ? ' over' : ''}`}>{tldr.length} / {TLDR_MAX}</span>
        </label>
      )}

      <MarkdownEditor
        value={body}
        onChange={setBody}
        maxChars={max}
        label={isDiscussion ? 'Discussion text' : 'Description'}
        placeholder={isDiscussion ? 'Explain the idea: what, why, and what you would like people to weigh in on.' : 'What the referendum does, why, and what it costs.'}
        minRows={10}
        draftKey={draftKey}
        onSubmit={() => void submit()}
        canUpload={upload.ok}
        uploadBlockedReason={upload.reason}
        onBusyChange={setUploading}
        footer={
          <div className="fc-foot">
            {me.data && <span className="fc-as">Posting as <AddrPill account={me.data.account} noCopy /></span>}
            <span className="fc-foot-actions">
              {onCancel && <button type="button" className="gov-btn" onClick={onCancel} disabled={busy}>Cancel</button>}
              <button type="submit" className="gov-btn gov-btn-primary" disabled={blocked} title={hint || undefined}>
                {busy ? (mode.kind === 'new' ? 'Publishing…' : 'Saving…') : drafting ? 'Sign in to publish' : mode.kind === 'new' ? 'Publish discussion' : 'Save changes'}
              </button>
            </span>
          </div>
        }
      />
      {hint && !busy && <p className="pe-hint" aria-live="polite">{hint}.</p>}
      {drafting && (askSignIn
        ? <div className="fc-box fc-box-quiet pe-signin"><ForumSignIn action="publish this discussion" /></div>
        : !hint && <p className="pe-hint">You are not signed in: your text is kept in this browser, and Publish asks you to sign in.</p>)}
      {error && <p className="fc-error" role="alert">{error}</p>}
    </form>
  )
}
