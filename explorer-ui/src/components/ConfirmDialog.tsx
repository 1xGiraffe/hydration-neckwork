import * as Dialog from '@radix-ui/react-dialog'

// The one confirm step in the app, for actions nothing can undo: deleting an
// alert, removing a push channel, unlinking Telegram, emptying the inbox.
//
// Modelled on ListDetail's delete-list dialog (same `.dialog` chrome, same
// Cancel/danger footer, same narrow width) and deliberately NOT window.confirm:
// a native prompt cannot name the subject in the app's own words, cannot show the
// server's error when the write fails, and cannot hold a pending state while it
// is in flight. Every copy that reaches here therefore names WHAT is being
// removed and says what stops as a result — a confirm that only asks "are you
// sure?" trains people to click through it.
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = 'Delete', danger = true, pending, error, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: React.ReactNode
  confirmLabel?: string
  /** false only for a confirm that removes nothing (none today). */
  danger?: boolean
  pending?: boolean
  error?: string | null
  onConfirm: () => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog confirm-dialog" style={{ width: 'min(420px, 94vw)' }}>
          <div className="dialog-head">
            <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">{body}</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</button>
            <button type="button" className={`btn${danger ? ' danger' : ' primary'}`} disabled={pending} onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
