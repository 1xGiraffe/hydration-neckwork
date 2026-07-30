// QR device-link handoff. The QR encodes a full URL so a phone's native camera
// app can open the explorer directly; the in-app scanner accepts the same URL
// (or a bare code) and extracts the code from it. The code travels in the URL
// FRAGMENT on purpose: fragments never leave the browser, so a code cannot
// land in nginx/api logs or a Referer header on its way to being claimed.
export const DEVICE_LINK_PATH = '/link-device'

const CODE_RE = /^[0-9a-f]{64}$/i

export function deviceLinkUrl(origin: string, code: string): string {
  return `${origin}${DEVICE_LINK_PATH}#${code}`
}

// A scanned QR's text, a pasted URL, or a bare 64-hex code → the code, or null
// for anything else (foreign QR codes land here — the scanner keeps looking).
export function extractDeviceLinkCode(text: string): string | null {
  const trimmed = text.trim()
  if (CODE_RE.test(trimmed)) return trimmed.toLowerCase()
  try {
    const url = new URL(trimmed)
    const code = url.hash.slice(1)
    if (url.pathname === DEVICE_LINK_PATH && CODE_RE.test(code)) return code.toLowerCase()
  } catch { /* not a URL either */ }
  return null
}
