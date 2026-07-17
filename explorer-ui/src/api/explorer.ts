import type {
  ExplorerStats, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  HoldersResponse, AddressDetail, SearchResult, Tag, AssetListItem,
  AccountsPage, AccountSort, DailyPoint, IndexerStatus, EventRow, EventDetail, ActivityRow, VoteRow, MoneyMarketResponse, AssetDetail, TagDetail,
  AccountHistoryResponse, CloseAccountsResponse, HdxDashboard, HollarDashboard, TradeDetail, DcaScheduleDetail,
} from '../types'

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

type QueryValue = string | number | boolean | null | undefined

function withQuery(path: string, values: Record<string, QueryValue>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === '' || value === false) continue
    query.set(key, value === true ? '1' : String(value))
  }
  const encoded = query.toString()
  return encoded ? `${path}?${encoded}` : path
}

export interface ValueFilters { token?: string; min?: string }
export interface ExtrinsicFilters { call?: string; result?: string }
export interface EventFilters { event?: string }

export const api = {
  stats: (signal?: AbortSignal) => getJson<ExplorerStats>('/explorer/stats', signal),
  indexer: (signal?: AbortSignal) => getJson<IndexerStatus>('/indexer', signal),
  blocks: (limit = 25, offset = 0, signal?: AbortSignal) => getJson<BlockSummary[]>(withQuery('/explorer/blocks', { limit, offset }), signal),
  block: (height: number, signal?: AbortSignal) => getJson<BlockDetail>(`/explorer/block/${height}`, signal),
  blockActivity: (height: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/block/${height}/activity`, signal),
  extrinsics: (limit = 25, signedOnly = false, from?: string, to?: string, offset = 0, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery('/explorer/extrinsics', { limit, offset, signedOnly, from, to, ...filters }), signal),
  extrinsic: (hash: string, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic/${hash}`, signal),
  extrinsicAt: (height: number, index: number, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic-at/${height}/${index}`, signal),
  extrinsicActivity: (hash: string, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic/${hash}/activity`, signal),
  extrinsicAtActivity: (height: number, index: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic-at/${height}/${index}/activity`, signal),
  dcaSchedule: (scheduleId: number, offset = 0, limit = 25, signal?: AbortSignal) => getJson<DcaScheduleDetail>(withQuery(`/explorer/dca/${scheduleId}`, { offset, limit }), signal),
  dcaScheduleAt: (height: number, index: number, kind: 'event' | 'extrinsic', signal?: AbortSignal) => getJson<{ scheduleId: number }>(withQuery(`/explorer/dca-at/${height}/${index}`, { kind }), signal),
  trade: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade/${height}/${index}`, signal),
  tradeEvent: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade-event/${height}/${index}`, signal),
  events: (limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters, signal?: AbortSignal) => getJson<EventRow[]>(withQuery('/explorer/events', { limit, offset, from, to, ...filters }), signal),
  eventAt: (height: number, index: number, signal?: AbortSignal) => getJson<EventDetail>(`/explorer/event/${height}/${index}`, signal),
  activity: (limit = 25, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string, signal?: AbortSignal) => getJson<ActivityRow[]>(withQuery('/explorer/activity', { limit, offset, type, action, from, to, ...filters }), signal),
  counts: (signal?: AbortSignal) => getJson<{ blocks: number; extrinsics: number; events: number; transfers: number }>('/explorer/counts', signal),
  moneyMarket: (limit = 50, signal?: AbortSignal) => getJson<MoneyMarketResponse>(withQuery('/explorer/money-market', { limit }), signal),
  asset: (assetId: number, signal?: AbortSignal) => getJson<AssetDetail>(`/explorer/asset/${assetId}`, signal),
  // Same endpoint as the global activities feed, with the asset id pinned.
  assetActivity: (assetId: number, type = 'all', offset = 0, limit = 40, action?: string, from?: string, to?: string, min?: string, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery('/explorer/activity', { asset: assetId, type, offset, limit, action, from, to, min }), signal),
  holders: (assetId: number, offset = 0, limit = 100, signal?: AbortSignal) => getJson<HoldersResponse>(withQuery(`/explorer/holders/${assetId}`, { offset, limit }), signal),
  address: (address: string, signal?: AbortSignal) => getJson<AddressDetail>(`/explorer/address/${encodeURIComponent(address)}`, signal),
  // Lightweight variant for the hover card: the API skips LP/DCA/proxy/multisig so
  // the preview loads fast (the card only shows name, value, holdings, volumes).
  addressSummary: (address: string, signal?: AbortSignal) => getJson<AddressDetail>(withQuery(`/explorer/address/${encodeURIComponent(address)}`, { summary: '1' }), signal),
  addressHistory: (address: string, signal?: AbortSignal) => getJson<AccountHistoryResponse>(`/explorer/address/${encodeURIComponent(address)}/history`, signal),
  closeAccounts: (address: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/address/${encodeURIComponent(address)}/close-accounts`, signal),
  tagCloseAccounts: (tagId: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/tag/${encodeURIComponent(tagId)}/close-accounts`, signal),
  // `tail` pages from the account's OLDEST activity (tail=0 → first rows ever);
  // the pager uses it for pages beyond forward-offset reach.
  accountActivity: (address: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, tail?: number, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/activity`, { type, offset, limit, action, from, to, ...filters, tail }), signal),
  accountExtrinsics: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  accountEvents: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/events`, { offset, limit, from, to, ...filters }), signal),
  // Governance votes cast by the account (OpenGov + Democracy + collectives).
  accountVotes: (address: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/votes`, { offset, limit, from, to }), signal),
  accountActivityCounts: (address: string, signal?: AbortSignal) => getJson<{ extrinsics: number; events: number; activity: number; votes: number }>(`/explorer/address/${encodeURIComponent(address)}/counts`, signal),
  // Activity rows surviving a $-value filter (smol threshold) — null while the value index backfills.
  accountActivityCount: (address: string, min: number, signal?: AbortSignal) => getJson<{ activity: number | null }>(withQuery(`/explorer/address/${encodeURIComponent(address)}/activity-count`, { min }), signal),
  tag: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(`/explorer/tag/${encodeURIComponent(tagId)}`, signal),
  // Lightweight variant for the hover card (skips the heavy portfolio-history walk).
  tagSummary: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}`, { summary: '1' }), signal),
  tagActivity: (tagId: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, tail?: number, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/activity`, { type, offset, limit, action, from, to, ...filters, tail }), signal),
  tagExtrinsics: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  tagEvents: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/events`, { offset, limit, from, to, ...filters }), signal),
  tagVotes: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/votes`, { offset, limit, from, to }), signal),
  tagActivityCounts: (tagId: string, signal?: AbortSignal) => getJson<{ extrinsics: number; events: number; activity: number; votes: number }>(`/explorer/tag/${encodeURIComponent(tagId)}/counts`, signal),
  tagActivityCount: (tagId: string, min: number, signal?: AbortSignal) => getJson<{ activity: number | null }>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/activity-count`, { min }), signal),
  search: (query: string, signal?: AbortSignal) => getJson<SearchResult[]>(withQuery('/explorer/search', { q: query }), signal),
  assets: (signal?: AbortSignal) => getJson<AssetListItem[]>('/explorer/assets', signal),
  hdx: (signal?: AbortSignal) => getJson<HdxDashboard>('/explorer/hdx', signal),
  hollar: (signal?: AbortSignal) => getJson<HollarDashboard>('/explorer/hollar', signal),
  accounts: (offset = 0, limit = 50, sort: AccountSort = 'value', signal?: AbortSignal) => getJson<AccountsPage>(withQuery('/explorer/accounts', { offset, limit, sort }), signal),
  // The daily histogram can mirror the activity page's tab + filters.
  daily: (scope: string, params?: { type?: string; action?: string; token?: string }, signal?: AbortSignal) => getJson<DailyPoint[]>(withQuery(`/explorer/daily/${scope}`, { ...params }), signal),
  accountsDaily: (signal?: AbortSignal) => getJson<{ date: string; active: number; new: number }[]>('/explorer/accounts-daily', signal),
  tags: (signal?: AbortSignal) => getJson<Tag[]>('/explorer/tags', signal),
}
