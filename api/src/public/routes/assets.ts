import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { allExplorerAssets } from '../../services/explorerAssets.ts'
import { zAssetId } from '../schemas/common.ts'

const zAsset = z.object({
  id: zAssetId,
  symbol: z.string(),
  // Null when the registry's name adds nothing to the symbol.
  name: z.string().nullable(),
  decimals: z.number().int(),
  // Reserved: the on-chain registry does not publish an asset type, so this is
  // null for every asset until registry enrichment lands. Declared now so adding
  // it later is additive for consumers.
  assetType: z.string().nullable(),
  origin: z.object({
    ecosystem: z.string(),
    chainId: z.string(),
    assetId: z.string().nullable(),
  }).nullable(),
})

export const assetsRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async fastify => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/assets', {
    schema: {
      tags: ['assets'],
      summary: 'Asset registry',
      description: 'The full asset registry (including foreign, aToken, pool-share and bond assets). Consumers resolve decimals from here; ids are decimal strings everywhere on this surface. Served from the in-process registry snapshot, refreshed every 5 minutes.',
      response: { 200: z.object({ items: z.array(zAsset) }) },
    },
  }, async () => {
    const items = allExplorerAssets()
      // Registry order is a hash-map walk; sort so the payload is stable and diffable.
      .sort((a, b) => a.assetId - b.assetId)
      .map(asset => ({
        id: String(asset.assetId),
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        assetType: null,
        origin: asset.origin,
      }))
    return { items }
  })
}
