import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The dashboard is served from a background build: a reader never waits on a rebuild
// once a build exists, and the prewarm rebuilds only when the snapshot it reads changed.

const state = vi.hoisted(() => ({ snap: null as null | { block: number; readAt: number; vaults: unknown[]; events: unknown[]; loop: null }, builds: 0 }))

vi.mock('../src/services/juicerState.ts', () => ({ currentJuicerSnapshot: () => state.snap }))
vi.mock('../src/services/positionYield.ts', () => ({ getExplorerYields: async () => ({}) }))
vi.mock('../src/services/explorerService.ts', () => ({
  accountRef: (a: string) => ({ address: a }),
  ensurePrices: async () => new Map(),
  juicerPartyAccounts: async () => new Map(),
  juicerRowsValued: async () => { state.builds++; return [] },
  moneyMarketIdentities: () => ({ h160s: [] }),
  resolveRelatedAccounts: async () => null,
}))

const snapAt = (readAt: number) => ({ block: 100 + readAt, readAt, vaults: [], events: [], loop: null })

describe('juicer dashboard cache', () => {
  beforeEach(() => { vi.resetModules(); state.snap = null; state.builds = 0 })
  afterEach(async () => { (await import('../src/services/cache.ts')).resetCacheForTests() })

  it('builds once before any snapshot (the boot build), then once per snapshot', async () => {
    const { getJuicerDashboard, prewarmJuicerDashboard } = await import('../src/services/juicerService.ts')
    await prewarmJuicerDashboard()
    await prewarmJuicerDashboard()
    expect(state.builds).toBe(1)
    // A reader before the first snapshot is answered from the boot build, not a build of its own.
    expect((await getJuicerDashboard()).asOfBlock).toBeNull()
    expect(state.builds).toBe(1)
    state.snap = snapAt(1)
    await prewarmJuicerDashboard()
    await prewarmJuicerDashboard()
    expect(state.builds).toBe(2)
    state.snap = snapAt(2)
    await prewarmJuicerDashboard()
    expect(state.builds).toBe(3)
  })

  it('answers readers from the prewarmed build, and from the previous build across a snapshot change', async () => {
    const { getJuicerDashboard, prewarmJuicerDashboard } = await import('../src/services/juicerService.ts')
    state.snap = snapAt(1)
    await prewarmJuicerDashboard()
    const first = await getJuicerDashboard()
    expect(state.builds).toBe(1)
    expect(first.generatedAt).toBeTruthy()
    expect(first.asOfBlock).toBe(101)
    state.snap = snapAt(2)
    const during = await getJuicerDashboard()
    expect(during.asOfBlock).toBe(101)
    await prewarmJuicerDashboard()
    expect((await getJuicerDashboard()).asOfBlock).toBe(102)
  })
})
