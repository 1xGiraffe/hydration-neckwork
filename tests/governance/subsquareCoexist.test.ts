import { describe, expect, it } from 'vitest'
import { planWrites, type SourceView } from '../../src/governance/subsquare/diff.js'
import { parseComment, parseItem, type SsItem } from '../../src/governance/subsquare/parse.js'
import { buildGroups, postRow, type BuildContext, type PostRow } from '../../src/governance/subsquare/rows.js'
import {
  dropRacedRows, emptyBatch, loadFullComments, loadFullPosts, type ForumState, type StoredComment, type StoredPost,
} from '../../src/governance/subsquare/store.js'
import type { ClickHouseClient } from '../../src/db/client.js'

// The Subsquare sync beside native writes: what this forum decided (a moderator's
// hide or restore, a locked thread, an author's delete, a native edit) survives
// every sync rewrite, native rows are never touched, and a row written while a
// cycle ran is deferred rather than overwritten.

const PK = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
const ME = '0x' + PK
const author = { username: 'alice', publicKey: PK }

const discussion = (fields: Record<string, unknown> = {}): SsItem => parseItem('discussions', {
  _id: '0000000000000000d15c0248', postUid: '248', title: 'source title', content: 'source body', contentType: 'markdown',
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastActivityAt: '2025-02-01T00:00:00Z',
  commentsCount: 0, author, reactions: [], labels: ['Treasury'], ...fields,
})!

const emptyState = (): ForumState => ({ posts: new Map(), comments: new Map(), mediaUrls: new Map(), mediaCids: new Set(), removedCids: new Set() })
const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({ now: Date.parse('2025-03-01T00:00:00Z'), importing: false, firstSeen: () => true, nextSeq: () => 42, ...over })
const noLoader = { posts: async () => [], comments: async () => [] }

function viewOf(items: SsItem[], over: Partial<SourceView> = {}): SourceView {
  return {
    items: new Map(items.map(i => [i.subject, i])), gone: new Set(),
    groups: buildGroups(items, new Map()), discussionById: new Map(), links: new Map(), threads: new Map(), appendants: new Map(), pollJson: new Map(),
    ...over,
  }
}

const storedPost = (p: PostRow, over: Partial<StoredPost> = {}): StoredPost =>
  ({ ...p, source_activity_ms: 0, updated_ms: 1_000, created_ms: 0, ...over }) as unknown as StoredPost
const storedComment = (c: Record<string, unknown>): StoredComment =>
  ({ created_ms: 0, updated_ms: 1_000, edited_at: '1970-01-01T00:00:00.000Z', deleted: 0, moderated: 0, ...c }) as unknown as StoredComment

/** The post as the sync last wrote it from `item`, stored. */
async function seeded(item: SsItem, over: Partial<StoredPost> = {}): Promise<ForumState> {
  const state = emptyState()
  const first = await planWrites(viewOf([item]), state, ctx(), noLoader, {})
  state.posts.set(item.subject, storedPost(first.batch.posts[0], over))
  return state
}

describe('a moderator decision survives the sync', () => {
  it('a moderated hide holds through a Subsquare change, with no log row the sync did not cause', async () => {
    const state = await seeded(discussion(), { moderated: 1, hidden: 1, hidden_reason: 'abuse', locked: 1, deleted: 0 })
    const r = await planWrites(viewOf([discussion({ content: 'edited on subsquare', contentHash: 'a'.repeat(32) })]), state, ctx(), noLoader, {})
    expect(r.batch.posts).toHaveLength(1)
    expect(r.batch.posts[0]).toMatchObject({ hidden: 1, hidden_reason: 'abuse', moderated: 1, locked: 1, body: 'edited on subsquare' })
    expect(r.batch.modlog).toEqual([])
  })

  it('a moderated restore holds when Subsquare hides or marks it spam', async () => {
    const state = await seeded(discussion({ hide: true }), { moderated: 1, hidden: 0, hidden_reason: '' })
    const r = await planWrites(viewOf([discussion({ isMalicious: true })]), state, ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ hidden: 0, hidden_reason: '', moderated: 1 })
    expect(r.batch.modlog).toEqual([])
  })

  it('removal on Subsquare records the fact but does not re-hide a moderated post', async () => {
    const state = await seeded(discussion(), { moderated: 1, hidden: 0 })
    const row = { ...state.posts.get('s248')!, moderated: 1, locked: 0, hidden: 0, hidden_reason: '' } as unknown as PostRow
    const loader = { posts: async () => [{ ...row }], comments: async () => [] }
    const r = await planWrites(viewOf([], { gone: new Set(['s248']) }), state, ctx(), loader, {})
    expect(r.batch.posts[0]).toMatchObject({ post_id: 's248', source_removed: 1, hidden: 0, moderated: 1 })
    expect(r.batch.modlog).toEqual([])
  })

  it('an unmoderated removal still hides and logs', async () => {
    const state = await seeded(discussion())
    const row = { ...state.posts.get('s248')!, moderated: 0, locked: 0 } as unknown as PostRow
    const r = await planWrites(viewOf([], { gone: new Set(['s248']) }), state, ctx(), { posts: async () => [{ ...row }], comments: async () => [] }, {})
    expect(r.batch.posts[0]).toMatchObject({ hidden: 1, hidden_reason: 'removed-on-subsquare', source_removed: 1 })
    expect(r.batch.modlog).toEqual([expect.objectContaining({ action: 'hide', reason_code: 'removed-on-subsquare' })])
  })

  it('an author delete is carried; the sync never sets deleted or locked itself', async () => {
    const state = await seeded(discussion(), { deleted: 1, authority: 'native', title: '', body: '' })
    const r = await planWrites(viewOf([discussion({ content: 'changed', contentHash: 'b'.repeat(32) })]), state, ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ deleted: 1, title: '', body: '', authority: 'native', locked: 0 })
    // Its revisions were purged by the delete: the Subsquare change writes none back.
    expect(r.batch.revisions).toEqual([])
    expect(r.batch.posts[0].revision).toBe(state.posts.get('s248')!.revision)
    // A fresh import never carries either flag.
    const fresh = await planWrites(viewOf([discussion()]), emptyState(), ctx(), noLoader, {})
    expect(fresh.batch.posts[0]).toMatchObject({ deleted: 0, locked: 0, moderated: 0 })
  })

  it('a moderated comment keeps its visibility; a native comment edit keeps its text and edit time', async () => {
    const item = discussion({ commentsCount: 2 })
    const thread = { ok: true, total: 2, comments: [
      parseComment({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', post: '0000000000000000d15c0248', content: 'source a v2', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!,
      parseComment({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', post: '0000000000000000d15c0248', content: 'source b v2', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!,
    ] }
    const groups = buildGroups([item], new Map([['0000000000000000d15c0248', 's248']]))
    const state = await seeded(item)
    state.comments.set('saaaaaaaaaaaaaaaaaaaaaaaa', storedComment({ thread_key: 's248', comment_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', kind: 'comment', authority: 'subsquare', source_hash: 'old', row_fp: 'old', hidden: 1, hidden_reason: 'spam', moderated: 1, revision: 0, seq: 0, body: 'source a', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    state.comments.set('sbbbbbbbbbbbbbbbbbbbbbbbb', storedComment({ thread_key: 's248', comment_id: 'sbbbbbbbbbbbbbbbbbbbbbbbb', kind: 'comment', authority: 'native', source_hash: 'old', row_fp: 'old', hidden: 0, hidden_reason: '', revision: 2, seq: 7, body: 'my edit', edited_at: '2025-02-02T00:00:00.000Z', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    const view = viewOf([item], { groups, discussionById: new Map([['0000000000000000d15c0248', 's248']]), threads: new Map([[groups.keys().next().value!, thread]]) })
    const r = await planWrites(view, state, ctx(), noLoader, {})
    const a = r.batch.comments.find(c => c.comment_id === 'saaaaaaaaaaaaaaaaaaaaaaaa')!
    const b = r.batch.comments.find(c => c.comment_id === 'sbbbbbbbbbbbbbbbbbbbbbbbb')!
    expect(a).toMatchObject({ hidden: 1, hidden_reason: 'spam', moderated: 1 })
    expect(b).toMatchObject({ authority: 'native', body: 'my edit', edited_at: '2025-02-02T00:00:00.000Z', revision: 3, seq: 7 })
    expect(r.batch.revisions.find(x => x.target_id === 'sbbbbbbbbbbbbbbbbbbbbbbbb')).toMatchObject({ revision: 3, body: 'source b v2', source: 'subsquare' })
  })
})

describe('a deleted comment', () => {
  it('gets no revision row on a later Subsquare change, and keeps deleted/authority/body', async () => {
    const item = discussion({ commentsCount: 1 })
    const groups = buildGroups([item], new Map([['0000000000000000d15c0248', 's248']]))
    const state = await seeded(item)
    state.comments.set('saaaaaaaaaaaaaaaaaaaaaaaa', storedComment({ thread_key: 's248', comment_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', kind: 'comment', authority: 'native', source_hash: 'old', row_fp: 'old', hidden: 0, hidden_reason: '', deleted: 1, revision: 1, seq: 0, body: '', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    const thread = { ok: true, total: 1, comments: [parseComment({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', post: '0000000000000000d15c0248', content: 'edited on subsquare', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!] }
    const r = await planWrites(viewOf([item], { groups, discussionById: new Map([['0000000000000000d15c0248', 's248']]), threads: new Map([[groups.keys().next().value!, thread]]) }), state, ctx(), noLoader, {})
    expect(r.batch.comments.find(c => c.comment_id === 'saaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ deleted: 1, authority: 'native', body: '', revision: 1 })
    expect(r.batch.revisions.filter(x => x.target_id === 'saaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([])
  })

  it('a comment a moderator purged gets no revision row either', async () => {
    const item = discussion({ commentsCount: 1 })
    const groups = buildGroups([item], new Map([['0000000000000000d15c0248', 's248']]))
    const state = await seeded(item)
    state.comments.set('saaaaaaaaaaaaaaaaaaaaaaaa', storedComment({ thread_key: 's248', comment_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', kind: 'comment', authority: 'native', source_hash: 'old', row_fp: 'old', hidden: 1, hidden_reason: 'purged', moderated: 1, deleted: 0, revision: 1, seq: 0, body: '', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    const thread = { ok: true, total: 1, comments: [parseComment({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', post: '0000000000000000d15c0248', content: 'edited on subsquare', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!] }
    const r = await planWrites(viewOf([item], { groups, discussionById: new Map([['0000000000000000d15c0248', 's248']]), threads: new Map([[groups.keys().next().value!, thread]]) }), state, ctx(), noLoader, {})
    expect(r.batch.comments.find(c => c.comment_id === 'saaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ hidden: 1, hidden_reason: 'purged', body: '', revision: 1 })
    expect(r.batch.revisions.filter(x => x.target_id === 'saaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([])
  })
})

describe('native authority', () => {
  it('keeps title, body, TL;DR, labels and edit time; row_fp stays the source fingerprint, so an unchanged source writes nothing', async () => {
    const src = discussion()
    const state = await seeded(src, {
      authority: 'native', title: 'my title', body: 'my body', tldr: 'short', labels: ['Meta'], edited_at: '2025-02-10T00:00:00.000Z',
    })
    const sourceFp = (postRow({ item: src, linked: [], removed: false, pollJson: '' }) as PostRow).row_fp
    expect(state.posts.get('s248')!.row_fp).toBe(sourceFp)
    const quiet = await planWrites(viewOf([src]), state, ctx(), noLoader, {})
    expect(quiet.batch.posts).toEqual([])
    const changed = await planWrites(viewOf([discussion({ title: 'new source title', contentHash: 'c'.repeat(32) })]), state, ctx(), noLoader, {})
    const row = changed.batch.posts[0]
    expect(row).toMatchObject({ authority: 'native', title: 'my title', body: 'my body', tldr: 'short', labels: ['Meta'], edited_at: '2025-02-10T00:00:00.000Z' })
    expect(row.row_fp).toBe((postRow({ item: discussion({ title: 'new source title', contentHash: 'c'.repeat(32) }), linked: [], removed: false, pollJson: '' }) as PostRow).row_fp)
    expect(changed.batch.revisions).toEqual([expect.objectContaining({ title: 'new source title', source: 'subsquare', revision: 1 })])
  })
})

describe('native rows are never touched', () => {
  it('removal detection reads s-ids only: native comments in a thread read whole stay as they are', async () => {
    const item = discussion({ commentsCount: 1 })
    const groups = buildGroups([item], new Map([['0000000000000000d15c0248', 's248']]))
    const state = await seeded(item)
    state.comments.set('c01JABCDEFGHJKMNPQRSTVWXYZ', storedComment({ thread_key: 's248', comment_id: 'c01JABCDEFGHJKMNPQRSTVWXYZ', kind: 'comment', authority: 'native', source_hash: '', row_fp: '', hidden: 0, hidden_reason: '', revision: 0, seq: 9, body: 'native', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    state.comments.set('c01JUPDATE00000000000000000', storedComment({ thread_key: 's248', comment_id: 'c01JUPDATE00000000000000000', kind: 'update', authority: 'native', source_hash: '', row_fp: '', hidden: 0, hidden_reason: '', revision: 0, seq: 10, body: 'update', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    state.comments.set('sgone', storedComment({ thread_key: 's248', comment_id: 'sgone', kind: 'comment', authority: 'subsquare', source_hash: 'h', row_fp: 'f', hidden: 0, hidden_reason: '', revision: 0, seq: 0, body: 'x', source_removed: 0, parent_id: '', reply_to_id: '', author_account_id: ME, author_legacy_name: '' }))
    const requested: string[][] = []
    const loader = { posts: async () => [], comments: async (ids: string[]) => { requested.push(ids); return [] } }
    const thread = { ok: true, total: 0, comments: [] }
    await planWrites(viewOf([item], { groups, discussionById: new Map([['0000000000000000d15c0248', 's248']]), threads: new Map([[groups.keys().next().value!, thread]]) }), state, ctx(), loader, {})
    expect(requested.flat()).toEqual(['sgone'])
  })

  it('a native discussion (decimal id) is never planned, stubbed or removed', async () => {
    const state = await seeded(discussion())
    state.posts.set('17', storedPost({ ...state.posts.get('s248')!, post_id: '17', source: '', source_id: '', authority: 'native', row_fp: '' } as unknown as PostRow))
    const r = await planWrites(viewOf([discussion({ content: 'changed', contentHash: 'd'.repeat(32) })], { gone: new Set(['s999']) }), state, ctx(), noLoader, {})
    expect(r.batch.posts.map(p => p.post_id)).toEqual(['s248'])
  })
})

describe('an api stub post', () => {
  it('is replaced by the full Subsquare row, the source text as revision 0, its seq kept', async () => {
    const item = parseItem('opengov', {
      _id: '0000000000000000aef00450', referendumIndex: 450, title: 'Proposal title', content: 'proposal body', contentType: 'markdown',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastActivityAt: '2025-02-01T00:00:00Z', commentsCount: 0, author, reactions: [],
    })!
    expect(item.subject).toBe('opengov:450')
    const state = emptyState()
    state.posts.set('opengov:450', {
      post_id: 'opengov:450', kind: 'opengov', authority: '', body_format: 'markdown', revision: 0, source_hash: '', source_comments_count: 0, source_activity_ms: 0,
      hidden: 0, hidden_reason: '', source_removed: 0, row_fp: '', seq: 5, title: '', body: '', source_id: '', linked: [], poll_json: '',
      updated_ms: 1_000, author_account_id: '', author_legacy_name: '', created_ms: 0, tldr: '', labels: [], edited_at: '1970-01-01T00:00:00.000Z',
      deleted: 0, moderated: 0, locked: 0, banner_cid: '',
    })
    const r = await planWrites(viewOf([item]), state, ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ post_id: 'opengov:450', title: 'Proposal title', body: 'proposal body', authority: 'subsquare', source: 'subsquare', revision: 0, seq: 5 })
    expect(r.batch.revisions).toEqual([expect.objectContaining({ target_id: 'opengov:450', revision: 0, body: 'proposal body' })])
  })
})

describe('the write-time recheck', () => {
  it('drops rows written since the cycle read the tables, with their revisions and log rows; keeps the rest', () => {
    const state = emptyState()
    state.posts.set('s1', { updated_ms: 1_000 } as StoredPost)
    state.posts.set('s2', { updated_ms: 1_000 } as StoredPost)
    state.comments.set('saaaaaaaaaaaaaaaaaaaaaaaa', { updated_ms: 1_000 } as StoredComment)
    const batch = emptyBatch()
    batch.posts.push({ post_id: 's1' } as PostRow, { post_id: 's2' } as PostRow, { post_id: 'opengov:9' } as PostRow, { post_id: 's3' } as PostRow)
    batch.comments.push({ comment_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', thread_key: 's1' } as never, { comment_id: 'sbbbbbbbbbbbbbbbbbbbbbbbb', thread_key: 's1' } as never)
    batch.revisions.push({ target_id: 's1', revision: 2 } as never, { target_id: 's2', revision: 1 } as never, { target_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', revision: 1 } as never)
    batch.modlog.push({ target_id: 's1', action_id: 'x' } as never, { target_id: 's2', action_id: 'y' } as never)
    const current = {
      // s1 edited here after the read; s2 unchanged; opengov:9 created here (a stub) after the read; s3 still absent
      posts: new Map([['s1', 2_000], ['s2', 1_000], ['opengov:9', 1_500]]),
      // sa unchanged; sb absent
      comments: new Map([['saaaaaaaaaaaaaaaaaaaaaaaa', 1_000]]),
    }
    const { batch: out, deferred } = dropRacedRows(batch, state, current)
    expect(deferred.sort()).toEqual(['opengov:9', 's1'])
    expect(out.posts.map(p => p.post_id)).toEqual(['s2', 's3'])
    expect(out.comments.map(c => c.comment_id)).toEqual(['saaaaaaaaaaaaaaaaaaaaaaaa', 'sbbbbbbbbbbbbbbbbbbbbbbbb'])
    expect(out.revisions.map(r => r.target_id)).toEqual(['s2', 'saaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(out.modlog.map(m => m.target_id)).toEqual(['s2'])
  })

  it('is a no-op when nothing raced', () => {
    const state = emptyState()
    state.posts.set('s1', { updated_ms: 1_000 } as StoredPost)
    const batch = emptyBatch()
    batch.posts.push({ post_id: 's1' } as PostRow)
    const r = dropRacedRows(batch, state, { posts: new Map([['s1', 1_000]]), comments: new Map() })
    expect(r.deferred).toEqual([])
    expect(r.batch).toBe(batch)
  })
})

describe('whole-row reads carry the native columns', () => {
  function fakeClient(rows: Record<string, unknown>[], seen: string[]): ClickHouseClient {
    return { query: async ({ query }: { query: string }) => { seen.push(query); return { json: async () => rows } } } as unknown as ClickHouseClient
  }
  it('loadFullPosts and loadFullComments select moderated/locked and return them as numbers', async () => {
    const seen: string[] = []
    const posts = await loadFullPosts(fakeClient([{ post_id: 's1', moderated: '1', locked: '1', revision: '0', hidden: '1', deleted: '0', source_removed: '0', source_comments_count: '0', seq: '0' }], seen), ['s1'])
    expect(posts[0]).toMatchObject({ moderated: 1, locked: 1 })
    const comments = await loadFullComments(fakeClient([{ comment_id: 'saaaaaaaaaaaaaaaaaaaaaaaa', moderated: '1', revision: '0', hidden: '1', deleted: '0', source_removed: '0', source_height: '0', seq: '0' }], seen), ['saaaaaaaaaaaaaaaaaaaaaaaa'])
    expect(comments[0]).toMatchObject({ moderated: 1 })
    expect(seen[0]).toMatch(/\bmoderated\b.*\blocked\b/)
    expect(seen[1]).toMatch(/\bmoderated\b/)
  })
})
