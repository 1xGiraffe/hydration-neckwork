import { afterEach, describe, expect, it, vi } from 'vitest'

// The Omnipool hub asset is called H2O everywhere (AGENTS.md); the on-chain
// registry still spells it LRNA / Lerna. The explorer's registry loader has
// always renamed it — the preis/market-stats loader here must too, or the two
// UIs name the same asset differently.

interface AssetRow {
  asset_id: number
  symbol: string
  name: string
  decimals: number
  parachain_id: number | null
  origin_ecosystem: string | null
  origin_chain_id: string | null
  origin_asset_id: string | null
}

const row = (asset_id: number, symbol: string, name = symbol, decimals = 12): AssetRow => ({
  asset_id, symbol, name, decimals,
  parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null,
})

async function loadFixture() {
  vi.resetModules()
  const assets = await import('../src/services/assetsService.ts')
  const rows = [row(0, 'HDX', 'Hydration'), row(1, 'LRNA', 'Lerna'), row(5, 'DOT', 'Polkadot', 10)]
  const client = { query: vi.fn(async () => ({ json: async () => rows })) }
  await assets.loadAssets(client as never)
  return assets
}

afterEach(() => { vi.restoreAllMocks() })

describe('hub asset naming in the preis asset registry', () => {
  it('renames the on-chain LRNA to H2O, symbol and name alike', async () => {
    const { getAssetById } = await loadFixture()
    const hub = getAssetById(1)
    expect(hub?.symbol).toBe('H2O')
    // The name repeats the symbol, so — as for every such asset — it is null.
    expect(hub?.name).toBeNull()
    expect(hub?.decimals).toBe(12)
  })

  it('leaves every other asset as the registry spells it', async () => {
    const { getAssetById } = await loadFixture()
    expect(getAssetById(0)?.symbol).toBe('HDX')
    expect(getAssetById(0)?.name).toBe('Hydration')
    expect(getAssetById(5)?.symbol).toBe('DOT')
  })
})
