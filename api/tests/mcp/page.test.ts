import { existsSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildMcpApp } from '../../src/mcp/app.ts'
import { mcpConfig } from '../../src/mcp/config.ts'
import { TOOL_DEFINITIONS } from '../../src/mcp/registry.ts'
import type { UpstreamClient } from '../../src/mcp/upstream.ts'

// The getting-started documentation lives in the Explorer UI (explorer-ui
// /mcp), and only there. This file pins the consequences of that decision on
// this service: `/` and `/start` hand a visitor over to the Explorer, this
// process ships no HTML of its own, and the one thing the Explorer page cannot
// know at build time — the registered tool list — is served here as plain JSON
// for it to fetch.
//
// The `light-my-request` injector is enough for all of it: none of these routes
// hijacks the reply the way POST /mcp does.

const upstream: UpstreamClient = {
  async get() {
    throw new Error('the page test must not reach the explorer api')
  },
}

let app: FastifyInstance
const routes: { method: string | string[]; url: string }[] = []

beforeAll(async () => {
  app = await buildMcpApp({ logger: false, upstream, onRoute: route => routes.push(route) })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('the documentation lives in the Explorer, not here', () => {
  it('redirects / and /start to the Explorer page', async () => {
    for (const url of ['/', '/start']) {
      const res = await app.inject({ method: 'GET', url })
      // 302, not 301: where the documentation lives is a product decision, and
      // a permanently-cached redirect would outlive a change of mind in every
      // browser that ever followed it.
      expect(res.statusCode, url).toBe(302)
      expect(res.headers.location, url).toBe(`${mcpConfig.explorerPublicUrl}/mcp`)
    }
  })

  it('serves no HTML at all', async () => {
    for (const url of ['/', '/start', '/llms.txt', '/mcp.json', '/tools.json', '/health']) {
      const res = await app.inject({ method: 'GET', url })
      expect(String(res.headers['content-type'] ?? ''), url).not.toMatch(/text\/html/)
    }
  })

  it('registers no page route and no static template', () => {
    // The whole surface, pinned: a new route here is a deliberate change, and
    // a static or template-serving one would be the page coming back.
    // ('*' is the CORS plugin's own catch-all.)
    const urls = [...new Set(routes.map(r => r.url))].sort()
    expect(urls).toEqual(['*', '/', '/favicon.ico', '/health', '/llms.txt', '/mcp', '/mcp.json', '/start', '/tools.json'])
    // The template and its boot-time read are gone together: a file left behind
    // would be a second copy of the page waiting to drift from the Explorer's.
    expect(existsSync(new URL('../../src/mcp/page/start.html', import.meta.url))).toBe(false)
    const source = readFileSync(new URL('../../src/mcp/app.ts', import.meta.url), 'utf8')
    expect(source, 'app.ts must not read a template file any more').not.toMatch(/readFileSync/)
    for (const placeholder of ['{{ORIGIN}}', '{{EXPLORER_URL}}', '{{TOOL_COUNT}}', '{{TOOL_TABLE_JSON}}']) {
      expect(source, `the ${placeholder} substitution belongs to a page this service no longer serves`).not.toContain(placeholder)
    }
  })

  it('points a 404 at the Explorer page rather than at itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().gettingStarted).toBe(`${mcpConfig.explorerPublicUrl}/mcp`)
  })
})

describe('GET /tools.json', () => {
  it('renders the registry with the three fields the page draws', async () => {
    const res = await app.inject({ method: 'GET', url: '/tools.json' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toEqual(TOOL_DEFINITIONS.map(t => ({ name: t.name, title: t.title, description: t.description })))
    for (const tool of body) {
      expect(Object.keys(tool).sort(), `${tool.name} must carry exactly name, title and description`).toEqual(['description', 'name', 'title'])
      expect(typeof tool.name).toBe('string')
      expect(typeof tool.title).toBe('string')
      expect(typeof tool.description).toBe('string')
    }
  })

  it('is readable from the Explorer origin', async () => {
    // The page fetches this cross-origin (the Explorer host is not this one),
    // so the app-wide `origin: '*'` policy has to reach this route too.
    const res = await app.inject({
      method: 'GET',
      url: '/tools.json',
      headers: { origin: 'https://hydration-explorer.neckwork.net' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })
})
