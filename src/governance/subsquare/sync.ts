import type { ClickHouseClient } from '../../db/client.js'
import type { SubsquareClient } from './client.js'
import { linkOptions, motionIdsOf, planWrites, type DiffStats, type SourceView } from './diff.js'
import {
  COLLECTIONS, fetchDetail, fetchDiscussionByUid, fetchPollVotes, fetchReferendumAppendants, fetchSummary, fetchThread,
  listAll, newestOverviewUid, parseInlineAppendants, warn, type Detail, type ListResult, type ThreadResult, type Warnings,
} from './fetchSource.js'
import { rehostImage, spacedQueue, urlDue } from './images.js'
import type { KuboClient } from './kubo.js'
import { planNormalisation, type NormaliseMemo, type NormaliseStats } from './normalise.js'
import { voterActor } from './authors.js'
import type { CollectionName, SsItem, SsPollVotes } from './parse.js'
import { boundLinks, buildGroups, contentHashOf, type BuildContext, type Group } from './rows.js'
import { ImageBudget, STOPS_THE_PASS, imageCandidates } from './imagePlan.js'
import {
  batchSize, dropRacedRows, emptyBatch, isCidRemoved, loadForumState, loadFullComments, loadFullPosts, loadRevisionsToNormalise, loadSyncMediaToday, loadUpdatedMs, recheckTargets,
  writeBatch, type ForumState, type StoredPost, type WriteBatch,
} from './store.js'

// The Subsquare → forum sync (spec: a resumable one-time full import, then a batch
// every few minutes). The user's explicit exception to the per-block preference: this
// source is not the chain, so it arrives in batches.
//
// A cycle:
//   1. list pass — every collection's list, every page (about twenty requests): an
//      item whose comment count, activity or text differs from the stored row is read
//      in full, so a new comment on ANY item, however old, arrives within a cycle;
//   2. new discussions — /posts/<uid> probed past the newest known uid (the list hides
//      SIMA and Subsquare-hidden posts; /overview/discussions names the newest);
//   3. rotation — the stored items whose bucket (a hash of the id, sweepBucket) is
//      this cycle's slot of the day (sweepSlot): every item is re-read once per
//      SUBSQUARE_SWEEP_HOURS from the clock alone, so a restart never starves it. It
//      is what catches comment edits, hiding and removal, none of which show
//      in a list;
//   4. diff, then the normalisation pass over stored imported text (normalise.ts),
//      and write (only rows whose fingerprint or text changed), then image re-hosting.


/** The image pass's default wall-time budget per cycle. */
export const IMAGE_BUDGET_MS = 120_000

export const NEW_UID_LOOKAHEAD = 5
/** Slots a late cycle catches up on at most (a cycle that overran its slot, a short outage). */
export const MAX_SLOT_CATCHUP = 6

/** Cycles in one rotation window: every stored item is re-read once per window. */
export function slotsPerWindow(cycleMinutes: number, sweepHours: number): number {
  return Math.max(1, Math.floor((sweepHours * 60) / Math.max(1, cycleMinutes)))
}

/** The rotation tick a clock time falls in: a cycle-length tick of the wall clock (its slot is the tick modulo the window). */
export function sweepSlot(nowMs: number, cycleMinutes: number): number {
  return Math.floor(nowMs / (Math.max(1, cycleMinutes) * 60_000))
}

/** An item's fixed slot in the rotation: FNV-1a of its id, modulo the window. */
export function sweepBucket(id: string, slots: number): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h % slots
}

/**
 * The stored items this cycle re-reads: those whose bucket is a slot from just after
 * the last slot this process swept up to the current one (only the current one after
 * a restart, at most MAX_SLOT_CATCHUP), so a cycle that overruns its slot skips none.
 */
export function rotationDue(ids: Iterable<string>, tick: number, lastTick: number | null, slots: number): string[] {
  const from = lastTick == null || tick - lastTick > MAX_SLOT_CATCHUP || tick <= lastTick ? tick : lastTick + 1
  const due = new Set<number>()
  for (let t = from; t <= tick; t++) due.add(((t % slots) + slots) % slots)
  return [...ids].filter(id => due.has(sweepBucket(id, slots)))
}

/**
 * A poll as stored (`poll_json`): its question, options, close time and visibility,
 * and once it has closed its results — `votes` (option → count) and, for a public
 * poll, `voters` (option → each voter's account id, or `legacy:<username>` for an
 * address-less Subsquare account).
 */
export function pollJsonOf(poll: NonNullable<SsItem['poll']>, votes: SsPollVotes | null): string {
  const base = { title: poll.title, options: poll.options, expiresTime: poll.expiresTime, anonymous: poll.anonymous }
  if (!votes) return JSON.stringify(base)
  const voters = votes.voters && !poll.anonymous
    ? Object.fromEntries(Object.entries(votes.voters).map(([option, list]) => [option, list.map(voterActor).filter((a): a is string => !!a)]))
    : null
  return JSON.stringify({ ...base, votes: votes.counts, ...(voters ? { voters } : {}) })
}

/** A closed poll whose results are stored in full: never read again. */
export function pollSettled(stored: string): boolean {
  try {
    const p = JSON.parse(stored) as { votes?: unknown; voters?: unknown; anonymous?: boolean }
    return typeof p.votes === 'object' && p.votes != null && (p.anonymous !== false || (typeof p.voters === 'object' && p.voters != null))
  } catch { return false }
}

const unchangedRow = (stored: StoredPost | undefined, item: SsItem) => unchanged(stored, item)

/** A stored row matches a list item's content, comment count and activity: nothing to re-fetch. */
export function unchanged(stored: StoredPost | undefined, item: SsItem): boolean {
  return !!stored && stored.source_activity_ms === item.lastActivityAt && stored.source_comments_count === item.commentsCount
    && stored.source_hash === contentHashOf(item.title + '\u0000' + item.content, item.contentHash)
}

export interface SyncDeps {
  client: SubsquareClient
  ch: ClickHouseClient
  kubo: KuboClient | null
  dryRun: boolean
  images: boolean
  maxImagesPerCycle: number
  /** Wall time the image pass may take per cycle (default IMAGE_BUDGET_MS). */
  imageBudgetMs?: number
  cycleMinutes: number
  sweepHours: number
  /** a full pass re-reads every item even when stored unchanged (the post-import report; a replay must then write nothing) */
  refetchAll?: boolean
  now?: () => number
  log?: (line: string) => void
}

export interface CycleResult {
  mode: 'full' | 'incremental'
  requests: number
  fetched: { listPages: number; details: number; gone: number; invalid: number; threads: number; appendants: number; polls: number; uidProbes: number; head: number; sweep: number }
  stats: DiffStats
  /** stored imported rows and revisions whose links the rewrite changed this cycle (normalise.ts) */
  normalised: NormaliseStats
  written: number
  images: { due: number; pinnedCid: number; rehosted: number; archived: number; failed: number; deferred: number; gc: boolean | null; failures: Record<string, number> }
  warnings: Warnings
  /** what the report needs, for a full import */
  source?: FullSource
  plannedBatch?: WriteBatch
}

export interface FullSource {
  summary: Record<string, number>
  lists: Map<CollectionName, ListResult>
  uidProbe: { maxUid: number; probed: number; found: number; notFound: number[]; unlisted: number }
  items: Map<string, SsItem>
  groups: Map<string, Group>
  threads: Map<string, ThreadResult>
  detailOutcome: Map<string, 'fetched' | 'gone' | 'invalid' | 'skipped'>
}

export class GovernanceSync {
  private inventory = new Map<string, SsItem>()
  /** the last rotation tick swept (sweepSlot), so a late cycle catches up the slots it overran; null after a start */
  private lastTick: number | null = null
  private seqCounter = 0
  /** The Internet Archive's queue: one request at a time, a second apart. */
  private readonly archive = spacedQueue(1_000)
  /** Rows and revisions this process found already normalised (normalise.ts). */
  private readonly normaliseMemo: NormaliseMemo = new Map()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.log(line))
  }

  private ctx(importing: boolean, state: ForumState): BuildContext {
    return {
      now: this.now(),
      importing,
      firstSeen: id => !state.posts.has(id) && !state.comments.has(id),
      nextSeq: () => this.now() * 1000 + (this.seqCounter = (this.seqCounter + 1) % 1000),
    }
  }

  private discussionById(state: ForumState, items: Iterable<SsItem>): Map<string, string> {
    const out = new Map<string, string>()
    for (const p of state.posts.values()) if (p.kind === 'discussion' && p.source_id) out.set(p.source_id, p.post_id)
    for (const it of items) if (it.collection === 'discussions') out.set(it.sourceId, it.subject)
    return out
  }

  private emptyFetched(): CycleResult['fetched'] {
    return { listPages: 0, details: 0, gone: 0, invalid: 0, threads: 0, appendants: 0, polls: 0, uidProbes: 0, head: 0, sweep: 0 }
  }

  /** The one-time import (and a forced re-import): every collection, every uid, every thread — skipping what is stored unchanged. */
  async fullImport(): Promise<CycleResult> {
    const { client } = this.deps
    const w: Warnings = {}
    const startRequests = client.requests
    const state = await loadForumState(this.deps.ch)
    const fetched = this.emptyFetched()
    const unchanged = this.deps.refetchAll ? () => false : unchangedRow
    const summary = await fetchSummary(client)
    const lists = new Map<CollectionName, ListResult>()
    for (const c of COLLECTIONS) lists.set(c, await listAll(client, c, w))
    for (const l of lists.values()) fetched.listPages += l.pages

    const items = new Map<string, SsItem>()     // best version per subject
    const fetchedSubjects = new Set<string>()   // subjects whose detail was read this run
    const gone = new Set<string>()
    const detailOutcome = new Map<string, 'fetched' | 'gone' | 'invalid' | 'skipped'>()
    const take = (subject: string, d: Detail, listItem: SsItem | undefined) => {
      if (d === 'gone') { gone.add(subject); detailOutcome.set(subject, 'gone'); fetched.gone++; return }
      if (d === 'invalid') { warn(w, 'detail-invalid'); detailOutcome.set(subject, 'invalid'); fetched.invalid++; if (listItem) items.set(subject, listItem); return }
      items.set(subject, d); fetchedSubjects.add(subject); detailOutcome.set(subject, 'fetched'); fetched.details++
    }

    // Discussions: the uid sweep reads every uid, listed or not — the list omits every
    // post Subsquare has flagged (hide / isMalicious) and the SIMA ones.
    const listedDiscussions = new Map((lists.get('discussions')?.items ?? []).map(i => [i.uid!, i]))
    const storedUids = [...state.posts.keys()].filter(k => /^s\d+$/.test(k)).map(k => Number(k.slice(1)))
    const overviewUid = await newestOverviewUid(client)
    const maxUid = Math.max(0, overviewUid ?? 0, ...listedDiscussions.keys(), ...storedUids)
    const uidProbe = { maxUid, probed: 0, found: 0, notFound: [] as number[], unlisted: 0 }
    for (let uid = 1, misses = 0; uid <= maxUid || misses < NEW_UID_LOOKAHEAD; uid++) {
      const subject = `s${uid}`
      const listed = listedDiscussions.get(uid)
      const stored = state.posts.get(subject)
      if (listed && unchanged(stored, listed)) { detailOutcome.set(subject, 'skipped'); uidProbe.found++; misses = 0; continue }
      if (!this.deps.refetchAll && !listed && stored?.hidden && !stored.source_removed) { detailOutcome.set(subject, 'skipped'); uidProbe.found++; uidProbe.unlisted++; misses = 0; continue }
      uidProbe.probed++
      fetched.uidProbes++
      const d = await fetchDiscussionByUid(client, uid)
      if (d === 'gone') {
        uidProbe.notFound.push(uid)
        if (uid > maxUid) misses++
        if (stored) take(subject, d, undefined)
        continue
      }
      misses = 0
      uidProbe.found++
      if (!listed) uidProbe.unlisted++
      take(subject, d, listed)
    }

    // On-chain items: the detail carries their full text and flags.
    for (const c of COLLECTIONS) {
      if (c === 'discussions') continue
      for (const it of lists.get(c)!.items) {
        if (unchanged(state.posts.get(it.subject), it)) { detailOutcome.set(it.subject, 'skipped'); continue }
        take(it.subject, await fetchDetail(client, c, it), it)
      }
    }

    // Threads: every merged thread with a comment, read once through any member.
    const all = new Map<string, SsItem>()
    for (const c of COLLECTIONS) for (const it of lists.get(c)!.items) all.set(it.subject, it)
    for (const [s, it] of items) all.set(s, it)
    const discussionById = this.discussionById(state, all.values())
    const groups = buildGroups([...all.values()], discussionById)
    const links = boundLinks(all.values(), discussionById)
    const threads = new Map<string, ThreadResult>()
    for (const g of groups.values()) {
      const commented = g.members.some(m => m.commentsCount > 0)
      if (!commented) continue
      if (g.members.every(m => unchanged(state.posts.get(m.subject), m))) continue
      const via = g.members.find(m => m.subject === g.owner) ?? g.members[0]
      threads.set(g.rootPostId, await fetchThread(client, via, w))
      fetched.threads++
    }

    const appendants = new Map<string, ReturnType<typeof parseInlineAppendants>>()
    for (const subject of fetchedSubjects) {
      const it = items.get(subject)!
      if (it.collection === 'discussions' && it.appendantsRaw?.length) appendants.set(subject, parseInlineAppendants(it.appendantsRaw, w))
      if (it.collection === 'opengov' && it.refs.referendumIndex != null) {
        const list = await fetchReferendumAppendants(client, it.refs.referendumIndex, w)
        fetched.appendants++
        if (list?.length) appendants.set(subject, list)
      }
    }
    const pollJson = await this.pollResults(items, fetchedSubjects, state, fetched, w)

    const view: SourceView = {
      items: new Map([...items].filter(([s]) => fetchedSubjects.has(s))),
      gone, groups, discussionById, links, threads, appendants, pollJson, motionIds: motionIdsOf(all.values()),
    }
    const result = await this.finish('full', view, state, true, w, fetched, startRequests)
    result.source = { summary, lists, uidProbe, items, groups, threads, detailOutcome }
    this.inventory = all
    return result
  }

  /** Expired polls whose results are not stored yet: read once. */
  private async pollResults(items: Map<string, SsItem>, subjects: Iterable<string>, state: ForumState, fetched: CycleResult['fetched'], w: Warnings): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const subject of subjects) {
      const it = items.get(subject)
      if (!it?.poll) continue
      const stored = state.posts.get(subject)?.poll_json ?? ''
      const expired = it.poll.expiresTime != null && it.poll.expiresTime < this.now()
      if (pollSettled(stored)) { out.set(subject, stored); continue }
      if (!expired) { out.set(subject, pollJsonOf(it.poll, null)); continue }
      const votes = await fetchPollVotes(this.deps.client, it.poll.id)
      fetched.polls++
      if (!votes) warn(w, 'poll-votes')
      out.set(subject, pollJsonOf(it.poll, votes))
    }
    return out
  }

  /** One batch cycle: list pass, new-uid probe, rotation. */
  async incremental(): Promise<CycleResult> {
    const { client } = this.deps
    const w: Warnings = {}
    const startRequests = client.requests
    const state = await loadForumState(this.deps.ch)
    const fetched = this.emptyFetched()
    const refetch = new Map<string, SsItem | { subject: string; uid: number }>()

    // Every list in full: the thread model (which items share a thread) and every
    // item's comment count and activity, read fresh each cycle.
    for (const c of COLLECTIONS) {
      const list = await listAll(client, c, w)
      fetched.listPages += list.pages
      for (const it of list.items) {
        this.inventory.set(it.subject, it)
        if (!unchanged(state.posts.get(it.subject), it)) { refetch.set(it.subject, it); fetched.head++ }
      }
    }

    // New discussions past the newest known uid (listed or not).
    const storedUids = [...state.posts.keys()].filter(k => /^s\d+$/.test(k)).map(k => Number(k.slice(1)))
    const maxKnown = Math.max(0, ...storedUids)
    const newest = await newestOverviewUid(client)
    const lastProbe = Math.min(Math.max(newest ?? 0, maxKnown) + NEW_UID_LOOKAHEAD, maxKnown + 50)
    for (let uid = maxKnown + 1; uid <= lastProbe; uid++) {
      if (!refetch.has(`s${uid}`)) refetch.set(`s${uid}`, { subject: `s${uid}`, uid })
    }

    // Rotation: this cycle's slot of the stored subjects.
    const candidates = [...state.posts.values()].filter(p => p.source_id && !p.source_removed).map(p => p.post_id)
    const tick = sweepSlot(this.now(), this.deps.cycleMinutes)
    const sweep = rotationDue(candidates, tick, this.lastTick, slotsPerWindow(this.deps.cycleMinutes, this.deps.sweepHours)).filter(s => !refetch.has(s))
    this.lastTick = tick
    for (const s of sweep) {
      const known = this.inventory.get(s)
      const uid = /^s\d+$/.test(s) ? Number(s.slice(1)) : null
      if (known) refetch.set(s, known)
      else if (uid != null) refetch.set(s, { subject: s, uid })
      fetched.sweep++
    }

    const items = new Map<string, SsItem>()
    const fetchedSubjects = new Set<string>()
    const gone = new Set<string>()
    for (const [subject, ref] of refetch) {
      const isItem = 'collection' in ref
      const collection: CollectionName = isItem ? ref.collection : 'discussions'
      if (!isItem) fetched.uidProbes++
      const d = await fetchDetail(client, collection, isItem ? ref : { uid: ref.uid, sourceId: '' })
      if (d === 'gone') { if (state.posts.has(subject)) { gone.add(subject); fetched.gone++ }; continue }
      if (d === 'invalid') { warn(w, 'detail-invalid'); fetched.invalid++; continue }
      items.set(subject, d); fetchedSubjects.add(subject); fetched.details++
      this.inventory.set(subject, d)
    }

    const discussionById = this.discussionById(state, this.inventory.values())
    const groups = buildGroups([...this.inventory.values()], discussionById)
    const links = boundLinks(this.inventory.values(), discussionById)
    const bySubject = new Map<string, Group>()
    for (const g of groups.values()) for (const m of g.members) bySubject.set(m.subject, g)
    const threads = new Map<string, ThreadResult>()
    for (const subject of fetchedSubjects) {
      const g = bySubject.get(subject)
      if (!g || threads.has(g.rootPostId)) continue
      const storedThread = [...state.comments.values()].some(c => c.thread_key === g.owner)
      if (!g.members.some(m => m.commentsCount > 0) && !storedThread) continue
      threads.set(g.rootPostId, await fetchThread(client, items.get(subject)!, w))
      fetched.threads++
    }
    const appendants = new Map<string, ReturnType<typeof parseInlineAppendants>>()
    for (const subject of fetchedSubjects) {
      const it = items.get(subject)!
      if (it.collection === 'discussions' && it.appendantsRaw?.length) appendants.set(subject, parseInlineAppendants(it.appendantsRaw, w))
      if (it.collection === 'opengov' && it.refs.referendumIndex != null) {
        const list = await fetchReferendumAppendants(client, it.refs.referendumIndex, w)
        fetched.appendants++
        if (list?.length) appendants.set(subject, list)
      }
    }
    const pollJson = await this.pollResults(items, fetchedSubjects, state, fetched, w)
    const view: SourceView = { items, gone, groups, discussionById, links, threads, appendants, pollJson, motionIds: motionIdsOf(this.inventory.values()) }
    return this.finish('incremental', view, state, false, w, fetched, startRequests)
  }

  private async finish(mode: CycleResult['mode'], view: SourceView, state: ForumState, importing: boolean, w: Warnings, fetched: CycleResult['fetched'], startRequests: number): Promise<CycleResult> {
    const loader = { posts: (ids: string[]) => loadFullPosts(this.deps.ch, ids), comments: (ids: string[]) => loadFullComments(this.deps.ch, ids) }
    const planned = await planWrites(view, state, this.ctx(importing, state), loader, w)
    const { stats } = planned
    let batch = planned.batch
    const normalised = await planNormalisation(batch, state, linkOptions(view.motionIds), { ...loader, revisions: () => loadRevisionsToNormalise(this.deps.ch) }, this.now(), this.normaliseMemo)
    let written = 0
    if (!this.deps.dryRun && batchSize(batch)) {
      // Rows the api wrote since this cycle read the tables are left to the next cycle (store.ts, dropRacedRows).
      const targets = recheckTargets(batch, state)
      const current = await loadUpdatedMs(this.deps.ch, targets.postIds, targets.comments)
      const checked = dropRacedRows(batch, state, current)
      if (checked.deferred.length) {
        this.log(`[subsquare] deferred ${checked.deferred.length} row(s) written here since the cycle read them: ${checked.deferred.slice(0, 10).join(', ')}${checked.deferred.length > 10 ? ', …' : ''}`)
        w['deferred-raced-write'] = (w['deferred-raced-write'] ?? 0) + checked.deferred.length
      }
      batch = checked.batch
      if (batchSize(batch)) {
        await writeBatch(this.deps.ch, batch)
        written = batchSize(batch)
      }
    }
    const images = await this.rehostImages(batch, state)
    return { mode, requests: this.deps.client.requests - startRequests, fetched, stats, normalised, written, images, warnings: w, plannedBatch: batch }
  }

  /**
   * Re-hosts every due image a visible item references, and every visible post's
   * banner (imagePlan.ts), within the cycle's wall-time budget and ImageBudget's caps.
   */
  private async rehostImages(batch: WriteBatch, state: ForumState): Promise<CycleResult['images']> {
    const out: CycleResult['images'] = { due: 0, pinnedCid: 0, rehosted: 0, archived: 0, failed: 0, deferred: 0, gc: null, failures: {} }
    const candidates = imageCandidates([...state.posts.values(), ...batch.posts], [...state.comments.values(), ...batch.comments])
    const now = this.now()
    const due = [...candidates.keys()].filter(u => urlDue(state.mediaUrls.get(u), now))
    out.due = due.length
    if (!this.deps.images || this.deps.dryRun || !this.deps.kubo || !due.length) return out
    const kubo = this.deps.kubo
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000
    const perAuthor = new Map<string, number>()
    for (const [u, s] of state.mediaUrls) {
      const author = candidates.get(u)
      if (s.status === 'ok' && s.updated_ms >= dayStart && author) perAuthor.set(author, (perAuthor.get(author) ?? 0) + 1)
    }
    const budget = new ImageBudget(kubo, await loadSyncMediaToday(this.deps.ch, dayStart), perAuthor)
    const media = emptyBatch()
    // A wall-time budget per cycle: a run of failing hosts (each up to its own timeout)
    // must not hold up the content sync; what is left is due again next cycle.
    const started = this.now()
    let garbage = false
    let done = 0
    for (const url of due.slice(0, this.deps.maxImagesPerCycle)) {
      if (this.now() - started >= (this.deps.imageBudgetMs ?? IMAGE_BUDGET_MS)) { out.deferred += due.length - done; break }
      done++
      const author = candidates.get(url) ?? ''
      const r = await rehostImage(url, state.mediaUrls.get(url), {
        kubo, now: this.now,
        throttle: fn => this.deps.client.throttle(fn),
        onGarbage: () => { garbage = true },
        archiveThrottle: this.archive,
        // The cycle's set, then the durable tombstone: a removal made since the cycle
        // read its state must stop (or undo) this pin too.
        refuseCid: async cid => {
          if (state.removedCids.has(cid)) return true
          if (!(await isCidRemoved(this.deps.ch, cid))) return false
          state.removedCids.add(cid); state.mediaCids.delete(cid)
          return true
        },
        admit: bytes => budget.admit(author, bytes),
      })
      if (r.kind === 'deferred') {
        out.deferred++
        out.failures[`deferred:${r.reason}`] = (out.failures[`deferred:${r.reason}`] ?? 0) + 1
        if (STOPS_THE_PASS.has(r.reason)) { out.deferred += due.length - done; break }
        continue
      }
      // A removed CID is never written back live (refuseCid stops it before; this is the last guard).
      if (r.media && !state.mediaCids.has(r.media.cid) && !state.removedCids.has(r.media.cid)) {
        media.media.push(r.media); state.mediaCids.add(r.media.cid); budget.commit(author, r.media.bytes)
      }
      media.mediaUrls.push(r.url)
      if (r.kind === 'pinned-cid') out.pinnedCid++
      else if (r.kind === 'rehosted') out.rehosted++
      else if (r.kind === 'archived') out.archived++
      else { out.failed++; out.failures[r.url.reason] = (out.failures[r.url.reason] ?? 0) + 1 }
      // Written as it goes, so a long re-host pass survives an interruption.
      if (media.mediaUrls.length >= 20) { await writeBatch(this.deps.ch, media); media.media = []; media.mediaUrls = [] }
    }
    if (media.mediaUrls.length) await writeBatch(this.deps.ch, media)
    // Blocks fetched for a refused, deferred or unreachable CID are held by no pin:
    // removed now rather than left to the node's watermark GC.
    if (garbage) { try { await kubo.repoGc(); out.gc = true } catch { out.gc = false } }
    return out
  }
}
