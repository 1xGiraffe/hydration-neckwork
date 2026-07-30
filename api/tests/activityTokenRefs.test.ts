import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activityRowMatchesFilters } from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { assetDescriptor, loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// Liquidity rows display one representative asset (the Stableswap pool share or
// the XYK assetA) while referencing every asset the event touched. The SQL
// sources match those through `hasAny(asset_refs, …)`, so the merged post-filter
// has to accept the same rows — otherwise a token-filtered feed comes back empty
// while the histogram above it still counts the dropped rows.
const registryRow = (assetId: number, symbol: string, decimals = 12) => ({
  asset_id: assetId,
  symbol,
  name: symbol,
  decimals,
  parachain_id: null,
  origin_ecosystem: null,
  origin_chain_id: null,
  origin_asset_id: null,
})

const clientWith = (rows: ReturnType<typeof registryRow>[]) => ({
  query: vi.fn(async () => ({ json: async () => rows })),
}) as never

function liquidityRow(assetId: number, assetRefs?: number[]): ActivityRow {
  return {
    type: 'liquidity',
    blockHeight: 13_209_758,
    timestamp: '2026-07-19 10:00:00',
    eventIndex: 12,
    extrinsicIndex: 3,
    who: null,
    to: null,
    asset: assetDescriptor(assetId),
    assetIn: null,
    assetOut: null,
    amount: '1000000000000000000',
    amountIn: null,
    amountOut: null,
    valueUsd: 1,
    assetRefs,
    liqAction: 'Add',
  } as ActivityRow
}

describe('token filter over referenced assets', () => {
  beforeEach(async () => {
    await loadExplorerAssets(clientWith([
      registryRow(5, 'DOT', 10),
      registryRow(110, '2-Pool-HUSDC', 18),
      registryRow(222, 'HOLLAR', 18),
      registryRow(1_000_085, 'WUD', 10),
    ]))
  })

  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('keeps a Stableswap deposit filtered by the nested pool asset', () => {
    expect(activityRowMatchesFilters(liquidityRow(110, [110, 222]), { token: 'HOLLAR' })).toBe(true)
  })

  it('keeps an XYK row filtered by the pair asset it does not display', () => {
    expect(activityRowMatchesFilters(liquidityRow(1_000_085, [1_000_085, 5]), { token: 'DOT' })).toBe(true)
  })

  it('still rejects a row that references neither the displayed nor the filtered asset', () => {
    expect(activityRowMatchesFilters(liquidityRow(110, [110, 5]), { token: 'HOLLAR' })).toBe(false)
  })

  it('matches on the displayed asset when a row carries no referenced assets', () => {
    expect(activityRowMatchesFilters(liquidityRow(110), { token: '2-Pool-HUSDC' })).toBe(true)
    expect(activityRowMatchesFilters(liquidityRow(110), { token: 'HOLLAR' })).toBe(false)
  })
})
