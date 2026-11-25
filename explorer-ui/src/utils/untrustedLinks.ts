import { isLocalNetworkHref } from '../markdown/localNetwork'

// Links whose target a stranger chose: an account's on-chain identity fields, a
// treasury tip's reason. They follow the forum renderer's link policy (render.ts):
// only an http(s) target, never one into the reader's own network or machine, and
// opened with the same rel. Anything else is shown as text, never as a link.

/** rel for a link to a target a stranger supplied. */
export const UNTRUSTED_REL = 'noopener noreferrer nofollow ugc'

// A bare domain an identity's `web` field often holds (`example.org`, `example.org/about`).
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:[/?#]\S*)?$/i

/**
 * A stranger-supplied web address as a link target: http(s) only (a bare domain gets
 * `https://`), no credentials, nothing in the reader's own network
 * (`isLocalNetworkHref`). null = show it as text.
 */
export function untrustedWebHref(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value || /[\s\\]/.test(value)) return null
  const candidate = /^https?:\/\//i.test(value) ? value : BARE_DOMAIN.test(value) ? `https://${value}` : null
  if (!candidate) return null
  let url: URL
  try { url = new URL(candidate) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (isLocalNetworkHref(url.href)) return null
  return url.href
}

/** An identity's email as a mailto: target, or null when it is not one plain address (no query, no escape, no second recipient). */
export function untrustedEmailHref(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  return /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
    ? `mailto:${value}`
    : null
}

/** An identity's X/Twitter field as a handle (without the @), or null when it is not one. */
export function xHandle(raw: string | null | undefined): string | null {
  const m = /^@?([A-Za-z0-9_]{1,15})$/.exec((raw ?? '').trim())
  return m ? m[1] : null
}
