import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { userApi } from '../api/explorer'
import { useUserMutation } from '../hooks/useUser'
import { AccountEmoji } from './ui'
import type { ProfileRef } from '../types'

// Square-crop + resize any picked image down to a 128×128 avatar before it ever
// leaves the browser: webp first (smallest at equal quality), falling back to
// jpeg where `canvas.toBlob('image/webp', …)` returns null (Safari < 17). The
// server only checks magic bytes + the 64 KiB ceiling — it never decodes an
// image — so an oversized or unrecognized result has to be caught here, with a
// message the visitor can act on, rather than surfacing as an opaque 422.
// Returns the bare base64 (what the API stores) plus a data: URL of the SAME
// encoded bytes for the preview — a truthful preview, and one the production
// CSP allows (img-src permits data:, not blob:, so an object URL over the
// original file renders as a broken image behind nginx).
async function fileToAvatar(file: File): Promise<{ base64: string; dataUrl: string }> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128)
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', 0.8))
    ?? await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.85))
  if (!blob) throw new Error('Could not encode the image')
  if (blob.size > 64 * 1024) throw new Error('Image is too large after resize')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const base64 = btoa(bin)
  return { base64, dataUrl: `data:${blob.type};base64,${base64}` }
}

// Self-authored profile: a display name and an avatar the account owner sets
// after wallet login (Account.tsx opens this only on the viewer's own page and
// passes the page's own already-loaded profile, so the fields are prefilled
// even when the /user/me query is still cold). Both fields save independently.
export function EditProfileDialog({ open, onOpenChange, account, profile }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: { accountId: string; emoji?: string; emojiName?: string; emojiUrl?: string }
  profile: ProfileRef | null
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const nameMutation = useUserMutation(userApi.setProfileName)
  const avatarMutation = useUserMutation(userApi.setAvatar)
  const clearMutation = useUserMutation(userApi.clearAvatar)
  const busy = nameMutation.isPending || avatarMutation.isPending || clearMutation.isPending

  // Reset to the current profile every time the dialog opens (prop-change-reset,
  // same pattern as ConnectDialog), so a previous attempt's error/preview never
  // leaks into the next one and a rename elsewhere in the app is picked up.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(profile?.name ?? '')
      setPreview(null)
      setError(null)
    }
  }

  async function saveName() {
    setError(null)
    try {
      await nameMutation.mutateAsync([name.trim()])
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the name')
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const { base64, dataUrl } = await fileToAvatar(file)
      await avatarMutation.mutateAsync([base64])
      setPreview(dataUrl)
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : 'Could not update the picture')
    }
  }

  async function removePicture() {
    setError(null)
    try {
      await clearMutation.mutateAsync([])
      setPreview(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the picture')
    }
  }

  const avatarVersion = profile?.avatarVersion ?? 0
  const hasAvatar = !!preview || avatarVersion > 0

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>Edit profile</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            <Dialog.Description className="dialog-hint">Shown wherever this account appears, exactly like an on-chain identity.</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}

            {/* The picture control IS the avatar: the current (or just-uploaded)
                image in the same 60px circle the account header uses, with
                Replace/Remove beside it — no native file-input chrome. */}
            <div className="field">
              <span className="field-label">Picture</span>
              <div className="row" style={{ alignItems: 'center', gap: 12 }}>
                {preview
                  ? <span className="acct-avatar" style={{ padding: 0, overflow: 'hidden' }}><img src={preview} alt="" className="acct-avatar-img" /></span>
                  : <AccountEmoji account={{ ...account, profile }} className="acct-avatar" imgClass="acct-avatar-img" />}
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => void onFileChange(e)} disabled={busy} />
                <div className="row gap6">
                  <button type="button" className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy}>{hasAvatar ? 'Replace' : 'Upload'}</button>
                  {hasAvatar && <button type="button" className="btn sm" onClick={() => void removePicture()} disabled={busy}>Remove</button>}
                </div>
              </div>
            </div>

            <div className="field">
              <label htmlFor="profile-name-input">Display name</label>
              <input id="profile-name-input" value={name} maxLength={48} placeholder="Not set" onChange={e => setName(e.target.value)} disabled={busy} />
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn primary" onClick={() => void saveName()} disabled={busy || name.trim() === (profile?.name ?? '')}>Save name</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
