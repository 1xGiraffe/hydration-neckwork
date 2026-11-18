import { useState } from 'react'
import { MarkdownEditor } from '../../markdown/MarkdownEditor'
import { clearDraft, loadDraft, scopedDraftKey } from '../../markdown/drafts'
import { forumApi } from '../../api/explorer'
import { useSession } from '../../session'
import { useChainWallets } from '../../chainWallet'
import { requestConnect } from '../../connectDialog'
import { actionGate, errorText, signInWithChainAccount, signableAccounts, useAfterForumWrite, useForumMe } from '../../forumSession'
import { AddrPill } from '../ui'
import type { ForumComment, ForumMe } from '../../governanceTypes'

// The forum's writing box, in every state a reader can be in: signed out (one
// signature signs them in — no transaction, no fee), signed in but not yet allowed
// (the gate says why, in words they can act on), or writing. Comments, replies,
// edits and a proposer's Updates all go through here; the editor itself is
// markdown/MarkdownEditor.tsx (its preview is the forum's one renderer).
// A thread's own comment box can start as one line ("Write a comment…") that opens
// into the sign-in prompt or the editor when clicked; a saved draft opens it at once,
// and a reader who cannot write yet still sees why up front.

/** "Sign in to comment": one click per wallet already connected here, or the login dialog for any other. */
export function ForumSignIn({ action }: { action: string }) {
  const { accounts } = useChainWallets()
  const signable = signableAccounts(accounts)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const go = async (id: string) => {
    const account = signable.find(a => a.id === id)
    if (!account) return
    setBusy(id); setError(null)
    try { await signInWithChainAccount(account) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  return (
    <div className="fc-signin" role="group" aria-label={`Sign in to ${action}`}>
      <p className="fc-signin-lead"><strong>Sign in to {action}.</strong> Your wallet signs a short message that names this site — no transaction, no fee.</p>
      <div className="fc-signin-actions">
        {signable.slice(0, 4).map(a => (
          <button key={a.id} type="button" className="gov-btn gov-btn-primary" disabled={!!busy} onClick={() => void go(a.id)}>
            {busy === a.id ? 'Check your wallet…' : <>Sign in as {a.name || `${a.address.slice(0, 6)}…${a.address.slice(-4)}`} <span className="muted">· {a.walletName}</span></>}
          </button>
        ))}
        <button type="button" className={`gov-btn${signable.length ? '' : ' gov-btn-primary'}`} disabled={!!busy} onClick={() => requestConnect()}>
          {signable.length ? 'Use another wallet' : 'Sign in with a wallet'}
        </button>
      </div>
      {error && <p className="fc-error" role="alert">{error}</p>}
    </div>
  )
}

/** Signed in but not (yet) allowed to write: why, what the account holds, and the next step. */
export function GateNote({ me, reason, title = 'You can read, but not write here yet.' }: { me: ForumMe; reason: string | null; title?: string }) {
  return (
    <div className="fc-box fc-box-quiet fc-gate" role="note">
      <p><strong>{title}</strong> {reason ?? me.gate?.detail}</p>
      <p className="muted">Signed in as <AddrPill account={me.account} noCopy /></p>
    </div>
  )
}

export type ComposerMode =
  | { kind: 'comment'; threadKey: string }
  | { kind: 'reply'; threadKey: string; parentId: string }
  | { kind: 'edit-comment'; commentId: string }
  | { kind: 'update'; postId: string }

const SUBMIT: Record<ComposerMode['kind'], [string, string]> = {
  comment: ['Comment', 'Posting…'],
  reply: ['Reply', 'Posting…'],
  'edit-comment': ['Save changes', 'Saving…'],
  update: ['Post update', 'Posting…'],
}

export function ForumComposer({ mode, initialBody = '', draftKey, autoFocus, onDone, onCancel, placeholder, label, collapsible }: {
  mode: ComposerMode
  initialBody?: string
  /** Autosave key for this box (null: no draft, e.g. an edit). */
  draftKey: string | null
  autoFocus?: boolean
  onDone(comment: ForumComment): void
  onCancel?(): void
  placeholder?: string
  label: string
  /** Start as a one-line "Write a comment…" box (a thread's top-level composer). */
  collapsible?: boolean
}) {
  const session = useSession()
  const me = useForumMe()
  const after = useAfterForumWrite()
  const [body, setBody] = useState(initialBody)
  const [uploading, setUploading] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(() => !collapsible || !!(draftKey && loadDraft(scopedDraftKey(draftKey))?.text.trim()))
  const [opened, setOpened] = useState(false)
  const limits = me.data?.limits
  const max = mode.kind === 'update' ? 10_000 : limits?.commentBodyChars ?? 10_000

  const gate = actionGate('comment', me.data, !!session)
  const upload = actionGate('upload', me.data, !!session)

  if (session && !gate.ok && me.data) return <GateNote me={me.data} reason={gate.reason} />
  if (!open) {
    return (
      <button type="button" className="fc-collapsed" aria-expanded={false} onClick={() => { setOpen(true); setOpened(true) }}>
        {label}…
      </button>
    )
  }
  if (!session) return <div className="fc-box fc-box-quiet"><ForumSignIn action={mode.kind === 'update' ? 'post an update' : 'comment'} /></div>

  const empty = body.trim().length === 0
  const over = body.length > max
  const blocked = busy || uploading > 0 || empty || over || (mode.kind === 'edit-comment' && body === initialBody)
  const why = uploading > 0 ? 'Waiting for the image upload to finish' : over ? `Shorten it to ${max.toLocaleString('en-US')} characters` : ''
  const [idle, working] = SUBMIT[mode.kind]

  const submit = async () => {
    if (blocked) return
    setBusy(true); setError(null)
    try {
      const res = mode.kind === 'comment' ? await forumApi.createComment({ threadKey: mode.threadKey, body })
        : mode.kind === 'reply' ? await forumApi.createComment({ threadKey: mode.threadKey, parentId: mode.parentId, body })
          : mode.kind === 'edit-comment' ? await forumApi.editComment(mode.commentId, body)
            : await forumApi.addUpdate(mode.postId, body)
      if (draftKey) clearDraft(scopedDraftKey(draftKey))
      setBody('')
      after(res.generation)
      onDone(res.comment)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fc-box">
      <MarkdownEditor
        value={body}
        onChange={setBody}
        maxChars={max}
        label={label}
        placeholder={placeholder}
        minRows={mode.kind === 'reply' || mode.kind === 'edit-comment' ? 3 : 4}
        draftKey={draftKey}
        onSubmit={() => void submit()}
        autoFocus={autoFocus || opened}
        canUpload={upload.ok}
        uploadBlockedReason={upload.reason}
        onBusyChange={setUploading}
        footer={
          <div className="fc-foot">
            {me.data && <span className="fc-as">Posting as <AddrPill account={me.data.account} noCopy /></span>}
            <span className="fc-foot-actions">
              {onCancel
                ? <button type="button" className="gov-btn" onClick={onCancel} disabled={busy}>Cancel</button>
                : collapsible && empty && <button type="button" className="gov-btn" onClick={() => { setOpen(false); setOpened(false) }}>Cancel</button>}
              <button type="button" className="gov-btn gov-btn-primary" onClick={() => void submit()} disabled={blocked} title={why || undefined}>
                {busy ? working : idle}
              </button>
            </span>
          </div>
        }
      />
      {error && <p className="fc-error" role="alert">{error}</p>}
    </div>
  )
}
