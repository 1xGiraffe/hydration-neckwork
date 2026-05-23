import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'

interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
}

interface CacheEntry { data: IndexerStatus; fetchedAt: number }
const TTL_MS = 5_000
let cache: CacheEntry | null = null

export async function indexerRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  fastify.get('/indexer', async () => {
    if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.data
    // Main indexer head + raw indexer head in one round trip
    const [mainRes, rawRes] = await Promise.all([
      opts.client.query({
        query: `
          SELECT
            toUInt64(max(block_height)) AS block_height,
            toString(max(block_timestamp)) AS block_timestamp
          FROM price_data.blocks
        `,
        format: 'JSONEachRow',
      }),
      opts.client.query({
        query: `
          SELECT toUInt64(max(block_height)) AS block_height
          FROM price_data.raw_block_snapshots
        `,
        format: 'JSONEachRow',
      }),
    ])
    const mainRows = await mainRes.json<{ block_height: string; block_timestamp: string }>()
    const rawRows = await rawRes.json<{ block_height: string }>()
    const main = mainRows[0]
    const raw = rawRows[0]
    const blockTs = main?.block_timestamp ?? ''
    const blockHeight = main ? Number(main.block_height) : 0
    const chainBlockHeight = raw ? Number(raw.block_height) : 0
    const lagSeconds = blockTs
      ? Math.max(0, Math.floor((Date.now() - new Date(blockTs.replace(' ', 'T') + 'Z').getTime()) / 1000))
      : 0
    const data: IndexerStatus = {
      blockHeight,
      blockTimestamp: blockTs,
      lagSeconds,
      chainBlockHeight,
      blocksBehindHead: Math.max(0, chainBlockHeight - blockHeight),
    }
    cache = { data, fetchedAt: Date.now() }
    return data
  })
}
