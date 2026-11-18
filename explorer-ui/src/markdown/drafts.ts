// Unsent forum text, kept in this browser only (localStorage) so a reload, a closed
// tab or a failed post never loses what someone wrote. Keyed per account and place
// ('forum-draft:<account or anon>|<key>', the key naming the thread or form —
// `scopedDraftKey`), dated, and discarded after DRAFT_MAX_AGE_MS. One account's
// drafts are never offered to another signed in on the same browser, and logging out
// clears the account's drafts (`clearAccountDrafts`). Drafts never leave the browser.

import { getSession } from '../session'

export const DRAFT_PREFIX = 'forum-draft:'
export const DRAFT_MAX_AGE_MS = 30 * 24 * 3600_000
/** A draft larger than any body the forum accepts is not worth keeping (and could fill the quota). */
const DRAFT_MAX_CHARS = 60_000

export interface Draft { text: string; savedAt: number }

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function defaultStore(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** Saves a draft; empty (or whitespace-only) text removes it. */
export function saveDraft(key: string, text: string, store: Store | null = defaultStore(), now = Date.now()): void {
  if (!store) return
  try {
    if (!text.trim()) { store.removeItem(DRAFT_PREFIX + key); return }
    store.setItem(DRAFT_PREFIX + key, JSON.stringify({ text: text.slice(0, DRAFT_MAX_CHARS), savedAt: now }))
  } catch { /* storage full or blocked: the draft lives only in the page */ }
}

/** The stored draft, or null — an expired or malformed one is removed on read. */
export function loadDraft(key: string, store: Store | null = defaultStore(), now = Date.now()): Draft | null {
  if (!store) return null
  try {
    const raw = store.getItem(DRAFT_PREFIX + key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Draft>
    if (typeof v?.text !== 'string' || typeof v.savedAt !== 'number' || !v.text.trim() || now - v.savedAt > DRAFT_MAX_AGE_MS) {
      store.removeItem(DRAFT_PREFIX + key)
      return null
    }
    return { text: v.text, savedAt: v.savedAt }
  } catch {
    try { store.removeItem(DRAFT_PREFIX + key) } catch { /* ignore */ }
    return null
  }
}

/** Forgets a draft — after it was posted, or discarded. */
export function clearDraft(key: string, store: Store | null = defaultStore()): void {
  if (!store) return
  try { store.removeItem(DRAFT_PREFIX + key) } catch { /* ignore */ }
}

/** Removes every expired or unreadable draft (run once when an editor mounts). */
export function pruneDrafts(store: Store | null = defaultStore(), now = Date.now()): void {
  if (!store) return
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k?.startsWith(DRAFT_PREFIX)) keys.push(k.slice(DRAFT_PREFIX.length))
    }
    for (const k of keys) loadDraft(k, store, now)
  } catch { /* ignore */ }
}

/** The scope drafts are kept under: the signed-in account, or 'anon' when signed out. */
export function draftScope(accountId: string | null | undefined = getSession()?.accountId): string {
  return accountId || 'anon'
}

/** A place's draft key inside the current account's scope — what the editor and its callers use. */
export function scopedDraftKey(key: string, accountId: string | null | undefined = getSession()?.accountId): string {
  return `${draftScope(accountId)}|${key}`
}

/** Removes every draft kept for an account (on logout), and any left unscoped by an older version. */
export function clearAccountDrafts(accountId: string, store: Store | null = defaultStore()): void {
  if (!store) return
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (!k?.startsWith(DRAFT_PREFIX)) continue
      const rest = k.slice(DRAFT_PREFIX.length)
      if (rest.startsWith(`${accountId}|`) || !rest.includes('|')) keys.push(k)
    }
    for (const k of keys) store.removeItem(k)
  } catch { /* ignore */ }
}
