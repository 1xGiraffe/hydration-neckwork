import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { encodeAddress } from '@polkadot/util-crypto'
import { setForumSnapshotForTest, type ForumCommentMeta, type ForumPostMeta, type ThreadCounts } from '../../src/services/forumStore.ts'
import { AUTH, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for the governance forum on the Data API: discussions (list and
// detail), a referendum's description and its comment feed. The invariant that
// matters most: forum text is hostile (the imported hidden set holds live XSS
// probes), so a hidden or deleted post or comment leaves as a stub with no title,
// body, excerpt, labels or author — whatever the stored row holds.

type Row = Record<string, unknown>

const AUTHOR = `0x${'77'.repeat(32)}`
const XSS = '"><img src=x onerror=alert(1)><script>evil()</script>'
const T0 = Date.parse('2026-08-01T00:00:00Z')
const H = 3_600_000

const post = (p: Partial<ForumPostMeta> & { postId: string }): ForumPostMeta => ({
  kind: 'discussion', title: `Title ${p.postId}`, excerpt: `Excerpt ${p.postId}`, bodyFormat: 'markdown', bodyLength: 10, tldr: '', labels: [], linked: [],
  authorAccountId: '', authorLegacyName: 'alice', authority: 'subsquare', source: 'subsquare', sourceId: `sq-${p.postId}`, sourceCid: '',
  sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0, hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false,
  createdAt: T0, editedAt: null, lastActivityAt: T0, updatedAt: 0,
  ...p,
})

const counts = (comments: number, lastCommentAt: number | null): ThreadCounts => ({ comments, replies: 0, updates: 0, lastCommentAt, commenters: comments })

// Discussions: '1' native (account author), 's2'..'s6' imported, 's7' hidden with a
// probe for a title, '8' deleted. Then two referendum descriptions — opengov:381
// with its own thread, democracy:200 whose discussion lives on council:5.
function installSnapshot(): void {
  const posts = [
    post({ postId: '1', title: 'Native proposal', authorAccountId: AUTHOR, authorLegacyName: '', authority: 'native', source: '', sourceId: '', labels: ['Treasury'], createdAt: T0 + 1 * H, lastActivityAt: T0 + 1 * H, editedAt: T0 + 2 * H, revision: 2, tldr: 'short' }),
    post({ postId: 's2', createdAt: T0 + 2 * H, lastActivityAt: T0 + 2 * H, labels: ['Protocol'] }),
    post({ postId: 's3', createdAt: T0 + 3 * H, lastActivityAt: T0 + 3 * H }),
    post({ postId: 's4', title: 'Omnipool fees', createdAt: T0 + 4 * H, lastActivityAt: T0 + 4 * H }),
    post({ postId: 's5', createdAt: T0 + 5 * H, lastActivityAt: T0 + 5 * H }),
    post({ postId: 's6', createdAt: T0 + 5 * H, lastActivityAt: T0 + 5 * H }),
    post({ postId: 's7', title: XSS, excerpt: XSS, labels: [XSS], hidden: true, hiddenReason: 'imported-hidden', createdAt: T0 + 9 * H, lastActivityAt: T0 + 9 * H }),
    post({ postId: '8', title: 'gone', deleted: true, authorAccountId: AUTHOR, source: '', createdAt: T0 + 8 * H, lastActivityAt: T0 + 8 * H }),
    post({ postId: 'opengov:381', kind: 'opengov', title: 'GIGAHDX voting rewards', tldr: 'Rewards for voters', excerpt: 'Pay voters', authorAccountId: AUTHOR, authorLegacyName: '' }),
    post({ postId: 'democracy:200', kind: 'democracy', title: 'Legacy upgrade', linked: ['council:5'] }),
    post({ postId: 'council:5', kind: 'council', title: 'Council motion' }),
  ]
  setForumSnapshotForTest({
    generation: 'g1',
    posts: new Map(posts.map(p => [p.postId, p])),
    comments: new Map<string, ForumCommentMeta>(),
    // s2 has a later comment, so it leads the `active` order.
    threads: new Map([['s2', counts(3, T0 + 20 * H)], ['opengov:381', counts(4, T0 + 7 * H)], ['council:5', counts(1, T0 + 6 * H)]]),
  })
}

const POST_BODIES: Record<string, Row> = {
  '1': { shown_body: '# Native body', hidden: 0, deleted: 0 },
  's2': { shown_body: 'Imported body', hidden: 0, deleted: 0 },
  'opengov:381': { shown_body: '**Pay** voters', hidden: 0, deleted: 0 },
  'democracy:200': { shown_body: 'Legacy text', hidden: 0, deleted: 0 },
  // Visible in the snapshot, hidden in storage since (a moderation the snapshot has
  // not reloaded yet): the stored flags win.
  's3': { shown_body: '', hidden: 1, deleted: 0 },
}

const comment = (c: Partial<Row> & { comment_id: string; created_s: string }): Row => ({
  kind: 'comment', parent_id: '', reply_to_id: '', shown_author_id: AUTHOR, shown_legacy_name: '', shown_body: `body ${c.comment_id}`,
  body_format: 'markdown', source: 'subsquare', source_id: `sq-${c.comment_id}`, revision: 0, hidden: 0, hidden_reason: '', deleted: 0,
  edited_s: '1970-01-01 00:00:00.000', ...c,
})

const THREADS: Record<string, Row[]> = {
  'opengov:381': [
    comment({ comment_id: 'c1', created_s: '2026-08-02 00:00:00.000' }),
    comment({ comment_id: 'c2', created_s: '2026-08-02 01:00:00.000', parent_id: 'c1', reply_to_id: 'c1', shown_author_id: '', shown_legacy_name: 'bob' }),
    // A hidden comment whose row (worst case) still carries its probe text and author.
    comment({ comment_id: 'c3', created_s: '2026-08-02 02:00:00.000', hidden: 1, hidden_reason: 'spam', shown_body: XSS, shown_legacy_name: XSS }),
    // Same timestamp as c3: the comment id breaks the tie.
    comment({ comment_id: 'c4', created_s: '2026-08-02 02:00:00.000', deleted: 1, shown_body: XSS }),
    // A reply whose parent was removed upstream: placed top-level.
    comment({ comment_id: 'c5', created_s: '2026-08-02 03:00:00.000', parent_id: 'sMissing', reply_to_id: 'sMissing', edited_s: '2026-08-02 04:00:00.000', revision: 1 }),
    comment({ comment_id: 'c6', created_s: '2026-08-02 05:00:00.000', source: '', source_id: '' }),
  ],
  'council:5': [comment({ comment_id: 'k1', created_s: '2026-01-02 00:00:00.000' })],
  's2': [
    comment({ comment_id: 'd1', created_s: '2026-08-01 03:00:00.000' }),
    comment({ comment_id: 'd2', created_s: '2026-08-01 04:00:00.000', parent_id: 'd1', reply_to_id: 'd1' }),
  ],
  's7': [comment({ comment_id: 'h1', created_s: '2026-08-01 10:00:00.000' })],
}

const LIFECYCLE: Row[] = [
  { pallet: 'opengov', ref_index: 381, event_name: 'Referenda.Submitted', block_height: 1000, event_index: 1, ts: '2026-08-01 00:00:00', args_json: JSON.stringify({ index: 381, track: 5 }), ingested_at: '2026-08-01 00:00:05' },
  { pallet: 'democracy', ref_index: 200, event_name: 'Democracy.Started', block_height: 500, event_index: 1, ts: '2026-01-01 00:00:00', args_json: JSON.stringify({ refIndex: 200 }), ingested_at: '2026-01-01 00:00:05' },
  { pallet: 'opengov', ref_index: 999, event_name: 'Referenda.Submitted', block_height: 2000, event_index: 1, ts: '2026-08-05 00:00:00', args_json: JSON.stringify({ index: 999, track: 1 }), ingested_at: '2026-08-05 00:00:05' },
]

function forumClient() {
  return fakeDataClient(
    // The paging walks send more requests than the default per-minute budget.
    query => (query.includes('FROM price_data.user_api_limits') ? [{ per_minute: 10_000, per_day: 100_000 }] : undefined),
    (query, params) => (query.includes('-- data:forum:post-body') ? (POST_BODIES[String(params.id)] ? [POST_BODIES[String(params.id)]] : []) : undefined),
    (query, params) => (query.includes('-- data:forum:thread') ? THREADS[String(params.k)] ?? [] : undefined),
    (query, params) => (query.includes('-- data:governance:referendum')
      ? LIFECYCLE.filter(row => row.pallet === params.pallet && Number(row.ref_index) === Number(params.refIndex))
      : undefined),
    query => (query.includes('-- data:governance:referenda') ? LIFECYCLE : undefined),
    query => (query.includes('-- data:governance:proposal') ? [] : undefined),
  )
}

let app: FastifyInstance | undefined

beforeEach(() => installSnapshot())

afterEach(async () => {
  await app?.close()
  app = undefined
  setForumSnapshotForTest(null)
})

async function getJson(url: string) {
  const res = await app!.inject({ url, headers: AUTH })
  return { status: res.statusCode, body: res.json(), headers: res.headers }
}

async function walk(url: string, limit: number): Promise<{ pages: string[][]; ids: string[] }> {
  const pages: string[][] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const sep = url.includes('?') ? '&' : '?'
    const { status, body } = await getJson(`${url}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
    expect(status).toBe(200)
    const ids = body.items.map((item: { postId?: string; commentId?: string }) => item.postId ?? item.commentId)
    pages.push(ids)
    expect(body.hasMore).toBe(body.nextCursor !== undefined)
    if (!body.hasMore) break
    cursor = body.nextCursor
  }
  return { pages, ids: pages.flat() }
}

describe('GET /v1/governance/discussions', () => {
  it('lists visible discussions only, with the wire shape and no hidden text', async () => {
    app = await freshDataApp(forumClient())
    const { status, body, headers } = await getJson('/v1/governance/discussions?sort=new')
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('private, max-age=10')
    expect(body.items.map((d: { postId: string }) => d.postId)).toEqual(['s5', 's6', 's4', 's3', 's2', '1'])
    expect(JSON.stringify(body)).not.toContain('onerror')
    expect(body.items.find((d: { postId: string }) => d.postId === '1')).toEqual({
      postId: '1', title: 'Native proposal', excerpt: 'Excerpt 1', labels: ['Treasury'],
      author: { account: { address: encodeAddress(AUTHOR, 0), accountIdHex: AUTHOR, evmAddress: null }, legacyName: null },
      createdAt: '2026-08-01T01:00:00.000Z', lastActivityAt: '2026-08-01T01:00:00.000Z', editedAt: '2026-08-01T02:00:00.000Z',
      commentsCount: 0, linked: [], source: null,
      explorerUrl: 'https://hydration-explorer.neckwork.net/discussions/1',
    })
    expect(body.items.find((d: { postId: string }) => d.postId === 's2')).toMatchObject({
      author: { account: null, legacyName: 'alice' },
      commentsCount: 3,
      lastActivityAt: '2026-08-01T20:00:00.000Z',
      source: { name: 'subsquare', id: 'sq-s2' },
    })
  })

  it('orders by activity (default), refuses the retired upvote order, and filters by label and text', async () => {
    app = await freshDataApp(forumClient())
    const active = await getJson('/v1/governance/discussions')
    expect(active.body.items.map((d: { postId: string }) => d.postId)).toEqual(['s2', 's5', 's6', 's4', 's3', '1'])
    expect((await app.inject({ url: '/v1/governance/discussions?sort=top', headers: AUTH })).statusCode).toBe(400)
    const label = await getJson('/v1/governance/discussions?label=Treasury')
    expect(label.body.items.map((d: { postId: string }) => d.postId)).toEqual(['1'])
    const q = await getJson('/v1/governance/discussions?q=omnipool')
    expect(q.body.items.map((d: { postId: string }) => d.postId)).toEqual(['s4'])
    // A hidden discussion is not found by its (hostile) title either.
    const probe = await getJson('/v1/governance/discussions?q=onerror')
    expect(probe.body.items).toEqual([])
  })

  it('pages every sort in consecutive pages without overlap or gaps', async () => {
    app = await freshDataApp(forumClient())
    for (const sort of ['new', 'active']) {
      const whole = (await getJson(`/v1/governance/discussions?sort=${sort}&limit=100`)).body.items.map((d: { postId: string }) => d.postId)
      for (const limit of [1, 2, 4]) {
        const { pages, ids } = await walk(`/v1/governance/discussions?sort=${sort}`, limit)
        expect(ids).toEqual(whole)
        expect(pages.every(page => page.length <= limit)).toBe(true)
      }
    }
  })

  it('refuses a cursor from another sort and a garbage one', async () => {
    app = await freshDataApp(forumClient())
    const first = await getJson('/v1/governance/discussions?sort=new&limit=1')
    const crossed = await app.inject({ url: `/v1/governance/discussions?sort=active&cursor=${first.body.nextCursor}`, headers: AUTH })
    expect(crossed.statusCode).toBe(400)
    expect((await app.inject({ url: '/v1/governance/discussions?cursor=@@', headers: AUTH })).statusCode).toBe(400)
  })

  it('answers 503 with Retry-After while the forum snapshot is not loaded', async () => {
    setForumSnapshotForTest(null)
    app = await freshDataApp(forumClient())
    const res = await app.inject({ url: '/v1/governance/discussions', headers: AUTH })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('10')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json().error.code).toBe('unavailable')
  })
})

describe('GET /v1/governance/discussions/:id', () => {
  it('returns the body, tldr, revision and counts of a visible discussion', async () => {
    app = await freshDataApp(forumClient())
    const { status, body } = await getJson('/v1/governance/discussions/1')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      postId: '1', hidden: false, deleted: false, hiddenReason: null,
      title: 'Native proposal', body: '# Native body', bodyFormat: 'markdown', tldr: 'short', revision: 2,
      authority: 'native', threadKey: '1', commentsCount: 0, locked: false, source: null,
    })
  })

  it('serves hidden and deleted discussions as stubs without any authored field', async () => {
    const client = forumClient()
    app = await freshDataApp(client)
    const hidden = await getJson('/v1/governance/discussions/s7')
    expect(hidden.status).toBe(200)
    expect(hidden.body).toMatchObject({
      postId: 's7', hidden: true, deleted: false, hiddenReason: 'imported-hidden',
      title: null, excerpt: null, body: null, tldr: null, labels: [], author: null, commentsCount: null,
    })
    expect(JSON.stringify(hidden.body)).not.toContain('onerror')
    const deleted = await getJson('/v1/governance/discussions/8')
    expect(deleted.body).toMatchObject({ postId: '8', hidden: true, deleted: true, hiddenReason: 'deleted', title: null, body: null, author: null })
    // A stub never reads the body at all.
    expect(client.seen.filter(s => s.query.includes('-- data:forum:post-body')).map(s => s.params.id)).toEqual([])
  })

  it('lets the stored row\'s flags win over a snapshot that has not reloaded yet', async () => {
    const client = forumClient()
    app = await freshDataApp(client)
    const { body } = await getJson('/v1/governance/discussions/s3')
    expect(body).toMatchObject({ postId: 's3', hidden: true, title: null, body: null, excerpt: null })
    const read = client.seen.find(s => s.query.includes('-- data:forum:post-body'))!
    // The text is withheld in the query itself, not only in the response.
    expect(read.query).toMatch(/if\(hidden = 0 AND deleted = 0, body, ''\)/)
    expect(read.query).toMatch(/WHERE post_id = \{id:String\}/)
  })

  it('404s an id that names no discussion, a subject description included, and 400s a malformed id', async () => {
    app = await freshDataApp(forumClient())
    expect((await app.inject({ url: '/v1/governance/discussions/s999', headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ url: '/v1/governance/discussions/council:5', headers: AUTH })).statusCode).toBe(400)
    expect((await app.inject({ url: `/v1/governance/discussions/${'a'.repeat(41)}`, headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/governance/referenda/:pallet/:index (description)', () => {
  it('carries the forum description beside the fold', async () => {
    app = await freshDataApp(forumClient())
    const { status, body } = await getJson('/v1/governance/referenda/opengov/381')
    expect(status).toBe(200)
    expect(body.descriptionStatus).toBe('ok')
    expect(body.title).toBe('GIGAHDX voting rewards')
    expect(body.description).toEqual({
      postId: 'opengov:381', hidden: false, hiddenReason: null,
      title: 'GIGAHDX voting rewards', tldr: 'Rewards for voters', excerpt: 'Pay voters', body: '**Pay** voters', bodyFormat: 'markdown',
      author: { account: { address: encodeAddress(AUTHOR, 0), accountIdHex: AUTHOR, evmAddress: null }, legacyName: null },
      authority: 'subsquare', revision: 0, editedAt: null, threadKey: 'opengov:381', commentsCount: 4,
      source: { name: 'subsquare', id: 'sq-opengov:381' },
    })
  })

  it('names a legacy referendum\'s merged thread, and is null with no forum record', async () => {
    app = await freshDataApp(forumClient())
    const legacy = await getJson('/v1/governance/referenda/democracy/200')
    expect(legacy.body.description).toMatchObject({ postId: 'democracy:200', threadKey: 'council:5', commentsCount: 1, title: 'Legacy upgrade' })
    const none = await getJson('/v1/governance/referenda/opengov/999')
    expect(none.status).toBe(200)
    expect(none.body.description).toBeNull()
    expect(none.body.descriptionStatus).toBe('none')
  })

  it('withholds a hidden description\'s text but keeps its thread count', async () => {
    setForumSnapshotForTest({
      posts: new Map([['opengov:381', post({ postId: 'opengov:381', kind: 'opengov', title: XSS, tldr: XSS, excerpt: XSS, hidden: true, hiddenReason: 'spam' })]]),
      threads: new Map([['opengov:381', counts(4, null)]]),
    })
    app = await freshDataApp(forumClient())
    const { body } = await getJson('/v1/governance/referenda/opengov/381')
    expect(body.description).toMatchObject({ hidden: true, hiddenReason: 'spam', title: null, tldr: null, excerpt: null, body: null, author: null, commentsCount: 4 })
    expect(body.descriptionStatus).toBe('hidden')
    expect(body.title).toBeNull()
    expect(JSON.stringify(body)).not.toContain('onerror')
  })
})

describe('GET /v1/governance/referenda/:pallet/:index/comments', () => {
  it('serves the thread oldest first, two levels, with stubs that carry no text or author', async () => {
    const client = forumClient()
    app = await freshDataApp(client)
    const { status, body, headers } = await getJson('/v1/governance/referenda/opengov/381/comments')
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('private, max-age=10')
    expect(body.threadKey).toBe('opengov:381')
    expect(body.items.map((c: { commentId: string }) => c.commentId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    const [c1, c2, c3, c4, c5, c6] = body.items
    expect(c1).toEqual({
      commentId: 'c1', kind: 'comment', parentId: null, replyToId: null, hidden: false, hiddenReason: null, deleted: false,
      author: { account: { address: encodeAddress(AUTHOR, 0), accountIdHex: AUTHOR, evmAddress: null }, legacyName: null },
      body: 'body c1', bodyFormat: 'markdown', createdAt: '2026-08-02T00:00:00.000Z', editedAt: null, revision: 0,
      source: { name: 'subsquare', id: 'sq-c1' },
    })
    expect(c2).toMatchObject({ parentId: 'c1', replyToId: 'c1', author: { account: null, legacyName: 'bob' } })
    expect(c3).toMatchObject({ hidden: true, deleted: false, hiddenReason: 'spam', body: null, bodyFormat: null, author: null, revision: null })
    expect(c4).toMatchObject({ hidden: true, deleted: true, hiddenReason: 'deleted', body: null, author: null })
    expect(c5).toMatchObject({ parentId: null, replyToId: 'sMissing', editedAt: '2026-08-02T04:00:00.000Z', revision: 1 })
    expect(c6.source).toBeNull()
    expect(JSON.stringify(body)).not.toContain('onerror')
    const read = client.seen.find(s => s.query.includes('-- data:forum:thread'))!
    expect(read.params.k).toBe('opengov:381')
    expect(read.query).toMatch(/if\(hidden = 0 AND deleted = 0, body, ''\)/)
    expect(read.query).toMatch(/if\(hidden = 0 AND deleted = 0, author_legacy_name, ''\)/)
  })

  it('pages in consecutive pages without overlap or gaps, ties broken by id', async () => {
    app = await freshDataApp(forumClient())
    for (const limit of [1, 2, 4]) {
      const { ids } = await walk('/v1/governance/referenda/opengov/381/comments', limit)
      expect(ids).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    }
    expect((await app.inject({ url: '/v1/governance/referenda/opengov/381/comments?cursor=@@', headers: AUTH })).statusCode).toBe(400)
  })

  it('reads a legacy referendum\'s merged thread, answers a quiet one empty and an unknown one 404', async () => {
    app = await freshDataApp(forumClient())
    const legacy = await getJson('/v1/governance/referenda/democracy/200/comments')
    expect(legacy.body.threadKey).toBe('council:5')
    expect(legacy.body.items.map((c: { commentId: string }) => c.commentId)).toEqual(['k1'])
    const quiet = await getJson('/v1/governance/referenda/opengov/999/comments')
    expect(quiet.status).toBe(200)
    expect(quiet.body).toMatchObject({ threadKey: 'opengov:999', items: [], hasMore: false })
    // An empty thread's tail starts at the beginning: the first comment will be served.
    expect(typeof quiet.body.tailCursor).toBe('string')
    expect((await app.inject({ url: '/v1/governance/referenda/opengov/12345/comments', headers: AUTH })).statusCode).toBe(404)
  })
})

describe('following a thread with tailCursor', () => {
  it('ends the walk with a tail cursor that re-serves the last hour and picks up a backdated import', async () => {
    const thread = THREADS['opengov:381']
    app = await freshDataApp(forumClient())
    const all = await getJson('/v1/governance/referenda/opengov/381/comments?limit=100')
    expect(all.body.hasMore).toBe(false)
    expect(all.body.nextCursor).toBeUndefined()
    expect(typeof all.body.tailCursor).toBe('string')
    // A page with more to come carries no tail cursor.
    expect((await getJson('/v1/governance/referenda/opengov/381/comments?limit=2')).body.tailCursor).toBeUndefined()

    // An import lands later, dated 30 minutes before the newest comment (c6, 05:00).
    THREADS['opengov:381'] = [...thread, comment({ comment_id: 'c7', created_s: '2026-08-02 04:30:00.000' })]
    try {
      setForumSnapshotForTest({ generation: 'g2', posts: new Map([['opengov:381', post({ postId: 'opengov:381', kind: 'opengov' })]]) })
      const polled = await getJson(`/v1/governance/referenda/opengov/381/comments?cursor=${all.body.tailCursor}`)
      // The hour before 05:00: c7 (new) and c6 (again); c5 at 03:00 is outside it.
      expect(polled.body.items.map((c: { commentId: string }) => c.commentId)).toEqual(['c7', 'c6'])
      expect(polled.body.hasMore).toBe(false)
      expect(typeof polled.body.tailCursor).toBe('string')
    } finally {
      THREADS['opengov:381'] = thread
    }
  })
})

describe('GET /v1/governance/discussions/:id/comments', () => {
  it('serves a discussion\'s thread in the referendum feed\'s shape and paging', async () => {
    app = await freshDataApp(forumClient())
    const { status, body, headers } = await getJson('/v1/governance/discussions/s2/comments')
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('private, max-age=10')
    expect(body.threadKey).toBe('s2')
    expect(body.items.map((c: { commentId: string; parentId: string | null }) => [c.commentId, c.parentId])).toEqual([['d1', null], ['d2', 'd1']])
    const { ids } = await walk('/v1/governance/discussions/s2/comments', 1)
    expect(ids).toEqual(['d1', 'd2'])
  })

  it('keeps a hidden discussion\'s thread, 404s an unknown discussion and 400s a subject id', async () => {
    app = await freshDataApp(forumClient())
    const hidden = await getJson('/v1/governance/discussions/s7/comments')
    expect(hidden.status).toBe(200)
    expect(hidden.body.items.map((c: { commentId: string }) => c.commentId)).toEqual(['h1'])
    expect((await app.inject({ url: '/v1/governance/discussions/s999/comments', headers: AUTH })).statusCode).toBe(404)
    expect((await app.inject({ url: '/v1/governance/discussions/opengov:381/comments', headers: AUTH })).statusCode).toBe(400)
  })
})
