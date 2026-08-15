import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_KEYS = [
  'RPC_URL',
  'CLICKHOUSE_HOST',
  'RPC_RATE_LIMIT',
  'RPC_CAPACITY',
  'BATCH_SIZE',
  'SNAPSHOT_INTERVAL',
  'SNAPSHOT_INTERVAL_MINUTES',
  'RPC_HEAD_POLL_MS',
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
    process.env.SNAPSHOT_INTERVAL_MINUTES = '1.5'

    const { config } = await import('../src/config.ts')

    expect(config.RPC_RATE_LIMIT).toBe(100)
    expect(config.RPC_CAPACITY).toBe(20)
    expect(config.BATCH_SIZE).toBe(50_000)
    expect(config.SNAPSHOT_INTERVAL_MINUTES).toBe(100)
  })

  // The registry scan interval is a duration. Its old block-count spelling meant
  // 100 minutes only while a block was 6s, so the deprecated variable is read at
  // that cadence — never reinterpreted at whatever the chain's block time becomes.
  it('reads the deprecated block-count snapshot interval at the cadence it was written for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.SNAPSHOT_INTERVAL = '1000'

    const { config } = await import('../src/config.ts')

    expect(config.SNAPSHOT_INTERVAL_MINUTES).toBe(100)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SNAPSHOT_INTERVAL is deprecated'))
    warn.mockRestore()
  })

  it('prefers the minutes variable over the deprecated block count', async () => {
    process.env.SNAPSHOT_INTERVAL = '1000'
    process.env.SNAPSHOT_INTERVAL_MINUTES = '240'

    const { config } = await import('../src/config.ts')

    expect(config.SNAPSHOT_INTERVAL_MINUTES).toBe(240)
  })

  // At a 2s block time a 2000ms head poll is exactly one poll per block, so any
  // jitter costs a whole block of lag. The default has to stay well inside a block.
  it('polls for a new head several times per block at any planned cadence', async () => {
    const { config } = await import('../src/config.ts')

    expect(config.RPC_HEAD_POLL_MS).toBe(750)
    expect(config.RPC_HEAD_POLL_MS).toBeLessThan(2_000 / 2)
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

    expect(config.RPC_URL).toBe('https://hydration-rpc.neckwork.net')
    expect(config.CLICKHOUSE_URL).toBe('http://localhost:18123')
  })
})
