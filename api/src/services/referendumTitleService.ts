import { forumGeneration, forumPosts, forumReady } from './forumStore.ts'

// Referendum titles, kept in memory.
//
// A title says what a referendum is; "#369" does not. The chain has none, so they
// come from the governance forum: the description post of each on-chain subject
// (forum_posts, post_id 'opengov:<i>' / 'democracy:<i>', 021_forum.sql), imported
// from Subsquare by the governance-content-sync service or written natively by the
// proposer. They are read from the api's in-process forum snapshot (forumStore.ts),
// rebuilt whenever its `generation` moves — which every native write and moderation
// action does at once (the snapshot is patched before the write answers), and every
// reload of the tables within FORUM_REFRESH_MS — so a hidden or deleted description
// stops lending its title to every surface (vote rows, search, share cards, feeds,
// notifications, the MCP through the explorer routes) within seconds. Lookup stays a
// synchronous Map read on every vote row the explorer renders. Titles are
// user-authored and HOSTILE: rendered as text, never markup.
//
// Keys are `${pallet}:${index}`: Hydration voted through both pallets and both
// index from 0, so a bare number would collide — and they are exactly the forum's
// post ids. While the snapshot has not loaded there are no titles, never stale ones.

const SUBJECT_KINDS = new Set(['opengov', 'democracy'])
let built: { generation: string; byRef: Map<string, string> } | null = null

export function referendumTitleKey(pallet: string, index: number | string): string {
  return `${pallet}:${index}`
}

function titleMap(): ReadonlyMap<string, string> {
  if (!forumReady()) return new Map()
  const generation = forumGeneration()
  if (built?.generation === generation) return built.byRef
  const byRef = new Map<string, string>()
  for (const post of forumPosts()) {
    if (!SUBJECT_KINDS.has(post.kind) || post.hidden || post.deleted) continue
    // Stored verbatim (whitespace included); a title is shown trimmed.
    const title = post.title.trim()
    if (title) byRef.set(post.postId, title)
  }
  built = { generation, byRef }
  return byRef
}

export async function referendumTitles(): Promise<ReadonlyMap<string, string>> {
  return titleMap()
}

// The highest index this pallet is known to have reached, or null while the map
// is still empty. Referenda are numbered sequentially from 0 and the table
// covers them densely, so an index above this one names a referendum that does
// not exist — which is how the SEO layer tells a real page from a fabricated
// one without a query. Null means "cannot say", never "nothing exists".
export function highestReferendumIndex(pallet: string): number | null {
  let highest: number | null = null
  for (const key of titleMap().keys()) {
    const [keyPallet, index] = key.split(':')
    if (keyPallet !== pallet) continue
    const n = Number(index)
    if (Number.isFinite(n) && (highest == null || n > highest)) highest = n
  }
  return highest
}

// Synchronous lookup for the hot paths (every vote row in every activity feed).
// Returns null rather than a placeholder when a title has not been fetched yet, so
// the UI falls back to the index instead of showing an invented name.
export function referendumTitleFor(pallet: string, index: number | string | null | undefined): string | null {
  if (index == null || index === '') return null
  return titleMap().get(referendumTitleKey(pallet, index)) ?? null
}

// Whether a title says anything a reader could not have worked out from the index.
//
// An imported title is Subsquare's, and for a referendum nobody wrote a post for
// that is the platform's own placeholder: the bare
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
