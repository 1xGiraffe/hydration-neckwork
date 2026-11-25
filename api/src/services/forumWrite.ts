import { referendumDeposits } from './governanceDeposits.ts'
import { createHash, randomBytes } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { accountRef, resolveDisplayAccountId } from './explorerService.ts'
import { getReferendum } from './governanceService.ts'
import { multisigCompositionFor, proxyInfoFor } from './proxyMultisigService.ts'
import { isApiAdmin } from './userApiTokenService.ts'
import {
  applyLocalComment, applyLocalPost, forumComment, forumComments, forumPost, forumPosts, forumReady, plainText,
  type ForumCommentMeta, type ForumPostMeta, forumMediaUrlMap,
} from './forumStore.ts'
import { commentFromRow, getForumPost, imageUrlsIn, threadKeyFor, type CommentRow, type ForumComment, type ForumPostDetail, type ForumPostStub } from './forumRead.ts'
import { FORUM_TOPICS, LIMITS, cleanBody, cleanLabels, cleanTitle, contentHash, hasVisibleText, linkCount, localNetworkUrls, mentionsIn, rawTooLong } from './forumText.ts'
import { SlidingLimiter, limitMessage, type LimitAction } from './forumLimits.ts'

// The forum's write side (/user/forum/*): discussions, comments and replies, edits
// with revisions, deletes, reports, a proposer's description and Updates,
// and moderation. Every write is one synchronous insert into the forum_* tables
// (021_forum.sql) — public source-of-record — followed by a patch of the in-process
// snapshot (forumStore.ts) that moves `generation`, so the author's next read shows
// it and no cache keyed by the old generation answers again.
//
// Rules this module owns:
// - WHO: the session account (bearer token, resolved like the explorer's display
//   identity). An item is its author's: the account that wrote it here, or the
//   imported author when that is the same account (claiming needs no extra step). An
//   on-chain subject's description belongs to its proposer's authority (§ below).
// - GATES: posting needs some stake in the chain (HDX, an identity or a vote), a
//   muted account cannot write, and every action has rate limits (forumLimits.ts).
// - TEXT: lengths, link and mention caps and the duplicate rule (forumText.ts). Text
//   is stored exactly as cleaned — never as trusted HTML; the explorer's one renderer
//   makes it safe at read time.
// - COEXISTENCE with the Subsquare sync: native ids never collide with imported ones
//   (a discussion is a decimal, a comment 'c<ULID>'; imports are 's…'), a native edit
//   flips `authority` to 'native' (the sync then keeps our text), and moderation
//   decisions set `moderated` (the sync then keeps the visibility). Rows are always
//   rewritten WHOLE from the stored row, so no column the sync owns is reset.
// - PRIVACY: report notes, reporters and sanctions are user_* rows, never logged.

let client: ClickHouseClient
export function initForumWrite(c: ClickHouseClient): void { client = c; assertForumModeratorConfig() }

const HDX = 10n ** 12n
const envHdx = (name: string, def: number): bigint => {
  const v = Number(process.env[name] ?? def)
  return BigInt(Math.round((Number.isFinite(v) && v >= 0 ? v : def) * 1000)) * HDX / 1000n
}
const MIN_HDX_POST = envHdx('FORUM_MIN_HDX_POST', 100)
const MIN_HDX_COMMENT = envHdx('FORUM_MIN_HDX_COMMENT', 1)
/** Above this an account's bodies may carry any number of links. */
const LINK_FREE_HDX = 1000n * HDX
const DUPLICATE_WINDOW_MS = 24 * 3_600_000
const GATE_TTL_MS = 5 * 60_000
/** Distinct eligible reporters (autoHideEligible) that hide an item until a moderator decides. */
export const AUTO_HIDE_REPORTS = 3
/** A reporter without an on-chain identity counts toward an automatic hide only with this much HDX… */
export const AUTO_HIDE_HDX = envHdx('FORUM_MIN_HDX_POST', 100)
/** …and an account first seen on chain at least this many days ago. */
export const AUTO_HIDE_MIN_AGE_DAYS = 30

export const REPORT_REASONS = ['spam', 'abuse', 'illegal', 'off-topic', 'duplicate', 'other'] as const
export const MOD_REASONS = ['spam', 'abuse', 'illegal', 'off-topic', 'duplicate', 'author-request', 'other'] as const
export const MOD_ACTIONS = ['hide', 'restore', 'lock-thread', 'unlock-thread', 'purge'] as const
export type ModAction = typeof MOD_ACTIONS[number]

export class ForumWriteError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly retryAfterSec?: number) { super(message) }
}

// ---- moderators ----

function parseModerators(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const entry of (raw ?? '').split(',')) {
    const t = entry.trim().toLowerCase()
    if (!t) continue
    if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error(`FORUM_MODERATOR_ACCOUNT_IDS entries must be 0x-prefixed 32-byte hex public keys, received ${JSON.stringify(entry)}`)
    out.add(t)
  }
  return out
}
let moderators: { raw: string; set: Set<string> } | null = null

/** ADMIN_ACCOUNT_IDS ∪ FORUM_MODERATOR_ACCOUNT_IDS. */
export function isForumModerator(accountId: string): boolean {
  const raw = process.env.FORUM_MODERATOR_ACCOUNT_IDS ?? ''
  if (moderators?.raw !== raw) moderators = { raw, set: parseModerators(raw) }
  return isApiAdmin(accountId) || moderators.set.has(accountId)
}

/** Validates FORUM_MODERATOR_ACCOUNT_IDS at boot, so a typo fails the start rather than the first moderator request. */
export function assertForumModeratorConfig(): void { isForumModerator('') }

// ---- ids, seq, time ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let ulidLastMs = 0
let ulidLastRand = 0n

/** A ULID: 48-bit millisecond time + 80 random bits, monotonic within one millisecond. */
export function ulid(now = Date.now()): string {
  let rand: bigint
  if (now <= ulidLastMs) { now = ulidLastMs; rand = ulidLastRand + 1n } else rand = BigInt('0x' + randomBytes(10).toString('hex'))
  ulidLastMs = now
  ulidLastRand = rand
  let t = now, time = ''
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32) }
  let r = rand, tail = ''
  for (let i = 0; i < 16; i++) { tail = CROCKFORD[Number(r & 31n)] + tail; r >>= 5n }
  return time + tail
}

let lastSeq = 0
/** The forum notification lane's ordering key for a NEW item: microsecond-scaled write time, strictly increasing. */
export function nextSeq(now = Date.now()): number {
  lastSeq = Math.max(lastSeq + 1, now * 1000)
  return lastSeq
}

let lastDiscussionId = 0
/** The next native discussion id: one above every decimal post id the store holds or this process issued. */
function nextDiscussionId(): string {
  let max = lastDiscussionId
  for (const p of forumPosts()) if (/^\d{1,15}$/.test(p.postId)) max = Math.max(max, Number(p.postId))
  lastDiscussionId = max + 1
  return String(lastDiscussionId)
}

/** ClickHouse DateTime64(3) text, UTC: 'YYYY-MM-DD HH:MM:SS.mmm'. */
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const msOf = (v: string) => { const t = Date.parse(`${v.replace(' ', 'T')}Z`); return Number.isFinite(t) ? t : 0 }

// One write at a time per target: an edit, a delete and a moderator's hide of the
// same row each read it whole and write it back whole, so two at once would lose one.
const locks = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  locks.set(key, run)
  try { return await run } finally { if (locks.get(key) === run) locks.delete(key) }
}

// ---- stored rows ----

const ISO = (col: string) => `toString(${col}) AS ${col}`
const POST_COLS = ['post_id', 'kind', 'title', 'body', 'body_format', 'tldr', 'labels', 'linked', 'author_account_id', 'author_legacy_name', 'authority', 'source', 'source_id', 'source_cid', 'source_hash', ISO('source_activity_at'), 'source_removed', 'source_comments_count', 'poll_json', 'banner_cid', 'revision', 'hidden', 'hidden_reason', 'deleted', ISO('created_at'), ISO('edited_at'), ISO('last_activity_at'), 'seq', 'row_fp', 'moderated', 'locked']
const COMMENT_COLS = ['thread_key', 'comment_id', 'kind', 'parent_id', 'reply_to_id', 'author_account_id', 'author_legacy_name', 'body', 'body_format', 'authority', 'source', 'source_id', 'source_cid', 'source_hash', 'source_height', 'source_removed', 'revision', 'hidden', 'hidden_reason', 'deleted', ISO('created_at'), ISO('edited_at'), 'seq', 'row_fp', 'moderated']

export interface PostRow {
  post_id: string; kind: string; title: string; body: string; body_format: string; tldr: string; labels: string[]; linked: string[]
  author_account_id: string; author_legacy_name: string; authority: string; source: string; source_id: string; source_cid: string; source_hash: string
  source_activity_at: string; source_removed: number; source_comments_count: number; poll_json: string; banner_cid: string
  revision: number; hidden: number; hidden_reason: string; deleted: number; created_at: string; edited_at: string; last_activity_at: string
  seq: number | string; row_fp: string; moderated: number; locked: number; updated_at?: string
}
export type StoredComment = CommentRow & { source_hash: string; seq: number | string; row_fp: string; moderated: number; updated_at?: string }

const READ_SETTINGS = { max_threads: 2 } as const
const WRITE_SETTINGS = { async_insert: 0, wait_for_async_insert: 1, date_time_input_format: 'best_effort' } as const

async function loadPost(postId: string): Promise<PostRow | null> {
  const res = await client.query({
    query: `SELECT ${POST_COLS.join(', ')} FROM price_data.forum_posts FINAL WHERE post_id = {id:String} LIMIT 1`,
    query_params: { id: postId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const r = (await res.json<PostRow>())[0]
  return r ? { ...r, revision: Number(r.revision), hidden: Number(r.hidden), deleted: Number(r.deleted), source_removed: Number(r.source_removed), source_comments_count: Number(r.source_comments_count), moderated: Number(r.moderated), locked: Number(r.locked) } : null
}

async function loadComment(commentId: string): Promise<StoredComment | null> {
  // The snapshot names the comment's thread, so the read stays on the primary key.
  const threadKey = forumComment(commentId)?.threadKey
  if (!threadKey) return null
  const res = await client.query({
    query: `SELECT ${COMMENT_COLS.join(', ')} FROM price_data.forum_comments FINAL WHERE thread_key = {k:String} AND comment_id = {id:String} LIMIT 1`,
    query_params: { k: threadKey, id: commentId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const r = (await res.json<StoredComment>())[0]
  return r ? { ...r, revision: Number(r.revision), hidden: Number(r.hidden), deleted: Number(r.deleted), source_removed: Number(r.source_removed), source_height: Number(r.source_height), moderated: Number(r.moderated) } : null
}

async function insert(table: string, values: object[]): Promise<void> {
  if (!values.length) return
  await client.insert({ table: `price_data.${table}`, values, format: 'JSONEachRow', clickhouse_settings: WRITE_SETTINGS })
}

function revisionRow(targetId: string, revision: number, title: string, body: string, editor: string, now: number) {
  return { target_id: targetId, revision, title, body, editor_account_id: editor, source: 'native', created_at: ts(now) }
}

function postMeta(r: PostRow): ForumPostMeta {
  return {
    postId: r.post_id, kind: r.kind, title: r.title, excerpt: r.hidden || r.deleted ? '' : plainText(r.body.slice(0, 2000)), bodyFormat: r.body_format,
    bodyLength: r.body.length, tldr: r.tldr, labels: r.labels, linked: r.linked, authorAccountId: r.author_account_id,
    authorLegacyName: r.author_legacy_name, authority: r.authority, source: r.source, sourceId: r.source_id, sourceCid: r.source_cid,
    sourceRemoved: r.source_removed === 1, bannerCid: r.banner_cid, pollJson: r.poll_json, revision: r.revision,
    hidden: r.hidden === 1, hiddenReason: r.hidden_reason, deleted: r.deleted === 1, locked: r.locked === 1, moderated: r.moderated === 1,
    createdAt: msOf(r.created_at), editedAt: msOf(r.edited_at) || null, lastActivityAt: msOf(r.last_activity_at), updatedAt: Date.now(),
  }
}

function commentMeta(r: StoredComment): ForumCommentMeta {
  return {
    commentId: r.comment_id, threadKey: r.thread_key, kind: r.kind, parentId: r.parent_id, replyToId: r.reply_to_id,
    authorAccountId: r.author_account_id, hidden: r.hidden === 1, deleted: r.deleted === 1, createdAt: msOf(r.created_at),
    excerpt: r.hidden || r.deleted ? '' : plainText(r.body.slice(0, 600)),
  }
}

// ---- gates ----

export interface GateFacts { hdx: bigint; identity: boolean; voted: boolean; firstSeenMs: number | null }
const gateCache = new Map<string, { at: number; facts: GateFacts }>()

/**
 * What the posting gate reads about an account: its HDX, an on-chain identity, any
 * vote ever, and when it was first seen on chain (its earliest indexed activity).
 * Cached briefly for the gate; `fresh` re-reads (a report's eligibility always does).
 */
export async function gateFacts(accountId: string, fresh = false): Promise<GateFacts> {
  const hit = gateCache.get(accountId)
  if (!fresh && hit && Date.now() - hit.at < GATE_TTL_MS) return hit.facts
  const [bal, votes, first] = await Promise.all([
    client.query({
      query: `SELECT toString(toUInt256OrZero(argMaxMerge(total_state))) AS bal FROM price_data.account_asset_latest_balances
              WHERE account_id = {a:String} AND asset_id = '0' GROUP BY account_id`,
      query_params: { a: accountId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    }).then(r => r.json<{ bal: string }>()),
    client.query({
      query: `SELECT 1 AS v FROM price_data.governance_vote_calls_by_voter WHERE voter = {a:String} LIMIT 1`,
      query_params: { a: accountId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    }).then(r => r.json<{ v: number }>()),
    client.query({
      query: `SELECT toUnixTimestamp(min(block_timestamp)) AS t FROM price_data.account_activity_v3 WHERE account = {a:String} GROUP BY account`,
      query_params: { a: accountId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    }).then(r => r.json<{ t: number | string }>()),
  ])
  const t = Number(first[0]?.t ?? 0)
  const facts: GateFacts = { hdx: BigInt(bal[0]?.bal ?? '0'), identity: !!accountRef(accountId).identity, voted: votes.length > 0, firstSeenMs: t > 0 ? t * 1000 : null }
  if (gateCache.size > 20_000) gateCache.clear()
  gateCache.set(accountId, { at: Date.now(), facts })
  return facts
}

export interface ActionGate { ok: boolean; reason: string | null }

export interface ForumStanding {
  canPost: boolean
  canComment: boolean
  /** Per action, whether this account may do it now and, if not, why and what to do next. */
  actions: { comment: ActionGate; post: ActionGate; report: ActionGate; upload: ActionGate }
  /** The facts the gate read (balance as raw planck, 12 decimals). */
  facts: { hdx: string; identity: boolean; voted: boolean }
  thresholds: { commentHdx: number; postHdx: number; autoHideHdx: number }
  /** Why not, in words a person can act on; null when every write is open. */
  gate: { reason: 'muted' | 'no-stake-post' | 'no-stake-comment'; detail: string } | null
  mutedUntil: string | null
  moderator: boolean
  linksUnlimited: boolean
}

const hdxWords = (v: bigint) => (v % HDX === 0n ? (v / HDX).toString() : (Number(v) / 1e12).toString())

export function standingFrom(facts: GateFacts, mutedUntilMs: number | null, moderator: boolean): ForumStanding {
  const stake = facts.identity || facts.voted
  const canComment = stake || facts.hdx >= MIN_HDX_COMMENT
  const canPost = stake || facts.hdx >= MIN_HDX_POST
  const muted = mutedUntilMs != null && mutedUntilMs > Date.now()
  const gate: ForumStanding['gate'] = muted
    ? { reason: 'muted', detail: `A moderator has paused writing for this account until ${new Date(mutedUntilMs!).toUTCString()}.` }
    : !canComment ? { reason: 'no-stake-comment', detail: `To comment, an account needs at least ${hdxWords(MIN_HDX_COMMENT)} HDX, an on-chain identity, or a vote on any referendum.` }
      : !canPost ? { reason: 'no-stake-post', detail: `To start a discussion, an account needs at least ${hdxWords(MIN_HDX_POST)} HDX, an on-chain identity, or a vote on any referendum. You can still comment.` }
        : null
  const held = `This account holds ${hdxWords(facts.hdx - facts.hdx % (HDX / 1000n))} HDX`
  const need = (what: string, min: bigint) => `${what} needs at least ${hdxWords(min)} HDX, an on-chain identity, or a vote on any referendum. ${held} — add HDX, set an identity, or vote, then try again.`
  const mutedReason = muted ? gate!.detail : null
  const commentGate: ActionGate = { ok: canComment && !muted, reason: mutedReason ?? (canComment ? null : need('Commenting', MIN_HDX_COMMENT)) }
  const sameAsComment = (what: string): ActionGate => ({ ok: commentGate.ok, reason: mutedReason ?? (canComment ? null : need(what, MIN_HDX_COMMENT)) })
  return {
    canPost: canPost && !muted, canComment: canComment && !muted, gate,
    actions: {
      comment: commentGate,
      post: { ok: canPost && !muted, reason: mutedReason ?? (canPost ? null : need('Starting a discussion', MIN_HDX_POST)) },
      report: sameAsComment('Reporting'),
      upload: sameAsComment('Adding images'),
    },
    facts: { hdx: facts.hdx.toString(), identity: facts.identity, voted: facts.voted },
    thresholds: { commentHdx: Number(MIN_HDX_COMMENT) / 1e12, postHdx: Number(MIN_HDX_POST) / 1e12, autoHideHdx: Number(AUTO_HIDE_HDX) / 1e12 },
    mutedUntil: muted ? new Date(mutedUntilMs!).toISOString() : null, moderator,
    linksUnlimited: facts.hdx >= LINK_FREE_HDX,
  }
}

// ---- sanctions (user_forum_sanctions, private) ----

const mutes = new Map<string, number>()
let mutesLoadedAt = 0

async function loadMutes(force = false): Promise<void> {
  if (!force && Date.now() - mutesLoadedAt < 60_000) return
  const res = await client.query({
    query: `SELECT account_id, toUnixTimestamp(until) AS until FROM price_data.user_forum_sanctions FINAL
            WHERE kind = 'mute' AND deleted = 0 AND until > now()`,
    format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  mutes.clear()
  for (const r of await res.json<{ account_id: string; until: number }>()) mutes.set(r.account_id, Number(r.until) * 1000)
  mutesLoadedAt = Date.now()
}

export async function mutedUntil(accountId: string): Promise<number | null> {
  await loadMutes()
  const until = mutes.get(accountId)
  return until && until > Date.now() ? until : null
}

export async function standingOf(accountId: string): Promise<ForumStanding> {
  const [facts, muted] = await Promise.all([gateFacts(accountId), mutedUntil(accountId)])
  return standingFrom(facts, muted, isForumModerator(accountId))
}

// ---- limits ----

export const limiter = new SlidingLimiter()
setInterval(() => limiter.sweep(), 10 * 60_000).unref()

/** Seeds the daily windows that must survive a restart from what the account wrote here. */
function seedFromStore(action: LimitAction, accountId: string): void {
  if (limiter.isSeeded(action, accountId)) return
  const since = Date.now() - 86_400_000
  const times: number[] = []
  if (action === 'discussion') {
    for (const p of forumPosts()) if (p.kind === 'discussion' && p.source === '' && p.authorAccountId === accountId && p.createdAt > since) times.push(p.createdAt)
  } else if (action === 'comment') {
    for (const c of forumComments()) if (c.commentId.startsWith('c') && c.authorAccountId === accountId && c.createdAt > since) times.push(c.createdAt)
  }
  limiter.seed(action, accountId, times)
}

export interface LimitSlots { taken: Array<{ action: LimitAction; who: string; at: number }> }

/**
 * Takes one slot of `action` for the account (and of `ip` for the client address) or
 * refuses with 429 — checked and recorded in one synchronous step, so concurrent
 * requests can never both take the last slot. A write that then fails gives its slots
 * back (`giveBack`).
 */
export function takeLimit(action: LimitAction, accountId: string, ip: string | null): LimitSlots {
  seedFromStore(action, accountId)
  const slots: LimitSlots = { taken: [] }
  for (const [a, who] of [[action, accountId], ...(ip ? [['ip', ip]] : [])] as Array<[LimitAction, string]>) {
    const got = limiter.reserve(a, who)
    if ('window' in got) { giveBack(slots); throw new ForumWriteError(429, limitMessage(got), 'rate-limited', got.retryAfterSec) }
    slots.taken.push({ action: a, who, at: got.at })
  }
  return slots
}

export function giveBack(slots: LimitSlots): void {
  for (const t of slots.taken) limiter.release(t.action, t.who, t.at)
  slots.taken = []
}

/** Runs a write holding its rate-limit slots; a write that throws gives them back. */
async function limited<T>(slots: LimitSlots, fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (err) { giveBack(slots); throw err }
}

// Duplicate rule: the same body from the same account within a day is refused.
const recentBodies = new Map<string, Array<{ hash: string; at: number }>>()
function duplicateCheck(accountId: string, text: string): string {
  const hash = contentHash(text)
  const now = Date.now()
  const list = (recentBodies.get(accountId) ?? []).filter(e => now - e.at < DUPLICATE_WINDOW_MS)
  recentBodies.set(accountId, list)
  if (list.some(e => e.hash === hash)) throw new ForumWriteError(409, 'You already posted this exact text in the last 24 hours.', 'duplicate')
  return hash
}
function rememberBody(accountId: string, hash: string): void {
  const list = recentBodies.get(accountId) ?? []
  list.push({ hash, at: Date.now() })
  recentBodies.set(accountId, list.slice(-50))
}

/** Clears every in-process ledger (tests). */
export function resetForumWriteForTests(): void {
  limiter.clear(); recentBodies.clear(); gateCache.clear(); mutes.clear(); mutesLoadedAt = 0; lastDiscussionId = 0
}

// ---- validation ----

function tooLong(what: string, length: number, max: number): ForumWriteError {
  return new ForumWriteError(422, `The ${what} is ${length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}.`, 'too-long')
}

function validateBody(raw: unknown, max: number, standing: ForumStanding, what: string): string {
  if (typeof raw !== 'string') throw new ForumWriteError(400, `The ${what} is missing.`, 'invalid')
  if (rawTooLong(raw, max)) throw tooLong(what, raw.length, max)
  const body = cleanBody(raw)
  if (!hasVisibleText(body)) throw new ForumWriteError(400, `The ${what} is empty.`, 'empty')
  if (body.length > max) throw tooLong(what, body.length, max)
  if (mentionsIn(body).length > LIMITS.mentionsPerItem) throw new ForumWriteError(422, `Mention at most ${LIMITS.mentionsPerItem} accounts in one ${what}.`, 'too-many-mentions')
  if (!standing.linksUnlimited && linkCount(body) > LIMITS.linksPerBodyLowBalance) {
    throw new ForumWriteError(422, `A ${what} can carry at most ${LIMITS.linksPerBodyLowBalance} links from an account holding under 1,000 HDX.`, 'too-many-links')
  }
  refuseLocalNetworkLinks(body, `This ${what}`)
  return body
}

/**
 * Refuses text that links into a private or local network (localhost, private IPs, bare
 * one-label names, .local and similar, unusual ports): enforced here, in the api, so it
 * holds for every client, not only the explorer's editor.
 */
function refuseLocalNetworkLinks(text: string, what: string): void {
  const [first] = localNetworkUrls(text)
  if (first) {
    const shown = first.length > 120 ? `${first.slice(0, 119)}…` : first
    throw new ForumWriteError(422, `${what} links to a private or local network address (${shown}). Only public web links are allowed.`, 'local-link')
  }
}

function validateTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new ForumWriteError(400, 'The title is missing.', 'invalid')
  const title = cleanTitle(raw)
  if (!title) throw new ForumWriteError(400, 'The title is empty.', 'empty')
  if (title.length > LIMITS.titleChars) throw new ForumWriteError(422, `The title is ${title.length} characters; the limit is ${LIMITS.titleChars}.`, 'too-long')
  refuseLocalNetworkLinks(title, 'The title')
  return title
}

function validateLabels(raw: unknown, allowed: readonly string[] = FORUM_TOPICS): string[] {
  if (raw == null) return []
  if (!Array.isArray(raw) || raw.some(l => typeof l !== 'string')) throw new ForumWriteError(400, 'Topics must be a list of names.', 'invalid')
  const labels = cleanLabels(raw as string[])
  if (labels.length > LIMITS.labelsPerPost) throw new ForumWriteError(422, `Pick at most ${LIMITS.labelsPerPost} topics.`, 'too-many-labels')
  const unknown = labels.find(l => !allowed.includes(l))
  if (unknown) throw new ForumWriteError(422, `“${unknown.slice(0, 32)}” is not a forum topic. Topics: ${FORUM_TOPICS.join(', ')}.`, 'unknown-label')
  return labels
}

// ---- authority ----

const sameAccount = (a: string, b: string) => !!a && !!b && (a === b || resolveDisplayAccountId(a) === b || a === resolveDisplayAccountId(b))

/** Whether `accountId` wrote this item (here, or as the imported author it is). */
export function isAuthor(accountId: string, author: string): boolean { return sameAccount(author, accountId) }

/**
 * The accounts that may speak for an on-chain subject's proposer P: P itself, any of
 * P's Any or Governance proxies, every signatory when P is a multisig, and P's spawner
 * when P is a pure proxy — evaluated from the indexed state on every write.
 */
export function speaksFor(accountId: string, proposer: string): boolean {
  if (sameAccount(proposer, accountId)) return true
  const proxy = proxyInfoFor([proposer])
  if (proxy?.delegates.some(d => sameAccount(d.accountId, accountId) && (d.proxyType === 'Any' || d.proxyType === 'Governance'))) return true
  if (proxy?.isPure && sameAccount(proxy.isPure.creator, accountId)) return true
  return !!multisigCompositionFor([proposer])?.signatories.some(s => sameAccount(s, accountId))
}

/** An on-chain subject's key, canonical only (no leading zeros): 'opengov:450', never 'opengov:0450'. */
export const SUBJECT_RE = /^(opengov|democracy):(0|[1-9]\d{0,8})$/
const OPENGOV_RE = /^opengov:(0|[1-9]\d{0,8})$/

/** The proposer whose authority owns an on-chain subject's description (the submit's signer, and the account its submission deposit came from), or null (no such referendum, or none recorded). */
async function subjectProposer(postId: string): Promise<{ exists: boolean; proposer: string | null; depositor: string | null }> {
  const m = SUBJECT_RE.exec(postId)
  if (!m) return { exists: false, proposer: null, depositor: null }
  const detail = await getReferendum(m[1] as 'opengov' | 'democracy', Number(m[2]), 1).catch(() => null)
  // The submit extrinsic's signer is a proxy when the proposal was submitted through
  // one; the account the submission deposit was reserved from is the real proposer.
  const deposits = m[1] === 'opengov' && detail ? await referendumDeposits(Number(m[2])).catch(() => null) : null
  return { exists: !!detail, proposer: detail?.proposer?.accountId ?? null, depositor: deposits?.submission?.who ?? null }
}

export interface Permissions { edit: boolean; delete: boolean; update: boolean; comment: boolean; reason: string | null }

/**
 * What the session account may do with a post: edit its text, delete it, add Updates,
 * comment on its thread.
 *
 * A discussion is its author's. An on-chain subject's description is NEVER owned by
 * whoever last wrote it: its authority is recomputed on every call from the chain —
 * the referendum's proposer and, as they stand now, its Any/Governance proxies,
 * multisig signatories and pure-proxy creator — so a proxy that was removed loses the
 * right at once. A description cannot be deleted by anyone (its revisions are the
 * record of what the proposer said); only a moderator's purge erases it.
 */
export async function postPermissions(accountId: string, postId: string): Promise<Permissions> {
  const meta = forumPost(postId)
  const subject = SUBJECT_RE.test(postId)
  const gone = !!meta?.deleted
  const commentable = commentableThread(meta ? threadKeyFor(postId) : postId, postId)
  if (subject) {
    const { proposer, depositor } = await subjectProposer(postId)
    const authority = (!!proposer && speaksFor(accountId, proposer)) || (!!depositor && speaksFor(accountId, depositor))
    return {
      edit: !gone && authority, delete: false, update: !gone && authority && OPENGOV_RE.test(postId),
      comment: commentable.ok, reason: gone ? 'This was deleted.' : commentable.ok ? null : commentable.reason,
    }
  }
  const authorOk = !!meta && meta.kind === 'discussion' && isAuthor(accountId, meta.authorAccountId)
  return {
    edit: !gone && authorOk, delete: !gone && authorOk, update: false,
    comment: commentable.ok, reason: gone ? 'This was deleted.' : commentable.ok ? null : commentable.reason,
  }
}

/**
 * Threads take new comments on discussions and OpenGov referenda; the pre-OpenGov
 * archive is read-only. A lock on the post a reader asked for OR on the thread it
 * resolves to closes it (a merged thread is reachable from several posts).
 */
function commentableThread(threadKey: string, requested: string = threadKey): { ok: true } | { ok: false; reason: string } {
  const meta = forumPost(threadKey)
  if (meta?.locked || forumPost(requested)?.locked) return { ok: false, reason: 'A moderator locked this thread.' }
  if (meta && (meta.hidden || meta.deleted) && meta.kind === 'discussion') return { ok: false, reason: 'This discussion is no longer shown.' }
  if (meta?.kind === 'discussion' || OPENGOV_RE.test(threadKey)) return { ok: true }
  return { ok: false, reason: 'The archive of pre-OpenGov governance is read-only.' }
}

// ---- writes ----

export interface WriteContext { accountId: string; ip: string | null }

function requireReady(): void {
  if (!forumReady()) throw new ForumWriteError(503, 'The forum is still loading — try again in a few seconds.', 'not-ready')
}

async function requireStanding(ctx: WriteContext, need: 'post' | 'comment'): Promise<ForumStanding> {
  const s = await standingOf(ctx.accountId)
  if (need === 'post' ? !s.canPost : !s.canComment) throw new ForumWriteError(403, s.gate?.detail ?? 'This account cannot write here.', s.gate?.reason ?? 'gated')
  return s
}

export interface PostResult { post: ForumPostDetail | ForumPostStub; generation: string }
export interface CommentResult { comment: ForumComment; generation: string }

export async function createDiscussion(ctx: WriteContext, input: { title?: unknown; body?: unknown; labels?: unknown }): Promise<PostResult> {
  requireReady()
  const standing = await requireStanding(ctx, 'post')
  return limited(takeLimit('discussion', ctx.accountId, ctx.ip), async () => {
    const title = validateTitle(input.title)
    const body = validateBody(input.body, LIMITS.postBodyChars, standing, 'post')
    const labels = validateLabels(input.labels)
    const hash = duplicateCheck(ctx.accountId, `${title}\n${body}`)
    const now = Date.now()
    const postId = nextDiscussionId()
    const row: PostRow = {
      post_id: postId, kind: 'discussion', title, body, body_format: 'markdown', tldr: '', labels, linked: [],
      author_account_id: ctx.accountId, author_legacy_name: '', authority: 'native', source: '', source_id: '', source_cid: '', source_hash: '',
      source_activity_at: ts(0), source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '',
      revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: ts(now), edited_at: ts(0), last_activity_at: ts(now),
      seq: nextSeq(now), row_fp: '', moderated: 0, locked: 0, updated_at: ts(now),
    }
    await insert('forum_revisions', [revisionRow(postId, 0, title, body, ctx.accountId, now)])
    await insert('forum_posts', [row])
    rememberBody(ctx.accountId, hash)
    const generation = applyLocalPost(postMeta(row))
    return { post: (await getForumPost(postId))!, generation }
  })
}

/**
 * Edits a post's text (a discussion by its author; an OpenGov or Democracy
 * referendum's description by its proposer's CURRENT authority — which writes the
 * description when none exists yet). Every edit is a new revision; the first flips
 * the post's authority to 'native', after which the sync stores Subsquare's later
 * edits as revisions only.
 */
export async function editPost(ctx: WriteContext, postId: string, input: { title?: unknown; body?: unknown; tldr?: unknown; labels?: unknown }): Promise<PostResult> {
  requireReady()
  return serialized(postId, async () => {
    const perms = await postPermissions(ctx.accountId, postId)
    if (!perms.edit) {
      if (!forumPost(postId) && !SUBJECT_RE.test(postId)) throw new ForumWriteError(404, 'There is no such post.', 'not-found')
      throw new ForumWriteError(403, perms.reason ?? (SUBJECT_RE.test(postId) ? 'Only the proposer, or an account that speaks for it on chain now, can edit this description.' : 'Only its author can edit this.'), 'forbidden')
    }
    const standing = await requireStanding(ctx, 'comment')
    return limited(takeLimit('edit', ctx.accountId, ctx.ip), async () => {
      const stored = await loadPost(postId)
      const now = Date.now()
      const subject = SUBJECT_RE.exec(postId)
      const base: PostRow = stored ?? {
        post_id: postId, kind: subject![1], title: '', body: '', body_format: 'markdown', tldr: '', labels: [], linked: [],
        author_account_id: ctx.accountId, author_legacy_name: '', authority: 'native', source: '', source_id: '', source_cid: '', source_hash: '',
        source_activity_at: ts(0), source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '',
        revision: -1, hidden: 0, hidden_reason: '', deleted: 0, created_at: ts(now), edited_at: ts(0), last_activity_at: ts(now),
        seq: 0, row_fp: '', moderated: 0, locked: 0,
      }
      if (base.deleted) throw new ForumWriteError(409, 'This was deleted.', 'deleted')
      if (base.hidden_reason === PURGED) throw new ForumWriteError(409, 'Moderators removed this.', 'purged')
      const next: PostRow = { ...base }
      if (input.title !== undefined) next.title = validateTitle(input.title)
      if (input.body !== undefined) next.body = validateBody(input.body, LIMITS.postBodyChars, standing, 'post')
      if (input.tldr !== undefined) {
        if (typeof input.tldr !== 'string') throw new ForumWriteError(400, 'The summary must be text.', 'invalid')
        next.tldr = cleanTitle(input.tldr)
        if (next.tldr.length > LIMITS.tldrChars) throw new ForumWriteError(422, `The summary is limited to ${LIMITS.tldrChars} characters.`, 'too-long')
        refuseLocalNetworkLinks(next.tldr, 'The summary')
      }
      if (input.labels !== undefined) {
        if (base.kind !== 'discussion') throw new ForumWriteError(422, 'Only discussions have topics.', 'invalid')
        // A post keeps the labels it was imported with; new ones come from the forum's topics.
        next.labels = validateLabels(input.labels, [...FORUM_TOPICS, ...base.labels])
      }
      if (!next.title && base.kind === 'discussion') throw new ForumWriteError(400, 'The title is empty.', 'empty')
      if (!hasVisibleText(next.body)) throw new ForumWriteError(400, 'The text is empty.', 'empty')
      const textChanged = next.title !== base.title || next.body !== base.body
      if (!textChanged && next.tldr === base.tldr && next.labels.join('\u0000') === base.labels.join('\u0000')) {
        return { post: (await getForumPost(postId))!, generation: '' }
      }
      // A text-less stub (a comment opened the thread) is credited to whoever writes the first description.
      if (!next.author_account_id && !next.author_legacy_name) next.author_account_id = ctx.accountId
      if (textChanged) {
        next.revision = base.revision + 1
        next.edited_at = stored && stored.body ? ts(now) : ts(0)
        await insert('forum_revisions', [revisionRow(postId, next.revision, next.title, next.body, ctx.accountId, now)])
      }
      next.authority = 'native'
      next.last_activity_at = ts(now)
      next.updated_at = ts(now)
      await insert('forum_posts', [next])
      const generation = applyLocalPost(postMeta(next))
      return { post: (await getForumPost(postId))!, generation }
    })
  })
}

// ---- erasing text: an author's delete, a moderator's purge ----
//
// A ReplacingMergeTree keeps superseded versions of a row until a merge, and every
// one of them carries the old text (readable with a plain SELECT, the read-only
// endpoint included). So after the tombstone version is written, the older versions
// are removed with a lightweight DELETE on the row's own key, and so are the item's
// revisions. Both are public in the moderation log ('delete' by the author, 'purge'
// by a moderator), which is what a restore from an older backup re-applies
// (ops/forum-reapply-erasures.sh).

/** The hidden_reason of a moderator's purge: text gone for good, never shown, never restorable here. */
export const PURGED = 'purged'
const ERASE_SETTINGS = { lightweight_deletes_sync: '2' } as const

async function eraseOldPostVersions(postId: string): Promise<void> {
  await client.command({
    query: `DELETE FROM price_data.forum_posts WHERE post_id = {id:String} AND (body != '' OR title != '' OR tldr != '')`,
    query_params: { id: postId }, clickhouse_settings: ERASE_SETTINGS,
  })
}

async function eraseOldCommentVersions(threadKey: string, commentId: string): Promise<void> {
  await client.command({
    query: `DELETE FROM price_data.forum_comments WHERE thread_key = {k:String} AND comment_id = {id:String} AND body != ''`,
    query_params: { k: threadKey, id: commentId }, clickhouse_settings: ERASE_SETTINGS,
  })
}

async function purgeRevisions(targetId: string): Promise<void> {
  await client.command({
    query: `DELETE FROM price_data.forum_revisions WHERE target_id = {id:String}`,
    query_params: { id: targetId }, clickhouse_settings: ERASE_SETTINGS,
  })
}

async function logAction(target: string, action: string, reason: string, actor: string, now: number): Promise<void> {
  await insert('forum_moderation_log', [{ action_id: `${action}:${ulid(now)}`, target_id: target, action, reason_code: reason, moderator_account_id: actor, created_at: ts(now) }])
}

/**
 * An author's delete of their own discussion: the text and every revision are erased
 * from the live tables at once and a tombstone stays, so the thread under it keeps
 * its shape ("deleted by its author"). A referendum's description is never deleted.
 * Nightly backups age out under their retention.
 */
export async function deletePost(ctx: WriteContext, postId: string): Promise<{ generation: string }> {
  requireReady()
  if (SUBJECT_RE.test(postId) || /^[a-z_]+:/.test(postId)) throw new ForumWriteError(403, 'A referendum’s description cannot be deleted; its proposer can edit it.', 'forbidden')
  return serialized(postId, async () => {
    if (!forumPost(postId)) throw new ForumWriteError(404, 'There is no such post.', 'not-found')
    const perms = await postPermissions(ctx.accountId, postId)
    if (!perms.delete) throw new ForumWriteError(403, perms.reason ?? 'Only its author can delete this.', 'forbidden')
    return limited(takeLimit('edit', ctx.accountId, ctx.ip), async () => {
      const stored = await loadPost(postId)
      if (!stored) throw new ForumWriteError(404, 'There is no such post.', 'not-found')
      const now = Date.now()
      const next: PostRow = { ...stored, title: '', body: '', tldr: '', deleted: 1, authority: 'native', edited_at: ts(now), updated_at: ts(now) }
      await logAction(postId, 'delete', 'author-request', ctx.accountId, now)
      await insert('forum_posts', [next])
      await eraseOldPostVersions(postId)
      await purgeRevisions(postId)
      return { generation: applyLocalPost(postMeta(next)) }
    })
  })
}

/** Where a new comment files: its thread (the one readers see) and, for a reply, the top-level parent. */
function placement(threadKeyIn: string, parentId: string | null): { threadKey: string; parentId: string; replyToId: string } {
  if (/^[a-z_]+:/.test(threadKeyIn) && !forumPost(threadKeyIn) && !SUBJECT_RE.test(threadKeyIn)) {
    throw new ForumWriteError(404, 'There is no such thread.', 'not-found')
  }
  const threadKey = forumPost(threadKeyIn) ? threadKeyFor(threadKeyIn) : threadKeyIn
  if (!parentId) return { threadKey, parentId: '', replyToId: '' }
  const parent = forumComment(parentId)
  if (!parent || parent.threadKey !== threadKey || parent.kind !== 'comment') throw new ForumWriteError(404, 'The comment you are replying to is not in this thread.', 'not-found')
  if (parent.deleted || parent.hidden) throw new ForumWriteError(409, 'The comment you are replying to is no longer shown.', 'gone')
  // Two levels: a reply to a reply files under its top-level comment and names the one it answers.
  return { threadKey, parentId: parent.parentId || parent.commentId, replyToId: parent.commentId }
}

/**
 * A stub description row for an on-chain subject a comment opens a thread on (no
 * text; the sync replaces it if Subsquare has one). Serialized with every other
 * write to the post and re-checked against the stored row after the referendum
 * lookup, so it can never overwrite a description written meanwhile — here or by the
 * sync, which the snapshot may not show yet.
 */
async function ensureSubjectStub(threadKey: string, now: number): Promise<void> {
  if (forumPost(threadKey)) return
  await serialized(threadKey, async () => {
    if (forumPost(threadKey)) return
    const { exists } = await subjectProposer(threadKey)
    if (!exists) throw new ForumWriteError(404, 'There is no such referendum.', 'not-found')
    if (forumPost(threadKey) || await loadPost(threadKey)) return
    const row: PostRow = {
      post_id: threadKey, kind: SUBJECT_RE.exec(threadKey)![1], title: '', body: '', body_format: 'markdown', tldr: '', labels: [], linked: [],
      author_account_id: '', author_legacy_name: '', authority: '', source: '', source_id: '', source_cid: '', source_hash: '',
      source_activity_at: ts(0), source_removed: 0, source_comments_count: 0, poll_json: '', banner_cid: '',
      revision: 0, hidden: 0, hidden_reason: '', deleted: 0, created_at: ts(now), edited_at: ts(0), last_activity_at: ts(now),
      seq: 0, row_fp: '', moderated: 0, locked: 0, updated_at: ts(now),
    }
    await insert('forum_posts', [row])
    applyLocalPost(postMeta(row))
  })
}

export async function createComment(ctx: WriteContext, input: { threadKey?: unknown; parentId?: unknown; body?: unknown }): Promise<CommentResult> {
  requireReady()
  if (typeof input.threadKey !== 'string' || !input.threadKey) throw new ForumWriteError(400, 'Which thread is this for?', 'invalid')
  if (input.parentId != null && typeof input.parentId !== 'string') throw new ForumWriteError(400, 'Invalid reply target.', 'invalid')
  const where = placement(input.threadKey, (input.parentId as string | null) || null)
  const open = commentableThread(where.threadKey, input.threadKey)
  if (!open.ok) throw new ForumWriteError(409, open.reason, 'closed')
  const standing = await requireStanding(ctx, 'comment')
  return limited(takeLimit('comment', ctx.accountId, ctx.ip), async () => {
    const body = validateBody(input.body, LIMITS.commentBodyChars, standing, 'comment')
    const hash = duplicateCheck(ctx.accountId, `${where.threadKey}\n${body}`)
    const now = Date.now()
    await ensureSubjectStub(where.threadKey, now)
    // The lock is read again after the awaits: a moderator may have locked it meanwhile.
    const still = commentableThread(where.threadKey, input.threadKey as string)
    if (!still.ok) throw new ForumWriteError(409, still.reason, 'closed')
    const row = commentRow(ctx.accountId, where, 'comment', body, now)
    await insert('forum_revisions', [revisionRow(row.comment_id, 0, '', body, ctx.accountId, now)])
    await insert('forum_comments', [row])
    rememberBody(ctx.accountId, hash)
    const generation = applyLocalComment(commentMeta(row))
    return { comment: commentFromRow(row), generation }
  })
}

function commentRow(author: string, where: { threadKey: string; parentId: string; replyToId: string }, kind: 'comment' | 'update', body: string, now: number): StoredComment {
  return {
    thread_key: where.threadKey, comment_id: `c${ulid(now)}`, kind, parent_id: where.parentId, reply_to_id: where.replyToId,
    author_account_id: author, author_legacy_name: '', body, body_format: 'markdown', authority: 'native', source: '', source_id: '',
    source_cid: '', source_hash: '', source_height: 0, source_removed: 0, revision: 0, hidden: 0, hidden_reason: '', deleted: 0,
    created_at: ts(now), edited_at: ts(0), seq: nextSeq(now), row_fp: '', moderated: 0, updated_at: ts(now),
  }
}

/** A proposer's append-only note under an OpenGov referendum's description (its "Updates"): no edit, no delete. */
export async function addUpdate(ctx: WriteContext, postId: string, input: { body?: unknown }): Promise<CommentResult> {
  requireReady()
  const perms = await postPermissions(ctx.accountId, postId)
  if (!perms.update) throw new ForumWriteError(403, 'Only the proposer (or an account that speaks for it on chain now) can post Updates here.', 'forbidden')
  const standing = await requireStanding(ctx, 'comment')
  return limited(takeLimit('comment', ctx.accountId, ctx.ip), async () => {
    const body = validateBody(input.body, LIMITS.updateBodyChars, standing, 'update')
    const now = Date.now()
    await ensureSubjectStub(postId, now)
    const row = commentRow(ctx.accountId, { threadKey: postId, parentId: '', replyToId: '' }, 'update', body, now)
    await insert('forum_revisions', [revisionRow(row.comment_id, 0, '', body, ctx.accountId, now)])
    await insert('forum_comments', [row])
    const generation = applyLocalComment(commentMeta(row))
    return { comment: commentFromRow(row), generation }
  })
}

async function ownComment(ctx: WriteContext, commentId: string): Promise<StoredComment> {
  const meta = forumComment(commentId)
  if (!meta) throw new ForumWriteError(404, 'There is no such comment.', 'not-found')
  if (meta.kind === 'update') throw new ForumWriteError(403, 'Updates under a description are append-only: post a new one instead.', 'append-only')
  if (!isAuthor(ctx.accountId, meta.authorAccountId)) throw new ForumWriteError(403, 'Only its author can change this comment.', 'forbidden')
  const stored = await loadComment(commentId)
  if (!stored) throw new ForumWriteError(404, 'There is no such comment.', 'not-found')
  if (stored.deleted) throw new ForumWriteError(409, 'This comment was deleted.', 'deleted')
  if (stored.hidden_reason === PURGED) throw new ForumWriteError(409, 'Moderators removed this comment.', 'purged')
  return stored
}

export async function editComment(ctx: WriteContext, commentId: string, input: { body?: unknown }): Promise<CommentResult> {
  requireReady()
  return serialized(commentId, async () => {
    const stored = await ownComment(ctx, commentId)
    const standing = await requireStanding(ctx, 'comment')
    const slots = takeLimit('edit', ctx.accountId, ctx.ip)
    return limited(slots, async () => {
      const body = validateBody(input.body, LIMITS.commentBodyChars, standing, 'comment')
      // An edit that changes nothing writes nothing and keeps its slot free.
      if (body === stored.body) { giveBack(slots); return { comment: commentFromRow(stored), generation: '' } }
      const now = Date.now()
      const next: StoredComment = { ...stored, body, revision: stored.revision + 1, authority: 'native', edited_at: ts(now), updated_at: ts(now) }
      await insert('forum_revisions', [revisionRow(commentId, next.revision, '', body, ctx.accountId, now)])
      await insert('forum_comments', [next])
      const generation = applyLocalComment(commentMeta(next))
      return { comment: commentFromRow(next), generation }
    })
  })
}

export async function deleteComment(ctx: WriteContext, commentId: string): Promise<{ generation: string }> {
  requireReady()
  return serialized(commentId, async () => {
    const stored = await ownComment(ctx, commentId)
    return limited(takeLimit('edit', ctx.accountId, ctx.ip), async () => {
      const now = Date.now()
      const next: StoredComment = { ...stored, body: '', deleted: 1, authority: 'native', edited_at: ts(now), updated_at: ts(now) }
      await logAction(commentId, 'delete', 'author-request', ctx.accountId, now)
      await insert('forum_comments', [next])
      await eraseOldCommentVersions(stored.thread_key, commentId)
      await purgeRevisions(commentId)
      return { generation: applyLocalComment(commentMeta(next)) }
    })
  })
}

/** A shown post or comment: its author, its kind, and whether it is an on-chain subject's text. */
function visibleTarget(targetId: string): { author: string; kind: string; subject: boolean } | null {
  const p = forumPost(targetId)
  if (p) return p.hidden || p.deleted ? null : { author: p.authorAccountId, kind: p.kind, subject: p.kind !== 'discussion' }
  const c = forumComment(targetId)
  return c && !c.hidden && !c.deleted ? { author: c.authorAccountId, kind: c.kind, subject: c.kind === 'update' } : null
}

// ---- reports (user_forum_reports, private) ----
//
// Anyone who may comment can report; a report always reaches the moderators' queue.
// Hiding an item WITHOUT a moderator takes more: AUTO_HIDE_REPORTS distinct reporters
// who each, read fresh at that moment (never from the gate's cache), hold an on-chain
// identity, or at least AUTO_HIDE_HDX and an account first seen on chain at least
// AUTO_HIDE_MIN_AGE_DAYS ago. And it never applies to a referendum's description or
// its proposer's Updates (those only queue), nor to an item a moderator has already
// looked at (restored it, or dismissed a report on it): later reports only queue.

const reportId = (reporter: string, target: string) => createHash('sha256').update(`${reporter}\u0000${target}`).digest('hex').slice(0, 32)

export async function fileReport(ctx: WriteContext, input: { targetId?: unknown; reason?: unknown; note?: unknown }): Promise<{ ok: true; autoHidden: boolean }> {
  requireReady()
  if (typeof input.targetId !== 'string' || !visibleTarget(input.targetId)) throw new ForumWriteError(404, 'There is nothing to report here.', 'not-found')
  if (typeof input.reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(input.reason)) throw new ForumWriteError(400, `Pick a reason: ${REPORT_REASONS.join(', ')}.`, 'invalid')
  const noteTooLong = () => new ForumWriteError(422, `The note is limited to ${LIMITS.reportNoteChars} characters.`, 'too-long')
  if (input.note != null && (typeof input.note !== 'string' || rawTooLong(input.note, LIMITS.reportNoteChars))) throw noteTooLong()
  await requireStanding(ctx, 'comment')
  const targetId = input.targetId
  const id = reportId(ctx.accountId, targetId)
  return limited(takeLimit('report', ctx.accountId, ctx.ip), async () => {
    const note = typeof input.note === 'string' ? cleanBody(input.note) : ''
    if (note.length > LIMITS.reportNoteChars) throw noteTooLong()
    const res = await client.query({
      query: `SELECT status, toString(created_at) AS created_at FROM price_data.user_forum_reports FINAL WHERE report_id = {id:String} AND deleted = 0 LIMIT 1`,
      query_params: { id }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    const existing = (await res.json<{ status: string; created_at: string }>())[0]
    // A report a moderator already decided stays decided: filing it again neither
    // reopens it nor counts it again.
    if (existing && existing.status !== 'open') return { ok: true as const, autoHidden: false }
    const now = Date.now()
    await insert('user_forum_reports', [{
      report_id: id, reporter_account_id: ctx.accountId, target_id: targetId, reason: input.reason,
      note, status: 'open', deleted: 0, created_at: existing ? existing.created_at : ts(now).slice(0, 19), updated_at: ts(now),
    }])
    return { ok: true as const, autoHidden: await maybeAutoHide(targetId) }
  })
}

/** Whether a reporter's report counts toward an automatic hide — read fresh, never from the gate's cache. */
export async function autoHideEligible(accountId: string): Promise<boolean> {
  const facts = await gateFacts(accountId, true)
  if (facts.identity) return true
  const ageDays = facts.firstSeenMs ? (Date.now() - facts.firstSeenMs) / 86_400_000 : 0
  return facts.hdx >= AUTO_HIDE_HDX && ageDays >= AUTO_HIDE_MIN_AGE_DAYS && !(await mutedUntil(accountId))
}

async function reportRows(targetId: string): Promise<Array<{ r: string; status: string }>> {
  const res = await client.query({
    query: `SELECT reporter_account_id AS r, status FROM price_data.user_forum_reports FINAL
            WHERE target_id = {t:String} AND deleted = 0 LIMIT 200`,
    query_params: { t: targetId }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  return res.json<{ r: string; status: string }>()
}

/** Whether reports alone may still hide an item: not hidden, never decided by a moderator, no report on it decided. */
async function autoHideOpen(targetId: string, stored: { hidden: number; moderated: number }): Promise<boolean> {
  if (stored.hidden || stored.moderated) return false
  // A moderator looked at this item (a report on it was dismissed or resolved): reports only queue now.
  return !(await reportRows(targetId)).some(x => x.status !== 'open')
}

/** Hides an item once AUTO_HIDE_REPORTS distinct eligible accounts report it, until a moderator decides. */
async function maybeAutoHide(targetId: string): Promise<boolean> {
  const target = visibleTarget(targetId)
  if (!target || target.subject) return false
  const stored = forumPost(targetId) ? await loadPost(targetId) : await loadComment(targetId)
  if (!stored || stored.hidden || stored.moderated) return false
  const rows = await reportRows(targetId)
  if (rows.some(x => x.status !== 'open')) return false
  const reporters = [...new Set(rows.map(x => x.r))]
  if (reporters.length < AUTO_HIDE_REPORTS) return false
  let eligible = 0
  for (const r of reporters.slice(0, 50)) {
    if (await autoHideEligible(r)) eligible++
    if (eligible >= AUTO_HIDE_REPORTS) break
  }
  if (eligible < AUTO_HIDE_REPORTS) return false
  // A moderator may have decided while the reporters were read: the hide re-reads the
  // item and its reports inside the item's serialized write, and yields to that decision.
  return (await moderate(AUTO_MODERATOR, targetId, 'hide', 'reported', stored => autoHideOpen(targetId, stored))) != null
}

// ---- import probes (the sync's guard refusals → the moderators' queue) ----
//
// The Subsquare import fetches the images imported text references, through an SSRF
// guard (src/governance/subsquare/safeFetch.ts) that refuses a non-https scheme, an IP
// literal, a port other than 443 and a name resolving to a non-public address, and
// records the refusal in forum_media_urls. Honest text almost never trips those; a post
// that does is likely probing the importer. Every visible post or comment that
// references such a URL gets ONE report from the import guard — the reasons and URLs in
// its note — so it reaches the moderators' queue. It only queues: hiding stays a
// moderator's decision, and a decided report is never reopened.

/** forum_media_urls reasons that mean the guard refused the address itself (not a dead or oversized image). */
export const PROBE_FETCH_REASONS = ['fetch:scheme', 'fetch:ip-literal', 'fetch:port', 'fetch:private-address'] as const
/** The reporter an import-guard report is filed under (never an account; the queue names it). */
export const PROBE_REPORTER = 'system:import-guard'
const PROBE_EVERY_MS = 10 * 60_000
const PROBE_NEEDLES_PER_QUERY = 200

/** Files the import guard's report on every visible item that references a refused address; returns how many it filed. */
export async function flagImportProbes(): Promise<number> {
  requireReady()
  const res = await client.query({
    query: `SELECT original_url AS u, reason AS r FROM price_data.forum_media_urls FINAL
            WHERE status = 'failed' AND reason IN {reasons:Array(String)} LIMIT 2000`,
    query_params: { reasons: [...PROBE_FETCH_REASONS] }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const refused = new Map((await res.json<{ u: string; r: string }>()).filter(x => x.u).map(x => [x.u, x.r]))
  if (refused.size === 0) return 0
  const urls = [...refused.keys()]
  const hits = new Map<string, string[]>()
  for (let i = 0; i < urls.length; i += PROBE_NEEDLES_PER_QUERY) {
    const needles = urls.slice(i, i + PROBE_NEEDLES_PER_QUERY)
    for (const [table, idCol] of [['forum_posts', 'post_id'], ['forum_comments', 'comment_id']] as const) {
      const r = await client.query({
        query: `SELECT ${idCol}, body FROM price_data.${table} FINAL
                WHERE hidden = 0 AND deleted = 0 AND multiSearchAny(body, {n:Array(String)}) LIMIT 1000`,
        query_params: { n: needles }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
      })
      for (const row of await r.json<Record<string, unknown>>()) {
        const id = String(row[idCol] ?? ''), body = row.body
        const found = needles.filter(u => typeof body === 'string' && body.includes(u))
        if (id && found.length) hits.set(id, [...(hits.get(id) ?? []), ...found])
      }
    }
  }
  let filed = 0
  for (const [targetId, found] of hits) {
    if (!visibleTarget(targetId)) continue
    const id = reportId(PROBE_REPORTER, targetId)
    const existing = await client.query({
      query: `SELECT status FROM price_data.user_forum_reports FINAL WHERE report_id = {id:String} AND deleted = 0 LIMIT 1`,
      query_params: { id }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    if ((await existing.json<{ status: string }>()).length) continue
    const list = [...new Set(found)].map(u => `${u} (${(refused.get(u) ?? '').replace(/^fetch:/, '')})`).join(', ')
    let note = `Images aimed at internal addresses, refused by the import guard: ${list}`
    if (note.length > LIMITS.reportNoteChars) note = `${note.slice(0, LIMITS.reportNoteChars - 1)}…`
    const now = Date.now()
    await insert('user_forum_reports', [{
      report_id: id, reporter_account_id: PROBE_REPORTER, target_id: targetId, reason: 'other',
      note, status: 'open', deleted: 0, created_at: ts(now).slice(0, 19), updated_at: ts(now),
    }])
    filed++
  }
  if (filed) console.log(`[forum] import guard: ${filed} item(s) referencing refused addresses queued for moderation`)
  return filed
}

/** Every PROBE_EVERY_MS (the sync's cycle), once the forum store is ready. Never throws. */
export function startImportProbeFlagging(): void {
  const tick = () => { if (forumReady()) void flagImportProbes().catch(err => console.warn('[forum] import-guard flagging failed', err instanceof Error ? err.name : 'error')) }
  setTimeout(tick, 60_000).unref()
  setInterval(tick, PROBE_EVERY_MS).unref()
}

// ---- moderation ----

/**
 * A moderation action on a post or comment: hide or restore (the row's visibility
 * becomes this forum's decision, which the sync keeps), lock or unlock a thread, or
 * purge — erase the text and every revision for good (illegal content), unpinning
 * images only that item used. Every action is logged publicly in forum_moderation_log.
 */
export async function applyModeration(moderator: string, targetId: string, action: ModAction, reasonCode: string): Promise<{ generation: string }> {
  return (await moderate(moderator, targetId, action, reasonCode, null))!
}

/** The moderator an automatic hide (enough eligible reports) is logged under. */
const AUTO_MODERATOR = 'reports'

/**
 * applyModeration, optionally conditional: `onlyIf` sees the item as read inside its
 * serialized write, so no other moderation action on it can interleave; null when it
 * declines (nothing written).
 */
async function moderate(moderator: string, targetId: string, action: ModAction, reasonCode: string,
  onlyIf: ((stored: { hidden: number; moderated: number }) => Promise<boolean>) | null): Promise<{ generation: string } | null> {
  requireReady()
  return serialized(targetId, async () => {
    const now = Date.now()
    let generation: string
    let erasedBody = ''
    let erasedBanner = ''
    if (forumPost(targetId)) {
      const stored = await loadPost(targetId)
      if (!stored) throw new ForumWriteError(404, 'No such item.', 'not-found')
      if (onlyIf && !(await onlyIf(stored))) return null
      if (stored.hidden_reason === PURGED && action !== 'lock-thread' && action !== 'unlock-thread') throw new ForumWriteError(409, 'This was purged; there is nothing left to change.', 'purged')
      const next: PostRow = { ...stored, updated_at: ts(now) }
      if (action === 'purge') {
        erasedBody = stored.body
        erasedBanner = stored.banner_cid ?? ''
        Object.assign(next, { title: '', body: '', tldr: '', banner_cid: '', hidden: 1, hidden_reason: PURGED, moderated: 1, authority: 'native' })
      } else if (action === 'hide' || action === 'restore') {
        if (stored.deleted) throw new ForumWriteError(409, 'Its author deleted it; there is nothing to show.', 'deleted')
        Object.assign(next, { hidden: action === 'hide' ? 1 : 0, hidden_reason: action === 'hide' ? reasonCode : '', moderated: 1 })
      } else next.locked = action === 'lock-thread' ? 1 : 0
      await logAction(targetId, action, reasonCode, moderator, now)
      await insert('forum_posts', [next])
      if (action === 'purge') { await eraseOldPostVersions(targetId); await purgeRevisions(targetId) }
      generation = applyLocalPost(postMeta(next))
    } else if (forumComment(targetId)) {
      if (action === 'lock-thread' || action === 'unlock-thread') throw new ForumWriteError(422, 'Lock the thread from its post.', 'invalid')
      const stored = await loadComment(targetId)
      if (!stored) throw new ForumWriteError(404, 'No such item.', 'not-found')
      if (onlyIf && !(await onlyIf(stored))) return null
      if (stored.hidden_reason === PURGED) throw new ForumWriteError(409, 'This was purged; there is nothing left to change.', 'purged')
      if (stored.deleted && action !== 'purge') throw new ForumWriteError(409, 'Its author deleted it; there is nothing to show.', 'deleted')
      const next: StoredComment = action === 'purge'
        ? { ...stored, body: '', hidden: 1, hidden_reason: PURGED, moderated: 1, authority: 'native', updated_at: ts(now) }
        : { ...stored, hidden: action === 'hide' ? 1 : 0, hidden_reason: action === 'hide' ? reasonCode : '', moderated: 1, updated_at: ts(now) }
      if (action === 'purge') erasedBody = stored.body
      await logAction(targetId, action, reasonCode, moderator, now)
      await insert('forum_comments', [next])
      if (action === 'purge') { await eraseOldCommentVersions(stored.thread_key, targetId); await purgeRevisions(targetId) }
      generation = applyLocalComment(commentMeta(next))
    } else throw new ForumWriteError(404, 'No such item.', 'not-found')
    if (action === 'purge') await unpinImagesOnlyIn(erasedBody, erasedBanner, moderator)
    if (action === 'hide' || action === 'restore' || action === 'purge') await closeReports(targetId, action === 'restore' ? 'dismissed' : 'resolved', moderator === AUTO_MODERATOR)
    return { generation }
  })
}

/**
 * The CIDs a body's images resolve to: literal `/ipfs/<cid>` paths (an upload here) and
 * imported image URLs through the sync's re-hosting map (forum_media_urls) — the same
 * resolution the renderer uses, so a purge finds every image the item showed.
 */
export function imageCidsOf(body: string, urlMap: ReadonlyMap<string, string>, banner = ''): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/\/ipfs\/([A-Za-z0-9]{46,121})/g)) out.add(m[1])
  for (const url of imageUrlsIn(body)) { const cid = urlMap.get(url); if (cid) out.add(cid) }
  if (banner) out.add(urlMap.get(`https://subsquare.infura-ipfs.io/ipfs/${banner}`) ?? banner)
  return [...out]
}

/** After a purge: the images the purged item showed (body and banner) that no visible item references are removed like a moderator's media removal. */
async function unpinImagesOnlyIn(body: string, banner: string, moderator: string): Promise<void> {
  const cids = imageCidsOf(body, forumMediaUrlMap(), banner)
  if (!cids.length) return
  const { invalidateVisibleReferencedCids, referencedCids, removeMedia } = await import('./forumMedia.ts')
  const still = await referencedCids({ visibleOnly: true })
  for (const cid of cids) {
    if (still.has(cid)) continue
    try { await removeMedia(moderator, cid, 'illegal') } catch { /* not a forum image, or already removed */ }
  }
  invalidateVisibleReferencedCids()
}

/** Marks a target's open reports decided (a moderator's hide or purge resolves them, a restore dismisses them). */
async function closeReports(targetId: string, status: 'resolved' | 'dismissed', automatic: boolean): Promise<void> {
  if (automatic) return // an automatic hide waits for a moderator: the reports stay open
  await client.command({
    query: `INSERT INTO price_data.user_forum_reports (report_id, reporter_account_id, target_id, reason, note, status, deleted, created_at, updated_at)
            SELECT report_id, reporter_account_id, target_id, reason, note, {s:String}, deleted, created_at, now64(3)
            FROM price_data.user_forum_reports FINAL WHERE target_id = {t:String} AND status = 'open' AND deleted = 0`,
    query_params: { s: status, t: targetId }, clickhouse_settings: WRITE_SETTINGS,
  })
}

export async function setReportStatus(reportIdIn: string, status: 'resolved' | 'dismissed'): Promise<boolean> {
  const res = await client.query({
    query: `SELECT target_id FROM price_data.user_forum_reports FINAL WHERE report_id = {id:String} AND deleted = 0 LIMIT 1`,
    query_params: { id: reportIdIn }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const target = (await res.json<{ target_id: string }>())[0]?.target_id
  if (target == null) return false
  // In the target's serialized write, like every moderation decision on it, so an
  // automatic hide in flight sees this decision before it writes.
  await serialized(target, () => client.command({
    query: `INSERT INTO price_data.user_forum_reports (report_id, reporter_account_id, target_id, reason, note, status, deleted, created_at, updated_at)
            SELECT report_id, reporter_account_id, target_id, reason, note, {s:String}, deleted, created_at, now64(3)
            FROM price_data.user_forum_reports FINAL WHERE report_id = {id:String}`,
    query_params: { s: status, id: reportIdIn }, clickhouse_settings: WRITE_SETTINGS,
  }))
  return true
}

/** Mutes an account until a date (null lifts it). Private: user_forum_sanctions. */
export async function setMute(moderator: string, accountId: string, untilMs: number | null, reason: string): Promise<void> {
  const now = Date.now()
  await insert('user_forum_sanctions', [{
    account_id: accountId, kind: 'mute', until: ts(untilMs ?? now).slice(0, 19), reason: reason.slice(0, 500),
    moderator_account_id: moderator, deleted: untilMs == null ? 1 : 0, created_at: ts(now).slice(0, 19), updated_at: ts(now),
  }])
  await loadMutes(true)
}

// ---- the moderator queue ----

export interface QueueItem {
  targetId: string
  kind: 'post' | 'comment'
  threadKey: string
  title: string | null
  /** The full text, for the moderator's decision (hidden items included). */
  body: string
  bodyFormat: string
  author: string
  createdAt: string
  hidden: boolean
  hiddenReason: string
  moderated: boolean
  /** A referendum's description or a proposer's Update: reports on it only queue. */
  subject: boolean
  reports: Array<{ reportId: string; reporter: string; reason: string; note: string; at: string }>
}

/** The stored rows of many items, in two bounded reads (posts by key, comments by (thread, id)). */
async function itemsFor(ids: string[]): Promise<Map<string, QueueItem>> {
  const out = new Map<string, QueueItem>()
  const postIds = ids.filter(id => forumPost(id))
  const commentPairs = ids.map(id => forumComment(id)).filter((c): c is ForumCommentMeta => !!c && !forumPost(c.commentId))
  const iso = (v: string) => new Date(msOf(v)).toISOString()
  if (postIds.length) {
    const res = await client.query({
      query: `SELECT ${POST_COLS.join(', ')} FROM price_data.forum_posts FINAL WHERE post_id IN {ids:Array(String)}`,
      query_params: { ids: postIds }, format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    for (const p of await res.json<PostRow>()) {
      out.set(p.post_id, { targetId: p.post_id, kind: 'post', threadKey: p.post_id, title: p.title || null, body: p.body, bodyFormat: p.body_format, author: p.author_account_id, createdAt: iso(p.created_at), hidden: Number(p.hidden) === 1, hiddenReason: p.hidden_reason, moderated: Number(p.moderated) === 1, subject: p.kind !== 'discussion', reports: [] })
    }
  }
  if (commentPairs.length) {
    const res = await client.query({
      query: `SELECT ${COMMENT_COLS.join(', ')} FROM price_data.forum_comments FINAL
              WHERE thread_key IN {ks:Array(String)} AND comment_id IN {ids:Array(String)}`,
      query_params: { ks: [...new Set(commentPairs.map(c => c.threadKey))], ids: commentPairs.map(c => c.commentId) },
      format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
    })
    for (const c of await res.json<StoredComment>()) {
      out.set(c.comment_id, { targetId: c.comment_id, kind: 'comment', threadKey: c.thread_key, title: forumPost(c.thread_key)?.title || null, body: c.body, bodyFormat: c.body_format, author: c.author_account_id, createdAt: iso(c.created_at), hidden: Number(c.hidden) === 1, hiddenReason: c.hidden_reason, moderated: Number(c.moderated) === 1, subject: c.kind === 'update', reports: [] })
    }
  }
  return out
}

/** Open reports grouped by target (with the reported text), and the last two days' native writing. */
export async function moderationQueue(): Promise<{ reported: QueueItem[]; recent: QueueItem[] }> {
  const res = await client.query({
    query: `SELECT report_id, reporter_account_id, target_id, reason, note, toString(updated_at) AS at FROM price_data.user_forum_reports FINAL
            WHERE status = 'open' AND deleted = 0 ORDER BY updated_at DESC LIMIT 500`,
    format: 'JSONEachRow', clickhouse_settings: READ_SETTINGS,
  })
  const byTarget = new Map<string, QueueItem['reports']>()
  for (const r of await res.json<{ report_id: string; reporter_account_id: string; target_id: string; reason: string; note: string; at: string }>()) {
    const list = byTarget.get(r.target_id) ?? []
    list.push({ reportId: r.report_id, reporter: r.reporter_account_id, reason: r.reason, note: r.note, at: new Date(msOf(r.at)).toISOString() })
    byTarget.set(r.target_id, list)
  }
  const since = Date.now() - 2 * 86_400_000
  const recentIds: string[] = []
  for (const p of forumPosts()) if (p.kind === 'discussion' && p.source === '' && p.createdAt > since && !p.deleted) recentIds.push(p.postId)
  for (const c of forumComments()) if (c.commentId.startsWith('c') && c.createdAt > since && !c.deleted) recentIds.push(c.commentId)
  const items = await itemsFor([...byTarget.keys(), ...recentIds.slice(-100)])
  const reported = [...byTarget].flatMap(([id, reports]) => { const i = items.get(id); return i ? [{ ...i, reports }] : [] })
  const recent = recentIds.slice(-100).flatMap(id => { const i = items.get(id); return i ? [{ ...i, reports: [] }] : [] })
  recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { reported, recent }
}
