import { describe, it, expect, beforeAll } from 'vitest'
import {
  collectEvmCalls,
  evmLogFromEventArgs,
  attachEvmLogDecodes,
  type EvmLogDecode,
} from '../src/services/contractAbiDecode.ts'
import {
  initContractVerificationService,
  loadVerifiedContracts,
} from '../src/services/contractVerificationService.ts'
import {
  initExplorerService,
  getExtrinsicAt,
  getEventAt,
} from '../src/services/explorerService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const VERIFIED = '0x00000000000000000000000000000000000000e1'
const UNVERIFIED = '0x00000000000000000000000000000000000000e2'
const SENDER = '0x4b0540d29f19b2da4cce2b1ba6b6325dd9d86622'

const TRANSFER_SELECTOR = '0xa9059cbb'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const TRANSFER_INPUT = `${TRANSFER_SELECTOR}${word(SENDER)}${word('f4240')}`

const ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Transfer',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
]

const TRANSFER_LOG = {
  log: {
    address: VERIFIED,
    topics: [TRANSFER_TOPIC0, `0x${word(SENDER)}`, `0x${word(VERIFIED)}`],
    data: `0x${word('f4240')}`,
  },
}

// EVM.call args exactly as raw_extrinsics stores them (SCALE-decoded JSON).
const evmCallArgs = (target: string) => ({
  source: SENDER,
  target,
  input: TRANSFER_INPUT,
  value: '0',
  gasLimit: '200000',
})

// Ethereum.transact call_args_json shape (Legacy envelope).
const transactArgs = (target: string) => ({
  transaction: {
    __kind: 'Legacy',
    value: {
      nonce: '1',
      gasPrice: '7000000',
      gasLimit: '34872',
      action: { __kind: 'Call', value: target },
      value: '0',
      input: TRANSFER_INPUT,
    },
  },
})

describe('collectEvmCalls', () => {
  it('extracts the target and input of a top-level EVM.call', () => {
    expect(collectEvmCalls('EVM.call', evmCallArgs(VERIFIED))).toEqual([
      { target: VERIFIED, input: TRANSFER_INPUT },
    ])
  })

  it('extracts an Ethereum.transact Call action, and skips Create', () => {
    expect(collectEvmCalls('Ethereum.transact', transactArgs(VERIFIED))).toEqual([
      { target: VERIFIED, input: TRANSFER_INPUT },
    ])
    const create = {
      transaction: { __kind: 'Legacy', value: { action: { __kind: 'Create' }, input: '0x6080' } },
    }
    expect(collectEvmCalls('Ethereum.transact', create)).toEqual([])
  })

  it('finds EVM.call nodes nested in batch/proxy/multisig wrappers, in order', () => {
    const args = {
      threshold: 2,
      call: {
        __kind: 'Utility',
        value: {
          __kind: 'batch_all',
          calls: [
            { __kind: 'EVMAccounts', value: { __kind: 'bind_evm_address' } },
            { __kind: 'EVM', value: { __kind: 'call', ...evmCallArgs(VERIFIED) } },
            { __kind: 'EVM', value: { __kind: 'call', ...evmCallArgs(UNVERIFIED), input: '0xdeadbeef' } },
          ],
        },
      },
    }
    expect(collectEvmCalls('Multisig.as_multi', args)).toEqual([
      { target: VERIFIED, input: TRANSFER_INPUT },
      { target: UNVERIFIED, input: '0xdeadbeef' },
    ])
  })

  it('ignores non-call EVM variants, malformed nodes, and non-object args', () => {
    expect(collectEvmCalls('EVM.call', { target: 'not-hex', input: TRANSFER_INPUT })).toEqual([])
    expect(collectEvmCalls('EVM.call', null)).toEqual([])
    expect(collectEvmCalls('Utility.batch_all', {
      calls: [{ __kind: 'EVM', value: { __kind: 'create', init: '0x6080' } }],
    })).toEqual([])
    expect(collectEvmCalls('Balances.transfer', { dest: SENDER, value: '1' })).toEqual([])
  })

  it('bounds the tree walk depth', () => {
    let nested: Record<string, unknown> = { __kind: 'EVM', value: { __kind: 'call', ...evmCallArgs(VERIFIED) } }
    for (let i = 0; i < 20; i++) nested = { call: nested }
    expect(collectEvmCalls('Proxy.proxy', nested)).toEqual([])
  })
})

describe('evmLogFromEventArgs', () => {
  it('reads the nested log shape raw_events stores', () => {
    expect(evmLogFromEventArgs(TRANSFER_LOG)).toEqual({
      address: VERIFIED,
      topics: TRANSFER_LOG.log.topics,
      data: TRANSFER_LOG.log.data,
    })
  })

  it('tolerates a flat log object and rejects malformed args', () => {
    expect(evmLogFromEventArgs(TRANSFER_LOG.log)).not.toBeNull()
    expect(evmLogFromEventArgs({ log: { address: 'nope', topics: [], data: '0x' } })).toBeNull()
    expect(evmLogFromEventArgs({ log: { address: VERIFIED, topics: [42], data: '0x' } })).toBeNull()
    expect(evmLogFromEventArgs('0x')).toBeNull()
    expect(evmLogFromEventArgs(null)).toBeNull()
  })
})

// --- detail-surface integration --------------------------------------------
//
// One fake client serves the extrinsic/event/ABI reads and records every query,
// so the tests can assert decoding is page-bounded: rows already fetched are
// decoded in memory, the single ABI read is cached per (address, verifiedAt),
// and no further ClickHouse queries appear however many rows decode.

const seen: string[] = []

function fakeClient(): ClickHouseClient {
  const extrinsics = new Map<string, Record<string, unknown>>([
    ['100:1', {
      block_height: 100, extrinsic_index: 1, extrinsic_hash: '0x' + '11'.repeat(32), ts: '2026-08-04 10:00:00',
      version: 4, signer: SENDER, success: 1, call_name: 'EVM.call', fee: null, tip: null,
      call_args_json: JSON.stringify(evmCallArgs(VERIFIED)), error_json: null, spec_version: 320,
    }],
    ['101:1', {
      block_height: 101, extrinsic_index: 1, extrinsic_hash: '0x' + '22'.repeat(32), ts: '2026-08-04 10:00:12',
      version: 4, signer: SENDER, success: 1, call_name: 'Ethereum.transact', fee: null, tip: null,
      call_args_json: JSON.stringify(transactArgs(VERIFIED)), error_json: null, spec_version: 320,
    }],
    ['102:1', {
      block_height: 102, extrinsic_index: 1, extrinsic_hash: '0x' + '33'.repeat(32), ts: '2026-08-04 10:00:24',
      version: 4, signer: SENDER, success: 1, call_name: 'EVM.call', fee: null, tip: null,
      call_args_json: JSON.stringify(evmCallArgs(UNVERIFIED)), error_json: null, spec_version: 320,
    }],
  ])
  return {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push(opts.query)
      return {
        json: async () => {
          const q = opts.query
          if (q.includes('FROM price_data.contract_abis')) {
            if (q.includes('abi_present')) {
              return [{
                address: VERIFIED, contract_name: 'MockToken', compiler_version: 'v0.8.19',
                match_type: 'FULL', source: 'verified', code_hash: '0xcc',
                verified_at: '2026-08-04 09:00:00.000', abi_present: 1,
              }]
            }
            return [{ abi_json: JSON.stringify(ABI), contract_name: 'MockToken', source: 'verified' }]
          }
          if (q.includes('FROM price_data.contract_sources')) return []
          if (q.includes('FROM price_data.raw_extrinsics e')) {
            const p = opts.query_params as { h: number; i: number }
            const row = extrinsics.get(`${p.h}:${p.i}`)
            return row ? [row] : []
          }
          if (q.includes('FROM price_data.raw_events') && q.includes('extrinsic_index = {index:UInt32}')) {
            return [
              { event_index: 0, event_name: 'EVM.Log', args_json: JSON.stringify(TRANSFER_LOG) },
              { event_index: 1, event_name: 'System.ExtrinsicSuccess', args_json: '{}' },
            ]
          }
          if (q.includes('FROM price_data.raw_events') && q.includes('event_index = {i:UInt32}')) {
            const p = opts.query_params as { h: number; i: number }
            return [{
              block_height: p.h, event_index: p.i, extrinsic_index: null,
              ts: '2026-08-04 10:00:00', event_name: 'EVM.Log', args_json: JSON.stringify(TRANSFER_LOG),
            }]
          }
          throw new Error(`unexpected query: ${q}`)
        },
      }
    },
  } as unknown as ClickHouseClient
}

describe('detail-surface decoding', () => {
  beforeAll(async () => {
    const client = fakeClient()
    initExplorerService(client)
    initContractVerificationService(client)
    await loadVerifiedContracts()
    seen.length = 0
  })

  it('decodes a top-level EVM.call on the extrinsic detail', async () => {
    const detail = await getExtrinsicAt(100, 1)
    expect(detail?.evmCalls).toEqual([
      {
        target: VERIFIED,
        contractName: 'MockToken',
        call: {
          decoded: true,
          name: 'transfer',
          signature: 'transfer(address,uint256)',
          selector: TRANSFER_SELECTOR,
          params: [
            { name: 'to', type: 'address', value: SENDER },
            { name: 'value', type: 'uint256', value: '1000000' },
          ],
        },
      },
    ])
  })

  it('decodes Ethereum.transact calldata and the extrinsic\'s EVM.Log events', async () => {
    const detail = await getExtrinsicAt(101, 1)
    expect(detail?.evmCalls?.[0].call).toMatchObject({ decoded: true, name: 'transfer' })
    const log = detail?.events.find(e => e.name === 'EVM.Log')
    expect(log?.evmDecoded).toMatchObject({
      decoded: true,
      name: 'Transfer',
      decodedBy: 'verified-abi',
    })
    expect(detail?.events.find(e => e.name === 'System.ExtrinsicSuccess')?.evmDecoded).toBeUndefined()
    // The response stays additive: existing fields are untouched.
    expect(detail?.callName).toBe('Ethereum.transact')
    expect(detail?.callArgs).toEqual(transactArgs(VERIFIED))
  })

  it('attaches nothing for an unverified target', async () => {
    const detail = await getExtrinsicAt(102, 1)
    expect(detail?.evmCalls).toBeUndefined()
  })

  it('decodes EVM.Log args on the event detail', async () => {
    const event = await getEventAt(300, 0)
    expect(event?.evmDecoded).toMatchObject({ decoded: true, name: 'Transfer', decodedBy: 'verified-abi' })
    expect(event?.args).toEqual(TRANSFER_LOG)
  })

  it('is page-bounded: one cached ABI read total, no other decode queries', async () => {
    // All prior tests decoded five surfaces across four requests; the ABI was
    // read from ClickHouse exactly once, everything else came from the rows the
    // pages had already fetched.
    expect(seen.filter(q => q.includes('contract_abis') && !q.includes('abi_present'))).toHaveLength(1)
    const allowed = /contract_abis|contract_sources|raw_extrinsics|raw_events/
    expect(seen.filter(q => !allowed.test(q))).toEqual([])
  })

  it('attachEvmLogDecodes enriches list rows in place without extra queries', async () => {
    const before = seen.length
    const rows: { name: string; args: unknown; evmDecoded?: EvmLogDecode }[] = [
      { name: 'EVM.Log', args: TRANSFER_LOG },
      { name: 'EVM.Log', args: { log: { address: UNVERIFIED, topics: [TRANSFER_TOPIC0], data: '0x' } } },
      { name: 'Tokens.Transfer', args: {} },
    ]
    await attachEvmLogDecodes(rows)
    expect(rows[0].evmDecoded).toMatchObject({ decoded: true, name: 'Transfer' })
    expect(rows[1].evmDecoded).toBeUndefined()
    expect(rows[2].evmDecoded).toBeUndefined()
    expect(seen.length).toBe(before)
  })
})
