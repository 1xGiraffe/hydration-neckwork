import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { api, userApi, PUBLIC_LIST_TAG } from '../api/explorer'
import type { EventFilters, ExtrinsicFilters, ListCountQuery, ValueFilters } from '../api/explorer'
import { useSession, setSession } from '../session'
import { setTagMap, setTagMapError } from '../userTags'
import { BLOCK_STALE_MS } from '../live'
import { useHeldRows } from './useHeldRows'
// The same poll cadence the public feeds use — the list-tag feeds below are the
// authed twins of the system-tag ones, so they share one rule for when to poll.
import { useInterval } from './useExplorerData'

export function useMe() {
  const session = useSession()
  return useQuery({ queryKey: ['user', 'me', session?.accountId], queryFn: ({ signal }) => userApi.me(signal), enabled: !!session, staleTime: 30_000 })
}

// Fetch + push the viewer's tag map into the resolution store. Mounted once
// (Topbar), so every pill on every page resolves through it.
export function useTagMapSync() {
  const session = useSession()
  const q = useQuery({ queryKey: ['user', 'tag-map', session?.accountId], queryFn: ({ signal }) => userApi.tagMap(signal), enabled: !!session, staleTime: 30_000 })
  // The explicit second argument matters exactly when `session` is truthy but
  // `q.data` hasn't arrived yet — tagMapStatus() needs to read 'loading', not
  // 'anonymous', for that window (see userTags.ts). `q.isError` needs its own
  // branch: react-query leaves `data` undefined on a failed fetch too, same
  // as "still loading" — without checking isError, a query that exhausts its
  // retries and fails never fires this effect again (data stays `undefined`,
  // unchanged), so tagMapStatus() would read 'loading' forever.
  useEffect(() => {
    if (!session) { setTagMap(null); return }
    if (q.isError) { setTagMapError(); return }
    setTagMap(q.data ?? null, true)
  }, [session, q.data, q.isError])
  return q
}

export function useLists() {
  return useQuery({ queryKey: ['lists'], queryFn: ({ signal }) => api.lists(signal), staleTime: 30_000, placeholderData: keepPreviousData })
}
export function useList(id: string | null, authed: boolean) {
  return useQuery({
    queryKey: ['list', id, authed],
    queryFn: ({ signal }) => (authed ? userApi.list(id!, signal) : api.list(id!, signal)),
    enabled: !!id, staleTime: 15_000,
  })
}
export function useAddressLists(address: string | null) {
  return useQuery({ queryKey: ['address-lists', address], queryFn: ({ signal }) => api.addressLists(address!, signal), enabled: !!address, staleTime: 30_000 })
}
// Public lists that TAG this address as a member — the account page's
// "tagged in a public list" hint for a viewer with no session. Unrelated to
// useAddressLists above (ownership); ungated on session and same staleTime,
// matching that sibling query so both stay eligible for the same shared
// cache regardless of who's asking.
export function useAddressTaggedIn(address: string | null) {
  return useQuery({ queryKey: ['address-tagged-in', address], queryFn: ({ signal }) => api.addressTaggedIn(address!, signal), enabled: !!address, staleTime: 30_000 })
}

// ── List tag aggregate view ──────────────────────────────────────────────
// Mirrors the useTag*/useAddress* hooks in hooks/useExplorerData.ts. Two
// surfaces, one set of hooks: the authed one for a viewer's own or subscribed
// tag, and the anonymous one a PUBLIC list's tag is reachable on by link
// (PUBLIC_LIST_TAG as the listId — see api/explorer.ts). `enabled` still
// requires listId/tagId themselves so ScopedActivity/VotesTab can pass them
// through unconditionally, same pattern as their system-tag counterparts.
const LIST_TAG_POLL_MS = 15_000

// Readable now: a public tag needs no session, a private one needs one. listId
// null is "not resolved yet", which is neither.
const listTagReadable = (session: unknown, listId: string | null): boolean =>
  listId === PUBLIC_LIST_TAG || (!!session && !!listId)

// Which public list a shared tag link belongs to — the provenance line's name
// and owner, and how TagDetail tells a public list tag from an unknown id.
export function usePublicListTagList(tagId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['public-list-tag-list', tagId],
    queryFn: ({ signal }) => api.publicListTagList(tagId as string, signal),
    enabled: enabled && !!tagId,
    retry: false,
    staleTime: 600_000,
  })
}

// A user tag's members as directory rows — the same table /accounts renders.
export function useListTagMembers(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-members', listId, tagId],
    queryFn: ({ signal }) => userApi.listTagMembers(listId as string, tagId as string, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    staleTime: 60_000,
  })
}

export function useListTag(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag', listId, tagId],
    queryFn: ({ signal }) => userApi.listTag(listId as string, tagId as string, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    refetchInterval: useInterval(LIST_TAG_POLL_MS),
    staleTime: BLOCK_STALE_MS,
  })
}
// Hover-card variant: the API skips the heavy portfolio-history reconstruction.
export function useListTagSummary(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-summary', listId, tagId],
    queryFn: ({ signal }) => userApi.listTagSummary(listId as string, tagId as string, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    staleTime: 30_000,
  })
}
export function useListTagActivityCounts(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-activity-counts', listId, tagId],
    queryFn: ({ signal }) => userApi.listTagActivityCounts(listId as string, tagId as string, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    staleTime: 600_000,
  })
}
export function useListTagListCount(listId: string | null, tagId: string | null, query: ListCountQuery | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-list-count', listId, tagId, query],
    queryFn: ({ signal }) => userApi.listTagListCount(listId as string, tagId as string, query as ListCountQuery, signal),
    enabled: listTagReadable(session, listId) && !!tagId && !!query,
    staleTime: 120_000,
  })
}
export function useListTagValueEvents(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-value-events', listId, tagId],
    queryFn: ({ signal }) => userApi.listTagValueEvents(listId as string, tagId as string, undefined, undefined, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    staleTime: 600_000,
  })
}
export function useListTagActivity(listId: string | null, tagId: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['list-tag-activity', listId, tagId, type, offset, action, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.listTagActivity(listId as string, tagId as string, type, offset, undefined, action, from, to, filters, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: BLOCK_STALE_MS,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useListTagExtrinsics(listId: string | null, tagId: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['list-tag-extrinsics', listId, tagId, offset, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.listTagExtrinsics(listId as string, tagId as string, offset, undefined, from, to, filters, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: BLOCK_STALE_MS,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useListTagEvents(listId: string | null, tagId: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['list-tag-events', listId, tagId, offset, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.listTagEvents(listId as string, tagId as string, offset, undefined, from, to, filters, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: BLOCK_STALE_MS,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useListTagRevenueBreakdown(listId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['list-tag-revenue-breakdown', listId, tagId],
    queryFn: ({ signal }) => userApi.listTagRevenueBreakdown(listId as string, tagId as string, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    staleTime: 300_000,
  })
}
export function useListTagVotes(listId: string | null, tagId: string | null, offset = 0, from?: string, to?: string) {
  const session = useSession()
  const ri = useInterval()
  const key = ['list-tag-votes', listId, tagId, offset, from, to]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.listTagVotes(listId as string, tagId as string, offset, undefined, from, to, signal),
    enabled: listTagReadable(session, listId) && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: BLOCK_STALE_MS,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
// Grouped mode (one row per referendum) — ranked page, no useHeldRows, same as
// its system-tag counterpart in useExplorerData.ts.
export function useListTagVotesByReferendum(listId: string | null, tagId: string | null, offset = 0, enabled = true) {
  const session = useSession()
  const ri = useInterval()
  return useQuery({
    queryKey: ['list-tag-votes-by-ref', listId, tagId, offset],
    queryFn: ({ signal }) => userApi.listTagVotesByReferendum(listId as string, tagId as string, offset, undefined, signal),
    enabled: listTagReadable(session, listId) && !!tagId && enabled,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: BLOCK_STALE_MS,
    placeholderData: keepPreviousData,
  })
}

// One mutation wrapper: every user mutation invalidates the user scope (me,
// tag-map, list details) so the next render resolves with fresh data.
export function useUserMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] })
      void qc.invalidateQueries({ queryKey: ['lists'] })
      void qc.invalidateQueries({ queryKey: ['list'] })
      // Profile edits change how the account page itself renders (header name,
      // avatar), and that page reads the ADDRESS query — refresh it too. Cheap:
      // only mounted address queries refetch, and user mutations are rare.
      void qc.invalidateQueries({ queryKey: ['address'] })
    },
  })
}

export async function logout(): Promise<void> {
  try { await userApi.logout() } finally { setSession(null) }
}
