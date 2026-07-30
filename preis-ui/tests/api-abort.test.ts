import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAssets } from '../src/api/assets'
import { fetchIndexerStatus } from '../src/api/indexer'
import { fetchMarketStats } from '../src/api/marketStats'

describe('query cancellation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['/api/assets', fetchAssets],
    ['/api/indexer', fetchIndexerStatus],
    ['/api/market-stats', fetchMarketStats],
  ] as const)('passes AbortSignal to %s', async (url, request) => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const pending = request(controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledWith(url, { signal: controller.signal })
  })
})
