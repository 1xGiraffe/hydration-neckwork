import { randomUUID } from 'node:crypto'
import type { ClickHouseClient } from '../db/client.ts'
import { normalizeAddress } from './addressIdentity.ts'
import { UserDataError, profileForAccount } from './userProfileService.ts'
import { accountIcon } from './omniwatchIdentity.ts'
// explorerService.ts does not import this module (checked: no import cycle),
// so this stays a direct import rather than an init-time injected function.
import { resolveDisplayAccountId } from './explorerService.ts'

// User tag lists: named collections of tags, each tag holding member
// accounts. Owned by one account; shareable by invite or publicly (Task 7);
// prioritized per viewer (Task 8). The api process is the single writer —
// these maps ARE the model, ClickHouse is their durability. Every mutation
// updates memory first, then persists; every row uses the ReplacingMergeTree
// soft-delete idiom (insert with deleted=1 to remove).

// `members` stays a Set for O(1) has/add/delete (the one-tag-per-account-per-
// list move check does this on every write); `order` is the same
// membership as a display-ordered array, the only field a drag/keyboard
// reorder actually changes. `nextPosition` is a monotonic per-tag counter
// (never rewound by a removal — see setTagMembers) so an appended member
// always sorts after every row already persisted, exactly like
// userProfileService's avatarCounter avoids reissuing a stale version.
export interface UserTagDef { tagId: string; name: string; color: string; icon: string; note: string; members: Set<string>; order: string[]; nextPosition: number }
export interface UserList {
  listId: string; owner: string; name: string; note: string
  visibility: 'private' | 'public'; isPersonal: boolean
  tags: Map<string, UserTagDef>
  memberTag: Map<string, string>
}
export interface ListSummary {
  listId: string; name: string; note: string; visibility: 'private' | 'public'; isPersonal: boolean
  ownerAccountId: string; tagCount: number; accountCount: number; subscriberCount: number
}

export const LIMITS = {
  listsPerUser: 50, tagsPerList: 200, membersPerTag: 2_000, membersPerList: 20_000,
  subscriptionsPerUser: 200, nameLen: 48, noteLen: 280,
} as const

interface Subscription { status: 'invited' | 'active' | 'declined'; origin: 'invite' | 'public' }

export const SYSTEM_LIST_ID = 'system'

let client: ClickHouseClient
const lists = new Map<string, UserList>()
const byOwner = new Map<string, Set<string>>()
const subsByList = new Map<string, Map<string, Subscription>>()   // listId -> account -> sub
const subsByAccount = new Map<string, Set<string>>()                 // account -> listIds (any status)
const orderByAccount = new Map<string, string[]>()                   // raw stored arrays; resolution happens in listOrderFor

export function initUserListService(c: ClickHouseClient): void {
  client = c; lists.clear(); byOwner.clear(); subsByList.clear(); subsByAccount.clear(); orderByAccount.clear()
}

// AGENTS.md's idempotent-schema rule: `CREATE TABLE IF NOT EXISTS` never
// re-runs the declaration in `clickhouse/schema/004_user.sql` against a
// database that already has the table, so a column added to that
// declaration (here: `position`) needs its own guard to reach a database
// created before the column existed. `ADD COLUMN IF NOT EXISTS` is
// metadata-only on MergeTree (instant regardless of table size) and old
// parts read the missing column as its `DEFAULT 0`, so this is safe and
// cheap to run unconditionally on every start — called once from the
// server bootstrap, before loadUserLists() first SELECTs `position`.
export async function ensureTagMemberPositionColumn(c: ClickHouseClient): Promise<void> {
  await c.command({ query: `ALTER TABLE price_data.user_tag_members ADD COLUMN IF NOT EXISTS position UInt32 DEFAULT 0` })
}

export async function loadUserLists(): Promise<void> {
  lists.clear(); byOwner.clear(); subsByList.clear(); subsByAccount.clear(); orderByAccount.clear()
  const [listRes, tagRes, memberRes, subRes, orderRes] = [
    await client.query({ query: `SELECT list_id, owner_account_id, name, note, visibility, is_personal FROM price_data.user_lists FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT list_id, tag_id, name, color, icon, note FROM price_data.user_tags FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT list_id, tag_id, account_id, position FROM price_data.user_tag_members FINAL WHERE deleted = 0 ORDER BY list_id, tag_id, position, account_id`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT list_id, account_id, status, origin FROM price_data.user_list_subscriptions FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
    await client.query({ query: `SELECT account_id, list_ids FROM price_data.user_list_order FINAL WHERE deleted = 0`, format: 'JSONEachRow' }),
  ]
  for (const r of await listRes.json<{ list_id: string; owner_account_id: string; name: string; note: string; visibility: string; is_personal: number }>()) {
    const list: UserList = {
      listId: r.list_id, owner: r.owner_account_id, name: r.name, note: r.note ?? '',
      visibility: r.visibility === 'public' ? 'public' : 'private', isPersonal: r.is_personal === 1,
      tags: new Map(), memberTag: new Map(),
    }
    lists.set(list.listId, list)
    if (!byOwner.has(list.owner)) byOwner.set(list.owner, new Set())
    byOwner.get(list.owner)!.add(list.listId)
  }
  for (const r of await tagRes.json<{ list_id: string; tag_id: string; name: string; color: string; icon: string; note: string }>()) {
    lists.get(r.list_id)?.tags.set(r.tag_id, { tagId: r.tag_id, name: r.name, color: r.color ?? '', icon: r.icon ?? '', note: r.note ?? '', members: new Set(), order: [], nextPosition: 0 })
  }
  // The SQL ORDER BY above already sorts by position, but a re-sort here
  // costs nothing at this table's size and keeps correctness independent of
  // the query text — every row a pre-migration deployment left at the
  // column's DEFAULT 0 still comes out in a deterministic (tag, account)
  // order rather than whatever order ClickHouse happened to return them in.
  const memberRows = [...await memberRes.json<{ list_id: string; tag_id: string; account_id: string; position: number }>()]
    .sort((a, b) => a.list_id.localeCompare(b.list_id) || a.tag_id.localeCompare(b.tag_id) || Number(a.position) - Number(b.position) || a.account_id.localeCompare(b.account_id))
  const maxPositionByTag = new Map<UserTagDef, number>()
  for (const r of memberRows) {
    const list = lists.get(r.list_id)
    const tag = list?.tags.get(r.tag_id)
    if (!list || !tag) continue
    tag.members.add(r.account_id)
    tag.order.push(r.account_id)
    list.memberTag.set(r.account_id, r.tag_id)
    maxPositionByTag.set(tag, Math.max(maxPositionByTag.get(tag) ?? -1, Number(r.position)))
  }
  for (const [tag, maxPosition] of maxPositionByTag) tag.nextPosition = maxPosition + 1
  for (const r of await subRes.json<{ list_id: string; account_id: string; status: string; origin: string }>()) {
    if (!lists.has(r.list_id)) continue
    setSub(r.list_id, r.account_id, { status: r.status as Subscription['status'], origin: r.origin as Subscription['origin'] }, false)
  }
  for (const r of await orderRes.json<{ account_id: string; list_ids: string[] }>()) orderByAccount.set(r.account_id, r.list_ids)
}

export function getList(listId: string): UserList | null { return lists.get(listId) ?? null }
export function ownedListsFor(owner: string): ListSummary[] {
  return [...(byOwner.get(owner) ?? [])].map(id => listSummary(lists.get(id)!))
}
export function listSummary(list: UserList): ListSummary {
  return {
    listId: list.listId, name: list.name, note: list.note, visibility: list.visibility, isPersonal: list.isPersonal,
    ownerAccountId: list.owner, tagCount: list.tags.size, accountCount: list.memberTag.size,
    subscriberCount: subscriberCountFor(list.listId),
  }
}
async function setSub(listId: string, account: string, sub: Subscription | null, persist = true): Promise<void> {
  if (sub) {
    if (!subsByList.has(listId)) subsByList.set(listId, new Map())
    subsByList.get(listId)!.set(account, sub)
    if (!subsByAccount.has(account)) subsByAccount.set(account, new Set())
    subsByAccount.get(account)!.add(listId)
  } else {
    subsByList.get(listId)?.delete(account)
    subsByAccount.get(account)?.delete(listId)
  }
  if (!persist) return
  await client.insert({
    table: 'price_data.user_list_subscriptions',
    values: [{ list_id: listId, account_id: account, status: sub?.status ?? 'active', origin: sub?.origin ?? 'public', deleted: sub ? 0 : 1 }],
    format: 'JSONEachRow',
  })
}

function subscriberCountFor(listId: string): number {
  let n = 0
  for (const s of subsByList.get(listId)?.values() ?? []) if (s.status === 'active') n++
  return n
}

// Owner-only view of a list's subscription state (Subscribers tab): every
// account with a live invite or an active subscription, in the order they were
// first shared with. 'declined' is filtered defensively for Subscription's full
// status union — in practice respondToInvite(..., false) deletes the entry via
// setSub(..., null) rather than ever persisting 'declined', so this never
// actually sees one today, but a future caller that DID record a declined
// status rather than deleting it must not leak it here.
export function sharesFor(listId: string): { accountId: string; status: 'invited' | 'active' }[] {
  const out: { accountId: string; status: 'invited' | 'active' }[] = []
  for (const [account, sub] of subsByList.get(listId) ?? []) {
    if (sub.status === 'declined') continue
    out.push({ accountId: account, status: sub.status })
  }
  return out
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

// Mirrors tagService.ts's iconFor for SYSTEM tags: an unset icon derives from
// the first member (by display order, so a drag reorder can change which
// member's face a tag shows) rather than rendering a blank pill. A user
// list's first member is far more likely to be another explorer user than
// a system tag's is, so this adds one precedence step ahead of the emoji
// derivation — their own uploaded profile avatar. checkIcon above still keeps
// an EXPLICITLY set icon emoji-only (v1's no-third-party-URL rule); this only
// ever fires when the owner left the icon unset, so it never conflicts.
export function tagDisplayIcon(icon: string, order: string[]): string {
  if (icon) return icon
  const first = order[0]
  if (!first) return '🏷️'
  const profile = profileForAccount(first)
  if (profile && profile.avatarVersion > 0) return `/api/explorer/profile-avatar/${first}?v=${profile.avatarVersion}`
  const memberIcon = accountIcon(first)
  return memberIcon.emojiUrl || memberIcon.emoji
}

function requireOwned(owner: string, listId: string): UserList {
  const list = lists.get(listId)
  if (!list) throw new UserDataError(404, 'List not found')
  if (list.owner !== owner) throw new UserDataError(403, 'Not your list')
  return list
}

async function persistList(list: UserList, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_lists',
    values: [{ list_id: list.listId, owner_account_id: list.owner, name: list.name, note: list.note, visibility: list.visibility, is_personal: list.isPersonal ? 1 : 0, deleted }],
    format: 'JSONEachRow',
  })
}
async function persistTag(listId: string, tag: UserTagDef, deleted = 0): Promise<void> {
  await client.insert({
    table: 'price_data.user_tags',
    values: [{ list_id: listId, tag_id: tag.tagId, name: tag.name, color: tag.color, icon: tag.icon, note: tag.note, deleted }],
    format: 'JSONEachRow',
  })
}
// `position` is meaningless on a tombstone (deleted=1) row — nothing ever
// reads it back once `deleted = 0` is filtered out on load — so removal/move
// callers just pass 0. An add or reorder always passes the real slot.
async function persistMembers(listId: string, tagId: string, rows: { accountId: string; position: number }[], deleted: number): Promise<void> {
  if (!rows.length) return
  await client.insert({
    table: 'price_data.user_tag_members',
    values: rows.map(({ accountId, position }) => ({ list_id: listId, tag_id: tagId, account_id: accountId, position, deleted })),
    format: 'JSONEachRow',
  })
}
const tombstoneRows = (accountIds: string[]) => accountIds.map(accountId => ({ accountId, position: 0 }))

function addList(list: UserList): void {
  lists.set(list.listId, list)
  if (!byOwner.has(list.owner)) byOwner.set(list.owner, new Set())
  byOwner.get(list.owner)!.add(list.listId)
}

export async function ensurePersonalList(accountId: string): Promise<UserList> {
  const existing = [...(byOwner.get(accountId) ?? [])].map(id => lists.get(id)!).find(l => l.isPersonal)
  if (existing) return existing
  const list: UserList = { listId: randomUUID(), owner: accountId, name: 'Personal', note: '', visibility: 'private', isPersonal: true, tags: new Map(), memberTag: new Map() }
  addList(list)
  await persistList(list)
  return list
}

export async function createList(owner: string, name: string, note: string, visibility: 'private' | 'public'): Promise<UserList> {
  if ((byOwner.get(owner)?.size ?? 0) >= LIMITS.listsPerUser) throw new UserDataError(422, `Limited to ${LIMITS.listsPerUser} lists`)
  const list: UserList = {
    listId: randomUUID(), owner, name: checkText(name, LIMITS.nameLen, 'list name'),
    note: checkText(note, LIMITS.noteLen, 'list note'), visibility, isPersonal: false, tags: new Map(), memberTag: new Map(),
  }
  addList(list)
  await persistList(list)
  return list
}

export async function updateList(owner: string, listId: string, patch: { name?: string; note?: string; visibility?: 'private' | 'public' }): Promise<UserList> {
  const list = requireOwned(owner, listId)
  if (patch.name !== undefined) list.name = checkText(patch.name, LIMITS.nameLen, 'list name')
  if (patch.note !== undefined) list.note = checkText(patch.note, LIMITS.noteLen, 'list note')
  if (patch.visibility !== undefined && patch.visibility !== list.visibility) {
    list.visibility = patch.visibility
    if (patch.visibility === 'private') await revokePublicSubscriptions(list.listId)
  }
  await persistList(list)
  return list
}
async function revokePublicSubscriptions(listId: string): Promise<void> {
  for (const [account, sub] of subsByList.get(listId) ?? []) {
    if (sub.origin === 'public') await setSub(listId, account, null)
  }
}

export async function deleteList(owner: string, listId: string): Promise<void> {
  const list = requireOwned(owner, listId)
  if (list.isPersonal) throw new UserDataError(403, 'The personal list cannot be deleted')
  lists.delete(listId)
  byOwner.get(owner)?.delete(listId)
  for (const account of [...(subsByList.get(listId)?.keys() ?? [])]) await setSub(listId, account, null)
  await persistList(list, 1)
}

export async function inviteToList(owner: string, listId: string, grantee: string): Promise<void> {
  const list = requireOwned(owner, listId)
  if (grantee === owner) throw new UserDataError(422, 'You already own this list')
  const existing = subsByList.get(listId)?.get(grantee)
  if (existing?.status === 'active') return
  await setSub(list.listId, grantee, { status: 'invited', origin: 'invite' })
}

export async function revokeShare(owner: string, listId: string, grantee: string): Promise<void> {
  requireOwned(owner, listId)
  await setSub(listId, grantee, null)
}

export async function respondToInvite(accountId: string, listId: string, accept: boolean): Promise<void> {
  const sub = subsByList.get(listId)?.get(accountId)
  if (!sub || sub.status !== 'invited') throw new UserDataError(404, 'No pending invite')
  if (!accept) { await setSub(listId, accountId, null); return }
  if (activeSubscriptionCount(accountId) >= LIMITS.subscriptionsPerUser) throw new UserDataError(422, `Limited to ${LIMITS.subscriptionsPerUser} subscriptions`)
  await setSub(listId, accountId, { status: 'active', origin: 'invite' })
}

export async function subscribePublic(accountId: string, listId: string): Promise<void> {
  const list = lists.get(listId)
  if (!list) throw new UserDataError(404, 'List not found')
  if (list.owner === accountId) throw new UserDataError(422, 'You already own this list')
  if (list.visibility !== 'public') throw new UserDataError(403, 'This list is not public')
  const existing = subsByList.get(listId)?.get(accountId)
  if (existing?.status === 'active') return
  if (activeSubscriptionCount(accountId) >= LIMITS.subscriptionsPerUser) throw new UserDataError(422, `Limited to ${LIMITS.subscriptionsPerUser} subscriptions`)
  await setSub(listId, accountId, { status: 'active', origin: existing?.origin === 'invite' ? 'invite' : 'public' })
}

export async function unsubscribe(accountId: string, listId: string): Promise<void> {
  const sub = subsByList.get(listId)?.get(accountId)
  if (!sub || sub.status !== 'active') throw new UserDataError(404, 'Not subscribed')
  await setSub(listId, accountId, null)
}

function activeSubscriptionCount(accountId: string): number {
  let n = 0
  for (const listId of subsByAccount.get(accountId) ?? []) if (subsByList.get(listId)?.get(accountId)?.status === 'active') n++
  return n
}

// The aggregate-view seam: everything a tag's own combined portfolio/activity page
// needs, gated by the SAME rule listDetailResponse's tag contents use — owner or
// active subscriber, never mere public visibility. A public list still hides its
// curation from a viewer who hasn't subscribed (see listDetailResponse's comment);
// this is the same privacy boundary applied to the aggregate page rather than the
// management page. Returns null for "not visible or missing" so the route can answer
// both with the same 404 — a private list's tag and an unknown one must be
// indistinguishable from outside.
export function visibleTagMembers(viewer: string, listId: string, tagId: string): { name: string; color: string; icon: string; note: string; members: string[] } | null {
  const list = lists.get(listId)
  if (!list) return null
  const isOwner = list.owner === viewer
  const isActiveSubscriber = subsByList.get(listId)?.get(viewer)?.status === 'active'
  if (!isOwner && !isActiveSubscriber) return null
  const tag = list.tags.get(tagId)
  if (!tag) return null
  return { name: tag.name, color: tag.color, icon: tagDisplayIcon(tag.icon, tag.order), note: tag.note, members: [...tag.order] }
}

export function invitesFor(accountId: string): ListSummary[] {
  const out: ListSummary[] = []
  for (const listId of subsByAccount.get(accountId) ?? []) {
    if (subsByList.get(listId)?.get(accountId)?.status !== 'invited') continue
    const list = lists.get(listId)
    if (list) out.push(listSummary(list))
  }
  return out
}

export function subscriptionsFor(accountId: string): ListSummary[] {
  const out: ListSummary[] = []
  for (const listId of subsByAccount.get(accountId) ?? []) {
    if (subsByList.get(listId)?.get(accountId)?.status !== 'active') continue
    const list = lists.get(listId)
    if (list) out.push(listSummary(list))
  }
  return out
}

// Who may READ a list's contents: its owner, an active subscriber, or —
// for public lists — anyone.
export function canView(accountId: string, listId: string): boolean {
  const list = lists.get(listId)
  if (!list) return false
  if (list.visibility === 'public') return true
  if (list.owner === accountId) return true
  return subsByList.get(listId)?.get(accountId)?.status === 'active'
}

export async function createTag(owner: string, listId: string, def: { name: string; color?: string; icon?: string; note?: string }): Promise<UserTagDef> {
  const list = requireOwned(owner, listId)
  if (list.tags.size >= LIMITS.tagsPerList) throw new UserDataError(422, `Limited to ${LIMITS.tagsPerList} tags per list`)
  const tag: UserTagDef = {
    tagId: randomUUID(), name: checkText(def.name, LIMITS.nameLen, 'tag name'),
    color: checkText(def.color ?? '', 32, 'tag color'), icon: checkIcon(def.icon ?? ''),
    note: checkText(def.note ?? '', LIMITS.noteLen, 'tag note'), members: new Set(), order: [], nextPosition: 0,
  }
  list.tags.set(tag.tagId, tag)
  await persistTag(listId, tag)
  return tag
}

export async function updateTag(owner: string, listId: string, tagId: string, patch: { name?: string; color?: string; icon?: string; note?: string }): Promise<UserTagDef> {
  const list = requireOwned(owner, listId)
  const tag = list.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  if (patch.name !== undefined) tag.name = checkText(patch.name, LIMITS.nameLen, 'tag name')
  if (patch.color !== undefined) tag.color = checkText(patch.color, 32, 'tag color')
  if (patch.icon !== undefined) tag.icon = checkIcon(patch.icon)
  if (patch.note !== undefined) tag.note = checkText(patch.note, LIMITS.noteLen, 'tag note')
  await persistTag(listId, tag)
  return tag
}

export async function deleteTag(owner: string, listId: string, tagId: string): Promise<void> {
  const list = requireOwned(owner, listId)
  const tag = list.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  const members = [...tag.order]
  list.tags.delete(tagId)
  for (const m of members) list.memberTag.delete(m)
  await persistTag(listId, tag, 1)
  await persistMembers(listId, tagId, tombstoneRows(members), 1)
}

export async function setTagMembers(owner: string, listId: string, tagId: string, add: string[], remove: string[]): Promise<UserTagDef> {
  const list = requireOwned(owner, listId)
  const tag = list.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  const bad: string[] = []
  // Canonicalize exactly like login/accountRef: a bound-EVM member must be
  // stored under the SAME accountId pills carry, or a tag on a bound-EVM
  // account never matches any pill on the page.
  // Deduped: `trulyNew` below filters against the PRE-mutation Set, so a
  // caller-supplied duplicate (e.g. a double-submitted `add`) would otherwise
  // pass the "not already a member" check twice and get pushed into `order`
  // (and persisted with two different positions) for one Set entry — order
  // and membership silently desync until the next full reload.
  const addIds = [...new Set(add.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n ? resolveDisplayAccountId(n.accountId) : '' }).filter(Boolean))]
  const removeIds = [...new Set(remove.map(a => { const n = normalizeAddress(a); if (!n) bad.push(a); return n ? resolveDisplayAccountId(n.accountId) : '' }).filter(Boolean))]
  if (bad.length) throw new UserDataError(400, `Not valid addresses: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}`)
  const trulyNew = addIds.filter(id => !tag.members.has(id))
  if (tag.members.size + trulyNew.length > LIMITS.membersPerTag) throw new UserDataError(422, `Limited to ${LIMITS.membersPerTag} accounts per tag`)
  const netNew = trulyNew.filter(id => !list.memberTag.has(id))
  if (list.memberTag.size + netNew.length > LIMITS.membersPerList) throw new UserDataError(422, `Limited to ${LIMITS.membersPerList} accounts per list`)

  // One tag per account per list: adding an account MOVES it out of its
  // current tag in this list (tombstoning that membership row). New
  // members always land at the END of display order, at a position past
  // every row already persisted for this tag (see UserTagDef.nextPosition).
  const moves = new Map<string, string[]>()   // fromTagId -> accountIds
  const added: { accountId: string; position: number }[] = []
  for (const id of trulyNew) {
    const from = list.memberTag.get(id)
    if (from && from !== tagId) {
      const fromTag = list.tags.get(from)
      if (fromTag) { fromTag.members.delete(id); fromTag.order = fromTag.order.filter(m => m !== id) }
      if (!moves.has(from)) moves.set(from, [])
      moves.get(from)!.push(id)
    }
    tag.members.add(id)
    tag.order.push(id)
    added.push({ accountId: id, position: tag.nextPosition++ })
    list.memberTag.set(id, tagId)
  }
  const removedHere = removeIds.filter(id => tag.members.delete(id))
  if (removedHere.length) {
    const removedSet = new Set(removedHere)
    tag.order = tag.order.filter(id => !removedSet.has(id))
  }
  for (const id of removedHere) list.memberTag.delete(id)

  await persistMembers(listId, tagId, added, 0)
  await persistMembers(listId, tagId, tombstoneRows(removedHere), 1)
  for (const [fromTag, ids] of moves) await persistMembers(listId, fromTag, tombstoneRows(ids), 1)
  return tag
}

// Owner-only reorder: `accountIds` must name exactly the tag's current
// members, once each — a client-computed drag/keyboard order that dropped or
// duplicated an id would silently corrupt the tag's membership, so this
// rejects anything that isn't a permutation instead of best-effort applying
// it. Every row is re-inserted with its new position — ReplacingMergeTree
// replaces by (list_id, tag_id, account_id), so this is a full rewrite of
// the tag's positions, not an addition — and `nextPosition` resets to the
// list length so the next plain append still lands after every reordered row.
export async function setMemberOrder(owner: string, listId: string, tagId: string, accountIds: string[]): Promise<UserTagDef> {
  const list = requireOwned(owner, listId)
  const tag = list.tags.get(tagId)
  if (!tag) throw new UserDataError(404, 'Tag not found')
  const seen = new Set<string>()
  const isPermutation = accountIds.length === tag.members.size && accountIds.every(id => tag.members.has(id) && !seen.has(id) && seen.add(id))
  if (!isPermutation) throw new UserDataError(400, 'Member order must list every current member exactly once')
  tag.order = [...accountIds]
  tag.nextPosition = accountIds.length
  await persistMembers(listId, tagId, accountIds.map((accountId, position) => ({ accountId, position })), 0)
  return tag
}

export async function setListOrder(accountId: string, listIds: string[]): Promise<string[]> {
  if (listIds.length > 500) throw new UserDataError(422, 'Order list too long')
  orderByAccount.set(accountId, listIds)
  await client.insert({ table: 'price_data.user_list_order', values: [{ account_id: accountId, list_ids: listIds, deleted: 0 }], format: 'JSONEachRow' })
  return listOrderFor(accountId)
}

// The RESOLVED order: stored entries that are still visible (or 'system'),
// then everything visible-but-unlisted — personal first, 'system' next (when
// unlisted), then subscription/creation order. Stale stored ids vanish here,
// never at write time, so a revoked-then-reshared list keeps its old slot.
export function listOrderFor(accountId: string): string[] {
  const visible = visibleListIds(accountId)
  const stored = orderByAccount.get(accountId) ?? []
  const out: string[] = []
  for (const id of stored) {
    if (id === SYSTEM_LIST_ID || visible.has(id)) { out.push(id); visible.delete(id) }
  }
  if (!stored.includes(SYSTEM_LIST_ID)) {
    // unlisted defaults: personal ahead of system, everything else after
    const personal = [...visible].find(id => lists.get(id)?.isPersonal && lists.get(id)?.owner === accountId)
    if (personal) { out.push(personal); visible.delete(personal) }
    out.push(SYSTEM_LIST_ID)
  }
  out.push(...visible)
  return out
}

function visibleListIds(accountId: string): Set<string> {
  const ids = new Set<string>(byOwner.get(accountId) ?? [])
  for (const listId of subsByAccount.get(accountId) ?? []) {
    if (subsByList.get(listId)?.get(accountId)?.status === 'active' && lists.has(listId)) ids.add(listId)
  }
  return ids
}

export function visibleListsFor(accountId: string): UserList[] {
  return listOrderFor(accountId).filter(id => id !== SYSTEM_LIST_ID).map(id => lists.get(id)!).filter(Boolean)
}

export interface TagMapList { listId: string; name: string; tags: { tagId: string; name: string; color: string; icon: string; members: string[] }[] }

// One payload with everything the client needs to resolve labels: every
// visible list in priority order, tags with member account-ids. The
// 'system' slot is a marker — the client already has the system tag on each
// accountRef, so shipping members again would be pure duplication.
export function tagMapFor(accountId: string): TagMapList[] {
  return listOrderFor(accountId).map(id => {
    if (id === SYSTEM_LIST_ID) return { listId: SYSTEM_LIST_ID, name: 'Hydration', tags: [] }
    const list = lists.get(id)!
    return {
      listId: list.listId, name: list.name,
      tags: [...list.tags.values()].map(t => ({ tagId: t.tagId, name: t.name, color: t.color, icon: tagDisplayIcon(t.icon, t.order), members: [...t.order] })),
    }
  })
}

export function publicLists(): ListSummary[] {
  return [...lists.values()].filter(l => l.visibility === 'public').map(listSummary)
    .sort((a, b) => b.subscriberCount - a.subscriberCount || a.name.localeCompare(b.name))
}
export function publicListsByOwner(owner: string): ListSummary[] {
  return ownedListsFor(owner).filter(l => l.visibility === 'public')
}
