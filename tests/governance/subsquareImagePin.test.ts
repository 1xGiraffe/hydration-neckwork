import { describe, expect, it, vi } from 'vitest'
import { isSubsquareHost, rehostImage } from '../../src/governance/subsquare/images.js'
import type { KuboClient } from '../../src/governance/subsquare/kubo.js'
import { SubsquareClient } from '../../src/governance/subsquare/client.js'
import { authorKey } from '../../src/governance/subsquare/authors.js'
import { sanitizeImage } from '../../src/governance/subsquare/imageSanitize.js'

// An image already on IPFS is pinned by its own CID — but only after it has been
// validated: capped by its root block's stated size before any data is fetched, read
// with a length cap, walked unstripped (trailing bytes refused), re-hashed with the
// CID's own parameters to reproduce the CID. A refused CID is never pinned, and the
// blocks it left behind are garbage the cycle collects.

const CID = 'Qm' + '1'.repeat(44)
const URL_ = `https://subsquare.infura-ipfs.io/ipfs/${CID}`

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

function fakeKubo(over: Partial<Record<keyof KuboClient, unknown>> = {}) {
  const calls: string[] = []
  const bytes = png()
  const k = {
    rootStat: vi.fn(async () => { calls.push('stat'); return { size: bytes.length, cumulativeSize: bytes.length + 14, type: 'file' } }),
    cat: vi.fn(async () => { calls.push('cat'); return bytes }),
    cidParams: vi.fn(async () => ({ version: 0, codec: 'dag-pb', hash: 'sha2-256' })),
    add: vi.fn(async (_b: Uint8Array, o: { onlyHash?: boolean }) => { calls.push(o.onlyHash ? 'rehash' : 'add'); return CID }),
    pinAdd: vi.fn(async () => { calls.push('pin'); return true }),
    pinRm: vi.fn(async () => {}),
    repoGc: vi.fn(async () => {}),
    ...over,
  }
  return { kubo: k as unknown as KuboClient, calls, bytes }
}

describe('pinning an image by its existing CID', () => {
  it('stats, reads, validates and re-hashes before it pins', async () => {
    const { kubo, calls } = fakeKubo()
    const r = await rehostImage(URL_, undefined, { kubo, now: () => 0 })
    expect(r.kind).toBe('pinned-cid')
    expect(r.media).toMatchObject({ cid: CID, mime: 'image/png', origin: 'subsquare-cid' })
    expect(calls).toEqual(['stat', 'cat', 'rehash', 'pin'])
  })

  it('refuses an oversized CID from its root block alone, fetching nothing', async () => {
    const garbage = vi.fn()
    const { kubo, calls } = fakeKubo({ rootStat: vi.fn(async () => ({ size: 50 * 1024 * 1024, cumulativeSize: 50 * 1024 * 1024, type: 'file' })) })
    const r = await rehostImage(URL_, undefined, { kubo, now: () => 0, onGarbage: garbage })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'image:too-large' } })
    expect(calls).not.toContain('cat')
    expect(calls).not.toContain('pin')
    expect(garbage).toHaveBeenCalled()
  })

  it('never pins bytes that do not reproduce the CID, nor ones with a trailing payload', async () => {
    const garbage = vi.fn()
    const mismatch = fakeKubo({ add: vi.fn(async () => 'Qm' + '2'.repeat(44)) })
    expect(await rehostImage(URL_, undefined, { kubo: mismatch.kubo, now: () => 0, onGarbage: garbage })).toMatchObject({ kind: 'failed', url: { reason: 'cid-mismatch' } })
    expect(mismatch.calls).not.toContain('pin')
    const tail = fakeKubo()
    const withTail = Uint8Array.from([...tail.bytes, 0x3c, 0x73])
    ;(tail.kubo.cat as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(withTail)
    expect(await rehostImage(URL_, undefined, { kubo: tail.kubo, now: () => 0, onGarbage: garbage })).toMatchObject({ kind: 'failed', url: { reason: 'image:trailing-bytes' } })
    expect(tail.calls).not.toContain('pin')
    expect(garbage).toHaveBeenCalledTimes(2)
    expect(sanitizeImage(tail.bytes, { strip: false }).mime).toBe('image/png')
  })

  it('falls back to the guarded HTTPS fetch when the IPFS network cannot supply it, through the shared limiter', async () => {
    const { kubo } = fakeKubo({ rootStat: vi.fn(async () => { throw new Error('timeout') }) })
    let throttled = 0
    const throttle = async <T>(fn: () => Promise<T>): Promise<T> => { throttled++; return fn() }
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])
    const r = await rehostImage(URL_, undefined, { kubo, now: () => 0, throttle, fetchOptions: { resolve } })
    expect(throttled).toBe(1)
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'fetch:private-address' } })
  })
})

describe('Subsquare-owned image hosts', () => {
  it('names Subsquare\'s own hosts and its IPFS gateway, nothing else', () => {
    expect(isSubsquareHost('https://static.subsquare.io/a.png')).toBe(true)
    expect(isSubsquareHost(URL_)).toBe(true)
    expect(isSubsquareHost('https://i.ibb.co/x.png')).toBe(false)
    expect(isSubsquareHost('https://evil.com/subsquare.io')).toBe(false)
    expect(isSubsquareHost('https://subsquare.io.evil.com/a')).toBe(false)
  })

  it('paces a throttled fetch with the API calls: one in flight, one interval apart', async () => {
    let now = 0
    const starts: number[] = []
    const sleep = async (ms: number) => { now += ms }
    const client = new SubsquareClient({
      baseUrl: 'https://api.example', rps: 1, now: () => now, sleep,
      fetchImpl: (async () => { starts.push(now); return new Response('{}', { status: 200 }) }) as typeof fetch,
    })
    await client.get('/a')
    await client.throttle(async () => { starts.push(now) })
    await client.get('/b')
    expect(starts.slice(1).map((t, i) => t - starts[i])).toEqual([1000, 1000])
    expect(client.requests).toBe(3)
  })
})

describe('author keys', () => {
  it('accepts only hex public keys', () => {
    const base = { username: 'u', address: null }
    expect(authorKey({ ...base, publicKey: 'ab'.repeat(32) } as never)).toMatchObject({ ok: true, accountId: '0x' + 'ab'.repeat(32) })
    expect(authorKey({ ...base, publicKey: 'zz'.repeat(32) } as never)).toEqual({ ok: false, reason: 'unresolvable' })
    expect(authorKey({ ...base, publicKey: '0x' + 'ab'.repeat(32) } as never)).toMatchObject({ ok: true })
  })
})
