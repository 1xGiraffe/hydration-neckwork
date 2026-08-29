import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { ClickHouseClient } from '../../db/client.ts'
import { zIsoTimestamp } from '../schemas/common.ts'
import { dataStatus } from '../services/head.ts'

const zStatus = z.object({
  indexedHead: z.number().int().describe('The newest finalized block the index holds.'),
  indexedHeadTime: zIsoTimestamp,
  specVersion: z.number().int().describe('Runtime spec version at the indexed head.'),
  lagSeconds: z.number().int().describe('Wall-clock seconds between now and the indexed head\'s block time — the ingestion lag plus at most one block interval.'),
})

export const statusRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/v1/status', {
    schema: {
      tags: ['status'],
      summary: 'Indexer head and ingestion lag',
      description: 'The only unauthenticated data endpoint: what the index currently covers. Every 404 for a chain resource carries these same fields in its error context, so a consumer can tell "does not exist" from "not yet ingested". The contract serves finalized, indexed state only.',
      security: [],
      response: { 200: zStatus },
    },
  }, async () => dataStatus(opts.client))
}
