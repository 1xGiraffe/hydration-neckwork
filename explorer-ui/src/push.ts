import { userApi } from './api/explorer'
import type { NotificationChannel } from './types'

// Browser/PWA push, end to end: register the worker, ask for permission (only
// ever from a user gesture — Chrome and Safari both discard a request that
// isn't), subscribe with the deployment's VAPID key, and hand the subscription
// to the API. Everything that touches `navigator`/`Notification` lives here, so
// the page can render (and be render-tested) without any of it existing.

export const SERVICE_WORKER_URL = '/sw.js'

// Push needs all three: a worker to receive it, a PushManager to subscribe
// with, and the Notification API to show it. Safari on iOS exposes none of them
// in a normal tab — only inside an installed (home-screen) app.
export function isPushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && 'Notification' in window
}

// Running as an installed app rather than a browser tab.
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // iOS Safari's own, pre-standard flag.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

// iOS Safari is the one platform where "unsupported" is actionable rather than
// final: the same device CAN receive push once the site is added to the home
// screen, so the page says that instead of "your browser can't do this".
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac; the touch-point count is what
  // distinguishes it from a real desktop.
  const iPadOS = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1
  return /iPad|iPhone|iPod/.test(ua) || iPadOS
}

export type PushUnavailable = 'supported' | 'ios-install' | 'unsupported'

// Why the enable button is not being offered — the page turns this into copy.
export function pushAvailability(): PushUnavailable {
  if (isPushSupported()) return 'supported'
  if (isIosSafari() && !isStandalone()) return 'ios-install'
  return 'unsupported'
}

// VAPID keys travel as unpadded base64url; PushManager wants the raw bytes.
// The view is built over an explicit ArrayBuffer so it satisfies BufferSource
// (a Uint8Array's buffer is ArrayBufferLike, which may be shared).
export function urlBase64ToUint8Array(base64UrlKey: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlKey.length % 4)) % 4)
  const base64 = (base64UrlKey + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// A human name for THIS browser, so the channels list distinguishes "Chrome on
// this laptop" from "the phone". Best-effort from the user agent — the server
// stores it verbatim and never derives anything from it.
export function browserLabel(): string {
  if (typeof navigator === 'undefined') return 'This browser'
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser'
  const platform = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  const suffix = isStandalone() ? ' (installed)' : ''
  return platform ? `${browser} on ${platform}${suffix}` : `${browser}${suffix}`
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL)
  // `ready` resolves once an ACTIVE worker controls this scope — subscribing
  // against a still-installing registration throws in Firefox.
  return navigator.serviceWorker.ready.catch(() => registration)
}

export class PushError extends Error {}

// Call from a click handler. Returns the channel the API stored, so the caller
// can show it in the list without waiting for the overview to refetch.
export async function enablePush(vapidPublicKey: string, label?: string): Promise<NotificationChannel> {
  if (!isPushSupported()) throw new PushError('This browser cannot receive push notifications.')
  if (!vapidPublicKey) throw new PushError('Web Push is not configured on this deployment.')

  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new PushError(permission === 'denied'
      ? 'Notifications are blocked for this site — allow them in your browser settings, then try again.'
      : 'Notification permission was dismissed.')
  }

  const registration = await registerServiceWorker()
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)
  // An existing subscription signed with a DIFFERENT key can never be pushed to
  // by this deployment (a key rotation, or a shared browser profile), so it is
  // dropped rather than re-registered.
  const existing = await registration.pushManager.getSubscription()
  if (existing && !sameApplicationServerKey(existing, applicationServerKey)) await existing.unsubscribe()
  const subscription = (existing && sameApplicationServerKey(existing, applicationServerKey))
    ? existing
    : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!json.endpoint || !p256dh || !auth) throw new PushError('The browser returned an unusable push subscription.')
  return userApi.registerWebPush({ endpoint: json.endpoint, keys: { p256dh, auth } }, label ?? browserLabel())
}

function sameApplicationServerKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return false
  const bytes = new Uint8Array(current)
  if (bytes.length !== key.length) return false
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== key[i]) return false
  return true
}

// Drop the channel server-side and the browser subscription with it. The delete
// is what matters (the server stops sending); the local unsubscribe is
// best-effort, since a browser that has forgotten the subscription is exactly
// the case the channel is being removed for.
export async function disablePush(channelId: string): Promise<void> {
  await userApi.deleteNotificationChannel(channelId)
  if (!isPushSupported()) return
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL)
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  } catch { /* the channel is already gone server-side */ }
}
