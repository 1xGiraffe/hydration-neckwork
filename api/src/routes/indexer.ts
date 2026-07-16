import type { FastifyInstance } from 'fastify'
import type { ClickHouseClient } from '../db/client.ts'

interface IndexerStatus {
  blockHeight: number
  blockTimestamp: string
  lagSeconds: number
  chainBlockHeight: number
  blocksBehindHead: number
  rawFinalizedRangeCount: number
  rawFinalizedFromBlock: number
  rawFinalizedToBlock: number
}

const TTL_MS = 5_000
const CHAIN_HEAD_REFRESH_MS = 5_000

function uintValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

async function fetchChainBlockHeight(): Promise<number | null> {
  const rpcUrl = process.env.CHAIN_RPC_URL ?? process.env.RPC_URL ?? 'https://rpc.hydradx.cloud'
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getHeader', params: [] }),
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return null
    const json = await response.json() as { result?: { number?: unknown } }
    const encoded = json.result?.number
    if (typeof encoded !== 'string' || !/^0x[0-9a-f]+$/i.test(encoded)) return null
    const height = Number.parseInt(encoded.slice(2), 16)
    return Number.isSafeInteger(height) && height > 0 ? height : null
  } catch {
    return null
  }
}

export async function indexerRoutes(fastify: FastifyInstance, opts: { client: ClickHouseClient }) {
  let cache: { data: IndexerStatus; fetchedAt: number } | null = null
  let inflight: Promise<IndexerStatus> | null = null
  let chainBlockHeight: number | null = null
  let refreshingChainHead = false

  const refreshChainHead = async () => {
    if (refreshingChainHead) return
    refreshingChainHead = true
    try {
      const height = await fetchChainBlockHeight()
      if (height != null) chainBlockHeight = height
    } finally {
      refreshingChainHead = false
    }
  }

  // Chain RPC is sampled at startup and on a bounded background interval. HTTP
  // requests only read this snapshot and ClickHouse-backed status.
  await refreshChainHead()
  const chainHeadTimer = setInterval(() => { void refreshChainHead() }, CHAIN_HEAD_REFRESH_MS)
  chainHeadTimer.unref()
  fastify.addHook('onClose', async () => { clearInterval(chainHeadTimer) })

  fastify.get('/indexer', async () => {
    if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.data
    if (inflight) return inflight

    const request = loadIndexerStatus(opts.client, chainBlockHeight).then(data => {
      cache = { data, fetchedAt: Date.now() }
      return data
    }).finally(() => {
      if (inflight === request) inflight = null
    })
    inflight = request
    return request
  })
}

async function loadIndexerStatus(client: ClickHouseClient, sampledChainBlockHeight: number | null): Promise<IndexerStatus> {
  // Main indexer head, raw worker head, and finalized raw coverage come from
  // ClickHouse. If the background chain-head sample is unavailable, use the raw
  // checkpoint so the endpoint remains explicit about indexed status.
  const [mainRes, rawRes, rawCoverageRes] = await Promise.all([
    client.query({
      query: `
          SELECT
            toUInt64(max(block_height)) AS block_height,
            toString(max(block_timestamp)) AS block_timestamp
          FROM price_data.blocks
        `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          SELECT toUInt64(max(last_block)) AS block_height
          FROM price_data.raw_ingestion_state FINAL
        `,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `
          WITH
            ordered AS (
              SELECT
                from_block,
                to_block,
                max(to_block) OVER (
                  ORDER BY from_block ASC, to_block ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ) AS prev_max_to
              FROM price_data.raw_ingestion_ranges FINAL
              WHERE status = 'completed'
            ),
            marked AS (
              SELECT
                from_block,
                to_block,
                if(prev_max_to = 0 OR from_block > prev_max_to + 1, 1, 0) AS starts_new
              FROM ordered
            ),
            grouped AS (
              SELECT
                from_block,
                to_block,
                sum(starts_new) OVER (
                  ORDER BY from_block ASC, to_block ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS island
              FROM marked
            ),
            islands AS (
              SELECT
                island,
                min(from_block) AS from_block,
                max(to_block) AS to_block,
                count() AS range_count
              FROM grouped
              GROUP BY island
            )
          SELECT
            toUInt64(range_count) AS range_count,
            toUInt64(from_block) AS from_block,
            toUInt64(to_block) AS to_block
          FROM islands
          ORDER BY to_block DESC
          LIMIT 1
        `,
      format: 'JSONEachRow',
    }),
  ])
  const mainRows = await mainRes.json<{ block_height: string; block_timestamp: string }>()
  const rawRows = await rawRes.json<{ block_height: string }>()
  const rawCoverageRows = await rawCoverageRes.json<{
    range_count: string
    from_block: string
    to_block: string
  }>()
  const main = mainRows[0]
  const raw = rawRows[0]
  const rawCoverage = rawCoverageRows[0]
  const blockTs = main?.block_timestamp ?? ''
  const blockHeight = uintValue(main?.block_height)
  const rawBlockHeight = uintValue(raw?.block_height)
  const chainBlockHeight = sampledChainBlockHeight ?? Math.max(rawBlockHeight, blockHeight)
  const blockTimeMs = blockTs ? Date.parse(`${blockTs.replace(' ', 'T')}Z`) : Number.NaN
  const lagSeconds = Number.isFinite(blockTimeMs)
    ? Math.max(0, Math.floor((Date.now() - blockTimeMs) / 1000))
    : 0
  const data: IndexerStatus = {
    blockHeight,
    blockTimestamp: blockTs,
    lagSeconds,
    chainBlockHeight,
    blocksBehindHead: Math.max(0, chainBlockHeight - blockHeight),
    rawFinalizedRangeCount: uintValue(rawCoverage?.range_count),
    rawFinalizedFromBlock: uintValue(rawCoverage?.from_block),
    rawFinalizedToBlock: uintValue(rawCoverage?.to_block),
  }
  return data
}
