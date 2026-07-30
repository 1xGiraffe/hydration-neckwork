import { useQuery } from '@tanstack/react-query'
import { fetchIndexerStatus } from '../api/indexer'

export function useIndexerStatus() {
  return useQuery({
    queryKey: ['indexer-status'],
    queryFn: ({ signal }) => fetchIndexerStatus(signal),
    refetchInterval: 6_000,
    staleTime: 4_000,
  })
}
