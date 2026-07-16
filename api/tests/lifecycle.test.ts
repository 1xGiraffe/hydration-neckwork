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
    startIdentityRefresh()
    startIdentityRefresh()
    startEvmBindingsRefresh()
    startEvmBindingsRefresh()
    startAccountSuffixRefresh()
    startAccountSuffixRefresh()

    expect(vi.getTimerCount()).toBe(3)
    stopIdentityRefresh()
    stopExplorerBackgroundTasks()
    expect(vi.getTimerCount()).toBe(0)
  })
})
