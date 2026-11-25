import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isPublicAddress, safeFetch, vetUrl, type ResolvedTarget } from '../../src/governance/subsquare/safeFetch.js'

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  const ips = map[host]
  if (!ips) throw new Error('ENOTFOUND')
  return ips.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
}

function response(status: number, body: Buffer | string = '', headers: Record<string, string> = {}): IncomingMessage {
  const s = new PassThrough() as unknown as IncomingMessage & PassThrough
  Object.assign(s, { statusCode: status, headers })
  ;(s as PassThrough).end(body)
  return s
}

describe('SSRF guard: addresses', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.17.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.5',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1',
    // Teredo, benchmarking, ORCHID and ORCHIDv2, and the second documentation block.
    '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', '2001:2:0:ffff::1', '2001:10::1', '2001:1f:ffff::1', '2001:20::1', '2001:2f:ffff::1', '3fff::1', '3fff:fff:ffff::1',
  ])('refuses %s', ip => expect(isPublicAddress(ip)).toBe(false))

  it.each(['1.1.1.1', '104.16.0.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8',
    // Neighbours of the blocked blocks inside 2000::/3 stay public.
    '2001:1::1', '2001:2:1::1', '2001:30::1', '2001:4860:4860::8888', '2001:db9::1', '2003::1', '3fff:1000::1'])('allows %s', ip => expect(isPublicAddress(ip)).toBe(true))
})

describe('SSRF guard: URLs', () => {
  const dns = resolver({ 'img.example.com': ['93.184.216.34'], 'inside.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'], 'rebind.example.com': ['::1'] })

  it.each([
    ['http://img.example.com/a.png', 'scheme'],
    ['ftp://img.example.com/a.png', 'scheme'],
    ['https://img.example.com:8443/a.png', 'port'],
    ['https://127.0.0.1/a.png', 'ip-literal'],
    ['https://[::1]/a.png', 'ip-literal'],
    ['https://2130706433/a.png', 'ip-literal'], // decimal 127.0.0.1
    ['https://0x7f000001/a.png', 'ip-literal'],
    ['https://localhost/a.png', 'private-host'],
    // A trailing dot names the same host.
    ['https://localhost./a.png', 'private-host'],
    ['https://foo.localhost./a.png', 'private-host'],
    ['https://metadata.google.internal./a.png', 'private-host'],
    ['https://a.b.local./a.png', 'private-host'],
    ['https://a.b.local../a.png', 'private-host'],
    ['https://clickhouse./?query=SELECT', 'private-host'],
    ['https://inside.example.com./a.png', 'private-address'],
    ['https://clickhouse/?query=SELECT', 'private-host'],
    ['https://user:pw@img.example.com/a.png', 'credentials'],
    ['https://inside.example.com/a.png', 'private-address'],
    ['https://mixed.example.com/a.png', 'private-address'],
    ['https://rebind.example.com/a.png', 'private-address'],
    ['https://unknown.example.com/a.png', 'dns'],
  ])('refuses %s (%s)', async (url, reason) => {
    await expect(vetUrl(url, dns)).rejects.toMatchObject({ reason })
  })

  it('connects to the vetted address for a public host', async () => {
    expect(await vetUrl('https://img.example.com/a.png', dns)).toMatchObject({ address: '93.184.216.34', family: 4 })
    expect(await vetUrl('https://img.example.com./a.png', dns)).toMatchObject({ address: '93.184.216.34', family: 4 })
  })

  it('bounds the DNS lookup by the fetch\'s timeout: a lookup that never answers does not hang it', async () => {
    const never = () => new Promise<Array<{ address: string; family: number }>>(() => {})
    let requested = false
    const started = Date.now()
    await expect(safeFetch('https://img.example.com/a.png', { resolve: never, timeoutMs: 50, request: async () => { requested = true; return response(200) } }))
      .rejects.toMatchObject({ reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(requested).toBe(false)
    const controller = new AbortController()
    const vetting = vetUrl('https://img.example.com/a.png', never, controller.signal)
    controller.abort()
    await expect(vetting).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('re-checks every redirect hop and allows at most two', async () => {
    const seen: string[] = []
    const hops: Record<string, IncomingMessage | (() => IncomingMessage)> = {}
    const request = async (t: ResolvedTarget) => { seen.push(t.url.toString()); const r = hops[t.url.toString()]; return typeof r === 'function' ? r() : r }
    hops['https://img.example.com/a.png'] = () => response(302, '', { location: 'https://inside.example.com/secret' })
    await expect(safeFetch('https://img.example.com/a.png', { resolve: dns, request })).rejects.toMatchObject({ reason: 'private-address' })
    expect(seen).toEqual(['https://img.example.com/a.png'])

    hops['https://img.example.com/a.png'] = () => response(302, '', { location: '/b.png' })
    hops['https://img.example.com/b.png'] = () => response(302, '', { location: '/c.png' })
    hops['https://img.example.com/c.png'] = () => response(302, '', { location: '/d.png' })
    await expect(safeFetch('https://img.example.com/a.png', { resolve: dns, request })).rejects.toMatchObject({ reason: 'redirects' })

    hops['https://img.example.com/c.png'] = () => response(200, 'PNGDATA', { 'content-type': 'image/png' })
    const ok = await safeFetch('https://img.example.com/a.png', { resolve: dns, request })
    expect(ok.bytes.toString()).toBe('PNGDATA')
    expect(ok.finalUrl).toBe('https://img.example.com/c.png')
  })

  it('enforces the size cap while streaming, whatever the headers claim', async () => {
    const request = async () => response(200, Buffer.alloc(2048))
    await expect(safeFetch('https://img.example.com/a.png', { resolve: dns, request, maxBytes: 1024 })).rejects.toMatchObject({ reason: 'too-large' })
    const declared = async () => response(200, 'x', { 'content-length': '99999999' })
    await expect(safeFetch('https://img.example.com/a.png', { resolve: dns, request: declared })).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('refuses a non-200 answer', async () => {
    await expect(safeFetch('https://img.example.com/a.png', { resolve: dns, request: async () => response(404) })).rejects.toMatchObject({ reason: 'http-404' })
  })
})
