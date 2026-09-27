import { describe, expect, it } from 'vitest'
import {
  FEE_SALE_MIN_OUT, MAX_OMNIPOOL_SNAPSHOT_ASSETS,
  anyListedAt, invertAssetFeePermill, paramReadBlocks, isListedAt, listingIntervals, omnipoolSnapshotSemantics, parseOmnipoolAssetParam, parseOmnipoolSection, unlistedBetween,
  type ListingEventRow,
} from '../src/services/omnipoolSnapshots.ts'

// The pure half of /explorer/omnipool/snapshots: which assets a request names,
// when an asset was in the pool (so a delisted one ENDS rather than repeating its
// last row), what a payload section says, and how an asset fee is read back
// from a sale without guessing.

const added = (block: number, asset: number, event_index = 1): ListingEventRow => ({ block_height: block, event_index, event_name: 'Omnipool.TokenAdded', asset_id: asset })
const removed = (block: number, asset: number, event_index = 1): ListingEventRow => ({ block_height: block, event_index, event_name: 'Omnipool.TokenRemoved', asset_id: asset })

describe('asset parameter', () => {
  it('takes one or more ids, keeping first mention and order', () => {
    expect(parseOmnipoolAssetParam('222')).toEqual([222])
    expect(parseOmnipoolAssetParam('0, 222,1001,222')).toEqual([0, 222, 1001])
  })

  it('names what is wrong otherwise', () => {
    expect(parseOmnipoolAssetParam(undefined)).toMatch(/asset is required/)
    expect(parseOmnipoolAssetParam('')).toMatch(/asset is required/)
    expect(parseOmnipoolAssetParam('HOLLAR')).toMatch(/"HOLLAR" is not an asset id/)
    expect(parseOmnipoolAssetParam('1,-2')).toMatch(/"-2"/)
    expect(parseOmnipoolAssetParam('99999999999')).toMatch(/not an asset id/)
    const tooMany = Array.from({ length: MAX_OMNIPOOL_SNAPSHOT_ASSETS + 1 }, (_, i) => i).join(',')
    expect(parseOmnipoolAssetParam(tooMany)).toMatch(/at most 8/)
  })
})

describe('listing history', () => {
  // Asset 11's real history: listed, removed, listed again, removed again.
  const rows = [added(2_331_831, 11), removed(4_293_080, 11, 192), added(6_859_809, 11, 35), removed(8_120_888, 11, 71), added(10_436_402, 222, 38)]

  it('turns add/remove events into intervals, relisting included', () => {
    const iv = listingIntervals([...rows].reverse())
    expect(iv.get(11)).toEqual([
      { listedAt: 2_331_831, removedAt: 4_293_080 },
      { listedAt: 6_859_809, removedAt: 8_120_888 },
    ])
    expect(iv.get(222)).toEqual([{ listedAt: 10_436_402, removedAt: null }])
    // A replayed add of the open interval changes nothing.
    expect(listingIntervals([...rows, added(10_436_402, 222, 38)]).get(222)).toEqual([{ listedAt: 10_436_402, removedAt: null }])
    // A removal with no add before it opens at null rather than inventing a block.
    expect(listingIntervals([removed(500, 7)]).get(7)).toEqual([{ listedAt: null, removedAt: 500 }])
  })

  it('reads the state AFTER a block: in from the add block, out from the removal block', () => {
    const iv = listingIntervals(rows).get(11)
    expect(isListedAt(iv, 2_331_830)).toBe(false)
    expect(isListedAt(iv, 2_331_831)).toBe(true)
    expect(isListedAt(iv, 4_293_079)).toBe(true)
    expect(isListedAt(iv, 4_293_080)).toBe(false)
    expect(isListedAt(iv, 5_000_000)).toBe(false)
    expect(isListedAt(iv, 7_000_000)).toBe(true)
    expect(isListedAt(iv, 9_000_000)).toBe(false)
    expect(isListedAt(undefined, 1)).toBe(false)
  })

  it('knows when none of several assets was in the pool between two observations', () => {
    const byId = listingIntervals(rows)
    const eleven = [byId.get(11)]
    expect(unlistedBetween(eleven, 4_200_000, 4_290_000)).toBe(false)
    expect(unlistedBetween(eleven, 4_200_000, 6_900_000)).toBe(true)
    // Exactly adjacent: removed at 4,293,080 and observed there — nothing unlisted strictly between.
    expect(unlistedBetween(eleven, 4_292_400, 4_293_080)).toBe(false)
    // With HOLLAR also requested, a stretch 11 was out of the pool is still covered from HOLLAR's listing on.
    const both = [byId.get(11), byId.get(222)]
    expect(unlistedBetween(both, 10_500_000, 11_000_000)).toBe(false)
    expect(unlistedBetween(both, 8_000_000, 10_500_000)).toBe(true)
    expect(anyListedAt(both, 9_000_000)).toBe(false)
    expect(anyListedAt(both, 10_436_402)).toBe(true)
  })
})

describe('cap and tradability reads on the grid', () => {
  const pts = [600, 1_200, 1_800, 2_400, 3_000].map(block => ({ block, specVersion: block >= 2_400 ? 444 : 443 }))

  it('reads the first point, the first point at or after each change, and each runtime upgrade', () => {
    expect(paramReadBlocks(pts.filter(p => p.block < 2_400), [])).toEqual([600])
    // A change AT a grid height is in that height's snapshot; one just after is in the next.
    expect(paramReadBlocks(pts, [1_200, 1_201])).toEqual([600, 1_200, 1_800, 2_400])
    // A change before the first point is already in the first read; one past the last is nobody's.
    expect(paramReadBlocks(pts, [10, 9_000])).toEqual([600, 2_400])
    expect(paramReadBlocks([], [1])).toEqual([])
  })
})

describe('payload section', () => {
  it('reads every listed asset and the hub total across all of them, never a missing field as zero', () => {
    const section = {
      account: '0x6d6f…',
      assets: [
        { asset_id: 0, hub_reserve: '204979638128429032', reserve: '168286875092137903269', shares: '144768366721331759428', protocol_shares: '3757482219481776330', cap: '10000000000000000', tradable: 15 },
        { asset_id: 222, hub_reserve: '395897259992985430', reserve: '2403652265540635313151030', shares: '1', protocol_shares: '0', cap: '200000000000000000', tradable: 7 },
        { asset_id: 9, reserve: '5' }, // no hub reserve: left out, not zero
      ],
    }
    const parsed = parseOmnipoolSection(section)
    expect(parsed.assetCount).toBe(2)
    expect(parsed.hubReserveTotal).toBe(204979638128429032n + 395897259992985430n)
    expect(parsed.assets.get(222)).toEqual({ reserve: '2403652265540635313151030', hubReserve: '395897259992985430', shares: '1', protocolShares: '0', cap: '200000000000000000', tradable: 7 })
    expect(parsed.assets.has(9)).toBe(false)
    expect(parseOmnipoolSection(null)).toEqual({ assets: new Map(), hubReserveTotal: 0n, assetCount: 0 })
  })
})

describe('asset fee read back from a sale', () => {
  it('recovers the Permill exactly from real sales', () => {
    // Block 15,090,005 e19: H2O → HDX, 0.25% (the storage figure at that block).
    expect(invertAssetFeePermill(851_689_632_688_864n, 2_134_560_482_930n)).toBe(2500)
    // Block 4,203,941 e11: a sale of iBTC out at 0.2654%.
    expect(invertAssetFeePermill(1_995_628n, 5_311n)).toBe(2654)
    expect(invertAssetFeePermill(2_004_667n, 5_025n)).toBe(2500)
  })

  it('reproduces the pallet split for every rate at the size threshold, uniquely', () => {
    const gross = BigInt(FEE_SALE_MIN_OUT)
    for (const p of [0, 1, 1500, 2500, 2564, 50_000, 999_999]) {
      const out = ((1_000_000n - BigInt(p)) * gross) / 1_000_000n
      expect(invertAssetFeePermill(out, gross - out), `p=${p}`).toBe(p)
    }
  })

  it('refuses rather than guesses: a sale too small to fix one rate, or a split no rate produces', () => {
    // Block 4,204,186 e11: 161,531 gross fits several Permill values.
    expect(invertAssetFeePermill(161_127n, 404n)).toBeNull()
    expect(invertAssetFeePermill(0n, 0n)).toBeNull()
    // At a gross of 1e12 each Permill step moves the fee by exactly 1e6 units, so
    // 0.25% is 2,500,000,000 and one unit more is no rate's split at all.
    expect(invertAssetFeePermill(997_500_000_000n, 2_500_000_000n)).toBe(2500)
    expect(invertAssetFeePermill(997_499_999_999n, 2_500_000_001n)).toBeNull()
  })
})

describe('semantics', () => {
  it('states the carried read, the event-derived fee and the missing protocol fee', () => {
    const s = omnipoolSnapshotSemantics('grid', 1_200)
    expect(s.points).toContain('carries its last read')
    expect(s.points).toContain('every 2th grid block')
    expect(s.fees).toContain('rate last CHARGED')
    expect(s.fees).toContain('protocol fee is not served')
    expect(s.listing).toContain('never repeated')
    expect(s.missing).toContain('assetGaps')
    expect(s.reserves).not.toContain('aToken')
  })

  it('names an aToken asset and what its reserve leaves out', () => {
    const aDot = { assetId: 1001, iconAssetId: 5, symbol: 'aDOT', name: null, decimals: 10, parachainId: null, origin: null }
    const s = omnipoolSnapshotSemantics('day', null, [aDot as never])
    expect(s.reserves).toContain('aDOT (#1001) is a money-market aToken')
    expect(s.reserves).toContain('NOT included')
    expect(s.points).toContain('Omnipool page charts per day')
  })
})
