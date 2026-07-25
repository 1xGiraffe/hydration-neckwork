import { afterEach, describe, expect, it, vi } from 'vitest'
import { substrateAllKeys } from '../src/services/substrateRpc.ts'

// A truncated key set is indistinguishable from a smaller map, and callers publish it
// as current chain state — a half-read Balances.Locks would report locked accounts as
// unlocked and the snapshot it replaces is deleted. Enumeration therefore has to fail
// loudly; every caller keeps its previous snapshot when a refresh throws.
const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `0x${(offset + i).toString(16).padStart(4, '0')}`)

const respond = (bodies: (string[] | 'fail')[]) => {
  let call = 0
  return vi.fn(async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)]
    if (body === 'fail') return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => ({ result: body }) }
  })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('substrateAllKeys', () => {
  it('returns every key of a complete enumeration', async () => {
    vi.stubGlobal('fetch', respond([page(1000), page(1000, 1000), page(7, 2000)]))

    await expect(substrateAllKeys('0xprefix')).resolves.toHaveLength(2007)
  })

  it('throws when a page fails mid-enumeration', async () => {
    vi.stubGlobal('fetch', respond([page(1000), 'fail']))

    await expect(substrateAllKeys('0xprefix')).rejects.toThrow(/failed for 0xprefix at page 1/)
  })

  it('throws when the first page fails', async () => {
    vi.stubGlobal('fetch', respond(['fail']))

    await expect(substrateAllKeys('0xprefix')).rejects.toThrow(/failed for 0xprefix at page 0/)
  })

  it('throws rather than truncating at the page bound', async () => {
    vi.stubGlobal('fetch', respond([page(1000), page(1000, 1000), page(1000, 2000)]))

    await expect(substrateAllKeys('0xprefix', 2)).rejects.toThrow(/exceeded 2 pages/)
  })

  it('accepts a genuinely empty map', async () => {
    vi.stubGlobal('fetch', respond([[]]))

    await expect(substrateAllKeys('0xprefix')).resolves.toEqual([])
  })
})
