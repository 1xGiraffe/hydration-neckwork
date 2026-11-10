import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const { getHdxDashboard } = vi.hoisted(() => ({ getHdxDashboard: vi.fn() }))
vi.mock('../src/services/hdxService.ts', async importOriginal => ({ ...(await importOriginal<object>()), getHdxDashboard }))

const { explorerRoutes } = await import('../src/routes/explorer.ts')

async function hdxResponse(historyPending: boolean) {
  getHdxDashboard.mockReset().mockResolvedValue({ price: 0.01, structure: historyPending ? null : { weeks: [] }, churn: null, historyPending })
  const app = Fastify()
  await app.register(explorerRoutes)
  const response = await app.inject('/explorer/hdx')
  await app.close()
  return response
}

describe('GET /explorer/hdx', () => {
  it('keeps a build without its history out of every cache, so the page\'s poll reaches the api', async () => {
    const response = await hdxResponse(true)
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json().historyPending).toBe(true)
  })

  it('leaves a complete build to the route\'s own caching', async () => {
    const response = await hdxResponse(false)
    expect(response.headers['cache-control']).toBeUndefined()
  })
})
