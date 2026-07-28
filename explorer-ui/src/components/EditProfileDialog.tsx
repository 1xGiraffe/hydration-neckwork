import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { userApi } from '../api/explorer'
import { useMe, useUserMutation } from '../hooks/useUser'
import { AccountEmoji } from './ui'

// Square-crop + resize any picked image down to a 128×128 avatar before it ever
// leaves the browser: webp first (smallest at equal quality), falling back to
// jpeg where `canvas.toBlob('image/webp', …)` returns null (Safari < 17). The
// server only checks magic bytes + the 64 KiB ceiling — it never decodes an
// image — so an oversized or unrecognized result has to be caught here, with a
// message the visitor can act on, rather than surfacing as an opaque 422.
async function fileToAvatarBase64(file: File): Promise<string> {
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
  return btoa(bin)
}

// Self-authored profile: a display name and an avatar the account owner sets
// after wallet login (Account.tsx opens this only on the viewer's own page).
// Both fields save independently — a name edit doesn't require touching the
// picture and vice versa — and either can fail with a 422 the visitor can fix
// (name too long, image still too big after resize) without losing the other.
export function EditProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useMe()
  const account = me.data?.account
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      setName(account?.profile?.name ?? '')
      setPreview(null)
      setError(null)
    }
  }

  // The client-side preview is an object URL over the ORIGINAL picked file —
  // cheap and always decodable, unlike guessing the mime type the canvas
  // encoder picked. It's superseded by the real served avatar (avatarVersion
  // bump → cache invalidation → AccountEmoji re-fetches) the next time the
  // dialog opens, so it only ever needs to last this one session.
  useEffect(() => {
    if (!preview) return
    return () => URL.revokeObjectURL(preview)
  }, [preview])

  async function saveName() {
    setError(null)
    try {
      await nameMutation.mutateAsync([name.trim()])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the name')
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    const objectUrl = URL.createObjectURL(file)
    setPreview(objectUrl)
    try {
      const base64 = await fileToAvatarBase64(file)
      await avatarMutation.mutateAsync([base64])
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

  const hasAvatar = !!preview || (account?.profile?.avatarVersion ?? 0) > 0

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
            <Dialog.Description className="dialog-hint">Only visible to accounts that see your address, exactly like an on-chain identity.</Dialog.Description>
            {error && <div className="dialog-error">{error}</div>}

            <div className="field">
              <label htmlFor="profile-avatar-input">Picture</label>
              <div className="row gap6" style={{ alignItems: 'center' }}>
                {preview
                  ? <span className="acct-avatar" style={{ padding: 0, overflow: 'hidden' }}><img src={preview} alt="" className="acct-avatar-img" /></span>
                  : account ? <AccountEmoji account={account} className="acct-avatar" imgClass="acct-avatar-img" /> : null}
                {/* `.field input` resets file inputs' box model too (`all: unset`), which
                    can hide the browser-drawn picker button — revert it back to the UA
                    default here rather than losing the reset for every other field. */}
                <input id="profile-avatar-input" type="file" accept="image/*" style={{ all: 'revert' }} onChange={e => void onFileChange(e)} disabled={busy} />
                {hasAvatar && <button type="button" className="btn" onClick={() => void removePicture()} disabled={busy}>Remove picture</button>}
              </div>
            </div>

            <div className="field">
              <label htmlFor="profile-name-input">Display name</label>
              <input id="profile-name-input" value={name} maxLength={48} placeholder="Not set" onChange={e => setName(e.target.value)} disabled={busy} />
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn primary" onClick={() => void saveName()} disabled={busy || name.trim() === (account?.profile?.name ?? '')}>Save name</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
