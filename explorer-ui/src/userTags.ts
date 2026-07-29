import { useSyncExternalStore } from 'react'
import type { TagMapResponse, AccountRef } from './types'

// Viewer-side tag resolution. The server ships each account's SYSTEM tag on
// its accountRef (shared-cacheable); the viewer's own lists arrive once
// via /user/tag-map. Walking the map in priority order — with 'system' as a
// slot in that order — yields exactly one winning tag per account, while
// allAssociations() lists every match for the account page and hover card.
// `memberCount` disambiguates a pill wearing this tag on behalf of one of its
// several members (see AddrPill/ExternalAccountPill's `·xyz` suffix) — absent
// or 1 means the tag can only ever mean the one account it's shown next to.
export interface ResolvedTag { kind: 'system' | 'user'; id: string; name: string; color: string; icon: string; memberCount?: number; listId?: string; listName?: string }

interface ListTagIndex { tagId: string; name: string; color: string; icon: string; memberCount: number }
interface ListIndex { listId: string; name: string; tags: ListTagIndex[]; byAccount: Map<string, ListTagIndex> }
let indexes: ListIndex[] | null = null
// Whether a session exists — distinct from `indexes` being null, which is
// ALSO true for the brief window after login where a session exists but
// `/user/tag-map` hasn't answered yet. Without this, that window and "no
// session at all" are indistinguishable, which is exactly what let TagDetail
// flash "Tag not found" on a cold load (see tagMapStatus).
let sessionActive = false
// Set once a session's tag-map fetch fails OUTRIGHT (every retry exhausted) —
// distinct from `indexes` being null while a fetch is merely still in flight.
// Without this, a failed fetch and "still loading" read identically to
// tagMapStatus(), and a UUID-shaped /tag/:id page waited on a response that
// had already come back and failed: the skeleton never resolved. Cleared by
// every normal setTagMap() call (a fresh load or a later successful retry).
let mapErrored = false
let version = 0
const listeners = new Set<() => void>()

// `hasSession` defaults from `map`: the server only ever HAS a map to send
// once a session exists, so a caller passing a real map can omit it, and a
// caller resetting to logged-out (`setTagMap(null)`) gets the right default
// too. The one caller that needs to override it is useTagMapSync, for the
// "session exists, map not back yet" window itself (`setTagMap(null, true)`).
export function setTagMap(map: TagMapResponse | null, hasSession: boolean = map !== null): void {
  indexes = map ? map.lists.map(lib => ({
    listId: lib.listId, name: lib.name,
    tags: lib.tags.map(t => ({ tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length })),
    byAccount: new Map(lib.tags.flatMap(t => t.members.map(m => [m, { tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length }] as const))),
  })) : null
  sessionActive = hasSession
  mapErrored = false
  version++
  listeners.forEach(l => l())
}

// The session's tag-map fetch is done retrying and never succeeded — a
// TERMINAL outcome, unlike "still loading". Implies a session exists (this
// is only ever called from a session-gated query), so it's safe to call even
// if no prior setTagMap(_, true) has landed yet.
export function setTagMapError(): void {
  sessionActive = true
  mapErrored = true
  version++
  listeners.forEach(l => l())
}

export function useTagMapVersion(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => version, () => 0)
}

// Where the tag map stands, for callers (TagDetail, HoverCard) that must not
// treat "definitely no session", "session exists, map still in flight" and
// "session exists, map fetch failed" the same way — only 'loading' is
// temporary and guaranteed to resolve on its own; 'anonymous' and 'error' are
// both terminal (an id genuinely can't be resolved as a user tag from here)
// and get treated alike by every caller so far, but are named separately
// since WHY it can't be resolved differs. Pair with useTagMapVersion() for
// reactivity.
export function tagMapStatus(): 'anonymous' | 'loading' | 'ready' | 'error' {
  if (!sessionActive) return 'anonymous'
  if (indexes) return 'ready'
  return mapErrored ? 'error' : 'loading'
}

// Cheap "would the accounts directory even change" gate: whether the viewer's
// own (or subscribed) tag map has a member anywhere. useAccounts
// (useExplorerData.ts) reads this to decide whether the per-viewer /user/accounts
// fold is worth fetching at all — a tagless viewer gets nothing from it that the
// shared /explorer/accounts doesn't already answer, at zero extra server cost.
export function hasUserTagMembers(): boolean {
  if (!indexes) return false
  return indexes.some(lib => lib.listId !== 'system' && lib.tags.some(t => t.memberCount > 0))
}

// System tag ids are short, hand-picked slugs ('kraken', 'fee-processor', …);
// user tag ids are UUIDs minted by userListService's randomUUID(). The two
// id spaces never collide, which is what lets TagDetail fast-path a slug
// straight to the system view while waiting on the tag map only for an id
// that could actually BE a user tag.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function looksLikeUserTagId(id: string): boolean {
  return UUID_RE.test(id)
}

function systemTag(account: Pick<AccountRef, 'tag'>): ResolvedTag | null {
  return account.tag ? { kind: 'system', id: account.tag.id, name: account.tag.name, color: account.tag.color, icon: account.tag.icon, memberCount: account.tag.memberCount } : null
}

export function resolveTag(account: Pick<AccountRef, 'accountId' | 'tag'>): ResolvedTag | null {
  if (!indexes) return systemTag(account)
  for (const lib of indexes) {
    if (lib.listId === 'system') {
      const sys = systemTag(account)
      if (sys) return sys
      continue
    }
    const hit = lib.byAccount.get(account.accountId)
    if (hit) return { kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, memberCount: hit.memberCount, listId: lib.listId, listName: lib.name }
  }
  return null
}

export function allAssociations(account: Pick<AccountRef, 'accountId' | 'tag'>): ResolvedTag[] {
  if (!indexes) { const sys = systemTag(account); return sys ? [sys] : [] }
  const out: ResolvedTag[] = []
  for (const lib of indexes) {
    if (lib.listId === 'system') { const sys = systemTag(account); if (sys) out.push(sys); continue }
    const hit = lib.byAccount.get(account.accountId)
    if (hit) out.push({ kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, memberCount: hit.memberCount, listId: lib.listId, listName: lib.name })
  }
  return out
}

// Which of the viewer's own (or subscribed) lists owns a given tag id, if
// any — the client-side half of TagDetail's routing: a user-tag id is a UUID
// minted by userListService, never one of the short, code-defined system
// slugs (`kraken`, `treasury`, …), so this can never accidentally shadow a
// real system tag of the same id. Used to resolve /tag/:id instantly, before
// the system lookup even has a chance to 404.
export function listForTag(tagId: string): { listId: string; listName: string } | null {
  if (!indexes) return null
  for (const lib of indexes) {
    if (lib.listId === 'system') continue
    if (lib.tags.some(t => t.tagId === tagId)) return { listId: lib.listId, listName: lib.name }
  }
  return null
}

export interface UserTagSearchHit { listId: string; listName: string; tagId: string; name: string; color: string; icon: string }

// Client-side search over the viewer's OWN visible list tags — never the
// server's shared, anonymous /explorer/search, which cannot know a viewer's
// private tag names without becoming per-viewer (and losing its cache). Skips
// the 'system' slot (it carries no tags of its own; the built-in directory has
// its own /tag/:id search hit already). Logged out or before the tag map has
// loaded, there is nothing to search.
export function searchUserTags(q: string, limit = 3): UserTagSearchHit[] {
  const needle = q.trim().toLowerCase()
  if (!needle || !indexes) return []
  const hits: UserTagSearchHit[] = []
  for (const lib of indexes) {
    if (lib.listId === 'system') continue
    for (const t of lib.tags) {
      if (t.name.toLowerCase().includes(needle)) hits.push({ listId: lib.listId, listName: lib.name, tagId: t.tagId, name: t.name, color: t.color, icon: t.icon })
    }
  }
  return hits.slice(0, limit)
}
