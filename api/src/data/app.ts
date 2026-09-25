import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import etag from '@fastify/etag'
import swagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod'
import type { ClickHouseClient } from '../db/client.ts'
import { registerCacheControl } from './cacheControl.ts'
import { errorEnvelope } from './schemas/common.ts'
import { dataConfig } from './config.ts'
import {
  checkRateLimit, initDataAuth, isTokenShaped, recordUsage, resolveToken, unauthenticatedIpAllowed,
} from './services/auth.ts'
import { renderLlmsTxt } from './services/llmsTxt.ts'
import { statusRoutes } from './routes/status.ts'
import { blocksRoutes } from './routes/blocks.ts'
import { extrinsicsRoutes } from './routes/extrinsics.ts'
import { eventsRoutes } from './routes/events.ts'
import { accountsRoutes } from './routes/accounts.ts'
import { accountsDefiRoutes } from './routes/accountsDefi.ts'
import { assetsRoutes } from './routes/assets.ts'
import { poolsRoutes } from './routes/pools.ts'
import { tradesRoutes } from './routes/trades.ts'
import { dcaRoutes } from './routes/dca.ts'
import { intentsRoutes } from './routes/intents.ts'
import { otcRoutes } from './routes/otc.ts'
import { governanceRoutes } from './routes/governance.ts'
import { stakingRoutes } from './routes/staking.ts'
import { xcmRoutes } from './routes/xcm.ts'
import { evmRoutes } from './routes/evm.ts'
import { statsRoutes } from './routes/stats.ts'

// Every data route plugin, registered in order — the public app's idiom: a new
// endpoint group is added here and nowhere else.
export const DATA_ROUTE_PLUGINS: Array<FastifyPluginAsync<{ client: ClickHouseClient }>> = [
  statusRoutes,
  blocksRoutes,
  extrinsicsRoutes,
  eventsRoutes,
  accountsRoutes,
  accountsDefiRoutes,
  assetsRoutes,
  poolsRoutes,
  tradesRoutes,
  dcaRoutes,
  intentsRoutes,
  otcRoutes,
  governanceRoutes,
  stakingRoutes,
  xcmRoutes,
  evmRoutes,
  statsRoutes,
]

export interface DataRouteInfo {
  method: string | string[]
  url: string
}

export interface DataAppOptions {
  client: ClickHouseClient
  logger?: boolean
  // Same contract-test observer as the public app: fastify's own registration
  // events, so a nested/parameterised path cannot go undocumented.
  onRoute?: (route: DataRouteInfo) => void
}

declare module 'fastify' {
  interface FastifyRequest {
    // The authenticated token's owner, set by the auth hook for every
    // non-exempt route before its handler runs.
    dataAccountId?: string
  }
}

// The surfaces a developer — or their agent — must be able to reach WITHOUT a
// token: the status probe, the OpenAPI document, the docs portal that teaches
// them how to get a token in the first place, and /llms.txt, the compact
// orientation an automated client reads before deciding what to call.
// /favicon.ico rides along so a browser on the docs page gets a clean 404
// instead of a 401 in its console. /robots.txt and /sitemap.xml are what let
// a search engine index the docs portal: a crawler sends no token, and a 401
// on robots.txt reads as "crawl nothing".
const AUTH_EXEMPT = [
  /^\/v1\/status$/, /^\/openapi\.json$/, /^\/llms\.txt$/, /^\/docs(\/|$)/, /^\/docs$/, /^\/favicon\.ico$/,
  /^\/robots\.txt$/, /^\/sitemap\.xml$/,
]

export function isAuthExempt(path: string): boolean {
  return AUTH_EXEMPT.some(pattern => pattern.test(path))
}

// Runs before every non-exempt route: resolve the bearer token, enforce the
// owner's two fixed windows, stamp the X-RateLimit headers, meter the request.
// Unauthenticated/invalid requests cost one (negative-cached) token lookup at
// most and are additionally braked per IP (concept § 3.3).
async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.method === 'OPTIONS') return
  const path = req.url.split('?')[0]
  if (isAuthExempt(path)) return

  const header = req.headers.authorization
  const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  const accountId = raw && isTokenShaped(raw) ? await resolveToken(raw) : null
  if (!accountId) {
    if (!unauthenticatedIpAllowed(req.ip)) {
      await reply.code(429).header('retry-after', '60')
        .send(errorEnvelope('rate_limited', 'too many unauthenticated requests from this address', { retryAfterSeconds: 60 }))
      return
    }
    const message = raw
      ? (isTokenShaped(raw) ? 'unknown or revoked API token' : 'malformed API token: expected hdd_ followed by 64 hex characters')
      : 'missing API token: send it as `Authorization: Bearer hdd_…`'
    await reply.code(401).send(errorEnvelope('unauthorized', message, {
      docs: dataConfig.docsUrl,
      createToken: dataConfig.createTokenUrl,
    }))
    return
  }

  const decision = await checkRateLimit(accountId)
  reply.header('x-ratelimit-limit-minute', String(decision.limits.perMinute))
  reply.header('x-ratelimit-remaining-minute', String(decision.remainingMinute))
  reply.header('x-ratelimit-limit-day', String(decision.limits.perDay))
  reply.header('x-ratelimit-remaining-day', String(decision.remainingDay))
  recordUsage(accountId, !decision.allowed)
  if (!decision.allowed) {
    await reply.code(429).header('retry-after', String(decision.retryAfterSeconds))
      .send(errorEnvelope('rate_limited', 'rate limit exceeded', {
        perMinute: decision.limits.perMinute,
        perDay: decision.limits.perDay,
        usedMinute: decision.usedMinute,
        usedDay: decision.usedDay,
        retryAfterSeconds: decision.retryAfterSeconds,
      }))
    return
  }
  req.dataAccountId = accountId
}

// What a search engine shows for the docs portal. The plugin 301s `/docs` to
// `/docs/` and serves the HTML there, so that is the canonical form; the
// description is deliberately one sentence, not the OpenAPI document's
// getting-started text, because a result snippet is cut at ~160 characters.
export const DOCS_TITLE = 'Hydration Data API'
export const DOCS_DESCRIPTION = 'Hydration Data API reference: token-authenticated REST over the full public Hydration on-chain dataset — blocks, accounts, assets, pools, trades, governance, staking, XCM and EVM.'
export const DOCS_CANONICAL_URL = dataConfig.docsUrl + '/'
const DOCS_HTML_ROUTE = '/docs/'

const GETTING_STARTED = [
  'REST access to the full public Hydration on-chain dataset: chain core (blocks, extrinsics, events), accounts (balances, history, transfers, trades, DeFi positions), assets and prices, pools and trades, governance, staking, XCM and EVM, plus aggregate stats. Everything answers from purpose-built ClickHouse projections; typical reads are tens of milliseconds.',
  '## Getting started',
  '1. **Get a token**: sign in to the [Hydration Explorer](' + dataConfig.createTokenUrl.replace(/\/api-tokens$/, '') + ') with your wallet and create an API token under **API tokens** (' + dataConfig.createTokenUrl + '). The `hdd_…` secret is shown exactly once.',
  '2. **Send it as a Bearer header** on every request: `Authorization: Bearer hdd_…`. Only `/v1/status`, `/openapi.json`, `/llms.txt` and `/docs` work without one.',
  '3. **Watch the rate-limit headers**: every response carries `X-RateLimit-Limit-Minute`, `X-RateLimit-Remaining-Minute`, `X-RateLimit-Limit-Day`, `X-RateLimit-Remaining-Day`. All tokens of one account share the account\'s budget. A 429 carries `Retry-After` and the current usage in the error context; higher limits are granted per account — ask.',
  '## Conventions',
  '- **Addresses** are accepted as SS58 (any prefix), H160, or 0x-prefixed 32-byte public-key hex; responses carry the canonical form (`address`: Polkadot SS58, or the H160 for an EVM account) plus `accountIdHex`.',
  '- **Amounts** are raw integer strings (planck/wei) with an `assetId`; resolve decimals and symbols via `/v1/assets`. USD values are 2-decimal strings in `…Usd` fields (`valueUsd`, `amountUsd`, `tvlUsd`); a unit price (`priceUsd`) keeps its feed\'s full precision. Historical flows (trades, transfers, revenue) are valued at event time (the latest closed hourly candle at or before the row), bucketed histories (`…/history`) at the candle fully closed by each bucket end, holdings (balances, liquidity positions, TVL) at current prices.',
  '- **Timestamps** are ISO-8601 UTC.',
  '- **Extrinsic linkage**: wherever an `extrinsicIndex` appears, its `extrinsicHash` rides beside it (null on block-hook rows that no extrinsic carried).',
  '- **Names**: an event is always `eventName` (`Pallet.Event`), a call always `callName` (`Pallet.call`); the same entity has the same shape wherever it is reached (a vote under an account is the vote under its referendum, a staking event under an account is the staking event on the global feed).',
  '- **Pagination** is cursor-based: `?limit=` (1-100, default 25) and `?cursor=` (opaque, from the previous page\'s `nextCursor`). Responses are `{ items, nextCursor?, hasMore }`, descending by default (`order=asc` where documented). Cursors are stable under live ingestion and O(1) at any depth. Every deep feed also takes the optional window quartet `fromBlock`/`toBlock`/`fromTime`/`toTime` (either kind, either end alone) — the cursor then walks only the window, so reading a bounded slice costs the slice, not the account\'s whole history.',
  '- **Errors** are always `{ "error": { "code", "message", "context?" } }` with the matching HTTP status. `code` ∈ `unauthorized | rate_limited | bad_request | not_found | internal`. A 404 for a chain resource carries the indexed head in `context`, so "not found" is distinguishable from "not yet ingested". List endpoints answer an unknown-but-valid account with `200` and empty items; only single resources 404.',
  '- **Versioning**: `/v1` is additive-only. A breaking change means `/v2`; fields and routes are never renamed, retyped or removed within `/v1`.',
  '- The contract serves finalized, indexed state only — no mempool or unfinalized data.',
].join('\n\n')

// Builds the Data API without listening, so tests can drive it through
// app.inject(). src/data/server.ts owns the process lifecycle.
export async function buildDataApp({ client, logger = true, onRoute }: DataAppOptions): Promise<FastifyInstance> {
  initDataAuth(client)
  const app = Fastify({
    logger,
    // Trust XFF only from private-range hops — the reverse proxy on the compose
    // network. Same rationale as the other two API processes: without it every
    // req.ip collapses to the proxy's address and the per-IP brake keys all
    // callers into one bucket; with bare `true` a public client could spoof it.
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  })

  if (onRoute) app.addHook('onRoute', route => onRoute({ method: route.method, url: route.url }))

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(cors, { origin: '*' })

  // The docs portal is the one page on this host meant to be indexed, and the
  // Scalar plugin's document gives a crawler almost nothing to index: its
  // template carries only the `pageTitle` option (set below) — every other
  // configuration key, `metaData` included, is serialized into the
  // `createApiReference` call and applied by the bundle in the browser, so the
  // HTML a crawler fetches has no description and no canonical URL. The
  // template has no slot for either, so they are spliced in behind the title
  // here, on the plugin's HTML route alone. Added BEFORE etag and compress so
  // the validator hashes, and gzip compresses, the body that is actually sent.
  const docsHeadTags = `<meta name="description" content="${DOCS_DESCRIPTION}" />\n    <link rel="canonical" href="${DOCS_CANONICAL_URL}" />`
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url !== DOCS_HTML_ROUTE || typeof payload !== 'string') return payload
    if (!String(reply.getHeader('content-type') ?? '').startsWith('text/html')) return payload
    return payload.replace('</title>', `</title>\n    ${docsHeadTags}`)
  })

  // ETag before compress, exactly as in public/app.ts: the validator hashes the
  // canonical uncompressed body, so identity and gzip responses of one resource
  // carry the same ETag and revalidate as a 304 instead of re-transferring.
  await app.register(etag)
  await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Hydration Data API',
        version: '1.0.0',
        description: GETTING_STARTED,
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'An API token from the Hydration Explorer (`hdd_…`). Create one at ' + dataConfig.createTokenUrl,
          },
        },
      },
      // Declared globally so the docs portal's test client prompts for the
      // token natively; /v1/status overrides it with `security: []` and the
      // other exempt routes are hidden from the document entirely.
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  })

  // The interactive docs portal (Scalar, not Swagger UI): renders the same
  // OpenAPI document, with a built-in test client that sends the Bearer token.
  // `pageTitle` is the one option the plugin writes into the document it
  // serves (`<title>`); the plugin's `metaData` would only be applied by the
  // bundle in the browser, after the crawler has read the page.
  await app.register(scalarApiReference, {
    routePrefix: '/docs',
    configuration: {
      theme: 'purple',
      pageTitle: DOCS_TITLE,
    },
  })

  // The raw document, for codegen and the contract tests.
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  // The agent-readable map of the same document (llmstxt.org). Rendered once
  // on first request — the OpenAPI document is fixed after `ready()` — and
  // served as markdown so a client can read it without a JSON parse.
  let llmsTxt: string | null = null
  app.get('/llms.txt', { schema: { hide: true } }, async (_req, reply) => {
    llmsTxt ??= renderLlmsTxt(app.swagger(), dataConfig.publicUrl)
    return reply.type('text/markdown; charset=utf-8').send(llmsTxt)
  })

  // The crawler files. Only the token-free documents a search engine can
  // actually read are allowed; every /v1 route answers a crawler with a 401
  // and would be indexed as an error page. `/docs` is allowed as a prefix
  // because the portal is at `/docs/`, the 401 context points at `/docs`, and
  // the bundle a crawler needs to render the page is under `/docs/js/`. The
  // sitemap allows itself: a crawler that honours Disallow for the sitemap
  // fetch would otherwise never read it. Sitemaps are host-scoped, so this
  // host names its own one page.
  app.get('/robots.txt', { schema: { hide: true } }, async (_req, reply) => reply
    .type('text/plain; charset=utf-8')
    .send([
      'User-agent: *',
      'Allow: /docs',
      'Allow: /openapi.json',
      'Allow: /llms.txt',
      'Allow: /sitemap.xml',
      'Disallow: /',
      '',
      `Sitemap: ${dataConfig.publicUrl}/sitemap.xml`,
      '',
    ].join('\n')))
  app.get('/sitemap.xml', { schema: { hide: true } }, async (_req, reply) => reply
    .type('application/xml; charset=utf-8')
    .send([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `  <url><loc>${DOCS_CANONICAL_URL}</loc></url>`,
      '</urlset>',
      '',
    ].join('\n')))

  registerCacheControl(app)

  // Auth before any route registration so every /v1 route (and every future
  // one) is covered without opting in.
  app.addHook('onRequest', authenticate)

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send(errorEnvelope('not_found', `no route ${req.method} ${req.url}`, { docs: dataConfig.docsUrl }))
  })

  // One error shape for the whole surface; 5xx details stay in the log. An
  // error may carry its own `context` (the bounded-window 400s do).
  app.setErrorHandler((err: FastifyError & { context?: Record<string, unknown> }, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    const code = status >= 500 ? 'internal'
      : status === 404 ? 'not_found'
      : status === 401 ? 'unauthorized'
      : status === 429 ? 'rate_limited'
      : 'bad_request'
    void reply.code(status).send(errorEnvelope(code, status >= 500 ? 'internal error' : err.message, err.context))
  })

  for (const plugin of DATA_ROUTE_PLUGINS) await app.register(plugin, { client })
  return app
}
