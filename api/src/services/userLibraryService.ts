import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { UserDataError } from './userProfileService.ts'
// explorerService.ts does not import this module (checked: no import cycle),
// so this stays a direct import rather than an init-time injected function.
import { resolveDisplayAccountId } from './explorerService.ts'

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

interface Subscription { status: 'invited' | 'active' | 'declined'; origin: 'invite' | 'public' }

export const SYSTEM_LIBRARY_ID = 'system'

let client: ClickHouseClient
const libraries = new Map<string, UserLibrary>()
const byOwner = new Map<string, Set<string>>()
const subsByLibrary = new Map<string, Map<string, Subscription>>()   // libraryId -> account -> sub
const subsByAccount = new Map<string, Set<string>>()                 // account -> libraryIds (any status)
const orderByAccount = new Map<string, string[]>()                   // raw stored arrays; resolution happens in libraryOrderFor

export function initUserLibraryService(c: ClickHouseClient): void {
  client = c; libraries.clear(); byOwner.clear(); subsByLibrary.clear(); subsByAccount.clear(); orderByAccount.clear()
}

export async function loadUserLibraries(): Promise<void> {
  libraries.clear(); byOwner.clear(); subsByLibrary.clear(); subsByAccount.clear(); orderByAccount.clear()
  const [libRes, tagRes, memberRes, subRes, orderRes] = [
    await client.query({ query: `SELECT library_id, owner_account_id, name, note, visibility, is_personal FROM price_data.user_libraries FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT library_id, tag_id, name, color, icon, note FROM price_data.user_tags FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT library_id, tag_id, account_id FROM price_data.user_tag_members FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT library_id, account_id, status, origin FROM price_data.user_library_subscriptions FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT account_id, library_ids FROM price_data.user_library_order FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
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
  for (const r of await subRes.json<{ library_id: string; account_id: string; status: string; origin: string }>()) {
    if (!libraries.has(r.library_id)) continue
    setSub(r.library_id, r.account_id, { status: r.status as Subscription['status'], origin: r.origin as Subscription['origin'] }, false)
  }
  for (const r of await orderRes.json<{ account_id: string; library_ids: string[] }>()) orderByAccount.set(r.account_id, r.library_ids)
}

export function getLibrary(libraryId: string): UserLibrary | null { return libraries.get(libraryId) ?? null }
export function ownedLibrariesFor(owner: string): LibrarySummary[] {
  return [...(byOwner.get(owner) ?? [])].map(id => librarySummary(libraries.get(id)!))
}
export function librarySummary(lib: UserLibrary): LibrarySummary {
  return {
    libraryId: lib.libraryId, name: lib.name, note: lib.note, visibility: lib.visibility, isPersonal: lib.isPersonal,
    ownerAccountId: lib.owner, tagCount: lib.tags.size, accountCount: lib.memberTag.size,
    subscriberCount: subscriberCountFor(lib.libraryId),
  }
}
async function setSub(libraryId: string, account: string, sub: Subscription | null, persist = true): Promise<void> {
  if (sub) {
    if (!subsByLibrary.has(libraryId)) subsByLibrary.set(libraryId, new Map())
    subsByLibrary.get(libraryId)!.set(account, sub)
    if (!subsByAccount.has(account)) subsByAccount.set(account, new Set())
    subsByAccount.get(account)!.add(libraryId)
  } else {
    subsByLibrary.get(libraryId)?.delete(account)
    subsByAccount.get(account)?.delete(libraryId)
  }
  if (!persist) return
  await client.insert({
    table: 'price_data.user_library_subscriptions',
    values: [{ library_id: libraryId, account_id: account, status: sub?.status ?? 'active', origin: sub?.origin ?? 'public', deleted: sub ? 0 : 1 }],
    format: 'JSONEachRow',
  })
}

function subscriberCountFor(libraryId: string): number {
  let n = 0
  for (const s of subsByLibrary.get(libraryId)?.values() ?? []) if (s.status === 'active') n++
  return n
}

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
    if (patch.visibility === 'private') await revokePublicSubscriptions(lib.libraryId)
  }
  await persistLibrary(lib)
  return lib
}
async function revokePublicSubscriptions(libraryId: string): Promise<void> {
  for (const [account, sub] of subsByLibrary.get(libraryId) ?? []) {
    if (sub.origin === 'public') await setSub(libraryId, account, null)
  }
}

export async function deleteLibrary(owner: string, libraryId: string): Promise<void> {
  const lib = requireOwned(owner, libraryId)
  if (lib.isPersonal) throw new UserDataError(403, 'The personal library cannot be deleted')
  libraries.delete(libraryId)
  byOwner.get(owner)?.delete(libraryId)
  for (const account of [...(subsByLibrary.get(libraryId)?.keys() ?? [])]) await setSub(libraryId, account, null)
  await persistLibrary(lib, 1)
}

export async function inviteToLibrary(owner: string, libraryId: string, grantee: string): Promise<void> {
  const lib = requireOwned(owner, libraryId)
  if (grantee === owner) throw new UserDataError(422, 'You already own this library')
  const existing = subsByLibrary.get(libraryId)?.get(grantee)
  if (existing?.status === 'active') return
  await setSub(lib.libraryId, grantee, { status: 'invited', origin: 'invite' })
}

export async function revokeShare(owner: string, libraryId: string, grantee: string): Promise<void> {
  requireOwned(owner, libraryId)
  await setSub(libraryId, grantee, null)
}

export async function respondToInvite(accountId: string, libraryId: string, accept: boolean): Promise<void> {
  const sub = subsByLibrary.get(libraryId)?.get(accountId)
  if (!sub || sub.status !== 'invited') throw new UserDataError(404, 'No pending invite')
  if (!accept) { await setSub(libraryId, accountId, null); return }
  if (activeSubscriptionCount(accountId) >= LIMITS.subscriptionsPerUser) throw new UserDataError(422, `Limited to ${LIMITS.subscriptionsPerUser} subscriptions`)
  await setSub(libraryId, accountId, { status: 'active', origin: 'invite' })
}

export async function subscribePublic(accountId: string, libraryId: string): Promise<void> {
  const lib = libraries.get(libraryId)
  if (!lib) throw new UserDataError(404, 'Library not found')
  if (lib.owner === accountId) throw new UserDataError(422, 'You already own this library')
  if (lib.visibility !== 'public') throw new UserDataError(403, 'This library is not public')
  const existing = subsByLibrary.get(libraryId)?.get(accountId)
  if (existing?.status === 'active') return
  if (activeSubscriptionCount(accountId) >= LIMITS.subscriptionsPerUser) throw new UserDataError(422, `Limited to ${LIMITS.subscriptionsPerUser} subscriptions`)
  await setSub(libraryId, accountId, { status: 'active', origin: existing?.origin === 'invite' ? 'invite' : 'public' })
}

export async function unsubscribe(accountId: string, libraryId: string): Promise<void> {
  const sub = subsByLibrary.get(libraryId)?.get(accountId)
  if (!sub || sub.status !== 'active') throw new UserDataError(404, 'Not subscribed')
  await setSub(libraryId, accountId, null)
}

function activeSubscriptionCount(accountId: string): number {
  let n = 0
  for (const libId of subsByAccount.get(accountId) ?? []) if (subsByLibrary.get(libId)?.get(accountId)?.status === 'active') n++
  return n
}

// The aggregate-view seam: everything a tag's own combined portfolio/activity page
// needs, gated by the SAME rule libraryDetailResponse's tag contents use — owner or
// active subscriber, never mere public visibility. A public library still hides its
// curation from a viewer who hasn't subscribed (see libraryDetailResponse's comment);
// this is the same privacy boundary applied to the aggregate page rather than the
// management page. Returns null for "not visible or missing" so the route can answer
// both with the same 404 — a private library's tag and an unknown one must be
// indistinguishable from outside.
export function visibleTagMembers(viewer: string, libraryId: string, tagId: string): { name: string; color: string; icon: string; note: string; members: string[] } | null {
  const lib = libraries.get(libraryId)
  if (!lib) return null
  const isOwner = lib.owner === viewer
  const isActiveSubscriber = subsByLibrary.get(libraryId)?.get(viewer)?.status === 'active'
  if (!isOwner && !isActiveSubscriber) return null
  const tag = lib.tags.get(tagId)
  if (!tag) return null
  return { name: tag.name, color: tag.color, icon: tag.icon, note: tag.note, members: [...tag.members] }
}

export function invitesFor(accountId: string): LibrarySummary[] {
  const out: LibrarySummary[] = []
  for (const libId of subsByAccount.get(accountId) ?? []) {
    if (subsByLibrary.get(libId)?.get(accountId)?.status !== 'invited') continue
    const lib = libraries.get(libId)
    if (lib) out.push(librarySummary(lib))
  }
  return out
}

export function subscriptionsFor(accountId: string): LibrarySummary[] {
  const out: LibrarySummary[] = []
  for (const libId of subsByAccount.get(accountId) ?? []) {
    if (subsByLibrary.get(libId)?.get(accountId)?.status !== 'active') continue
    const lib = libraries.get(libId)
    if (lib) out.push(librarySummary(lib))
  }
  return out
}

// Who may READ a library's contents: its owner, an active subscriber, or —
// for public libraries — anyone.
export function canView(accountId: string, libraryId: string): boolean {
  const lib = libraries.get(libraryId)
  if (!lib) return false
  if (lib.visibility === 'public') return true
  if (lib.owner === accountId) return true
  return subsByLibrary.get(libraryId)?.get(accountId)?.status === 'active'
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
  // Canonicalize exactly like login/accountRef: a bound-EVM member must be
  // stored under the SAME accountId pills carry, or a tag on a bound-EVM
  // account never matches any pill on the page.
  const addIds = add.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n ? resolveDisplayAccountId(n.accountId) : '' }).filter(Boolean)
  const removeIds = remove.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n ? resolveDisplayAccountId(n.accountId) : '' }).filter(Boolean)
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

export async function setLibraryOrder(accountId: string, libraryIds: string[]): Promise<string[]> {
  if (libraryIds.length > 500) throw new UserDataError(422, 'Order list too long')
  orderByAccount.set(accountId, libraryIds)
  await client.insert({ table: 'price_data.user_library_order', values: [{ account_id: accountId, library_ids: libraryIds, deleted: 0 }], format: 'JSONEachRow' })
  return libraryOrderFor(accountId)
}

// The RESOLVED order: stored entries that are still visible (or 'system'),
// then everything visible-but-unlisted — personal first, 'system' next (when
// unlisted), then subscription/creation order. Stale stored ids vanish here,
// never at write time, so a revoked-then-reshared library keeps its old slot.
export function libraryOrderFor(accountId: string): string[] {
  const visible = visibleLibraryIds(accountId)
  const stored = orderByAccount.get(accountId) ?? []
  const out: string[] = []
  for (const id of stored) {
    if (id === SYSTEM_LIBRARY_ID || visible.has(id)) { out.push(id); visible.delete(id) }
  }
  if (!stored.includes(SYSTEM_LIBRARY_ID)) {
    // unlisted defaults: personal ahead of system, everything else after
    const personal = [...visible].find(id => libraries.get(id)?.isPersonal && libraries.get(id)?.owner === accountId)
    if (personal) { out.push(personal); visible.delete(personal) }
    out.push(SYSTEM_LIBRARY_ID)
  }
  out.push(...visible)
  return out
}

function visibleLibraryIds(accountId: string): Set<string> {
  const ids = new Set<string>(byOwner.get(accountId) ?? [])
  for (const libId of subsByAccount.get(accountId) ?? []) {
    if (subsByLibrary.get(libId)?.get(accountId)?.status === 'active' && libraries.has(libId)) ids.add(libId)
  }
  return ids
}

export function visibleLibrariesFor(accountId: string): UserLibrary[] {
  return libraryOrderFor(accountId).filter(id => id !== SYSTEM_LIBRARY_ID).map(id => libraries.get(id)!).filter(Boolean)
}

export interface TagMapLibrary { libraryId: string; name: string; tags: { tagId: string; name: string; color: string; icon: string; members: string[] }[] }

// One payload with everything the client needs to resolve labels: every
// visible library in priority order, tags with member account-ids. The
// 'system' slot is a marker — the client already has the system tag on each
// accountRef, so shipping members again would be pure duplication.
export function tagMapFor(accountId: string): TagMapLibrary[] {
  return libraryOrderFor(accountId).map(id => {
    if (id === SYSTEM_LIBRARY_ID) return { libraryId: SYSTEM_LIBRARY_ID, name: 'Hydration', tags: [] }
    const lib = libraries.get(id)!
    return {
      libraryId: lib.libraryId, name: lib.name,
      tags: [...lib.tags.values()].map(t => ({ tagId: t.tagId, name: t.name, color: t.color, icon: t.icon, members: [...t.members] })),
    }
  })
}

export function publicLibraries(): LibrarySummary[] {
  return [...libraries.values()].filter(l => l.visibility === 'public').map(librarySummary)
    .sort((a, b) => b.subscriberCount - a.subscriberCount || a.name.localeCompare(b.name))
}
export function publicLibrariesByOwner(owner: string): LibrarySummary[] {
  return ownedLibrariesFor(owner).filter(l => l.visibility === 'public')
}
