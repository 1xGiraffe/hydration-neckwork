import type {
  ExplorerStats, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  HoldersResponse, AddressDetail, SearchResult, Tag, AssetListItem, AssetFilterItem,
  AccountsPage, AccountSort, DailyPoint, IndexerStatus, EventRow, EventDetail, ActivityRow, VoteRow, MoneyMarketResponse, AssetDetail, TagDetail,
  AccountHistoryResponse, CloseAccountsResponse, HdxDashboard, HollarDashboard, TradeDetail, DcaScheduleDetail, DcaExecutionDetail,
  ValueEvent, ReferendumDetail,
  LibrarySummaryRef, LibraryDetailResponse, LibraryTagDetail, TagMapResponse, MeResponse, ProfileRef, LoginChallengeResponse, LoginResponse,
} from '../types'
import { getSession, setSession } from '../session'

// A failed request carries the API's own explanation (Fastify puts it in
// `message`, hand-written rejections in `error`). Keeping it on the error lets a
// list surface actionable guidance — "narrow the filters" for a too-broad
// activity window — instead of a bare status.
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null
    throw new ApiError(response.status, body?.message || body?.error || `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

// Authenticated JSON. A 401 means the session died server-side (expired,
// revoked) — drop it locally so the UI falls back to logged-out everywhere.
async function authedJson<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getSession()?.token
  const response = await fetch(`/api${path}`, {
    method, signal,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401) setSession(null)
  if (!response.ok) {
    const errBody = await response.json().catch(() => null) as { error?: string; message?: string } | null
    throw new ApiError(response.status, errBody?.message || errBody?.error || `${response.status} ${response.statusText}`)
  }
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
export interface ExtrinsicFilters { call?: string; result?: string; origin?: string }
export interface EventFilters { event?: string }
// Which list on an account/tag detail page a total is being asked for, plus the
// filters that list is showing. The total must move with the filters, so every
// filter field a list can apply travels with the request.
export type ListTab = 'activity' | 'extrinsics' | 'events' | 'votes'
// Tab badges: the exact length of each list, unfiltered.
export interface TabCounts { extrinsics: number; extrinsicsOnBehalf?: number; events: number; votes: number }
export interface ListCountQuery extends ValueFilters, ExtrinsicFilters, EventFilters {
  tab: ListTab
  type?: string
  action?: string
  from?: string
  to?: string
}
// One list's length. `complete: false` = `total` counts only the newest rows of a
// list that runs deeper than one candidate window reaches, so the pages it numbers
// are real but are not all the list has.
export interface ListCount { total: number | null; complete: boolean }
// The chain-wide Activity feed's length under the filters shown, plus the deepest
// offset the API serves it at. `total: null` = this category is assembled from
// several sources and cannot be counted without classifying chain-wide history, so
// its pager walks by `maxOffset` instead of numbering pages.
export interface ActivityCount extends ListCount { maxOffset: number }
// Global list totals, plus the deepest offset those lists serve — the events feed
// is far longer than its servable depth, so its pager needs both numbers.
export interface ListCounts { blocks: number; extrinsics: number; events: number; transfers: number; maxOffset: number }

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
  extrinsicEncoded: (height: number, index: number, signal?: AbortSignal) =>
    getJson<{ encoded: string }>(`/explorer/extrinsic-at/${height}/${index}/encoded`, signal),
  referendum: (pallet: 'opengov' | 'democracy', index: number, signal?: AbortSignal, limit?: number) =>
    getJson<ReferendumDetail>(withQuery(`/explorer/referendum/${pallet}/${index}`, limit == null ? {} : { limit }), signal),
  dcaSchedule: (scheduleId: number, offset = 0, limit = 25, signal?: AbortSignal) => getJson<DcaScheduleDetail>(withQuery(`/explorer/dca/${scheduleId}`, { offset, limit }), signal),
  dcaScheduleAt: (height: number, index: number, kind: 'event' | 'extrinsic', signal?: AbortSignal) => getJson<{ scheduleId: number }>(withQuery(`/explorer/dca-at/${height}/${index}`, { kind }), signal),
  dcaExecution: (height: number, index: number, signal?: AbortSignal) => getJson<DcaExecutionDetail>(`/explorer/dca/exec/${height}/${index}`, signal),
  trade: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade/${height}/${index}`, signal),
  tradeEvent: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade-event/${height}/${index}`, signal),
  events: (limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters, signal?: AbortSignal) => getJson<EventRow[]>(withQuery('/explorer/events', { limit, offset, from, to, ...filters }), signal),
  eventAt: (height: number, index: number, signal?: AbortSignal) => getJson<EventDetail>(`/explorer/event/${height}/${index}`, signal),
  activity: (limit = 25, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string, signal?: AbortSignal) => getJson<ActivityRow[]>(withQuery('/explorer/activity', { limit, offset, type, action, from, to, ...filters }), signal),
  // What the Activity pager sizes itself against: the feed's length under exactly
  // these filters where it can be counted, and always the servable depth.
  activityCount: (type = 'all', from?: string, to?: string, filters?: ValueFilters, action?: string, signal?: AbortSignal) =>
    getJson<ActivityCount>(withQuery('/explorer/activity/count', { type, action, from, to, ...filters }), signal),
  counts: (signal?: AbortSignal) => getJson<ListCounts>('/explorer/counts', signal),
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
  // Value-chart variant: `series=1` leaves out the per-asset balance history, 98-99%
  // of the full payload and read only by the Balances treemap.
  addressHistorySeries: (address: string, signal?: AbortSignal) => getJson<AccountHistoryResponse>(withQuery(`/explorer/address/${encodeURIComponent(address)}/history`, { series: '1' }), signal),
  closeAccounts: (address: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/address/${encodeURIComponent(address)}/close-accounts`, signal),
  tagCloseAccounts: (tagId: string, signal?: AbortSignal) => getJson<CloseAccountsResponse>(`/explorer/tag/${encodeURIComponent(tagId)}/close-accounts`, signal),
  accountActivity: (address: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/activity`, { type, offset, limit, action, from, to, ...filters }), signal),
  accountExtrinsics: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  accountEvents: (address: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/events`, { offset, limit, from, to, ...filters }), signal),
  // Governance votes cast by the account (OpenGov + Democracy + collectives).
  accountVotes: (address: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/votes`, { offset, limit, from, to }), signal),
  accountActivityCounts: (address: string, signal?: AbortSignal) => getJson<TabCounts>(`/explorer/address/${encodeURIComponent(address)}/counts`, signal),
  // How many rows one list holds under exactly the filters it is showing. `total` is
  // exact for the rows it covers; `complete: false` = the list runs deeper than the
  // pages that total can number. `total: null` = no countable prefix at all.
  accountListCount: (address: string, query: ListCountQuery, signal?: AbortSignal) =>
    getJson<ListCount>(withQuery(`/explorer/address/${encodeURIComponent(address)}/list-count`, { ...query }), signal),
  // Largest value-changing events (big transfers/swaps/liquidations) for the
  // value-history chart's markers; defaults to the account's full indexed range.
  accountValueEvents: (address: string, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<ValueEvent[]>(withQuery(`/explorer/address/${encodeURIComponent(address)}/value-events`, { from, to }), signal),
  tagValueEvents: (tagId: string, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<ValueEvent[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/value-events`, { from, to }), signal),
  tag: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(`/explorer/tag/${encodeURIComponent(tagId)}`, signal),
  // Lightweight variant for the hover card (skips the heavy portfolio-history walk).
  tagSummary: (tagId: string, signal?: AbortSignal) => getJson<TagDetail>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}`, { summary: '1' }), signal),
  tagActivity: (tagId: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/activity`, { type, offset, limit, action, from, to, ...filters }), signal),
  tagExtrinsics: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/extrinsics`, { offset, limit, from, to, ...filters }), signal),
  tagEvents: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    getJson<EventRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/events`, { offset, limit, from, to, ...filters }), signal),
  tagVotes: (tagId: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    getJson<VoteRow[]>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/votes`, { offset, limit, from, to }), signal),
  tagActivityCounts: (tagId: string, signal?: AbortSignal) => getJson<TabCounts>(`/explorer/tag/${encodeURIComponent(tagId)}/counts`, signal),
  tagListCount: (tagId: string, query: ListCountQuery, signal?: AbortSignal) =>
    getJson<ListCount>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/list-count`, { ...query }), signal),
  search: (query: string, signal?: AbortSignal) => getJson<SearchResult[]>(withQuery('/explorer/search', { q: query }), signal),
  assets: (signal?: AbortSignal) => getJson<AssetListItem[]>('/explorer/assets', signal),
  // Token-filter variant: the same ordered directory without prices, totals or
  // sparklines — 74 kB down to 5.8 kB, since the combo reads ids and symbols only.
  assetFilterOptions: (signal?: AbortSignal) => getJson<AssetFilterItem[]>(withQuery('/explorer/assets', { fields: 'filter' }), signal),
  hdx: (signal?: AbortSignal) => getJson<HdxDashboard>('/explorer/hdx', signal),
  hollar: (signal?: AbortSignal) => getJson<HollarDashboard>('/explorer/hollar', signal),
  accounts: (offset = 0, limit = 50, sort: AccountSort = 'value', signal?: AbortSignal) => getJson<AccountsPage>(withQuery('/explorer/accounts', { offset, limit, sort }), signal),
  // The daily histogram can mirror the activity page's tab + filters.
  daily: (scope: string, params?: { type?: string; action?: string; token?: string }, signal?: AbortSignal) => getJson<DailyPoint[]>(withQuery(`/explorer/daily/${scope}`, { ...params }), signal),
  accountsDaily: (signal?: AbortSignal) => getJson<{ date: string; active: number; new: number }[]>('/explorer/accounts-daily', signal),
  tags: (signal?: AbortSignal) => getJson<Tag[]>('/explorer/tags', signal),
  // Public, shared-cacheable tag-library directory — no auth, no per-viewer
  // fields (subscribed etc. come only from the authenticated userApi.library).
  libraries: (signal?: AbortSignal) => getJson<LibrarySummaryRef[]>('/explorer/libraries', signal),
  library: (id: string, signal?: AbortSignal) => getJson<LibraryDetailResponse>(`/explorer/library/${encodeURIComponent(id)}`, signal),
  addressLibraries: (address: string, signal?: AbortSignal) => getJson<LibrarySummaryRef[]>(`/explorer/address/${encodeURIComponent(address)}/libraries`, signal),
}

export const userApi = {
  challenge: (address: string) => authedJson<LoginChallengeResponse>('POST', '/user/auth/challenge', { address }),
  verify: (address: string, nonce: string, signature: string) => authedJson<LoginResponse>('POST', '/user/auth/verify', { address, nonce, signature }),
  logout: () => authedJson<{ ok: true }>('POST', '/user/auth/logout'),
  me: (signal?: AbortSignal) => authedJson<MeResponse>('GET', '/user/me', undefined, signal),
  tagMap: (signal?: AbortSignal) => authedJson<TagMapResponse>('GET', '/user/tag-map', undefined, signal),
  setProfileName: (name: string) => authedJson<ProfileRef>('PUT', '/user/profile', { name }),
  setAvatar: (data: string) => authedJson<ProfileRef>('PUT', '/user/profile/avatar', { data }),
  clearAvatar: () => authedJson<ProfileRef>('DELETE', '/user/profile/avatar'),
  library: (id: string, signal?: AbortSignal) => authedJson<LibraryDetailResponse>('GET', `/user/libraries/${encodeURIComponent(id)}`, undefined, signal),
  createLibrary: (body: { name: string; note?: string; visibility: 'private' | 'public' }) => authedJson<LibraryDetailResponse>('POST', '/user/libraries', body),
  updateLibrary: (id: string, body: { name?: string; note?: string; visibility?: 'private' | 'public' }) => authedJson<LibraryDetailResponse>('PATCH', `/user/libraries/${encodeURIComponent(id)}`, body),
  deleteLibrary: (id: string) => authedJson<{ ok: true }>('DELETE', `/user/libraries/${encodeURIComponent(id)}`),
  createTag: (id: string, body: { name: string; color?: string; icon?: string; note?: string }) => authedJson<LibraryTagDetail>('POST', `/user/libraries/${encodeURIComponent(id)}/tags`, body),
  updateTag: (id: string, tagId: string, body: { name?: string; color?: string; icon?: string; note?: string }) => authedJson<LibraryTagDetail>('PATCH', `/user/libraries/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`, body),
  deleteTag: (id: string, tagId: string) => authedJson<{ ok: true }>('DELETE', `/user/libraries/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`),
  setTagMembers: (id: string, tagId: string, body: { add?: string[]; remove?: string[] }) => authedJson<LibraryTagDetail>('PUT', `/user/libraries/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}/members`, body),
  invite: (id: string, address: string) => authedJson<{ ok: true }>('POST', `/user/libraries/${encodeURIComponent(id)}/invites`, { address }),
  revokeInvite: (id: string, address: string) => authedJson<{ ok: true }>('DELETE', `/user/libraries/${encodeURIComponent(id)}/invites/${encodeURIComponent(address)}`),
  invites: (signal?: AbortSignal) => authedJson<LibrarySummaryRef[]>('GET', '/user/invites', undefined, signal),
  respondInvite: (libraryId: string, accept: boolean) => authedJson<{ ok: true }>('POST', `/user/invites/${encodeURIComponent(libraryId)}/${accept ? 'accept' : 'decline'}`),
  subscribe: (libraryId: string) => authedJson<{ ok: true }>('POST', '/user/subscriptions', { libraryId }),
  unsubscribe: (libraryId: string) => authedJson<{ ok: true }>('DELETE', `/user/subscriptions/${encodeURIComponent(libraryId)}`),
  setOrder: (libraryIds: string[]) => authedJson<{ order: string[] }>('PUT', '/user/library-order', { libraryIds }),
}
