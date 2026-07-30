import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/explorer'

describe('explorer API cancellation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('passes the caller AbortSignal through to fetch', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const request = api.blocks(25, 0, controller.signal)
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledWith('/api/explorer/blocks?limit=25&offset=0', { signal: controller.signal })
  })

  it('makes close-account analysis cancellable when the viewed address changes', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const request = api.closeAccounts('1abc', controller.signal)
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledWith('/api/explorer/address/1abc/close-accounts', { signal: controller.signal })
  })
})
