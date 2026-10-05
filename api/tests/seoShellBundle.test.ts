import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadShell, bundleIdFromHeader, shellMatchesBundle, ShellBundleMismatch, __testing } from '../src/routes/seo.ts'

// The bundle-identity handshake: a page shell is served only when it names the
// entry chunk of the nginx that asked (X-Bundle-Id), so a UI deploy can never
// leave the renderer handing out a shell whose chunks are gone.
const html = (id: string) => `<html><head><script type="module" src="/assets/index-${id}.js"></script></head><body><div id="root"></div></body></html>`

function mockFetch(bodies: string[]) {
  const fn = vi.fn(async () => new Response(bodies.length > 1 ? bodies.shift()! : bodies[0], { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals(); __testing.loadShellReset() })

describe('seo shell bundle handshake', () => {
  it('parses only a plausible bundle id', () => {
    expect(bundleIdFromHeader('BxK3_a-9')).toBe('BxK3_a-9')
    expect(bundleIdFromHeader(['abcd1234'])).toBe('abcd1234')
    expect(bundleIdFromHeader('')).toBeNull()
    expect(bundleIdFromHeader('a.b/../c')).toBeNull()
    expect(bundleIdFromHeader(undefined)).toBeNull()
    expect(shellMatchesBundle(html('abcd1234'), 'abcd1234')).toBe(true)
    expect(shellMatchesBundle(html('abcd1234'), 'abcd123')).toBe(false)
  })

  it('serves the cached shell while it matches, without refetching', async () => {
    const f = mockFetch([html('aaaa1111')])
    expect(await loadShell('aaaa1111')).toContain('index-aaaa1111')
    expect(await loadShell('aaaa1111')).toContain('index-aaaa1111')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refetches at once when the asking nginx serves a new bundle', async () => {
    const f = mockFetch([html('aaaa1111'), html('bbbb2222')])
    await loadShell('aaaa1111')
    expect(await loadShell('bbbb2222')).toContain('index-bbbb2222')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('refuses a shell that still names another bundle (route answers 502 → static shell)', async () => {
    mockFetch([html('aaaa1111')])
    await expect(loadShell('bbbb2222')).rejects.toBeInstanceOf(ShellBundleMismatch)
  })

  it('collapses a burst of mismatched requests into one fetch', async () => {
    const f = mockFetch([html('aaaa1111'), html('bbbb2222')])
    await loadShell('aaaa1111')
    const out = await Promise.all([1, 2, 3, 4, 5].map(() => loadShell('bbbb2222')))
    expect(out.every(h => h.includes('index-bbbb2222'))).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('never falls back to a stale shell of the wrong bundle when the fetch fails', async () => {
    mockFetch([html('aaaa1111')])
    await loadShell('aaaa1111')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await expect(loadShell('bbbb2222')).rejects.toThrow('down')
  })

  it('re-reads a matching shell in the background once it is a minute old (index.html can change under the same entry id)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const f = mockFetch([html('aaaa1111'), html('aaaa1111').replace('<head>', '<head><meta name="v" content="2">')])
      await loadShell('aaaa1111')
      vi.setSystemTime(Date.now() + 61_000)
      expect(await loadShell('aaaa1111')).not.toContain('content="2"') // served at once, refresh in flight
      await vi.waitFor(async () => expect(await loadShell('aaaa1111')).toContain('content="2"'))
      expect(f).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('remembers a mismatch for a moment, so a burst during the swap costs one fetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const f = mockFetch([html('aaaa1111')])
      await expect(loadShell('bbbb2222')).rejects.toBeInstanceOf(ShellBundleMismatch)
      await expect(loadShell('bbbb2222')).rejects.toBeInstanceOf(ShellBundleMismatch)
      expect(f).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 2_000)
      await expect(loadShell('bbbb2222')).rejects.toBeInstanceOf(ShellBundleMismatch)
      expect(f).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
