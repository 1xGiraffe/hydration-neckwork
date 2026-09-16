import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  XC_DESTINATIONS,
  activityRowMatchesFilters,
  activityTokenFilterMatchesNothing,
} from '../src/services/explorerService.ts'
import type { ActivityRow } from '../src/services/explorerService.ts'
import { assetDescriptor, loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// A cross-chain swap's far side is not a registry asset — Hydration never holds
// ZEC or wNEAR — so a token filter naming one resolves to no asset id and every
// id-based predicate rejects the row. The identity those rows DO carry is the
// destination's 1Click id on `xcswapDestAsset`, and that is what the filter has to
// match on, or the destination's own symbol filters its own activity to nothing.
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

const ZEC = XC_DESTINATIONS.find(d => d.platform === 'zec')!
const NEAR = XC_DESTINATIONS.find(d => d.platform === 'near')!

function xcswapRow(destinationAsset: string | null, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    type: 'xcswap',
    blockHeight: 14_820_010,
    timestamp: '2026-09-15 10:00:00',
    eventIndex: 7,
    extrinsicIndex: 2,
    who: null,
    to: null,
    asset: null,
    assetIn: assetDescriptor(5),
    assetOut: null,
    amount: null,
    amountIn: '50000000000',
    amountOut: null,
    valueUsd: 210,
    assetRefs: [5],
    xcswapDestAsset: destinationAsset,
    ...over,
  } as ActivityRow
}

function xcmRow(assetId: number): ActivityRow {
  return {
    type: 'xcm',
    blockHeight: 14_820_011,
    timestamp: '2026-09-15 10:00:12',
    eventIndex: 9,
    extrinsicIndex: 3,
    who: null,
    to: null,
    asset: assetDescriptor(assetId),
    assetIn: null,
    assetOut: null,
    amount: '1000000000',
    amountIn: null,
    amountOut: null,
    valueUsd: 4,
    xcmDestChain: 'Kusama',
  } as ActivityRow
}

describe('cross-chain destination token filter', () => {
  beforeEach(async () => {
    await loadExplorerAssets(clientWith([
      registryRow(0, 'HDX'),
      registryRow(5, 'DOT', 10),
    ]))
  })

  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('keeps a cross-chain swap filtered by its destination symbol, however it is spelled', () => {
    for (const token of ['ZEC', 'zec', 'Zcash']) {
      expect(activityRowMatchesFilters(xcswapRow(ZEC.oneClickId), { token })).toBe(true)
    }
    for (const token of ['wNEAR', 'near', 'NEAR', 'Wrapped NEAR']) {
      expect(activityRowMatchesFilters(xcswapRow(NEAR.oneClickId), { token })).toBe(true)
    }
  })

  it('does not let one destination match another destination\'s swaps', () => {
    expect(activityRowMatchesFilters(xcswapRow(NEAR.oneClickId), { token: 'ZEC' })).toBe(false)
    expect(activityRowMatchesFilters(xcswapRow(ZEC.oneClickId), { token: 'wNEAR' })).toBe(false)
  })

  it('excludes an order the settlement sweep has not named yet', () => {
    expect(activityRowMatchesFilters(xcswapRow(null), { token: 'ZEC' })).toBe(false)
  })

  it('keeps the Hydration asset that was sold matching on its own symbol', () => {
    expect(activityRowMatchesFilters(xcswapRow(ZEC.oneClickId), { token: 'DOT' })).toBe(true)
    expect(activityRowMatchesFilters(xcswapRow(ZEC.oneClickId), { token: 'HDX' })).toBe(false)
  })

  // A destination token names an ASSET that a swap delivered, not the consensus a
  // message travelled to. An XCM send to Kusama moves the asset it carries; the
  // chain it lands on is not that asset, and admitting those rows would make the
  // feed disagree with the destination page, which counts orders alone.
  it('does not admit an ordinary XCM send merely because it left for another chain', () => {
    expect(activityRowMatchesFilters(xcmRow(5), { token: 'ZEC' })).toBe(false)
    expect(activityRowMatchesFilters(xcmRow(0), { token: 'wNEAR' })).toBe(false)
  })

  // A token-unit floor on a destination-matched row has to be measured on what the
  // swap DELIVERED: the Hydration legs are the asset that was sold, so measuring
  // them would apply a ZEC threshold to a DOT amount.
  it('measures a token-unit minimum on the delivered amount', () => {
    const delivered = xcswapRow(ZEC.oneClickId, { xcswapDestAmount: '250000000', xcswapDestDecimals: 8 }) // 2.5 ZEC
    expect(activityRowMatchesFilters(delivered, { token: 'ZEC', min: 2, unit: 'token' })).toBe(true)
    expect(activityRowMatchesFilters(delivered, { token: 'ZEC', min: 3, unit: 'token' })).toBe(false)
    // Unsettled: the delivered amount is unknown, and a filtered view excludes the
    // unknown rather than asserting it clears the floor.
    expect(activityRowMatchesFilters(xcswapRow(ZEC.oneClickId), { token: 'ZEC', min: 1, unit: 'token' })).toBe(false)
  })
})

describe('provably empty token filter', () => {
  beforeEach(async () => {
    await loadExplorerAssets(clientWith([
      registryRow(0, 'HDX'),
      registryRow(5, 'DOT', 10),
    ]))
  })

  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('reports a token that is neither a registry asset nor a destination', () => {
    expect(activityTokenFilterMatchesNothing({ token: 'NOSUCHTOKEN' })).toBe(true)
    expect(activityTokenFilterMatchesNothing({ token: 'DTO' })).toBe(true)
  })

  it('never reports an absent token filter, which means unfiltered', () => {
    expect(activityTokenFilterMatchesNothing({})).toBe(false)
    expect(activityTokenFilterMatchesNothing({ token: undefined })).toBe(false)
    // Blank resolves to "no filter" in every source, so it is not unsatisfiable either.
    expect(activityTokenFilterMatchesNothing({ token: '   ' })).toBe(false)
    expect(activityTokenFilterMatchesNothing({ min: 10, unit: 'usd' })).toBe(false)
  })

  it('never reports a token some row could carry', () => {
    expect(activityTokenFilterMatchesNothing({ token: 'HDX' })).toBe(false)
    expect(activityTokenFilterMatchesNothing({ token: 'dot' })).toBe(false)
    expect(activityTokenFilterMatchesNothing({ token: '5' })).toBe(false)
    // The whole point of the correctness fix: a destination is matchable even
    // though it resolves to no asset id at all.
    for (const token of ['ZEC', 'zec', 'Zcash', 'wNEAR', 'near']) {
      expect(activityTokenFilterMatchesNothing({ token })).toBe(false)
    }
  })
})
