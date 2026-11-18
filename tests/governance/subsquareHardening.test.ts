import { describe, expect, it } from 'vitest'
import { MAX_RESPONSE_BYTES, SubsquareClient, readCapped, toWellFormed, wellFormed } from '../../src/governance/subsquare/client.js'
import { keepsVisibility, planWrites, type SourceView } from '../../src/governance/subsquare/diff.js'
import { rewriteSubsquareLinks } from '../../src/governance/subsquare/links.js'
import { planNormalisation, type NormaliseMemo } from '../../src/governance/subsquare/normalise.js'
import { POLL_MAX_OPTIONS, POLL_MAX_VOTERS, parseItem, parsePollVotes } from '../../src/governance/subsquare/parse.js'
import { IMPORT_LIMITS, buildGroups, capText, importedCommentText, importedPostText, type PostRow } from '../../src/governance/subsquare/rows.js'
import { emptyBatch, type ForumState, type StoredPost } from '../../src/governance/subsquare/store.js'
import { pollJsonOf } from '../../src/governance/subsquare/sync.js'

// Hostile-input bounds on the Subsquare sync: response size, malformed UTF-16, text
// length, the rewrite's cost, poll shapes; and a native edit's visibility.

const PK = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
const author = { username: 'alice', publicKey: PK }

describe('responses', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms } } }

  it('a body past the cap is cancelled, not read whole, and the request fails', async () => {
    let pulled = 0
    const huge = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1 << 20; c.enqueue(new Uint8Array(1 << 20)); if (pulled > 64 << 20) c.close() } })
    expect(await readCapped(new Response(huge), 4 << 20)).toBeNull()
    expect(pulled).toBeLessThan(8 << 20)
    const c = clock()
    const client = new SubsquareClient({ baseUrl: 'https://x', rps: 5, maxRetries: 0, breakerThreshold: 99, now: c.now, sleep: c.sleep,
      fetchImpl: (async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), { status: 200 })) as typeof fetch })
    await expect(client.get('/big')).rejects.toThrow(/status -2/)
  })

  it('every string is made well-formed, keys included (a lone surrogate would fail the whole ClickHouse batch)', async () => {
    expect(toWellFormed('a\uD800b\uDC00c😀')).toBe('a�b�c😀')
    expect(wellFormed({ ['k\uD800']: ['x\uDBFF'], n: 1 })).toEqual({ 'k�': ['x�'], n: 1 })
    const c = clock()
    const client = new SubsquareClient({ baseUrl: 'https://x', rps: 5, now: c.now, sleep: c.sleep,
      fetchImpl: (async () => new Response('{"title":"a\\ud800b"}', { status: 200 })) as typeof fetch })
    expect((await client.get('/p')).body).toEqual({ title: 'a�b' })
  })
})

describe('text bounds', () => {
  it('cuts with a marker, never splitting a surrogate pair, and is a fixed point', () => {
    expect(capText('abcdef', 4, '…')).toBe('abc…')
    expect(capText('ab😀cd', 4, '…')).toBe('ab…')
    const long = 'x'.repeat(IMPORT_LIMITS.postBodyChars + 10)
    const once = importedPostText('t', long, 'markdown')
    expect(once.body.length).toBe(IMPORT_LIMITS.postBodyChars)
    expect(once.body.endsWith('[…]')).toBe(true)
    expect(importedPostText(once.title, once.body, 'markdown')).toEqual(once)
    const c = importedCommentText('y'.repeat(IMPORT_LIMITS.commentBodyChars * 2), 'html')
    expect(c.endsWith('<p>[…]</p>')).toBe(true)
    expect(importedCommentText(c, 'html')).toBe(c)
  })

  it('an over-long title is cut; with no body the full text becomes the body, so nothing is lost', () => {
    const reason = 'Period of the contribution: 2022 / 04 - 2022 / 07. '.repeat(10)
    const t = importedPostText(reason, '', 'markdown')
    expect(t.title.length).toBe(IMPORT_LIMITS.titleChars)
    expect(t.title.endsWith('…')).toBe(true)
    expect(t.body).toBe(reason)
    expect(importedPostText(t.title, t.body, 'markdown')).toEqual(t)
    expect(importedPostText(reason, 'own body', 'markdown').body).toBe('own body')
  })
})

describe('the rewrite\'s cost is linear', () => {
  const n = 60_000
  const trigger = ' href subsquare.io'
  it.each([
    ['unclosed anchors', '<a href=x>'.repeat(n / 10)],
    ['anchors with no >', '<a '.repeat(n / 3)],
    ['a backtick run', '`'.repeat(n) + 'x'],
    ['a tilde run', '~'.repeat(n) + 'x'],
    ['open brackets', '[a'.repeat(n / 2)],
    ['a fence with a long info line', '```' + 'a'.repeat(n)],
    ['many URLs', 'https://hydration.subsquare.io/posts/1 '.repeat(n / 40)],
  ])('%s, 60 KB, well under 250 ms in either format', (_name, text) => {
    for (const format of ['markdown', 'html']) {
      const t = performance.now()
      rewriteSubsquareLinks(text + trigger, format)
      expect(performance.now() - t).toBeLessThan(250)
    }
  })

  it('an anchor with no closing tag keeps its text, its href still mapped', () => {
    expect(rewriteSubsquareLinks('<a href="https://hydradx.subsquare.io/posts/1">open', 'html')).toBe('<a href="/discussions/s1">open')
    expect(rewriteSubsquareLinks('<a href="https://polkadot.subsquare.io/posts/1">open', 'html')).toBe('<a >open')
  })
})

describe('the normalisation memo', () => {
  it('a row found converged is not examined again until it is written', async () => {
    const row = { post_id: 's1', source_id: 'x', authority: 'subsquare', deleted: 0, hidden_reason: '', title: 't', body: 'b', body_format: 'markdown', revision: 0, edited_at: '1970-01-01T00:00:00.000Z', updated_ms: 1 }
    const state = { posts: new Map([['s1', row]]), comments: new Map() } as unknown as ForumState
    const memo: NormaliseMemo = new Map()
    let examined = 0
    const loader = { posts: async () => [], comments: async () => [], revisions: async () => [] }
    const counting = new Proxy(state.posts, { get: (t, k) => (k === 'values' ? () => { examined++; return t.values() } : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) })
    await planNormalisation(emptyBatch(), { ...state, posts: counting } as ForumState, {}, loader, 0, memo)
    expect(memo.get('p:s1')).toBe('1')
    // A body the rules would change, under the same stored version: skipped (memoised); under a newer one: examined.
    const changed = { ...row, body: 'see https://hydration.subsquare.io/posts/2' }
    const asked: string[][] = []
    const spy = { ...loader, posts: async (ids: string[]) => { asked.push(ids); return [] } }
    await planNormalisation(emptyBatch(), { ...state, posts: new Map([['s1', changed]]) } as unknown as ForumState, {}, spy, 0, memo)
    expect(asked).toEqual([[]])
    await planNormalisation(emptyBatch(), { ...state, posts: new Map([['s1', { ...changed, updated_ms: 2 }]]) } as unknown as ForumState, {}, spy, 0, memo)
    expect(asked[1]).toEqual(['s1'])
    expect(examined).toBe(1)
  })
})

describe('polls', () => {
  it('an option named __proto__ keeps its count', () => {
    const v = parsePollVotes(JSON.parse('{"__proto__": 3, "constructor": 2}'))!
    expect(Object.keys(v.counts)).toEqual(['__proto__', 'constructor'])
    expect(v.counts['__proto__']).toBe(3)
    const poll = parseItem('discussions', { _id: 'a'.repeat(24), postUid: '1', title: 't', content: '', createdAt: '2023-01-01T00:00:00Z', author, poll: { _id: 'b'.repeat(24), title: 'q', options: ['__proto__'], expiresTime: 1, anonymous: true } })!.poll!
    expect(JSON.parse(pollJsonOf(poll, v)).votes).toEqual(JSON.parse('{"__proto__": 3, "constructor": 2}'))
  })

  it('bounds options and the voters kept, counting every voter', () => {
    expect(parsePollVotes(Object.fromEntries(Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => [`o${i}`, 1])))).toBeNull()
    const voters = Array.from({ length: POLL_MAX_VOTERS + 5 }, () => ({ username: 'u', publicKey: PK }))
    const v = parsePollVotes({ Yes: voters })!
    expect(v.counts.Yes).toBe(POLL_MAX_VOTERS + 5)
    expect(v.voters!.Yes).toHaveLength(POLL_MAX_VOTERS)
    const many = Array.from({ length: POLL_MAX_OPTIONS + 1 }, (_, i) => `o${i}`)
    expect(parseItem('discussions', { _id: 'a'.repeat(24), postUid: '1', title: 't', createdAt: '2023-01-01T00:00:00Z', author, poll: { _id: 'b'.repeat(24), title: 'q', options: many, anonymous: true } })).toBeNull()
  })
})

describe('a native edit keeps its visibility', () => {
  const item = (fields: Record<string, unknown> = {}) => parseItem('opengov', {
    _id: 'c'.repeat(24), referendumIndex: 7, title: 'src', content: 'src', contentHash: 'a'.repeat(32), createdAt: '2025-01-01T00:00:00Z', author, reactions: [], ...fields,
  })!
  const view = (items: ReturnType<typeof item>[], over: Partial<SourceView> = {}): SourceView => ({
    items: new Map(items.map(i => [i.subject, i])), gone: new Set(), groups: buildGroups(items, new Map()),
    discussionById: new Map(), links: new Map(), threads: new Map(), appendants: new Map(), pollJson: new Map(), ...over,
  })
  const ctx = { now: Date.parse('2025-03-01T00:00:00Z'), importing: false, firstSeen: () => false, nextSeq: () => 1 }
  const stored = (over: Partial<StoredPost>) => ({ post_id: 'opengov:7', kind: 'opengov', authority: 'native', body_format: 'markdown', revision: 1, source_hash: 'old', source_comments_count: 0, source_activity_ms: 0, hidden: 0, hidden_reason: '', source_removed: 0, row_fp: 'old', seq: 0, title: 'mine', body: 'mine', source_id: 'c'.repeat(24), linked: [], poll_json: '', updated_ms: 1, author_account_id: '', author_legacy_name: '', created_ms: 0, tldr: '', labels: [], edited_at: '2025-02-01T00:00:00.000Z', deleted: 0, moderated: 0, locked: 0, banner_cid: '', ...over }) as StoredPost
  const state = (p: StoredPost): ForumState => ({ posts: new Map([[p.post_id, p]]), comments: new Map(), mediaUrls: new Map(), mediaCids: new Set(), removedCids: new Set() })

  it('is decided here for a moderated item and for a natively edited one', () => {
    expect(keepsVisibility({ moderated: 1, authority: 'subsquare' })).toBe(true)
    expect(keepsVisibility({ moderated: 0, authority: 'native' })).toBe(true)
    expect(keepsVisibility({ moderated: 0, authority: 'subsquare' })).toBe(false)
  })

  it('Subsquare hiding its own copy hides nothing here and logs nothing', async () => {
    const r = await planWrites(view([item({ isMalicious: true })]), state(stored({})), ctx, { posts: async () => [], comments: async () => [] }, {})
    expect(r.batch.posts[0]).toMatchObject({ authority: 'native', hidden: 0, hidden_reason: '' })
    expect(r.batch.modlog).toEqual([])
  })

  it('Subsquare removing it records the fact but does not hide it', async () => {
    const full = { ...stored({}), source_removed: 0, moderated: 0, locked: 0 } as unknown as PostRow
    const r = await planWrites(view([], { gone: new Set(['opengov:7']) }), state(stored({})), ctx, { posts: async () => [{ ...full }], comments: async () => [] }, {})
    expect(r.batch.posts[0]).toMatchObject({ source_removed: 1, hidden: 0 })
    expect(r.batch.modlog).toEqual([])
  })
})
