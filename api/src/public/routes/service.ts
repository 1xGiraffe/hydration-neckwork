import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import pkg from '../../../package.json' with { type: 'json' }
import type { ClickHouseClient } from '../../db/client.ts'
import { iso, zIsoTimestamp } from '../schemas/common.ts'
import { publicStatus } from '../services/status.ts'

// Static identity of this indexer, published by /rest/service/metadata. The
// Hydration UI's provider failover reads this document, so its SHAPE is
// data-lake-compatible even though the values are ours.
const INDEXER_ID = 'giraffe-neckwork-mainnet'
const NETWORK = 'hydration'

const zHealth = z.object({
  status: z.literal('healthy'),
  timestamp: zIsoTimestamp,
})

const zMetadata = z.object({
  metadataVersion: z.literal(1),
  indexer: z.object({
    id: z.string(),
    version: z.string(),
    network: z.string(),
    master: z.boolean(),
  }),
  coverage: z.object({
    // The data lake's convention, kept verbatim so a UI reading this document
    // needs no special case: 0 = indexed from genesis, -1 = no upper bound (the
    // indexer is live and follows the head). GET /v1/status carries the real head.
    blockBounds: z.object({
      minBlockHeight: z.number().int(),
      maxBlockHeight: z.number().int(),
    }),
  }),
})

const zStatus = z.object({
  blockHeight: z.number().int(),
  blockTimestamp: zIsoTimestamp,
  lagSeconds: z.number().int(),
  // The raw pipeline's own checkpoint, not a chain-head RPC sample: this service
  // never touches a node. See src/public/services/status.ts.
  chainBlockHeight: z.number().int(),
  blocksBehindHead: z.number().int(),
})

export const serviceRoutes: FastifyPluginAsync<{ client: ClickHouseClient }> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get('/rest/service/health', {
    schema: {
      tags: ['service'],
      summary: 'Liveness probe',
      description: 'Static liveness answer. It reports that this process is serving, not that the indexer is caught up — use /v1/status for lag.',
      response: { 200: zHealth },
    },
  }, async () => ({ status: 'healthy' as const, timestamp: iso(new Date()) }))

  app.get('/rest/service/metadata', {
    schema: {
      tags: ['service'],
      summary: 'Indexer identity and coverage',
      description: 'Data-lake-compatible metadata probe. `master` comes from PUBLIC_API_MASTER (default true); a replica serving stale data should set it to "false" so a consumer\'s provider failover can prefer another host.',
      response: { 200: zMetadata },
    },
  }, async () => ({
    metadataVersion: 1 as const,
    indexer: {
      id: INDEXER_ID,
      version: pkg.version,
      network: NETWORK,
      master: process.env.PUBLIC_API_MASTER !== 'false',
    },
    coverage: { blockBounds: { minBlockHeight: 0, maxBlockHeight: -1 } },
  }))

  app.get('/v1/status', {
    schema: {
      tags: ['service'],
      summary: 'Indexed head and lag',
      description: '`chainBlockHeight` is the raw ingestion checkpoint, so `blocksBehindHead` measures distance from raw ingestion rather than from the chain head — this service performs no RPC.',
      response: { 200: zStatus },
    },
  }, async () => publicStatus(opts.client))
}
