import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { getJson, withQuery } from './explorer'
import { priceHeadTag } from '../live'
import type { AccountRef, AssetRef } from '../types'

// The oracle surface (api routes/oracles.ts, services/oracleService.ts). Prices
// are exact decimal strings in the source's own decimals; ages are seconds at the
// moment the API built the payload (`asOf.now`), so a page adds its own clock's
// drift since then rather than trusting a stale number.

export type SourceKind = 'dia' | 'push' | 'ema' | 'composite' | 'computed' | 'fixed' | 'unknown'
export type FeedStatus = 'live' | 'stale' | 'retired' | 'static'
export type SourceStatus = FeedStatus | 'fixed' | 'unknown'

export interface OracleSourceRef {
  address: string
  kind: SourceKind
  label: string
  feedId: string | null
  provider: string | null
  value: string | null
  updatedAt: string | null
  ageSec: number | null
  status: SourceStatus
  note: string | null
  components?: OracleSourceRef[]
}

/** `depth` 0: the consumer reads the feed directly (through its own adapter); 1: as a composite's input. */
export type OracleConsumer =
  | { kind: 'reserve'; market: string; marketLabel: string; asset: AssetRef; via: string | null; depth: number }
  | { kind: 'peg'; poolId: number; pool: AssetRef; asset: AssetRef; via: string | null; depth: number }

export interface OracleReserveRow {
  asset: AssetRef
  reserve: string
  oraclePrice: string | null
  marketPrice: number | null
  marketNote: string | null
  deviationPct: number | null
  source: OracleSourceRef
}
export interface OracleMarket { key: string; label: string; oracle: string | null; fallbackOracle: string | null; reserves: OracleReserveRow[] }
export interface OraclePegRow { pool: AssetRef; poolAssets: AssetRef[]; asset: AssetRef; peg: string | null; source: OracleSourceRef }

export interface FeedCadence {
  updates24h: number; updates7d: number; updates30d: number
  medianIntervalSec: number | null; longestGapSec: number | null; staleAfterSec: number
}
export interface OracleFeedRow {
  feedId: string
  kind: 'dia' | 'push'
  pair: string
  provider: string
  contract: string
  decimals: number
  latestValue: string | null
  updatedAt: string | null
  ageSec: number | null
  status: FeedStatus
  cadence: FeedCadence
  allTimeUpdates: number
  firstUpdateAt: string | null
  pushers: { account: AccountRef; updates: number }[]
  relays: AccountRef[]
  consumers: OracleConsumer[]
}
export interface EmaPairRow {
  feedId: string; assetA: AssetRef; assetB: AssetRef
  /** 1 assetB = price assetA (Short period). */
  price: string | null
  updatedAt: string; ageSec: number; updates24h: number
  consumers: OracleConsumer[]
}
export interface EmaSourceRow {
  source: string; label: string
  updates24h: number; pairs24h: number; pairs: number
  newestAt: string | null; newestAgeSec: number | null
  daily: { date: string; count: number }[]
  pairRows: EmaPairRow[]
}
export interface OracleSourceLink { address: string; label: string; feedId: string | null }
export type OracleChange =
  | { kind: 'asset-source'; market: string | null; marketLabel: string | null; oracle: string; asset: AssetRef | null; assetAddress: string; from: OracleSourceLink | null; to: OracleSourceLink; blockHeight: number; extrinsicIndex: number | null; timestamp: string }
  | { kind: 'peg-source'; pool: AssetRef; asset: AssetRef; from: OracleSourceLink | null; to: OracleSourceLink; blockHeight: number; timestamp: string }
  | { kind: 'dia-updater'; contract: string; to: AccountRef; blockHeight: number; extrinsicIndex: number | null; timestamp: string }

export interface OraclesOverview {
  asOf: { liveReadAt: string | null; liveBlock: number | null; indexedHead: number; now: string }
  history: { logsComplete: boolean; emaComplete: boolean; emaCoveredFrom: string | null; logsThroughBlock?: number; emaThroughBlock?: number }
  kpis: {
    liveFeeds: number
    staleFeeds: number
    staleUnused: number
    stale: { feedId: string; pair: string; consumed: boolean }[]
    updates24h: number
    largestDeviation: { asset: AssetRef; market: string; deviationPct: number } | null
  }
  markets: OracleMarket[]
  pegs: OraclePegRow[]
  feeds: OracleFeedRow[]
  ema: EmaSourceRow[]
  changes: OracleChange[]
  rules: { cadenceSpanSec: number; retiredAfterSec: number; minGraceSec: number; fallbackHeartbeatSec: number }
}

export type FeedRange = '7d' | '30d' | '12m' | 'all'
export interface FeedChart { range: FeedRange; stepSec: number; buckets: string[]; series: { key: string; label: string; values: (number | null)[] }[] }
export interface FeedUpdateRow {
  blockHeight: number; eventIndex: number; extrinsicIndex: number | null; timestamp: string
  value: string; changePct: number | null; intervalSec: number | null; reportedAt: string | null; pusher: AccountRef | null
}
export type EmaPeriod = 'LastBlock' | 'Short' | 'TenMinutes' | 'Hour' | 'Day' | 'Week'
export interface EmaUpdateRow { blockHeight: number; eventIndex: number; timestamp: string; prices: { period: EmaPeriod; value: string }[] }
export interface UpdatesPage<T> { rows: T[]; total: number; page: number; pageSize: number; complete: boolean }

export interface OracleFeedDetail {
  feedId: string
  kind: 'dia' | 'push' | 'ema' | 'source'
  label: string
  provider: string | null
  contract: string | null
  key: string | null
  decimals: number | null
  latestValue: string | null
  updatedAt: string | null
  ageSec: number | null
  reportedAt: string | null
  status: SourceStatus
  cadence: FeedCadence | null
  allTimeUpdates: number | null
  firstUpdateAt: string | null
  pushers: { account: AccountRef; updates: number }[]
  relays: AccountRef[]
  consumers: OracleConsumer[]
  subject: { asset: AssetRef; quote: AssetRef | null } | null
  source: OracleSourceRef | null
  ema: { source: string; sourceLabel: string; assetA: AssetRef; assetB: AssetRef; prices: { period: EmaPeriod; value: string }[]; coveredFrom: string | null; complete: boolean } | null
  chart: FeedChart | null
  updates: UpdatesPage<FeedUpdateRow> | UpdatesPage<EmaUpdateRow>
  historyComplete: boolean
}

// The API's id has a slash in a DIA key ("DOT/USD"); encode it as one segment.
const feedPath = (feed: string) => `/explorer/oracle/${encodeURIComponent(feed)}`

export const oraclesApi = {
  // `pg` — the pushed price generation: the market-price column follows it.
  overview: (signal?: AbortSignal) => getJson<OraclesOverview>(withQuery('/explorer/oracles', { pg: priceHeadTag() || undefined }), signal),
  feed: (feed: string, range: FeedRange, page: number, signal?: AbortSignal) =>
    getJson<OracleFeedDetail>(withQuery(feedPath(feed), { range, page: page > 0 ? page : undefined }), signal),
}

// The live read refreshes every 300s and the ledgers' tails every 15s; a 30s client reuse costs nothing.
const STALE = 30_000

export function useOraclesOverview() {
  return useQuery({ queryKey: ['oracles'], queryFn: ({ signal }) => oraclesApi.overview(signal), staleTime: STALE, refetchInterval: 60_000 })
}
export function useOracleFeed(feed: string, range: FeedRange, page: number) {
  return useQuery({
    queryKey: ['oracle', feed, range, page], queryFn: ({ signal }) => oraclesApi.feed(feed, range, page, signal),
    staleTime: STALE, placeholderData: keepPreviousData,
  })
}
