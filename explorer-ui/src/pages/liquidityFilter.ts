import type { PoolKind, PoolListEntry } from '../types'

// The pool-type filter. The Omnipool is one row, so it needs no filter of its own:
// it stays in "All" and drops out once a type is picked.
export type PoolTypeFilter = 'all' | Exclude<PoolKind, 'omnipool'>
export const POOL_TYPE_FILTERS: { v: PoolTypeFilter; label: string }[] = [
  { v: 'all', label: 'All' }, { v: 'stableswap', label: 'Stableswap' }, { v: 'xyk', label: 'XYK' }, { v: 'uniswapv3', label: 'Uniswap v3' },
]
export function parsePoolType(value: string | null): PoolTypeFilter {
  return POOL_TYPE_FILTERS.find(f => f.v === value)?.v ?? 'all'
}
export function poolsOfType(pools: PoolListEntry[], type: PoolTypeFilter): PoolListEntry[] {
  return type === 'all' ? pools : pools.filter(p => p.kind === type)
}
