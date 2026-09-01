import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DataRouteInfo } from '../../src/data/app.ts'
import { buildDataApp } from '../../src/data/app.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'
import { fakeDataClient } from './helpers.ts'

// /llms.txt is generated from the OpenAPI document, so the invariant worth
// pinning is that it stays a COMPLETE and CHEAP map of the surface: every
// registered /v1 route appears with its summary (a new route cannot ship
// invisible to an agent), and the whole file stays small enough to be read
// before the ~60x larger document it points at.

let app: FastifyInstance
let routes: DataRouteInfo[]
let body: string

beforeAll(async () => {
  routes = []
  app = await buildDataApp({
    client: fakeDataClient() as unknown as ClickHouseClient,
    logger: false,
    onRoute: route => routes.push(route),
  })
  await app.ready()
  body = (await app.inject('/llms.txt')).body
})

afterAll(async () => {
  await app?.close()
})

describe('/llms.txt', () => {
  it('serves markdown in the llmstxt.org shape without a token', async () => {
    const res = await app.inject('/llms.txt')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/markdown/)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    const [heading, blank, summary] = res.body.split('\n')
    expect(heading).toBe('# Hydration Data API')
    expect(blank).toBe('')
    expect(summary.startsWith('> ')).toBe(true)
    expect(summary.length).toBeGreaterThan(80)
  })

  it('lists every registered /v1 route with its summary', () => {
    const paths = [...new Set(routes
      .map(route => route.url.replace(/:([^/]+)/g, '{$1}'))
      .filter(url => url.startsWith('/v1/')))]
    const missing = paths.filter(path => !body.includes(`\`GET ${path}\` — `))
    expect(missing).toEqual([])
    // Each path appears exactly once: an entry per route, not per tag.
    for (const path of paths) {
      expect(body.split(`\`GET ${path}\``).length - 1).toBe(1)
    }
  })

  it('carries the conventions and points at the normative document', () => {
    expect(body).toContain('## Endpoints')
    expect(body).toContain('## Conventions')
    expect(body).toContain('## Full contract')
    expect(body).toMatch(/Base URL: https?:\/\/\S+\. Every path below is relative to it\./)
    expect(body).toContain('/openapi.json')
    expect(body).toContain('/docs')
  })

  it('stays an orientation, not a second copy of the spec', async () => {
    const spec = (await app.inject('/openapi.json')).body
    // Budget: a few thousand tokens at ~4 chars each, and far below the
    // document it summarises — parameters and response schemas stay there.
    expect(body.length).toBeLessThan(16_000)
    expect(body.length).toBeLessThan(spec.length / 5)
  })
})
