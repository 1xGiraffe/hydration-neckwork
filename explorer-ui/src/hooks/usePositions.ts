import { useQueries, useQuery, keepPreviousData } from '@tanstack/react-query'
import { positionsApi, PUBLIC_LIST_TAG } from '../api/explorer'
import { useSession } from '../session'
import type { OrderHistoryKind, PositionScope } from '../types'

// Reads behind the Orders · Liquidity · Borrow tabs, one hook per read and one
// scope shape for all three holders (account, system tag, list tag). The query
// key names the scope, so an account and a tag never share an entry.

const scopeKey = (scope: PositionScope): string[] =>
  scope.kind === 'account' ? ['account', scope.address]
    : scope.kind === 'tag' ? ['tag', scope.tagId]
      : ['list-tag', scope.listId, scope.tagId]

// A list tag is readable without a session only when it is a public one (see
// useUser's listTagReadable); the other scopes are always readable.
function useScopeReadable(scope: PositionScope): boolean {
  const session = useSession()
  return scope.kind !== 'list-tag' || scope.listId === PUBLIC_LIST_TAG || (!!session && !!scope.listId)
}

// Pool APRs and reserve APYs change with fees, farms and rates — a slow
// global read the API caches for minutes, shared by every page.
export function useYields(enabled = true) {
  return useQuery({
    queryKey: ['explorer-yields'],
    queryFn: ({ signal }) => positionsApi.yields(signal),
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  })
}

export function usePositionsPresence(scope: PositionScope, enabled = true) {
  const readable = useScopeReadable(scope)
  return useQuery({
    queryKey: ['positions-presence', ...scopeKey(scope)],
    queryFn: ({ signal }) => positionsApi.presence(scope, signal),
    enabled: enabled && readable,
    staleTime: 60_000,
  })
}

export function useOrderHistory(scope: PositionScope, offset: number, kind: OrderHistoryKind, limit = 25, enabled = true) {
  const readable = useScopeReadable(scope)
  return useQuery({
    queryKey: ['order-history', ...scopeKey(scope), offset, limit, kind],
    queryFn: ({ signal }) => positionsApi.orderHistory(scope, offset, limit, kind, signal),
    enabled: enabled && readable,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export function useLiquidityRewards(scope: PositionScope, enabled = true) {
  const readable = useScopeReadable(scope)
  return useQuery({
    queryKey: ['liquidity-rewards', ...scopeKey(scope)],
    queryFn: ({ signal }) => positionsApi.liquidityRewards(scope, signal),
    enabled: enabled && readable,
    staleTime: 60_000,
  })
}

export function useLiquidityHistory(scope: PositionScope, enabled = true) {
  const readable = useScopeReadable(scope)
  return useQuery({
    queryKey: ['liquidity-history', ...scopeKey(scope)],
    queryFn: ({ signal }) => positionsApi.liquidityHistory(scope, signal),
    enabled: enabled && readable,
    staleTime: 60_000,
  })
}

// Per account: a tag's Borrow tab asks once per member card it opens.
const moneyMarketHistoryQuery = (address: string | null, enabled: boolean) => ({
  queryKey: ['money-market-history', address],
  queryFn: ({ signal }: { signal: AbortSignal }) => positionsApi.moneyMarketHistory(address as string, signal),
  enabled: enabled && !!address,
  staleTime: 60_000,
})
export function useMoneyMarketHistory(address: string | null, enabled = true) {
  return useQuery(moneyMarketHistoryQuery(address, enabled))
}
/** The same read for several accounts at once (one cache entry each), `null` skipping one. */
export function useMoneyMarketHistories(addresses: (string | null)[]) {
  return useQueries({ queries: addresses.map(a => moneyMarketHistoryQuery(a, a != null)) })
}
