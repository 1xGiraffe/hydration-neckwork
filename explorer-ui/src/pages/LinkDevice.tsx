import { useEffect, useState } from 'react'
import { ApiError, userApi } from '../api/explorer'
import { setSession, getSession } from '../session'
import { extractDeviceLinkCode } from '../deviceLink'
import { Link, navigate, paths } from '../router'
import { AddrPill, ShortAddr } from '../components/ui'
import type { AccountRef } from '../types'

type Target =
  | { state: 'loading' }
  | { state: 'ready'; account: AccountRef }
  | { state: 'gone' }    // unknown, expired or already used
  | { state: 'failed' }  // the check itself could not run

// Where a scanned QR lands (phone camera app → this URL). The code rides in
// the fragment; it is read once into state and immediately scrubbed from the
// address bar/history so it cannot be recovered from this device later. The
// claim itself is behind an explicit tap: an auto-claim on page load would let
// any link someone sends silently burn a code — or worse, silently swap this
// browser onto a stranger's account. Before that tap the page names the account
// the code signs into (a non-consuming preview), and the button stays disabled
// until it has: a link to this page can come from anyone, and only the reader can
// tell whether the account is their own.
export function LinkDevice() {
  const [code] = useState(() => extractDeviceLinkCode(window.location.hash.slice(1)))
  // Captured once: after a successful claim the session changes hands, but the
  // "you were logged in as …" context of the moment of scanning is what the
  // replace warning is about.
  const [previous] = useState(() => getSession())
  const [target, setTarget] = useState<Target>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  useEffect(() => {
    if (!code) return
    let live = true
    userApi.previewDeviceLink(code).then(
      ({ account }) => { if (live) setTarget({ state: 'ready', account }) },
      (e: unknown) => { if (live) setTarget(e instanceof ApiError && e.status === 401 ? { state: 'gone' } : { state: 'failed' }) },
    )
    return () => { live = false }
  }, [code, attempt])

  async function claim() {
    if (!code || busy || target.state !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      const { token, me } = await userApi.claimDeviceLink(code)
      setSession({ token, accountId: me.account.accountId, address: me.account.address })
      // Straight into the logged-in explorer — the tap on the button above was
      // the confirmation; a success interstitial would just be one more tap.
      navigate(paths.dashboard())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t sign in with this code')
      setBusy(false)
    }
  }

  const sameAccount = target.state === 'ready' && previous?.accountId === target.account.accountId

  return (
    <div className="wrap">
      <div className="page-head"><h1 className="page-title">Link this device</h1></div>
      <div className="detail-card link-device-card">
        {!code ? (
          <>
            <p>This link is missing its login code. Codes are single-use and short-lived — open the QR code on your logged-in device and scan it again.</p>
            <Link className="hash" to={paths.dashboard()}>← Back to search</Link>
          </>
        ) : (
          <>
            <p>A QR code from a logged-in device can log this browser in as the same account — no wallet needed here.</p>
            {target.state === 'loading' && <p className="muted" role="status">Checking which account this code signs into…</p>}
            {target.state === 'gone' && (
              <div className="dialog-error" role="alert">This code has expired or was already used — generate a fresh QR code on your logged-in device and scan it again.</div>
            )}
            {target.state === 'failed' && (
              <div className="dialog-error" role="alert">
                Couldn’t check which account this code signs into. <button type="button" className="link-btn" onClick={() => { setTarget({ state: 'loading' }); setAttempt(n => n + 1) }}>Try again</button>
              </div>
            )}
            {target.state === 'ready' && (
              <>
                <div className="link-device-target">
                  <div className="link-device-target-label">This signs this browser in as</div>
                  <div className="link-device-target-name"><AddrPill account={target.account} noCopy /></div>
                  <div className="link-device-target-addr mono wrap-anywhere">{target.account.address}</div>
                </div>
                <p className="link-device-warn">
                  Continue only if this is <strong>your own</strong> account and you just opened this code on your own device. A link like this one can come from anyone: it would sign this browser into <em>their</em> account, and whatever you do here next would be done as them.
                </p>
              </>
            )}
            {previous && !sameAccount && (
              <p className="link-device-warn">
                This browser is already logged in as <span className="mono"><ShortAddr addr={previous.address} /></span>. Continuing replaces that login.
              </p>
            )}
            {error && <div className="dialog-error">{error} — generate a fresh QR code on your logged-in device and scan it again.</div>}
            <button type="button" className="btn primary" onClick={() => void claim()} disabled={busy || target.state !== 'ready'}>
              {busy ? 'Signing in…' : 'Sign in on this device'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
