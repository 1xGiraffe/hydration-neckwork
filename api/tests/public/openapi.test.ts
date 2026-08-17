import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { PublicRouteInfo } from '../../src/public/app.ts'
import { PUBLIC_ROUTE_PLUGINS, buildPublicApp } from '../../src/public/app.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'

// Every public route is part of a documented contract, so the OpenAPI document
// must describe all of them. A route that ships without a zod schema silently
// disappears from /openapi.json — this test is what catches that.
//
// The route list comes from fastify's own `onRoute` registration events
// (buildPublicApp's `onRoute` observer), never from parsing printRoutes(): that
// output nests children under a shared prefix, so `/v1/trades/:id` prints as
// `/:id` and a "does the document cover every route" assertion over it would
// pass vacuously for exactly the parameterised shapes this API is full of.
let app: FastifyInstance
let routes: PublicRouteInfo[]

function fakeClient() {
  return { query: vi.fn(() => { throw new Error('no query expected while building the app') }) } as unknown as ClickHouseClient
}

// Registered paths in OpenAPI path form (`:account` -> `{account}`).
function documentedForm(routeUrls: string[]): string[] {
  return routeUrls.map(url => url.replace(/:([^/]+)/g, '{$1}'))
}

function contractPaths(observed: PublicRouteInfo[]): string[] {
  const urls = observed.map(route => route.url).filter(url => url.startsWith('/v1/') || url.startsWith('/rest/'))
  return [...new Set(documentedForm(urls))]
}

beforeAll(async () => {
  routes = []
  app = await buildPublicApp({ client: fakeClient(), logger: false, onRoute: route => routes.push(route) })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('public OpenAPI document', () => {
  it('names the service and its version', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    expect(doc.info.title).toBe('Hydration Public API')
    expect(doc.info.version).toBeTruthy()
  })

  it('documents every registered /v1 and /rest route', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const expected = contractPaths(routes)
    expect(expected).toEqual(expect.arrayContaining(['/rest/service/health', '/rest/service/metadata', '/v1/status', '/v1/assets']))
    const documented = Object.keys(doc.paths ?? {})
    expect(expected.filter(path => !documented.includes(path))).toEqual([])
  })

  it('declares a 200 response schema for every documented path', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const missing: string[] = []
    for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.responses?.['200']) missing.push(`${method.toUpperCase()} ${path}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('collects nested and parameterised routes, not just their shared prefix', async () => {
    // The failure mode this collector exists to rule out: a child route under an
    // existing prefix (the shape /v1/dca/schedules/:id/executions has) must be
    // reported with its FULL path, so an undocumented one cannot hide.
    const nested: FastifyPluginAsync<{ client: ClickHouseClient }> = async fastify => {
      const typed = fastify.withTypeProvider<ZodTypeProvider>()
      const schema = { response: { 200: z.object({ ok: z.boolean() }) } }
      typed.get('/v1/probe/things', { schema }, async () => ({ ok: true }))
      typed.get('/v1/probe/things/:id/parts', { schema }, async () => ({ ok: true }))
    }
    PUBLIC_ROUTE_PLUGINS.push(nested)
    const observed: PublicRouteInfo[] = []
    let probeApp: FastifyInstance | undefined
    try {
      probeApp = await buildPublicApp({ client: fakeClient(), logger: false, onRoute: route => observed.push(route) })
      await probeApp.ready()
      const paths = contractPaths(observed)
      expect(paths).toContain('/v1/probe/things')
      expect(paths).toContain('/v1/probe/things/{id}/parts')
      const doc = (await probeApp.inject('/openapi.json')).json()
      expect(paths.filter(path => !Object.keys(doc.paths ?? {}).includes(path))).toEqual([])
    } finally {
      PUBLIC_ROUTE_PLUGINS.pop()
      await probeApp?.close()
    }
  })
})
