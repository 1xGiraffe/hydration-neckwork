import { afterEach, describe, expect, it, vi } from 'vitest'

// The api's calls to the forum IPFS node's RPC carry its bearer token (IPFS_TOKEN_API),
// which ops/ipfs-init.sh scopes to add, pin/rm, repo/stat and repo/gc.

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

describe('forum media → IPFS RPC authorization', () => {
  it('sends Authorization: Bearer <IPFS_TOKEN_API> on every RPC call', async () => {
    vi.stubEnv('IPFS_TOKEN_API', 'a'.repeat(64))
    const seen: Array<{ url: string; auth: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { seen.push({ url, auth: new Headers(init?.headers).get('authorization') }); return new Response('', { status: 200 }) }))
    const media = await import('../src/services/forumMedia.ts')
    await media.kuboUnpin('bafkreicudippknz34poet7cuf7m2mulxwzsk5qa4rwdar6m6n3evk56yye')
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) expect(s.auth, s.url).toBe(`Bearer ${'a'.repeat(64)}`)
    expect(seen.map(s => new URL(s.url).pathname)).toContain('/api/v0/pin/rm')
  })

  it('sends no Authorization header when no token is configured', async () => {
    vi.stubEnv('IPFS_TOKEN_API', '')
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('authorization')); return new Response('', { status: 200 }) }))
    const media = await import('../src/services/forumMedia.ts')
    await media.kuboUnpin('bafkreicudippknz34poet7cuf7m2mulxwzsk5qa4rwdar6m6n3evk56yye', false)
    expect(seen).toEqual([null])
  })
})
