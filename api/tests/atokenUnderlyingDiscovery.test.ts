import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ATOKEN_UNDERLYING_ID,
  loadExplorerAssets,
  priceAssetId,
  stopExplorerAssetsRefresh,
} from '../src/services/explorerAssets.ts'

// Every aToken's underlying was listed by hand. So a money-market reserve opened on
// a new asset arrived in the explorer with no price and no icon, and stayed that way
// until someone edited the table: measured on 2026-09-16, the Treasury wrapped four
// pool shares into a3-Pool-MRL (1105), a2-Pool-PRIME (1143), a2-Pool-apyUSD (1146)
// and a2-Pool-BIL (11055), all registered in the same block and none of them known
// here.
//
// The pairing is not a judgement call — the Aave reserve map states it, and we index
// it. An underlying is named there by its ERC-20 precompile, whose low bytes ARE the
// asset id (0x…0100000069 is asset 105).

const asset = (assetId: number, symbol: string, evmAddress = '') => ({
  asset_id: assetId,
  symbol,
  name: symbol,
  decimals: 18,
  parachain_id: null,
  origin_ecosystem: null,
  origin_chain_id: null,
  origin_asset_id: null,
  evm_address: evmAddress,
})

const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')

/** Answers the asset registry read and the reserve-map read from one fake. */
const clientWith = (assets: ReturnType<typeof asset>[], reserves: { asset_address: string; atoken: string }[]) => ({
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('atoken_reserve_map') ? reserves : query.includes('price_data.assets') ? assets : []),
  })),
}) as never

describe('aToken underlyings discovered from the reserve map', () => {
  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('pairs a brand-new aToken with its reserve, so it prices without a code change', async () => {
    await loadExplorerAssets(clientWith(
      [asset(105, '3-Pool-MRL'), asset(1105, 'a3-Pool-MRL', '0xabfb92906f9c8d90bf6e2686c9e39906669c1843')],
      [{ asset_address: precompile(105), atoken: '0xabfb92906f9c8d90bf6e2686c9e39906669c1843' }],
    ))
    expect(ATOKEN_UNDERLYING_ID[1105]).toBe(105)
    expect(priceAssetId(1105)).toBe(105)
  })

  // The hand-written entries encode deliberate inversions the reserve map cannot
  // express — BIL is the traded leg and its "underlying" uBIL never trades, so the
  // map's own direction would price BIL off an asset with no feed.
  it('never overwrites a deliberate exception with the map’s own direction', async () => {
    const before = ATOKEN_UNDERLYING_ID[55]
    await loadExplorerAssets(clientWith(
      [asset(55, 'BIL', '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'), asset(550, 'uBIL')],
      [{ asset_address: precompile(550), atoken: '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4' }],
    ))
    expect(ATOKEN_UNDERLYING_ID[55]).toBe(before)
  })

  // The map states GDOT's reserve is 2-Pool-GDOT, while the share table already
  // prices 2-Pool-GDOT off GDOT. Taking the map's direction too would alias the pair
  // BOTH ways, and priceAssetId would walk the cycle to its hop bound and land on
  // whichever end the parity picked — GDOT priced off an unpriced pool share.
  it('refuses a pairing that would invert an alias already going the other way', async () => {
    await loadExplorerAssets(clientWith(
      [asset(69, 'GDOT', '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'), asset(690, '2-Pool-GDOT')],
      [{ asset_address: precompile(690), atoken: '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad' }],
    ))
    expect(ATOKEN_UNDERLYING_ID[69]).toBeUndefined()
    expect(priceAssetId(690)).toBe(69)
  })

  it('ignores a reserve whose aToken or underlying this chain does not know', async () => {
    await loadExplorerAssets(clientWith(
      [asset(105, '3-Pool-MRL')],
      [
        { asset_address: precompile(105), atoken: '0xdeadbeef00000000000000000000000000000000' },
        { asset_address: '0xnot-a-precompile', atoken: '0xabfb92906f9c8d90bf6e2686c9e39906669c1843' },
      ],
    ))
    expect(ATOKEN_UNDERLYING_ID[105]).toBeUndefined()
  })
})
