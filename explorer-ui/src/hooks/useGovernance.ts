import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { govApi, isNotReady } from '../api/explorer'
import { shouldRetryQuery } from '../queryRetry'
import type { DiscussionSort, ListedPostKind, ThreadFilter, ThreadSort } from '../governanceTypes'

// Governance and forum reads. The snapshot-backed routes (vote state, the forum
// store) answer 503 `not-ready` while the api is still loading them after a
// restart: that is a wait, not a failure, so those queries keep retrying on a
// slow beat and the pages read `failureReason` to say "still loading" instead of
// rendering an empty list that would read as real.

const NOT_READY_RETRIES = 60
const NOT_READY_DELAY_MS = 5_000

export const snapshotRetry = {
  retry: (failureCount: number, error: unknown) => (isNotReady(error) ? failureCount < NOT_READY_RETRIES : shouldRetryQuery(failureCount, error)),
  retryDelay: (failureCount: number, error: unknown) => (isNotReady(error) ? NOT_READY_DELAY_MS : Math.min(1000 * 2 ** failureCount, 30_000)),
}

/** True while a query is waiting out a 503 not-ready (its retries are still running). */
export function waitingForSnapshot(q: { failureReason: unknown; isFetching: boolean; data: unknown }): boolean {
  return q.data == null && isNotReady(q.failureReason)
}

/** The governance projector (anchor and measured pace); every countdown on these pages uses it. */
export function useGovClock() {
  return useQuery({ queryKey: ['gov-clock'], queryFn: ({ signal }) => govApi.clock(signal), staleTime: 30_000, refetchInterval: 60_000 })
}

const VOTES_PAGE = 25

export function useReferendumVotes(pallet: 'opengov' | 'democracy', index: number, opts: { sort: 'power' | 'time'; side: 'all' | 'aye' | 'nay' | 'abstain'; q: string; page: number }, live: boolean) {
  return useQuery({
    queryKey: ['referendum-votes', pallet, index, opts.sort, opts.side, opts.q, opts.page],
    queryFn: ({ signal }) => govApi.referendumVotes(pallet, index, { sort: opts.sort, side: opts.side, q: opts.q || undefined, offset: opts.page * VOTES_PAGE, limit: VOTES_PAGE }, signal),
    staleTime: live ? 15_000 : 300_000,
    refetchInterval: live && opts.page === 0 ? 30_000 : false,
    placeholderData: keepPreviousData,
  })
}
export const REFERENDUM_VOTES_PAGE = VOTES_PAGE

export function useGovTracks() {
  return useQuery({ queryKey: ['gov-tracks'], queryFn: ({ signal }) => govApi.tracks(signal), staleTime: 300_000 })
}

// The conviction table alone, for pages that explain a vote's lock (the referendum).
export function useGovConvictions() {
  return useQuery({ queryKey: ['gov-convictions'], queryFn: ({ signal }) => govApi.convictions(signal), staleTime: 300_000 })
}

// A running referendum's trajectory gains points as votes land; a concluded one is final.
export function useTallyHistory(pallet: 'opengov' | 'democracy', index: number, live: boolean, enabled = true) {
  return useQuery({
    queryKey: ['gov-tally-history', pallet, index],
    queryFn: ({ signal }) => govApi.tallyHistory(pallet, index, signal),
    enabled,
    staleTime: live ? 15_000 : 600_000,
    refetchInterval: live ? 30_000 : false,
  })
}

/** The hub's Stats view. Built once on the api and served from its cache. */
export function useGovStats(enabled = true) {
  return useQuery({ queryKey: ['gov-stats'], queryFn: ({ signal }) => govApi.stats(signal), staleTime: 300_000, enabled })
}

export function useGovCalendar(from: string, to: string) {
  return useQuery({
    queryKey: ['gov-calendar', from, to],
    queryFn: ({ signal }) => govApi.calendar(from, to, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
}

export function useAccountGovernance(address: string | null) {
  return useQuery({
    queryKey: ['gov-account', address],
    queryFn: ({ signal }) => govApi.accountGovernance(address as string, signal),
    enabled: !!address,
    staleTime: 30_000,
    ...snapshotRetry,
  })
}

/** A system tag's members' governance, summed (the tag page's Governance tab). */
export function useTagGovernance(tagId: string | null) {
  return useQuery({
    queryKey: ['gov-tag', tagId],
    queryFn: ({ signal }) => govApi.tagGovernance(tagId as string, signal),
    enabled: !!tagId,
    staleTime: 30_000,
    ...snapshotRetry,
  })
}

export function useNeedsVote(accounts: string[]) {
  const key = [...accounts].sort().join(',')
  return useQuery({
    queryKey: ['gov-needs-vote', key],
    queryFn: ({ signal }) => govApi.needsVote(accounts, signal),
    enabled: accounts.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    ...snapshotRetry,
  })
}

const DISCUSSIONS_PAGE = 20

export function useDiscussions(opts: { sort: DiscussionSort; kind?: ListedPostKind }) {
  return useInfiniteQuery({
    queryKey: ['forum-discussions', opts.kind ?? 'discussion', opts.sort],
    queryFn: ({ signal, pageParam }) => govApi.discussions({ ...opts, cursor: pageParam, limit: DISCUSSIONS_PAGE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    ...snapshotRetry,
  })
}

export function useForumPost(postId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['forum-post', postId],
    queryFn: ({ signal }) => govApi.post(postId as string, signal),
    enabled: !!postId && enabled,
    staleTime: 60_000,
    ...snapshotRetry,
  })
}

const THREAD_PAGE = 20

export function useForumThread(threadKey: string | null, sort: ThreadSort, filter: ThreadFilter, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['forum-thread', threadKey, sort, filter ?? ''],
    queryFn: ({ signal, pageParam }) => govApi.thread(threadKey as string, { sort, filter, cursor: pageParam, limit: THREAD_PAGE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    enabled: !!threadKey && enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    ...snapshotRetry,
  })
}

export function useForumRevisions(targetId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['forum-revisions', targetId],
    queryFn: ({ signal }) => govApi.revisions(targetId as string, signal),
    enabled: !!targetId && enabled,
    staleTime: 300_000,
    ...snapshotRetry,
  })
}

/** How many forum items an account has (a one-row read of the in-memory store). */
export function useAccountForumCount(address: string | null) {
  return useQuery({ queryKey: ['forum-account-count', address], queryFn: ({ signal }) => govApi.accountForumCount(address as string, signal), enabled: !!address, staleTime: 300_000, retry: false })
}

export function useAccountForum(address: string | null) {
  return useInfiniteQuery({
    queryKey: ['forum-account', address],
    queryFn: ({ signal, pageParam }) => govApi.accountForum(address as string, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    enabled: !!address,
    staleTime: 60_000,
    ...snapshotRetry,
  })
}
