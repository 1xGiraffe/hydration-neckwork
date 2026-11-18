import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { ClickHouseClient } from '../src/db/client.ts'
import { plainText, setForumSnapshotForTest, type ForumPostMeta } from '../src/services/forumStore.ts'
import { BadCursorError, bannerPathFor, getForumPost, getForumRevisions, getForumThread, imageUrlsIn, initForumRead, listDiscussions, threadKeyFor } from '../src/services/forumRead.ts'
import { CID_RE, governanceRoutes } from '../src/routes/governance.ts'
import { setVisibleReferencedCidsForTest } from '../src/services/forumMedia.ts'

// The forum's read side. Imported content is hostile (Subsquare's hidden set holds
// live XSS probes): a hidden or deleted item must leave the API as a stub with no
// title, body or excerpt, and the image route must serve only CIDs the forum pinned.

const post = (p: Partial<ForumPostMeta> & { postId: string }): ForumPostMeta => ({
  kind: 'discussion', title: 't', excerpt: 'e', bodyFormat: 'markdown', bodyLength: 1, tldr: '', labels: [], linked: [],
  authorAccountId: '', authorLegacyName: 'alice', authority: 'subsquare', source: 'subsquare', sourceId: 'x', sourceCid: '',
  sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0, hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false,
  createdAt: Date.parse('2026-01-01T00:00:00Z'), editedAt: null, lastActivityAt: Date.parse('2026-01-02T00:00:00Z'), updatedAt: 0,
  ...p,
})

function fakeClient(rowsFor: (query: string, params: Record<string, unknown>) => unknown[]): ClickHouseClient {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({ json: async () => rowsFor(query, query_params ?? {}) }),
  } as unknown as ClickHouseClient
}

afterEach(() => setForumSnapshotForTest(null))

describe('plainText', () => {
  it('reduces markdown and html to words, never keeping markup', () => {
    expect(plainText('# Title\n\n**bold** [link](https://x) ![img](https://i)')).toBe('Title bold link')
    expect(plainText('<img src=x onerror="alert(1)">hi<script>evil()</script>')).toBe('hi')
    expect(plainText('word '.repeat(100), 20).length).toBeLessThanOrEqual(21)
  })
})

describe('discussions', () => {
  beforeEach(() => {
    setForumSnapshotForTest({
      posts: new Map([
        ['s1', post({ postId: 's1', title: 'Old', createdAt: 1, lastActivityAt: 5 })],
        ['s2', post({ postId: 's2', title: 'New', createdAt: 3, lastActivityAt: 3, labels: ['Treasury'] })],
        ['s3', post({ postId: 's3', title: 'Test"><img src=x>', hidden: true, hiddenReason: 'imported-hidden', createdAt: 9, lastActivityAt: 9 })],
        ['opengov:5', post({ postId: 'opengov:5', kind: 'opengov' })],
      ]),
      threads: new Map([['s1', { comments: 2, replies: 1, updates: 0, lastCommentAt: 7, commenters: 2 }]]),
    })
  })

  it('lists visible discussions only, sorted by activity or newness', () => {
    expect(listDiscussions({ sort: 'active', offset: 0, limit: 10 }).rows.map(r => r.postId)).toEqual(['s1', 's2'])
    expect(listDiscussions({ sort: 'new', offset: 0, limit: 10 }).rows.map(r => r.postId)).toEqual(['s2', 's1'])
    const page = listDiscussions({ sort: 'active', label: 'Treasury', offset: 0, limit: 10 })
    expect(page.total).toBe(1)
    expect(JSON.stringify(listDiscussions({ sort: 'active', offset: 0, limit: 10 }))).not.toContain('<img')
  })

  it('lists another collection by kind, still visible items only, and refuses an unknown kind', async () => {
    setForumSnapshotForTest({
      posts: new Map([
        ['s1', post({ postId: 's1' })],
        ['council:7', post({ postId: 'council:7', kind: 'council', title: 'Motion' })],
        ['council:8', post({ postId: 'council:8', kind: 'council', hidden: true, hiddenReason: 'imported-hidden' })],
      ]),
    })
    expect(listDiscussions({ sort: 'new', kind: 'council', offset: 0, limit: 10 }).rows.map(r => r.postId)).toEqual(['council:7'])
    const app = Fastify()
    await app.register(governanceRoutes)
    expect((await app.inject({ url: '/explorer/forum/discussions?kind=council' })).json().rows.map((r: { postId: string }) => r.postId)).toEqual(['council:7'])
    expect((await app.inject({ url: '/explorer/forum/discussions?kind=opengov' })).statusCode).toBe(400)
    await app.close()
  })

  it('sorts a thin post nobody engaged with after the rest under active, never under new', () => {
    setForumSnapshotForTest({
      posts: new Map([
        ['s1', post({ postId: 's1', bodyLength: 4000, createdAt: 1, lastActivityAt: 10 })],
        ['s2', post({ postId: 's2', bodyLength: 1, lastActivityAt: 30, createdAt: 30 })],
        ['s3', post({ postId: 's3', bodyLength: 1, createdAt: 2, lastActivityAt: 20 })],
      ]),
      threads: new Map([['s3', { comments: 1, replies: 0, updates: 0, lastCommentAt: 20, commenters: 1 }]]),
    })
    // s2: a one-liner with no comment; s3 is as short but someone commented on it.
    expect(listDiscussions({ sort: 'active', offset: 0, limit: 10 }).rows.map(r => r.postId)).toEqual(['s3', 's1', 's2'])
    expect(listDiscussions({ sort: 'new', offset: 0, limit: 10 }).rows[0].postId).toBe('s2')
  })

  it('pages with a cursor that ends', () => {
    const first = listDiscussions({ sort: 'active', offset: 0, limit: 1 })
    expect(first.nextCursor).toBe('1')
    expect(listDiscussions({ sort: 'active', offset: 1, limit: 1 }).nextCursor).toBeNull()
  })

  it('answers a hidden post with a stub that carries no text', async () => {
    initForumRead(fakeClient(() => { throw new Error('a hidden post must not be read') }))
    const stub = await getForumPost('s3')
    expect(stub).toMatchObject({ postId: 's3', hidden: true, hiddenReason: 'imported-hidden' })
    expect(JSON.stringify(stub)).not.toMatch(/img|Test/)
  })

  it('reads a visible post body and its re-hosted image map', async () => {
    const cid = 'b' + 'a'.repeat(58)
    setForumSnapshotForTest({
      posts: new Map([['s1', post({ postId: 's1' })]]),
      urlMap: new Map([['https://i.ibb.co/x.png', cid]]),
    })
    initForumRead(fakeClient(q => (q.includes('FROM price_data.forum_posts') ? [{ body: 'hi ![a](https://i.ibb.co/x.png) <img src="https://other/y.png">' }] : [])))
    const p = await getForumPost('s1')
    expect(p).toMatchObject({ hidden: false, body: expect.stringContaining('hi'), media: { 'https://i.ibb.co/x.png': `/ipfs/${cid}` } })
  })
})

describe('threads', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    thread_key: 'opengov:7', comment_id: id, kind: 'comment', parent_id: '', reply_to_id: '', author_account_id: '', author_legacy_name: 'bob',
    body: `body ${id}`, body_format: 'markdown', authority: 'subsquare', source: 'subsquare', source_id: id, source_cid: '', source_height: 0,
    source_removed: 0, revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: '2026-01-01 00:00:00.000', edited_at: '1970-01-01 00:00:00.000',
    ...extra,
  })

  it('builds two levels, keeps hidden comments as stubs, and separates updates', async () => {
    setForumSnapshotForTest({ posts: new Map(), generation: 'g1' })
    initForumRead(fakeClient(q => q.includes('forum_comments') ? [
      row('a'),
      row('b', { parent_id: 'a', created_at: '2026-01-01 00:01:00.000' }),
      row('c', { hidden: 1, hidden_reason: 'spam', body: '<img src=x onerror=alert(1)>' }),
      row('u', { kind: 'update' }),
      row('orphan', { parent_id: 'gone' }),
    ] : []))
    const t = await getForumThread('opengov:7', { sort: 'old', filter: null, cursor: null, limit: 50 })
    expect(t.rows.map(c => c.commentId)).toEqual(['a', 'c', 'orphan'])
    expect(t.rows[0].replies.map(c => c.commentId)).toEqual(['b'])
    const hidden = t.rows.find(c => c.commentId === 'c')!
    expect(hidden).toMatchObject({ hidden: true, hiddenReason: 'spam', body: null })
    expect(JSON.stringify(t)).not.toContain('onerror')
    expect(t.updates.map(c => c.commentId)).toEqual(['u'])
  })

  it('pages by keyset: a comment arriving between reads neither repeats nor skips a row', async () => {
    setForumSnapshotForTest({ posts: new Map(), generation: 'g2' })
    const rows = ['a', 'b', 'c', 'd'].map((id, i) => row(id, { created_at: `2026-01-01 00:0${i}:00.000` }))
    initForumRead(fakeClient(q => q.includes('forum_comments') ? rows : []))
    const p1 = await getForumThread('opengov:7', { sort: 'old', filter: null, cursor: null, limit: 2 })
    expect(p1.rows.map(c => c.commentId)).toEqual(['a', 'b'])
    // A newer comment lands before the second read, under a new generation.
    rows.push(row('e', { created_at: '2026-01-01 00:09:00.000' }))
    setForumSnapshotForTest({ posts: new Map(), generation: 'g3' })
    const p2 = await getForumThread('opengov:7', { sort: 'old', filter: null, cursor: p1.nextCursor, limit: 2 })
    expect(p2.rows.map(c => c.commentId)).toEqual(['c', 'd'])
    const p3 = await getForumThread('opengov:7', { sort: 'old', filter: null, cursor: p2.nextCursor, limit: 2 })
    expect(p3.rows.map(c => c.commentId)).toEqual(['e'])
    expect(p3.nextCursor).toBeNull()
    // Newest first walks the same rows backwards; a cursor never crosses sorts.
    const n1 = await getForumThread('opengov:7', { sort: 'new', filter: null, cursor: null, limit: 3 })
    expect(n1.rows.map(c => c.commentId)).toEqual(['e', 'd', 'c'])
    await expect(getForumThread('opengov:7', { sort: 'old', filter: null, cursor: n1.nextCursor, limit: 3 })).rejects.toBeInstanceOf(BadCursorError)
    await expect(getForumThread('opengov:7', { sort: 'old', filter: null, cursor: 'garbage', limit: 3 })).rejects.toBeInstanceOf(BadCursorError)
  })

  it('judges a comment\'s visibility from the snapshot, without a table scan', async () => {
    setForumSnapshotForTest({
      comments: new Map([['sx', { commentId: 'sx', threadKey: 's1', kind: 'comment', parentId: '', replyToId: '', authorAccountId: '', hidden: true, deleted: false, createdAt: 1, excerpt: '' }]]),
    })
    initForumRead(fakeClient(q => { if (q.includes('forum_comments')) throw new Error('no scan'); return [{ revision: 0, title: '', body: 'secret', editor_account_id: '', source: '', created_at: '2026-01-01 00:00:00.000' }] }))
    expect(await getForumRevisions('sx')).toMatchObject({ revisions: [] })
    expect(await getForumRevisions('unknown')).toBeNull()
  })

  it('a reader of a linked subject sees the merged thread its owner holds', () => {
    setForumSnapshotForTest({
      posts: new Map([['council:231', post({ postId: 'council:231', kind: 'council', linked: ['external:0xab@1', 'tc:178'] })]]),
      threads: new Map([['tc:178', { comments: 29, replies: 0, updates: 0, lastCommentAt: 1, commenters: 5 }]]),
    })
    expect(threadKeyFor('council:231')).toBe('tc:178')
  })
})

describe('image urls', () => {
  it('finds markdown and html images', () => {
    expect(imageUrlsIn('![x](https://a/1.png "t") <img alt=y src="https://b/2.jpg"> <IMG SRC=https://c/3.gif>')).toEqual(['https://a/1.png', 'https://b/2.jpg', 'https://c/3.gif'])
  })
})

describe('a post\'s banner', () => {
  const media = (cid: string) => ({ cid, mime: 'image/png', bytes: 4, width: 1, height: 1, origin: 'subsquare-cid', createdAt: 0 })
  const subsquareCid = 'Qm' + '1'.repeat(44)
  const rehosted = 'b' + 'k'.repeat(58)

  it('is our own image path once re-hosted — under its own CID, or through the image map — and null before', () => {
    setForumSnapshotForTest({ media: new Map([[subsquareCid, media(subsquareCid)]]) })
    expect(bannerPathFor(subsquareCid)).toBe(`/ipfs/${subsquareCid}`)
    setForumSnapshotForTest({ media: new Map([[rehosted, media(rehosted)]]), urlMap: new Map([[`https://subsquare.infura-ipfs.io/ipfs/${subsquareCid}`, rehosted]]) })
    expect(bannerPathFor(subsquareCid)).toBe(`/ipfs/${rehosted}`)
    setForumSnapshotForTest({})
    expect(bannerPathFor(subsquareCid)).toBeNull()
    expect(bannerPathFor('')).toBeNull()
  })
})

describe('/forum/media/:cid', () => {
  const cid = 'b' + 'k'.repeat(58)
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  let app: ReturnType<typeof Fastify>
  beforeEach(async () => {
    setForumSnapshotForTest({ media: new Map([[cid, { cid, mime: 'image/png', bytes: 4, width: 1, height: 1, origin: 'subsquare-rehost', createdAt: 0 }]]) })
    setVisibleReferencedCidsForTest(new Set([cid]))
    app = Fastify()
    await app.register(governanceRoutes)
  })
  afterEach(async () => { await app.close(); vi.unstubAllGlobals() })

  it('accepts CIDv1 base32 and CIDv0 only', () => {
    expect(CID_RE.test(cid)).toBe(true)
    expect(CID_RE.test('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true)
    expect(CID_RE.test('../../etc/passwd')).toBe(false)
    expect(CID_RE.test('bafy?x=1')).toBe(false)
  })

  it('404s a CID the forum never pinned, without touching the node', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await app.inject({ method: 'GET', url: `/forum/media/b${'z'.repeat(58)}` })
    expect(res.statusCode).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serves a pinned CID with the validated type, nosniff and a sandboxing CSP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } })))
    const res = await app.inject({ method: 'GET', url: `/forum/media/${cid}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.rawPayload.equals(bytes)).toBe(true)
  })

  it('404s a pinned image no visible item references (only a hidden, deleted or purged one)', async () => {
    setVisibleReferencedCidsForTest(new Set())
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect((await app.inject({ method: 'GET', url: `/forum/media/${cid}` })).statusCode).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serves a fresh upload nothing references yet (the editor previews it before the post exists)', async () => {
    setVisibleReferencedCidsForTest(new Set())
    setForumSnapshotForTest({ media: new Map([[cid, { cid, mime: 'image/png', bytes: 4, width: 1, height: 1, origin: 'upload', createdAt: Date.now() - 60_000 }]]) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    expect((await app.inject({ method: 'GET', url: `/forum/media/${cid}` })).statusCode).toBe(200)
    setForumSnapshotForTest({ media: new Map([[cid, { cid, mime: 'image/png', bytes: 4, width: 1, height: 1, origin: 'upload', createdAt: Date.now() - 2 * 86_400_000 }]]) })
    expect((await app.inject({ method: 'GET', url: `/forum/media/${cid}` })).statusCode).toBe(404)
  })

  it('refuses bytes that do not match the pinned size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('much longer than four'), { status: 200 })))
    expect((await app.inject({ method: 'GET', url: `/forum/media/${cid}` })).statusCode).toBe(502)
  })
})

describe('routes over a snapshot that has not loaded', () => {
  it('answer 503 not-ready, uncached, rather than an empty result that reads as real', async () => {
    setForumSnapshotForTest(null)
    const app = Fastify()
    await app.register(governanceRoutes)
    for (const url of ['/explorer/forum/discussions', '/explorer/forum/post/s1', '/explorer/forum/thread/s1', `/forum/media/b${'k'.repeat(58)}`,
      '/explorer/address/15MiwSsTJisLrAS3y8PAgtah5KoZ1gTrm9wrhn4nvaJRhugK/governance', '/explorer/governance/needs-vote?accounts=x']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(503)
      expect(res.headers['cache-control'], url).toBe('no-store')
      expect(res.json().reason, url).toBe('not-ready')
    }
    await app.close()
  })
})

describe('the hub highlight', () => {
  it('leads with engaged discussions that have a real body', async () => {
    const { highlightDiscussions, HIGHLIGHT_MIN_BODY } = await import('../src/services/forumRead.ts')
    setForumSnapshotForTest({
      posts: new Map([
        ['s1', post({ postId: 's1', bodyLength: HIGHLIGHT_MIN_BODY, lastActivityAt: 10 })],
        ['s2', post({ postId: 's2', bodyLength: 1, lastActivityAt: 30 })],
        ['s3', post({ postId: 's3', bodyLength: 5000, lastActivityAt: 20 })],
        ['s4', post({ postId: 's4', bodyLength: 5000, lastActivityAt: 40 })],
      ]),
      threads: new Map([
        ['s1', { comments: 1, replies: 0, updates: 0, lastCommentAt: 10, commenters: 1 }],
        ['s2', { comments: 9, replies: 0, updates: 0, lastCommentAt: 30, commenters: 3 }],
        ['s3', { comments: 2, replies: 0, updates: 0, lastCommentAt: 20, commenters: 2 }],
      ]),
    })
    // s2: a one-liner; s4: nobody engaged.
    expect(highlightDiscussions(5).map(r => r.postId)).toEqual(['s3', 's1'])
  })
})
