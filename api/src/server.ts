import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.ts'
import { createClickHouseClient } from './db/client.ts'
import { loadAssets } from './services/assetsService.ts'
import { candlesRoutes } from './routes/candles.ts'
import { assetsRoutes } from './routes/assets.ts'
import { marketStatsRoutes } from './routes/market-stats.ts'

const fastify = Fastify({ logger: true })

const client = createClickHouseClient()

await fastify.register(cors, { origin: true })

fastify.get('/health', async () => {
  return { status: 'ok' }
})

await fastify.register(assetsRoutes)
await fastify.register(candlesRoutes, { client })
await fastify.register(marketStatsRoutes, { client })

async function start() {
  try {
    await loadAssets(client)
    await fastify.listen({ port: config.port, host: config.host })
    console.log(`[API] Server listening on ${config.host}:${config.port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
