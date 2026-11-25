import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { archiveUrl, rehostImage, spacedQueue } from '../../src/governance/subsquare/images.js'
import type { KuboClient } from '../../src/governance/subsquare/kubo.js'
import { SafeFetchError, type ResolvedTarget } from '../../src/governance/subsquare/safeFetch.js'
import { parseItem, parsePollVotes } from '../../src/governance/subsquare/parse.js'
import { bannerUrl } from '../../src/governance/subsquare/rows.js'
import { pollJsonOf, pollSettled } from '../../src/governance/subsquare/sync.js'

// The Internet Archive as the last source for an image whose host and IPFS providers
// are gone; banners in the image pass; poll results in both of Subsquare's shapes.

const CID = 'Qm' + '1'.repeat(44)
const IPFS_URL = `https://subsquare.infura-ipfs.io/ipfs/${CID}`

function png(): Uint8Array {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 } return (~c) >>> 0 }
  const chunk = (type: string, data: number[]) => {
    const t = Buffer.from(type, 'latin1'), d = Buffer.from(data), len = Buffer.alloc(4), c = Buffer.alloc(4)
    len.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([t, d])))
    return Buffer.concat([len, t, d, c])
  }
  return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]), chunk('IDAT', [1, 2, 3]), chunk('IEND', [])]))
}

function response(status: number, body: Buffer | Uint8Array | string = '', headers: Record<string, string> = {}): IncomingMessage {
  const s = new PassThrough() as unknown as IncomingMessage & PassThrough
  Object.assign(s, { statusCode: status, headers })
  ;(s as PassThrough).end(Buffer.from(body as Uint8Array))
  return s
}

/** A network where the original host answers `original`, and the archive serves `archived` after one redirect to its capture. */
function network(original: () => IncomingMessage, archived: () => IncomingMessage) {
  const seen: string[] = []
  const request = async (target: ResolvedTarget) => {
    seen.push(target.url.href)
    if (target.url.hostname !== 'web.archive.org') return original()
    if (target.url.pathname.startsWith('/web/20000101000000id_/')) return response(302, '', { location: target.url.href.replace('20000101000000id_', '20240130045025id_') })
    return archived()
  }
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
  return { seen, fetchOptions: { resolve, request } }
}

function fakeKubo(reproduces: boolean) {
  const calls: string[] = []
  const k = {
    rootStat: vi.fn(async () => { calls.push('stat'); throw new Error('no providers') }),
    cat: vi.fn(),
    cidParams: vi.fn(async () => ({ version: 0, codec: 'dag-pb', hash: 'sha2-256' })),
    add: vi.fn(async (_b: Uint8Array, o: { onlyHash?: boolean; pin?: boolean } = {}) => { calls.push(o.onlyHash ? 'rehash' : o.pin ? 'add-pinned' : 'add'); return reproduces || !o.onlyHash ? (o.onlyHash || o.pin ? CID : 'bafkrei' + 'a'.repeat(52)) : 'Qm' + '2'.repeat(44) }),
    pinAdd: vi.fn(async () => { calls.push('pin'); return true }),
    pinRm: vi.fn(async () => {}),
    repoGc: vi.fn(async () => {}),
  }
  return { kubo: k as unknown as KuboClient, calls }
}

const queue = <T>(fn: () => Promise<T>) => fn()

describe('the archive fallback', () => {
  it('a dead IPFS image is recovered from the archive only when the capture reproduces its CID, and pinned under it', async () => {
    const net = network(() => response(504), () => response(200, png(), { 'content-type': 'image/png' }))
    const { kubo, calls } = fakeKubo(true)
    const r = await rehostImage(IPFS_URL, undefined, { kubo, now: () => 0, fetchOptions: net.fetchOptions, archiveThrottle: queue })
    expect(r).toMatchObject({ kind: 'archived', media: { cid: CID, origin: 'wayback-cid', mime: 'image/png' }, url: { status: 'ok', cid: CID } })
    expect(calls).toEqual(['stat', 'rehash', 'rehash', 'add-pinned'])
    expect(net.seen).toEqual([IPFS_URL, archiveUrl(IPFS_URL), archiveUrl(IPFS_URL)!.replace('20000101000000id_', '20240130045025id_')])
  })

  it('a capture that does not reproduce the CID is refused', async () => {
    const net = network(() => response(504), () => response(200, png()))
    const { kubo, calls } = fakeKubo(false)
    const r = await rehostImage(IPFS_URL, undefined, { kubo, now: () => 0, fetchOptions: net.fetchOptions, archiveThrottle: queue })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'archive:cid-mismatch' } })
    expect(calls).not.toContain('add-pinned')
  })

  it('a dead non-IPFS image is recovered from its capture, stripped and added like a direct fetch', async () => {
    const net = network(() => response(503), () => response(200, png()))
    const { kubo } = fakeKubo(true)
    const r = await rehostImage('https://i.ibb.co/Y9fKvT5/x.png', undefined, { kubo, now: () => 0, fetchOptions: net.fetchOptions, archiveThrottle: queue })
    expect(r).toMatchObject({ kind: 'archived', media: { origin: 'wayback' } })
  })

  it('with no capture the direct failure is reported, and a captured error page is no image', async () => {
    const none = network(() => response(503), () => response(404, '<html>'))
    expect(await rehostImage('https://i.ibb.co/a/b.png', undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetchOptions: none.fetchOptions, archiveThrottle: queue }))
      .toMatchObject({ kind: 'failed', url: { reason: 'fetch:http-503' } })
    const page = network(() => response(503), () => response(200, '<html>gone</html>'))
    expect(await rehostImage('https://i.ibb.co/a/b.png', undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetchOptions: page.fetchOptions, archiveThrottle: queue }))
      .toMatchObject({ kind: 'failed', url: { reason: expect.stringMatching(/^archive:image:/) } })
  })

  it('the archive goes through the SSRF guard too', async () => {
    const resolve = async (host: string) => [{ address: host === 'web.archive.org' ? '10.0.0.5' : '93.184.216.34', family: 4 }]
    const request = async () => response(503)
    const r = await rehostImage('https://i.ibb.co/a/b.png', undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetchOptions: { resolve, request }, archiveThrottle: queue })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'fetch:http-503' } })
  })

  it.each([404, 410, 451])('is never asked after the host answered %i: a takedown stays down', async status => {
    const net = network(() => response(status), () => response(200, png()))
    const r = await rehostImage('https://i.ibb.co/a/b.png', undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetchOptions: net.fetchOptions, archiveThrottle: queue })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: `fetch:http-${status}` } })
    expect(net.seen).toEqual(['https://i.ibb.co/a/b.png'])
  })

  it('names a capture under the raw-capture path, whatever dot segments the original carries', () => {
    const prefix = 'https://web.archive.org/web/20000101000000id_/'
    expect(archiveUrl('https://i.ibb.co/a/b.png')).toBe(`${prefix}https://i.ibb.co/a/b.png`)
    expect(archiveUrl('https://img.example/ä b.png?x=1&y=ä')).toBe(`${prefix}https://img.example/%C3%A4%20b.png?x=1&y=%C3%A4`)
    // Dot segments are resolved inside the original: the capture path keeps its prefix.
    expect(archiveUrl('https://attacker.example/../../../../../save/https://victim.example/')).toBe(`${prefix}https://attacker.example/save/https://victim.example/`)
    expect(archiveUrl('https://attacker.example/%2e%2e/%2e%2e/%2E%2e/save/https://victim.example/')).toBe(`${prefix}https://attacker.example/save/https://victim.example/`)
    expect(archiveUrl('https://attacker.example/a/.%2e/..\\..\\save/x')).toBe(`${prefix}https://attacker.example/save/x`)
    // What would still be resolved against the capture path is refused, never rewritten.
    for (const url of ['https://../save/https://victim.example/', 'https://%2e%2e/save/x', 'foo:../../../save/https://victim.example/', 'not a url']) {
      expect(archiveUrl(url), url).toBeNull()
    }
  })

  it('is not tried when the original cannot be named as a capture', async () => {
    const net = network(() => response(503), () => response(200, png()))
    const url = 'https://../save/https://victim.example/'
    expect(await rehostImage(url, undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetch: async u => { net.seen.push(u); throw new SafeFetchError('http-503') }, archiveThrottle: queue }))
      .toMatchObject({ kind: 'failed', url: { reason: 'fetch:http-503' } })
    expect(net.seen).toEqual([url])
  })

  it('is not tried without its queue', async () => {
    const net = network(() => response(404), () => response(200, png()))
    expect(await rehostImage('https://i.ibb.co/a/b.png', undefined, { kubo: fakeKubo(true).kubo, now: () => 0, fetchOptions: net.fetchOptions })).toMatchObject({ kind: 'failed' })
    expect(net.seen).toEqual(['https://i.ibb.co/a/b.png'])
  })

  it('the queue runs one request at a time, a second apart', async () => {
    let now = 0
    const starts: number[] = []
    const q = spacedQueue(1_000, () => now, async ms => { now += ms })
    await Promise.all([1, 2, 3].map(() => q(async () => { starts.push(now); now += 200 })))
    expect(starts).toEqual([0, 1000, 2000])
  })
})

describe('banners', () => {
  it('are keyed by Subsquare\'s gateway URL for the CID, which the image pass pins by that CID', () => {
    expect(bannerUrl(CID)).toBe(IPFS_URL)
    expect(bannerUrl('')).toBeNull()
    expect(bannerUrl('not-a-cid')).toBeNull()
  })
})

describe('poll results', () => {
  const author = (pk: string) => ({ username: `polkadot-key-0x${pk}`, publicKey: pk, address: null, emailMd5: 'abc' })
  const poll = (anonymous: boolean) => parseItem('discussions', {
    _id: '777777777777777777777777', postUid: '73', title: 't', content: '', createdAt: '2023-05-02T00:00:00Z', author: author('ab'.repeat(32)),
    poll: { _id: '999999999999999999999999', title: 'Q?', options: ['Yes', 'No'], expiresTime: 1683793260000, anonymous },
  })!.poll!

  it('reads an anonymous poll\'s counts', () => {
    expect(parsePollVotes({ Yes: 3, No: 5 })).toEqual({ counts: { Yes: 3, No: 5 }, voters: null })
    expect(pollJsonOf(poll(true), parsePollVotes({ Yes: 3 }))).toBe(JSON.stringify({ title: 'Q?', options: ['Yes', 'No'], expiresTime: 1683793260000, anonymous: true, votes: { Yes: 3 } }))
  })

  it('reads a public poll\'s voters, counting them and naming them by account, never by email hash', () => {
    const v = parsePollVotes({ Yes: [author('aa'.repeat(32)), author('bb'.repeat(32))], No: [{ username: 'legacy-bob' }] })
    expect(v?.counts).toEqual({ Yes: 2, No: 1 })
    const json = pollJsonOf(poll(false), v)
    expect(JSON.parse(json)).toEqual({
      title: 'Q?', options: ['Yes', 'No'], expiresTime: 1683793260000, anonymous: false,
      votes: { Yes: 2, No: 1 }, voters: { Yes: ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)], No: ['legacy:legacy-bob'] },
    })
    expect(json).not.toContain('emailMd5')
    expect(json).not.toContain('abc')
  })

  it('refuses any other shape', () => {
    expect(parsePollVotes([1, 2])).toBeNull()
    expect(parsePollVotes({ Yes: 'three' })).toBeNull()
    expect(parsePollVotes({ Yes: [42] })).toBeNull()
    expect(parsePollVotes({ Yes: [{ username: '' }] })).toBeNull()
  })

  it('a poll with its results stored in full is never read again; one missing its voters is', () => {
    expect(pollSettled(JSON.stringify({ anonymous: true, votes: { Yes: 1 } }))).toBe(true)
    expect(pollSettled(JSON.stringify({ anonymous: false, votes: { Yes: 1 }, voters: { Yes: ['0x'] } }))).toBe(true)
    expect(pollSettled(JSON.stringify({ anonymous: false, votes: { Yes: 1 } }))).toBe(false)
    expect(pollSettled(JSON.stringify({ anonymous: false }))).toBe(false)
    expect(pollSettled('')).toBe(false)
  })
})
