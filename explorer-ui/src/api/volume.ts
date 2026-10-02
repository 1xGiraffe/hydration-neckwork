import { useQuery } from '@tanstack/react-query'
import { getJson, withQuery } from './explorer'
import type { AccountRef, AssetRef, ChartWindowPayload } from '../types'

// Trading volume (api routes/volume.ts, services/volumeHistory.ts). Three
// definitions, one per figure: ROUTED volume (every trade once, netted across its
// route — the platform total), VENUE/POOL volume (every fill once in the pool it
// executed in; a two-pool route counts in both pools, so venue volumes sum to more
// than routed volume) and ASSET volume (the asset's own legs, sold plus bought).
// Every window ends at `asOf`, the hourly read models' published cut.

export interface WindowStat { volumeUsd: number; prevUsd: number; changePct: number | null }
/** The trailing windows every volume surface states: 24H, 7D, 30D and 12M (365 days). */
export type WindowKey = 'd1' | 'd7' | 'd30' | 'd365'
export interface VolumeKpis { d1: WindowStat; d7: WindowStat; d30: WindowStat; d365: WindowStat }
export type VolumeRange = '30d' | '1y' | 'all'

export interface AssetVolume {
  assetId: number
  assetIds: number[]
  /** The assets those ids are (the page's asset, its aToken, the shares shown under it). */
  assets: AssetRef[]
  asOf: string | null
  kpis: VolumeKpis
  byVenue: { venue: string; d1: number; d7: number; d30: number; d365: number }[]
  allTimeUsd: number
  volumeTvl: {
    d7: number | null; d30: number | null; d365: number | null
    meanTvl7dUsd: number | null; meanTvl30dUsd: number | null; meanTvl365dUsd: number | null
  }
  chart: ChartWindowPayload
}

export interface PoolVolume {
  venue: 'omnipool' | 'stableswap' | 'xyk' | 'uniswapv3'
  poolKey: string
  asOf: string | null
  kpis: VolumeKpis
  fees: Record<WindowKey, { lpUsd: number; protocolUsd: number }>
  fills: Record<WindowKey, number>
  allTime: { volumeUsd: number; lpFeeUsd: number; protocolFeeUsd: number; fills: number }
  tvlUsd: number | null
  meanTvl7dUsd: number | null
  meanTvl30dUsd: number | null
  meanTvl365dUsd: number | null
  /** Window volume over the window's mean TVL (24H: over the current TVL); a ratio, never annualised. */
  volumeTvl: Record<WindowKey, number | null>
  /** The TVL that long before the cut: the daily close nearest the instant, and when that close is. */
  tvlAgo: Record<WindowKey, { usd: number | null; at: string | null }>
  feeApr7dPct: number | null
  /** series: volume, lpFees, protocolFees, fills, tvl, volumeTvl (ratio per bucket) (+ a:<id> and other on the Omnipool). */
  chart: ChartWindowPayload
  stackAssets?: AssetRef[]
}

export interface PlatformVolume {
  asOf: string | null
  range: VolumeRange
  routed: VolumeKpis
  routedTrades: Record<WindowKey, number>
  venues: { venue: string; kpis: VolumeKpis }[]
  venueTotal: VolumeKpis
  /** series: one per venue, plus routed and trades. */
  chart: ChartWindowPayload
  /** `assets`: the pool's assets for its icons, largest first (the pools index's composition); empty when unknown. */
  topPools: { venue: string; name: string; poolId: number | null; address: string | null; volume7dUsd: number; tvlUsd: number | null; volumeTvl7d: number | null; assets?: AssetRef[] }[]
  topAssets: { asset: AssetRef; volume7dUsd: number; sharePct: number }[]
  topTraders: { account: AccountRef; volume7dUsd: number; trades: number }[]
  tradersWindow: { fromBlock: number; toBlock: number; asOfBlock: number | null } | null
}

const win = (fromTs: number, toTs: number, points: number) => ({ fromTs, toTs, points })

export const volumeApi = {
  platform: (range: VolumeRange, signal?: AbortSignal) => getJson<PlatformVolume>(withQuery('/explorer/volume', { range }), signal),
  platformWindow: (fromTs: number, toTs: number, points: number, signal?: AbortSignal) =>
    getJson<ChartWindowPayload>(withQuery('/explorer/volume', win(fromTs, toTs, points)), signal),
  asset: (assetId: number, signal?: AbortSignal) => getJson<AssetVolume>(`/explorer/asset/${assetId}/volume`, signal),
  assetWindow: (assetId: number, fromTs: number, toTs: number, points: number, signal?: AbortSignal) =>
    getJson<ChartWindowPayload>(withQuery(`/explorer/asset/${assetId}/volume`, win(fromTs, toTs, points)), signal),
  omnipool: (signal?: AbortSignal) => getJson<PoolVolume>('/explorer/omnipool/volume', signal),
  omnipoolWindow: (fromTs: number, toTs: number, points: number, signal?: AbortSignal) =>
    getJson<ChartWindowPayload>(withQuery('/explorer/omnipool/volume', win(fromTs, toTs, points)), signal),
  pool: (poolId: number, signal?: AbortSignal) => getJson<PoolVolume>(`/explorer/pool/${poolId}/volume`, signal),
  poolWindow: (poolId: number, fromTs: number, toTs: number, points: number, signal?: AbortSignal) =>
    getJson<ChartWindowPayload>(withQuery(`/explorer/pool/${poolId}/volume`, win(fromTs, toTs, points)), signal),
  v3Pool: (address: string, signal?: AbortSignal) => getJson<PoolVolume>(`/explorer/pool/v3/${address}/volume`, signal),
}

// The models publish about once an hour, so a few minutes of client reuse costs nothing.
const STALE = 120_000

export function usePlatformVolume(range: VolumeRange) {
  return useQuery({ queryKey: ['volume-platform', range], queryFn: ({ signal }) => volumeApi.platform(range, signal), staleTime: STALE })
}
export function useAssetVolume(assetId: number) {
  return useQuery({ queryKey: ['volume-asset', assetId], queryFn: ({ signal }) => volumeApi.asset(assetId, signal), staleTime: STALE })
}
export function useOmnipoolVolume() {
  return useQuery({ queryKey: ['volume-omnipool'], queryFn: ({ signal }) => volumeApi.omnipool(signal), staleTime: STALE })
}
export function usePoolVolume(poolId: number | null) {
  return useQuery({
    queryKey: ['volume-pool', poolId], queryFn: ({ signal }) => volumeApi.pool(poolId as number, signal),
    staleTime: STALE, enabled: poolId != null,
  })
}
export function useV3PoolVolume(address: string) {
  return useQuery({ queryKey: ['volume-v3', address], queryFn: ({ signal }) => volumeApi.v3Pool(address, signal), staleTime: STALE })
}
