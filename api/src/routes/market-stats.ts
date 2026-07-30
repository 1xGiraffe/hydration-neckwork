import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'
import { getMarketStats } from '../services/marketStatsService.ts'

export async function marketStatsRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  fastify.get('/market-stats', async () => {
    return getMarketStats(opts.client)
  })
}
