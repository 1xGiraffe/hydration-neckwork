import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DataRouteInfo } from '../../src/data/app.ts'
import { buildDataApp } from '../../src/data/app.ts'
import type { ClickHouseClient } from '../../src/db/client.ts'
import { fakeDataClient } from './helpers.ts'

// Two invariants pinned here, both load-bearing for the contract:
//  1. Every registered /v1 route is documented in /openapi.json with a 200
//     schema (the public API's coverage test, via fastify's own onRoute
//     events so parameterised paths cannot hide).
//  2. The route SET equals the concept's surface (§ 4) — no stub domain can
//     silently ship empty, and no route can appear undocumented in the plan.
let app: FastifyInstance
let routes: DataRouteInfo[]

function documentedForm(routeUrls: string[]): string[] {
  return routeUrls.map(url => url.replace(/:([^/]+)/g, '{$1}'))
}

function contractPaths(observed: DataRouteInfo[]): string[] {
  const urls = observed.map(route => route.url).filter(url => url.startsWith('/v1/'))
  return [...new Set(documentedForm(urls))]
}

// The complete /v1 surface (concept § 4). Adding a route means adding it here;
// removing or renaming one within /v1 is a contract break and needs a /v2.
const EXPECTED_PATHS = [
  '/v1/status',
  '/v1/blocks',
  '/v1/blocks/{heightOrHash}',
  '/v1/blocks/{height}/extrinsics',
  '/v1/blocks/{height}/events',
  '/v1/extrinsics',
  '/v1/extrinsics/{id}',
  '/v1/extrinsics/{id}/events',
  '/v1/events',
  '/v1/events/{id}',
  '/v1/accounts/{address}',
  '/v1/accounts/{address}/balances',
  '/v1/accounts/{address}/balances/history',
  '/v1/accounts/{address}/events',
  '/v1/accounts/{address}/extrinsics',
  '/v1/accounts/{address}/transfers',
  '/v1/accounts/{address}/trades',
  '/v1/accounts/{address}/dca',
  '/v1/accounts/{address}/otc',
  '/v1/accounts/{address}/otc/fills',
  '/v1/accounts/{address}/staking',
  '/v1/accounts/{address}/votes',
  '/v1/accounts/{address}/liquidity',
  '/v1/accounts/{address}/liquidity/positions',
  '/v1/accounts/{address}/xcm',
  '/v1/accounts/{address}/money-market',
  '/v1/accounts/{address}/liquidations',
  '/v1/accounts/{address}/fees',
  '/v1/assets',
  '/v1/assets/{id}',
  '/v1/assets/{id}/price',
  '/v1/assets/{id}/candles',
  '/v1/assets/{id}/transfers',
  '/v1/assets/{id}/swaps',
  '/v1/assets/{id}/holders',
  '/v1/pools',
  '/v1/pools/omnipool/{assetId}/history',
  '/v1/pools/stableswap/{poolId}/history',
  '/v1/pools/xyk/{poolAccount}/history',
  '/v1/pools/{venue}/{poolKey}/trades',
  '/v1/pools/{venue}/{poolKey}/volumes',
  '/v1/trades',
  '/v1/dca/schedules',
  '/v1/dca/schedules/{id}',
  '/v1/dca/schedules/{id}/executions',
  '/v1/otc/orders',
  '/v1/otc/orders/{id}',
  '/v1/otc/orders/{id}/events',
  '/v1/governance/referenda',
  '/v1/governance/referenda/{pallet}/{index}',
  '/v1/governance/referenda/{pallet}/{index}/votes',
  '/v1/governance/votes',
  '/v1/staking/events',
  '/v1/xcm/transfers',
  '/v1/evm/transactions/{txHash}',
  '/v1/evm/contracts/{address}',
  '/v1/evm/contracts/{address}/logs',
  '/v1/evm/contracts/{address}/abi',
  '/v1/stats/volume',
  '/v1/stats/revenue',
  '/v1/stats/active-accounts',
  '/v1/stats/tvl',
].sort()

beforeAll(async () => {
  routes = []
  app = await buildDataApp({
    client: fakeDataClient() as unknown as ClickHouseClient,
    logger: false,
    onRoute: route => routes.push(route),
  })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('data OpenAPI document', () => {
  it('names the service and declares bearer auth globally', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    expect(doc.info.title).toBe('Hydration Data API')
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(doc.security).toEqual([{ bearerAuth: [] }])
  })

  it('registers exactly the planned /v1 surface', () => {
    expect(contractPaths(routes).sort()).toEqual(EXPECTED_PATHS)
  })

  it('documents every registered /v1 route', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const documented = Object.keys(doc.paths ?? {})
    expect(contractPaths(routes).filter(path => !documented.includes(path))).toEqual([])
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

  it('exempts only the status probe from the global security requirement', async () => {
    const doc = (await app.inject('/openapi.json')).json()
    const exempted: string[] = []
    for (const [path, methods] of Object.entries(doc.paths as Record<string, Record<string, { security?: unknown[] }>>)) {
      for (const operation of Object.values(methods)) {
        if (Array.isArray(operation.security) && operation.security.length === 0) exempted.push(path)
      }
    }
    expect(exempted).toEqual(['/v1/status'])
  })
})
