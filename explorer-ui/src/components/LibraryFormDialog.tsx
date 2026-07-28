import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

export interface LibraryFormValues { name: string; note: string; visibility: 'private' | 'public' }

// Two-segment switch with a sliding indicator — same mechanics as preis-ui's
// interval selector (an absolutely-positioned pill translated by segment
// index; the global prefers-reduced-motion block zeroes the transition).
function VisibilitySwitch({ value, onChange, disabled }: {
  value: 'private' | 'public'
  onChange: (v: 'private' | 'public') => void
  disabled?: boolean
}) {
  const OPTIONS = ['private', 'public'] as const
  return (
    <div className="seg-switch" role="group" aria-label="Visibility" style={{ '--active-index': OPTIONS.indexOf(value) } as React.CSSProperties}>
      <span className="seg-indicator" aria-hidden="true" />
      {OPTIONS.map(v => (
        <button key={v} type="button" aria-pressed={v === value} className={v === value ? 'active' : ''} disabled={disabled} onClick={() => onChange(v)}>
          {v === 'private' ? 'Private' : 'Public'}
        </button>
      ))}
    </div>
  )
}

// Shared name/note/visibility form for creating a library (Libraries.tsx) and
// editing one (LibraryDetail.tsx) — same fields, same validation, same submit
// chrome; only the title/hint/initial values and what happens on submit
// differ, so both pages lazy-import this one file instead of drifting apart.
export function LibraryFormDialog({ open, onOpenChange, title, hint, initial, submitLabel, pending, onSubmit }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  hint: string
  initial?: LibraryFormValues
  submitLabel: string
  pending: boolean
  onSubmit: (values: LibraryFormValues) => Promise<void>
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [visibility, setVisibility] = useState<'private' | 'public'>(initial?.visibility ?? 'private')
  const [error, setError] = useState<string | null>(null)

  // Reset to the caller's current values every time the dialog opens
  // (prop-change-reset, same pattern as ConnectDialog/EditProfileDialog) so a
  // previous attempt's error never leaks into the next one and an edit picks
  // up whatever is current when reopened.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(initial?.name ?? ''); setNote(initial?.note ?? ''); setVisibility(initial?.visibility ?? 'private'); setError(null)
    }
  }

  async function submit() {
    setError(null)
    try { await onSubmit({ name: name.trim(), note: note.trim(), visibility }) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the library') }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">{hint}</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}

            <div className="field">
              <label htmlFor="library-name-input">Name</label>
              <input id="library-name-input" value={name} maxLength={64} onChange={e => setName(e.target.value)} disabled={pending} />
            </div>
            <div className="field">
              <label htmlFor="library-note-input">Note</label>
              <input id="library-note-input" value={note} maxLength={280} placeholder="Optional" onChange={e => setNote(e.target.value)} disabled={pending} />
            </div>
            <div className="field">
              <label id="library-visibility-label">Visibility</label>
              <VisibilitySwitch value={visibility} onChange={setVisibility} disabled={pending} />
              <div className="muted" style={{ fontSize: 11 }}>
                {visibility === 'public' ? 'Listed in Discover — anyone can subscribe.' : 'Only you (and anyone you invite) can see this library.'}
              </div>
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={pending || !name.trim()}>{submitLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
