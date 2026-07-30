import { afterEach, describe, expect, it, vi } from 'vitest'
import { substrateAllKeys, substrateKeysPaged, substrateStorageBatch } from '../src/services/substrateRpc.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('substrate RPC response boundaries', () => {
  it('maps valid batch ids and ignores out-of-range or malformed ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, result: '0x02' },
        { id: 999_999, result: '0xff' },
        { id: -1, result: '0xff' },
        { id: 0.5, result: '0xff' },
        { id: 0, result: '0x01' },
      ],
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(substrateStorageBatch(['0xaa', '0xbb'])).resolves.toEqual(['0x01', '0x02'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('filters non-string storage keys and rejects invalid page sizes locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['0xaa', 42, null, '0xbb'] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(substrateKeysPaged('0x00', 100, null)).resolves.toEqual(['0xaa', '0xbb'])
    await expect(substrateKeysPaged('0x00', 0, null)).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates pages and stops when a node repeats the cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: ['0xaa', '0xbb'] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: ['0xbb', '0xbb'] }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(substrateAllKeys('0x00', 10, 2)).resolves.toEqual(['0xaa', '0xbb'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
