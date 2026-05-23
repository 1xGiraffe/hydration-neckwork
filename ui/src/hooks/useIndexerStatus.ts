import { useQuery } from '@tanstack/react-query'
import { fetchIndexerStatus } from '../api/indexer'

export function useIndexerStatus() {
  return useQuery({
    queryKey: ['indexer-status'],
    queryFn: fetchIndexerStatus,
    refetchInterval: 6_000,
    staleTime: 4_000,
  })
}
