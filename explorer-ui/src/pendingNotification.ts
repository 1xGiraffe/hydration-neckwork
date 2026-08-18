import { isNotificationKind } from './notificationKinds'
import type { NotificationRuleInput } from './types'

// A visitor can meet a "Get notified" button anywhere — a safety timeline, an
// asset header, the activity filters — while logged out. Creating the rule
// needs a session, and logging in is a wallet round trip that leaves and
// re-enters the page, so the INTENT is parked here first and claimed once a
// session appears (see usePendingNotificationHandoff in hooks/useNotifications).
//
// Deliberately storage-only: no React, no fetch, no router. That keeps the
// handoff's two halves — "what did the visitor ask for" and "what happens when
// they come back" — separately testable, and lets any surface stash an intent
// without importing the notifications stack.
export const PENDING_NOTIFICATION_KEY = 'explorer-pending-notification'

// The stashed intent is exactly a create-rule body minus the fields only the
// management page sets, so claiming it is a plain POST of what was parked.
export type PendingNotification = Pick<NotificationRuleInput, 'kind' | 'params' | 'name'>

export function stashPendingNotification(rule: PendingNotification): void {
  try {
    localStorage.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({ kind: rule.kind, params: rule.params, ...(rule.name ? { name: rule.name } : {}) }))
  } catch { /* private mode / storage full — the visitor can ask again */ }
}

// Reads defensively: anything that isn't a known kind with an object of
// parameters is discarded rather than POSTed. A stale entry written by an older
// build (a kind since renamed) must not become a 400 on every login.
export function readPendingNotification(): PendingNotification | null {
  let raw: string | null
  try { raw = localStorage.getItem(PENDING_NOTIFICATION_KEY) } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingNotification>
    if (!parsed || !isNotificationKind(parsed.kind)) return null
    if (!parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params)) return null
    return {
      kind: parsed.kind,
      params: parsed.params as Record<string, unknown>,
      ...(typeof parsed.name === 'string' && parsed.name ? { name: parsed.name } : {}),
    }
  } catch { return null }
}

export function clearPendingNotification(): void {
  try { localStorage.removeItem(PENDING_NOTIFICATION_KEY) } catch { /* ignore */ }
}

// Take the parked intent, if there is one, and hand it to `create`. The entry
// is removed BEFORE the request: an intent is single-shot, so a failing create
// surfaces as an error the visitor can retry by clicking the button again,
// never as a rule that is re-POSTed on every session change or page load.
export async function claimPendingNotification(
  create: (rule: PendingNotification) => Promise<unknown>,
): Promise<PendingNotification | null> {
  const pending = readPendingNotification()
  if (!pending) return null
  clearPendingNotification()
  await create(pending)
  return pending
}
