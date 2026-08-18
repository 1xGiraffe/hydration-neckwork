import { useEffect, useRef } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { userApi } from '../api/explorer'
import { useSession } from '../session'
import { navigate, paths } from '../router'
import { claimPendingNotification } from '../pendingNotification'

// The notifications query family. Everything under the ['notifications'] key
// so one invalidate after a mutation refreshes the overview, the inbox and the
// topbar's unread badge together — the same shape useUserMutation gives the
// ['user']/['lists'] family.

// The badge poll. Sixty seconds is deliberate: the evaluator ticks every few
// seconds, but an unread COUNT is not something a reader watches, and this
// query is mounted on every page through the topbar.
const OVERVIEW_POLL_MS = 60_000

export function useNotificationsOverview() {
  const session = useSession()
  return useQuery({
    queryKey: ['notifications', 'overview', session?.accountId],
    queryFn: ({ signal }) => userApi.notificationsOverview(signal),
    enabled: !!session,
    refetchInterval: OVERVIEW_POLL_MS,
    staleTime: 30_000,
  })
}

export function useNotificationInbox(limit = 50, offset = 0, enabled = true) {
  const session = useSession()
  return useQuery({
    queryKey: ['notifications', 'inbox', session?.accountId, limit, offset],
    queryFn: ({ signal }) => userApi.notificationInbox(limit, offset, signal),
    enabled: !!session && enabled,
    staleTime: 15_000,
  })
}

// The family's one refresh, used after every write. Cancelling before
// invalidating is not decoration: a write can resolve while the family's FIRST
// fetch is still in flight — logging in starts one, and the pending-alert
// handoff below creates a rule in that very instant — and react-query dedupes a
// refetch onto an in-flight first fetch, because there is no previous data for
// `cancelRefetch` to revert to. A bare invalidate is then swallowed, the query
// settles on the response that PREDATES the write, and (with a 30s staleTime)
// the surface keeps showing the old answer for half a minute.
export async function refreshNotifications(qc: QueryClient): Promise<void> {
  await qc.cancelQueries({ queryKey: ['notifications'] })
  await qc.invalidateQueries({ queryKey: ['notifications'] })
}

// One mutation wrapper for the whole surface, mirroring useUserMutation: the
// call shape is `mutate([...args])`, and every success refreshes the family.
export function useNotificationMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => { void refreshNotifications(qc) },
  })
}

// The other half of the logged-out "Get notified" handoff (see
// pendingNotification.ts): once a session exists, POST whatever the visitor
// asked for before logging in, refresh the family, and land them on the page
// that now holds the alert. Mounted once, in the topbar, so it runs whichever
// page the login happened on.
//
// `attempted` makes this once-per-mount regardless of how many times the effect
// re-runs: the storage entry is already single-shot, and the ref keeps a
// re-render between "read" and "cleared" from starting a second request.
export function usePendingNotificationHandoff(): void {
  const session = useSession()
  const qc = useQueryClient()
  const attempted = useRef(false)
  useEffect(() => {
    if (!session || attempted.current) return
    attempted.current = true
    void claimPendingNotification(rule => userApi.createNotificationRule(rule))
      .then(claimed => {
        if (!claimed) return
        // The alerts tab, not the inbox: what the visitor just made is a RULE,
        // and an inbox that will stay empty until it fires reads as a failure.
        navigate(paths.notifications('alerts'))
        void refreshNotifications(qc)
      })
      // A rejected create is not worth a modal on an unrelated page: the intent
      // is gone, and every surface that stashed one still offers the button.
      .catch(() => {})
  }, [session, qc])
}
