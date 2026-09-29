import { afterEach, describe, expect, it, vi } from 'vitest'
import { foldedShareEntries, loadExplorerAssets, namedShareWrapperOf, priceAssetId, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// The api's half of the one share/wrapper rule. The price writer applies the same
// rule to the same inputs (tests/registry/wrapperPairing.test.ts, `LP aliases`, on
// this fixture): a share the writer publishes under its wrapper must be read from
// the wrapper here, and a share it writes under its own id must be read from its own.

const asset = (assetId: number, symbol: string, evmAddress = '') => ({
  asset_id: assetId, symbol, name: symbol, decimals: 18, parachain_id: null,
  origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null, evm_address: evmAddress,
})
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const HUSDC = '0x35774c305aaf441a102d47988d35f0f5428471b3'
const A2_POOL_PRIME = '0xc2b44f574b8c8440c0d5665f0039b49523139851'
const BIL = '0x8184e2f7c477d165772c21f7a2dbbb61a76e7fc4'
const LIVE = [
  asset(69, 'GDOT', GDOT), asset(690, '2-Pool-GDOT'),
  asset(1110, 'HUSDC', HUSDC), asset(110, '2-Pool-HUSDC'),
  asset(43, 'PRIME'), asset(143, '2-Pool-PRIME'), asset(1143, 'a2-Pool-PRIME', A2_POOL_PRIME),
  asset(55, 'BIL', BIL), asset(550, 'uBIL'), asset(10055, '2-Pool-BIL'),
]
const RESERVES = [
  { asset_address: precompile(690), atoken: GDOT, market_key: 'core' },
  { asset_address: precompile(110), atoken: HUSDC, market_key: 'core' },
  { asset_address: precompile(143), atoken: A2_POOL_PRIME, market_key: 'core' },
  { asset_address: precompile(550), atoken: BIL, market_key: 'bil' },
]
const clientWith = (assets: unknown[]) => ({
  query: vi.fn(async ({ query }: { query: string }) => ({
    json: async () => (query.includes('atoken_reserve_map') ? RESERVES : query.includes('price_data.assets') ? assets : []),
  })),
}) as never

describe('the share/wrapper rule, as the price writer applies it', () => {
  afterEach(() => stopExplorerAssetsRefresh())

  it('names exactly the pairs the writer publishes under the wrapper', async () => {
    await loadExplorerAssets(clientWith(LIVE))
    expect(foldedShareEntries().sort((a, b) => a[0] - b[0])).toEqual([[110, 1110], [690, 69]])
    expect(priceAssetId(110)).toBe(1110)
    expect(priceAssetId(690)).toBe(69)
  })

  it('reads every share the writer publishes under its own id from its own id', async () => {
    await loadExplorerAssets(clientWith(LIVE))
    expect(namedShareWrapperOf(143)).toBeUndefined()
    expect(namedShareWrapperOf(10055)).toBeUndefined()
    expect(priceAssetId(143)).toBe(143)
    expect(priceAssetId(10055)).toBe(10055)
    expect(priceAssetId(1143)).toBe(143)
  })

  it('names nothing through a symbol two registry assets carry', async () => {
    await loadExplorerAssets(clientWith([...LIVE, asset(9069, 'GDOT')]))
    expect(namedShareWrapperOf(690)).toBeUndefined()
    expect(namedShareWrapperOf(110)).toBe(1110)
    // Unnamed, GDOT is an ordinary aToken over its share…
    expect(priceAssetId(69)).toBe(690)
    // …and named again, the pair never cycles.
    await loadExplorerAssets(clientWith(LIVE))
    expect(priceAssetId(690)).toBe(69)
    expect(priceAssetId(69)).toBe(69)
  })
})
