import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AUTH, TEST_HEAD, fakeDataClient, freshDataApp } from './helpers.ts'

// Contract tests for /v1/evm/*: transaction by hash, contract identity,
// the index-then-enrich log pages, and the ABI/sources surface.

type Row = Record<string, unknown>

const TX_HASH = `0x${'a1'.repeat(32)}`
const CONTRACT = `0x${'b2'.repeat(20)}`
const FROM = `0x${'c3'.repeat(20)}`
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const TX_ROW: Row = {
  tx_hash: TX_HASH, block_height: 500, extrinsic_index: 3, event_index: 9, ts: '2026-08-20 10:00:00',
  from_address: FROM, to_address: CONTRACT, exit_kind: 'Revert', exit_detail: 'Reverted', extra_data: '0x08c379a0',
}

const LOG_INDEX_ROWS: Row[] = [
  { block_height: 700, event_index: 4, ts: '2026-08-21 10:00:00', ingested_at: '2026-08-21 10:00:05' },
  { block_height: 600, event_index: 2, ts: '2026-08-20 12:00:00', ingested_at: '2026-08-20 12:00:05' },
]

const LOG_RAW_ROWS: Row[] = [
  {
    block_height: 700, event_index: 4, extrinsic_index: 1, ts: '2026-08-21 10:00:00',
    topics: [TOPIC_TRANSFER, `0x${'00'.repeat(32)}`], data: '0x01', decode_status: 'decoded',
    event_name: 'Transfer', event_signature: 'Transfer(address,address,uint256)',
    decoded_args_json: '{"from":"0x0000000000000000000000000000000000000000","value":"1"}',
    ingested_at: '2026-08-21 10:00:05',
  },
  {
    block_height: 600, event_index: 2, extrinsic_index: null, ts: '2026-08-20 12:00:00',
    topics: [], data: '0x02', decode_status: 'undecoded', event_name: null, event_signature: null,
    decoded_args_json: '', ingested_at: '2026-08-20 12:00:05',
  },
]

function evmClient(overrides: {
  tx?: Row[]; snapshot?: Row[]; abi?: Row[]; stats?: Row[]; logIndex?: Row[]; logRaw?: Row[]; sources?: Row[]
} = {}) {
  return fakeDataClient(
    (query, params) => (query.includes('-- data:evm:transaction')
      ? (overrides.tx ?? [TX_ROW]).filter(row => row.tx_hash === params.hash)
      : undefined),
    (query, params) => (query.includes('-- data:evm:contract-log-stats')
      ? (overrides.stats ?? [{ log_count: '42', first_block: 100, last_block: 700, first_ts: '2026-01-01 00:00:00', last_ts: '2026-08-21 10:00:00' }]).filter(() => params.address === CONTRACT)
      : undefined),
    (query, params) => (query.includes('-- data:evm:contract')
      ? (overrides.snapshot ?? [{ address: CONTRACT, kind: 'contract', code_hash: `0x${'d4'.repeat(32)}`, code_size: 1234, destroyed: 0 }]).filter(row => row.address === params.address)
      : undefined),
    (query, params) => (query.includes('-- data:evm:abi')
      ? (overrides.abi ?? [{ address: CONTRACT, abi_json: '[{"type":"function","name":"transfer"}]', contract_name: 'MyToken', compiler_version: 'v0.8.19', source: 'verified', match_type: 'FULL', code_hash: `0x${'d4'.repeat(32)}` }]).filter(row => row.address === params.address)
      : undefined),
    (query, params) => {
      if (!query.includes('-- data:evm:logs:index')) return undefined
      let rows = (overrides.logIndex ?? LOG_INDEX_ROWS)
      if (params.topic0) rows = rows.filter(row => Number(row.block_height) === 700) // only the Transfer row carries it
      if (params.cb != null) rows = rows.filter(row => Number(row.block_height) < Number(params.cb))
      return params.address === CONTRACT ? rows : []
    },
    (query, params) => (query.includes('-- data:evm:logs:enrich')
      ? (overrides.logRaw ?? LOG_RAW_ROWS).filter(row => (params.bs as number[]).some((b, i) => b === Number(row.block_height) && (params.es as number[])[i] === Number(row.event_index)))
      : undefined),
    (query, params) => (query.includes('-- data:evm:sources')
      ? (overrides.sources ?? [{ path: 'src/MyToken.sol', content: 'contract MyToken {}', evm_version: 'paris', optimizer_enabled: 1, optimizer_runs: 200, constructor_arguments: '0x' }]).filter(() => params.address === CONTRACT)
      : undefined),
  )
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /v1/evm/transactions/:txHash', () => {
  it('answers a hash with the full exit detail and a derived success flag', async () => {
    app = await freshDataApp(evmClient())
    const res = await app.inject({ url: `/v1/evm/transactions/${TX_HASH}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      txHash: TX_HASH, blockHeight: 500, extrinsicIndex: 3, extrinsicHash: null, eventIndex: 9,
      timestamp: '2026-08-20T10:00:00.000Z', from: FROM, to: CONTRACT,
      success: false, exitKind: 'Revert', exitDetail: 'Reverted', extraData: '0x08c379a0',
    })
  })

  it('404s an unknown hash with the indexed head, and 400s a malformed one', async () => {
    app = await freshDataApp(evmClient())
    const missing = await app.inject({ url: `/v1/evm/transactions/0x${'99'.repeat(32)}`, headers: AUTH })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.context.indexedHead).toBe(TEST_HEAD)
    expect(missing.json().error.context.hint).toMatch(/finalized/)
    expect((await app.inject({ url: '/v1/evm/transactions/12345', headers: AUTH })).statusCode).toBe(400)
  })
})

describe('GET /v1/evm/contracts/:address', () => {
  it('joins registry identity, verification and exact log stats', async () => {
    app = await freshDataApp(evmClient())
    const res = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      address: CONTRACT, kind: 'contract', codeHash: `0x${'d4'.repeat(32)}`, codeSize: 1234,
      destroyed: false, verified: true, contractName: 'MyToken', compilerVersion: 'v0.8.19',
      matchType: 'FULL', abiSource: 'verified',
      logs: { count: 42, firstBlock: 100, lastBlock: 700, firstTime: '2026-01-01T00:00:00.000Z', lastTime: '2026-08-21T10:00:00.000Z' },
    })
  })

  it('reports an unverified, logless contract honestly and 404s an unknown address', async () => {
    const other = `0x${'e5'.repeat(20)}`
    app = await freshDataApp(evmClient({
      snapshot: [{ address: other, kind: 'asset-erc20', code_hash: '0x00', code_size: 1, destroyed: 0 }],
      abi: [], stats: [],
    }))
    // Rewire the address filters: this client only knows `other`.
    const res = await app.inject({ url: `/v1/evm/contracts/${other}`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ address: other, verified: false, contractName: null, abiSource: null, logs: null })

    const missing = await app.inject({ url: `/v1/evm/contracts/0x${'f6'.repeat(20)}`, headers: AUTH })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.context.hint).toMatch(/registry/)
  })
})

describe('GET /v1/evm/contracts/:address/logs', () => {
  it('pages the narrow index and enriches the page with topics/data/decoded', async () => {
    const client = evmClient()
    app = await freshDataApp(client)
    const res = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}/logs`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    const { items } = res.json()
    expect(items).toEqual([
      {
        blockHeight: 700, eventIndex: 4, extrinsicIndex: 1, extrinsicHash: null, timestamp: '2026-08-21T10:00:00.000Z',
        topics: [TOPIC_TRANSFER, `0x${'00'.repeat(32)}`], data: '0x01',
        decoded: { name: 'Transfer', signature: 'Transfer(address,address,uint256)', args: { from: '0x0000000000000000000000000000000000000000', value: '1' } },
      },
      {
        blockHeight: 600, eventIndex: 2, extrinsicIndex: null, extrinsicHash: null, timestamp: '2026-08-20T12:00:00.000Z',
        topics: [], data: '0x02', decoded: null,
      },
    ])
    // The enrichment is one primary-key IN read carrying exactly the page's keys.
    const enrich = client.seen.find(s => s.query.includes('-- data:evm:logs:enrich'))!
    expect(enrich.params.bs).toEqual([700, 600])
    expect(enrich.params.es).toEqual([4, 2])
  })

  it('filters by topic0 and pages by cursor', async () => {
    app = await freshDataApp(evmClient())
    const filtered = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}/logs?topic0=${TOPIC_TRANSFER}`, headers: AUTH })
    expect(filtered.json().items.map((l: { blockHeight: number }) => l.blockHeight)).toEqual([700])

    const first = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}/logs?limit=1`, headers: AUTH })
    expect(first.json().hasMore).toBe(true)
    const second = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}/logs?limit=1&cursor=${first.json().nextCursor}`, headers: AUTH })
    expect(second.json().items.map((l: { blockHeight: number }) => l.blockHeight)).toEqual([600])
  })
})

describe('GET /v1/evm/contracts/:address/abi', () => {
  it('serves the ABI with its source files', async () => {
    app = await freshDataApp(evmClient())
    const res = await app.inject({ url: `/v1/evm/contracts/${CONTRACT}/abi`, headers: AUTH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      address: CONTRACT,
      abi: [{ type: 'function', name: 'transfer' }],
      contractName: 'MyToken', compilerVersion: 'v0.8.19', source: 'verified', matchType: 'FULL',
      codeHash: `0x${'d4'.repeat(32)}`,
      sources: [{ path: 'src/MyToken.sol', content: 'contract MyToken {}', evmVersion: 'paris', optimizerEnabled: true, optimizerRuns: 200, constructorArguments: '0x' }],
    })
  })

  it('404s a contract without an ABI, pointing at the contract detail', async () => {
    const bare = `0x${'a7'.repeat(20)}`
    app = await freshDataApp(evmClient({ abi: [], sources: [] }))
    const res = await app.inject({ url: `/v1/evm/contracts/${bare}/abi`, headers: AUTH })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.context.hint).toMatch(/\/v1\/evm\/contracts/)
  })
})
