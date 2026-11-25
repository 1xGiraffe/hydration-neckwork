import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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

  it('never compresses its answer, whatever the client accepts', async () => {
    const ok = await start(fetcherHandler(async () => ({ bytes: Buffer.alloc(4096), contentType: 'image/png', finalUrl: '' })))
    for (const url of ['https://a.example/x', 'http://db:8123/']) {
      const res = await fetch(`${ok}/fetch`, { method: 'POST', headers: { 'Accept-Encoding': 'gzip, br, deflate' }, body: JSON.stringify({ url }) })
      expect(res.headers.get('content-encoding')).toBeNull()
      await res.arrayBuffer()
    }
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

describe('the sync reading a fetcher answer', () => {
  /** A fake fetcher: answers every request with `status` and `headers`, then writes 64 KiB chunks until the client hangs up. */
  async function endless(status: number, headers: Record<string, string> = {}) {
    const state = { acceptEncoding: undefined as string | undefined, sent: 0, closed: false }
    const base = await start(((req: IncomingMessage, res: ServerResponse) => {
      state.acceptEncoding = req.headers['accept-encoding']
      req.resume()
      res.writeHead(status, headers)
      const chunk = Buffer.alloc(64 * 1024)
      const pump = () => {
        while (!res.destroyed && state.sent < 64 * 1024 * 1024) {
          state.sent += chunk.length
          if (!res.write(chunk)) { res.once('drain', pump); return }
        }
      }
      res.on('close', () => { state.closed = true })
      pump()
    }))
    return { base, state }
  }
  const settle = () => new Promise(r => setTimeout(r, 50))

  it('asks for an uncompressed answer and refuses a compressed one before reading it', async () => {
    const f = await endless(200, { 'Content-Encoding': 'gzip' })
    const err = await remoteSafeFetch(f.base)('https://a.example/x', { maxBytes: 1000, timeoutMs: 5000 }).then(() => null, e => e)
    expect(err).toBeInstanceOf(SafeFetchError)
    expect((err as SafeFetchError).reason).toBe('fetcher')
    expect(f.state.acceptEncoding).toBe('identity')
  })

  it('caps the image body while it streams', async () => {
    const f = await endless(200)
    const err = await remoteSafeFetch(f.base)('https://a.example/x', { maxBytes: 1000, timeoutMs: 5000 }).then(() => null, e => e)
    expect((err as SafeFetchError).reason).toBe('too-large')
    await settle()
    expect(f.state.closed).toBe(true)
    expect(f.state.sent).toBeLessThan(64 * 1024 * 1024)
  })

  it('refuses a declared length over the cap before reading', async () => {
    const base = await start((_req, res) => { res.writeHead(200, { 'Content-Length': '99999999' }); res.write(Buffer.alloc(10)) })
    const err = await remoteSafeFetch(base)('https://a.example/x', { maxBytes: 1000, timeoutMs: 5000 }).then(() => null, e => e)
    expect((err as SafeFetchError).reason).toBe('too-large')
  })

  it('reads at most 1 KiB of a refusal', async () => {
    const f = await endless(422, { 'Content-Type': 'application/json' })
    const err = await remoteSafeFetch(f.base)('https://a.example/x', { maxBytes: 1000, timeoutMs: 5000 }).then(() => null, e => e)
    expect((err as SafeFetchError).reason).toBe('fetch')
    await settle()
    expect(f.state.closed).toBe(true)
  })
})
