import { describe, expect, it } from 'vitest'
import { motionIdsOf, planWrites, type SourceView } from '../../src/governance/subsquare/diff.js'
import { planNormalisation, type NormaliseLoader } from '../../src/governance/subsquare/normalise.js'
import { parseComment, parseItem, type SsItem } from '../../src/governance/subsquare/parse.js'
import { buildGroups, commentFingerprint, contentHashOf, postFingerprint, type BuildContext, type CommentRow, type PostRow, type RevisionRow } from '../../src/governance/subsquare/rows.js'
import { dropRacedRows, emptyBatch, recheckTargets, type ForumState, type StoredComment, type StoredPost } from '../../src/governance/subsquare/store.js'

// The Subsquare link rewrite in the sync: applied to what is imported, never read as
// an edit, never applied to text written here, and brought to stored rows by the
// normalisation pass without a revision of their own.

const PK = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
const author = { username: 'alice', publicKey: PK }
const ADDR = '7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos'
const OLD = 'Follows [the vote](https://hydradx.subsquare.io/democracy/referenda/18), see https://hydration.subsquare.io/posts/45.'
const NEW = 'Follows [the vote](/referendum/democracy/18), see [Discussion #45](/discussions/s45).'

const discussion = (fields: Record<string, unknown> = {}): SsItem => parseItem('discussions', {
  _id: '0000000000000000d15c0248', postUid: '248', title: 'source title', content: OLD, contentType: 'markdown', contentHash: 'c'.repeat(32),
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastActivityAt: '2025-02-01T00:00:00Z',
  commentsCount: 0, author, reactions: [], labels: [], ...fields,
})!

const emptyState = (): ForumState => ({ posts: new Map(), comments: new Map(), mediaUrls: new Map(), mediaCids: new Set(), removedCids: new Set() })
const ctx = (): BuildContext => ({ now: Date.parse('2025-03-01T00:00:00Z'), importing: false, firstSeen: () => true, nextSeq: () => 42 })
const noLoader = { posts: async () => [], comments: async () => [] }
const viewOf = (items: SsItem[], over: Partial<SourceView> = {}): SourceView => ({
  items: new Map(items.map(i => [i.subject, i])), gone: new Set(), groups: buildGroups(items, new Map()),
  discussionById: new Map(), links: new Map(), threads: new Map(), appendants: new Map(), pollJson: new Map(), ...over,
})
const stored = (p: PostRow, over: Partial<StoredPost> = {}): StoredPost => ({ ...p, source_activity_ms: 0, updated_ms: 1_000, created_ms: 0, ...over }) as unknown as StoredPost

describe('on import', () => {
  it('stores the body with Subsquare links pointing at the explorer, its hash that of the text as received', async () => {
    const r = await planWrites(viewOf([discussion()]), emptyState(), ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ body: NEW, source_hash: contentHashOf('source title\u0000' + OLD, 'c'.repeat(32)), revision: 0 })
    expect(r.batch.revisions).toEqual([expect.objectContaining({ revision: 0, body: NEW })])
  })

  it('rewrites a tip title that is a Subsquare URL', async () => {
    const tip = parseItem('tip', {
      _id: 'ffffffffffffffffffffffff', hash: '0x' + 'ab'.repeat(32), indexer: { blockHeight: 1687463 }, title: 'https://hydradx.subsquare.io/post/17', content: '',
      createdAt: '2023-06-01T00:00:00Z', author, reactions: [],
    })!
    const r = await planWrites(viewOf([tip]), emptyState(), ctx(), noLoader, {})
    expect(r.batch.posts[0].title).toBe('Discussion #17')
  })

  it('rewrites comments (Subsquare mentions become account links) and resolves a TC motion named by block and hash', async () => {
    const root = { postId: 'root', postType: 'post' }
    const d = discussion({ rootPost: root, commentsCount: 1 })
    const tcHash = '0x' + '0e'.repeat(32)
    const tc = parseItem('tc', { _id: 'eeeeeeeeeeeeeeeeeeeeeeee', motionIndex: 271, hash: tcHash, indexer: { blockHeight: 8533957 }, title: 't', createdAt: '2025-01-01T00:00:00Z', author, reactions: [] })!
    const body = `[@Alice](${ADDR}-hydradx) see https://hydration.subsquare.io/techcomm/proposals/8533957_${tcHash}`
    const thread = { ok: true, total: 1, comments: [parseComment({ _id: 'cccccccccccccccccccccccc', post: 'root', content: body, contentType: 'markdown', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!] }
    const r = await planWrites(viewOf([d], { groups: buildGroups([d], new Map()), threads: new Map([['root', thread]]), motionIds: motionIdsOf([tc]) }), emptyState(), ctx(), noLoader, {})
    expect(r.batch.comments[0].body).toBe(`[@Alice](/account/${ADDR}) see [Technical committee motion #271](/governance/motion/tc/271)`)
    expect(r.batch.comments[0].source_hash).toBe(contentHashOf(body, null))
  })

  it('an unchanged replay writes nothing', async () => {
    const state = emptyState()
    const first = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    state.posts.set('s248', stored(first.batch.posts[0]))
    const again = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    expect(again.batch.posts).toEqual([])
    expect(again.batch.revisions).toEqual([])
  })

  it('a row stored before the rewrite is rewritten on its next fetch as a normalisation: no revision, no edit time', async () => {
    const state = emptyState()
    const first = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    const before = { ...first.batch.posts[0], body: OLD }
    before.row_fp = postFingerprint(before)
    state.posts.set('s248', stored(before, { revision: 2 }))
    const r = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ body: NEW, revision: 2, edited_at: before.edited_at })
    expect(r.batch.revisions).toEqual([])
  })

  it('is never applied to text edited here: the native body stays as written, a later Subsquare edit is a (rewritten) revision only', async () => {
    const native = 'my own words, quoting https://hydration.subsquare.io/referenda/1'
    const state = emptyState()
    const first = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    state.posts.set('s248', stored(first.batch.posts[0], { authority: 'native', body: native, revision: 3 }))
    const edited = discussion({ content: `${OLD} (edited)`, contentHash: 'd'.repeat(32) })
    const r = await planWrites(viewOf([edited]), state, ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ authority: 'native', body: native, revision: 4 })
    expect(r.batch.revisions).toEqual([expect.objectContaining({ revision: 4, body: `${NEW} (edited)` })])
  })
})

// ---- the normalisation pass over stored rows ----

const ISO6 = '2025-01-01T00:00:00.000000Z' // ClickHouse's ISO spelling of a DateTime64(3)

function storedPostRow(over: Partial<PostRow> = {}): PostRow {
  const row: PostRow = {
    post_id: 's248', kind: 'discussion', title: 'https://hydradx.subsquare.io/post/17', body: OLD, body_format: 'markdown', tldr: '', labels: [], linked: [],
    author_account_id: '0x' + PK, author_legacy_name: '', authority: 'subsquare', source: 'subsquare', source_id: '0000000000000000d15c0248', source_cid: '',
    source_hash: 'c'.repeat(32), source_activity_at: ISO6, source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '', revision: 1,
    hidden: 1, hidden_reason: 'abuse', deleted: 0, created_at: ISO6, edited_at: '1970-01-01T00:00:00.000000Z', last_activity_at: ISO6, seq: 7,
    row_fp: '', updated_at: '', moderated: 1, locked: 1, ...over,
  }
  const asWritten = { ...row, source_activity_at: '2025-01-01T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z', edited_at: '1970-01-01T00:00:00.000Z', last_activity_at: '2025-01-01T00:00:00.000Z' }
  row.row_fp = over.row_fp ?? postFingerprint(asWritten)
  return row
}

function storedCommentRow(over: Partial<CommentRow> = {}): CommentRow {
  const row: CommentRow = {
    thread_key: 's248', comment_id: 'sabc', kind: 'comment', parent_id: '', reply_to_id: '', author_account_id: '0x' + PK, author_legacy_name: '',
    body: `[@Alice](${ADDR}-hydradx) agreed`, body_format: 'markdown', authority: 'subsquare', source: 'subsquare', source_id: 'abc', source_cid: '',
    source_hash: 'sha256:x', source_height: 0, source_removed: 0, revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: ISO6,
    edited_at: '1970-01-01T00:00:00.000000Z', seq: 0, row_fp: '', updated_at: '', moderated: 0, ...over,
  }
  row.row_fp = over.row_fp ?? commentFingerprint({ ...row, created_at: '2025-01-01T00:00:00.000Z', edited_at: '1970-01-01T00:00:00.000Z' })
  return row
}

function stateOf(posts: PostRow[], comments: CommentRow[]): ForumState {
  const s = emptyState()
  for (const p of posts) s.posts.set(p.post_id, { ...p, updated_ms: 1_000 } as unknown as StoredPost)
  for (const c of comments) s.comments.set(c.comment_id, { ...c, updated_ms: 1_000 } as unknown as StoredComment)
  return s
}

function loaderOf(posts: PostRow[], comments: CommentRow[], revisions: RevisionRow[]): NormaliseLoader {
  return {
    posts: async ids => posts.filter(p => ids.includes(p.post_id)).map(p => ({ ...p })),
    comments: async ids => comments.filter(c => ids.includes(c.comment_id)).map(c => ({ ...c })),
    revisions: async () => revisions.map(r => ({ ...r })),
  }
}

const rev = (target: string, revision: number, body: string, source = 'subsquare', title = ''): RevisionRow =>
  ({ target_id: target, revision, title, body, editor_account_id: '0x' + PK, source, created_at: '2025-01-01T00:00:00.123000Z' })

describe('the normalisation pass', () => {
  it('rewrites a stored imported row in place: same revision, seq, edit time and forum decisions; the fingerprint follows the text', async () => {
    const post = storedPostRow()
    const comment = storedCommentRow()
    const batch = emptyBatch()
    const stats = await planNormalisation(batch, stateOf([post], [comment]), {}, loaderOf([post], [comment], []), Date.parse('2026-01-01T00:00:00Z'))
    expect(stats).toEqual({ posts: 1, comments: 1, revisions: 0 })
    expect(batch.posts[0]).toMatchObject({
      title: 'Discussion #17', body: NEW, revision: 1, seq: 7, edited_at: post.edited_at, hidden: 1, hidden_reason: 'abuse', moderated: 1, locked: 1,
      source_hash: post.source_hash, updated_at: '2026-01-01T00:00:00.000Z',
    })
    // What the sync now computes from the unchanged source, so its next fetch writes nothing.
    expect(batch.posts[0].row_fp).toBe(postFingerprint({ ...batch.posts[0], source_activity_at: '2025-01-01T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z', edited_at: '1970-01-01T00:00:00.000Z', last_activity_at: '2025-01-01T00:00:00.000Z' }))
    expect(batch.comments[0]).toMatchObject({ body: `[@Alice](/account/${ADDR}) agreed`, revision: 0 })
    expect(batch.revisions).toEqual([])
  })

  it('recomputes the fingerprint from the row, whatever was stored', () => {
    const post = storedPostRow({ row_fp: 'written-under-an-older-rule' })
    const batch = emptyBatch()
    return planNormalisation(batch, stateOf([post], []), {}, loaderOf([post], [], []), 0).then(() => {
      expect(batch.posts[0].body).toBe(NEW)
      expect(batch.posts[0].row_fp).not.toBe('written-under-an-older-rule')
    })
  })

  it('rewrites imported revisions in place, keeping their number and version', async () => {
    const post = storedPostRow({ body: NEW, title: 'Discussion #17' })
    const batch = emptyBatch()
    const stats = await planNormalisation(batch, stateOf([post], []), {}, loaderOf([post], [], [
      rev('s248', 0, OLD, 'subsquare', 'https://hydradx.subsquare.io/post/17'), rev('s248', 1, NEW), rev('s248', 2, OLD, 'native'),
    ]), 0)
    expect(stats).toEqual({ posts: 0, comments: 0, revisions: 1 })
    expect(batch.revisions).toEqual([{ ...rev('s248', 0, NEW), title: 'Discussion #17' }])
  })

  it('never touches native rows, native edits or erased items, nor their revisions', async () => {
    const posts = [
      storedPostRow({ post_id: '12', source: '', source_id: '', authority: 'native' }),     // a native discussion
      storedPostRow({ post_id: 's1', authority: 'native' }),                                  // an imported post edited here
      storedPostRow({ post_id: 's2', deleted: 1, body: '', title: '' }),                      // deleted by its author here
      storedPostRow({ post_id: 's3', hidden_reason: 'purged' }),                              // purged by a moderator
    ]
    const comments = [
      storedCommentRow({ comment_id: 'c01HZX', source: '', source_id: '', authority: 'native' }),
      storedCommentRow({ comment_id: 'sedited', authority: 'native' }),
    ]
    const batch = emptyBatch()
    const stats = await planNormalisation(batch, stateOf(posts, comments), {}, loaderOf(posts, comments, [rev('s2', 0, OLD), rev('s3', 0, OLD)]), 0)
    expect(stats).toEqual({ posts: 0, comments: 0, revisions: 0 })
    expect(batch.posts).toEqual([])
    expect(batch.comments).toEqual([])
    expect(batch.revisions).toEqual([])
  })

  it('is a fixed point: a converged table plans nothing', async () => {
    const post = storedPostRow()
    const first = emptyBatch()
    await planNormalisation(first, stateOf([post], []), {}, loaderOf([post], [], [rev('s248', 0, OLD)]), 0)
    const after = first.posts[0]
    const second = emptyBatch()
    const stats = await planNormalisation(second, stateOf([after], []), {}, loaderOf([after], [], first.revisions), 0)
    expect(stats).toEqual({ posts: 0, comments: 0, revisions: 0 })
  })

  it('a revision rewritten on its own is deferred when its item was written here since the cycle read it', async () => {
    const post = storedPostRow({ body: NEW })
    const state = stateOf([post], [])
    const batch = emptyBatch()
    await planNormalisation(batch, state, {}, loaderOf([post], [], [rev('s248', 0, OLD)]), 0)
    expect(recheckTargets(batch, state)).toEqual({ postIds: ['s248'], comments: [] })
    const raced = dropRacedRows(batch, state, { posts: new Map([['s248', 2_000]]), comments: new Map() })
    expect(raced.deferred).toEqual(['s248'])
    expect(raced.batch.revisions).toEqual([])
    const quiet = dropRacedRows(batch, state, { posts: new Map([['s248', 1_000]]), comments: new Map() })
    expect(quiet.batch.revisions).toHaveLength(1)
  })
})

describe('"edited" only when there is more than one version', () => {
  it('a new import has no edit time, whatever Subsquare\'s `edited` flag and updatedAt say', async () => {
    const r = await planWrites(viewOf([discussion({ edited: true, updatedAt: '2025-06-01T00:00:00Z' })]), emptyState(), ctx(), noLoader, {})
    expect(r.batch.posts[0]).toMatchObject({ revision: 0, edited_at: '1970-01-01T00:00:00.000Z' })
  })

  it('a moved hash with the same text is no new version; changed text is, with its time', async () => {
    const state = emptyState()
    const first = await planWrites(viewOf([discussion()]), state, ctx(), noLoader, {})
    state.posts.set('s248', stored(first.batch.posts[0]))
    const sameText = await planWrites(viewOf([discussion({ contentHash: 'e'.repeat(32) })]), state, ctx(), noLoader, {})
    expect(sameText.batch.posts[0]).toMatchObject({ revision: 0, edited_at: '1970-01-01T00:00:00.000Z', source_hash: 'e'.repeat(32) })
    expect(sameText.batch.revisions).toEqual([])
    const edited = await planWrites(viewOf([discussion({ content: 'new words', contentHash: 'f'.repeat(32), updatedAt: '2025-02-10T00:00:00Z' })]), state, ctx(), noLoader, {})
    expect(edited.batch.posts[0]).toMatchObject({ revision: 1, edited_at: '2025-02-10T00:00:00.000Z' })
    expect(edited.batch.revisions).toEqual([expect.objectContaining({ revision: 1, body: 'new words' })])
  })

  it('a comment whose hash moved but text did not gets no new version', async () => {
    const root = { postId: 'root', postType: 'post' }
    const d = discussion({ rootPost: root, commentsCount: 1 })
    const c = (content: string) => ({ ok: true, total: 1, comments: [parseComment({ _id: 'cccccccccccccccccccccccc', post: 'root', content, contentType: 'markdown', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!] })
    const view = (content: string) => viewOf([d], { groups: buildGroups([d], new Map()), threads: new Map([['root', c(content)]]) })
    const first = await planWrites(view('hello'), emptyState(), ctx(), noLoader, {})
    const state = emptyState()
    state.comments.set('scccccccccccccccccccccccc', { ...first.batch.comments[0], source_hash: 'sha256:older-hash', row_fp: 'older', updated_ms: 1_000 } as unknown as StoredComment)
    const r = await planWrites(view('hello'), state, ctx(), noLoader, {})
    expect(r.batch.comments[0]).toMatchObject({ comment_id: 'scccccccccccccccccccccccc', revision: 0 })
    expect(r.batch.revisions.filter(x => x.target_id === 'scccccccccccccccccccccccc')).toEqual([])
  })

  it('the pass clears a single-version post\'s edit time and leaves multi-version and native ones', async () => {
    const edited = '2025-01-02T00:00:00.000000Z'
    const posts = [
      storedPostRow({ post_id: 's1', title: 't', body: 'b', edited_at: edited, revision: 0 }),
      storedPostRow({ post_id: 's2', title: 't', body: 'b', edited_at: edited, revision: 1 }),
      storedPostRow({ post_id: 's3', title: 't', body: 'b', edited_at: edited, revision: 0, authority: 'native' }),
    ]
    const batch = emptyBatch()
    const stats = await planNormalisation(batch, stateOf(posts, []), {}, loaderOf(posts, [], []), 0)
    expect(stats.posts).toBe(1)
    expect(batch.posts).toEqual([expect.objectContaining({ post_id: 's1', edited_at: '1970-01-01T00:00:00.000Z', revision: 0 })])
    expect(batch.revisions).toEqual([])
  })
})
