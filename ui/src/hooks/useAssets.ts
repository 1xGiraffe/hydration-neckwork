import { useQuery } from '@tanstack/react-query'
import { fetchAssets } from '../api/assets'

export function useAssets() {
  return useQuery({
    queryKey: ['assets'],
    queryFn: fetchAssets,
    staleTime: 5 * 60 * 1000,  // 5 minutes
  })
}
