import { useSyncExternalStore } from 'react'
import type { TagMapResponse, AccountRef } from './types'

// Viewer-side tag resolution. The server ships each account's SYSTEM tag on
// its accountRef (shared-cacheable); the viewer's own libraries arrive once
// via /user/tag-map. Walking the map in priority order — with 'system' as a
// slot in that order — yields exactly one winning tag per account, while
// allAssociations() lists every match for the account page and hover card.
// `memberCount` disambiguates a pill wearing this tag on behalf of one of its
// several members (see AddrPill/ExternalAccountPill's `·xyz` suffix) — absent
// or 1 means the tag can only ever mean the one account it's shown next to.
export interface ResolvedTag { kind: 'system' | 'user'; id: string; name: string; color: string; icon: string; memberCount?: number; libraryId?: string; libraryName?: string }

interface LibraryTagIndex { tagId: string; name: string; color: string; icon: string; memberCount: number }
interface LibraryIndex { libraryId: string; name: string; tags: LibraryTagIndex[]; byAccount: Map<string, LibraryTagIndex> }
let indexes: LibraryIndex[] | null = null
// Whether a session exists — distinct from `indexes` being null, which is
// ALSO true for the brief window after login where a session exists but
// `/user/tag-map` hasn't answered yet. Without this, that window and "no
// session at all" are indistinguishable, which is exactly what let TagDetail
// flash "Tag not found" on a cold load (see tagMapStatus).
let sessionActive = false
let version = 0
const listeners = new Set<() => void>()

// `hasSession` defaults from `map`: the server only ever HAS a map to send
// once a session exists, so a caller passing a real map can omit it, and a
// caller resetting to logged-out (`setTagMap(null)`) gets the right default
// too. The one caller that needs to override it is useTagMapSync, for the
// "session exists, map not back yet" window itself (`setTagMap(null, true)`).
export function setTagMap(map: TagMapResponse | null, hasSession: boolean = map !== null): void {
  indexes = map ? map.libraries.map(lib => ({
    libraryId: lib.libraryId, name: lib.name,
    tags: lib.tags.map(t => ({ tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length })),
    byAccount: new Map(lib.tags.flatMap(t => t.members.map(m => [m, { tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length }] as const))),
  })) : null
  sessionActive = hasSession
  version++
  listeners.forEach(l => l())
}

export function useTagMapVersion(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => version, () => 0)
}

// Three-state read of where the tag map stands, for callers (TagDetail) that
// must not treat "definitely no session" and "session exists, map still in
// flight" the same way — the latter is temporary and resolves on its own,
// the former never will. Pair with useTagMapVersion() for reactivity.
export function tagMapStatus(): 'anonymous' | 'loading' | 'ready' {
  if (!sessionActive) return 'anonymous'
  return indexes ? 'ready' : 'loading'
}

// System tag ids are short, hand-picked slugs ('kraken', 'fee-processor', …);
// user tag ids are UUIDs minted by userLibraryService's randomUUID(). The two
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
    if (lib.libraryId === 'system') {
      const sys = systemTag(account)
      if (sys) return sys
      continue
    }
    const hit = lib.byAccount.get(account.accountId)
    if (hit) return { kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, memberCount: hit.memberCount, libraryId: lib.libraryId, libraryName: lib.name }
  }
  return null
}

export function allAssociations(account: Pick<AccountRef, 'accountId' | 'tag'>): ResolvedTag[] {
  if (!indexes) { const sys = systemTag(account); return sys ? [sys] : [] }
  const out: ResolvedTag[] = []
  for (const lib of indexes) {
    if (lib.libraryId === 'system') { const sys = systemTag(account); if (sys) out.push(sys); continue }
    const hit = lib.byAccount.get(account.accountId)
    if (hit) out.push({ kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, memberCount: hit.memberCount, libraryId: lib.libraryId, libraryName: lib.name })
  }
  return out
}

// Which of the viewer's own (or subscribed) libraries owns a given tag id, if
// any — the client-side half of TagDetail's routing: a user-tag id is a UUID
// minted by userLibraryService, never one of the short, code-defined system
// slugs (`kraken`, `treasury`, …), so this can never accidentally shadow a
// real system tag of the same id. Used to resolve /tag/:id instantly, before
// the system lookup even has a chance to 404.
export function libraryForTag(tagId: string): { libraryId: string; libraryName: string } | null {
  if (!indexes) return null
  for (const lib of indexes) {
    if (lib.libraryId === 'system') continue
    if (lib.tags.some(t => t.tagId === tagId)) return { libraryId: lib.libraryId, libraryName: lib.name }
  }
  return null
}

export interface UserTagSearchHit { libraryId: string; libraryName: string; tagId: string; name: string; color: string; icon: string }

// Client-side search over the viewer's OWN visible library tags — never the
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
    if (lib.libraryId === 'system') continue
    for (const t of lib.tags) {
      if (t.name.toLowerCase().includes(needle)) hits.push({ libraryId: lib.libraryId, libraryName: lib.name, tagId: t.tagId, name: t.name, color: t.color, icon: t.icon })
    }
  }
  return hits.slice(0, limit)
}
