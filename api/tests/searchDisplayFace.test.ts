import { afterEach, describe, expect, it, vi } from 'vitest'
import { initExplorerService, search, type SearchResult } from '../src/services/explorerService.ts'
import { initGovernanceService } from '../src/services/governanceService.ts'
import { initReferendumTitleService } from '../src/services/referendumTitleService.ts'
import { loadExplorerAssets, stopExplorerAssetsRefresh } from '../src/services/explorerAssets.ts'

// Search names an asset the way every other explorer surface does — under its
// display face. A Hydrated pool's share is found by its product name and offered
// as "GDOT · 2-Pool-GDOT" right after the wrapper itself, drawn with the wrapper's
// artwork; a share whose wrapper only restates it keeps its own name.

const GDOT = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const A3POOL = '0xc09cf2f85367f3c2ab66e094283de3a499cb9108'

const asset = (assetId: number, symbol: string, opts: { name?: string; evmAddress?: string } = {}) => ({
  asset_id: assetId,
  symbol,
  name: opts.name ?? null,
  decimals: 18,
  parachain_id: null,
  origin_ecosystem: null,
  origin_chain_id: null,
  origin_asset_id: null,
  evm_address: opts.evmAddress ?? '',
})
const precompile = (assetId: number) => '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')
const reserve = (shareId: number, atoken: string) => ({ asset_address: precompile(shareId), atoken, market_key: 'core' })

const REGISTRY = [
  asset(5, 'DOT', { name: 'Polkadot' }),
  asset(690, '2-Pool-GDOT'), asset(69, 'GDOT', { name: 'GIGADOT', evmAddress: GDOT }),
  asset(103, '3-Pool'), asset(1008, 'a3-Pool', { evmAddress: A3POOL }),
]
const RESERVES = [reserve(690, GDOT), reserve(103, A3POOL)]
const POOLS = [{ pool_id: 690, members: [15, 5] }, { pool_id: 103, members: [10, 22, 222] }]

function emptyRowClient() {
  return { query: vi.fn(async () => ({ json: async () => [] })) } as never
}

async function setup(): Promise<void> {
  initExplorerService(emptyRowClient())
  initGovernanceService(emptyRowClient())
  initReferendumTitleService(emptyRowClient())
  await loadExplorerAssets({
    query: vi.fn(async ({ query }: { query: string }) => ({
      json: async () => (query.includes('atoken_reserve_map') ? RESERVES
        : query.includes('stableswap_pool_state_history') ? POOLS
          : query.includes('price_data.assets') ? REGISTRY : []),
    })),
  } as never)
}

const assets = (r: SearchResult[]) => r.filter(x => x.type === 'asset').map(x => ({ value: x.value, label: x.label, desc: x.desc, icon: x.asset?.iconAssetId }))

describe('search: assets under their display face', () => {
  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('finds a Hydrated pool share by its product name, after the wrapper, with the on-chain name as its description', async () => {
    await setup()
    expect(assets(await search('GDOT'))).toEqual([
      { value: '69', label: 'GDOT', desc: 'GIGADOT', icon: 69 },
      { value: '690', label: 'GDOT', desc: '2-Pool-GDOT', icon: 69 },
    ])
  })

  it('still finds the share by its on-chain name', async () => {
    await setup()
    expect(assets(await search('2-Pool-GDOT'))).toEqual([{ value: '690', label: 'GDOT', desc: '2-Pool-GDOT', icon: 69 }])
  })

  it('keeps a share under its own name when its wrapper only restates it', async () => {
    await setup()
    expect(assets(await search('3-Pool')).map(a => `${a.value}:${a.label}`)).toEqual(['103:3-Pool', '1008:a3-Pool'])
  })
})
