import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { rehostImage } from '../../src/governance/subsquare/images.js'
import { IMAGES_PER_BODY, ImageBudget, SYNC_DAILY_BYTES, SYNC_DAILY_IMAGES, SYNC_DAILY_IMAGES_PER_AUTHOR, imageCandidates } from '../../src/governance/subsquare/imagePlan.js'
import type { KuboClient } from '../../src/governance/subsquare/kubo.js'
import type { ResolvedTarget } from '../../src/governance/subsquare/safeFetch.js'

// What the sync may store: never a CID a moderator removed (however the image is
// spelled), only what visible items reference, and never past the repo ceiling or the
// daily caps — the same bounds uploads have.

const CID = 'Qm' + '1'.repeat(44)
const STRIPPED = 'bafkrei' + 'a'.repeat(52)

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

const ok = () => {
  const s = new PassThrough() as unknown as IncomingMessage & PassThrough
  Object.assign(s, { statusCode: 200, headers: { 'content-type': 'image/png' } })
  ;(s as PassThrough).end(Buffer.from(png()))
  return s
}
const fetchOptions = { resolve: async () => [{ address: '93.184.216.34', family: 4 }], request: async (_t: ResolvedTarget) => ok() }

function kubo(cidOfBytes = STRIPPED) {
  const calls: string[] = []
  const k = {
    rootStat: vi.fn(async () => { calls.push('stat'); return { size: 100, cumulativeSize: 114, type: 'file' } }),
    cat: vi.fn(async () => { calls.push('cat'); return png() }),
    cidParams: vi.fn(async () => ({ version: 0, codec: 'dag-pb', hash: 'sha2-256' })),
    add: vi.fn(async (_b: Uint8Array, o: { onlyHash?: boolean } = {}) => { calls.push(o.onlyHash ? 'hash' : 'add'); return o.onlyHash ? cidOfBytes : cidOfBytes }),
    pinAdd: vi.fn(async () => { calls.push('pin'); return true }),
    pinRm: vi.fn(async () => { calls.push('unpin') }),
    repoStat: vi.fn(async () => ({ repoSize: 0, storageMax: 2e9 })),
  }
  return { kubo: k as unknown as KuboClient, calls }
}

describe('a CID moderators removed', () => {
  it('is refused by its own URL before anything is fetched or pinned', async () => {
    const k = kubo()
    const r = await rehostImage(`https://ipfs.io/ipfs/${CID}`, undefined, { kubo: k.kubo, now: () => 0, refuseCid: c => c === CID })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'removed', status: 'failed' }, media: null })
    expect(k.calls).toEqual([])
  })

  it('is refused under another URL whose bytes hash to it (the same image stripped again), before it is added', async () => {
    const k = kubo(STRIPPED)
    const r = await rehostImage('https://i.ibb.co/other/spelling.png?1', undefined, { kubo: k.kubo, now: () => 0, fetchOptions, refuseCid: c => c === STRIPPED })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'removed' } })
    expect(k.calls).toEqual(['hash'])
  })
})

describe('a CID removed while it is being pinned', () => {
  // The tombstone lands after the first check: the sync's own pin must not outlive it.
  const removedAfterPin = (cid: string, calls: string[]) => (c: string) => c === cid && calls.includes('pin') || c === cid && calls.includes('add')

  it('is unpinned again when the removal raced a pin by its existing CID', async () => {
    const k = kubo(CID)
    const garbage = vi.fn()
    const r = await rehostImage(`https://subsquare.infura-ipfs.io/ipfs/${CID}`, undefined, { kubo: k.kubo, now: () => 0, onGarbage: garbage, refuseCid: async c => removedAfterPin(CID, k.calls)(c) })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'removed' }, media: null })
    expect(k.calls.slice(-2)).toEqual(['pin', 'unpin'])
    expect(garbage).toHaveBeenCalled()
  })

  it('is unpinned again when the removal raced an add of fetched bytes', async () => {
    const k = kubo(STRIPPED)
    const r = await rehostImage('https://i.ibb.co/x.png', undefined, { kubo: k.kubo, now: () => 0, fetchOptions, refuseCid: async c => removedAfterPin(STRIPPED, k.calls)(c) })
    expect(r).toMatchObject({ kind: 'failed', url: { reason: 'removed' }, media: null })
    expect(k.calls).toEqual(['hash', 'add', 'unpin'])
  })

  it('keeps the pin when nothing was removed', async () => {
    const k = kubo(STRIPPED)
    const r = await rehostImage('https://i.ibb.co/x.png', undefined, { kubo: k.kubo, now: () => 0, fetchOptions, refuseCid: async () => false })
    expect(r).toMatchObject({ kind: 'rehosted', media: { cid: STRIPPED } })
    expect(k.calls).toEqual(['hash', 'add'])
  })
})

describe('admission', () => {
  it('a deferred image stores nothing and records nothing', async () => {
    const k = kubo()
    const garbage = vi.fn()
    const r = await rehostImage('https://i.ibb.co/x.png', undefined, { kubo: k.kubo, now: () => 0, fetchOptions, admit: async () => 'storage-ceiling', onGarbage: garbage })
    expect(r).toEqual({ kind: 'deferred', reason: 'storage-ceiling', media: null, url: null })
    expect(k.calls).toEqual(['hash'])
    const pinned = await rehostImage(`https://subsquare.infura-ipfs.io/ipfs/${CID}`, undefined, { kubo: kubo(CID).kubo, now: () => 0, admit: async () => 'daily-bytes', onGarbage: garbage })
    expect(pinned).toMatchObject({ kind: 'deferred', reason: 'daily-bytes' })
    expect(garbage).toHaveBeenCalled()
  })

  it('the budget holds the repo below 80% of StorageMax and the daily and per-author caps', async () => {
    const stat = (repoSize: number) => ({ repoStat: async () => ({ repoSize, storageMax: 1000 }) })
    expect(await new ImageBudget(stat(700), { images: 0, bytes: 0 }, new Map()).admit('a', 100)).toBeNull()
    expect(await new ImageBudget(stat(701), { images: 0, bytes: 0 }, new Map()).admit('a', 100)).toBe('storage-ceiling')
    expect(await new ImageBudget({ repoStat: async () => { throw new Error('down') } }, { images: 0, bytes: 0 }, new Map()).admit('a', 1)).toBe('repo-stat')
    expect(await new ImageBudget(stat(0), { images: SYNC_DAILY_IMAGES, bytes: 0 }, new Map()).admit('a', 1)).toBe('daily-images')
    expect(await new ImageBudget(stat(0), { images: 0, bytes: SYNC_DAILY_BYTES }, new Map()).admit('a', 1)).toBe('daily-bytes')
    const b = new ImageBudget(stat(0), { images: 0, bytes: 0 }, new Map([['a', SYNC_DAILY_IMAGES_PER_AUTHOR - 1]]))
    expect(await b.admit('a', 1)).toBeNull()
    b.commit('a', 1)
    expect(await b.admit('a', 1)).toBe('author-daily-images')
    expect(await b.admit('b', 1)).toBeNull()
  })
})

describe('candidates', () => {
  const post = (over: Record<string, unknown>) => ({ post_id: 's1', hidden: 0, deleted: 0, source_removed: 0, body: '', banner_cid: '', author_account_id: '0xaa', author_legacy_name: '', ...over })
  const comment = (over: Record<string, unknown>) => ({ comment_id: 'sc', hidden: 0, deleted: 0, source_removed: 0, body: '', author_account_id: '', author_legacy_name: 'bob', ...over })

  it('only visible items, at most IMAGES_PER_BODY per body, banners included, each with its author', () => {
    const many = Array.from({ length: 30 }, (_, i) => `![](https://img.example/${i}.png)`).join(' ')
    const c = imageCandidates([
      post({ body: many, banner_cid: CID }),
      post({ post_id: 's2', hidden: 1, body: '![](https://img.example/hidden.png)', banner_cid: 'Qm' + '2'.repeat(44) }),
      post({ post_id: 's3', source_removed: 1, body: '![](https://img.example/removed.png)' }),
      post({ post_id: 's4', deleted: 1, body: '![](https://img.example/deleted.png)' }),
    ], [comment({ body: '![](https://img.example/c.png)' }), comment({ comment_id: 'sd', hidden: 1, body: '![](https://img.example/hc.png)' })])
    expect(c.get(`https://subsquare.infura-ipfs.io/ipfs/${CID}`)).toBe('0xaa')
    expect([...c.keys()].filter(u => u.startsWith('https://img.example/') && /\/\d+\.png$/.test(u))).toHaveLength(IMAGES_PER_BODY)
    expect(c.get('https://img.example/c.png')).toBe('legacy:bob')
    for (const u of ['hidden', 'removed', 'deleted', 'hc']) expect(c.has(`https://img.example/${u}.png`)).toBe(false)
    expect(c.has(`https://subsquare.infura-ipfs.io/ipfs/${'Qm' + '2'.repeat(44)}`)).toBe(false)
  })

  it('a later version of an item (this cycle\'s batch) wins over the stored one', () => {
    const c = imageCandidates([post({ body: '![](https://img.example/a.png)' }), post({ hidden: 1, body: '![](https://img.example/a.png)' })], [])
    expect(c.size).toBe(0)
  })
})
