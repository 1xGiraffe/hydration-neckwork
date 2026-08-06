import { useQuery } from '@tanstack/react-query'
import { fetchIndexerStatus } from '../api/indexer'
import { useHeadStream } from '../live'

export function useIndexerStatus() {
  // While the SSE head stream is healthy, main.tsx refetches this on every
  // pushed head — the interval is only the fallback when the stream is down.
  const streaming = useHeadStream()
  return useQuery({
    queryKey: ['indexer-status'],
    queryFn: ({ signal }) => fetchIndexerStatus(signal),
    refetchInterval: streaming ? false : 6_000,
    staleTime: 4_000,
  })
}
