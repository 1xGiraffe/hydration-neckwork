import { useQuery } from '@tanstack/react-query'
import { fetchPriceSource, type PairPriceSource } from '../api/priceSource'

/**
 * Never blocks a render: until the answer arrives (and whenever it cannot) the
 * source reads as 'usd-ratio', so the app paints exactly as it would without
 * the switch and only gains the stablecoin-quoted options once 'route' is known.
 */
export function usePriceSource(): PairPriceSource {
  const query = useQuery({
    queryKey: ['price-source'],
    queryFn: ({ signal }) => fetchPriceSource(signal),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  return query.data ?? 'usd-ratio'
}
