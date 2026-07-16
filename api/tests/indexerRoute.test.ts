import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Rows = Record<string, string>[]

function queryResult(rows: Rows) {
  return { json: vi.fn(async () => rows) }
}

async function makeApp(options: {
  mainHeight: number
  rawHeight: number
  chainHeight?: number
  chainHeader?: string
}) {
  vi.resetModules()
  if (options.chainHeight == null && options.chainHeader == null) {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('rpc unavailable')))
  } else {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { number: options.chainHeader ?? `0x${options.chainHeight!.toString(16)}` } }),
    }))
  }

  const { default: Fastify } = await import('fastify')
  const { indexerRoutes } = await import('../src/routes/indexer.ts')
  const client = {
    query: vi.fn(({ query }: { query: string }) => {
      if (query.includes('FROM price_data.blocks')) {
        return queryResult([{ block_height: String(options.mainHeight), block_timestamp: '2026-06-24 12:00:00' }])
      }
      if (query.includes('FROM price_data.raw_ingestion_state')) {
        return queryResult([{ block_height: String(options.rawHeight) }])
      }
      if (query.includes('FROM price_data.raw_ingestion_ranges')) {
        return queryResult([{ range_count: '4', from_block: '10', to_block: '49' }])
      }
      throw new Error(`unexpected query: ${query}`)
    }),
  }
  const app = Fastify()
  await app.register(indexerRoutes, { client: client as never })
  return { app, client }
}

describe('/indexer route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-24T12:00:42Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports lag against the background chain-head snapshot', async () => {
    const { app } = await makeApp({ mainHeight: 100, rawHeight: 105, chainHeight: 120 })
    const response = await app.inject('/indexer')
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      blockHeight: 100,
      chainBlockHeight: 120,
      blocksBehindHead: 20,
      rawFinalizedRangeCount: 4,
      rawFinalizedFromBlock: 10,
      rawFinalizedToBlock: 49,
    })
  })

  it('falls back to the local raw checkpoint when RPC is unavailable', async () => {
    const { app } = await makeApp({ mainHeight: 100, rawHeight: 112 })
    const response = await app.inject('/indexer')
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      blockHeight: 100,
      chainBlockHeight: 112,
      blocksBehindHead: 12,
    })
  })

  it('rejects malformed RPC heights instead of partially parsing them', async () => {
    const { app } = await makeApp({ mainHeight: 100, rawHeight: 112, chainHeader: '0x78junk' })
    const response = await app.inject('/indexer')
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ chainBlockHeight: 112, blocksBehindHead: 12 })
  })

  it('shares a cold ClickHouse load without issuing request-time RPC', async () => {
    const { app, client } = await makeApp({ mainHeight: 100, rawHeight: 105, chainHeight: 120 })
    const [first, second] = await Promise.all([app.inject('/indexer'), app.inject('/indexer')])
    await app.close()

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
