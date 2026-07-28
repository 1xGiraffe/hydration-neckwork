import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { api, userApi } from '../api/explorer'
import type { EventFilters, ExtrinsicFilters, ListCountQuery, ValueFilters } from '../api/explorer'
import { useSession, setSession } from '../session'
import { setTagMap } from '../userTags'
import { useLive, LIVE_MS } from '../live'
import { useHeldRows } from './useHeldRows'

function useInterval(intervalMs = LIVE_MS): number | false {
  return useLive() ? intervalMs : false
}

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
  // 'anonymous', for that window (see userTags.ts).
  useEffect(() => { setTagMap(session ? q.data ?? null : null, !!session) }, [session, q.data])
  return q
}

export function useLibraries() {
  return useQuery({ queryKey: ['libraries'], queryFn: ({ signal }) => api.libraries(signal), staleTime: 30_000, placeholderData: keepPreviousData })
}
export function useLibrary(id: string | null, authed: boolean) {
  return useQuery({
    queryKey: ['library', id, authed],
    queryFn: ({ signal }) => (authed ? userApi.library(id!, signal) : api.library(id!, signal)),
    enabled: !!id, staleTime: 15_000,
  })
}
export function useAddressLibraries(address: string | null) {
  return useQuery({ queryKey: ['address-libraries', address], queryFn: ({ signal }) => api.addressLibraries(address!, signal), enabled: !!address, staleTime: 30_000 })
}

// ── Library tag aggregate view ──────────────────────────────────────────────
// Mirrors the useTag*/useAddress* hooks in hooks/useExplorerData.ts, but authed
// (userApi, gated on a session) — a library tag's combined view has no
// anonymous/public form. `enabled` still requires libraryId/tagId themselves so
// ScopedActivity/VotesTab can pass them through unconditionally, same pattern
// as their system-tag counterparts.
const LIBRARY_TAG_POLL_MS = 15_000

export function useLibraryTag(libraryId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['library-tag', libraryId, tagId],
    queryFn: ({ signal }) => userApi.libraryTag(libraryId as string, tagId as string, signal),
    enabled: !!session && !!libraryId && !!tagId,
    refetchInterval: useInterval(LIBRARY_TAG_POLL_MS),
    staleTime: 6000,
  })
}
// Hover-card variant: the API skips the heavy portfolio-history reconstruction.
export function useLibraryTagSummary(libraryId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['library-tag-summary', libraryId, tagId],
    queryFn: ({ signal }) => userApi.libraryTagSummary(libraryId as string, tagId as string, signal),
    enabled: !!session && !!libraryId && !!tagId,
    staleTime: 30_000,
  })
}
export function useLibraryTagActivityCounts(libraryId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['library-tag-activity-counts', libraryId, tagId],
    queryFn: ({ signal }) => userApi.libraryTagActivityCounts(libraryId as string, tagId as string, signal),
    enabled: !!session && !!libraryId && !!tagId,
    staleTime: 600_000,
  })
}
export function useLibraryTagListCount(libraryId: string | null, tagId: string | null, query: ListCountQuery | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['library-tag-list-count', libraryId, tagId, query],
    queryFn: ({ signal }) => userApi.libraryTagListCount(libraryId as string, tagId as string, query as ListCountQuery, signal),
    enabled: !!session && !!libraryId && !!tagId && !!query,
    staleTime: 120_000,
  })
}
export function useLibraryTagValueEvents(libraryId: string | null, tagId: string | null) {
  const session = useSession()
  return useQuery({
    queryKey: ['library-tag-value-events', libraryId, tagId],
    queryFn: ({ signal }) => userApi.libraryTagValueEvents(libraryId as string, tagId as string, undefined, undefined, signal),
    enabled: !!session && !!libraryId && !!tagId,
    staleTime: 600_000,
  })
}
export function useLibraryTagActivity(libraryId: string | null, tagId: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['library-tag-activity', libraryId, tagId, type, offset, action, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.libraryTagActivity(libraryId as string, tagId as string, type, offset, undefined, action, from, to, filters, signal),
    enabled: !!session && !!libraryId && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: 6000,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useLibraryTagExtrinsics(libraryId: string | null, tagId: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['library-tag-extrinsics', libraryId, tagId, offset, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.libraryTagExtrinsics(libraryId as string, tagId as string, offset, undefined, from, to, filters, signal),
    enabled: !!session && !!libraryId && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: 6000,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useLibraryTagEvents(libraryId: string | null, tagId: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const session = useSession()
  const ri = useInterval()
  const key = ['library-tag-events', libraryId, tagId, offset, from, to, filters]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.libraryTagEvents(libraryId as string, tagId as string, offset, undefined, from, to, filters, signal),
    enabled: !!session && !!libraryId && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: 6000,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}
export function useLibraryTagVotes(libraryId: string | null, tagId: string | null, offset = 0, from?: string, to?: string) {
  const session = useSession()
  const ri = useInterval()
  const key = ['library-tag-votes', libraryId, tagId, offset, from, to]
  return useHeldRows(useQuery({
    queryKey: key,
    queryFn: ({ signal }) => userApi.libraryTagVotes(libraryId as string, tagId as string, offset, undefined, from, to, signal),
    enabled: !!session && !!libraryId && !!tagId,
    refetchInterval: offset === 0 ? ri : false,
    staleTime: 6000,
    placeholderData: keepPreviousData,
  }), key, offset === 0)
}

// One mutation wrapper: every user mutation invalidates the user scope (me,
// tag-map, library details) so the next render resolves with fresh data.
export function useUserMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user'] })
      void qc.invalidateQueries({ queryKey: ['libraries'] })
      void qc.invalidateQueries({ queryKey: ['library'] })
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
