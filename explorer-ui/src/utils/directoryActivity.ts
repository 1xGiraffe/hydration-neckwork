import type { TopAccountRow } from '../types'

// The key /explorer/accounts/activity-counts counts a row by — the directory's own
// grouping key: a system tag's id, else the account. A member list's rows are the
// accounts themselves. A viewer's own group (a list or personal tag) has its own
// counting lane server-side and is never asked for here.
export function activityCountKey(r: TopAccountRow, memberView?: boolean): string | null {
  if (memberView || !r.tag) return r.account?.accountId ?? null
  return r.tag.userTagId || r.tag.listId ? null : r.tag.tagId
}
