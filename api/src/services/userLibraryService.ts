import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { UserDataError } from './userProfileService.ts'

// User tag libraries: named collections of tags, each tag holding member
// accounts. Owned by one account; shareable by invite or publicly (Task 7);
// prioritized per viewer (Task 8). The api process is the single writer —
// these maps ARE the model, ClickHouse is their durability. Every mutation
// updates memory first, then persists; every row uses the ReplacingMergeTree
// soft-delete idiom (insert with deleted=1 to remove).

export interface UserTagDef { tagId: string; name: string; color: string; icon: string; note: string; members: Set<string> }
export interface UserLibrary {
  libraryId: string; owner: string; name: string; note: string
  visibility: 'private' | 'public'; isPersonal: boolean
  tags: Map<string, UserTagDef>
  memberTag: Map<string, string>
}
export interface LibrarySummary {
  libraryId: string; name: string; note: string; visibility: 'private' | 'public'; isPersonal: boolean
  ownerAccountId: string; tagCount: number; accountCount: number; subscriberCount: number
}

export const LIMITS = {
  librariesPerUser: 50, tagsPerLibrary: 200, membersPerTag: 2_000, membersPerLibrary: 20_000,
  subscriptionsPerUser: 200, nameLen: 48, noteLen: 280,
} as const

let client: ClickHouseClient
const libraries = new Map<string, UserLibrary>()
const byOwner = new Map<string, Set<string>>()

export function initUserLibraryService(c: ClickHouseClient): void {
  client = c; libraries.clear(); byOwner.clear()
}

export async function loadUserLibraries(): Promise<void> {
  libraries.clear(); byOwner.clear()
  const [libRes, tagRes, memberRes] = [
    await client.query({ query: `SELECT library_id, owner_account_id, name, note, visibility, is_personal FROM price_data.user_libraries FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT library_id, tag_id, name, color, icon, note FROM price_data.user_tags FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT library_id, tag_id, account_id FROM price_data.user_tag_members FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
  ]
  for (const r of await libRes.json<{ library_id: string; owner_account_id: string; name: string; note: string; visibility: string; is_personal: number }>()) {
    const lib: UserLibrary = {
      libraryId: r.library_id, owner: r.owner_account_id, name: r.name, note: r.note ?? '',
      visibility: r.visibility === 'public' ? 'public' : 'private', isPersonal: r.is_personal === 1,
      tags: new Map(), memberTag: new Map(),
    }
    libraries.set(lib.libraryId, lib)
    if (!byOwner.has(lib.owner)) byOwner.set(lib.owner, new Set())
    byOwner.get(lib.owner)!.add(lib.libraryId)
  }
  for (const r of await tagRes.json<{ library_id: string; tag_id: string; name: string; color: string; icon: string; note: string }>()) {
    libraries.get(r.library_id)?.tags.set(r.tag_id, { tagId: r.tag_id, name: r.name, color: r.color ?? '', icon: r.icon ?? '', note: r.note ?? '', members: new Set() })
  }
  for (const r of await memberRes.json<{ library_id: string; tag_id: string; account_id: string }>()) {
    const lib = libraries.get(r.library_id)
    const tag = lib?.tags.get(r.tag_id)
    if (!lib || !tag) continue
    tag.members.add(r.account_id)
    lib.memberTag.set(r.account_id, r.tag_id)
  }
}

export function getLibrary(libraryId: string): UserLibrary | null { return libraries.get(libraryId) ?? null }
export function ownedLibrariesFor(owner: string): LibrarySummary[] {
  return [...(byOwner.get(owner) ?? [])].map(id => librarySummary(libraries.get(id)!))
}
export function librarySummary(lib: UserLibrary): LibrarySummary {
  return {
    libraryId: lib.libraryId, name: lib.name, note: lib.note, visibility: lib.visibility, isPersonal: lib.isPersonal,
    ownerAccountId: lib.owner, tagCount: lib.tags.size, accountCount: lib.memberTag.size,
    subscriberCount: subscriberCountFor(lib.libraryId),   // Task 7 replaces the stub below
  }
}
// Replaced in Task 7 by the real subscription index.
function subscriberCountFor(_libraryId: string): number { return 0 }

function checkText(value: string, max: number, what: string): string {
  const v = value.trim()
  if (!v && what.endsWith('name')) throw new UserDataError(422, `A ${what} is required`)
  if (v.length > max) throw new UserDataError(422, `A ${what} is limited to ${max} characters`)
  return v
}
// v1 keeps user tag icons to emoji so no third-party URL is ever rendered into
// other viewers' pages. Anything URL-shaped is rejected outright.
function checkIcon(icon: string): string {
  const v = icon.trim()
  if (v.length > 16 || v.includes('/') || v.includes(':') || v.includes('.')) throw new UserDataError(422, 'Tag icons are limited to an emoji')
  return v
}

function requireOwned(owner: string, libraryId: string): UserLibrary {
  const lib = libraries.get(libraryId)
  if (!lib) throw new UserDataError(404, 'Library not found')
  if (lib.owner !== owner) throw new UserDataError(403, 'Not your library')
  return lib
}

async function persistLibrary(lib: UserLibrary, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_libraries',
    values: [{ library_id: lib.libraryId, owner_account_id: lib.owner, name: lib.name, note: lib.note, visibility: lib.visibility, is_personal: lib.isPersonal ? 1 : 0, deleted }],
    format: 'JSONEachRow',
  })
}
async function persistTag(libraryId: string, tag: UserTagDef, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_tags',
    values: [{ library_id: libraryId, tag_id: tag.tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note, deleted }],
    format: 'JSONEachRow',
  })
}
async function persistMembers(libraryId: string, tagId: string, accountIds: string[], deleted: number): Promise<void> {
  if (!accountIds.length) return
  await client.insert({
    table: 'price_data.user_tag_members',
    values: accountIds.map(account_id => ({ library_id: libraryId, tag_id: tagId, account_id, deleted })),
    format: 'JSONEachRow',
  })
}

function addLibrary(lib: UserLibrary): void {
  libraries.set(lib.libraryId, lib)
  if (!byOwner.has(lib.owner)) byOwner.set(lib.owner, new Set())
  byOwner.get(lib.owner)!.add(lib.libraryId)
}

export async function ensurePersonalLibrary(accountId: string): Promise<UserLibrary> {
  const existing = [...(byOwner.get(accountId) ?? [])].map(id => libraries.get(id)!).find(l => l.isPersonal)
  if (existing) return existing
  const lib: UserLibrary = { libraryId: randomUUID(), owner: accountId, name: 'Personal', note: '', visibility: 'private', isPersonal: true, tags: new Map(), memberTag: new Map() }
  addLibrary(lib)
  await persistLibrary(lib)
  return lib
}

export async function createLibrary(owner: string, name: string, note: string, visibility: 'private' | 'public'): Promise<UserLibrary> {
  if ((byOwner.get(owner)?.size ?? 0) >= LIMITS.librariesPerUser) throw new UserDataError(422, `Limited to ${LIMITS.librariesPerUser} libraries`)
  const lib: UserLibrary = {
    libraryId: randomUUID(), owner, name: checkText(name, LIMITS.nameLen, 'library name'),
    note: checkText(note, LIMITS.noteLen, 'library note'), visibility, isPersonal: false, tags: new Map(), memberTag: new Map(),
  }
  addLibrary(lib)
  await persistLibrary(lib)
  return lib
}

export async function updateLibrary(owner: string, libraryId: string, patch: { name?: string; note?: string; visibility?: 'private' | 'public' }): Promise<UserLibrary> {
  const lib = requireOwned(owner, libraryId)
  if (patch.name !== undefined) lib.name = checkText(patch.name, LIMITS.nameLen, 'library name')
  if (patch.note !== undefined) lib.note = checkText(patch.note, LIMITS.noteLen, 'library note')
  if (patch.visibility !== undefined && patch.visibility !== lib.visibility) {
    lib.visibility = patch.visibility
    if (patch.visibility === 'private') await revokePublicSubscriptions(lib.libraryId)   // Task 7; stub as no-op until then
  }
  await persistLibrary(lib)
  return lib
}
// Replaced in Task 7.
async function revokePublicSubscriptions(_libraryId: string): Promise<void> {}

export async function deleteLibrary(owner: string, libraryId: string): Promise<void> {
  const lib = requireOwned(owner, libraryId)
  if (lib.isPersonal) throw new UserDataError(403, 'The personal library cannot be deleted')
  libraries.delete(libraryId)
  byOwner.get(owner)?.delete(libraryId)
  await persistLibrary(lib, 1)
}

export async function createTag(owner: string, libraryId: string, def: { name: string; color?: string; icon?: string; note?: string }): Promise<UserTagDef> {
  const lib = requireOwned(owner, libraryId)
  if (lib.tags.size >= LIMITS.tagsPerLibrary) throw new UserDataError(422, `Limited to ${LIMITS.tagsPerLibrary} tags per library`)
  const tag: UserTagDef = {
    tagId: randomUUID(), name: checkText(def.name, LIMITS.nameLen, 'tag name'),
    color: checkText(def.color ?? '', 32, 'tag color'), icon: checkIcon(def.icon ?? ''),
    note: checkText(def.note ?? '', LIMITS.noteLen, 'tag note'), members: new Set(),
  }
  lib.tags.set(tag.tagId, tag)
  await persistTag(libraryId, tag)
  return tag
}

export async function updateTag(owner: string, libraryId: string, tagId: string, patch: { name?: string; color?: string; icon?: string; note?: string }): Promise<UserTagDef> {
  const lib = requireOwned(owner, libraryId)
  const tag = lib.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  if (patch.name !== undefined) tag.name = checkText(patch.name, LIMITS.nameLen, 'tag name')
  if (patch.color !== undefined) tag.color = checkText(patch.color, 32, 'tag color')
  if (patch.icon !== undefined) tag.icon = checkIcon(patch.icon)
  if (patch.note !== undefined) tag.note = checkText(patch.note, LIMITS.noteLen, 'tag note')
  await persistTag(libraryId, tag)
  return tag
}

export async function deleteTag(owner: string, libraryId: string, tagId: string): Promise<void> {
  const lib = requireOwned(owner, libraryId)
  const tag = lib.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  const members = [...tag.members]
  lib.tags.delete(tagId)
  for (const m of members) lib.memberTag.delete(m)
  await persistTag(libraryId, tag, 1)
  await persistMembers(libraryId, tagId, members, 1)
}

export async function setTagMembers(owner: string, libraryId: string, tagId: string, add: string[], remove: string[]): Promise<UserTagDef> {
  const lib = requireOwned(owner, libraryId)
  const tag = lib.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  const bad: string[] = []
  const addIds = add.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n?.accountId ?? '' }).filter(Boolean)
  const removeIds = remove.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n?.accountId ?? '' }).filter(Boolean)
  if (bad.length) throw new UserDataError(400, `Not valid addresses: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`)
  const trulyNew = addIds.filter(id => !tag.members.has(id))
  if (tag.members.size + trulyNew.length > LIMITS.membersPerTag) throw new UserDataError(422, `Limited to ${LIMITS.membersPerTag} accounts per tag`)
  const netNew = trulyNew.filter(id => !lib.memberTag.has(id))
  if (lib.memberTag.size + netNew.length > LIMITS.membersPerLibrary) throw new UserDataError(422, `Limited to ${LIMITS.membersPerLibrary} accounts per library`)

  // One tag per account per library: adding an account MOVES it out of its
  // current tag in this library (tombstoning that membership row).
  const moves = new Map<string, string[]>()   // fromTagId -> accountIds
  for (const id of trulyNew) {
    const from = lib.memberTag.get(id)
    if (from && from !== tagId) {
      lib.tags.get(from)?.members.delete(id)
      if (!moves.has(from)) moves.set(from, [])
      moves.get(from)!.push(id)
    }
    tag.members.add(id)
    lib.memberTag.set(id, tagId)
  }
  const removedHere = removeIds.filter(id => tag.members.delete(id))
  for (const id of removedHere) lib.memberTag.delete(id)

  await persistMembers(libraryId, tagId, trulyNew, 0)
  await persistMembers(libraryId, tagId, removedHere, 1)
  for (const [fromTag, ids] of moves) await persistMembers(libraryId, fromTag, ids, 1)
  return tag
}
