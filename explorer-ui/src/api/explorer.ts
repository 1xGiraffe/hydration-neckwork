import type {
  ExplorerStats, BlockSummary, BlockDetail, ExtrinsicSummary, ExtrinsicDetail,
  HoldersResponse, AddressDetail, SearchResult, Tag, AssetListItem, AssetFilterItem, FilterNames,
  AccountsPage, AccountSort, ContractsPage, ContractSort, ContractAbiPayload, ContractSourcesPayload, ContractTransactionsPage, ContractEventsPage, VerificationJob, DailyPoint, IndexerStatus, EventRow, EventDetail, ActivityRow, VoteRow, VotesByReferendumPage, MoneyMarketResponse, AssetDetail, TagDetail, RevenueBreakdown, GovernanceOverview, GovernanceReferendaPage, CollectiveMotionsPage, TreasuryTipsPage,
  AccountHistoryResponse, CloseAccountsResponse, HdxDashboard,
  RevenueDashboard, RevenueFlowResponse, RevenueRange, HollarDashboard, SecurityDashboard, WormholeBridgeDetail, TradeDetail, DcaScheduleDetail, DcaExecutionDetail, AssetDcas,
  AssetLiquidity, PoolDetail, OmnipoolDetail, PoolLpsResponse, OmnipoolAssetLpsResponse,
  ValueEvent, ReferendumDetail,
  ListSummaryRef, ListDetailResponse, ListTagDetail, TagMapResponse, MeResponse, ProfileRef, LoginChallengeResponse, LoginResponse,
  AccountRef, DeviceLinkResponse, DeviceLinkStatus, DeviceSession, EvmReceipt, PoolsIndexResponse,
  ApiTokensResponse, CreatedApiToken, ApiUsersResponse,
  NotificationChannel, NotificationRule, NotificationRuleInput, NotificationRulePatch,
  NotificationsOverview, NotificationInboxPage, NotificationTelegramLink, NotificationLinkStatus,
  WebPushSubscriptionInput,
} from '../types'
import { getSession, setSession } from '../session'
// Live feeds stamp the pushed head onto their URLs (`h=`): the nginx
// micro-cache keys on the URI alone, so a push-triggered refetch would
// otherwise HIT the entry cached for the previous head — and with interval
// polling paused while streaming, that staleness would last until the NEXT
// block. Per-head URIs keep the shared cache (same head → same entry) while
// making a new head a guaranteed cache MISS. 0 (not streaming) omits the tag.
import { liveHeadTag } from '../live'

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

// Authenticated JSON. A 401 on a request that actually carried a bearer token
// means THAT session died server-side (expired, revoked) — drop it locally so
// the UI falls back to logged-out everywhere. Never clear on a 401 from
// /user/auth/* though: challenge/verify are pre-auth (never carry the session
// they'd be clearing), so a bad-signature verify during an account SWITCH must
// not log the still-valid original session out across every tab; logout
// clears its own session unconditionally in its caller regardless of this.
async function authedJson<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getSession()?.token
  const response = await fetch(`/api${path}`, {
    method, signal,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401 && token && !path.startsWith('/user/auth/')) setSession(null)
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

// `minRevenue` is a floor on what the PROTOCOL earned on the row's extrinsic, which
// is a different question from `min` (the row's own value) and always in USD — it has
// no token denomination, so the unit toggle does not apply to it.
export interface ValueFilters { token?: string; min?: string; minRevenue?: string; identity?: string }
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
  stats: (signal?: AbortSignal) => getJson<ExplorerStats>(withQuery('/explorer/stats', { h: liveHeadTag() || undefined }), signal),
  indexer: (signal?: AbortSignal) => getJson<IndexerStatus>('/indexer', signal),
  blocks: (limit = 25, offset = 0, signal?: AbortSignal) => getJson<BlockSummary[]>(withQuery('/explorer/blocks', { limit, offset, h: liveHeadTag() || undefined }), signal),
  block: (height: number, signal?: AbortSignal) => getJson<BlockDetail>(`/explorer/block/${height}`, signal),
  blockActivity: (height: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/block/${height}/activity`, signal),
  extrinsics: (limit = 25, signedOnly = false, from?: string, to?: string, offset = 0, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    getJson<ExtrinsicSummary[]>(withQuery('/explorer/extrinsics', { limit, offset, signedOnly, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  extrinsic: (hash: string, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic/${hash}`, signal),
  extrinsicAt: (height: number, index: number, signal?: AbortSignal) => getJson<ExtrinsicDetail>(`/explorer/extrinsic-at/${height}/${index}`, signal),
  extrinsicActivity: (hash: string, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic/${hash}/activity`, signal),
  extrinsicAtActivity: (height: number, index: number, signal?: AbortSignal) => getJson<ActivityRow[]>(`/explorer/extrinsic-at/${height}/${index}/activity`, signal),
  extrinsicEncoded: (height: number, index: number, signal?: AbortSignal) =>
    getJson<{ encoded: string }>(`/explorer/extrinsic-at/${height}/${index}/encoded`, signal),
  // Gas for one EVM transaction, from the chain's own receipt (nothing indexes it).
  // 404 when the node cannot answer — the extrinsic page then omits the gas rows.
  evmReceipt: (txHash: string, signal?: AbortSignal) => getJson<EvmReceipt>(`/explorer/evm-tx/${txHash}/receipt`, signal),
  referendum: (pallet: 'opengov' | 'democracy', index: number, signal?: AbortSignal, limit?: number) =>
    getJson<ReferendumDetail>(withQuery(`/explorer/referendum/${pallet}/${index}`, limit == null ? {} : { limit }), signal),
  dcaSchedule: (scheduleId: number, offset = 0, limit = 25, signal?: AbortSignal) => getJson<DcaScheduleDetail>(withQuery(`/explorer/dca/${scheduleId}`, { offset, limit }), signal),
  dcaScheduleAt: (height: number, index: number, kind: 'event' | 'extrinsic', signal?: AbortSignal) => getJson<{ scheduleId: number }>(withQuery(`/explorer/dca-at/${height}/${index}`, { kind }), signal),
  dcaExecution: (height: number, index: number, signal?: AbortSignal) => getJson<DcaExecutionDetail>(`/explorer/dca/exec/${height}/${index}`, signal),
  trade: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade/${height}/${index}`, signal),
  tradeEvent: (height: number, index: number, signal?: AbortSignal) => getJson<TradeDetail>(`/explorer/trade-event/${height}/${index}`, signal),
  events: (limit = 25, from?: string, to?: string, offset = 0, filters?: EventFilters, signal?: AbortSignal) => getJson<EventRow[]>(withQuery('/explorer/events', { limit, offset, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  eventAt: (height: number, index: number, signal?: AbortSignal) => getJson<EventDetail>(`/explorer/event/${height}/${index}`, signal),
  activity: (limit = 25, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string, signal?: AbortSignal) => getJson<ActivityRow[]>(withQuery('/explorer/activity', { limit, offset, type, action, from, to, ...filters, h: liveHeadTag() || undefined }), signal),
  // What the Activity pager sizes itself against: the feed's length under exactly
  // these filters where it can be counted, and always the servable depth.
  activityCount: (type = 'all', from?: string, to?: string, filters?: ValueFilters, action?: string, signal?: AbortSignal) =>
    getJson<ActivityCount>(withQuery('/explorer/activity/count', { type, action, from, to, ...filters }), signal),
  counts: (signal?: AbortSignal) => getJson<ListCounts>('/explorer/counts', signal),
  moneyMarket: (limit = 50, signal?: AbortSignal) => getJson<MoneyMarketResponse>(withQuery('/explorer/money-market', { limit }), signal),
  asset: (assetId: number, signal?: AbortSignal) => getJson<AssetDetail>(`/explorer/asset/${assetId}`, signal),
  assetDcas: (assetId: number, signal?: AbortSignal) => getJson<AssetDcas>(`/explorer/asset/${assetId}/dcas`, signal),
  assetLiquidity: (assetId: number, signal?: AbortSignal) => getJson<AssetLiquidity>(`/explorer/asset/${assetId}/liquidity`, signal),
  poolDetail: (poolId: number, signal?: AbortSignal) => getJson<PoolDetail>(`/explorer/pool/${poolId}`, signal),
  omnipool: (signal?: AbortSignal) => getJson<OmnipoolDetail>('/explorer/omnipool', signal),
  // Same endpoint as the global activities feed, with the asset id pinned.
  assetActivity: (assetId: number, type = 'all', offset = 0, limit = 40, action?: string, from?: string, to?: string, min?: string, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery('/explorer/activity', { asset: assetId, type, offset, limit, action, from, to, min }), signal),
  pools: (signal?: AbortSignal) => getJson<PoolsIndexResponse>('/explorer/pools', signal),
  // A pool's own activity: the swaps that happened IN it, merged with what its
  // share token did. The asset-pinned activity feed cannot answer this — a
  // routed swap's hops name the pool's members, not its share token.
  poolActivity: (poolId: number, limit = 25, signal?: AbortSignal) =>
    getJson<ActivityRow[]>(withQuery(`/explorer/pool/${poolId}/activity`, { limit }), signal),
  // A pool's liquidity providers (share-token holders, farm principal
  // attributed), and one omnipool asset's LP ranking (position owners plus the
  // protocol's own shares). Both paged server-side over the full ranking.
  poolLps: (poolId: number, offset = 0, limit = 10, signal?: AbortSignal) =>
    getJson<PoolLpsResponse>(withQuery(`/explorer/pool/${poolId}/lps`, { offset, limit }), signal),
  omnipoolLps: (assetId: number, offset = 0, limit = 10, signal?: AbortSignal) =>
    getJson<OmnipoolAssetLpsResponse>(withQuery(`/explorer/omnipool/${assetId}/lps`, { offset, limit }), signal),
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
  // Where the protocol revenue this account generated came from (stream × asset).
  accountRevenueBreakdown: (address: string, signal?: AbortSignal) =>
    getJson<RevenueBreakdown>(`/explorer/address/${encodeURIComponent(address)}/revenue-breakdown`, signal),
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
  // The tag's members as directory rows — the same shape /explorer/accounts
  // returns, so a tag page renders the directory table rather than its own list.
  tagMembers: (tagId: string, signal?: AbortSignal) =>
    getJson<AccountsPage>(`/explorer/tag/${encodeURIComponent(tagId)}/members`, signal),
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
  governance: (signal?: AbortSignal) => getJson<GovernanceOverview>('/explorer/governance', signal),
  governanceReferenda: (pallet: 'opengov' | 'democracy', status?: string, track?: number, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<GovernanceReferendaPage>(withQuery('/explorer/governance/referenda', { pallet, status, track, offset, limit }), signal),
  governanceMotions: (body: 'tc' | 'council', offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<CollectiveMotionsPage>(withQuery('/explorer/governance/motions', { body, offset, limit }), signal),
  governanceTips: (offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<TreasuryTipsPage>(withQuery('/explorer/governance/tips', { offset, limit }), signal),
  tagRevenueBreakdown: (tagId: string, signal?: AbortSignal) =>
    getJson<RevenueBreakdown>(`/explorer/tag/${encodeURIComponent(tagId)}/revenue-breakdown`, signal),
  // Grouped mode of the votes tab: one row per referendum, members combined.
  tagVotesByReferendum: (tagId: string, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<VotesByReferendumPage>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/votes-by-referendum`, { offset, limit }), signal),
  tagActivityCounts: (tagId: string, signal?: AbortSignal) => getJson<TabCounts>(`/explorer/tag/${encodeURIComponent(tagId)}/counts`, signal),
  tagListCount: (tagId: string, query: ListCountQuery, signal?: AbortSignal) =>
    getJson<ListCount>(withQuery(`/explorer/tag/${encodeURIComponent(tagId)}/list-count`, { ...query }), signal),
  search: (query: string, signal?: AbortSignal) => getJson<SearchResult[]>(withQuery('/explorer/search', { q: query }), signal),
  assets: (signal?: AbortSignal) => getJson<AssetListItem[]>('/explorer/assets', signal),
  // Token-filter variant: the same ordered directory without prices, totals or
  // sparklines — 74 kB down to 5.8 kB, since the combo reads ids and symbols only.
  assetFilterOptions: (signal?: AbortSignal) => getJson<AssetFilterItem[]>(withQuery('/explorer/assets', { fields: 'filter' }), signal),
  // The call/event names the data actually holds, for the name filters and the
  // alert form's pallet/name pickers. Cached an hour on both ends — a name list
  // moves only with a runtime upgrade.
  filterNames: (signal?: AbortSignal) => getJson<FilterNames>('/explorer/filter-names', signal),
  hdx: (signal?: AbortSignal) => getJson<HdxDashboard>('/explorer/hdx', signal),
  revenue: (range: RevenueRange = '30d', signal?: AbortSignal) => getJson<RevenueDashboard>(withQuery('/explorer/revenue', { range }), signal),
  // Live feed: the head tag busts the edge micro-cache the moment a block lands.
  revenueFlow: (after?: string | null, signal?: AbortSignal) => getJson<RevenueFlowResponse>(withQuery('/explorer/revenue/flow', { after: after || undefined, h: liveHeadTag() || undefined }), signal),
  hollar: (signal?: AbortSignal) => getJson<HollarDashboard>('/explorer/hollar', signal),
  security: (signal?: AbortSignal) => getJson<SecurityDashboard>('/explorer/security', signal),
  securityWormhole: (signal?: AbortSignal) => getJson<WormholeBridgeDetail>('/explorer/security/wormhole', signal),
  accounts: (offset = 0, limit = 50, sort: AccountSort = 'value', signal?: AbortSignal) => getJson<AccountsPage>(withQuery('/explorer/accounts', { offset, limit, sort }), signal),
  contracts: (offset = 0, limit = 50, sort: ContractSort = 'created', signal?: AbortSignal) => getJson<ContractsPage>(withQuery('/explorer/contracts', { offset, limit, sort }), signal),
  // Lazy verified-contract artifacts (Code/Read sub-tabs); 404 when unverified.
  contractAbi: (address: string, signal?: AbortSignal) => getJson<ContractAbiPayload>(`/explorer/contract/${encodeURIComponent(address)}/abi`, signal),
  contractSources: (address: string, signal?: AbortSignal) => getJson<ContractSourcesPayload>(`/explorer/contract/${encodeURIComponent(address)}/sources`, signal),
  compilerVersions: (signal?: AbortSignal) => getJson<{ versions: string[] }>('/explorer/contract/compiler-versions', signal),
  // Contract-tab activity: the contract's own transactions and events with
  // page-bounded verified-ABI decoding (method chips, named log params).
  contractTransactions: (address: string, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<ContractTransactionsPage>(withQuery(`/explorer/contract/${encodeURIComponent(address)}/transactions`, { offset, limit }), signal),
  contractEvents: (address: string, offset = 0, limit = 25, signal?: AbortSignal) =>
    getJson<ContractEventsPage>(withQuery(`/explorer/contract/${encodeURIComponent(address)}/events`, { offset, limit }), signal),
  // Sourcify V2 verification (the same surface `forge verify-contract` uses).
  // The api mounts these under /v2 — nginx/vite strip the /api prefix — and a
  // failed submit answers with {customCode, message}, which ApiError surfaces.
  verifySubmit: async (address: string, body: { stdJsonInput: unknown; compilerVersion: string; contractIdentifier: string }): Promise<{ verificationId: string }> => {
    const response = await fetch(`/api/v2/verify/222222/${encodeURIComponent(address)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status !== 202) {
      const errBody = await response.json().catch(() => null) as { message?: string; error?: string } | null
      throw new ApiError(response.status, errBody?.message || errBody?.error || `${response.status} ${response.statusText}`)
    }
    return response.json() as Promise<{ verificationId: string }>
  },
  verifyPoll: (verificationId: string, signal?: AbortSignal) => getJson<VerificationJob>(`/v2/verify/${encodeURIComponent(verificationId)}`, signal),
  // The daily histogram can mirror the activity page's tab + filters.
  daily: (scope: string, params?: { type?: string; action?: string; token?: string }, signal?: AbortSignal) => getJson<DailyPoint[]>(withQuery(`/explorer/daily/${scope}`, { ...params }), signal),
  accountsDaily: (signal?: AbortSignal) => getJson<{ date: string; active: number; new: number }[]>('/explorer/accounts-daily', signal),
  tags: (signal?: AbortSignal) => getJson<Tag[]>('/explorer/tags', signal),
  // Public, shared-cacheable tag-list directory — no auth, no per-viewer
  // fields (subscribed etc. come only from the authenticated userApi.list).
  lists: (signal?: AbortSignal) => getJson<ListSummaryRef[]>('/explorer/lists', signal),
  // Display refs for wallet addresses (connect dialog): input order, null per
  // unparseable entry, canonical Polkadot/H160 display form + identity/profile.
  accountRefs: (addresses: string[], signal?: AbortSignal) =>
    getJson<(AccountRef | null)[]>(withQuery('/explorer/account-refs', { addresses: addresses.join(',') }), signal),
  list: (id: string, signal?: AbortSignal) => getJson<ListDetailResponse>(`/explorer/list/${encodeURIComponent(id)}`, signal),
  addressLists: (address: string, signal?: AbortSignal) => getJson<ListSummaryRef[]>(`/explorer/address/${encodeURIComponent(address)}/lists`, signal),
  // Public lists that TAG this address as a member — distinct from
  // addressLists above (lists the address itself OWNS). Same summary shape,
  // never tag names/other members (see the route's own comment).
  addressTaggedIn: (address: string, signal?: AbortSignal) => getJson<ListSummaryRef[]>(`/explorer/address/${encodeURIComponent(address)}/tagged-in`, signal),
}

export const userApi = {
  challenge: (address: string) => authedJson<LoginChallengeResponse>('POST', '/user/auth/challenge', { address }),
  verify: (address: string, nonce: string, signature: string) => authedJson<LoginResponse>('POST', '/user/auth/verify', { address, nonce, signature }),
  logout: () => authedJson<{ ok: true }>('POST', '/user/auth/logout'),
  // QR device-link handoff (see deviceLink.ts). All three live under
  // /user/auth/ so authedJson's 401 carve-out applies: a rejected code never
  // clears a session this device already holds.
  createDeviceLink: () => authedJson<DeviceLinkResponse>('POST', '/user/auth/device-link'),
  deviceLinkStatus: (linkId: string, signal?: AbortSignal) => authedJson<{ status: DeviceLinkStatus }>('GET', `/user/auth/device-link/${encodeURIComponent(linkId)}`, undefined, signal),
  claimDeviceLink: (code: string) => authedJson<LoginResponse>('POST', '/user/auth/device-link/claim', { code }),
  sessions: (signal?: AbortSignal) => authedJson<{ sessions: DeviceSession[] }>('GET', '/user/sessions', undefined, signal),
  revokeSession: (id: string) => authedJson<{ ok: true }>('DELETE', `/user/sessions/${encodeURIComponent(id)}`),
  // Data API tokens (the hydration-data host authenticates with these; CRUD
  // lives here where the wallet session is). The create response is the ONLY
  // place the raw secret ever appears.
  apiTokens: (signal?: AbortSignal) => authedJson<ApiTokensResponse>('GET', '/user/api-tokens', undefined, signal),
  createApiToken: (label: string) => authedJson<CreatedApiToken>('POST', '/user/api-tokens', { label }),
  revokeApiToken: (id: string) => authedJson<{ ok: true }>('DELETE', `/user/api-tokens/${encodeURIComponent(id)}`),
  // Admin (allowlist-gated server-side; 404 for everyone else).
  apiUsers: (signal?: AbortSignal) => authedJson<ApiUsersResponse>('GET', '/user/admin/api-users', undefined, signal),
  setApiUserLimits: (accountId: string, body: { perMinute: number; perDay: number; note?: string }) =>
    authedJson<{ ok: true }>('PUT', `/user/admin/api-users/${encodeURIComponent(accountId)}/limits`, body),
  clearApiUserLimits: (accountId: string) => authedJson<{ ok: true }>('DELETE', `/user/admin/api-users/${encodeURIComponent(accountId)}/limits`),
  adminRevokeApiToken: (id: string) => authedJson<{ ok: true }>('DELETE', `/user/admin/api-tokens/${encodeURIComponent(id)}`),
  me: (signal?: AbortSignal) => authedJson<MeResponse>('GET', '/user/me', undefined, signal),
  tagMap: (signal?: AbortSignal) => authedJson<TagMapResponse>('GET', '/user/tag-map', undefined, signal),
  setProfileName: (name: string) => authedJson<ProfileRef>('PUT', '/user/profile', { name }),
  setAvatar: (data: string) => authedJson<ProfileRef>('PUT', '/user/profile/avatar', { data }),
  clearAvatar: () => authedJson<ProfileRef>('DELETE', '/user/profile/avatar'),
  list: (id: string, signal?: AbortSignal) => authedJson<ListDetailResponse>('GET', `/user/lists/${encodeURIComponent(id)}`, undefined, signal),
  createList: (body: { name: string; note?: string; visibility: 'private' | 'public' }) => authedJson<ListDetailResponse>('POST', '/user/lists', body),
  updateList: (id: string, body: { name?: string; note?: string; visibility?: 'private' | 'public' }) => authedJson<ListDetailResponse>('PATCH', `/user/lists/${encodeURIComponent(id)}`, body),
  deleteList: (id: string) => authedJson<{ ok: true }>('DELETE', `/user/lists/${encodeURIComponent(id)}`),
  createTag: (id: string, body: { name: string; color?: string; icon?: string; note?: string }) => authedJson<ListTagDetail>('POST', `/user/lists/${encodeURIComponent(id)}/tags`, body),
  updateTag: (id: string, tagId: string, body: { name?: string; color?: string; icon?: string; note?: string }) => authedJson<ListTagDetail>('PATCH', `/user/lists/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`, body),
  deleteTag: (id: string, tagId: string) => authedJson<{ ok: true }>('DELETE', `/user/lists/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`),
  setTagMembers: (id: string, tagId: string, body: { add?: string[]; remove?: string[] }) => authedJson<ListTagDetail>('PUT', `/user/lists/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}/members`, body),
  // Drag/keyboard reorder: `accountIds` must be a permutation of the tag's
  // current members — the server 400s otherwise (see setMemberOrder).
  setMemberOrder: (id: string, tagId: string, accountIds: string[]) =>
    authedJson<ListTagDetail>('PUT', `/user/lists/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}/member-order`, { accountIds }),
  // A list tag's own aggregate view (combined balances/history/activity of all
  // its members) — same TagDetail shape the system /tag/:id page uses, authed
  // because a private list's tag contents are owner/subscriber-only.
  listTag: (listId: string, tagId: string, signal?: AbortSignal) =>
    authedJson<TagDetail>('GET', `/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}`, undefined, signal),
  // The same activity feeds as the public ones, with the viewer's OWN and
  // subscribed tags counting as names for the identity filter. Identical params
  // and response shape, so a caller swaps endpoints and reads it unchanged.
  activity: (limit = 25, from?: string, to?: string, offset = 0, type = 'all', filters?: ValueFilters, action?: string, signal?: AbortSignal) =>
    authedJson<ActivityRow[]>('GET', withQuery('/user/activity', { limit, offset, type, action, from, to, ...filters }), undefined, signal),
  activityCount: (type = 'all', from?: string, to?: string, filters?: ValueFilters, action?: string, signal?: AbortSignal) =>
    authedJson<ActivityCount>('GET', withQuery('/user/activity/count', { type, action, from, to, ...filters }), undefined, signal),
  accountActivity: (address: string, type = 'all', offset = 0, limit = 40, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    authedJson<ActivityRow[]>('GET', withQuery(`/user/address/${encodeURIComponent(address)}/activity`, { type, offset, limit, action, from, to, ...filters }), undefined, signal),
  tagActivity: (tagId: string, type = 'all', offset = 0, limit = 40, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    authedJson<ActivityRow[]>('GET', withQuery(`/user/tag/${encodeURIComponent(tagId)}/activity`, { type, offset, limit, action, from, to, ...filters }), undefined, signal),
  listTagMembers: (listId: string, tagId: string, signal?: AbortSignal) =>
    authedJson<AccountsPage>('GET', `/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/members`, undefined, signal),
  listTagSummary: (listId: string, tagId: string, signal?: AbortSignal) =>
    authedJson<TagDetail>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}`, { summary: '1' }), undefined, signal),
  listTagActivity: (listId: string, tagId: string, type = 'all', offset = 0, limit = 25, action?: string, from?: string, to?: string, filters?: ValueFilters, signal?: AbortSignal) =>
    authedJson<ActivityRow[]>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/activity`, { type, offset, limit, action, from, to, ...filters }), undefined, signal),
  listTagExtrinsics: (listId: string, tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: ExtrinsicFilters, signal?: AbortSignal) =>
    authedJson<ExtrinsicSummary[]>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/extrinsics`, { offset, limit, from, to, ...filters }), undefined, signal),
  listTagEvents: (listId: string, tagId: string, offset = 0, limit = 25, from?: string, to?: string, filters?: EventFilters, signal?: AbortSignal) =>
    authedJson<EventRow[]>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/events`, { offset, limit, from, to, ...filters }), undefined, signal),
  listTagRevenueBreakdown: (listId: string, tagId: string, signal?: AbortSignal) =>
    authedJson<RevenueBreakdown>('GET', `/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/revenue-breakdown`, undefined, signal),
  listTagVotes: (listId: string, tagId: string, offset = 0, limit = 25, from?: string, to?: string, signal?: AbortSignal) =>
    authedJson<VoteRow[]>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/votes`, { offset, limit, from, to }), undefined, signal),
  listTagVotesByReferendum: (listId: string, tagId: string, offset = 0, limit = 25, signal?: AbortSignal) =>
    authedJson<VotesByReferendumPage>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/votes-by-referendum`, { offset, limit }), undefined, signal),
  listTagActivityCounts: (listId: string, tagId: string, signal?: AbortSignal) =>
    authedJson<TabCounts>('GET', `/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/counts`, undefined, signal),
  listTagListCount: (listId: string, tagId: string, query: ListCountQuery, signal?: AbortSignal) =>
    authedJson<ListCount>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/list-count`, { ...query }), undefined, signal),
  listTagValueEvents: (listId: string, tagId: string, from?: string, to?: string, signal?: AbortSignal) =>
    authedJson<ValueEvent[]>('GET', withQuery(`/user/list-tag/${encodeURIComponent(listId)}/${encodeURIComponent(tagId)}/value-events`, { from, to }), undefined, signal),
  invite: (id: string, address: string) => authedJson<{ ok: true }>('POST', `/user/lists/${encodeURIComponent(id)}/invites`, { address }),
  revokeInvite: (id: string, address: string) => authedJson<{ ok: true }>('DELETE', `/user/lists/${encodeURIComponent(id)}/invites/${encodeURIComponent(address)}`),
  invites: (signal?: AbortSignal) => authedJson<ListSummaryRef[]>('GET', '/user/invites', undefined, signal),
  respondInvite: (listId: string, accept: boolean) => authedJson<{ ok: true }>('POST', `/user/invites/${encodeURIComponent(listId)}/${accept ? 'accept' : 'decline'}`),
  subscribe: (listId: string) => authedJson<{ ok: true }>('POST', '/user/subscriptions', { listId }),
  unsubscribe: (listId: string) => authedJson<{ ok: true }>('DELETE', `/user/subscriptions/${encodeURIComponent(listId)}`),
  setOrder: (listIds: string[]) => authedJson<{ order: string[] }>('PUT', '/user/list-order', { listIds }),
  // Same shape as api.accounts, folded under the caller's own tags too — see
  // useAccounts (useExplorerData.ts) for when this is used instead of the
  // public endpoint.
  accounts: (offset = 0, limit = 50, sort: AccountSort = 'value', signal?: AbortSignal) =>
    authedJson<AccountsPage>('GET', withQuery('/user/accounts', { offset, limit, sort }), undefined, signal),
  // Same shape as api.holders, folded under the caller's own tags too — see
  // useHolders (useExplorerData.ts) for when this replaces the public endpoint.
  holders: (assetId: number, offset = 0, limit = 100, signal?: AbortSignal) =>
    authedJson<HoldersResponse>('GET', withQuery(`/user/holders/${assetId}`, { offset, limit }), undefined, signal),

  // ── Notifications ────────────────────────────────────────────────────
  // Channels, alert rules and the inbox. Everything lives under
  // /user/notifications/, so nginx's uncached /api/user/ location and the
  // API's own no-store stamping cover it without a rule of their own.
  notificationsOverview: (signal?: AbortSignal) =>
    authedJson<NotificationsOverview>('GET', '/user/notifications/overview', undefined, signal),
  // 503 when the deployment carries no VAPID keys — the overview says so
  // first (vapidPublicKey === ''), so this is the race, not the normal path.
  registerWebPush: (subscription: WebPushSubscriptionInput, label?: string) =>
    authedJson<NotificationChannel>('POST', '/user/notifications/channels/webpush', { subscription, ...(label ? { label } : {}) }),
  createTelegramLink: () =>
    authedJson<NotificationTelegramLink>('POST', '/user/notifications/channels/telegram/link'),
  telegramLinkStatus: (code: string, signal?: AbortSignal) =>
    authedJson<{ status: NotificationLinkStatus }>('GET', `/user/notifications/channels/telegram/link/${encodeURIComponent(code)}`, undefined, signal),
  deleteNotificationChannel: (id: string) =>
    authedJson<{ ok: true }>('DELETE', `/user/notifications/channels/${encodeURIComponent(id)}`),
  // Dispatches a real message through the real renderer, so a green reply means
  // the whole path works — not merely that the channel row exists.
  testNotificationChannel: (id: string) =>
    authedJson<{ ok: true }>('POST', `/user/notifications/channels/${encodeURIComponent(id)}/test`),
  createNotificationRule: (body: NotificationRuleInput) =>
    authedJson<NotificationRule>('POST', '/user/notifications/rules', body),
  updateNotificationRule: (id: string, body: NotificationRulePatch) =>
    authedJson<NotificationRule>('PATCH', `/user/notifications/rules/${encodeURIComponent(id)}`, body),
  deleteNotificationRule: (id: string) =>
    authedJson<{ ok: true }>('DELETE', `/user/notifications/rules/${encodeURIComponent(id)}`),
  notificationInbox: (limit = 50, offset = 0, signal?: AbortSignal) =>
    authedJson<NotificationInboxPage>('GET', withQuery('/user/notifications/inbox', { limit, offset }), undefined, signal),
  // No `ids` marks everything read — the inbox's own "you have seen these" call.
  markNotificationsRead: (ids?: string[]) =>
    authedJson<{ ok: true; marked: number; unread: number }>('POST', '/user/notifications/inbox/read', ids ? { ids } : {}),
  // Empties the history in one write. The rules are untouched and keep firing —
  // this is not unsubscribing, which is why the UI puts it behind a confirm.
  clearNotificationInbox: () =>
    authedJson<{ ok: true; cleared: number; unread: number }>('POST', '/user/notifications/inbox/clear', {}),
}
