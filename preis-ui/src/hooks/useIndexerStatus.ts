import { useQuery } from '@tanstack/react-query'
import { fetchIndexerStatus } from '../api/indexer'
import { useHeadStream } from '../live'

// One nominal block: ~6s today, 2s planned. The chip's own timers are the only
// block-time knowledge in preis, and neither is a value anyone reads — one is a
// fallback poll interval, the other its freshness window — so they ride on this
// constant rather than on a measured pace that only arrives inside the payload
// they fetch. Moving it at the 2s migration moves both.
const NOMINAL_BLOCK_MS = 6_000
// Freshness is deliberately shorter than the poll, so a status pushed by the
// head stream is never served from a still-fresh cache entry. Derived from the
// same constant rather than written out (4 000 today): a bare literal would
// invert that invariant the moment the block time moved under it.
const STATUS_STALE_MS = Math.round(NOMINAL_BLOCK_MS * 2 / 3)

export function useIndexerStatus() {
  // While the SSE head stream is healthy, main.tsx refetches this on every
  // pushed head — the interval is only the fallback when the stream is down.
  const streaming = useHeadStream()
  return useQuery({
    queryKey: ['indexer-status'],
    queryFn: ({ signal }) => fetchIndexerStatus(signal),
    refetchInterval: streaming ? false : NOMINAL_BLOCK_MS,
    staleTime: STATUS_STALE_MS,
  })
}
