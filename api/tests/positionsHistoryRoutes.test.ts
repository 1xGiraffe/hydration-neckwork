import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The order-history / positions-presence / liquidity-rewards routes and their tag and
// list-tag twins: one query parser (kind all|dca|limit, offset, limit ≤ 100, default
// 25), the resolved scope handed to the service, 404 for a scope that is not there.
vi.mock('../src/services/positionsPresence.ts', async importOriginal => {
  const page = (q: unknown) => ({ total: 0, offset: 0, limit: 25, rows: [], q })
  return {
    ...await importOriginal<typeof import('../src/services/positionsPresence.ts')>(),
    getAddressOrderHistory: vi.fn(async (a: string, q: unknown) => (a === 'missing' ? null : page(q))),
    getTagOrderHistory: vi.fn(async (t: string, q: unknown) => (t === 'missing' ? null : page(q))),
    getListTagOrderHistory: vi.fn(async (_l: string, _t: string, _m: string[], q: unknown) => page(q)),
    getAddressPositionsPresence: vi.fn(async (a: string) => (a === 'missing' ? null : { orderHistory: 3, liquidityHistory: true, moneyMarketHistory: false })),
    getTagPositionsPresence: vi.fn(async () => ({ orderHistory: 0, liquidityHistory: false, moneyMarketHistory: false })),
    getListTagPositionsPresence: vi.fn(async () => ({ orderHistory: 1, liquidityHistory: false, moneyMarketHistory: true })),
    getAddressLiquidityRewards: vi.fn(async () => ({ rows: [], totalClaimedUsd: 0, unpricedClaims: 0 })),
    getTagLiquidityRewards: vi.fn(async (t: string) => (t === 'missing' ? null : { rows: [], totalClaimedUsd: 0, unpricedClaims: 0 })),
    getListTagLiquidityRewards: vi.fn(async () => ({ rows: [], totalClaimedUsd: 1, unpricedClaims: 0 })),
  }
})

const svc = await import('../src/services/positionsPresence.ts')
const { explorerRoutes } = await import('../src/routes/explorer.ts')
const { listTagReadRoutes } = await import('../src/routes/listTagRoutes.ts')

const MEMBERS = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`]
const ADDR = '7KATdGakyhfBGnAt3XVgXTL7cYjzRXeSZHezKNtENcbwWibb'

describe('positions history routes', () => {
  const app = Fastify()
  beforeAll(async () => {
    await app.register(explorerRoutes)
    await app.register(async f => listTagReadRoutes(f, {
      base: '/test/list-tag/:tagId',
      resolve: () => ({ listId: 'L1', tagId: 'T1', tag: { name: 'n', color: '#000', icon: '', note: '', members: MEMBERS } }),
      valueFilters: () => ({}),
    }))
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => vi.clearAllMocks())

  it('parses the order-history query once for every scope', async () => {
    const def = await app.inject(`/explorer/address/${ADDR}/order-history`)
    expect(def.statusCode).toBe(200)
    expect(vi.mocked(svc.getAddressOrderHistory)).toHaveBeenLastCalledWith(ADDR, { kind: 'all', offset: 0, limit: 25 })

    expect((await app.inject('/explorer/tag/treasury/order-history?kind=limit&offset=50&limit=100')).statusCode).toBe(200)
    expect(vi.mocked(svc.getTagOrderHistory)).toHaveBeenLastCalledWith('treasury', { kind: 'limit', offset: 50, limit: 100 })

    expect((await app.inject('/test/list-tag/T1/order-history?kind=dca')).statusCode).toBe(200)
    expect(vi.mocked(svc.getListTagOrderHistory)).toHaveBeenLastCalledWith('L1', 'T1', MEMBERS, { kind: 'dca', offset: 0, limit: 25 })

    for (const bad of ['kind=twap', 'limit=0', 'limit=101', 'offset=-1', 'offset=x']) {
      expect((await app.inject(`/explorer/tag/treasury/order-history?${bad}`)).statusCode, bad).toBe(400)
      expect((await app.inject(`/test/list-tag/T1/order-history?${bad}`)).statusCode, bad).toBe(400)
    }
    expect((await app.inject('/explorer/tag/missing/order-history')).statusCode).toBe(404)
  })

  it('serves presence and claimed rewards for each scope', async () => {
    expect((await app.inject(`/explorer/address/${ADDR}/positions-presence`)).json()).toEqual({ orderHistory: 3, liquidityHistory: true, moneyMarketHistory: false })
    expect((await app.inject('/explorer/tag/treasury/positions-presence')).statusCode).toBe(200)
    expect((await app.inject('/test/list-tag/T1/positions-presence')).json().moneyMarketHistory).toBe(true)
    expect(vi.mocked(svc.getListTagPositionsPresence)).toHaveBeenLastCalledWith('L1', 'T1', MEMBERS)

    expect((await app.inject(`/explorer/address/${ADDR}/liquidity-rewards`)).statusCode).toBe(200)
    expect((await app.inject('/explorer/tag/missing/liquidity-rewards')).statusCode).toBe(404)
    expect((await app.inject('/test/list-tag/T1/liquidity-rewards')).json().totalClaimedUsd).toBe(1)
  })
})
