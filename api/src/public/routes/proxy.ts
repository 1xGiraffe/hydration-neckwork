import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { errorEnvelope } from '../schemas/common.ts'
import {
  PROXY_UPSTREAMS,
  UPSTREAM_TIMEOUT_MS,
  proxyTargetUrl,
  type ProxyUpstream,
} from '../services/proxyUpstreams.ts'

// Allow-listed passthrough to the third-party APIs the Hydration UI needs
// alongside indexed data (spec: "Proxies (data-lake host compatibility)"). The
// allow-list and the upstream mapping live in ../services/proxyUpstreams.ts.
//
// Caching is in-process (src/services/cache.ts), never in the nginx micro-cache:
// each upstream has its own TTL and a failure must never be held by a shared
// cache, so these routes are absent from the Cache-Control table and answer
// `no-store`.
//
// A failure is never cached. `cached()` stores only what the loader RESOLVES, so
// the loader throws on any upstream status >= 400 and the entry is simply never
// written — the next caller re-asks instead of being served a 502 for a TTL.

// What a successful passthrough caches: the bytes and enough to re-serve them.
// The body stays a string, so it is neither re-parsed nor re-serialized (and
// fastify does not run the response serializer over it).
interface ProxyResult {
  status: number
  contentType: string
  body: string
}

class UpstreamStatusError extends Error {
  constructor(readonly result: ProxyResult) {
    super(`upstream responded ${result.status}`)
  }
}

// Sent instead of the caller's headers, so an upstream that rejects an
// unidentified client still works while no client header is forwarded.
const USER_AGENT = 'hydration-neckwork-public-api'

// Every allow-listed upstream is a JSON API, so any other content type is a
// malfunction (an HTML error page, typically). Such a body is still passed
// through — a consumer debugging a broken upstream needs to see it — but it is
// re-labelled text/plain, because a browser pointed at a /proxy URL would
// otherwise RENDER third-party HTML as a document from this origin.
const PASSTHROUGH_CONTENT_TYPE = /^(application\/(json|[\w.+-]+\+json)|text\/plain)\s*(;|$)/i

function passthroughContentType(raw: string | null): string {
  const value = raw?.trim()
  return value && PASSTHROUGH_CONTENT_TYPE.test(value) ? value : 'text/plain; charset=utf-8'
}

async function fetchUpstream(url: string): Promise<ProxyResult> {
  // Deliberately built from nothing: no cookie, authorization, x-api-key, host or
  // forwarding header from the caller ever reaches a third party. Every upstream
  // is keyless, so no credential of ours is sent either.
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  const result: ProxyResult = {
    status: res.status,
    contentType: passthroughContentType(res.headers.get('content-type')),
    body: await res.text(),
  }
  if (result.status >= 400) throw new UpstreamStatusError(result)
  return result
}

// The whole question a passthrough answers is its upstream URL — the request
// carries nothing else that reaches the third party — so the URL is the key.
function cacheKey(upstream: ProxyUpstream, url: string): string {
  return `proxy:${upstream.name}:GET:${url}`
}

async function handleProxy(upstream: ProxyUpstream, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const relPath = String((req.params as Record<string, unknown>)['*'] ?? '')
  const search = req.raw.url?.split('?').slice(1).join('?') ?? ''
  const url = proxyTargetUrl(upstream, relPath, search)
  if (!url) {
    return reply.code(404).send(errorEnvelope('not_found', `no ${upstream.name} passthrough for '${relPath}'`))
  }

  let result: ProxyResult
  try {
    result = await cached(cacheKey(upstream, url), upstream.ttlMs, () => fetchUpstream(url))
  } catch (err) {
    // A 4xx is the caller's answer (an unknown pool id, a rejected query), so it
    // is passed through as-is rather than relabelled as our fault.
    if (err instanceof UpstreamStatusError && err.result.status < 500) {
      return reply.code(err.result.status).header('content-type', err.result.contentType).send(err.result.body)
    }
    // A 5xx or a transport failure is the upstream's fault and its body is not
    // part of this contract: the detail belongs in the log only.
    req.log.warn({ err, upstream: upstream.name, url }, 'proxy upstream request failed')
    const detail = err instanceof UpstreamStatusError ? `responded ${err.result.status}` : 'request failed'
    return reply.code(502).send(errorEnvelope('upstream_error', `${upstream.name} upstream ${detail}`))
  }

  return reply.code(result.status).header('content-type', result.contentType).send(result.body)
}

export const proxyRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async fastify => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  for (const upstream of PROXY_UPSTREAMS) {
    const url = `/proxy/${upstream.name}/*`
    const description = [
      upstream.docs,
      `Allow-listed paths only — anything else is 404: ${upstream.allow.map(pattern => pattern.source).join(' | ')}.`,
      `Responses are cached in this process for ${Math.round(upstream.ttlMs / 1000)}s and are never stored by a shared cache. An upstream 4xx is passed through; a 5xx or a timeout is reported as 502, and neither is cached.`,
      'No caller header is forwarded upstream.',
    ].join(' ')
    // The response is whatever the upstream sent, passed through byte for byte —
    // this surface makes no promise about a third party's payload shape.
    const schema = {
      tags: ['proxy'],
      summary: `${upstream.name} passthrough`,
      description,
      // Fastify's catch-all parameter is literally named '*', and @fastify/swagger
      // documents the path as `/proxy/<name>/{*}` — declaring it keeps the
      // templated path and its parameter list consistent in the document.
      params: z.object({ '*': z.string().describe('Allow-listed upstream path') }),
      response: { 200: z.unknown() },
    }

    app.get(url, { schema }, (req, reply) => handleProxy(upstream, req, reply))
  }
}
