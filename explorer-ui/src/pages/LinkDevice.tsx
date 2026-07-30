import { useEffect, useState } from 'react'
import { userApi } from '../api/explorer'
import { setSession, getSession } from '../session'
import { extractDeviceLinkCode } from '../deviceLink'
import { Link, navigate, paths } from '../router'
import { ShortAddr } from '../components/ui'

// Where a scanned QR lands (phone camera app → this URL). The code rides in
// the fragment; it is read once into state and immediately scrubbed from the
// address bar/history so it cannot be recovered from this device later. The
// claim itself is behind an explicit tap: an auto-claim on page load would let
// any link someone sends silently burn a code — or worse, silently swap this
// browser onto a stranger's account.
export function LinkDevice() {
  const [code] = useState(() => extractDeviceLinkCode(window.location.hash.slice(1)))
  // Captured once: after a successful claim the session changes hands, but the
  // "you were logged in as …" context of the moment of scanning is what the
  // replace warning is about.
  const [previous] = useState(() => getSession())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  async function claim() {
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      const { token, me } = await userApi.claimDeviceLink(code)
      setSession({ token, accountId: me.account.accountId, address: me.account.address })
      // Straight into the logged-in explorer — the tap on the button above was
      // the confirmation; a success interstitial would just be one more tap.
      navigate(paths.dashboard())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log in with this code')
      setBusy(false)
    }
  }

  return (
    <div className="wrap">
      <div className="page-head"><div className="page-title">Link this device</div></div>
      <div className="detail-card link-device-card">
        {!code ? (
          <>
            <p>This link is missing its login code. Codes are single-use and short-lived — open the QR code on your logged-in device and scan it again.</p>
            <Link className="hash" to={paths.dashboard()}>← Back to start</Link>
          </>
        ) : (
          <>
            <p>A QR code from a logged-in device can log this browser in as the same account — no wallet needed here.</p>
            {previous && (
              <p className="link-device-warn">
                This browser is already logged in as <span className="mono"><ShortAddr addr={previous.address} /></span>. Continuing replaces that login.
              </p>
            )}
            {error && <div className="dialog-error">{error} — generate a fresh QR code on your logged-in device and scan it again.</div>}
            <button type="button" className="btn primary" onClick={() => void claim()} disabled={busy}>
              {busy ? 'Logging in…' : 'Log in on this device'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
