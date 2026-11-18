import type { FastifyInstance } from 'fastify'

// Which origins may read a response. The anonymous reads answer every origin with one
// fixed wildcard (no reflection, so no `Vary: Origin` and no fragmentation of the
// shared micro-cache). The private /user/ surface (sessions, lists, the forum's
// writes) answers no other origin: its bearer token never rides along cross-site, so
// CSRF cannot apply, and stripping CORS also keeps another site's script from reading
// its responses — preflights included.

export const isPrivatePath = (url: string | undefined): boolean => (url ?? '').startsWith('/user/')

const CORS_HEADERS = [
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age',
]

/** Registered once at the root, after @fastify/cors: removes every CORS header from /user/ replies. */
export function stripCorsFromPrivate(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (req, reply, payload) => {
    if (isPrivatePath(req.url)) for (const h of CORS_HEADERS) reply.removeHeader(h)
    return payload
  })
}
