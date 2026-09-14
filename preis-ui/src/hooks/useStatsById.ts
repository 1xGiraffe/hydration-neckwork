import { useMemo } from 'react'
import type { AssetMarketStats } from '../types'

/** The market-stats feed indexed by asset id — every surface resolves legs this way. */
export function useStatsById(marketStats: AssetMarketStats[] | undefined): Map<number, AssetMarketStats> {
  return useMemo(() => {
    const byId = new Map<number, AssetMarketStats>()
    if (marketStats) for (const stats of marketStats) byId.set(stats.assetId, stats)
    return byId
  }, [marketStats])
}
