import type { SubsquareClient } from './client.js'
import {
  COLLECTIONS, LIST_PATH, parseAppendant, parseComment, parseItem, parsePage, parsePollVotes,
  type CollectionName, type SsAppendant, type SsComment, type SsItem, type SsPollVotes,
} from './parse.js'

// Everything the sync reads from Subsquare, one request at a time through the polite
// client. Unknown shapes are counted as warnings and the item skipped.

export const PAGE_SIZE = 100

export interface Warnings { [reason: string]: number }
export const warn = (w: Warnings, reason: string) => { w[reason] = (w[reason] ?? 0) + 1 }

export interface ListResult { total: number; items: SsItem[]; pages: number }

/** Every page of a collection's list. */
export async function listAll(client: SubsquareClient, collection: CollectionName, w: Warnings): Promise<ListResult> {
  const items: SsItem[] = []
  let total = 0, pages = 0, seen = 0
  for (let page = 1; page <= 200; page++) {
    const res = await client.get(`${LIST_PATH[collection]}?page=${page}&page_size=${PAGE_SIZE}`)
    const parsed = res.status === 200 ? parsePage(res.body) : null
    if (!parsed) throw new Error(`list ${collection} page ${page}: unexpected answer (status ${res.status})`)
    pages++
    total = parsed.total
    seen += parsed.items.length
    for (const raw of parsed.items) {
      const item = parseItem(collection, raw)
      if (item) items.push(item)
      else warn(w, `list-item-shape:${collection}`)
    }
    if (parsed.items.length < PAGE_SIZE || seen >= total) break
  }
  return { total, items, pages }
}

export type Detail = SsItem | 'gone' | 'invalid'

/** An item's detail (content, Subsquare's hide/isMalicious flags). */
export async function fetchDetail(client: SubsquareClient, collection: CollectionName, ref: { uid?: number | null; sourceId: string }): Promise<Detail> {
  const path = collection === 'discussions' ? `/posts/${ref.uid}` : `${LIST_PATH[collection]}/${ref.sourceId}`
  const res = await client.get(path)
  if (res.status === 404) return 'gone'
  if (res.status !== 200) return 'invalid'
  return parseItem(collection, res.body) ?? 'invalid'
}

export async function fetchDiscussionByUid(client: SubsquareClient, uid: number): Promise<Detail> {
  return fetchDetail(client, 'discussions', { uid, sourceId: '' })
}

export interface ThreadResult { ok: boolean; comments: SsComment[]; total: number }

/** A merged thread's comments (top level, replies nested), every page. `ok` only when every page and comment parsed. */
export async function fetchThread(client: SubsquareClient, via: SsItem, w: Warnings): Promise<ThreadResult> {
  const base = `${LIST_PATH[via.collection]}/${via.sourceId}/comments`
  const comments: SsComment[] = []
  let ok = true, total = 0, seen = 0
  for (let page = 1; page <= 100; page++) {
    const res = await client.get(`${base}?page=${page}&page_size=${PAGE_SIZE}`)
    const parsed = res.status === 200 ? parsePage(res.body) : null
    if (!parsed) { warn(w, 'thread-page'); return { ok: false, comments, total } }
    total = parsed.total
    seen += parsed.items.length
    for (const raw of parsed.items) {
      const c = parseComment(raw)
      if (c) comments.push(c)
      else { warn(w, 'comment-shape'); ok = false }
    }
    if (parsed.items.length < PAGE_SIZE || seen >= total) break
  }
  return { ok, comments, total }
}

/** An OpenGov referendum's appendants (the proposer's Updates). */
export async function fetchReferendumAppendants(client: SubsquareClient, index: number, w: Warnings): Promise<SsAppendant[] | null> {
  const res = await client.get(`/gov2/referenda/${index}/appendants`)
  if (res.status !== 200 || !Array.isArray(res.body)) { warn(w, 'appendants'); return null }
  const out: SsAppendant[] = []
  for (const raw of res.body) {
    const a = parseAppendant(raw)
    if (a) out.push(a)
    else warn(w, 'appendant-shape')
  }
  return out
}

export function parseInlineAppendants(raw: unknown[] | null, w: Warnings): SsAppendant[] {
  const out: SsAppendant[] = []
  for (const r of raw ?? []) {
    const a = parseAppendant(r)
    if (a) out.push(a)
    else warn(w, 'appendant-shape')
  }
  return out
}

export async function fetchPollVotes(client: SubsquareClient, pollId: string): Promise<SsPollVotes | null> {
  const res = await client.get(`/polls/${pollId}/votes`)
  return res.status === 200 ? parsePollVotes(res.body) : null
}

/** The newest discussion uid Subsquare's overview names (it lists unlisted SIMA posts the /posts list hides). */
export async function newestOverviewUid(client: SubsquareClient): Promise<number | null> {
  const res = await client.get('/overview/discussions')
  const parsed = res.status === 200 ? parsePage(res.body) : null
  if (!parsed) return null
  let max: number | null = null
  for (const raw of parsed.items) {
    const uid = typeof raw === 'object' && raw && 'postUid' in raw ? Number((raw as { postUid: unknown }).postUid) : NaN
    if (Number.isInteger(uid) && (max == null || uid > max)) max = uid
  }
  return max
}

export async function fetchSummary(client: SubsquareClient): Promise<Record<string, number>> {
  const res = await client.get('/summary')
  const out: Record<string, number> = {}
  if (res.status === 200 && typeof res.body === 'object' && res.body) {
    for (const [k, v] of Object.entries(res.body as Record<string, unknown>)) {
      const all = typeof v === 'object' && v && 'all' in v ? Number((v as { all: unknown }).all) : NaN
      if (Number.isFinite(all)) out[k] = all
    }
  }
  return out
}

export { COLLECTIONS }
