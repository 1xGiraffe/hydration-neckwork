import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
  'RPC_URL',
  'CLICKHOUSE_HOST',
  'RPC_RATE_LIMIT',
  'RPC_CAPACITY',
  'BATCH_SIZE',
  'SNAPSHOT_INTERVAL',
  'GRAPH_MIN_PATH_LIQUIDITY_USD',
] as const
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

describe('indexer numeric configuration', () => {
  it('uses strict positive integers for concurrency and batch settings', async () => {
    process.env.RPC_RATE_LIMIT = '20junk'
    process.env.RPC_CAPACITY = '-1'
    process.env.BATCH_SIZE = '0'
    process.env.SNAPSHOT_INTERVAL = '1.5'

    const { config } = await import('../src/config.ts')

    expect(config.RPC_RATE_LIMIT).toBe(100)
    expect(config.RPC_CAPACITY).toBe(20)
    expect(config.BATCH_SIZE).toBe(50_000)
    expect(config.SNAPSHOT_INTERVAL).toBe(1_000)
  })

  it('allows zero only for the optional graph liquidity threshold', async () => {
    process.env.GRAPH_MIN_PATH_LIQUIDITY_USD = '0'

    const { config } = await import('../src/config.ts')

    expect(config.GRAPH_MIN_PATH_LIQUIDITY_USD).toBe(0)
  })

  it('does not accept empty service endpoints', async () => {
    process.env.RPC_URL = ''
    process.env.CLICKHOUSE_HOST = ''

    const { config } = await import('../src/config.ts')

    expect(config.RPC_URL).toBe('https://rpc.hydradx.cloud')
    expect(config.CLICKHOUSE_URL).toBe('http://localhost:18123')
  })
})
