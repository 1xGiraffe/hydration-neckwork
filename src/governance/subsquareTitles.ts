// SubSquare referendum titles.
//
// The chain records a referendum's index, track and proposal hash but never its
// human title — that lives off-chain, so it is fetched from SubSquare's rendered
// page and cached in price_data.referendum_titles.
//
// Everything here is pure so the selection policy and the parsing can be tested
// without touching the network; the fetching lives in
// src/scripts/snapshot-referendum-titles.ts.

export type ReferendumPallet = 'opengov' | 'democracy'

export interface ReferendumInventoryRow {
  pallet: ReferendumPallet
  refIndex: number
  concluded: boolean
}

export interface StoredTitleRow {
  pallet: ReferendumPallet
  refIndex: number
  title: string
  fetchedAtMs: number
}

// OpenGov referenda live under /referenda/:index; the pre-OpenGov Democracy ones
// under /democracy/referenda/:index. Both indexes start at 0 and Hydration has
// used both pallets (Democracy 0-206, OpenGov 0-369), so a title is only ever
// identified by the PAIR — indexing by number alone would cross-label them.
export function subsquareReferendumPath(pallet: ReferendumPallet, refIndex: number): string {
  return pallet === 'democracy' ? `/democracy/referenda/${refIndex}` : `/referenda/${refIndex}`
}

export function subsquareReferendumUrl(baseUrl: string, pallet: ReferendumPallet, refIndex: number): string {
  return `${baseUrl.replace(/\/+$/, '')}${subsquareReferendumPath(pallet, refIndex)}`
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const named = ENTITIES[name]
    if (named != null) return named
    const decimal = /^#(\d+)$/.exec(name)
    if (decimal) { const code = Number(decimal[1]); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole }
    const hex = /^#x([0-9a-fA-F]+)$/.exec(name)
    if (hex) { const code = Number.parseInt(hex[1], 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole }
    return whole
  })
}

// SubSquare answers 200 with its generic site title for a referendum that does not
// exist (verified: /referenda/9999 returns "SubSquare | hydradx governance
// platform"), so a naive parse would store that junk as ref 9999's name — the same
// absent-value-looks-real trap that made a missing DCA order read as HDX->HDX.
// Anything that is only the site's own branding is therefore not a title.
const GENERIC_TITLE = /^\s*subsquare\b|governance\s+platform\s*$/i

export function parseSubsquareTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
  if (!title || GENERIC_TITLE.test(title)) return null
  return title.length > 300 ? title.slice(0, 300) : title
}

export interface FetchPlanOptions {
  nowMs: number
  // How stale a LIVE referendum's title may get. Live titles are edited while the
  // vote runs, so they are re-read; concluded ones are frozen and never re-read.
  liveRefreshMs: number
  // Per-cycle ceiling, so a first run backfilling hundreds of referenda spreads
  // itself over cycles instead of hammering SubSquare in one burst.
  maxFetches: number
}

// Which referenda to fetch this cycle, and why. Ordered so the newest referenda —
// the ones anyone is actually looking at — are filled first, and a concluded
// referendum that already has a title is never requested again.
export function planTitleFetches(
  inventory: ReferendumInventoryRow[],
  stored: StoredTitleRow[],
  options: FetchPlanOptions,
): { pallet: ReferendumPallet; refIndex: number; reason: 'missing' | 'live-refresh' }[] {
  const key = (pallet: ReferendumPallet, refIndex: number) => `${pallet}:${refIndex}`
  const byKey = new Map(stored.map(row => [key(row.pallet, row.refIndex), row]))
  const missing: { pallet: ReferendumPallet; refIndex: number; reason: 'missing' }[] = []
  const refresh: { pallet: ReferendumPallet; refIndex: number; reason: 'live-refresh' }[] = []

  for (const row of inventory) {
    const held = byKey.get(key(row.pallet, row.refIndex))
    if (!held || !held.title) { missing.push({ pallet: row.pallet, refIndex: row.refIndex, reason: 'missing' }); continue }
    if (row.concluded) continue
    if (options.nowMs - held.fetchedAtMs >= options.liveRefreshMs) {
      refresh.push({ pallet: row.pallet, refIndex: row.refIndex, reason: 'live-refresh' })
    }
  }

  const newestFirst = <T extends { refIndex: number }>(rows: T[]) => rows.sort((a, b) => b.refIndex - a.refIndex)
  // Live refreshes go first: they are few (Hydration usually has 0-2 open
  // referenda) and they are the only ones whose stored value can be wrong.
  return [...newestFirst(refresh), ...newestFirst(missing)].slice(0, Math.max(0, options.maxFetches))
}
