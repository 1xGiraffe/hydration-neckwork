import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RAW_EVM_RPC_URL,
  GIGAHDX_POOL_PROXY,
  extractMoneyMarketRows,
  snapshotMoneyMarketPositions,
} from '../../src/raw/moneyMarket.ts'
import type { RawEvmLogRow } from '../../src/raw/types.ts'

const USER = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'
const RESERVE = '0x00000000000000000000000000000000000003e8'

function supplyLog(contractAddress = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'): RawEvmLogRow {
  return {
    block_height: 7_037_100,
    block_timestamp: '2026-01-01 00:00:00',
    event_index: 9,
    extrinsic_index: 1,
    call_address: '0',
    contract_address: contractAddress,
    topic0: '0x',
    topics: [],
    data: '0x',
    decode_status: 'decoded',
    event_signature: 'Supply(address,address,address,uint256,uint16)',
    event_name: 'Supply',
    decoded_args_json: JSON.stringify({
      reserve: RESERVE,
      user: USER,
      onBehalfOf: USER,
      amount: '1000',
      referralCode: '0',
    }),
    participants: [USER],
    assets: [RESERVE],
    warning: null,
    raw_log_json: '{}',
    ingest_source: 'test',
  }
}

describe('raw Money Market rows', () => {
  afterEach(() => {
    delete process.env.RAW_EVM_RPC_URL
    delete process.env.RAW_EVM_RPC_FALLBACK_URLS
    vi.restoreAllMocks()
  })

  it('ignores Money Market-shaped events from contracts outside the current deployment', async () => {
    const rows = await extractMoneyMarketRows([
      supplyLog('0x2222222222222222222222222222222222222222'),
    ], 'test')

    expect(rows.events).toHaveLength(0)
    expect(rows.positions).toHaveLength(0)
    expect(rows.reserves).toHaveLength(0)
  })

  it('uses the default Money Market position RPC when not configured', async () => {
    delete process.env.RAW_EVM_RPC_URL
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        result: `0x${[
          1000n,
          200n,
          800n,
          8500n,
          7500n,
          5_000_000_000_000_000_000n,
        ].map(value => value.toString(16).padStart(64, '0')).join('')}`,
      }),
    } as unknown as Response)

    const rows = await extractMoneyMarketRows([supplyLog()], 'test')

    expect(fetchMock).toHaveBeenCalledWith(
      DEFAULT_RAW_EVM_RPC_URL,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(rows.positions).toHaveLength(1)
    expect(rows.positions[0].total_collateral_base).toBe('1000')
  })

  it('redacts sensitive Money Market RPC URL parts from position evidence', async () => {
    process.env.RAW_EVM_RPC_URL = 'https://user:pass@example.com/private/path?token=secret'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        result: `0x${[
          1000n,
          200n,
          800n,
          8500n,
          7500n,
          5_000_000_000_000_000_000n,
        ].map(value => value.toString(16).padStart(64, '0')).join('')}`,
      }),
    } as unknown as Response)

    const rows = await extractMoneyMarketRows([supplyLog()], 'test')
    const evidence = JSON.parse(rows.positions[0].evidence_json) as Record<string, unknown>

    expect(fetchMock).toHaveBeenCalledWith(
      'https://user:pass@example.com/private/path?token=secret',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(evidence.rpc_origin).toBe('https://example.com')
    expect(evidence.rpc_url).toBeUndefined()
    expect(rows.positions[0].evidence_json).not.toContain('user:pass')
    expect(rows.positions[0].evidence_json).not.toContain('secret')
  })

  it('retries Money Market position reads on configured fallback RPCs', async () => {
    process.env.RAW_EVM_RPC_URL = 'https://slow.example'
    process.env.RAW_EVM_RPC_FALLBACK_URLS = 'https://fallback.example'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        statusText: 'Gateway Timeout',
        json: async () => ({ error: 'timeout' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          result: `0x${[
            1000n,
            200n,
            800n,
            8500n,
            7500n,
            5_000_000_000_000_000_000n,
          ].map(value => value.toString(16).padStart(64, '0')).join('')}`,
        }),
      } as unknown as Response)

    const rows = await extractMoneyMarketRows([supplyLog()], 'test')
    const evidence = JSON.parse(rows.positions[0].evidence_json) as Record<string, unknown>

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://slow.example')
    expect(fetchMock.mock.calls[1][0]).toBe('https://fallback.example')
    expect(rows.positions).toHaveLength(1)
    expect(rows.warnings).toHaveLength(0)
    expect(evidence.rpc_origin).toBe('https://fallback.example')
  })

  it('fails hard when Money Market position RPC is explicitly invalid', async () => {
    process.env.RAW_EVM_RPC_URL = 'wss://hydration.dotters.network'

    await expect(extractMoneyMarketRows([supplyLog()], 'test')).rejects.toThrow(
      'RAW_EVM_RPC_URL must use http or https',
    )
  })

  it('can snapshot only the requested isolated market', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        result: `0x${[1000n, 200n, 800n, 7000n, 4000n, 3_500_000_000_000_000_000n]
          .map(value => value.toString(16).padStart(64, '0'))
          .join('')}`,
      }),
    } as unknown as Response)

    const result = await snapshotMoneyMarketPositions(
      [USER],
      13_000_000,
      '2026-07-01 00:00:00',
      'test',
      { marketKeys: ['gigahdx'] },
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { params: Array<{ to: string }> }
    expect(body.params[0].to).toBe(GIGAHDX_POOL_PROXY)
    expect(result.positions).toHaveLength(1)
    expect(result.positions[0].pool_address).toBe(GIGAHDX_POOL_PROXY)
  })

  it('writes zero tombstones only when a sparse supplemental sweep requests them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ result: `0x${'0'.repeat(64 * 6)}` }),
    } as unknown as Response)

    const args = [
      [USER],
      13_000_000,
      '2026-07-01 00:00:00',
      'test',
    ] as const
    const defaultResult = await snapshotMoneyMarketPositions(...args, { marketKeys: ['gigahdx'] })
    const tombstoneResult = await snapshotMoneyMarketPositions(...args, {
      marketKeys: ['gigahdx'],
      includeZeroPositions: true,
    })

    expect(defaultResult.positions).toHaveLength(0)
    expect(tombstoneResult.positions).toHaveLength(1)
    expect(tombstoneResult.positions[0]).toMatchObject({
      pool_address: GIGAHDX_POOL_PROXY,
      total_collateral_base: '0',
      total_debt_base: '0',
    })
  })

  it('projects supplemental events without performing position RPC reads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const result = await extractMoneyMarketRows(
      [supplyLog(GIGAHDX_POOL_PROXY)],
      'supplemental',
      { marketKeys: ['gigahdx'], skipPositions: true },
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.events).toHaveLength(1)
    expect(result.events[0].pool_address).toBe(GIGAHDX_POOL_PROXY)
    expect(JSON.parse(result.events[0].evidence_json)).toMatchObject({
      market: 'gigahdx',
      current_market_contracts: { pool: GIGAHDX_POOL_PROXY },
    })
    expect(result.positions).toHaveLength(0)
  })
})

// MONEY_MARKETS is parsed at module load from RAW_MM_EXTRA_MARKETS. GIGAHDX is a
// built-in key, so these fixtures use a distinct future deployment.
describe('raw Money Market — additional markets (RAW_MM_EXTRA_MARKETS)', () => {
  const FUTURE_POOL = '0x3333333333333333333333333333333333333333'
  const FUTURE_ATOKEN = '0x4444444444444444444444444444444444444444'

  afterEach(() => {
    delete process.env.RAW_MM_EXTRA_MARKETS
    delete process.env.RAW_EVM_RPC_URL
    delete process.env.RAW_EVM_RPC_FALLBACK_URLS
    vi.restoreAllMocks()
    vi.resetModules()
  })

  function positionResult() {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        result: `0x${[1000n, 200n, 800n, 8500n, 7500n, 5_000_000_000_000_000_000n]
          .map(value => value.toString(16).padStart(64, '0'))
          .join('')}`,
      }),
    } as unknown as Response
  }

  it('attributes logs from a configured extra market to its own pool and routes the position read there', async () => {
    process.env.RAW_MM_EXTRA_MARKETS = JSON.stringify([
      { key: 'future', poolProxy: FUTURE_POOL, contracts: [FUTURE_ATOKEN] },
    ])
    vi.resetModules()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(positionResult())
    const { extractMoneyMarketRows: extract } = await import('../../src/raw/moneyMarket.ts')

    const rows = await extract([supplyLog(FUTURE_POOL)], 'test')

    // event tagged with the future market's pool
    expect(rows.events).toHaveLength(1)
    expect(rows.events[0].pool_address).toBe(FUTURE_POOL)
    // position read targeted the future market's pool
    expect(rows.positions).toHaveLength(1)
    expect(rows.positions[0].pool_address).toBe(FUTURE_POOL)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { params: Array<{ to: string }> }
    expect(body.params[0].to).toBe(FUTURE_POOL)
  })

  it('routes an a-token log of an extra market to that market’s pool', async () => {
    process.env.RAW_MM_EXTRA_MARKETS = JSON.stringify([
      { key: 'future', poolProxy: FUTURE_POOL, contracts: [FUTURE_ATOKEN] },
    ])
    vi.resetModules()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(positionResult())
    const { extractMoneyMarketRows: extract } = await import('../../src/raw/moneyMarket.ts')

    const rows = await extract([supplyLog(FUTURE_ATOKEN)], 'test')
    expect(rows.positions[0].pool_address).toBe(FUTURE_POOL)
  })

  it('still indexes the core market alongside an extra market', async () => {
    process.env.RAW_MM_EXTRA_MARKETS = JSON.stringify([
      { key: 'future', poolProxy: FUTURE_POOL, contracts: [FUTURE_ATOKEN] },
    ])
    vi.resetModules()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(positionResult())
    const { extractMoneyMarketRows: extract } = await import('../../src/raw/moneyMarket.ts')

    const rows = await extract([supplyLog()], 'test') // core pool
    expect(rows.events[0].pool_address).toBe('0x1b02e051683b5cfac5929c25e84adb26ecf87b38')
  })

  it('rejects malformed RAW_MM_EXTRA_MARKETS on load', async () => {
    process.env.RAW_MM_EXTRA_MARKETS = '[{"key":"bad","poolProxy":"nope"}]'
    vi.resetModules()
    await expect(import('../../src/raw/moneyMarket.ts')).rejects.toThrow('poolProxy must be a 20-byte hex address')
  })
})
