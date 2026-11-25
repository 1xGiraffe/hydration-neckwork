import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { Agent } from 'node:https'
import { BlockList, isIP } from 'node:net'

// Where a Web Push subscription may point. A subscription's endpoint is a URL the
// browser's push service hands the page, and the api later POSTs to it with the
// whole response read into memory — so an endpoint is accepted only when it names
// one of the push services browsers actually use: https, the default port, no
// credentials, and a host on this list (exact, or a subdomain of a suffix entry).
// An endpoint anywhere else could make the api hold sockets open, read an endless
// body, or send requests into networks it can reach and the caller cannot.
export const WEB_PUSH_SERVICE_HOSTS = {
  // Chrome, Opera, Samsung Internet, Brave and other Chromium browsers (FCM);
  // Firefox (Mozilla autopush); Safari on macOS and iOS (Apple Push Notification service).
  exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'],
  // Mozilla's regional push hosts, Edge (Windows Push Notification Services), Apple's push hosts.
  suffixes: ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'],
} as const

/** Whether `endpoint` is a Web Push endpoint the api may store and send to. Pure. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return (WEB_PUSH_SERVICE_HOSTS.exact as readonly string[]).includes(host)
    || WEB_PUSH_SERVICE_HOSTS.suffixes.some(suffix => host.endsWith(suffix) && host.length > suffix.length)
}

// Addresses a push request may connect to: global unicast only. Loopback,
// private, shared, link-local, multicast, reserved and documentation ranges are
// refused, and so are the IPv6 tunnelling prefixes that wrap an arbitrary IPv4.
const NON_PUBLIC_V4 = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_PUBLIC_V4.addSubnet(net, bits, 'ipv4')
const GLOBAL_UNICAST_V6 = new BlockList()
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6')
const NON_PUBLIC_V6 = new BlockList()
for (const [net, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) NON_PUBLIC_V6.addSubnet(net, bits, 'ipv6')

/** Whether a resolved address is on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return !NON_PUBLIC_V4.check(ip, 'ipv4')
  if (family !== 6) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return isPublicAddress(mapped[1])
  return GLOBAL_UNICAST_V6.check(ip, 'ipv6') && !NON_PUBLIC_V6.check(ip, 'ipv6')
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

// A DNS lookup that fails when any answer is not a public address, so a push
// host whose name resolves into a private network is never connected to.
export function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, options, (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
    if (err) { callback(err, address, family); return }
    const answers = Array.isArray(address) ? address.map(a => a.address) : [address]
    if (!answers.length || answers.some(a => !isPublicAddress(a))) {
      const refused: NodeJS.ErrnoException = new Error('push endpoint does not resolve to a public address')
      refused.code = 'ENOTPUBLIC'
      callback(refused, address, family)
      return
    }
    callback(null, address, family)
  })
}

/** The one agent every push request goes through: public addresses only, bounded sockets. */
export const pushAgent = new Agent({ lookup: publicOnlyLookup, maxSockets: 32 })

/** How long a push request may stay idle before it is abandoned. */
export const PUSH_TIMEOUT_MS = 10_000
