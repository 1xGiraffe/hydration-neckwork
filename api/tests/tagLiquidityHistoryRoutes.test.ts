import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The tag and list-tag twins of /explorer/address/:a/liquidity-history: the same
// optional block window (neither bound → the whole range, a valid pair → that
// window, anything else → 400) handed to the member-set builder, and a 404 for a
// tag that is not there. Money-market history is not aggregated to tags.
const EMPTY = { stepSec: 0, priceGrain: '1d', dates: [], blocks: [] }
vi.mock('../src/services/explorerService.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/explorerService.ts')>(),
  getTagLiquidityHistory: vi.fn(async (tagId: string) => (tagId === 'missing' ? null : { ...EMPTY, kind: 'lp' })),
  getListTagLiquidityHistory: vi.fn(async () => ({ ...EMPTY, kind: 'lp' })),
}))

const svc = await import('../src/services/explorerService.ts')
const { explorerRoutes } = await import('../src/routes/explorer.ts')
const { listTagReadRoutes } = await import('../src/routes/listTagRoutes.ts')

const MEMBERS = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`]

describe('tag liquidity-history routes', () => {
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
  beforeEach(() => { vi.mocked(svc.getTagLiquidityHistory).mockClear(); vi.mocked(svc.getListTagLiquidityHistory).mockClear(); })

  for (const [path, kind, fn] of [
    ['liquidity-history', 'lp', () => svc.getTagLiquidityHistory],
  ] as const) {
    it(`/explorer/tag/:tagId/${path}: whole range, window, bad window, missing tag`, async () => {
      const all = await app.inject(`/explorer/tag/treasury/${path}`)
      expect(all.statusCode).toBe(200)
      expect(all.json().kind).toBe(kind)
      expect(vi.mocked(fn())).toHaveBeenLastCalledWith('treasury', undefined)

      const zoom = await app.inject(`/explorer/tag/treasury/${path}?fromBlock=100&toBlock=200`)
      expect(zoom.statusCode).toBe(200)
      expect(vi.mocked(fn())).toHaveBeenLastCalledWith('treasury', { fromBlock: 100, toBlock: 200 })

      for (const bad of ['fromBlock=100', 'toBlock=200', 'fromBlock=200&toBlock=100', 'fromBlock=x&toBlock=2']) {
        expect((await app.inject(`/explorer/tag/treasury/${path}?${bad}`)).statusCode, bad).toBe(400)
      }
      expect((await app.inject(`/explorer/tag/missing/${path}`)).statusCode).toBe(404)
    })
  }

  for (const [path, kind, fn] of [
    ['liquidity-history', 'lp', () => svc.getListTagLiquidityHistory],
  ] as const) {
    it(`list tag ${path}: the resolved list tag's members, same window rules`, async () => {
      const all = await app.inject(`/test/list-tag/T1/${path}`)
      expect(all.statusCode).toBe(200)
      expect(all.json().kind).toBe(kind)
      expect(vi.mocked(fn())).toHaveBeenLastCalledWith('L1', 'T1', MEMBERS, undefined)
      await app.inject(`/test/list-tag/T1/${path}?fromBlock=5&toBlock=9`)
      expect(vi.mocked(fn())).toHaveBeenLastCalledWith('L1', 'T1', MEMBERS, { fromBlock: 5, toBlock: 9 })
      expect((await app.inject(`/test/list-tag/T1/${path}?fromBlock=9&toBlock=5`)).statusCode).toBe(400)
    })
  }
})
