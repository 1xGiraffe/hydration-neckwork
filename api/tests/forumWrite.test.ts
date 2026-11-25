import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { cryptoWaitReady } from '@polkadot/util-crypto'
import type { ClickHouseClient } from '../src/db/client.ts'

// The proposer every referendum here has, and whether it exists at all.
const PROPOSER = `0x${'50'.repeat(32)}`
vi.mock('../src/services/governanceService.ts', () => ({
  getReferendum: async (_p: string, i: number) => (i === 404 ? null : { proposer: { accountId: PROPOSER } }),
}))
// The account each referendum's submission deposit came from: the proposer itself,
// except #12, submitted through a proxy for the real account DEPOSITOR.
vi.mock('../src/services/governanceDeposits.ts', () => ({
  referendumDeposits: async (i: number) => ({ submission: { who: i === 12 ? `0x${'5d'.repeat(32)}` : `0x${'50'.repeat(32)}` } }),
}))
// The proposer's proxies AS THEY STAND NOW — mutable, so a test can remove one.
const mockProxies = vi.hoisted(() => ({ delegates: [] as Array<{ accountId: string; proxyType: string; delay: number }> }))
vi.mock('../src/services/proxyMultisigService.ts', () => ({
  proxyInfoFor: (ids: string[]) => (ids[0] === `0x${'50'.repeat(32)}` ? { isPure: null, delegates: mockProxies.delegates, delegatorOf: [] } : null),
  multisigCompositionFor: () => null,
}))

const { initUserAuthService, issueSession, resetUserAuthForTests } = await import('../src/services/userAuthService.ts')
const { fakeClient: userFakeClient } = await import('./helpers/userFakes.ts')
const { initUserApiTokenService } = await import('../src/services/userApiTokenService.ts')
const store = await import('../src/services/forumStore.ts')
const { initForumRead } = await import('../src/services/forumRead.ts')
const write = await import('../src/services/forumWrite.ts')
const { initForumMedia } = await import('../src/services/forumMedia.ts')
const { forumRoutes } = await import('../src/routes/forum.ts')
const { stripCorsFromPrivate } = await import('../src/routes/corsPolicy.ts')
const media = await import('../src/services/forumMedia.ts')
const { mentionsIn, linkCount, cleanTitle } = await import('../src/services/forumText.ts')

const ALICE = `0x${'a1'.repeat(32)}`
const PROPOSER_PROXY = `0x${'51'.repeat(32)}`
const BOB = `0x${'b0'.repeat(32)}`
const POOR = `0x${'00'.repeat(31)}01`
const MOD = `0x${'aa'.repeat(32)}`
const CAROL = `0x${'c3'.repeat(32)}`
const DAVE = `0x${'d4'.repeat(32)}`
const HDX = 10n ** 12n

type Row = Record<string, unknown>

/** The forum tables with ReplacingMergeTree semantics (newest row per key wins). */
const DAY_S = 86_400
/** First seen on chain (unix seconds) per account; absent = never seen. */
let firstSeen: Record<string, number> = {}

function forumFake(balances: Record<string, bigint>) {
  const posts = new Map<string, Row>(), comments = new Map<string, Row>(), revisions = new Map<string, Row>()
  const modlog: Row[] = [], reports = new Map<string, Row>(), sanctions = new Map<string, Row>()
  const media = new Map<string, Row>(), commands: string[] = []
  const mediaUrls: Row[] = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        const p = query_params ?? {}
        if (query.includes('account_asset_latest_balances')) return balances[String(p.a)] != null ? [{ bal: String(balances[String(p.a)]) }] : []
        if (query.includes('governance_vote_calls_by_voter')) return []
        if (query.includes('account_activity_v3')) return firstSeen[String(p.a)] ? [{ t: firstSeen[String(p.a)] }] : []
        if (query.includes('FROM price_data.forum_posts FINAL WHERE post_id')) return [...posts.values()].filter(r => r.post_id === p.id)
        if (query.includes('FROM price_data.forum_posts FINAL')) return [...posts.values()]
        if (query.includes('FROM price_data.forum_comments FINAL WHERE thread_key = {k:String} AND comment_id')) return [...comments.values()].filter(r => r.comment_id === p.id)
        if (query.includes('FROM price_data.forum_comments FINAL')) return [...comments.values()].filter(r => !p.k || r.thread_key === p.k)
        if (query.includes('user_forum_sanctions')) return [...sanctions.values()].filter(r => Number(r.deleted) === 0).map(r => ({ account_id: r.account_id, until: Math.floor(Date.parse(`${String(r.until).replace(' ', 'T')}Z`) / 1000) }))
        if (query.includes('user_forum_reports') && query.includes('AS r,')) return [...reports.values()].filter(r => r.target_id === p.t).map(r => ({ r: r.reporter_account_id, status: r.status }))
        if (query.includes('user_forum_reports') && p.id) return [...reports.values()].filter(r => r.report_id === p.id)
        if (query.includes('user_forum_reports')) return [...reports.values()]
        if (query.includes('forum_media_urls')) return mediaUrls.filter(r => r.status === 'failed' && (p.reasons as string[]).includes(String(r.reason))).map(r => ({ u: r.original_url, r: r.reason }))
        if (query.includes('forum_media FINAL WHERE uploader')) return [{ bytes: 0, recent: [] }]
        if (query.includes('forum_media')) return [...media.values()].filter(r => r.cid === p.c)
        return []
      },
    }),
    insert: async ({ table, values }: { table: string; values: Row[] }) => {
      for (const r of values) {
        if (table.endsWith('forum_posts')) posts.set(String(r.post_id), r)
        else if (table.endsWith('forum_comments')) comments.set(String(r.comment_id), r)
        else if (table.endsWith('forum_revisions')) revisions.set(`${r.target_id}|${r.revision}`, r)
        else if (table.endsWith('forum_moderation_log')) modlog.push(r)
        else if (table.endsWith('user_forum_reports')) reports.set(String(r.report_id), r)
        else if (table.endsWith('user_forum_sanctions')) sanctions.set(`${r.account_id}|${r.kind}`, r)
        else if (table.endsWith('forum_media')) media.set(String(r.cid), r)
      }
    },
    command: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push(query)
      if (query.startsWith('DELETE FROM price_data.forum_revisions')) for (const k of [...revisions.keys()]) if (k.startsWith(`${query_params?.id}|`)) revisions.delete(k)
    },
  } as unknown as ClickHouseClient
  return { client, posts, comments, revisions, modlog, reports, sanctions, media, mediaUrls, commands }
}

const meta = (p: Partial<import('../src/services/forumStore.ts').ForumPostMeta> & { postId: string }) => ({
  kind: 'discussion', title: 't', excerpt: '', bodyFormat: 'markdown', bodyLength: 1, tldr: '', labels: [], linked: [],
  authorAccountId: '', authorLegacyName: '', authority: 'subsquare', source: 'subsquare', sourceId: 'x', sourceCid: '',
  sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0, hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false,
  createdAt: 0, editedAt: null, lastActivityAt: 0, updatedAt: 0, ...p,
})

let fake: ReturnType<typeof forumFake>
const ctx = (accountId: string) => ({ accountId, ip: null })

beforeAll(async () => { await cryptoWaitReady() })

beforeEach(() => {
  fake = forumFake({ [ALICE]: 500n * HDX, [BOB]: 5n * HDX, [MOD]: 5000n * HDX, [`0x${'51'.repeat(32)}`]: 10n * HDX, [CAROL]: 200n * HDX, [DAVE]: 300n * HDX })
  firstSeen = {}
  mockProxies.delegates = [{ accountId: `0x${'51'.repeat(32)}`, proxyType: 'Governance', delay: 0 }, { accountId: `0x${'52'.repeat(32)}`, proxyType: 'Transfer', delay: 0 }]
  store.setForumSnapshotForTest({ generation: 'g0' })
  initForumRead(fake.client)
  write.initForumWrite(fake.client)
  write.resetForumWriteForTests()
  initForumMedia(fake.client)
})
afterEach(() => { store.setForumSnapshotForTest(null); delete process.env.FORUM_MODERATOR_ACCOUNT_IDS })

describe('text rules', () => {
  it('strips bidi and zero-width characters from titles', () => {
    expect(cleanTitle(`a\u202Eb\u200Bc  d\u0007`)).toBe('abc d')
  })
  it('counts mentions as the renderer reads them, de-duplicated', () => {
    const ss58 = '7NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba'
    expect(mentionsIn(`hi @${ss58} and @${ss58} and @0x${'ab'.repeat(20)}`)).toHaveLength(2)
    expect(mentionsIn('mail me@x.com')).toHaveLength(0)
  })
  it('counts inline links and bare urls but not images', () => {
    expect(linkCount('[a](https://a) https://b ![i](/ipfs/x)')).toBe(2)
  })
})

describe('discussions', () => {
  it('creates a native discussion: decimal id, revision 0, a seq, and the snapshot shows it at once', async () => {
    const r = await write.createDiscussion(ctx(ALICE), { title: '  Hello\u202E ', body: 'Body **text**', labels: ['Treasury'] })
    expect(r.post).toMatchObject({ postId: '1', title: 'Hello', hidden: false })
    expect(r.generation).not.toBe('g0')
    const row = fake.posts.get('1')!
    expect(row).toMatchObject({ kind: 'discussion', authority: 'native', source: '', author_account_id: ALICE, moderated: 0, locked: 0 })
    expect(Number(row.seq)).toBeGreaterThan(Date.now() * 1000 - 10_000_000)
    expect(fake.revisions.get('1|0')).toMatchObject({ body: 'Body **text**', source: 'native' })
    expect(store.forumPost('1')?.title).toBe('Hello')
    // never collides with an imported id
    store.applyLocalPost(meta({ postId: '41' }))
    expect((await write.createDiscussion(ctx(ALICE), { title: 'Two', body: 'x' })).post.postId).toBe('42')
  })

  it('gates posting on stake: 5 HDX may comment but not start a discussion; 0 HDX may do neither', async () => {
    await expect(write.createDiscussion(ctx(BOB), { title: 't', body: 'b' })).rejects.toMatchObject({ status: 403, code: 'no-stake-post' })
    await expect(write.createComment(ctx(POOR), { threadKey: 'opengov:1', body: 'b' })).rejects.toMatchObject({ status: 403, code: 'no-stake-comment' })
  })

  it('validates lengths, topics and the duplicate rule', async () => {
    await expect(write.createDiscussion(ctx(ALICE), { title: 'x'.repeat(161), body: 'b' })).rejects.toMatchObject({ status: 422 })
    await expect(write.createDiscussion(ctx(ALICE), { title: 't', body: '\u200B ' })).rejects.toMatchObject({ code: 'empty' })
    await expect(write.createDiscussion(ctx(ALICE), { title: 't', body: 'b', labels: ['Spam topic'] })).rejects.toMatchObject({ code: 'unknown-label' })
    await write.createDiscussion(ctx(ALICE), { title: 'Same', body: 'same body' })
    await expect(write.createDiscussion(ctx(ALICE), { title: 'Same', body: 'same  BODY' })).rejects.toMatchObject({ status: 409 })
  })

  it('rate-limits discussions per account (3 an hour)', async () => {
    for (let i = 0; i < 3; i++) await write.createDiscussion(ctx(MOD), { title: `t${i}`, body: `b${i}` })
    await expect(write.createDiscussion(ctx(MOD), { title: 't4', body: 'b4' })).rejects.toMatchObject({ status: 429 })
  })

  it('takes the rate-limit slot before reading the text, and gives it back when the text is refused', async () => {
    await write.createDiscussion(ctx(MOD), { title: 't0', body: 'b0' })
    await expect(write.createDiscussion(ctx(MOD), { title: 't1', body: 'x'.repeat(60_000) })).rejects.toMatchObject({ code: 'too-long' })
    await write.createDiscussion(ctx(MOD), { title: 't1', body: 'b1' })
    await write.createDiscussion(ctx(MOD), { title: 't2', body: 'b2' })
    // Out of slots: even hostile text is refused by the limiter, before anything reads it.
    const hostile = '['.repeat(1 << 20)
    const t = performance.now()
    await expect(write.createDiscussion(ctx(MOD), { title: 't3', body: hostile })).rejects.toMatchObject({ status: 429 })
    for (let i = 0; i < 20; i++) await expect(write.createComment(ctx(MOD), { threadKey: 'opengov:3', body: hostile })).rejects.toMatchObject({ code: 'too-long' })
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('refuses a raw text far over its limit before cleaning it', async () => {
    const t = performance.now()
    await expect(write.fileReport(ctx(ALICE), { targetId: 'opengov:3', reason: 'spam', note: `${' '.repeat(1 << 20)}x` })).rejects.toMatchObject({ status: 404 })
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'reported' })
    await expect(write.fileReport(ctx(ALICE), { targetId: comment.commentId, reason: 'spam', note: `${' '.repeat(1 << 20)}x` })).rejects.toMatchObject({ code: 'too-long' })
    await expect(write.createComment(ctx(ALICE), { threadKey: 'opengov:3', body: `${' '.repeat(1 << 20)}x` })).rejects.toMatchObject({ code: 'too-long' })
    expect(performance.now() - t).toBeLessThan(500)
    // A note within the limit once cleaned is accepted, CRLFs and trailing space included.
    expect(await write.fileReport(ctx(ALICE), { targetId: comment.commentId, reason: 'spam', note: `${'ab\r\n'.repeat(160)}   ` })).toMatchObject({ ok: true })
  })

  it('edits only by the author, as a new revision, keeping every column the sync owns', async () => {
    fake.posts.set('s9', { post_id: 's9', kind: 'discussion', title: 'Imp', body: 'old', body_format: 'markdown', tldr: '', labels: ['X'], linked: [], author_account_id: ALICE, author_legacy_name: '', authority: 'subsquare', source: 'subsquare', source_id: 'id', source_cid: '', source_hash: 'h', source_activity_at: '2026-01-01 00:00:00.000', source_removed: 0, source_comments_count: 2, poll_json: '', banner_cid: '', revision: 2, hidden: 0, hidden_reason: '', deleted: 0, created_at: '2026-01-01 00:00:00.000', edited_at: '1970-01-01 00:00:00.000', last_activity_at: '2026-01-01 00:00:00.000', seq: 0, row_fp: 'FP', moderated: 1, locked: 1 })
    store.applyLocalPost(meta({ postId: 's9', authorAccountId: ALICE, labels: ['X'] }))
    await expect(write.editPost(ctx(BOB), 's9', { body: 'mine now' })).rejects.toMatchObject({ status: 403 })
    await write.editPost(ctx(ALICE), 's9', { body: 'new text', labels: ['X', 'Treasury'] })
    expect(fake.posts.get('s9')).toMatchObject({ body: 'new text', authority: 'native', revision: 3, row_fp: 'FP', moderated: 1, locked: 1, source_id: 'id', labels: ['X', 'Treasury'] })
    expect(fake.revisions.get('s9|3')).toMatchObject({ body: 'new text', editor_account_id: ALICE })
  })

  it('a delete purges every revision and leaves a tombstone', async () => {
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Gone soon', body: 'secret' })
    await write.deletePost(ctx(ALICE), post.postId)
    expect(fake.posts.get(post.postId)).toMatchObject({ deleted: 1, body: '', title: '' })
    expect([...fake.revisions.keys()].filter(k => k.startsWith(`${post.postId}|`))).toHaveLength(0)
    expect(store.forumPost(post.postId)?.deleted).toBe(true)
  })
})

describe('referendum descriptions (proposer authority)', () => {
  it('lets the account whose submission deposit it is write the description when a proxy submitted it', async () => {
    const real = `0x${'5d'.repeat(32)}`
    expect((await write.postPermissions(real, 'opengov:12')).edit).toBe(true)
    expect((await write.postPermissions(real, 'opengov:13')).edit).toBe(false)
    expect((await write.postPermissions(ALICE, 'opengov:12')).edit).toBe(false)
  })

  it('the proposer and its Governance proxy may write; a Transfer proxy and strangers may not', async () => {
    await expect(write.editPost(ctx(ALICE), 'opengov:7', { title: 'T', body: 'B' })).rejects.toMatchObject({ status: 403 })
    expect(write.speaksFor(`0x${'52'.repeat(32)}`, PROPOSER)).toBe(false)
    expect(write.speaksFor(`0x${'51'.repeat(32)}`, PROPOSER)).toBe(true)
    const r = await write.editPost(ctx(`0x${'51'.repeat(32)}`), 'opengov:7', { title: 'Fund X', body: 'Why' })
    expect(r.post).toMatchObject({ title: 'Fund X' })
    expect(fake.posts.get('opengov:7')).toMatchObject({ kind: 'opengov', authority: 'native', revision: 0 })
    const u = await write.addUpdate(ctx(`0x${'51'.repeat(32)}`), 'opengov:7', { body: 'Milestone 1 done' })
    expect(fake.comments.get(u.comment.commentId)).toMatchObject({ kind: 'update', thread_key: 'opengov:7' })
  })
})

describe('referendum descriptions keep their history', () => {
  it('a proxy removed on chain loses the right to edit at once', async () => {
    await write.editPost(ctx(PROPOSER_PROXY), 'opengov:8', { title: 'T', body: 'by the proxy' })
    mockProxies.delegates = []
    await expect(write.editPost(ctx(PROPOSER_PROXY), 'opengov:8', { body: 'still mine?' })).rejects.toMatchObject({ status: 403 })
    await expect(write.addUpdate(ctx(PROPOSER_PROXY), 'opengov:8', { body: 'update' })).rejects.toMatchObject({ status: 403 })
  })

  it('writing it once never makes it yours: authority is the chain\'s, not the stored author', async () => {
    fake.posts.set('opengov:9', { post_id: 'opengov:9', kind: 'opengov', title: 'Imported', body: 'imported text', body_format: 'markdown', tldr: '', labels: [], linked: [], author_account_id: ALICE, author_legacy_name: '', authority: 'subsquare', source: 'subsquare', source_id: 'x', source_cid: '', source_hash: 'h', source_activity_at: '2026-01-01 00:00:00.000', source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '', revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: '2026-01-01 00:00:00.000', edited_at: '1970-01-01 00:00:00.000', last_activity_at: '2026-01-01 00:00:00.000', seq: 0, row_fp: 'FP', moderated: 0, locked: 0 })
    store.applyLocalPost(meta({ postId: 'opengov:9', kind: 'opengov', authorAccountId: ALICE }))
    await expect(write.editPost(ctx(ALICE), 'opengov:9', { body: 'rewritten' })).rejects.toMatchObject({ status: 403 })
    expect((await write.postPermissions(ALICE, 'opengov:9')).edit).toBe(false)
  })

  it('nobody can delete a description, so its revisions are never purged', async () => {
    await write.editPost(ctx(PROPOSER_PROXY), 'opengov:10', { title: 'T', body: 'v1' })
    await write.editPost(ctx(PROPOSER_PROXY), 'opengov:10', { body: 'v2' })
    expect((await write.postPermissions(PROPOSER_PROXY, 'opengov:10')).delete).toBe(false)
    await expect(write.deletePost(ctx(PROPOSER_PROXY), 'opengov:10')).rejects.toMatchObject({ status: 403 })
    expect(fake.revisions.has('opengov:10|0') && fake.revisions.has('opengov:10|1')).toBe(true)
    expect(fake.commands.some(q => q.includes('forum_revisions'))).toBe(false)
  })

  it('Updates are append-only', async () => {
    const u = await write.addUpdate(ctx(PROPOSER_PROXY), 'opengov:11', { body: 'first' })
    await expect(write.editComment(ctx(PROPOSER_PROXY), u.comment.commentId, { body: 'rewritten' })).rejects.toMatchObject({ code: 'append-only' })
    await expect(write.deleteComment(ctx(PROPOSER_PROXY), u.comment.commentId)).rejects.toMatchObject({ code: 'append-only' })
  })

  it('a non-canonical subject key opens no shadow thread, and a lock on either key closes the thread', async () => {
    await expect(write.createComment(ctx(BOB), { threadKey: 'opengov:0450', body: 'shadow' })).rejects.toMatchObject({ status: 404 })
    store.applyLocalPost(meta({ postId: 's77', locked: true, linked: ['opengov:12'] }))
    await write.createComment(ctx(ALICE), { threadKey: 'opengov:12', body: 'open thread' })
    await expect(write.createComment(ctx(BOB), { threadKey: 's77', body: 'via the locked post' })).rejects.toMatchObject({ status: 409 })
  })

  it('a comment opening a thread never blanks a description written meanwhile', async () => {
    // The sync wrote a description the snapshot has not seen yet.
    fake.posts.set('opengov:13', { post_id: 'opengov:13', kind: 'opengov', title: 'From Subsquare', body: 'real description', body_format: 'markdown', tldr: '', labels: [], linked: [], author_account_id: '', author_legacy_name: 'x', authority: 'subsquare', source: 'subsquare', source_id: 'y', source_cid: '', source_hash: 'h', source_activity_at: '2026-01-01 00:00:00.000', source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '', revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: '2026-01-01 00:00:00.000', edited_at: '1970-01-01 00:00:00.000', last_activity_at: '2026-01-01 00:00:00.000', seq: 0, row_fp: 'FP', moderated: 0, locked: 0 })
    await write.createComment(ctx(BOB), { threadKey: 'opengov:13', body: 'first comment' })
    expect(fake.posts.get('opengov:13')).toMatchObject({ body: 'real description', title: 'From Subsquare' })
  })

  it('an author delete erases older row versions too (no text left for a plain SELECT)', async () => {
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Will go', body: 'text' })
    await write.deletePost(ctx(ALICE), post.postId)
    expect(fake.commands.some(q => q.startsWith('DELETE FROM price_data.forum_posts') && q.includes("body != ''"))).toBe(true)
    expect(fake.modlog.at(-1)).toMatchObject({ target_id: post.postId, action: 'delete', moderator_account_id: ALICE })
  })
})

describe('uploads under concurrency', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('sixty parallel uploads cannot pass the per-account window or the byte budgets', async () => {
    let pinned = 0
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      await new Promise(r => setTimeout(r, 5)) // every node call yields, as a real one would
      if (u.includes('/repo/stat')) return new Response(JSON.stringify({ RepoSize: 0, StorageMax: 2_000_000_000 }))
      if (u.includes('/add?')) { if (!u.includes('only-hash')) pinned++; return new Response(JSON.stringify({ Hash: `b${'a'.repeat(58)}` })) }
      return new Response('{}')
    }) as typeof fetch
    media.resetForumMediaForTests({ size: 0, max: 2_000_000_000 })
    const { crc32 } = await import('../src/services/imageSanitize.ts')
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
      return Buffer.concat([len, body, crc])
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(2_000_000, 7)), chunk('IEND', Buffer.alloc(0))])
    const results = await Promise.allSettled(Array.from({ length: 60 }, () => media.uploadImage(ctx(ALICE), new Uint8Array(png))))
    const ok = results.filter(r => r.status === 'fulfilled').length
    expect(ok).toBe(20) // FORUM_LIMITS.upload: 20 an hour, however many arrive at once
    expect(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.status === 429)).toBe(true)
    expect(pinned).toBeLessThanOrEqual(20)
  })

  it('the repo ceiling counts bytes still in flight', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      await new Promise(r => setTimeout(r, 5))
      const u = String(url)
      if (u.includes('/add?')) return new Response(JSON.stringify({ Hash: `b${'c'.repeat(58)}` }))
      return new Response('{}')
    }) as typeof fetch
    // 1.6 GB of 2 GB used: 80% headroom leaves exactly nothing.
    media.resetForumMediaForTests({ size: 1_599_000_000, max: 2_000_000_000 })
    const { crc32 } = await import('../src/services/imageSanitize.ts')
    const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(400_000, 1)), chunk('IEND', Buffer.alloc(0))])
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => media.uploadImage(ctx(MOD), new Uint8Array(png))))
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(2) // 1,599,000,000 + 2 × ~400 kB ≤ 1.6 GB < + 3
    expect(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.code === 'storage-full')).toBe(true)
  })
})

describe('comments', () => {
  it('opens a thread on a referendum with a text-less stub the sync may replace, and files replies two levels deep', async () => {
    const top = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'first' })
    expect(fake.posts.get('opengov:3')).toMatchObject({ authority: '', source: '', row_fp: '', title: '' })
    expect(top.comment.commentId).toMatch(/^c[0-9A-HJKMNP-TV-Z]{26}$/)
    const reply = await write.createComment(ctx(ALICE), { threadKey: 'opengov:3', parentId: top.comment.commentId, body: 'reply' })
    const nested = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', parentId: reply.comment.commentId, body: 'reply to reply' })
    expect(fake.comments.get(nested.comment.commentId)).toMatchObject({ parent_id: top.comment.commentId, reply_to_id: reply.comment.commentId })
    expect(store.forumThreadCounts('opengov:3')).toMatchObject({ comments: 3, replies: 2 })
  })

  it('refuses the read-only archive, a locked thread and a missing referendum', async () => {
    store.applyLocalPost(meta({ postId: 'council:5', kind: 'council' }))
    await expect(write.createComment(ctx(BOB), { threadKey: 'council:5', body: 'x' })).rejects.toMatchObject({ status: 409 })
    store.applyLocalPost(meta({ postId: 's1', locked: true }))
    await expect(write.createComment(ctx(BOB), { threadKey: 's1', body: 'x' })).rejects.toMatchObject({ status: 409 })
    await expect(write.createComment(ctx(BOB), { threadKey: 'opengov:404', body: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('caps mentions at ten per comment', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `@0x${(i + 16).toString(16).padStart(2, '0').repeat(20)}`).join(' ')
    await expect(write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: many })).rejects.toMatchObject({ code: 'too-many-mentions' })
  })

  it('only the author edits or deletes a comment', async () => {
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'mine' })
    await expect(write.editComment(ctx(ALICE), comment.commentId, { body: 'hijack' })).rejects.toMatchObject({ status: 403 })
    await expect(write.deleteComment(ctx(ALICE), comment.commentId)).rejects.toMatchObject({ status: 403 })
    const e = await write.editComment(ctx(BOB), comment.commentId, { body: 'mine, edited' })
    expect(e.comment).toMatchObject({ body: 'mine, edited', revision: 1 })
    await write.deleteComment(ctx(BOB), comment.commentId)
    expect(fake.comments.get(comment.commentId)).toMatchObject({ deleted: 1, body: '' })
    expect(fake.revisions.has(`${comment.commentId}|0`)).toBe(false)
  })
})

describe('moderation', () => {
  it('a moderator hide sets `moderated` (the sync keeps it) and is logged publicly', async () => {
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'spam spam' })
    await write.applyModeration(MOD, comment.commentId, 'hide', 'spam')
    expect(fake.comments.get(comment.commentId)).toMatchObject({ hidden: 1, hidden_reason: 'spam', moderated: 1 })
    expect(fake.modlog.at(-1)).toMatchObject({ target_id: comment.commentId, action: 'hide', reason_code: 'spam', moderator_account_id: MOD })
  })

  it('auto-hides only after three ESTABLISHED reporters (100 HDX and 30 days on chain, or an identity)', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * DAY_S
    firstSeen = { [MOD]: old, [CAROL]: old, [DAVE]: Math.floor(Date.now() / 1000) - 5 * DAY_S }
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Reported', body: 'b' })
    // BOB (5 HDX) and DAVE (300 HDX but 5 days old) report: queued, not counted.
    for (const r of [BOB, DAVE, MOD]) expect((await write.fileReport(ctx(r), { targetId: post.postId, reason: 'spam' })).autoHidden).toBe(false)
    expect(fake.posts.get(post.postId)).toMatchObject({ hidden: 0 })
    // The third established reporter hides it.
    expect((await write.fileReport(ctx(CAROL), { targetId: post.postId, reason: 'spam' })).autoHidden).toBe(false)
    firstSeen[DAVE] = old
    expect((await write.fileReport(ctx(DAVE), { targetId: post.postId, reason: 'spam' })).autoHidden).toBe(true)
    expect(fake.posts.get(post.postId)).toMatchObject({ hidden: 1, moderated: 1, hidden_reason: 'reported' })
  })

  it('a moderator restore made while the reporters are read wins over the automatic hide', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * DAY_S
    firstSeen = { [MOD]: old, [CAROL]: old, [DAVE]: old }
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Contested', body: 'b' })
    for (const r of [MOD, CAROL]) await write.fileReport(ctx(r), { targetId: post.postId, reason: 'spam' })
    // The third report reads the item and its reports, then the reporters' chain facts;
    // a moderator restores the item in between.
    const query = fake.client.query.bind(fake.client)
    let restored = false
    ;(fake.client as { query: unknown }).query = async (a: { query: string }) => {
      const r = await query(a as never)
      if (!restored && a.query.includes('user_forum_reports') && a.query.includes('AS r,')) {
        const rows = await r.json()
        restored = true
        await write.applyModeration(MOD, post.postId, 'restore', 'ok')
        return { json: async () => rows }
      }
      return r
    }
    expect((await write.fileReport(ctx(DAVE), { targetId: post.postId, reason: 'spam' })).autoHidden).toBe(false)
    expect(restored).toBe(true)
    expect(fake.posts.get(post.postId)).toMatchObject({ hidden: 0, moderated: 1 })
    expect(fake.modlog.at(-1)).toMatchObject({ action: 'restore', moderator_account_id: MOD })
  })

  it('eligibility is read fresh at report time, never from the gate cache', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * DAY_S
    firstSeen = { [MOD]: old, [CAROL]: old, [DAVE]: old }
    await write.standingOf(DAVE) // primes the 5-minute gate cache
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Fresh', body: 'b' })
    await write.fileReport(ctx(MOD), { targetId: post.postId, reason: 'spam' })
    await write.fileReport(ctx(CAROL), { targetId: post.postId, reason: 'spam' })
    expect(await write.autoHideEligible(DAVE)).toBe(true)
    firstSeen[DAVE] = Math.floor(Date.now() / 1000) // re-read: now too new
    expect(await write.autoHideEligible(DAVE)).toBe(false)
  })

  it('never auto-hides a referendum description or a proposer Update — reports only queue', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * DAY_S
    firstSeen = { [MOD]: old, [CAROL]: old, [DAVE]: old }
    await write.editPost(ctx(PROPOSER_PROXY), 'opengov:7', { title: 'Fund X', body: 'Why' })
    const u = await write.addUpdate(ctx(PROPOSER_PROXY), 'opengov:7', { body: 'Milestone' })
    for (const target of ['opengov:7', u.comment.commentId]) {
      for (const r of [MOD, CAROL, DAVE]) expect((await write.fileReport(ctx(r), { targetId: target, reason: 'abuse' })).autoHidden).toBe(false)
    }
    expect(fake.posts.get('opengov:7')).toMatchObject({ hidden: 0 })
    expect(fake.comments.get(u.comment.commentId)).toMatchObject({ hidden: 0 })
  })

  it('a dismissed report immunises the item: re-filing does not reopen it, later reports only queue', async () => {
    const old = Math.floor(Date.now() / 1000) - 60 * DAY_S
    firstSeen = { [MOD]: old, [CAROL]: old, [DAVE]: old, [ALICE]: old }
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'contested' })
    await write.fileReport(ctx(CAROL), { targetId: comment.commentId, reason: 'spam' })
    const rid = [...fake.reports.values()].find(r => r.reporter_account_id === CAROL)!.report_id as string
    fake.reports.set(rid, { ...fake.reports.get(rid)!, status: 'dismissed' })
    await write.fileReport(ctx(CAROL), { targetId: comment.commentId, reason: 'spam' })
    expect(fake.reports.get(rid)).toMatchObject({ status: 'dismissed' })
    for (const r of [DAVE, MOD, ALICE]) expect((await write.fileReport(ctx(r), { targetId: comment.commentId, reason: 'spam' })).autoHidden).toBe(false)
    expect(fake.comments.get(comment.commentId)).toMatchObject({ hidden: 0 })
  })

  it('reports are rate-limited per account', async () => {
    const posts = []
    for (let i = 0; i < 6; i++) posts.push((await write.createComment(ctx(ALICE), { threadKey: 'opengov:3', body: `c${i}` })).comment.commentId)
    for (let i = 0; i < 5; i++) await write.fileReport(ctx(MOD), { targetId: posts[i], reason: 'spam' })
    await expect(write.fileReport(ctx(MOD), { targetId: posts[5], reason: 'spam' })).rejects.toMatchObject({ status: 429 })
  })

  it('a purge erases the text, its old row versions and every revision, and is logged', async () => {
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'illegal text' })
    await write.applyModeration(MOD, comment.commentId, 'purge', 'illegal')
    expect(fake.comments.get(comment.commentId)).toMatchObject({ body: '', hidden: 1, hidden_reason: 'purged', moderated: 1 })
    expect(fake.revisions.has(`${comment.commentId}|0`)).toBe(false)
    expect(fake.commands.some(q => q.startsWith('DELETE FROM price_data.forum_comments') && q.includes("body != ''"))).toBe(true)
    expect(fake.modlog.at(-1)).toMatchObject({ action: 'purge', reason_code: 'illegal' })
    await expect(write.applyModeration(MOD, comment.commentId, 'restore', 'other')).rejects.toMatchObject({ code: 'purged' })
  })

  it('a muted account cannot write', async () => {
    await write.setMute(MOD, BOB, Date.now() + 86_400_000, 'cool off')
    await expect(write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'x' })).rejects.toMatchObject({ code: 'muted' })
  })
})

describe('routes', () => {
  let app: FastifyInstance
  let bob: string, mod: string
  beforeEach(async () => {
    resetUserAuthForTests()
    await initUserAuthService(userFakeClient())
    initUserApiTokenService(fake.client)
    process.env.FORUM_MODERATOR_ACCOUNT_IDS = MOD
    app = Fastify({ logger: false })
    stripCorsFromPrivate(app)
    await app.register(cors, { origin: '*' })
    app.get('/explorer/ping', async () => ({ ok: true }))
    await app.register(forumRoutes)
    bob = await issueSession(BOB)
    mod = await issueSession(MOD)
  })
  afterEach(async () => { await app.close() })

  it('needs a session; the admin surface is a 404 for everyone but moderators', async () => {
    expect((await app.inject({ method: 'POST', url: '/user/forum/comments', payload: { threadKey: 'opengov:3', body: 'x' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/user/admin/forum/queue', headers: { authorization: `Bearer ${bob}` } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/user/admin/forum/queue', headers: { authorization: `Bearer ${mod}` } })).statusCode).toBe(200)
  })

  it('/user/ answers no other origin, and never caches', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/forum/me', headers: { authorization: `Bearer ${bob}`, origin: 'https://evil.example' } })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['cache-control']).toBe('no-store')
    const pre = await app.inject({ method: 'OPTIONS', url: '/user/forum/comments', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    const pub = await app.inject({ method: 'GET', url: '/explorer/ping', headers: { origin: 'https://evil.example' } })
    expect(pub.headers['access-control-allow-origin']).toBe('*')
    expect(pub.headers.vary ?? '').not.toMatch(/origin/i)
  })

  it('reports the gate before anyone types', async () => {
    const res = await app.inject({ method: 'GET', url: '/user/forum/me', headers: { authorization: `Bearer ${bob}` } })
    expect(res.json()).toMatchObject({ canComment: true, canPost: false, gate: { reason: 'no-stake-post' } })
  })

  it('refuses an SVG upload before anything reaches the IPFS node', async () => {
    const res = await app.inject({
      method: 'POST', url: '/user/forum/media',
      headers: { authorization: `Bearer ${bob}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    })
    expect(res.statusCode).toBe(415)
    expect(res.json()).toMatchObject({ reason: 'image:svg-or-markup' })
  })

  it('refuses a body over 5 MiB', async () => {
    const res = await app.inject({
      method: 'POST', url: '/user/forum/media',
      headers: { authorization: `Bearer ${bob}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(5 * 1024 * 1024 + 2048),
    })
    expect(res.statusCode).toBe(413)
  })

  it('an upload without a session is refused before its body is read', async () => {
    const res = await app.inject({ method: 'POST', url: '/user/forum/media', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(5 * 1024 * 1024) })
    expect(res.statusCode).toBe(401)
  })

  it('a refusal says why and how long to wait', async () => {
    const res = await app.inject({ method: 'POST', url: '/user/forum/discussions', headers: { authorization: `Bearer ${bob}` }, payload: { title: 't', body: 'b' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/100 HDX/)
  })
})

describe('import-guard flagging', () => {
  const refuse = (url: string, reason: string) => fake.mediaUrls.push({ original_url: url, cid: '', status: 'failed', reason, attempts: 1 })
  // Probe text arrives through the import (native writes refuse it): a post written here,
  // then its stored body replaced as the sync would store an imported one.
  const imported = async (title: string, body: string) => {
    const { post } = await write.createDiscussion(ctx(ALICE), { title, body: 'placeholder' })
    fake.posts.set(post.postId, { ...fake.posts.get(post.postId)!, body })
    return { post }
  }

  it('files one import-guard report on an item whose images the SSRF guard refused, and never twice', async () => {
    const { post } = await imported('Probe', '![c](http://db:8123/?query=SELECT%201)\n\n![d](https://10.0.2.1/x.png)\n\n![ok](https://i.imgur.com/a.png)')
    const { post: clean } = await write.createDiscussion(ctx(ALICE), { title: 'Clean', body: '![ok](https://i.imgur.com/a.png)' })
    refuse('http://db:8123/?query=SELECT%201', 'fetch:scheme')
    refuse('https://10.0.2.1/x.png', 'fetch:ip-literal')
    refuse('https://i.imgur.com/a.png', 'fetch:http-404') // a dead image is not a probe
    expect(await write.flagImportProbes()).toBe(1)
    const filed = [...fake.reports.values()]
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({ reporter_account_id: write.PROBE_REPORTER, target_id: post.postId, reason: 'other', status: 'open' })
    expect(String(filed[0].note)).toContain('http://db:8123/?query=SELECT%201 (scheme)')
    expect(String(filed[0].note)).toContain('https://10.0.2.1/x.png (ip-literal)')
    expect(filed.some(r => r.target_id === clean.postId)).toBe(false)
    expect(await write.flagImportProbes()).toBe(0)
    expect(fake.posts.get(post.postId)).toMatchObject({ hidden: 0 }) // it only queues
  })

  it('never reopens a report a moderator decided, and skips hidden items', async () => {
    const { post } = await imported('Probe', '![e](https://storage:5001/api/v0/version)')
    refuse('https://storage:5001/api/v0/version', 'fetch:port')
    expect(await write.flagImportProbes()).toBe(1)
    const [id] = [...fake.reports.keys()]
    fake.reports.set(id, { ...fake.reports.get(id)!, status: 'dismissed' })
    expect(await write.flagImportProbes()).toBe(0)
    expect(fake.reports.get(id)).toMatchObject({ status: 'dismissed' })

    const { post: other } = await imported('Probe 2', '![f](https://db./x.png)')
    refuse('https://db./x.png', 'fetch:private-address')
    await write.applyModeration(MOD, other.postId, 'hide', 'spam')
    expect(await write.flagImportProbes()).toBe(0)
    expect([...fake.reports.values()].some(r => r.target_id === other.postId)).toBe(false)
    expect(post.postId).not.toBe(other.postId)
  })
})

describe('links into a private or local network', () => {
  it('are refused in every native write — discussion, title, comment, Update, edit, summary — through the api', async () => {
    const probe = '![c](http://db:8123/?query=SELECT%201)'
    await expect(write.createDiscussion(ctx(ALICE), { title: 'Notes', body: probe })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    await expect(write.createDiscussion(ctx(ALICE), { title: 'see http://192.168.1.1/admin', body: 'x' })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    await expect(write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'look https://10.0.2.1/x.png' })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    const { post } = await write.createDiscussion(ctx(ALICE), { title: 'Fine', body: 'See https://hydration.net' })
    await expect(write.editPost(ctx(ALICE), post.postId, { body: 'now <http://localhost:5001/api/v0/config>' })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    await expect(write.editPost(ctx(ALICE), post.postId, { tldr: 'http://nas.local/' })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    const { comment } = await write.createComment(ctx(BOB), { threadKey: 'opengov:3', body: 'public https://github.com/x' })
    await expect(write.editComment(ctx(BOB), comment.commentId, { body: 'https://storage:5001/api/v0/version' })).rejects.toMatchObject({ status: 422, code: 'local-link' })
    expect(fake.posts.get(post.postId)).toMatchObject({ body: 'See https://hydration.net' })
  })
})
