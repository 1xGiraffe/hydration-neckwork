import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { planWrites, type SourceView } from '../../src/governance/subsquare/diff.js'
import { parseComment, parseItem, type CollectionName, type SsItem } from '../../src/governance/subsquare/parse.js'
import { boundLinks, buildGroups, contentHashOf, flattenThread, imageUrlsIn, ipfsCidOf, linkedOf, type BuildContext } from '../../src/governance/subsquare/rows.js'
import type { ForumState } from '../../src/governance/subsquare/store.js'
import { MAX_SLOT_CATCHUP, rotationDue, slotsPerWindow, sweepBucket, sweepSlot, unchanged } from '../../src/governance/subsquare/sync.js'
import { urlDue } from '../../src/governance/subsquare/images.js'

const PK = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
// Subsquare ids are MongoDB ObjectIds (24 lower-case hex); the parser refuses anything
// else. A one-letter hex tag spells one by repetition ('a' → 'aaaa…'), so expected
// comment ids stay readable; an item's id is a digest of what makes it distinct.
const oid = (tag: string) => (/^[0-9a-f]$/.test(tag) ? tag.repeat(24) : createHash('sha256').update(tag).digest('hex').slice(0, 24))
const author = { username: 'alice', publicKey: PK }

function item(collection: CollectionName, fields: Record<string, unknown>, root: { postId: string; postType: string } | null): SsItem {
  return parseItem(collection, {
    _id: oid(`${collection}-${JSON.stringify(fields)}`), title: 't', content: 'body', contentType: 'markdown',
    createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', lastActivityAt: '2025-02-01T00:00:00Z',
    commentsCount: 2, author, reactions: [], ...(root ? { rootPost: root } : {}), ...fields,
  })!
}

const comment = (id: string, root: string, replies: unknown[] = [], over: Record<string, unknown> = {}) => ({
  _id: oid(id), motion: root, replyToComment: null, content: `c-${id}`, contentType: 'markdown', createdAt: '2025-01-05T00:00:00Z',
  author, reactions: [], replies, ...over,
})

const emptyState = (): ForumState => ({ posts: new Map(), comments: new Map(), mediaUrls: new Map(), mediaCids: new Set(), removedCids: new Set() })
const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({ now: Date.parse('2025-03-01T00:00:00Z'), importing: true, firstSeen: () => true, nextSeq: () => 42, ...over })
const loader = { posts: async () => [], comments: async () => [] }

describe('merged threads', () => {
  // Council motion ↔ external proposal ↔ democracy referendum share one root post on Subsquare.
  const root = { postId: 'root-motion', postType: 'motion' }
  const council = item('council', { motionIndex: 250 }, root)
  const external = item('external', { externalProposalHash: '0x' + '11'.repeat(32), indexer: { blockHeight: 6820789 } }, root)
  const democracy = item('democracy', { referendumIndex: 113 }, root)
  const groups = buildGroups([external, democracy, council], new Map())
  const g = groups.get('root-motion')!

  it('files the thread under the owner its root post names, linking every member', () => {
    expect(g.owner).toBe('council:250')
    expect(linkedOf('democracy:113', g)).toEqual(['council:250', `external:0x${'11'.repeat(32)}@6820789`])
    expect(linkedOf('council:250', g)).toEqual(['democracy:113', `external:0x${'11'.repeat(32)}@6820789`])
  })

  it('a treasury proposal under an OpenGov referendum files into opengov:<referendumIndex>', () => {
    const tp = item('treasury', { proposalIndex: 31, referendumIndex: 390 }, { postId: 'r390', postType: 'referendaReferendum' })
    expect(buildGroups([tp], new Map()).get('r390')!.owner).toBe('opengov:390')
  })

  it('dedupes on the comment _id and keeps two levels', () => {
    const thread = [comment('a', 'root-motion', [comment('b', 'root-motion', [], { replyToComment: oid('a') })]), comment('a', 'root-motion'), comment('c', 'root-motion')]
    const flat = flattenThread(g.owner, thread.map(c => parseComment(c)!), () => {})
    expect(flat.map(f => [f.row.comment_id, f.row.parent_id, f.row.reply_to_id])).toEqual([['saaaaaaaaaaaaaaaaaaaaaaaa', '', ''], ['sbbbbbbbbbbbbbbbbbbbbbbbb', 'saaaaaaaaaaaaaaaaaaaaaaaa', 'saaaaaaaaaaaaaaaaaaaaaaaa'], ['scccccccccccccccccccccccc', '', '']])
    expect(flat.every(f => f.row.thread_key === 'council:250')).toBe(true)
  })

  it('writes the thread once and every linked subject a post row, then nothing on an unchanged replay', async () => {
    const thread = { ok: true, total: 2, comments: [comment('a', 'root-motion', [comment('b', 'root-motion')])].map(c => parseComment(c)!) }
    const view: SourceView = {
      items: new Map([council, external, democracy].map(i => [i.subject, i])), gone: new Set(), 
      groups, discussionById: new Map(), links: new Map(), threads: new Map([['root-motion', thread]]), appendants: new Map(), pollJson: new Map(),
    }
    const state = emptyState()
    const first = await planWrites(view, state, ctx(), loader, {})
    expect(first.batch.posts.map(p => p.post_id).sort()).toEqual(['council:250', 'democracy:113', `external:0x${'11'.repeat(32)}@6820789`])
    expect(first.batch.comments.map(c => c.comment_id)).toEqual(['saaaaaaaaaaaaaaaaaaaaaaaa', 'sbbbbbbbbbbbbbbbbbbbbbbbb'])
    expect(first.stats.revisions).toBe(5) // revision 0 of three posts and two comments
    expect(first.batch.posts.every(p => p.seq === 0)).toBe(true) // the import never notifies
    // Store what was written; the same source then plans no write at all.
    for (const p of first.batch.posts) state.posts.set(p.post_id, { ...p, source_activity_ms: 0, updated_ms: 0, created_ms: 0 } as never)
    for (const c of first.batch.comments) state.comments.set(c.comment_id, { ...c, created_ms: 0 } as never)
    const again = await planWrites(view, state, ctx(), loader, {})
    expect(again.batch.posts.length + again.batch.comments.length + again.batch.revisions.length).toBe(0)
  })
})

describe('bound discussions', () => {
  it('files a comment under the subject its own owner names, once, and links the bound pair both ways', async () => {
    const disc = parseItem('discussions', { _id: '111111111111111111111111', postUid: '20', title: 't', content: 'b', createdAt: '2025-01-01T00:00:00Z', commentsCount: 1, author, reactions: [] })!
    const tip = item('tip', { hash: '0x' + '22'.repeat(32), indexer: { blockHeight: 5 }, refToPost: { postId: '111111111111111111111111', postType: 'post' } }, { postId: 'tip-root', postType: 'tip' })
    const all = [disc, tip]
    const discussionById = new Map([['111111111111111111111111', 's20']])
    const groups = buildGroups(all, discussionById)
    const c = parseComment({ _id: '222222222222222222222222', post: '111111111111111111111111', content: 'hello', createdAt: '2025-01-05T00:00:00Z', author, reactions: [], replies: [] })!
    const view: SourceView = {
      items: new Map(all.map(i => [i.subject, i])), gone: new Set(), groups, discussionById,
      links: boundLinks(all, discussionById), appendants: new Map(), pollJson: new Map(),
      // Both endpoints return the discussion's comment.
      threads: new Map([['111111111111111111111111', { ok: true, total: 1, comments: [c] }], ['tip-root', { ok: true, total: 1, comments: [c] }]]),
    }
    const r = await planWrites(view, emptyState(), ctx(), loader, {})
    expect(r.batch.comments.map(x => [x.thread_key, x.comment_id])).toEqual([['s20', 's222222222222222222222222']])
    const linked = Object.fromEntries(r.batch.posts.map(p => [p.post_id, p.linked]))
    expect(linked.s20).toEqual([tip.subject])
    expect(linked[tip.subject]).toEqual(['s20'])
  })

  it('names a motion without an index by its hash and block, and accepts a list item\'s poll id', () => {
    const tc = parseItem('tc', { _id: '333333333333333333333333', hash: '0x' + '33'.repeat(32), indexer: { blockHeight: 100 }, title: 'x', createdAt: '2023-01-27T10:24:48.268Z' })!
    expect(tc.subject).toBe(`tc:0x${'33'.repeat(32)}@100`)
    const d = parseItem('discussions', { _id: oid('d'), postUid: '2', poll: '636bdb6c953f60259278f7fb', createdAt: '2023-01-27T10:24:48.268Z' })!
    expect(d.poll).toBeNull()
  })
})

describe('change detection', () => {
  const base = item('discussions', { postUid: '248' }, null)

  async function plan(state: ForumState, it: SsItem, c: BuildContext = ctx()) {
    const view: SourceView = { items: new Map([[it.subject, it]]), gone: new Set(), groups: buildGroups([it], new Map()), discussionById: new Map(), links: new Map(), threads: new Map(), appendants: new Map(), pollJson: new Map() }
    return planWrites(view, state, c, loader, {})
  }
  function stored(state: ForumState, rows: Awaited<ReturnType<typeof plan>>) {
    for (const p of rows.batch.posts) state.posts.set(p.post_id, { ...p, source_activity_ms: 0, updated_ms: 0, created_ms: 0 } as never)
  }

  it('a content change is the next revision; a native-authority post keeps its text', async () => {
    const state = emptyState()
    stored(state, await plan(state, base))
    const edited = { ...base, content: 'edited body', contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    const r = await plan(state, edited)
    expect(r.batch.posts[0]).toMatchObject({ revision: 1, body: 'edited body' })
    expect(r.batch.revisions).toEqual([expect.objectContaining({ target_id: 's248', revision: 1, body: 'edited body', source: 'subsquare' })])
    state.posts.set('s248', { ...state.posts.get('s248')!, authority: 'native', body: 'my own text' })
    const r2 = await plan(state, { ...edited, content: 'third', contentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    expect(r2.batch.posts[0]).toMatchObject({ authority: 'native', body: 'my own text' })
    expect(r2.batch.revisions[0]).toMatchObject({ body: 'third' })
  })

  it('logs Subsquare hiding and restoring publicly, once per transition', async () => {
    const state = emptyState()
    const first = await plan(state, { ...base, isMalicious: true })
    expect(first.batch.modlog).toEqual([expect.objectContaining({ action: 'hide', reason_code: 'spam', moderator_account_id: 'subsquare', action_id: 'subsquare:hide:spam:import' })])
    stored(state, first)
    const restore = await plan(state, base)
    expect(restore.batch.modlog).toEqual([expect.objectContaining({ action: 'restore', reason_code: 'spam' })])
  })

  it('only a first-seen item under an hour old gets a notification seq', async () => {
    const now = Date.parse('2025-01-01T00:30:00Z')
    const live = await plan(emptyState(), base, ctx({ importing: false, now }))
    expect(live.batch.posts[0].seq).toBe(42)
    const old = await plan(emptyState(), base, ctx({ importing: false, now: now + 2 * 3_600_000 }))
    expect(old.batch.posts[0].seq).toBe(0)
  })

  it('treats an item as unchanged only when content, comment count and activity all match', () => {
    const row = { source_activity_ms: base.lastActivityAt, source_comments_count: 2, source_hash: contentHashOf(base.title + '\u0000' + base.content, base.contentHash) } as never
    expect(unchanged(undefined, base)).toBe(false)
    expect(unchanged(row, base)).toBe(true)
    expect(unchanged(row, { ...base, commentsCount: 3 })).toBe(false)
    expect(unchanged(row, { ...base, lastActivityAt: base.lastActivityAt + 1 })).toBe(false)
    expect(unchanged(row, { ...base, content: 'x' })).toBe(false)
  })
})

describe('the stateless rotation', () => {
  const ids = Array.from({ length: 2076 }, (_, i) => (i % 3 ? `s${i}` : `opengov:${i}`))
  const slots = slotsPerWindow(10, 24)

  it('covers every item exactly once per window, about evenly, from the clock alone', () => {
    expect(slots).toBe(144)
    const seen = new Map<string, number>()
    const sizes: number[] = []
    for (let tick = 1000; tick < 1000 + slots; tick++) {
      const due = rotationDue(ids, tick, null, slots) // as if every cycle followed a restart
      sizes.push(due.length)
      for (const id of due) seen.set(id, (seen.get(id) ?? 0) + 1)
    }
    expect(seen.size).toBe(ids.length)
    expect([...seen.values()].every(n => n === 1)).toBe(true)
    expect(Math.max(...sizes)).toBeLessThan(40)
  })

  it('a bucket is a pure function of the id; the slot of the wall clock', () => {
    expect(sweepBucket('opengov:450', slots)).toBe(sweepBucket('opengov:450', slots))
    expect(sweepSlot(Date.parse('2026-11-08T10:09:59Z'), 10)).toBe(sweepSlot(Date.parse('2026-11-08T10:00:00Z'), 10))
    expect(sweepSlot(Date.parse('2026-11-08T10:10:00Z'), 10)).toBe(sweepSlot(Date.parse('2026-11-08T10:00:00Z'), 10) + 1)
  })

  it('a cycle that overran its slot catches up the slots it skipped; a restart or a long gap takes only the current one', () => {
    const one = (t: number) => new Set(rotationDue(ids, t, null, slots))
    const caught = new Set(rotationDue(ids, 503, 500, slots))
    expect(caught).toEqual(new Set([...one(501), ...one(502), ...one(503)]))
    expect(new Set(rotationDue(ids, 503 + MAX_SLOT_CATCHUP + 10, 503, slots))).toEqual(one(503 + MAX_SLOT_CATCHUP + 10))
    expect(new Set(rotationDue(ids, 503, 503, slots))).toEqual(one(503))
  })
})

describe('images in bodies', () => {
  it('finds markdown and html image URLs and IPFS CIDs', () => {
    const body = '![a](https://i.ibb.co/x/y.png "t") text <img alt="b" src="https://s3.bmp.ovh/imgs/z.jpg?a=1&amp;b=2"> ![c](javascript:alert(1)) ![d](http://h.example/p.gif)'
    expect(imageUrlsIn(body)).toEqual(['https://i.ibb.co/x/y.png', 'http://h.example/p.gif', 'https://s3.bmp.ovh/imgs/z.jpg?a=1&b=2'])
    expect(ipfsCidOf('https://subsquare.infura-ipfs.io/ipfs/QmapSmYyvphm9sxt5BnmrkPM1QHcQPhujkYBAgT6bUhjCE')).toBe('QmapSmYyvphm9sxt5BnmrkPM1QHcQPhujkYBAgT6bUhjCE')
    expect(ipfsCidOf('https://evil.example/ipfs/notacid')).toBeNull()
  })

  it('retries a failed URL at most daily, and gives up after five attempts', () => {
    const now = 10 * 86_400_000
    expect(urlDue(undefined, now)).toBe(true)
    expect(urlDue({ original_url: 'u', cid: 'c', status: 'ok', reason: '', attempts: 1, updated_ms: 0 }, now)).toBe(false)
    expect(urlDue({ original_url: 'u', cid: '', status: 'failed', reason: 'x', attempts: 1, updated_ms: now - 3_600_000 }, now)).toBe(false)
    expect(urlDue({ original_url: 'u', cid: '', status: 'failed', reason: 'x', attempts: 1, updated_ms: now - 86_400_000 }, now)).toBe(true)
    expect(urlDue({ original_url: 'u', cid: '', status: 'failed', reason: 'x', attempts: 5, updated_ms: 0 }, now)).toBe(false)
  })
})
