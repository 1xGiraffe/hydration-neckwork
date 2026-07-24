import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { api } from '../api/explorer'
import type { EventFilters, ExtrinsicFilters, ValueFilters } from '../api/explorer'
import { useLive, LIVE_MS } from '../live'
import type { AccountSort } from '../types'

// List/feed hooks honour the global Live toggle. When live, they poll on LIVE_MS;
// when paused, no refetch. The API's single-flight cache keeps DB load O(1) in
// the number of connected clients regardless of poll rate.
const DETAIL_POLL_MS = 15_000
const SLOW_POLL_MS = 60_000

function useInterval(intervalMs = LIVE_MS): number | false {
  return useLive() ? intervalMs : false
}

export function useStats(enabled = true) {
  const ri = useInterval()
  return useQuery({ queryKey: ['stats'], queryFn: ({ signal }) => api.stats(signal), enabled, refetchInterval: enabled ? ri : false, staleTime: 2000 })
}
export function useBlocks(limit = 25, offset = 0, enabled = true) {
  const ri = useInterval()
  return useQuery({ queryKey: ['blocks', limit, offset], queryFn: ({ signal }) => api.blocks(limit, offset, signal), enabled, refetchInterval: enabled && offset === 0 ? ri : false, staleTime: 5000 })
}
export function useExtrinsics(limit = 25, signedOnly = true, from?: string, to?: string, offset = 0, filters?: ExtrinsicFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['extrinsics', limit, signedOnly, from, to, offset, filters], queryFn: ({ signal }) => api.extrinsics(limit, signedOnly, from, to, offset, filters, signal), refetchInterval: offset === 0 ? ri : false, staleTime: 2000 })
}
export function useEvents(limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['events', limit, from, to, offset, filters], queryFn: ({ signal }) => api.events(limit, from, to, offset, filters, signal), refetchInterval: offset === 0 ? ri : false, staleTime: 2000 })
}
export function useActivity(limit = 30, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string) {
  const ri = useInterval()
  return useQuery({ queryKey: ['activity', limit, from, to, offset, type, filters, action], queryFn: ({ signal }) => api.activity(limit, from, to, offset, type, filters, action, signal), refetchInterval: offset === 0 ? ri : false, staleTime: 2000 })
}
export function useCounts() {
  return useQuery({ queryKey: ['counts'], queryFn: ({ signal }) => api.counts(signal), staleTime: 60_000 })
}
export function useBlock(height: number | null) {
  return useQuery({ queryKey: ['block', height], queryFn: ({ signal }) => api.block(height as number, signal), enabled: height != null, staleTime: 60_000 })
}
export function useBlockActivity(height: number | null, enabled = true) {
  return useQuery({ queryKey: ['block-activity', height], queryFn: ({ signal }) => api.blockActivity(height as number, signal), enabled: height != null && enabled, staleTime: 60_000 })
}
export function useExtrinsic(id: string | null) {
  return useQuery({
    queryKey: ['extrinsic', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return m ? api.extrinsicAt(Number(m[1]), Number(m[2]), signal) : api.extrinsic(id as string, signal)
    },
    enabled: !!id,
    staleTime: 60_000,
  })
}
export function useDcaSchedule(scheduleId: number, offset = 0) {
  return useQuery({ queryKey: ['dca-schedule', scheduleId, offset], queryFn: ({ signal }) => api.dcaSchedule(scheduleId, offset, 25, signal), staleTime: 8000 })
}
export function useDcaExecution(height: number, eventIndex: number) {
  return useQuery({ queryKey: ['dca-execution', height, eventIndex], queryFn: ({ signal }) => api.dcaExecution(height, eventIndex, signal), retry: false, staleTime: 60_000 })
}
export function useExtrinsicActivity(id: string | null, enabled = true) {
  return useQuery({
    queryKey: ['extrinsic-activity', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return m ? api.extrinsicAtActivity(Number(m[1]), Number(m[2]), signal) : api.extrinsicActivity(id as string, signal)
    },
    enabled: !!id && enabled,
    staleTime: 60_000,
  })
}
export function useTrade(id: string | null) {
  return useQuery({
    queryKey: ['trade', id],
    queryFn: ({ signal }) => {
      const event = /^(\d+)-e(\d+)$/.exec(id as string)
      if (event) return api.tradeEvent(Number(event[1]), Number(event[2]), signal)
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return api.trade(Number(m![1]), Number(m![2]), signal)
    },
    enabled: !!id && /^\d+-(?:e)?\d+$/.test(id),
    staleTime: 60_000,
  })
}
export function useEventAt(id: string | null) {
  return useQuery({
    queryKey: ['event', id],
    queryFn: ({ signal }) => {
      const m = /^(\d+)-(\d+)$/.exec(id as string)
      return api.eventAt(Number(m![1]), Number(m![2]), signal)
    },
    enabled: !!id && /^\d+-\d+$/.test(id),
    staleTime: 60_000,
  })
}
export function useAsset(assetId: number | null) {
  return useQuery({ queryKey: ['asset', assetId], queryFn: ({ signal }) => api.asset(assetId as number, signal), enabled: assetId != null, refetchInterval: useInterval(30_000), staleTime: 20_000 })
}
export function useHolders(assetId: number | null, offset: number, limit: number, enabled = true) {
  const ri = useInterval(30_000)
  return useQuery({ queryKey: ['holders', assetId, offset, limit], queryFn: ({ signal }) => api.holders(assetId as number, offset, limit, signal), enabled: assetId != null && enabled, refetchInterval: offset === 0 ? ri : false, staleTime: 20_000 })
}
export function useAssetActivity(assetId: number | null, type = 'all', offset = 0, action?: string, enabled = true, from?: string, to?: string, min?: string) {
  const ri = useInterval()
  return useQuery({ queryKey: ['asset-activity', assetId, type, offset, action, from, to, min], queryFn: ({ signal }) => api.assetActivity(assetId as number, type, offset, undefined, action, from, to, min, signal), enabled: assetId != null && enabled, refetchInterval: enabled && offset === 0 ? ri : false, staleTime: 6000 })
}
export function useAddress(address: string | null) {
  return useQuery({ queryKey: ['address', address], queryFn: ({ signal }) => api.address(address as string, signal), enabled: !!address, refetchInterval: useInterval(DETAIL_POLL_MS), staleTime: 6000 })
}
// Hover-card variant: the API omits LP/DCA/proxy/multisig so the preview loads fast.
export function useAddressSummary(address: string | null) {
  return useQuery({ queryKey: ['address-summary', address], queryFn: ({ signal }) => api.addressSummary(address as string, signal), enabled: !!address, staleTime: 30_000 })
}
export function useAddressHistory(address: string | null) {
  return useQuery({ queryKey: ['address-history', address], queryFn: ({ signal }) => api.addressHistory(address as string, signal), enabled: !!address, staleTime: 120_000 })
}
export function useCloseAccounts(address: string | null, enabled = false) {
  return useQuery({
    queryKey: ['close-accounts', address],
    queryFn: ({ signal }) => api.closeAccounts(address as string, signal),
    enabled: !!address && enabled,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  })
}
export function useTagCloseAccounts(tagId: string | null, enabled = false) {
  return useQuery({
    queryKey: ['tag-close-accounts', tagId],
    queryFn: ({ signal }) => api.tagCloseAccounts(tagId as string, signal),
    enabled: !!tagId && enabled,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
  })
}
export function useAccountActivity(address: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters, tail?: number) {
  const ri = useInterval()
  return useQuery({ queryKey: ['account-activity', address, type, offset, action, from, to, filters, tail], queryFn: ({ signal }) => api.accountActivity(address as string, type, offset, undefined, action, from, to, filters, tail, signal), enabled: !!address, refetchInterval: offset === 0 && tail == null ? ri : false, staleTime: 6000 })
}
export function useAccountExtrinsics(address: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['account-extrinsics', address, offset, from, to, filters], queryFn: ({ signal }) => api.accountExtrinsics(address as string, offset, undefined, from, to, filters, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
export function useAccountEvents(address: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['account-events', address, offset, from, to, filters], queryFn: ({ signal }) => api.accountEvents(address as string, offset, undefined, from, to, filters, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
export function useAccountVotes(address: string | null, offset = 0, from?: string, to?: string) {
  const ri = useInterval()
  return useQuery({ queryKey: ['account-votes', address, offset, from, to], queryFn: ({ signal }) => api.accountVotes(address as string, offset, undefined, from, to, signal), enabled: !!address, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
// Lazy per-account / per-tag activity totals (extrinsic + event counts). The
// first hit can take a few seconds server-side, so no live polling and a long
// staleTime — badges simply appear once the count query resolves.
export function useAccountActivityCounts(address: string | null) {
  return useQuery({ queryKey: ['account-activity-counts', address], queryFn: ({ signal }) => api.accountActivityCounts(address as string, signal), enabled: !!address, staleTime: 600_000 })
}
// Value-filtered activity count for the pager's last-page jump while the smol
// filter (or a custom $-minimum) hides rows server-side.
export function useAccountActivityCount(address: string | null, min: number | null) {
  return useQuery({
    queryKey: ['account-activity-count', address, min],
    queryFn: ({ signal }) => api.accountActivityCount(address as string, min as number, signal),
    enabled: !!address && min != null,
    staleTime: 600_000,
  })
}
// Value-history chart markers: the account/tag's largest transfers, swaps and
// liquidations. Server-cached top-N; no live polling — the set moves slowly.
export function useAddressValueEvents(address: string | null) {
  return useQuery({ queryKey: ['address-value-events', address], queryFn: ({ signal }) => api.accountValueEvents(address as string, undefined, undefined, signal), enabled: !!address, staleTime: 600_000 })
}
export function useTagValueEvents(tagId: string | null) {
  return useQuery({ queryKey: ['tag-value-events', tagId], queryFn: ({ signal }) => api.tagValueEvents(tagId as string, undefined, undefined, signal), enabled: !!tagId, staleTime: 600_000 })
}
export function useTagActivityCounts(tagId: string | null) {
  return useQuery({ queryKey: ['tag-activity-counts', tagId], queryFn: ({ signal }) => api.tagActivityCounts(tagId as string, signal), enabled: !!tagId, staleTime: 600_000 })
}
export function useTag(tagId: string | null) {
  return useQuery({ queryKey: ['tag', tagId], queryFn: ({ signal }) => api.tag(tagId as string, signal), enabled: !!tagId, refetchInterval: useInterval(DETAIL_POLL_MS), staleTime: 6000 })
}
// Hover-card variant: the API skips the heavy portfolio-history reconstruction.
export function useTagSummary(tagId: string | null) {
  return useQuery({ queryKey: ['tag-summary', tagId], queryFn: ({ signal }) => api.tagSummary(tagId as string, signal), enabled: !!tagId, staleTime: 30_000 })
}
export function useTagActivity(tagId: string | null, type = 'all', offset = 0, action?: string, from?: string, to?: string, filters?: ValueFilters, tail?: number) {
  const ri = useInterval()
  return useQuery({ queryKey: ['tag-activity', tagId, type, offset, action, from, to, filters, tail], queryFn: ({ signal }) => api.tagActivity(tagId as string, type, offset, undefined, action, from, to, filters, tail, signal), enabled: !!tagId, refetchInterval: offset === 0 && tail == null ? ri : false, staleTime: 6000 })
}
export function useTagExtrinsics(tagId: string | null, offset = 0, from?: string, to?: string, filters?: ExtrinsicFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['tag-extrinsics', tagId, offset, from, to, filters], queryFn: ({ signal }) => api.tagExtrinsics(tagId as string, offset, undefined, from, to, filters, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
export function useTagEvents(tagId: string | null, offset = 0, from?: string, to?: string, filters?: EventFilters) {
  const ri = useInterval()
  return useQuery({ queryKey: ['tag-events', tagId, offset, from, to, filters], queryFn: ({ signal }) => api.tagEvents(tagId as string, offset, undefined, from, to, filters, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
export function useTagVotes(tagId: string | null, offset = 0, from?: string, to?: string) {
  const ri = useInterval()
  return useQuery({ queryKey: ['tag-votes', tagId, offset, from, to], queryFn: ({ signal }) => api.tagVotes(tagId as string, offset, undefined, from, to, signal), enabled: !!tagId, refetchInterval: offset === 0 ? ri : false, staleTime: 6000 })
}
export function useTagActivityCount(tagId: string | null, min: number | null) {
  return useQuery({ queryKey: ['tag-activity-count', tagId, min], queryFn: ({ signal }) => api.tagActivityCount(tagId as string, min as number, signal), enabled: !!tagId && min != null, staleTime: 600_000 })
}
export function useAssets() {
  return useQuery({ queryKey: ['assets'], queryFn: ({ signal }) => api.assets(signal), refetchInterval: useInterval(SLOW_POLL_MS), staleTime: 30_000 })
}
export function useHdxDashboard() {
  return useQuery({ queryKey: ['hdx-dashboard'], queryFn: ({ signal }) => api.hdx(signal), staleTime: 120_000 })
}
export function useHollarDashboard() {
  return useQuery({ queryKey: ['hollar-dashboard'], queryFn: ({ signal }) => api.hollar(signal), staleTime: 120_000 })
}
export function useAccounts(offset = 0, limit = 50, sort: AccountSort = 'value') {
  return useQuery({ queryKey: ['accounts', offset, limit, sort], queryFn: ({ signal }) => api.accounts(offset, limit, sort, signal), refetchInterval: useInterval(SLOW_POLL_MS), staleTime: 20_000 })
}
export function useDaily(scope: string, params?: { type?: string; action?: string; token?: string }) {
  // keepPreviousData: switching the active tab/action changes the query key; without
  // it `data` drops to undefined mid-fetch and the chart collapses to a skeleton
  // (and back), flickering. Holding the previous series lets DayBarChart update the
  // bars in place — same frame, same height — while the new tab loads.
  return useQuery({ queryKey: ['daily', scope, params ?? null], queryFn: ({ signal }) => api.daily(scope, params, signal), staleTime: 300_000, placeholderData: keepPreviousData })
}
export function useAccountsDaily() {
  return useQuery({ queryKey: ['accounts-daily'], queryFn: ({ signal }) => api.accountsDaily(signal), staleTime: 300_000 })
}
export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => api.tags(signal), staleTime: 30_000 })
}
