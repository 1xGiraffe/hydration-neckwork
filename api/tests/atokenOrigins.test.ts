import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assetDescriptor,
  loadExplorerAssets,
  stopExplorerAssetsRefresh,
} from '../src/services/explorerAssets.ts'

const row = (
  assetId: number,
  symbol: string,
  origin: {
    parachainId?: number | null
    ecosystem?: string | null
    chainId?: string | null
    assetId?: string | null
  } = {},
) => ({
  asset_id: assetId,
  symbol,
  name: symbol,
  decimals: 12,
  parachain_id: origin.parachainId ?? null,
  origin_ecosystem: origin.ecosystem ?? null,
  origin_chain_id: origin.chainId ?? null,
  origin_asset_id: origin.assetId ?? null,
})

const clientWith = (rows: ReturnType<typeof row>[]) => ({
  query: vi.fn(async () => ({ json: async () => rows })),
}) as never

describe('aToken origin metadata', () => {
  afterEach(() => {
    stopExplorerAssetsRefresh()
    vi.restoreAllMocks()
  })

  it('inherits the reserve asset origin used by its icon', async () => {
    await loadExplorerAssets(clientWith([
      row(22, 'USDC', {
        parachainId: 1000,
        ecosystem: 'polkadot',
        chainId: '1000',
        assetId: '1337',
      }),
      row(1003, 'aUSDC'),
    ]))

    expect(assetDescriptor(1003)).toMatchObject({
      iconAssetId: 22,
      parachainId: 1000,
      origin: { ecosystem: 'polkadot', chainId: '1000', assetId: '1337' },
    })
  })

  it('preserves explicit aToken origin metadata', async () => {
    await loadExplorerAssets(clientWith([
      row(22, 'USDC', {
        parachainId: 1000,
        ecosystem: 'polkadot',
        chainId: '1000',
      }),
      row(1003, 'aUSDC', {
        parachainId: 2004,
        ecosystem: 'polkadot',
        chainId: '2004',
      }),
    ]))

    expect(assetDescriptor(1003)).toMatchObject({
      parachainId: 2004,
      origin: { ecosystem: 'polkadot', chainId: '2004', assetId: null },
    })
  })

  it('leaves aTokens without applicable reserve origin unbadged', async () => {
    await loadExplorerAssets(clientWith([
      row(5, 'DOT'),
      row(1001, 'aDOT'),
    ]))

    expect(assetDescriptor(1001)).toMatchObject({ parachainId: null, origin: null })
  })
})
