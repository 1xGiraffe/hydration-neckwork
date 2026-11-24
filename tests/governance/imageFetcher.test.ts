import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetcherHandler, remoteSafeFetch } from '../../src/governance/subsquare/imageFetcher.js'
import { SafeFetchError, safeFetch, type SafeFetchOptions } from '../../src/governance/subsquare/safeFetch.js'

// The isolated image fetcher: the sync's guarded fetch, run in a container that reaches
// the internet and no other service. Over the wire it must behave exactly like the
// local safeFetch — the bytes and metadata, or the guard's refusal reason.

let server: Server | null = null
afterEach(async () => { await new Promise<void>(r => server ? server.close(() => r()) : r()); server = null })

async function start(handler: ReturnType<typeof fetcherHandler>): Promise<string> {
  server = createServer(handler)
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

describe('image fetcher', () => {
  it('returns the fetched bytes, content type and final URL', async () => {
    const seen: Array<{ url: string; options?: SafeFetchOptions }> = []
    const base = await start(fetcherHandler(async (url, options) => {
      seen.push({ url, options })
      return { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', finalUrl: 'https://img.example/a.png?x=1&y=ä' }
    }))
    const r = await remoteSafeFetch(base)('https://img.example/a', { maxBytes: 999, timeoutMs: 5000, maxRedirects: 1 })
    expect([...r.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(r.contentType).toBe('image/png')
    expect(r.finalUrl).toBe('https://img.example/a.png?x=1&y=ä')
    expect(seen).toEqual([{ url: 'https://img.example/a', options: { maxBytes: 999, timeoutMs: 5000, maxRedirects: 1 } }])
  })

  it('carries the guard\'s refusal reason back as the same SafeFetchError (the real guard, nothing connected)', async () => {
    const base = await start(fetcherHandler(safeFetch))
    const remote = remoteSafeFetch(base)
    const reasons: Record<string, string> = {
      'http://db:8123/?query=SELECT%201': 'scheme',
      'https://10.0.2.1/x.png': 'ip-literal',
      'https://storage:5001/api/v0/version': 'port',
    }
    for (const [url, reason] of Object.entries(reasons)) {
      const err = await remote(url).then(() => null, e => e)
      expect(err, url).toBeInstanceOf(SafeFetchError)
      expect((err as SafeFetchError).reason, url).toBe(reason)
    }
  })

  it('clamps the bounds a caller sends and refuses anything but POST /fetch with a URL', async () => {
    const seen: SafeFetchOptions[] = []
    const base = await start(fetcherHandler(async (_url, options) => { seen.push(options!); return { bytes: Buffer.alloc(1), contentType: '', finalUrl: '' } }))
    await fetch(`${base}/fetch`, { method: 'POST', body: JSON.stringify({ url: 'https://a.example/x', maxBytes: 1e12, timeoutMs: 1e9, maxRedirects: 50 }) })
    expect(seen[0]).toEqual({ maxBytes: 5 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 2 })
    expect((await fetch(`${base}/fetch`)).status).toBe(404)
    expect((await fetch(`${base}/other`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${base}/fetch`, { method: 'POST', body: '{"url":5}' })).status).toBe(400)
    expect((await fetch(`${base}/fetch`, { method: 'POST', body: 'x'.repeat(20_000) })).status).toBe(413)
  })

  it('reports an unreachable fetcher as a transient `fetcher` failure', async () => {
    const err = await remoteSafeFetch('http://127.0.0.1:9')('https://a.example/x', { timeoutMs: 500 }).then(() => null, e => e)
    expect(err).toBeInstanceOf(SafeFetchError)
    expect((err as SafeFetchError).reason).toBe('fetcher')
  })
})

describe('the image pass with an unreachable fetcher', () => {
  it('defers the image (nothing recorded, no attempt spent) instead of failing it', async () => {
    const { rehostImage } = await import('../../src/governance/subsquare/images.js')
    const kubo = { add: async () => { throw new Error('unused') }, pinRm: async () => undefined } as unknown as import('../../src/governance/subsquare/kubo.js').KuboClient
    const r = await rehostImage('https://img.example/a.png', undefined, {
      kubo, now: () => 0, fetch: remoteSafeFetch('http://127.0.0.1:9'), fetchOptions: { timeoutMs: 500 },
      archiveThrottle: fn => fn(),
    })
    expect(r).toMatchObject({ kind: 'deferred', reason: 'fetcher-unavailable', url: null, media: null })
  })
})
