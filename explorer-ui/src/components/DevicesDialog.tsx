import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { renderSVG } from 'uqr'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { logout } from '../hooks/useUser'
import { useNow } from '../hooks/useNow'
import { deviceLinkUrl } from '../deviceLink'
import { F } from './ui'
import type { DeviceLinkResponse, DeviceSession } from '../types'

// Devices: every live login of this account (each session is a device), each
// revocable on its own, plus "Link a device" — a short-lived single-use QR
// that hands this login to a second device without moving the wallet. The QR
// encodes {origin}/link-device#{code}, so a phone's camera app opens the
// explorer directly; the in-app scanner (ConnectDialog) reads the same code.
type View = 'list' | 'link'

const POLL_MS = 2000

function DeviceRow({ s, now, onRevoked, onClose }: { s: DeviceSession; now: number; onRevoked: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function revoke() {
    setBusy(true)
    setError(false)
    try {
      if (s.current) {
        // Revoking the device you are on IS logging out — say so on the button.
        await logout()
        onClose()
        return
      }
      await userApi.revokeSession(s.id)
      onRevoked()
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  return (
    <div className="device-row">
      <div className="device-info">
        <div className="device-name">
          {s.label || 'Unknown device'}
          {s.current && <span className="tag device-tag">This device</span>}
          {s.createdVia === 'qr' && <span className="tag device-tag">via QR</span>}
        </div>
        <div className="device-meta">Added {F.ago(s.createdAt, now)} · last seen {F.ago(s.lastSeen, now)}{error ? ' · could not revoke' : ''}</div>
      </div>
      <button type="button" className="btn sm" onClick={() => void revoke()} disabled={busy}>
        {s.current ? 'Log out' : 'Revoke'}
      </button>
    </div>
  )
}

// The QR view: mint a code on mount, show it, poll until the other device
// claims it. The code exists only inside this view; leaving it discards the
// code (which still expires server-side on its own). "New code" remounts the
// whole view via the parent's key, so every mount is exactly one code.
function LinkView({ onBack, onLinked, onNewCode }: { onBack: () => void; onLinked: () => void; onNewCode: () => void }) {
  const [link, setLink] = useState<DeviceLinkResponse | null>(null)
  const [claimed, setClaimed] = useState(false)
  const [gone, setGone] = useState(false)   // the server no longer knows the code (restart) — same as expired
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  useEffect(() => {
    let cancelled = false
    userApi.createDeviceLink()
      .then(l => { if (!cancelled) setLink(l) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not create a code') })
    return () => { cancelled = true }
  }, [])

  const secondsLeft = link ? Math.max(0, Math.round((Date.parse(link.expiresAt) - now) / 1000)) : null
  const expired = !claimed && (gone || secondsLeft === 0)

  useEffect(() => {
    if (!link || claimed || expired) return
    const poll = setInterval(() => {
      userApi.deviceLinkStatus(link.linkId)
        .then(({ status }) => {
          if (status === 'claimed') { setClaimed(true); onLinked() }
          else if (status === 'expired') setGone(true)
        })
        .catch(() => {})   // a missed poll is just the next poll's problem
    }, POLL_MS)
    return () => clearInterval(poll)
  }, [link, claimed, expired, onLinked])

  return (
    <>
      {error ? (
        <div className="dialog-error">{error}</div>
      ) : claimed ? (
        <div className="qr-linked">✓ Device linked — it is now logged in as you.</div>
      ) : !link ? (
        <div className="qr-box qr-box-loading" aria-hidden="true" />
      ) : expired ? (
        <div className="qr-scan-fallback">This code has expired. Codes only live a few minutes.</div>
      ) : (
        <>
          {/* uqr emits a self-contained static SVG (rects and paths only). */}
          <div className="qr-box" role="img" aria-label="Device-link QR code" dangerouslySetInnerHTML={{ __html: renderSVG(deviceLinkUrl(window.location.origin, link.code), { border: 2 }) }} />
          <div className="qr-expiry mono">
            {secondsLeft != null && `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}
          </div>
          <div className="dialog-hint">
            Scan it with the other device's camera app, or from "Scan QR code" in its login dialog.
            One use only — and anyone who scans it gets logged in as you, so show it to your own device only.
          </div>
        </>
      )}
      <div className="row gap6" style={{ justifyContent: 'flex-end' }}>
        {(expired || error != null) && <button type="button" className="btn primary" onClick={onNewCode}>New code</button>}
        <button type="button" className="btn" onClick={onBack}>Back to devices</button>
      </div>
    </>
  )
}

export function DevicesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useSession()
  const [view, setView] = useState<View>('list')
  const [linkAttempt, setLinkAttempt] = useState(0)
  const qc = useQueryClient()
  const now = useNow()

  // Reset to the device list every time the dialog opens (prop-change-reset,
  // same pattern as ConnectDialog) so a leftover QR view never greets — or
  // mints a code for — the next open.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setView('list')
  }

  const sessions = useQuery({
    queryKey: ['user', 'sessions', session?.accountId],
    queryFn: ({ signal }) => userApi.sessions(signal),
    enabled: open && !!session,
    staleTime: 5000,
  })
  const invalidate = useCallback(() => void qc.invalidateQueries({ queryKey: ['user', 'sessions'] }), [qc])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <div className="dialog-head">
            <Dialog.Title asChild><h2>{view === 'list' ? 'Devices' : 'Link a device'}</h2></Dialog.Title>
            <Dialog.Close asChild>
              <button className="theme-toggle" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">
            {view === 'link' ? (
              <LinkView key={linkAttempt} onBack={() => setView('list')} onLinked={invalidate} onNewCode={() => setLinkAttempt(n => n + 1)} />
            ) : (
              <>
                <Dialog.Description className="dialog-hint">Every login of this account. Revoking one logs that device out immediately.</Dialog.Description>
                {sessions.isError && <div className="dialog-error">Could not load the device list.</div>}
                <div className="device-list">
                  {(sessions.data?.sessions ?? []).map(s => (
                    <DeviceRow key={s.id} s={s} now={now} onRevoked={invalidate} onClose={() => onOpenChange(false)} />
                  ))}
                </div>
              </>
            )}
          </div>
          {view === 'list' && (
            <div className="dialog-foot">
              <button type="button" className="btn primary" onClick={() => { setLinkAttempt(n => n + 1); setView('link') }}>Link a device</button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
