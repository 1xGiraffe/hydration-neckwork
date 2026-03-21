import { useQuery } from '@tanstack/react-query'
import { fetchMarketStats } from '../api/marketStats'

export function useMarketStats(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: ['market-stats'],
    queryFn: fetchMarketStats,
    staleTime: 60_000,
    refetchInterval: options?.refetchInterval ?? false,
  })
}
