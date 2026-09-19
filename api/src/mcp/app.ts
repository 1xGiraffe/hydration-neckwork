import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { mcpConfig } from './config.ts'
import { createMcpServer } from './mcpServer.ts'
import { TOOL_DEFINITIONS } from './registry.ts'
import { renderLlmsTxt } from './llmsTxt.ts'
import { createUpstreamClient, type UpstreamClient } from './upstream.ts'
import type { ToolContext } from './toolTypes.ts'

export interface McpRouteInfo {
  method: string | string[]
  url: string
}

export interface McpAppOptions {
  logger?: boolean
  // The contract tests' observer, as in the data app: fastify's own
  // registration events, so a route cannot be added without the tests seeing it.
  onRoute?: (route: McpRouteInfo) => void
  // Injected by tests so a protocol round trip touches no network. The process
  // always builds the real client from the configured explorer origin.
  upstream?: UpstreamClient
}

// The headers the Streamable HTTP transport needs a browser-hosted client to be
// allowed to send and read (spec § 2 "Transport").
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, mcp-session-id, mcp-protocol-version, Last-Event-ID'
const CORS_EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version'

function jsonRpcError(code: number, message: string, id: unknown = null): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: id ?? null }
}

// JSON-RPC 2.0 § 5.1. The transport implements the method-level codes; these
// are the envelope-level ones, which it answers for only after its own schema
// has already collapsed several distinct faults into "parse error".
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const INVALID_PARAMS = -32602

interface JsonRpcRejection { status: number; body: Record<string, unknown> }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeJson(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`
}

/**
 * Checks one JSON-RPC message before the SDK's schema sees it.
 *
 * The SDK parses the whole envelope with one zod schema, so every shape it does
 * not recognise — a 1.0 envelope, a null id (legal in JSON-RPC 2.0), positional
 * params — comes back as `-32700 Parse error`, which tells a client its JSON
 * was broken when it was not. And a tool call whose `arguments` is not an
 * object reaches the tool layer, where the failure surfaces as `-32603` wrapping
 * a serialized zod issue array. Both are answered here instead, with the code
 * the spec names and a sentence a model can act on.
 */
function checkJsonRpcMessage(message: unknown, where: string): JsonRpcRejection | null {
  if (!isPlainObject(message)) {
    return { status: 400, body: jsonRpcError(INVALID_REQUEST, `Invalid Request: ${where} must be a JSON object, received ${describeJson(message)}.`) }
  }
  const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
  const reject = (code: number, text: string, status = 400): JsonRpcRejection => ({ status, body: jsonRpcError(code, text, id) })

  if (message.jsonrpc !== '2.0') {
    return reject(INVALID_REQUEST, `Invalid Request: ${where} must carry "jsonrpc": "2.0"; received ${JSON.stringify(message.jsonrpc ?? null)}. This server speaks JSON-RPC 2.0 only.`)
  }
  if (typeof message.method !== 'string' || message.method.length === 0) {
    // A response (result/error) is a legal thing to post at a server in theory;
    // this one issues no requests to its clients, so there is nothing to answer.
    if ('result' in message || 'error' in message) {
      return reject(INVALID_REQUEST, `Invalid Request: ${where} is a JSON-RPC response. This server sends no requests to clients, so it has nothing to answer.`)
    }
    return reject(INVALID_REQUEST, `Invalid Request: ${where} must carry a "method" string.`)
  }
  if ('id' in message && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number') {
    return reject(INVALID_REQUEST, `Invalid Request: ${where} has an "id" that is ${describeJson(message.id)}; an id must be a string, a number, or null.`)
  }
  if ('params' in message && message.params !== null && message.params !== undefined && !isPlainObject(message.params)) {
    return reject(INVALID_PARAMS, `Invalid params: ${where} passes "params" as ${describeJson(message.params)}. This server takes named parameters, so "params" must be a JSON object.`, 200)
  }
  if (message.method === 'tools/call' && isPlainObject(message.params)) {
    const params = message.params
    if (typeof params.name !== 'string' || params.name.length === 0) {
      return reject(INVALID_PARAMS, `Invalid params: "params.name" must be the name of a tool (a string); received ${describeJson(params.name)}. Call tools/list for the available names.`, 200)
    }
    if ('arguments' in params && params.arguments !== undefined && !isPlainObject(params.arguments)) {
      return reject(INVALID_PARAMS, `Invalid params: "params.arguments" for ${params.name} must be a JSON object of the tool's parameters, or omitted entirely; received ${describeJson(params.arguments)}.`, 200)
    }
  }
  return null
}

/**
 * Validates the posted body and hands back the body the transport should see.
 *
 * `id: null` is a legal request id in JSON-RPC 2.0, but the SDK's schema admits
 * only strings and numbers, so such a request is rewritten onto a
 * request-scoped sentinel here and restored to null in the reply
 * (`restoreNullIds`). The nonce makes a collision with a client's own id
 * impossible.
 *
 * A batch is accepted or refused as a unit: one malformed member refuses the
 * whole array, naming its index, rather than half-executing it.
 */
function normalizeJsonRpcBody(body: unknown): { body: unknown; nullIds: Set<string> } | JsonRpcRejection {
  const nullIds = new Set<string>()
  const nonce = randomUUID()

  const rewrite = (raw: Record<string, unknown>, index: number): Record<string, unknown> => {
    let message = raw
    // `arguments` is optional in the MCP call schema, but the SDK validates the
    // tool's input schema against `undefined` and fails the call. A tool whose
    // parameters are all optional must be callable by name alone.
    if (message.method === 'tools/call' && isPlainObject(message.params) && message.params.arguments === undefined) {
      message = { ...message, params: { ...message.params, arguments: {} } }
    }
    if (!('id' in message) || message.id !== null) return message
    const sentinel = `mcp-null-id-${nonce}-${index}`
    nullIds.add(sentinel)
    return { ...message, id: sentinel }
  }

  if (Array.isArray(body)) {
    const out: unknown[] = []
    for (const [index, message] of body.entries()) {
      const rejection = checkJsonRpcMessage(message, `message ${index + 1} of the batch`)
      if (rejection) return rejection
      out.push(rewrite(message as Record<string, unknown>, index))
    }
    return { body: out, nullIds }
  }

  const rejection = checkJsonRpcMessage(body, 'a JSON-RPC message')
  if (rejection) return rejection
  return { body: rewrite(body as Record<string, unknown>, 0), nullIds }
}

// Puts the client's own `id: null` back on the reply it belongs to.
function restoreNullIds(payload: unknown, nullIds: ReadonlySet<string>): unknown {
  if (nullIds.size === 0) return payload
  const fix = (message: unknown): unknown => (
    isPlainObject(message) && typeof message.id === 'string' && nullIds.has(message.id)
      ? { ...message, id: null }
      : message
  )
  return Array.isArray(payload) ? payload.map(fix) : fix(payload)
}

// The request headers the transport reads, minus everything that describes a
// body it is not given: the parsed body is passed in directly, so a
// content-length copied from the original request would describe nothing.
const HOP_BY_HOP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-authorization'])

function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name)) continue
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item)
  }
  const host = typeof req.headers.host === 'string' && req.headers.host ? req.headers.host : 'mcp.invalid'
  return new Request(new URL(req.url, `http://${host}`), { method: req.method, headers })
}

// Constant-time over every configured key, and length-checked first because
// timingSafeEqual throws on unequal lengths. The loop deliberately does not
// break early.
function keyAccepted(presented: string, keys: readonly string[]): boolean {
  const offered = Buffer.from(presented, 'utf8')
  let accepted = false
  for (const key of keys) {
    const expected = Buffer.from(key, 'utf8')
    if (expected.length !== offered.length) continue
    if (timingSafeEqual(offered, expected)) accepted = true
  }
  return accepted
}

/**
 * Builds the MCP service without listening, so tests can drive it.
 * src/mcp/server.ts owns the process lifecycle.
 */
export async function buildMcpApp({ logger = true, onRoute, upstream }: McpAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Trust XFF only from private-range hops — the edge proxy on the compose
    // network. Same rationale as the other API processes: with bare `true` a
    // public client could spoof its address, and without it every req.ip
    // collapses to the proxy's.
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
  })

  if (onRoute) app.addHook('onRoute', route => onRoute({ method: route.method, url: route.url }))

  await app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOW_HEADERS.split(', '),
    exposedHeaders: CORS_EXPOSE_HEADERS.split(', '),
    // The plugin owns the preflight for every route except /mcp, which has its
    // own below with the transport's exact header set. `strictPreflight: false`
    // is the reason it can: the strict handler answers a bare OPTIONS — no
    // Origin, no Access-Control-Request-Method, which is exactly what an agent
    // runtime probing the endpoint for reachability sends — with 400 "Invalid
    // Preflight Request". Turning the plugin's preflight off entirely instead
    // leaves every other route answering OPTIONS with a 404, which a browser
    // reads as a refusal: the Explorer's getting-started page reads /tools.json
    // cross-origin and would lose it the day it sends a header of its own.
    preflight: true,
    strictPreflight: false,
  })
  // Compression for the orientation documents and the tool table. Deliberately no
  // @fastify/etag: /mcp is a POST surface whose body is a JSON-RPC exchange,
  // never a cacheable resource, and an entity tag on it would only invite a
  // client to revalidate a call it must actually make.
  await app.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })

  const ctx: ToolContext = {
    upstream: upstream ?? createUpstreamClient({
      baseUrl: mcpConfig.explorerApiUrl,
      timeoutMs: mcpConfig.upstreamTimeoutMs,
      maxConcurrency: mcpConfig.maxUpstreamConcurrency,
      queueTimeoutMs: mcpConfig.upstreamQueueTimeoutMs,
      maxQueueDepth: mcpConfig.upstreamQueueDepth,
      cheapLaneSlots: mcpConfig.upstreamCheapLaneSlots,
      defaultTtlMs: mcpConfig.cacheTtlMs,
      userAgent: 'hydration-mcp/1.0 (+' + mcpConfig.publicUrl + ')',
      logger: app.log,
    }),
    explorerBaseUrl: mcpConfig.explorerPublicUrl,
    publicUrl: mcpConfig.publicUrl,
    maxTextChars: mcpConfig.maxTextChars,
  }

  // The getting-started documentation lives in the Explorer UI at
  // `${EXPLORER_PUBLIC_URL}/mcp`, and only there: two copies of the same page
  // is exactly the duplication AGENTS.md forbids, and the Explorer one can
  // render the tool list live (see /tools.json below) instead of baking it in
  // at boot. This process therefore ships no HTML at all.
  const startPageUrl = `${mcpConfig.explorerPublicUrl}/mcp`

  const llmsTxt = renderLlmsTxt(TOOL_DEFINITIONS, mcpConfig.publicUrl)

  if (mcpConfig.accessKeys.length === 0) {
    app.log.info('[mcp] MCP_ACCESS_KEYS is empty: /mcp is open, as designed — every tool reads public chain data only')
  } else {
    app.log.info(`[mcp] /mcp requires one of ${mcpConfig.accessKeys.length} configured bearer access keys`)
  }

  // The gate covers /mcp only: the orientation documents, the tool table and
  // the health probe stay open so a client — and the getting-started page in
  // the Explorer, which probes this endpoint — can discover the surface and
  // read the 401 contract before it has a key.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (mcpConfig.accessKeys.length === 0) return
    if (req.method === 'OPTIONS') return
    // The ROUTE fastify matched, never the raw request target. find-my-way
    // percent-decodes the path before it matches, so `POST /%6dcp` reaches this
    // handler while `req.url` still reads `/%6dcp` — comparing the raw text
    // here let that spelling through the gate and served the whole endpoint
    // without a key. `routeOptions.url` is the registered pattern, so every
    // spelling that reaches /mcp is checked and nothing else is.
    if (req.routeOptions.url !== '/mcp') return
    const header = req.headers.authorization
    const presented = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (presented && keyAccepted(presented, mcpConfig.accessKeys)) return
    await reply.code(401).type('application/json').send(jsonRpcError(-32001, 'this Hydration MCP endpoint requires an access key: send it as `Authorization: Bearer <key>`'))
  })

  app.post('/mcp', async (req, reply) => {
    let parsedBody = req.body
    let nullIds: ReadonlySet<string> = new Set()
    // The transport answers 406 for an Accept header that does not admit both
    // media types, and 415 for a content-type that is not application/json.
    // Both come first in the protocol, so the envelope check runs only once
    // they would pass — a text/plain body must still be answered as an
    // unsupported media type, not as a malformed JSON-RPC message.
    const accept = req.headers.accept ?? ''
    const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (parsedBody !== undefined && mediaType === 'application/json' && accept.includes('application/json') && accept.includes('text/event-stream')) {
      const normalized = normalizeJsonRpcBody(parsedBody)
      if ('status' in normalized) {
        return await reply.code(normalized.status).type('application/json').send(normalized.body)
      }
      parsedBody = normalized.body
      nullIds = normalized.nullIds
    }

    const server = createMcpServer(ctx)
    // The web-standard transport hands back a Response instead of writing to
    // the socket, which is what lets this route answer through fastify's normal
    // pipeline: CORS and compression apply, and the reply can be corrected
    // where the SDK's envelope handling differs from JSON-RPC 2.0.
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: no session id, no resumable stream, no per-client state on
      // this process, so any number of agents can connect at once.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      // Fastify has already consumed and parsed the request stream, so the body
      // MUST be passed as `parsedBody`: left to read the request itself, the
      // transport would wait forever on a stream that has already ended.
      const res = await transport.handleRequest(toWebRequest(req), { parsedBody })

      reply.code(res.status)
      res.headers.forEach((value, name) => {
        // fastify re-derives both once the body it actually sends is known.
        if (name === 'content-length' || name === 'content-encoding') return
        reply.header(name, value)
      })
      if (!res.body) return await reply.send()
      // enableJsonResponse makes every POST answer a single JSON payload, so
      // this branch is a safety net: were the SDK to stream one, it must be
      // piped rather than read as text, which would hang.
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        return await reply.send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]))
      }
      const text = await res.text()
      if (nullIds.size === 0) return await reply.send(text)
      return await reply.send(JSON.stringify(restoreNullIds(JSON.parse(text), nullIds)))
    } catch (err) {
      // The client gets a bare sentence; the stack and this deployment's
      // internals stay in the log.
      req.log.error(err)
      if (!reply.sent) return await reply.code(500).type('application/json').send(jsonRpcError(-32603, 'internal error'))
      return undefined
    } finally {
      await server.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })

  // A stateless server has no stream to resume and no session to delete, so
  // both verbs are a protocol-level "not applicable" rather than a routing miss.
  const noStream = async (_req: FastifyRequest, reply: FastifyReply) => {
    await reply.code(405).header('allow', 'POST, OPTIONS').type('application/json')
      .send(jsonRpcError(-32000, 'this MCP server is stateless: there is no SSE stream to open or session to delete. Send every JSON-RPC message as POST /mcp.'))
  }
  app.get('/mcp', noStream)
  app.delete('/mcp', noStream)

  const preflight = (methods: string) => async (_req: FastifyRequest, reply: FastifyReply) => {
    await reply.code(204)
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', methods)
      .header('access-control-allow-headers', CORS_ALLOW_HEADERS)
      .header('access-control-expose-headers', CORS_EXPOSE_HEADERS)
      .header('access-control-max-age', '86400')
      .send()
  }
  // A static route, so it wins over the plugin's wildcard for the one path a
  // browser-hosted MCP client preflights.
  app.options('/mcp', preflight('POST, OPTIONS'))

  // 302, not 301: the documentation's home is a product decision, and a
  // permanently-cached redirect would outlive a change of mind in every browser
  // that ever followed it.
  const toStartPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.redirect(startPageUrl, 302)
  app.get('/', toStartPage)
  app.get('/start', toStartPage)

  // The agent-readable map of this surface (llmstxt.org), rendered from the
  // registry so a new tool appears in it the moment it registers.
  app.get('/llms.txt', async (_req, reply) => reply.type('text/markdown; charset=utf-8').send(llmsTxt))

  // Copy-ready client configuration, in the shape every host's mcp.json uses.
  app.get('/mcp.json', async (_req, reply) => reply.type('application/json; charset=utf-8')
    .send({ mcpServers: { hydration: { type: 'http', url: `${mcpConfig.publicUrl}/mcp` } } }))

  // The registered surface as plain data, for the getting-started page in the
  // Explorer UI (a different origin, which the app-wide CORS policy already
  // allows). It carries the same three fields a client sees in tools/list, so
  // the page never has to speak JSON-RPC just to name the tools. Rendered from
  // the registry, so a tool that registers appears here with no further edit.
  app.get('/tools.json', async (_req, reply) => reply.type('application/json; charset=utf-8')
    .send(TOOL_DEFINITIONS.map(t => ({ name: t.name, title: t.title, description: t.description }))))

  app.get('/health', async () => ({ status: 'ok' }))

  // A browser that lands here before the redirect fires asks for this;
  // answering 204 keeps it out of the log as a 404.
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send())

  app.setNotFoundHandler(async (req, reply) => {
    await reply.code(404).type('application/json')
      .send({ error: `no route ${req.method} ${req.url}`, endpoint: `${mcpConfig.publicUrl}/mcp`, gettingStarted: startPageUrl })
  })

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    // A client of /mcp speaks JSON-RPC and nothing else, so the faults fastify
    // catches before the route runs — an unparseable body, a missing or wrong
    // content-type — must answer in the same envelope the transport uses for
    // them rather than in fastify's `{error}` shape, which an MCP client cannot
    // read as a protocol error.
    if (req.method === 'POST' && req.url.split('?')[0] === '/mcp' && err.code?.startsWith('FST_ERR_CTP')) {
      const body = status === 415
        ? jsonRpcError(-32000, 'Unsupported Media Type: Content-Type must be application/json')
        : jsonRpcError(PARSE_ERROR, err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
          ? 'Parse error: the request body is empty. POST a JSON-RPC message.'
          : 'Parse error: the request body is not valid JSON.')
      return await reply.code(status).type('application/json').send(body)
    }
    await reply.code(status).type('application/json')
      .send({ error: status >= 500 ? 'internal error' : err.message })
  })

  return app
}
