import { useSyncExternalStore } from 'react'
import type { TagMapResponse, AccountRef } from './types'

// Viewer-side tag resolution. The server ships each account's SYSTEM tag on
// its accountRef (shared-cacheable); the viewer's own libraries arrive once
// via /user/tag-map. Walking the map in priority order — with 'system' as a
// slot in that order — yields exactly one winning tag per account, while
// allAssociations() lists every match for the account page and hover card.
export interface ResolvedTag { kind: 'system' | 'user'; id: string; name: string; color: string; icon: string; libraryId?: string; libraryName?: string }

interface LibraryIndex { libraryId: string; name: string; byAccount: Map<string, { tagId: string; name: string; color: string; icon: string }> }
let indexes: LibraryIndex[] | null = null
let version = 0
const listeners = new Set<() => void>()

export function setTagMap(map: TagMapResponse | null): void {
  indexes = map ? map.libraries.map(lib => ({
    libraryId: lib.libraryId, name: lib.name,
    byAccount: new Map(lib.tags.flatMap(t => t.members.map(m => [m, { tagId: t.tagId, name: t.name, color: t.color, icon: t.icon }] as const))),
  })) : null
  version++
  listeners.forEach(l => l())
}

export function useTagMapVersion(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => version, () => 0)
}

function systemTag(account: Pick<AccountRef, 'tag'>): ResolvedTag | null {
  return account.tag ? { kind: 'system', id: account.tag.id, name: account.tag.name, color: account.tag.color, icon: account.tag.icon } : null
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
    if (hit) return { kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, libraryId: lib.libraryId, libraryName: lib.name }
  }
  return null
}

export function allAssociations(account: Pick<AccountRef, 'accountId' | 'tag'>): ResolvedTag[] {
  if (!indexes) { const sys = systemTag(account); return sys ? [sys] : [] }
  const out: ResolvedTag[] = []
  for (const lib of indexes) {
    if (lib.libraryId === 'system') { const sys = systemTag(account); if (sys) out.push(sys); continue }
    const hit = lib.byAccount.get(account.accountId)
    if (hit) out.push({ kind: 'user', id: hit.tagId, name: hit.name, color: hit.color, icon: hit.icon, libraryId: lib.libraryId, libraryName: lib.name })
  }
  return out
}
