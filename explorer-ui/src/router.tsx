/* eslint-disable react-refresh/only-export-components -- router module exports hooks/helpers alongside <Link> */
import { useSyncExternalStore, useCallback } from 'react'
import { flushSync } from 'react-dom'
import type { MouseEvent, ReactNode, CSSProperties } from 'react'

// History-based router matching the Explorer.html design (/blocks, /block/:h,
// /extrinsic/:h-i, /account/:addr, …). Dependency-free, same philosophy as
// preis-ui (window events + a single store), but using the History API so URLs
// are clean (no `#`). Deep links work from static nginx via `try_files … /index.html`.

const ACTIVITY_SLUGS = ['swap', 'dca', 'transfer', 'cross-chain', 'add-liquidity', 'remove-liquidity', 'create-pool', 'claim-rewards', 'supply', 'withdraw', 'borrow', 'repay', 'liquidate', 'staking', 'vote', 'otc-place', 'otc-pull', 'otc-fill'] as const
export type ActivitySlug = typeof ACTIVITY_SLUGS[number]
const ACTIVITY_ID_RE = /^\d+-(?:e)?\d+$/
// Activity feed tab that lists this slug's rows (crumbs + malformed-id fallback).
export const ACTIVITY_SLUG_TAB: Record<ActivitySlug, string> = {
  swap: 'trade', dca: 'trade', transfer: 'transfer', 'cross-chain': 'xcm',
  'add-liquidity': 'liquidity', 'remove-liquidity': 'liquidity', 'create-pool': 'liquidity', 'claim-rewards': 'all',
  supply: 'mm', withdraw: 'mm', borrow: 'mm', repay: 'mm', liquidate: 'mm',
  staking: 'staking', vote: 'vote',
  // OTC folds under the Trade activity tab (rows keep their own otc-* slugs).
  'otc-place': 'trade', 'otc-pull': 'trade', 'otc-fill': 'trade',
}

export type Route =
  | { name: 'dashboard' }
  | { name: 'activity' }
  | { name: 'blocks' }
  | { name: 'block'; height: number }
  | { name: 'extrinsics' }
  | { name: 'extrinsic'; id: string } // "height-index"
  | { name: 'activity-detail'; slug: ActivitySlug; id: string } // "height-index"
  | { name: 'dca-schedule'; scheduleId: number }
  | { name: 'dca-resolve'; height: number; index: number; kind: 'event' | 'extrinsic' }
  | { name: 'events' }
  | { name: 'event'; id: string } // "height-index"
  | { name: 'legacy'; to: string } // pre-consolidation URL, redirected to /activity
  | { name: 'accounts' }
  | { name: 'account'; address: string }
  | { name: 'tags' }
  | { name: 'tag'; tagId: string }
  | { name: 'assets' }
  | { name: 'hdx' }
  | { name: 'hollar' }
  | { name: 'asset'; assetId: number }
  | { name: 'holders'; assetId: number }
  | { name: 'notfound'; path: string }

// Internal nav event the store listens to (pushState/replaceState don't fire
// popstate themselves, so navigate()/redirect() dispatch this).
const NAV_EVENT = 'explorer:navigation'

// The current location as `pathname?search` (no origin), kept in sync with the
// browser. This is what the store exposes and what parseRoute/useQuery consume.
function getLocation(): string {
  return window.location.pathname + window.location.search
}

export function parseRoute(loc: string): Route {
  const qIdx = loc.indexOf('?')
  const pathOnly = qIdx >= 0 ? loc.slice(0, qIdx) : loc
  let parts: string[]
  try {
    parts = pathOnly.replace(/^\//, '').split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return { name: 'notfound', path: pathOnly }
  }
  if (parts.length === 0) return { name: 'dashboard' }
  switch (parts[0]) {
    case 'activity': return { name: 'activity' }
    // Consolidated top-level URLs redirect to the matching Activity tab.
    case 'blocks': return { name: 'blocks' }
    case 'block':
      return parts[1] && isSafeId(parts[1]) ? { name: 'block', height: Number(parts[1]) } : { name: 'blocks' }
    case 'extrinsics': return { name: 'extrinsics' }
    case 'extrinsic':
      return parts[1] ? { name: 'extrinsic', id: parts[1] } : { name: 'extrinsics' }
    case 'trade': // /trade/* URLs canonicalize to /swap or /dca after load
      return parts[1] && ACTIVITY_ID_RE.test(parts[1])
        ? { name: 'legacy', to: `/swap/${parts[1]}` }
        : { name: 'legacy', to: '/activity?tab=trade' }
    case 'events': return { name: 'events' }
    case 'event':
      return parts[1] ? { name: 'event', id: parts[1] } : { name: 'events' }
    case 'transfers': return { name: 'legacy', to: '/activity?tab=transfer' }
    case 'trades': return { name: 'legacy', to: '/activity?tab=trade' }
    case 'votes': return { name: 'legacy', to: '/activity?tab=vote' }
    case 'accounts': return { name: 'accounts' }
    case 'account':
      return parts[1] ? { name: 'account', address: parts[1] } : { name: 'accounts' }
    case 'tags': return { name: 'tags' }
    case 'tag':
      return parts[1] ? { name: 'tag', tagId: parts[1] } : { name: 'tags' }
    case 'assets': return { name: 'assets' }
    case 'hdx': return { name: 'hdx' }
    case 'hollar': return { name: 'hollar' }
    case 'asset':
      return parts[1] && isSafeId(parts[1]) ? { name: 'asset', assetId: Number(parts[1]) } : { name: 'assets' }
    case 'holders':
      return parts[1] && isSafeId(parts[1]) ? { name: 'holders', assetId: Number(parts[1]) } : { name: 'assets' }
    default:
      if ((ACTIVITY_SLUGS as readonly string[]).includes(parts[0])) {
        const slug = parts[0] as ActivitySlug
        // A DCA is a SCHEDULE, not a single fill: /dca/<scheduleId> is its page.
        // Legacy per-execution links (/dca/<height-index>) land on the extrinsic.
        if (slug === 'dca' && parts[1]) {
          if (/^\d+$/.test(parts[1])) return { name: 'dca-schedule', scheduleId: Number(parts[1]) }
          // Legacy per-execution ids resolve to their owning SCHEDULE via the
          // API (extrinsic form = the scheduling extrinsic; event form = the
          // execution's block), falling back to the event/extrinsic page.
          const m = /^(\d+)-(e)?(\d+)$/.exec(parts[1])
          if (m) return { name: 'dca-resolve', height: Number(m[1]), index: Number(m[3]), kind: m[2] ? 'event' : 'extrinsic' }
        }
        return parts[1] && ACTIVITY_ID_RE.test(parts[1])
          ? { name: 'activity-detail', slug, id: parts[1] }
          : { name: 'legacy', to: `/activity?tab=${ACTIVITY_SLUG_TAB[slug]}` }
      }
      return { name: 'notfound', path: pathOnly }
  }
}

function isSafeId(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb)
  window.addEventListener(NAV_EVENT, cb)
  return () => {
    window.removeEventListener('popstate', cb)
    window.removeEventListener(NAV_EVENT, cb)
  }
}

// Normalise a target into an absolute clean path (`/activity`, `/account/x?…`).
function normalize(to: string): string {
  if (!to) return '/'
  return to.startsWith('/') ? to : '/' + to
}

// Crossing the "/" boundary swaps the hero search for the topbar search (they
// never coexist — see Dashboard/Topbar). Morph one into the other via a
// same-document view transition (the bars share a view-transition-name in
// global.css) on every viewport. Reduced motion, no browser support, and
// jsdom keep the instant swap.
export function shouldMorphSearch(fromPath: string, toPath: string): boolean {
  if ((fromPath === '/') === (toPath === '/')) return false
  if (typeof document.startViewTransition !== 'function') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function navigate(to: string): void {
  const next = normalize(to)
  if (getLocation() === next) return
  // Only scroll to top when the PATH changes (a real navigation). Query-only
  // changes — switching a tab, toggling a filter chip, paging — keep the current
  // scroll position so the controls don't jump out from under the cursor (#13).
  const prevPath = window.location.pathname
  const nextPath = next.split('?')[0]
  const commit = () => {
    window.history.pushState(null, '', next)
    window.dispatchEvent(new Event(NAV_EVENT))
    if (prevPath !== nextPath) window.scrollTo(0, 0)
  }
  // flushSync so the new page is in the DOM before the browser captures the
  // view transition's "new" snapshot.
  if (shouldMorphSearch(prevPath, nextPath)) document.startViewTransition(() => flushSync(commit))
  else commit()
}

// Replace the current history entry (used for canonicalizing URLs, e.g. a raw
// AccountId32 → its SS58/EVM form) so the back button isn't broken by the swap.
export function redirect(to: string): void {
  const next = normalize(to)
  if (getLocation() === next) return
  window.history.replaceState(null, '', next)
  window.dispatchEvent(new Event(NAV_EVENT))
}

// getSnapshot reads the URL directly (no cached copy): equal locations are
// equal strings, so it's loop-safe, and a navigation dispatched before a
// subscriber mounts (e.g. a redirect from a child's mount effect) can't be
// missed via a stale cache.
export function useRoute(): Route {
  const loc = useSyncExternalStore(subscribe, getLocation, () => '/')
  return parseRoute(loc)
}

// Generic deep-linkable query state, stored in the real query string
// (`/activity?tab=transfer&token=DOT&page=3`). Everything filterable/tabbable is
// kept here so links and the back button restore the exact view.
export function useQuery(): URLSearchParams {
  const loc = useSyncExternalStore(subscribe, getLocation, () => '/')
  return new URLSearchParams(loc.split('?')[1] ?? '')
}
export function setQuery(patch: Record<string, string | null | undefined>): void {
  const path = window.location.pathname
  const params = new URLSearchParams(window.location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const q = params.toString()
  navigate(q ? `${path}?${q}` : path)
}
// Reactive single value + its setter (resets page unless the key IS page).
export function useQueryValue(key: string, fallback = ''): string {
  return useQuery().get(key) ?? fallback
}
// Deep-linked page number, stored in the query string (`/blocks?page=3`).
export function usePageParam(): number {
  const p = useQuery().get('page')
  if (!p || !isSafeId(p)) return 0
  const n = Number(p)
  return n > 0 ? n : 0
}
export function setPage(page: number): void {
  setQuery({ page: page > 0 ? String(page) : null })
}

export const paths = {
  dashboard: () => '/',
  activity: () => '/activity',
  blocks: () => '/blocks',
  block: (h: number | string) => `/block/${h}`,
  extrinsics: () => '/extrinsics',
  extrinsic: (id: string) => `/extrinsic/${id}`,
  extrinsicAt: (h: number, i: number) => `/extrinsic/${h}-${i}`,
  activityDetail: (slug: ActivitySlug, id: string) => `/${slug}/${id}`,
  dcaSchedule: (scheduleId: number) => `/dca/${scheduleId}`,
  events: () => '/events',
  event: (id: string) => `/event/${id}`,
  eventAt: (h: number, i: number) => `/event/${h}-${i}`,
  accounts: () => '/accounts',
  account: (addr: string) => `/account/${encodeURIComponent(addr)}`,
  tags: () => '/tags',
  tag: (tagId: string) => `/tag/${encodeURIComponent(tagId)}`,
  assets: () => '/assets',
  hdx: () => '/hdx',
  hollar: () => '/hollar',
  asset: (assetId: number) => `/asset/${assetId}`,
  holders: (assetId: number) => `/holders/${assetId}`,
}

export function Link({ to, children, className, title, ariaLabel, onClick, style }: { to: string; children: ReactNode; className?: string; title?: string; ariaLabel?: string; onClick?: (e: MouseEvent) => void; style?: CSSProperties }) {
  const href = normalize(to)
  const handle = useCallback((e: MouseEvent) => {
    onClick?.(e)
    if (e.defaultPrevented) return
    // Honour modifier / middle clicks (open in new tab/window) by letting the
    // browser do a full navigation. Otherwise it's a real SPA nav: stop the
    // default reload and push state. Reset scroll like the design, but only for
    // real navigations (path changes) — a same-page query-only link keeps the
    // scroll position, matching navigate()/setQuery (#13).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    navigate(href)
  }, [onClick, href])
  return <a href={href} className={className} title={title} aria-label={ariaLabel} style={style} onClick={handle}>{children}</a>
}
