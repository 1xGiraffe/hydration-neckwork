/* Hydration Explorer service worker — push only.
 *
 * Deliberately has NO fetch handler: the app is served by nginx with
 * content-hashed assets and an always-revalidated shell, so a worker in the
 * request path could only ever break loading. Everything here reacts to a push
 * message or a click on the notification it produced.
 *
 * Plain JS, no build step, served from /sw.js with Cache-Control: no-cache
 * (see nginx.conf) — the generic .js location is cached for a week, and a stale
 * worker would keep answering pushes with old code forever.
 */

// Take over immediately: a push-only worker has no in-flight page state to
// preserve, and waiting for every tab to close is how a fixed worker never
// ships.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

var FALLBACK_URL = '/notifications'

// The payload is JSON written by the API's delivery module. Parse defensively:
// a push service can deliver an empty or non-JSON body (and some browsers send
// a keepalive push with no data at all), and throwing here would show nothing
// at all — several browsers then punish the registration.
function readPayload(event) {
  if (!event.data) return {}
  try {
    var parsed = event.data.json()
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    try { return { body: event.data.text() } } catch (err2) { return {} }
  }
}

self.addEventListener('push', function (event) {
  var payload = readPayload(event)
  var title = typeof payload.title === 'string' && payload.title ? payload.title : 'Hydration Explorer'
  var options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/icon-192.png',
    // Android renders the status-bar badge as an alpha-mask silhouette (every
    // opaque pixel turns white), so it needs the monochrome white-on-transparent
    // mark — the full-colour icon would show as a solid box up there.
    badge: '/badge-96.png',
    data: { url: typeof payload.url === 'string' && payload.url ? payload.url : FALLBACK_URL },
  }
  // `tag` collapses repeats of the same alert into one notification; without a
  // tag every match stacks, which is exactly what the coalescing on the server
  // exists to avoid.
  if (typeof payload.tag === 'string' && payload.tag) options.tag = payload.tag
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', function (event) {
  event.notification.close()
  var data = event.notification.data || {}
  var target = new URL(typeof data.url === 'string' && data.url ? data.url : FALLBACK_URL, self.location.origin)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Reuse a tab already on this origin — opening a third explorer window
      // for every alert is how a notification stops being welcome.
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i]
        if (new URL(client.url).origin !== target.origin) continue
        var focused = client.focus ? client.focus() : Promise.resolve(client)
        return Promise.resolve(focused).then(function (win) {
          var open = win || client
          if (open && open.navigate && open.url !== target.href) {
            return open.navigate(target.href).catch(function () { /* cross-origin/uncontrolled: focus alone is enough */ })
          }
        })
      }
      return self.clients.openWindow(target.href)
    }),
  )
})
