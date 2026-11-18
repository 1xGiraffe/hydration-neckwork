import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORUM_CURSOR_KEY, FORUM_FLOOR_KEY, FORUM_MAX_WINDOW_SEQ, FORUM_OVERLAP_SEQ, evaluateForum, forumItemPath, forumReadFrom,
  renderForumMatch, resetForumLaneForTests, runForumLane, type ForumContext, type ForumItem,
} from '../src/notifications/forumLane.ts'
import { initEvaluator, notificationIdFor, resetEvaluatorForTests, runEvaluatorTick, stopNotificationEvaluator } from '../src/notifications/evaluator.ts'
import { createRule, getNotificationState, initNotifications, loadNotifications, type NotificationRule } from '../src/notifications/notificationStore.ts'
import { resetDeliveryStateForTests } from '../src/notifications/delivery.ts'
import { KIND_LABELS, NOTIFICATION_KINDS, describeRule, parseRuleParams, type NotificationKind } from '../src/notifications/notificationRules.ts'
import { renderNotification, text } from '../src/notifications/render.ts'
import { initExplorerService } from '../src/services/explorerService.ts'
import { setForumSnapshotForTest } from '../src/services/forumStore.ts'
import { fakeClient, insertedRows, type FakeClient } from './helpers/userFakes.ts'

// The forum lane's invariants: who is told about a new post or comment (and who
// never is), the one-alert-per-item rule, and the seq cursor — forward-only from
// its seeded floor, re-reading a trailing overlap for the sync's late writes.

initExplorerService(fakeClient())

const ALICE = '0x' + 'a1'.repeat(32)
const BOB = '0x' + 'b2'.repeat(32)
const CAROL = '0x' + 'c3'.repeat(32)
// A mention is written as an SS58 or an H160; the tests mention by H160, whose
// truncated (ETH\0) account the stub resolver maps onto the test account — the
// same step resolveDisplayAccountId takes for a bound EVM signer.
const H160 = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const ETH = (n: number) => '0x45544800' + n.toString(16).padStart(40, '0') + '0000000000000000'
const ALIAS = new Map([[ETH(1), ALICE], [ETH(2), BOB], [ETH(3), CAROL]])
const resolve = (id: string) => ALIAS.get(id) ?? id

let n = 0
const rule = (accountId: string, kind: NotificationKind, params: unknown = {}): NotificationRule =>
  ({ ruleId: `r${++n}`, accountId, kind, name: '', params, channels: [], muted: false, cooldownS: 0 })

const comment = (over: Partial<ForumItem> = {}): ForumItem => ({
  id: `c${++n}`, type: 'comment', kind: 'comment', threadKey: '42', parentId: '', replyToId: '',
  authorAccountId: BOB, authorLegacyName: '', title: '', body: 'hello', hidden: false, deleted: false, seq: 2_000, source: '', ...over,
})

function ctx(over: Partial<ForumContext> = {}, authors: Record<string, string> = {}, posts: Record<string, string> = {}): ForumContext {
  return {
    authorOf: id => authors[id] ?? null,
    post: key => (posts[key] ? { authorAccountId: posts[key], title: `Thread ${key}`, visible: true } : null),
    resolve, floor: 1_000, blockHeight: 7, ...over,
  }
}

describe('forum kinds in the registry', () => {
  it('registers three kinds with their parameter shapes', () => {
    for (const k of ['forum-reply', 'forum-mention', 'forum-thread'] as const) {
      expect(NOTIFICATION_KINDS).toContain(k)
      expect(KIND_LABELS[k]).toBeTruthy()
    }
    expect(parseRuleParams('forum-reply', {}).ok).toBe(true)
    expect(parseRuleParams('forum-reply', { threadKey: '1' }).ok).toBe(false)
    expect(parseRuleParams('forum-mention', {}).ok).toBe(true)
    expect(parseRuleParams('forum-thread', { threadKey: 'opengov:450' }).ok).toBe(true)
    expect(parseRuleParams('forum-thread', { threadKey: 'external:0xab@6429878' }).ok).toBe(true)
    expect(parseRuleParams('forum-thread', {}).ok).toBe(false)
    expect(parseRuleParams('forum-thread', { threadKey: '<script>' }).ok).toBe(false)
    expect(parseRuleParams('forum-thread', { threadKey: 'x'.repeat(161) }).ok).toBe(false)
  })

  it('describes a followed thread by its title, else by its key', () => {
    expect(describeRule('forum-thread', { threadKey: 'opengov:450' })).toBe('new comments on referendum #450')
    expect(describeRule('forum-thread', { threadKey: '42' }, undefined, undefined, undefined, () => 'Fund the docs')).toBe('new comments on "Fund the docs"')
    expect(describeRule('forum-reply', {})).toMatch(/replies/)
  })
})

describe('evaluateForum', () => {
  it('tells the author of the comment a reply answers, by reply_to then parent', () => {
    const a = rule(ALICE, 'forum-reply'), c = rule(CAROL, 'forum-reply')
    const viaReplyTo = comment({ parentId: 'p', replyToId: 'q' })
    const viaParent = comment({ parentId: 'p' })
    const out = evaluateForum([viaReplyTo, viaParent], [a, c], ctx({}, { p: CAROL, q: ALICE }))
    expect(out.map(m => [m.ruleId, m.payload.itemId, m.payload.reason])).toEqual([
      [a.ruleId, viaReplyTo.id, 'reply'],
      [c.ruleId, viaParent.id, 'reply'],
    ])
    expect(out[0].identity).toBe(`forum:${viaReplyTo.id}`)
    expect(out[0].payload.path).toBe(`/discussions/42#c-${viaReplyTo.id}`)
  })

  it('treats a top-level comment as a reply to the post it is filed under', () => {
    const a = rule(ALICE, 'forum-reply')
    const out = evaluateForum([comment({ threadKey: 'opengov:450' })], [a], ctx({}, {}, { 'opengov:450': ALICE }))
    expect(out).toHaveLength(1)
    expect(out[0].payload.path).toMatch(/^\/referendum\/opengov\/450#c-/)
  })

  it('never tells an author about their own item', () => {
    const rules = [rule(ALICE, 'forum-reply'), rule(ALICE, 'forum-mention'), rule(ALICE, 'forum-thread', { threadKey: '42' })]
    const own = comment({ authorAccountId: ALICE, parentId: 'p', body: `note to self @${H160(1)}` })
    expect(evaluateForum([own], rules, ctx({}, { p: ALICE }))).toEqual([])
    // An author written in another form of the same account is still the author.
    const ownEvm = comment({ authorAccountId: ETH(1), parentId: 'p' })
    expect(evaluateForum([ownEvm], rules, ctx({}, { p: ALICE }))).toEqual([])
  })

  it('never fires for a hidden or deleted item, for seq 0, or at or below the floor', () => {
    const rules = [rule(ALICE, 'forum-thread', { threadKey: '42' })]
    const items = [comment({ hidden: true }), comment({ deleted: true }), comment({ seq: 0 }), comment({ seq: 1_000 }), comment({ seq: 999 })]
    expect(evaluateForum(items, rules, ctx())).toEqual([])
  })

  it('sends one alert per recipient and item: reply over mention over thread', () => {
    const rules = [rule(ALICE, 'forum-thread', { threadKey: '42' }), rule(ALICE, 'forum-mention'), rule(ALICE, 'forum-reply')]
    const both = comment({ replyToId: 'q', parentId: 'q', body: `@${H160(1)} what do you think?` })
    const out = evaluateForum([both], rules, ctx({}, { q: ALICE }))
    expect(out.map(m => m.payload.reason)).toEqual(['reply'])
    const mentionOnly = comment({ body: `cc @${H160(1)}` })
    expect(evaluateForum([mentionOnly], rules, ctx()).map(m => m.payload.reason)).toEqual(['mention'])
    expect(evaluateForum([comment()], rules, ctx()).map(m => m.payload.reason)).toEqual(['thread'])
  })

  it('never pages a mention from imported text (it passed none of the posting gates)', () => {
    const rules = [rule(ALICE, 'forum-mention'), rule(ALICE, 'forum-thread', { threadKey: '42' })]
    const imported = comment({ body: `cc @${H160(1)}`, source: 'subsquare' })
    expect(evaluateForum([imported], rules, ctx()).map(m => m.payload.reason)).toEqual(['thread'])
    expect(evaluateForum([{ ...imported, source: '' }], rules, ctx()).map(m => m.payload.reason)).toEqual(['mention'])
  })

  it('caps mentions per item, so one comment cannot page an unbounded list', () => {
    const many = Array.from({ length: 11 }, (_, i) => `@${H160(100 + i)}`).join(' ')
    const eleventh = ETH(110)
    const rules = [rule(ETH(100), 'forum-mention'), rule(eleventh, 'forum-mention')]
    const out = evaluateForum([comment({ body: many })], rules, ctx())
    expect(out.map(m => m.accountId)).toEqual([ETH(100)])
  })

  it('tells mentioned accounts about a new post too, and follows only the named thread', () => {
    const post: ForumItem = { ...comment(), id: '77', type: 'post', kind: 'discussion', threadKey: '77', title: 'A proposal', body: `@${H160(3)}` }
    const out = evaluateForum([post, comment({ threadKey: '43' })], [rule(CAROL, 'forum-mention'), rule(CAROL, 'forum-thread', { threadKey: '42' })], ctx())
    expect(out.map(m => [m.payload.itemId, m.payload.reason, m.payload.path])).toEqual([['77', 'mention', '/discussions/77']])
  })

  it('evaluates an item once even when a re-read returns it twice', () => {
    const c1 = comment()
    expect(evaluateForum([c1, { ...c1 }], [rule(ALICE, 'forum-thread', { threadKey: '42' })], ctx())).toHaveLength(1)
  })

  it('renders through the shared renderer with the excerpt quoted as text', () => {
    const [m] = evaluateForum([comment({ replyToId: 'q', body: '**bold** <img src=x onerror=alert(1)>' })], [rule(ALICE, 'forum-reply')], ctx({}, { q: ALICE }, { '42': CAROL }))
    const out = renderNotification(renderForumMatch(m.payload, () => text('Bob')))
    expect(out.title).toBe('Bob replied to you on “Thread 42”')
    expect(out.path).toBe(m.payload.path)
    expect(out.telegramHtml).not.toContain('<img')
  })
})

describe('forumItemPath', () => {
  it('links every thread kind to the page that shows it', () => {
    expect(forumItemPath('s248', 'c1')).toBe('/discussions/s248#c-c1')
    expect(forumItemPath('democracy:12', null)).toBe('/referendum/democracy/12')
    expect(forumItemPath('council:7', 'sabc')).toBe('/governance/motion/council/7#c-sabc')
    expect(forumItemPath('external:0xab@6429878', null)).toBe('/governance/democracy/external/0xab@6429878')
    expect(forumItemPath('spend:3', null)).toBe('/governance/treasury/spend/3')
  })
})

describe('forumReadFrom', () => {
  const now = 10 * FORUM_MAX_WINDOW_SEQ
  it('re-reads the overlap below the cursor but never below the floor', () => {
    expect(forumReadFrom(now - 100, now - 50, now, false)).toBe(now - 50)
    expect(forumReadFrom(now - 100, 0, now, false)).toBe(now - 100 - FORUM_OVERLAP_SEQ)
  })
  it('clamps a long gap instead of replaying it', () => {
    expect(forumReadFrom(1, 1, now, false)).toBe(now - FORUM_MAX_WINDOW_SEQ)
  })
  it('resumes a saturated page from its last seq without the overlap', () => {
    expect(forumReadFrom(now - 100, 0, now, true)).toBe(now - 101)
  })
})

/* ---- the lane over a fake source ---- */

interface Row { [k: string]: unknown; seq: number }

function forumClient(base: FakeClient, src: { posts: Row[]; comments: Row[] }): FakeClient {
  const wrapped = Object.create(base) as FakeClient
  wrapped.query = (async (args: { query: string; query_params?: Record<string, unknown> }) => {
    const q = args.query
    const from = Number(args.query_params?.from ?? 0)
    const rows = (list: Row[]) => list.filter(r => r.seq > from).sort((a, b) => a.seq - b.seq)
    if (q.includes('greatest(')) return { json: async () => [{ s: Math.max(0, ...[...src.posts, ...src.comments].map(r => r.seq)) }] }
    if (q.includes('forum_posts FINAL WHERE seq')) return { json: async () => rows(src.posts) }
    if (q.includes('forum_comments FINAL WHERE seq')) return { json: async () => rows(src.comments) }
    if (q.includes('forum_comments FINAL') && q.includes('comment_id IN')) return { json: async () => [] }
    return base.query(args as never)
  }) as FakeClient['query']
  return wrapped
}

const NOW_MS = 1_800_000_000_000
const SEQ = (ms: number) => ms * 1000
const commentRow = (id: string, seq: number, over: Record<string, unknown> = {}): Row => ({
  id, type: 'comment', kind: 'comment', thread_key: '42', parent_id: '', reply_to_id: '',
  author_account_id: BOB, author_legacy_name: '', title: '', body: 'hi', hidden: 0, deleted: 0, seq, ...over,
})

describe('runForumLane', () => {
  let base: FakeClient
  beforeEach(async () => {
    resetForumLaneForTests()
    base = fakeClient()
    initNotifications(base)
    await loadNotifications()
    setForumSnapshotForTest({})
  })
  afterEach(() => setForumSnapshotForTest(null))

  it('seeds at the newest seq on its first run and fires nothing, then fires only above it', async () => {
    const src = { posts: [] as Row[], comments: [commentRow('old', SEQ(NOW_MS - 60_000))] }
    const client = forumClient(base, src)
    const rules = [rule(ALICE, 'forum-thread', { threadKey: '42' })]
    expect(await runForumLane(client, rules, 5, NOW_MS)).toBeNull()
    expect(getNotificationState(FORUM_CURSOR_KEY)).toBe(String(SEQ(NOW_MS - 60_000)))
    expect(getNotificationState(FORUM_FLOOR_KEY)).toBe(String(SEQ(NOW_MS - 60_000)))
    src.comments.push(commentRow('new', SEQ(NOW_MS + 1_000)))
    const out = await runForumLane(client, rules, 6, NOW_MS + 2_000)
    expect(out?.matches.map(m => m.payload.itemId)).toEqual(['new'])
    expect(out?.matches[0].blockHeight).toBe(6)
  })

  it('picks up a row written late below the cursor (the sync stamps seq when it plans)', async () => {
    const src = { posts: [] as Row[], comments: [commentRow('a', SEQ(NOW_MS))] }
    const client = forumClient(base, src)
    const rules = [rule(ALICE, 'forum-thread', { threadKey: '42' })]
    await runForumLane(client, rules, 1, NOW_MS)                        // seeds at a
    src.comments.push(commentRow('b', SEQ(NOW_MS + 10_000)))
    const first = await runForumLane(client, rules, 2, NOW_MS + 11_000)
    first?.commit()                                                     // cursor at b
    // Planned before b, written after it: below the cursor, inside the overlap.
    src.comments.push(commentRow('late', SEQ(NOW_MS + 5_000)))
    const second = await runForumLane(client, rules, 3, NOW_MS + 12_000)
    expect(second?.matches.map(m => m.payload.itemId).sort()).toEqual(['b', 'late'])
    // b again carries the same identity, so the inbox collapses it.
    expect(second?.matches.find(m => m.payload.itemId === 'b')?.identity).toBe(first?.matches[0].identity)
  })

  it('follows the clock while no forum rule is active', async () => {
    const src = { posts: [] as Row[], comments: [commentRow('x', SEQ(NOW_MS - 1_000))] }
    const client = forumClient(base, src)
    expect(await runForumLane(client, [], 1, NOW_MS)).toBeNull()
    // The rule arrives later; the item written before it stays history.
    const out = await runForumLane(client, [rule(ALICE, 'forum-thread', { threadKey: '42' })], 2, NOW_MS + 6_000)
    expect(out?.matches).toEqual([])
  })
})

describe('the forum lane inside the evaluator', () => {
  let client: FakeClient
  const src = { posts: [] as Row[], comments: [] as Row[] }
  beforeEach(async () => {
    resetEvaluatorForTests()
    resetDeliveryStateForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
    src.posts = []; src.comments = []
    const base = fakeClient({ raw_ingestion_state: [{ head: 1_000 }] })
    client = forumClient(base, src)
    initNotifications(client)
    await loadNotifications()
    initEvaluator(client)
    setForumSnapshotForTest({})
  })
  afterEach(() => {
    void stopNotificationEvaluator()
    vi.useRealTimers()
    setForumSnapshotForTest(null)
  })

  it('delivers a reply once to the inbox, however often its seq range is re-read', async () => {
    const r = await createRule(ALICE, { kind: 'forum-reply', params: {} })
    await runEvaluatorTick()                                           // seeds
    src.comments.push(commentRow('cX', SEQ(NOW_MS) + 5, { reply_to_id: 'q', parent_id: 'q' }))
    src.comments.push(commentRow('q', SEQ(NOW_MS) - 5, { author_account_id: ALICE }))
    await runEvaluatorTick()
    await runEvaluatorTick()
    const inbox = insertedRows(client, 'user_notification_inbox')
    expect(inbox.map(row => row.notification_id)).toEqual([notificationIdFor(r.ruleId, 'forum:cX')])
    expect(inbox[0].kind).toBe('forum-reply')
    expect(String(inbox[0].url)).toBe('/discussions/42#c-cX')
    expect(Number(getNotificationState(FORUM_CURSOR_KEY))).toBe(SEQ(NOW_MS) + 5)
  })
})
