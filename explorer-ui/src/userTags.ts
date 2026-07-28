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
let version = 0
const listeners = new Set<() => void>()

export function setTagMap(map: TagMapResponse | null): void {
  indexes = map ? map.libraries.map(lib => ({
    libraryId: lib.libraryId, name: lib.name,
    tags: lib.tags.map(t => ({ tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length })),
    byAccount: new Map(lib.tags.flatMap(t => t.members.map(m => [m, { tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, memberCount: t.members.length }] as const))),
  })) : null
  version++
  listeners.forEach(l => l())
}

export function useTagMapVersion(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => version, () => 0)
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
