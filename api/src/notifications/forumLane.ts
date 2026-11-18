import type { ClickHouseClient } from '../db/client.ts'
import { accountRef, resolveDisplayAccountId, type AccountRef } from '../services/explorerService.ts'
import { forumComment, forumPost, plainText } from '../services/forumStore.ts'
import { LIMITS, mentionsIn } from '../services/forumText.ts'
import { threadKeyLabel, type NotificationKind, type RuleParams } from './notificationRules.ts'
import { getNotificationState, setNotificationStates, type NotificationRule } from './notificationStore.ts'
import { text as textPart, type RenderInput, type RenderPart } from './render.ts'

// The forum lane: `forum-reply`, `forum-mention` and `forum-thread` alerts over the
// forum tables (021_forum.sql).
//
// Its source is not the chain, so it is the second sanctioned exception to anchoring
// a lane on the live pipeline head (the first is the current-value alerts). It keeps
// its OWN forward cursor, `cursor:forum`, over the forum `seq`: a counter the api
// assigns to a NEW native post or comment at write time (Date.now() µs-scaled plus a
// per-process counter) and the Subsquare sync assigns only to an item it sees first
// within an hour of its creation. Imported history, replays and every older item
// carry seq 0 and never fire; an edit keeps the row's original seq, so an edit is
// never news. Finality is irrelevant here — nothing on chain is involved.
//
// Forward-only, like every lane: a lane with no cursor seeds at the newest seq the
// tables hold and evaluates nothing, and nothing at or below the seeded FLOOR can
// ever fire. While no forum rule is active the cursor and floor follow the clock,
// so the first rule created later sees only what is written after it.
//
// The sync stamps seq when it PLANS a cycle and writes the rows later (its image
// pass runs in between), so a row can land below the cursor by up to a cycle.
// Every tick therefore re-reads FORUM_OVERLAP_SEQ of seq space below the cursor and
// leans on the deterministic identity `forum:<item id>` per rule — the inbox key
// and the recent-id set collapse a re-read match. A long outage is clamped to
// FORUM_MAX_WINDOW_SEQ rather than replayed whole (the inbox is not a backlog).

/** One seq unit is a microsecond of the writer's clock. */
const SEQ_PER_MS = 1000
export const FORUM_OVERLAP_SEQ = 30 * 60_000 * SEQ_PER_MS
export const FORUM_MAX_WINDOW_SEQ = 2 * 3600_000 * SEQ_PER_MS
/** Rows read per table per tick; a saturated page is resumed from its last seq without the overlap. */
export const FORUM_PAGE = 1000
export const FORUM_CURSOR_KEY = 'cursor:forum'
export const FORUM_FLOOR_KEY = 'cursor:forum:floor'
const IDLE_PERSIST_MS = 5 * 60_000
const EXCERPT_CHARS = 160
const TITLE_CHARS = 90

export const FORUM_KINDS = ['forum-reply', 'forum-mention', 'forum-thread'] as const satisfies readonly NotificationKind[]
export type ForumKind = typeof FORUM_KINDS[number]

/** A new forum row the lane reads: a post or a comment (an Update under a description is a comment of kind 'update'). */
export interface ForumItem {
  id: string
  type: 'post' | 'comment'
  /** The post's kind ('discussion', 'opengov', …) or the comment's ('comment' | 'update'). */
  kind: string
  /** A comment's thread; a post's own id. */
  threadKey: string
  parentId: string
  replyToId: string
  authorAccountId: string
  authorLegacyName: string
  title: string
  body: string
  hidden: boolean
  deleted: boolean
  seq: number
  /** 'subsquare' for an imported item, '' for one written here. */
  source: string
}

export type ForumReason = 'reply' | 'mention' | 'thread'

export interface ForumMatchPayload {
  lane: 'forum'
  reason: ForumReason
  itemId: string
  itemType: 'post' | 'comment'
  threadKey: string
  threadTitle: string
  /** The author's canonical account id, '' for an address-less legacy author. */
  authorAccountId: string
  authorLegacyName: string
  /** Plain text, quoted as data. */
  excerpt: string
  path: string
}

export interface ForumMatch {
  ruleId: string
  accountId: string
  kind: ForumKind
  identity: string
  blockHeight: number
  payload: ForumMatchPayload
}

/** What the matcher needs to know beyond the rows themselves. */
export interface ForumContext {
  /** The canonical author of a comment or post id (a reply's target), or null when unknown. */
  authorOf: (id: string) => string | null
  /** A thread's root post, when the store holds it. */
  post: (threadKey: string) => { authorAccountId: string; title: string; visible: boolean } | null
  /** Canonical account form both sides of a comparison are put in (a bound EVM signer → its account). */
  resolve: (accountId: string) => string
  /** Nothing at or below this seq may fire (the seeded floor). */
  floor: number
  /** Stamped on every match: the live head when the lane ran (it keeps outbound tags per tick). */
  blockHeight: number
}

// Archive subjects' pages, by post-id prefix — the explorer's SUBJECT_ROUTES
// (explorer-ui/src/governanceSubjects.ts, api/src/routes/seo.ts).
const SUBJECT_ROUTE: Record<string, string> = {
  council: 'motion/council', tc: 'motion/tc', tip: 'tip', treasury: 'treasury/proposal',
  spend: 'treasury/spend', democracy_proposal: 'democracy/proposal', external: 'democracy/external',
}

/** The explorer page a forum thread lives on, with the comment's permalink anchor. */
export function forumItemPath(threadKey: string, commentId: string | null): string {
  const anchor = commentId ? `#c-${commentId}` : ''
  if (/^[A-Za-z0-9]{1,40}$/.test(threadKey)) return `/discussions/${threadKey}${anchor}`
  const m = /^([a-z_]+):(.+)$/.exec(threadKey)
  if (m && (m[1] === 'opengov' || m[1] === 'democracy') && /^\d+$/.test(m[2])) return `/referendum/${m[1]}/${m[2]}${anchor}`
  if (m && SUBJECT_ROUTE[m[1]]) return `/governance/${SUBJECT_ROUTE[m[1]]}/${m[2]}${anchor}`
  return '/discussions'
}

/** Plain text on one line — every run of whitespace, newlines included, is one space — clipped to `n` characters. */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}

/**
 * The matches a batch of new forum rows makes. Pure. One notification per (rule,
 * item); per recipient and item the most specific reason wins — a reply to you
 * outranks a mention of you, which outranks "a thread you follow got a comment" —
 * so one comment never arrives as three alerts. Nobody is told about their own
 * item, and a hidden or deleted item (Subsquare's hidden set holds live XSS
 * probes) never fires.
 */
export function evaluateForum(items: readonly ForumItem[], rules: readonly NotificationRule[], ctx: ForumContext): ForumMatch[] {
  const byKind = (k: ForumKind) => rules.filter(r => r.kind === k && !r.muted)
  const replyRules = byKind('forum-reply'), mentionRules = byKind('forum-mention'), threadRules = byKind('forum-thread')
  if (!replyRules.length && !mentionRules.length && !threadRules.length) return []
  const out: ForumMatch[] = []
  const sorted = [...items].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const seen = new Set<string>()
  for (const item of sorted) {
    if (!(item.seq > 0) || item.seq <= ctx.floor || item.hidden || item.deleted) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const author = item.authorAccountId ? ctx.resolve(item.authorAccountId) : ''
    const isComment = item.type === 'comment'
    const root = ctx.post(item.threadKey)
    const threadTitle = item.type === 'post'
      ? clip(item.title || threadKeyLabel(item.threadKey), TITLE_CHARS)
      : clip(root?.visible && root.title ? root.title : threadKeyLabel(item.threadKey), TITLE_CHARS)
    const payload = (reason: ForumReason): ForumMatchPayload => ({
      lane: 'forum', reason, itemId: item.id, itemType: item.type, threadKey: item.threadKey, threadTitle,
      authorAccountId: author, authorLegacyName: author ? '' : item.authorLegacyName,
      excerpt: plainText(item.body, EXCERPT_CHARS),
      path: forumItemPath(item.threadKey, isComment ? item.id : null),
    })
    const told = new Set<string>()
    const push = (rule: NotificationRule, reason: ForumReason) => {
      told.add(rule.accountId)
      out.push({
        ruleId: rule.ruleId, accountId: rule.accountId, kind: rule.kind as ForumKind,
        identity: `forum:${item.id}`, blockHeight: ctx.blockHeight, payload: payload(reason),
      })
    }
    const notSelf = (rule: NotificationRule) => !author || ctx.resolve(rule.accountId) !== author

    // A reply: a comment answers the comment it names (reply_to, else its parent);
    // a top-level comment answers the post its thread belongs to.
    if (isComment && item.kind === 'comment' && replyRules.length) {
      const targetId = item.replyToId || item.parentId
      const target = targetId ? ctx.authorOf(targetId) : root?.authorAccountId || null
      const to = target ? ctx.resolve(target) : null
      if (to) for (const rule of replyRules) if (ctx.resolve(rule.accountId) === to && notSelf(rule)) push(rule, 'reply')
    }

    // Imported text never passed this forum's posting gates (standing, rate limits,
    // the mention cap), so it cannot page anyone by naming them: mentions fire only
    // from items written here.
    if (mentionRules.length && item.source !== 'subsquare') {
      // The write path caps mentions per item; imported text was never capped, so the
      // lane caps again — one comment cannot page an unbounded list of accounts.
      const mentioned = new Set(mentionsIn(item.body).slice(0, LIMITS.mentionsPerItem).map(ctx.resolve))
      if (mentioned.size) {
        for (const rule of mentionRules) {
          if (told.has(rule.accountId) || !notSelf(rule)) continue
          if (mentioned.has(ctx.resolve(rule.accountId))) push(rule, 'mention')
        }
      }
    }

    if (isComment && threadRules.length) {
      for (const rule of threadRules) {
        if (told.has(rule.accountId) || !notSelf(rule)) continue
        if ((rule.params as RuleParams['forum-thread'] | null)?.threadKey === item.threadKey) push(rule, 'thread')
      }
    }
  }
  return out
}

/**
 * The message for a forum match. The author renders through the shared account
 * notation (`accountPartFor`, which the evaluator binds to the recipient's own tag
 * names); titles and excerpts are someone else's words and travel as plain text —
 * every outbound surface escapes text parts.
 */
export function renderForumMatch(p: ForumMatchPayload, accountPartFor: (ref: AccountRef) => RenderPart): RenderInput {
  const who: RenderPart = p.authorAccountId
    ? accountPartFor(accountRef(p.authorAccountId))
    : textPart(p.authorLegacyName || 'Someone')
  const where = p.itemType === 'post' ? `“${p.threadTitle}”` : `on “${p.threadTitle}”`
  const title: RenderPart[] = p.reason === 'reply'
    ? [who, textPart(`replied to you ${where}`)]
    : p.reason === 'mention'
      ? [who, textPart(`mentioned you ${p.itemType === 'post' ? `in ${where}` : where}`)]
      : [textPart('New comment'), textPart(where), textPart('by'), who]
  return { title, body: p.excerpt ? [`“${p.excerpt}”`] : [], path: p.path }
}

/* ============ the lane's state and source ============ */

let cursor: number | null = null
let floor: number | null = null
let catchingUp = false
let dirty = false
let persistedAtMs = 0

export function resetForumLaneForTests(): void {
  cursor = null; floor = null; catchingUp = false; dirty = false; persistedAtMs = 0
}

/** The lane's position, for diagnostics: seq values (µs since the epoch), never content. */
export function forumLaneStatus(): { cursor: number | null; floor: number | null; catchingUp: boolean } {
  return { cursor: cursorValue(), floor: floorValue(), catchingUp }
}

function stored(key: string): number | null {
  const v = Number(getNotificationState(key))
  return Number.isFinite(v) && v > 0 ? v : null
}
function cursorValue(): number | null { return cursor ?? (cursor = stored(FORUM_CURSOR_KEY)) }
function floorValue(): number | null { return floor ?? (floor = stored(FORUM_FLOOR_KEY)) }

/** The lowest seq a tick reads: the overlap below the cursor, never below the floor, never wider than the clamp. */
export function forumReadFrom(c: number, f: number, nowSeq: number, resume: boolean): number {
  const overlap = resume ? 1 : FORUM_OVERLAP_SEQ
  return Math.max(f, c - overlap, nowSeq - FORUM_MAX_WINDOW_SEQ)
}

const READ_SETTINGS = { max_threads: 2, max_memory_usage: '500000000', max_execution_time: 10 } as const

interface ItemRow {
  id: string; type: 'post' | 'comment'; kind: string; thread_key: string; parent_id: string; reply_to_id: string
  author_account_id: string; author_legacy_name: string; title: string; body: string; hidden: number; deleted: number; seq: string | number; source: string
}

// Both tables are a few thousand rows (ORDER BY post_id / (thread_key, comment_id)),
// so `seq > from` is a filter over a small table, not a key range; every version of
// an item carries the same seq (edits and moderation keep it), so filtering before
// FINAL's merge never separates an item from its newest version.
async function readItems(client: ClickHouseClient, from: number): Promise<{ items: ForumItem[]; saturated: boolean }> {
  const q = async (query: string) => (await client.query({
    query, query_params: { from: String(from), limit: FORUM_PAGE }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })).json<ItemRow>()
  const [posts, comments] = await Promise.all([
    q(`SELECT post_id AS id, 'post' AS type, kind, post_id AS thread_key, '' AS parent_id, '' AS reply_to_id,
              author_account_id, author_legacy_name, title, substring(body, 1, 50000) AS body, hidden, deleted, seq, source
       FROM price_data.forum_posts FINAL WHERE seq > {from:UInt64} ORDER BY seq LIMIT {limit:UInt32}`),
    q(`SELECT comment_id AS id, 'comment' AS type, kind, thread_key, parent_id, reply_to_id,
              author_account_id, author_legacy_name, '' AS title, substring(body, 1, 50000) AS body, hidden, deleted, seq, source
       FROM price_data.forum_comments FINAL WHERE seq > {from:UInt64} ORDER BY seq LIMIT {limit:UInt32}`),
  ])
  const toItem = (r: ItemRow): ForumItem => ({
    id: r.id, type: r.type, kind: r.kind, threadKey: r.thread_key, parentId: r.parent_id, replyToId: r.reply_to_id,
    authorAccountId: r.author_account_id, authorLegacyName: r.author_legacy_name, title: r.title, body: r.body,
    hidden: Number(r.hidden) === 1, deleted: Number(r.deleted) === 1, seq: Number(r.seq), source: r.source ?? '',
  })
  return { items: [...posts.map(toItem), ...comments.map(toItem)], saturated: posts.length >= FORUM_PAGE || comments.length >= FORUM_PAGE }
}

// A reply's target is usually an older comment the in-process store already holds;
// one written moments ago may not be in it yet, so the misses are read by their
// primary key (thread, comment id).
async function readAuthors(client: ClickHouseClient, wanted: Map<string, Set<string>>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const [threadKey, ids] of wanted) {
    const res = await client.query({
      query: `SELECT comment_id, author_account_id FROM price_data.forum_comments FINAL
              WHERE thread_key = {k:String} AND comment_id IN {ids:Array(String)}`,
      query_params: { k: threadKey, ids: [...ids] }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    for (const r of await res.json<{ comment_id: string; author_account_id: string }>()) if (r.author_account_id) out.set(r.comment_id, r.author_account_id)
  }
  return out
}

async function newestSeq(client: ClickHouseClient): Promise<number> {
  const res = await client.query({
    query: `SELECT greatest((SELECT max(seq) FROM price_data.forum_posts), (SELECT max(seq) FROM price_data.forum_comments)) AS s`,
    format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return Number((await res.json<{ s: string | number }>())[0]?.s ?? 0) || 0
}

export interface ForumLaneOutcome {
  matches: ForumMatch[]
  /** Applied only once the tick's matches are durably in the inbox — where every lane's cursor moves. */
  commit: () => void
}

/**
 * One tick of the forum lane. `rules` are the active forum rules; `head` only labels
 * the matches (see ForumContext.blockHeight). Null when there is nothing to commit.
 */
export async function runForumLane(client: ClickHouseClient, rules: readonly NotificationRule[], head: number, nowMs = Date.now()): Promise<ForumLaneOutcome | null> {
  const nowSeq = nowMs * SEQ_PER_MS
  if (!rules.length) {
    // Idle: history accrues below the clock, so a rule created later starts here.
    cursor = nowSeq; floor = nowSeq; catchingUp = false; dirty = true
    return null
  }
  const c = cursorValue(), f = floorValue()
  if (c == null || f == null) {
    // First run: everything already written is history.
    const seed = Math.max(await newestSeq(client), 1)
    cursor = seed; floor = seed; catchingUp = false
    await setNotificationStates([{ key: FORUM_CURSOR_KEY, value: String(seed) }, { key: FORUM_FLOOR_KEY, value: String(seed) }])
    dirty = false; persistedAtMs = nowMs
    return null
  }
  const from = forumReadFrom(c, f, nowSeq, catchingUp)
  const { items, saturated } = await readItems(client, from)

  const missing = new Map<string, Set<string>>()
  const inBatch = new Map(items.map(i => [i.id, i.authorAccountId] as const))
  for (const i of items) {
    const target = i.type === 'comment' ? (i.replyToId || i.parentId) : ''
    if (!target || inBatch.has(target) || forumComment(target)) continue
    if (!missing.has(i.threadKey)) missing.set(i.threadKey, new Set())
    missing.get(i.threadKey)!.add(target)
  }
  const fetched = missing.size ? await readAuthors(client, missing) : new Map<string, string>()

  const matches = evaluateForum(items, rules, {
    authorOf: id => inBatch.get(id) || forumComment(id)?.authorAccountId || forumPost(id)?.authorAccountId || fetched.get(id) || null,
    post: key => {
      const p = forumPost(key)
      return p ? { authorAccountId: p.authorAccountId, title: p.title, visible: !p.hidden && !p.deleted } : null
    },
    resolve: id => resolveDisplayAccountId(id),
    floor: f,
    blockHeight: head,
  })
  const newest = items.reduce((m, i) => Math.max(m, i.seq), 0)
  const next = Math.max(c, newest, from)
  return {
    matches,
    commit: () => {
      if (cursor !== next) { cursor = next; dirty = true }
      catchingUp = saturated
    },
  }
}

/** Persists the lane's position: at once after a delivering tick, else on a slow cadence. */
export async function persistForumLane(force: boolean, nowMs = Date.now()): Promise<void> {
  if (!dirty || cursor == null || floor == null) return
  if (!force && nowMs - persistedAtMs < IDLE_PERSIST_MS) return
  dirty = false
  persistedAtMs = nowMs
  await setNotificationStates([{ key: FORUM_CURSOR_KEY, value: String(cursor) }, { key: FORUM_FLOOR_KEY, value: String(floor) }])
}
