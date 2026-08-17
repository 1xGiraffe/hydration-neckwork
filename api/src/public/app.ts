import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import etag from '@fastify/etag'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod'
import type { ClickHouseClient } from '../db/client.ts'
import { registerCacheControl } from './cacheControl.ts'
import { errorEnvelope } from './schemas/common.ts'
import { serviceRoutes } from './routes/service.ts'
import { proxyRoutes } from './routes/proxy.ts'
import { assetsRoutes } from './routes/assets.ts'
import { accountsRoutes } from './routes/accounts.ts'
import { feesChartsRoutes } from './routes/feesCharts.ts'
import { webStatsRoutes } from './routes/webStats.ts'
import { lendingRoutes } from './routes/lending.ts'
import { tradesRoutes } from './routes/trades.ts'
import { chainRoutes } from './routes/chain.ts'
import { gigahdxRoutes } from './routes/gigahdx.ts'
import { dcaRoutes } from './routes/dca.ts'
import { pricesRoutes } from './routes/prices.ts'
import { poolsRoutes } from './routes/pools.ts'
import { dexscreenerRoutes } from './routes/dexscreener.ts'
import { statsRoutes } from './routes/stats.ts'
import { coingeckoRoutes } from './routes/coingecko.ts'
import { defillamaRoutes } from './routes/defillama.ts'

// Every public route plugin, registered in order. A new endpoint group is added
// here and nowhere else, so the app's composition stays one readable list.
export const PUBLIC_ROUTE_PLUGINS: Array<FastifyPluginAsync<{ client: ClickHouseClient }>> = [
  serviceRoutes,
  proxyRoutes,
  assetsRoutes,
  accountsRoutes,
  feesChartsRoutes,
  webStatsRoutes,
  lendingRoutes,
  tradesRoutes,
  chainRoutes,
  gigahdxRoutes,
  dcaRoutes,
  pricesRoutes,
  poolsRoutes,
  dexscreenerRoutes,
  statsRoutes,
  coingeckoRoutes,
  defillamaRoutes,
]

// A registered route, as reported to the optional `onRoute` observer below.
export interface PublicRouteInfo {
  method: string | string[]
  url: string
}

export interface PublicAppOptions {
  client: ClickHouseClient
  logger?: boolean
  // Called once per registered route, in registration order. The contract test
  // uses it to assert the OpenAPI document covers every route that exists —
  // reading fastify's own registration events rather than re-deriving the route
  // list, which is the only way a nested or parameterised path (`/v1/dca/
  // schedules/:id/executions`) cannot silently go undocumented.
  onRoute?: (route: PublicRouteInfo) => void
}

// Builds the public API without listening, so tests can drive it through
// app.inject(). src/public/server.ts owns the process lifecycle.
export async function buildPublicApp({ client, logger = true, onRoute }: PublicAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Trust X-Forwarded-For/X-Real-IP only from loopback/link-local/private-range
    // hops — exactly the api-public-nginx sidecar on the compose network. Without
    // it every request's req.ip collapses to the sidecar's container address and
    // @fastify/rate-limit keys all callers into one bucket. Never widen this to
    // bare `true`, which would trust XFF from any hop including a public client
    // spoofing it. Same rationale as api/src/server.ts.
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  })

  // Added before any route-registering plugin so it observes all of them,
  // including the swagger UI's and any route added directly below.
  if (onRoute) app.addHook('onRoute', route => onRoute({ method: route.method, url: route.url }))

  // zod is the single source of truth for request validation, response
  // serialization, and the published OpenAPI document.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // All routes are anonymous reads. A fixed wildcard avoids reflecting arbitrary
  // origins (and the resulting Vary: Origin fragmentation in shared caches).
  await app.register(cors, { origin: '*' })
  // Strong ETag over the response body, so the sidecar's
  // `proxy_cache_revalidate on` and browsers can revalidate an expired entry for
  // a 304 instead of re-transferring the payload. Registered BEFORE compress so
  // the validator is a hash of the canonical uncompressed representation:
  // measured, an identity and a gzip response of the same resource then carry
  // the same ETag, and compress adds `Vary: Accept-Encoding`, so no shared cache
  // mixes encodings under one entry.
  await app.register(etag)
  await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })
  // An abuse brake, not a quota: generous enough that a UI page's fan-out and a
  // feed's polling never see it, low enough to bound a single scraper.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Hydration Public API',
        version: '1.0.0',
        description: 'Versioned REST surface over the Hydration indexer. Addresses are lowercase hex public keys (never SS58), timestamps are ISO-8601 UTC, token amounts are strings and USD values are 2-decimal strings, and asset ids are decimal strings. Every error response, on every route, is `{ "error": { "code": "bad_request" | "not_found" | "rate_limited" | "upstream_error" | "internal", "message": "…" } }` with the matching HTTP status. /v1 is additive-only; a breaking change means /v2.',
      },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })
  // The raw document, for codegen and contract tests.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  registerCacheControl(app)

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorEnvelope('not_found', `no route ${req.method} ${req.url}`))
  })

  // One error shape for the whole surface. 5xx details stay in the log: an
  // internal message is not part of a public contract. Every other 4xx (406,
  // 415, 422, …) is a caller problem, so it reports the bad_request family
  // rather than being mislabelled as an internal fault.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    const code = status >= 500 ? 'internal'
      : status === 404 ? 'not_found'
      : status === 429 ? 'rate_limited'
      : 'bad_request'
    reply.code(status).send(errorEnvelope(code, status >= 500 ? 'internal error' : err.message))
  })

  for (const plugin of PUBLIC_ROUTE_PLUGINS) await app.register(plugin, { client })
  return app
}
