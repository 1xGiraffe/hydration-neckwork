import type { FastifyRequest } from 'fastify'

// What a request log line may say about the URL. The log keys every request by the
// client's address, so a URL that names a set of wallets or carries a one-time
// secret would tie that address to them for as long as the log is kept.
//
//   - A query string that lists wallets (the connect dialog's account-refs lookup)
//     is replaced as a whole.
//   - Everything after a `/link` path segment — a one-time linking code or the id
//     a link is polled by, as a path segment or in the query — is replaced.
//
// Every other URL is logged as requested.

const REDACTED = '[redacted]'
const WALLET_QUERY_PATHS = new Set(['/explorer/account-refs'])
const LINK_SEGMENT = /\/link(?=\/|$)/

export function redactLoggedUrl(url: string): string {
  const q = url.indexOf('?')
  const path = q < 0 ? url : url.slice(0, q)
  const link = LINK_SEGMENT.exec(path)
  if (link) {
    const head = path.slice(0, link.index + link[0].length)
    return head.length < path.length || q >= 0 ? `${head}/${REDACTED}` : url
  }
  if (q >= 0 && WALLET_QUERY_PATHS.has(path.replace(/\/+$/, ''))) return `${path}?${REDACTED}`
  return url
}

// Fastify's own request serializer (lib/logger-pino.js), with the URL redacted.
export const requestLogSerializers = {
  req(req: FastifyRequest) {
    const version = req.headers?.['accept-version']
    return {
      method: req.method,
      url: redactLoggedUrl(req.url),
      version: Array.isArray(version) ? version[0] : version,
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    }
  },
}
