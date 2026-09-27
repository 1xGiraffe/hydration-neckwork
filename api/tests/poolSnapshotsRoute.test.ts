import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// /explorer/pool/:poolId/snapshots — the route's own contract: which query
// shapes reach the service and with what defaults, which are refused with a
// 400 that names the rule, and a 404 for a share-token id no pool carries.
vi.mock('../src/services/poolService.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/poolService.ts')>(),
  getPoolSnapshots: vi.fn(async (poolId: number) => (poolId === 999 ? null : { poolId, points: [] })),
  getOmnipoolSnapshots: vi.fn(async (ids: number[]) => (ids.includes(99_999) || ids.includes(1) ? { neverListed: ids.filter(i => i === 99_999 || i === 1) } : { kind: 'omnipool', points: [] })),
}))

const svc = await import('../src/services/poolService.ts')
const { poolsRoutes } = await import('../src/routes/pools.ts')

describe('pool snapshots route', () => {
  const app = Fastify()
  beforeAll(async () => { await app.register(poolsRoutes) })
  afterAll(async () => { await app.close() })
  beforeEach(() => { vi.mocked(svc.getPoolSnapshots).mockClear() })

  it('defaults to the grid at 200 points and passes a full request through', async () => {
    const bare = await app.inject('/explorer/pool/143/snapshots')
    expect(bare.statusCode).toBe(200)
    expect(vi.mocked(svc.getPoolSnapshots)).toHaveBeenLastCalledWith(143, { resolution: 'grid', limit: 200 })

    const full = await app.inject('/explorer/pool/143/snapshots?fromBlock=100&toBlock=200&resolution=day&limit=5')
    expect(full.statusCode).toBe(200)
    expect(vi.mocked(svc.getPoolSnapshots)).toHaveBeenLastCalledWith(143, { fromBlock: 100, toBlock: 200, resolution: 'day', limit: 5 })

    const timed = await app.inject('/explorer/pool/143/snapshots?fromTs=1700000000&toTs=1700003600&resolution=hour')
    expect(timed.statusCode).toBe(200)
    expect(vi.mocked(svc.getPoolSnapshots)).toHaveBeenLastCalledWith(143, { fromTs: 1_700_000_000, toTs: 1_700_003_600, resolution: 'hour', limit: 200 })

    const strided = await app.inject('/explorer/pool/143/snapshots?stepBlocks=1200&limit=1000')
    expect(strided.statusCode).toBe(200)
    expect(vi.mocked(svc.getPoolSnapshots)).toHaveBeenLastCalledWith(143, { stepBlocks: 1_200, resolution: 'grid', limit: 1_000 })
  })

  it('refuses what the schema or the request rules reject, naming the rule', async () => {
    for (const [bad, rule] of [
      ['limit=0', /limit/],
      ['limit=1001', /limit/],
      ['resolution=minute', /resolution/],
      ['fromBlock=x', /fromBlock/],
      ['fromBlock=200&toBlock=100', /fromBlock must not exceed toBlock/],
      ['fromTs=2&toTs=1', /fromTs must not exceed toTs/],
      ['resolution=block&fromTs=1', /fromBlock\/toBlock/],
      ['resolution=day&stepBlocks=600', /grid/],
    ] as const) {
      const res = await app.inject(`/explorer/pool/143/snapshots?${bad}`)
      expect(res.statusCode, bad).toBe(400)
      expect(res.json().error, bad).toMatch(rule)
    }
    expect(vi.mocked(svc.getPoolSnapshots)).not.toHaveBeenCalled()
    expect((await app.inject('/explorer/pool/abc/snapshots')).statusCode).toBe(400)
  })

  it('answers 404 for a share-token id no pool carries', async () => {
    const res = await app.inject('/explorer/pool/999/snapshots')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Pool not found' })
  })
})

describe('omnipool snapshots route', () => {
  const app = Fastify()
  beforeAll(async () => { await app.register(poolsRoutes) })
  afterAll(async () => { await app.close() })
  beforeEach(() => { vi.mocked(svc.getOmnipoolSnapshots).mockClear() })

  it('passes the asset list and the shared window contract through', async () => {
    const bare = await app.inject('/explorer/omnipool/snapshots?asset=222')
    expect(bare.statusCode).toBe(200)
    expect(vi.mocked(svc.getOmnipoolSnapshots)).toHaveBeenLastCalledWith([222], { resolution: 'grid', limit: 200 })
    const full = await app.inject('/explorer/omnipool/snapshots?asset=0,222,1001&fromBlock=100&toBlock=200&resolution=day&limit=5')
    expect(full.statusCode).toBe(200)
    expect(vi.mocked(svc.getOmnipoolSnapshots)).toHaveBeenLastCalledWith([0, 222, 1001], { fromBlock: 100, toBlock: 200, resolution: 'day', limit: 5 })
  })

  it('refuses a missing or malformed asset and the shared request rules, naming the rule', async () => {
    for (const [bad, rule] of [
      ['', /asset is required/],
      ['asset=HOLLAR', /not an asset id/],
      ['asset=0,1,2,3,4,5,6,7,8', /at most 8/],
      ['asset=222&limit=1001', /limit/],
      ['asset=222&fromBlock=200&toBlock=100', /fromBlock must not exceed toBlock/],
      ['asset=222&resolution=block&fromTs=1', /fromBlock\/toBlock/],
    ] as const) {
      const res = await app.inject(`/explorer/omnipool/snapshots?${bad}`)
      expect(res.statusCode, bad).toBe(400)
      expect(res.json().error, bad).toMatch(rule)
    }
    expect(vi.mocked(svc.getOmnipoolSnapshots)).not.toHaveBeenCalled()
  })

  it('answers 404 naming the ids the Omnipool never held, the hub asset among them', async () => {
    const res = await app.inject('/explorer/omnipool/snapshots?asset=222,99999')
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/Not an Omnipool asset: 99999 has never been listed/)
    const hub = await app.inject('/explorer/omnipool/snapshots?asset=1')
    expect(hub.statusCode).toBe(404)
    expect(hub.json().error).toMatch(/H2O, asset 1, is its hub asset/)
  })
})
