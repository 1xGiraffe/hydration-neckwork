import type { ClickHouseClient } from '../db/client.ts'

// Referendum titles, kept in memory.
//
// A title says what a referendum is; "#369" does not. They come from SubSquare via
// the referendum-titles service and land in price_data.referendum_titles, a table of
// at most a few hundred short strings — so the API holds the whole thing in a Map
// and refreshes it on an interval, the same shape identityService uses. That keeps
// title lookup free on every vote row the explorer renders, instead of joining a
// table into every activity query.
//
// Keys are `${pallet}:${index}`: Hydration voted through both pallets and both
// index from 0 (Democracy 0-206, OpenGov 0-369), so a bare number would collide.
let client: ClickHouseClient
let byRef = new Map<string, string>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

export function initReferendumTitleService(c: ClickHouseClient): void { client = c }

export function referendumTitleKey(pallet: string, index: number | string): string {
  return `${pallet}:${index}`
}

async function loadUncached(): Promise<void> {
  const res = await client.query({
    query: `SELECT pallet, ref_index, title FROM price_data.referendum_titles FINAL WHERE title != ''`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ pallet: string; ref_index: number; title: string }>()
  const next = new Map<string, string>()
  for (const row of rows) {
    if (!row.pallet || !row.title) continue
    next.set(referendumTitleKey(row.pallet, Number(row.ref_index)), row.title)
  }
  byRef = next
}

export function loadReferendumTitles(): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadUncached().finally(() => { if (loadInflight === request) loadInflight = null })
  loadInflight = request
  return request
}

// The fetcher re-reads a LIVE referendum's title every 30 min, so a 5-minute
// refresh here means an edited title shows up promptly without the API ever
// querying the table per request.
export function startReferendumTitleRefresh(intervalMs = 5 * 60 * 1000): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => { loadReferendumTitles().catch(() => { /* keep the stale map on error */ }) }, intervalMs)
  refreshTimer.unref()
}

export function stopReferendumTitleRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export async function referendumTitles(): Promise<ReadonlyMap<string, string>> {
  if (!byRef.size) await loadReferendumTitles().catch(() => { /* absent titles are absent, not fatal */ })
  return byRef
}

// Synchronous lookup for the hot paths (every vote row in every activity feed).
// Returns null rather than a placeholder when a title has not been fetched yet, so
// the UI falls back to the index instead of showing an invented name.
export function referendumTitleFor(pallet: string, index: number | string | null | undefined): string | null {
  if (index == null || index === '') return null
  return byRef.get(referendumTitleKey(pallet, index)) ?? null
}

export function referendumTitleCount(): number {
  return byRef.size
}

// Whether a title says anything a reader could not have worked out from the index.
//
// What this table holds is SubSquare's page title, and for a referendum nobody
// wrote a post for that is the platform's own placeholder: the bare
// "Referendum #123", sometimes with the track in brackets ahead of it, sometimes
// literally "Untitled". A message whose subject line is that placeholder repeats
// the index its own headline already carries, which is why the submitted-phase
// notification waits for a real one (the parked map in notifications/evaluator).
//
// Deliberately narrow: only the bare template counts as generic. A title that
// merely CONTAINS the index ("Referendum #123 — raise the HDX fee") says
// something, and treating it as absent would hold a perfectly good alert forever.
const GENERIC_TITLE_RE = /^(?:\[[^\]]*\]\s*)?(?:referend(?:um|a)|ref)\.?\s*#?\s*\d+\.?$/i
export function isGenericReferendumTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  if (/^untitled$/i.test(t)) return true
  return GENERIC_TITLE_RE.test(t)
}
