import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAssets, stopAssetsRefresh } from '../src/services/assetsService.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'
import { startIdentityRefresh, stopIdentityRefresh } from '../src/services/identityService.ts'
import {
  startAccountSuffixRefresh,
  startEvmBindingsRefresh,
  stopExplorerBackgroundTasks,
} from '../src/services/explorerService.ts'

const emptyClient = {
  query: vi.fn(async () => ({ json: async () => [] })),
} as never

describe('background refresh lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopAssetsRefresh()
    stopExplorerAssetsRefresh()
    stopIdentityRefresh()
    stopExplorerBackgroundTasks()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('starts asset refresh loops once and stops them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await loadAssets(emptyClient)
    await loadAssets(emptyClient)
    await loadExplorerAssets(emptyClient)
    await loadExplorerAssets(emptyClient)

    expect(vi.getTimerCount()).toBe(2)
    stopAssetsRefresh()
    stopExplorerAssetsRefresh()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps explicit refresh starters idempotent and cancellable', () => {
    // A starter may own more than one timer — the EVM-bindings one runs a slow full
    // reload alongside a fast incremental poll — so what is pinned per starter is the
    // behaviour, not a count: the first call arms at least one timer, a second call
    // arms none, and the stoppers take every one of them back down.
    const starters: [string, () => void][] = [
      ['identity', startIdentityRefresh],
      ['evm-bindings', startEvmBindingsRefresh],
      ['account-suffix', startAccountSuffixRefresh],
    ]
    let running = 0
    for (const [name, start] of starters) {
      start()
      expect(vi.getTimerCount(), name).toBeGreaterThan(running)
      running = vi.getTimerCount()
      start()
      expect(vi.getTimerCount(), name).toBe(running)
    }

    stopIdentityRefresh()
    stopExplorerBackgroundTasks()
    expect(vi.getTimerCount()).toBe(0)
  })
})
