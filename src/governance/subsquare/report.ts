import type { ClickHouseClient } from '../../db/client.js'
import { authorKey } from './authors.js'
import type { KuboClient } from './kubo.js'
import { COLLECTIONS, SUMMARY_KEY, type SsComment } from './parse.js'
import { flattenThread, imageUrlsIn } from './rows.js'
import type { CycleResult } from './sync.js'

// The validation report (spec §5.5) for a full import: Subsquare's totals against what
// was read and stored, per-thread comment counts against commentsCount, 20 threads
// compared field by field with the stored rows, author resolution, Subsquare's own
// moderation flags, and the image re-hosting outcome. Text bodies never appear in it.

export async function buildReport(result: CycleResult, ch: ClickHouseClient, opts: { dryRun: boolean; sampleSize?: number }) {
  const src = result.source!
  const collections = COLLECTIONS.map(c => {
    const list = src.lists.get(c)!
    const subjects = c === 'discussions'
      ? [...src.detailOutcome.keys()].filter(s => /^s\d+$/.test(s))
      : list.items.map(i => i.subject)
    const outcome = (o: string) => subjects.filter(s => src.detailOutcome.get(s) === o).length
    return {
      collection: c,
      summaryAll: src.summary[SUMMARY_KEY[c]] ?? null,
      listTotal: list.total,
      listed: list.items.length,
      detailsFetched: outcome('fetched'), detailsSkippedUnchanged: outcome('skipped'), detailsGone: outcome('gone'), detailsInvalid: outcome('invalid'),
    }
  })

  const discussions = [...src.items.values()].filter(i => i.collection === 'discussions')
  const discussionStats = {
    summaryAll: src.summary.discussions ?? null,
    listed: src.lists.get('discussions')!.total,
    ...src.uidProbe,
    notFound: src.uidProbe.notFound.length,
    notFoundUids: src.uidProbe.notFound,
    hide: discussions.filter(d => d.hide && !d.isMalicious).length,
    isMalicious: discussions.filter(d => d.isMalicious).length,
    sima: discussions.filter(d => d.dataSource === 'sima').length,
    polls: discussions.filter(d => d.poll).length,
    html: discussions.filter(d => d.contentType === 'html').length,
  }

  // Comments, as read: unique per thread (threads are read once per merged group).
  const all: SsComment[] = []
  const byOwnerType: Record<string, number> = {}
  const mismatches: Array<{ owner: string; members: string[]; commentsCount: number[]; read: number; ok: boolean }> = []
  let threadsChecked = 0
  for (const [rootPostId, t] of src.threads) {
    const g = src.groups.get(rootPostId)!
    let n = 0
    for (const c of t.comments) { all.push(c); n++; for (const r of c.replies) { all.push(r); n++ } }
    threadsChecked++
    const counts = g.members.map(m => m.commentsCount)
    if (!counts.every(x => x === n) || !t.ok) mismatches.push({ owner: g.owner, members: g.members.map(m => m.subject), commentsCount: counts, read: n, ok: t.ok })
  }
  const unique = new Map(all.map(c => [c.id, c]))
  for (const c of unique.values()) byOwnerType[c.ownerType] = (byOwnerType[c.ownerType] ?? 0) + 1
  const replyIds = new Set<string>()
  for (const t of src.threads.values()) for (const c of t.comments) for (const r of c.replies) replyIds.add(r.id)

  // Authors: every item and comment key resolves (or is a legacy name).
  const authorStats = { resolved: 0, legacy: 0, failed: {} as Record<string, number> }
  const tally = (k: ReturnType<typeof authorKey>) => {
    if (!k.ok) authorStats.failed[k.reason] = (authorStats.failed[k.reason] ?? 0) + 1
    else if (k.accountId) authorStats.resolved++
    else authorStats.legacy++
  }
  for (const it of src.items.values()) tally(authorKey(it.author, it.proposer))
  for (const c of unique.values()) tally(authorKey(c.author, c.proposer))

  // Images referenced by bodies.
  const urls = new Set<string>()
  for (const it of src.items.values()) for (const u of imageUrlsIn(it.content)) urls.add(u)
  for (const c of unique.values()) for (const u of imageUrlsIn(c.content)) urls.add(u)
  const hosts: Record<string, number> = {}
  for (const u of urls) { const h = new URL(u).hostname; hosts[h] = (hosts[h] ?? 0) + 1 }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    requests: result.requests,
    fetched: result.fetched,
    planned: result.stats,
    written: result.written,
    collections,
    discussions: discussionStats,
    comments: {
      threadsRead: src.threads.size,
      threadsNotWhole: [...src.threads.values()].filter(t => !t.ok).length,
      unique: unique.size,
      replies: [...unique.keys()].filter(id => replyIds.has(id)).length,
      readTotalWithDuplicates: all.length,
      byOwnerType,
      html: [...unique.values()].filter(c => c.contentType === 'html').length,
      sima: [...unique.values()].filter(c => c.cid).length,
      withoutAddress: [...unique.values()].filter(c => !c.author?.address && !c.author?.publicKey && !c.proposer).length,
    },
    threadCounts: { checked: threadsChecked, matching: threadsChecked - mismatches.length, mismatches },
    authors: authorStats,
    images: { urls: urls.size, hosts, rehost: result.images },
    warnings: result.warnings,
  }

  if (!opts.dryRun) report.stored = await storedCounts(ch)
  report.samples = opts.dryRun ? 'skipped in a dry run (nothing stored to compare)' : await compareSamples(result, ch, opts.sampleSize ?? 20)
  return report
}

async function q<T>(ch: ClickHouseClient, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  return (await ch.query({ query, query_params: params, format: 'JSONEachRow' })).json<T>()
}

async function storedCounts(ch: ClickHouseClient) {
  return {
    postsByKind: await q(ch, `SELECT kind, count() AS n, countIf(hidden = 1) AS hidden, countIf(hidden_reason = 'spam') AS spam, countIf(title = '' AND body = '') AS empty_text FROM price_data.forum_posts FINAL GROUP BY kind ORDER BY kind`),
    comments: (await q(ch, `SELECT count() AS n, countIf(parent_id != '') AS replies, countIf(kind = 'update') AS updates, uniqExact(thread_key) AS threads, countIf(author_account_id = '') AS legacy FROM price_data.forum_comments FINAL`))[0],
    revisions: (await q(ch, `SELECT count() AS n FROM price_data.forum_revisions FINAL`))[0],
    moderationLog: await q(ch, `SELECT action, reason_code, count() AS n FROM price_data.forum_moderation_log FINAL GROUP BY action, reason_code`),
    media: await q(ch, `SELECT origin, count() AS n FROM price_data.forum_media FINAL WHERE deleted = 0 GROUP BY origin`),
    mediaUrls: await q(ch, `SELECT status, reason, count() AS n FROM price_data.forum_media_urls FINAL GROUP BY status, reason ORDER BY n DESC`),
  }
}

/** 20 threads compared field by field with what was stored. */
async function compareSamples(result: CycleResult, ch: ClickHouseClient, size: number) {
  const src = result.source!
  const withComments = [...src.threads.entries()].filter(([, t]) => t.comments.length).sort(([a], [b]) => a.localeCompare(b))
  const step = Math.max(1, Math.floor(withComments.length / size))
  const picks = withComments.filter((_, i) => i % step === 0).slice(0, size)
  const out: Array<{ owner: string; comments: number; ok: boolean; diffs: string[] }> = []
  // The sync's own routing: a comment files under the subject its owner field names.
  const discussionById = new Map([...src.items.values()].filter(i => i.collection === 'discussions').map(i => [i.sourceId, i.subject]))
  for (const [rootPostId, t] of picks) {
    const g = src.groups.get(rootPostId)!
    const expected = flattenThread(c => src.groups.get(c.ownerId)?.owner ?? (c.ownerType === 'post' ? discussionById.get(c.ownerId) : undefined) ?? g.owner, t.comments, () => {})
    const keys = [...new Set(expected.map(e => e.row.thread_key))]
    const stored = await q<{ comment_id: string; parent_id: string; reply_to_id: string; author_account_id: string; author_legacy_name: string; created_ms: string; body_sha: string }>(ch,
      `SELECT comment_id, parent_id, reply_to_id, author_account_id, author_legacy_name, toUnixTimestamp64Milli(created_at) AS created_ms,
              hex(SHA256(body)) AS body_sha
       FROM price_data.forum_comments FINAL WHERE thread_key IN {k:Array(String)}`, { k: keys.length ? keys : [g.owner] })
    const wanted = new Set(expected.map(e => e.row.comment_id))
    const byId = new Map(stored.filter(s => wanted.has(s.comment_id)).map(s => [s.comment_id, s]))
    const diffs: string[] = []
    for (const { row, source } of expected) {
      const s = byId.get(row.comment_id)
      if (!s) { diffs.push(`${row.comment_id}: missing`); continue }
      if (s.parent_id !== row.parent_id) diffs.push(`${row.comment_id}: parent`)
      if (s.reply_to_id !== row.reply_to_id) diffs.push(`${row.comment_id}: replyTo`)
      if (s.author_account_id !== row.author_account_id || s.author_legacy_name !== row.author_legacy_name) diffs.push(`${row.comment_id}: author`)
      if (Number(s.created_ms) !== source.createdAt) diffs.push(`${row.comment_id}: createdAt`)
      const { createHash } = await import('node:crypto')
      if (s.body_sha.toLowerCase() !== createHash('sha256').update(source.content).digest('hex')) diffs.push(`${row.comment_id}: body`)
    }
    if (byId.size !== expected.length) diffs.push(`stored ${byId.size} vs source ${expected.length}`)
    out.push({ owner: g.owner, comments: expected.length, ok: diffs.length === 0, diffs: diffs.slice(0, 10) })
  }
  return { compared: out.length, allMatch: out.every(s => s.ok), threads: out }
}

/** Every pinned image re-hashes to its CID: the bytes read back, hashed again with the parameters it was added with. */
export async function verifyMedia(ch: ClickHouseClient, kubo: KuboClient) {
  const rows = await q<{ cid: string; sha256: string; origin: string; bytes: string }>(ch, `SELECT cid, sha256, origin, toString(bytes) AS bytes FROM price_data.forum_media FINAL WHERE deleted = 0`)
  const { createHash } = await import('node:crypto')
  const out = { total: rows.length, rehashMatches: 0, sha256Matches: 0, failures: [] as Array<{ cid: string; origin: string; problem: string }> }
  for (const r of rows) {
    try {
      const bytes = await kubo.cat(r.cid, 6 * 1024 * 1024)
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha === r.sha256) out.sha256Matches++
      else out.failures.push({ cid: r.cid, origin: r.origin, problem: 'sha256' })
      const again = await kubo.add(bytes, { onlyHash: true, cidVersion: r.cid.startsWith('Qm') ? 0 : 1 })
      if (again === r.cid) out.rehashMatches++
      else out.failures.push({ cid: r.cid, origin: r.origin, problem: `rehash ${again}` })
    } catch (err) {
      out.failures.push({ cid: r.cid, origin: r.origin, problem: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
