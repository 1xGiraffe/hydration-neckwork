import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildMcpApp } from '../../src/mcp/app.ts'
import { TOOL_DEFINITIONS } from '../../src/mcp/registry.ts'
import { renderToolText } from '../../src/mcp/mcpServer.ts'
import type { UpstreamClient } from '../../src/mcp/upstream.ts'

// A JSON-RPC round trip over the real Streamable HTTP transport. The app
// listens on an ephemeral loopback port and the test speaks HTTP to it, because
// several of these cases turn on the exact request headers — a missing
// content-type, an Accept that names one media type — which light-my-request
// normalizes away.
const upstream: UpstreamClient = {
  async get() {
    throw new Error('the protocol test must not reach the explorer api')
  },
}

const PROTOCOL_VERSION = '2025-06-18'

let app: FastifyInstance
let origin: string

beforeAll(async () => {
  app = await buildMcpApp({ logger: false, upstream })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await app?.close()
})

// Exact control over the request headers — including sending none at all,
// which fetch will not do (it invents a content-type for a string body).
function rawPost(headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const port = Number(new URL(origin).port)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('MCP protocol surface', () => {
  it('answers initialize with a JSON-RPC result naming this server', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'protocol-test', version: '0.0.0' },
      },
    })
    expect(status).toBe(200)
    expect(json.jsonrpc).toBe('2.0')
    expect(json.id).toBe(1)
    expect(json.error).toBeUndefined()
    expect(typeof json.result.protocolVersion).toBe('string')
    expect(json.result.serverInfo.name).toBe('hydration-explorer')
    expect(json.result.capabilities).toBeTypeOf('object')
    // The SDK advertises this only because tools are registered; a server that
    // registered none would omit it, and a client would stop calling.
    expect(json.result.capabilities.tools).toBeDefined()
  })

  it('lists every registered tool in the SDK shape', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(status).toBe(200)
    expect(json.jsonrpc).toBe('2.0')
    expect(json.error).toBeUndefined()
    expect(Array.isArray(json.result.tools)).toBe(true)
    // The inventory itself is registry.test.ts's; what belongs here is that the
    // transport serves all of it rather than a subset, so an empty or truncated
    // list cannot pass the per-tool loop below by having nothing to iterate.
    expect(json.result.tools.map((t: any) => t.name)).toEqual(TOOL_DEFINITIONS.map(t => t.name))
    for (const tool of json.result.tools) {
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.annotations.readOnlyHint).toBe(true)
      expect(tool.annotations.destructiveHint).toBe(false)
      expect(tool.annotations.idempotentHint).toBe(true)
      expect(tool.annotations.openWorldHint).toBe(true)
    }
  })

  it('refuses a stateless GET and DELETE with a JSON-RPC error body', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${origin}/mcp`, { method })
      expect(res.status, method).toBe(405)
      const body = await res.json()
      expect(body.jsonrpc).toBe('2.0')
      expect(body.error.message).toMatch(/stateless/)
    }
  })

  it('answers the CORS preflight, strict or bare', async () => {
    for (const headers of [
      undefined,
      { origin: 'https://example.invalid', 'access-control-request-method': 'POST' },
    ]) {
      const res = await fetch(`${origin}/mcp`, { method: 'OPTIONS', headers })
      expect(res.status, headers ? 'preflight' : 'bare').toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-headers')).toMatch(/mcp-session-id/)
      expect(res.headers.get('access-control-expose-headers')).toMatch(/mcp-protocol-version/)
    }
  })

  it('serves health, the client config, the orientation and the tool table', async () => {
    const health = await fetch(`${origin}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const config = await fetch(`${origin}/mcp.json`)
    expect(config.status).toBe(200)
    const parsed = await config.json()
    expect(parsed.mcpServers.hydration.type).toBe('http')
    expect(parsed.mcpServers.hydration.url.endsWith('/mcp')).toBe(true)

    // The getting-started page is the Explorer's, not this service's: /start
    // hands the visitor over rather than serving a second copy of it. The
    // redirect target and the tool table it fetches are pinned in page.test.ts.
    const page = await fetch(`${origin}/start`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toMatch(/\/mcp$/)

    const tools = await fetch(`${origin}/tools.json`)
    expect(tools.status).toBe(200)
    expect(Array.isArray(await tools.json())).toBe(true)

    const llms = await fetch(`${origin}/llms.txt`)
    expect(llms.status).toBe(200)
    expect(llms.headers.get('content-type')).toMatch(/text\/markdown/)

    const favicon = await fetch(`${origin}/favicon.ico`)
    expect(favicon.status).toBe(204)
  })

  it('answers an unknown route with JSON', async () => {
    const res = await fetch(`${origin}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no route/)
  })
})

// The reply body every tool call produces. One text block, never
// structuredContent: a client that forwards both would put the same answer in
// the model's context twice.
describe('tool reply rendering', () => {
  const output = { markdown: '# Block 14,743,669', json: { height: 14743669 } }

  it('renders the markdown by default and the record on format: json', () => {
    expect(renderToolText(output, false, 24_000).text).toBe('# Block 14,743,669')
    expect(renderToolText(output, true, 24_000).text).toBe(JSON.stringify(output.json, null, 2))
  })

  it('appends errors without claiming the answer failed', () => {
    const { text, isError } = renderToolText({ ...output, errors: [{ code: 'UPSTREAM_UNAVAILABLE', message: 'holders could not be read' }] }, false, 24_000)
    expect(text).toContain('**Errors**')
    expect(text).toContain('`UPSTREAM_UNAVAILABLE` holders could not be read')
    expect(isError).toBe(false)
  })

  it('is an error only when there is nothing to read', () => {
    const { text, isError } = renderToolText({ markdown: '', json: null, errors: [{ code: 'NOT_FOUND', message: 'no such block' }] }, false, 24_000)
    expect(isError).toBe(true)
    expect(text).toContain('`NOT_FOUND` no such block')
  })

  it('trims to the text budget and says it did', () => {
    const { text } = renderToolText({ markdown: 'x'.repeat(5_000), json: null }, false, 500)
    expect(text.length).toBeLessThanOrEqual(500)
    expect(text).toContain('truncated')
  })
})

// The envelope contract. An agent runtime that gets the wrong code here cannot
// tell a bad request from a broken server: `-32700 Parse error` on a
// well-formed body says "your JSON is broken" about JSON that parsed, and a
// serialized zod issue array under `-32603` says "the server failed" about a
// call the client can fix.
describe('JSON-RPC envelope conformance', () => {
  const ACCEPT = 'application/json, text/event-stream'
  const JSON_HEADERS = { accept: ACCEPT, 'content-type': 'application/json' }

  it('answers a tools/call whose arguments are not an object with -32602', async () => {
    for (const args of [null, [1, 2, 3], 'x', 7]) {
      const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_network_status', arguments: args } })
      expect(status, JSON.stringify(args)).toBe(200)
      expect(json.error.code, JSON.stringify(args)).toBe(-32602)
      expect(json.error.message).toMatch(/must be a JSON object/)
      // Prose, not a machine dump: no serialized zod issues, no stack.
      expect(json.error.message).not.toMatch(/invalid_type|"path"|\n\s*\{/)
      expect(json.id).toBe(1)
    }
  })

  it('rejects positional params and a missing tool name with -32602', async () => {
    const positional = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: [1, 2] })
    expect(positional.json.error.code).toBe(-32602)
    expect(positional.json.error.message).toMatch(/named parameters/)

    const nameless = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { arguments: {} } })
    expect(nameless.json.error.code).toBe(-32602)
    expect(nameless.json.error.message).toMatch(/params\.name/)
  })

  it('calls a tool that takes no required arguments by name alone', async () => {
    // `arguments` is optional in the MCP call schema; a tool whose parameters
    // are all optional must not need an empty object spelled out.
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_network_status' } })
    expect(status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.result.content[0].type).toBe('text')
  })

  it('answers a non-2.0 envelope with -32600, not a parse error', async () => {
    const { status, json } = await rpc({ jsonrpc: '1.0', id: 5, method: 'tools/list' })
    expect(status).toBe(400)
    expect(json.error.code).toBe(-32600)
    expect(json.error.message).toMatch(/jsonrpc/)
    expect(json.id).toBe(5)
  })

  it('accepts a null id, which JSON-RPC 2.0 allows, and answers with it', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: null, method: 'ping' })
    expect(status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.id).toBe(null)

    const batch = await rpc([{ jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: 'x', method: 'ping' }])
    expect(batch.json.map((m: any) => m.id)).toEqual([null, 'x'])
  })

  it('refuses a batch whose member is malformed, naming the member', async () => {
    const { status, json } = await rpc([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '1.0', id: 7, method: 'ping' }])
    expect(status).toBe(400)
    expect(json.error.code).toBe(-32600)
    expect(json.error.message).toMatch(/message 2 of the batch/)
  })

  it('answers a malformed body with a JSON-RPC parse error, not a fastify error', async () => {
    for (const body of ['{not json', '']) {
      const res = await rawPost(JSON_HEADERS, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      const json = JSON.parse(res.text)
      expect(json.jsonrpc).toBe('2.0')
      expect(json.error.code).toBe(-32700)
      expect(json.id).toBe(null)
    }
  })

  it('answers a missing or wrong content-type with a JSON-RPC envelope', async () => {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
    const shapes: Record<string, string>[] = [
      { accept: ACCEPT },
      { accept: ACCEPT, 'content-type': 'text/plain' },
      { accept: ACCEPT, 'content-type': 'application/x-www-form-urlencoded' },
    ]
    for (const headers of shapes) {
      const res = await rawPost(headers, message)
      expect(res.status, JSON.stringify(headers)).toBe(415)
      const json = JSON.parse(res.text)
      expect(json.jsonrpc).toBe('2.0')
      expect(typeof json.error.code).toBe('number')
      expect(json.error.message).toMatch(/Content-Type/)
    }
  })

  it('keeps the invariants a client already depends on', async () => {
    // Version negotiation: this server's own version by default, the client's
    // when it asks for one this SDK still speaks.
    for (const [asked, expected] of [['2025-11-25', '2025-11-25'], ['2025-06-18', '2025-06-18']]) {
      const { json } = await rpc({ jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: 't', version: '0' } } })
      expect(json.result.protocolVersion, asked).toBe(expected)
    }

    // A notification is acknowledged with 202 and no body.
    const notification = await rawPost(JSON_HEADERS, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(notification.status).toBe(202)

    // Accept without text/event-stream is refused with an explanation.
    const narrow = await rawPost({ accept: 'application/json', 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }))
    expect(narrow.status).toBe(406)
    expect(JSON.parse(narrow.text).error.message).toMatch(/text\/event-stream/)

    // An unknown tool is the caller's mistake, reported in the reply body.
    const unknown = await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
    expect(unknown.json.result.isError).toBe(true)
    expect(JSON.stringify(unknown.json.result)).toMatch(/-32602/)

    // Never structuredContent: a client that forwards both doubles the token
    // cost of every answer.
    const call = await rpc({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_network_status', arguments: {} } })
    expect(call.json.result.structuredContent).toBeUndefined()

    // CORS survives the reply pipeline the transport's answer travels through.
    expect(notification.headers['access-control-allow-origin']).toBe('*')
  })

  it('leaks no stack trace, hostname or container path on any error path', async () => {
    const bodies: string[] = []
    bodies.push((await rawPost(JSON_HEADERS, '{not json')).text)
    bodies.push((await rawPost({ accept: ACCEPT }, '{}')).text)
    bodies.push(JSON.stringify((await rpc({ jsonrpc: '1.0', id: 13, method: 'ping' })).json))
    bodies.push(JSON.stringify((await rpc({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'get_network_status', arguments: null } })).json))
    // A tool whose upstream throws: the stub in this file refuses every read.
    bodies.push(JSON.stringify((await rpc({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'get_network_status', arguments: {} } })).json))
    bodies.push((await (await fetch(`${origin}/nope`)).text()))

    for (const body of bodies) {
      expect(body, body.slice(0, 120)).not.toMatch(/\bat [\w$.]+ \(/)          // a stack frame
      expect(body, body.slice(0, 120)).not.toMatch(/\/home\/|\/app\/|node_modules/)
      expect(body, body.slice(0, 120)).not.toMatch(/hydration-neckwork-api/)   // the internal upstream host
    }
  })
})

/*
 * The cost of the tool table itself.
 *
 * Measured on this registry: tools/list answers 53 KB — roughly 13k tokens
 * that every client spends before it can call anything. Of that, ~32 KB is the
 * thirteen descriptions and ~21 KB the generated input schemas.
 *
 * That size is a deliberate trade, not an oversight. A description here is the
 * tool's interface (AGENTS.md § MCP server): it carries the traps an agent
 * cannot discover by trying — that `type=dca` does not narrow to DCA rows, that
 * the isolated money markets never blend, that an unknown `action` yields an
 * empty page rather than an error. An agent that walks into one of those spends
 * far more than 13k tokens finding out, and on the shared explorer api rather
 * than in its own context. Shortening them would move the cost, not remove it,
 * so they stay whole; the transport gzips the reply (53 KB → 17 KB on the wire)
 * which is the part that is free to take.
 *
 * The ceiling below is what makes it a decision rather than a drift: a registry
 * that grows past it has to re-make the trade in the open.
 */
describe('tools/list budget', () => {
  it('stays inside the token budget the tool descriptions are worth', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} })
    const wire = Buffer.byteLength(JSON.stringify(json))
    const descriptions = json.result.tools.reduce((sum: number, tool: any) => sum + tool.description.length, 0)
    expect(wire, `tools/list is ${wire} bytes; the budget is 64,000. Trim a schema or split a tool rather than truncating a description — the traps in them are the product.`).toBeLessThan(64_000)
    // The descriptions are the majority of it, and that is the intended shape:
    // a table that is mostly schema would mean the traps had been dropped.
    expect(descriptions).toBeGreaterThan(wire / 4)
  })
})
