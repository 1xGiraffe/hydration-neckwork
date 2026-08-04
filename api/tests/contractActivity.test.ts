import { describe, it, expect, beforeAll } from 'vitest'
import {
  initExplorerService,
  getContractTransactions,
  getContractEvents,
} from '../src/services/explorerService.ts'
import {
  initContractRegistryService,
  loadContractRegistry,
} from '../src/services/contractRegistryService.ts'
import {
  initContractVerificationService,
  loadVerifiedContracts,
} from '../src/services/contractVerificationService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const CONTRACT = '0x00000000000000000000000000000000000000c1'
const CALLER = '0x4b0540d29f19b2da4cce2b1ba6b6325dd9d86622'

const TRANSFER_SELECTOR = '0xa9059cbb'
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')

const ABI = [
  { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }] },
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

// The contract's transactions view pages evm_executed by to_address (a
// primary-key prefix), dedupes replays by grouping on the row identity in SQL,
// and enriches only the page's own extrinsics with their input selector.
const seen: { query: string; params: Record<string, unknown> | undefined }[] = []

function fakeClient(): ClickHouseClient {
  return {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query: opts.query, params: opts.query_params })
      return {
        json: async () => {
          const q = opts.query
          // --- registry load ---
          if (q.includes('evm_contract_code_snapshot')) {
            return [{ address: CONTRACT, kind: 'contract', code_hash: '0x' + 'ab'.repeat(32), code_size: 100, destroyed: 0 }]
          }
          if (q.includes('evm_create_transactions FINAL')) return []
          if (q.includes('SELECT DISTINCT to_address')) return []
          if (q.includes('GROUP BY to_address')) {
            return [{ address: CONTRACT, c: 7, first_ts: '2026-01-01 00:00:00', last_ts: '2026-08-01 00:00:00' }]
          }
          if (q.includes('evm_pallet_calls')) return []
          if (q.includes('evm_contract_log_stats')) {
            return [{ address: CONTRACT, c: 12, first_ts: '2026-01-01 00:00:00', last_ts: '2026-08-01 00:00:00', first_block: 100 }]
          }
          if (q.includes('DeployerAdded')) return []
          // --- verified map ---
          if (q.includes('FROM price_data.contract_abis')) {
            if (q.includes('abi_present')) {
              return [{
                address: CONTRACT, contract_name: 'MockToken', compiler_version: 'v0.8.19',
                match_type: 'FULL', source: 'verified', code_hash: '0xcc',
                verified_at: '2026-08-04 09:00:00.000', abi_present: 1,
              }]
            }
            return [{ abi_json: JSON.stringify(ABI), contract_name: 'MockToken', source: 'verified' }]
          }
          if (q.includes('FROM price_data.contract_sources')) return []
          // --- transactions page ---
          if (q.includes('FROM price_data.evm_executed') && q.includes('uniqExact')) {
            return [{ c: 7 }]
          }
          if (q.includes('FROM price_data.evm_executed')) {
            return [
              {
                block_height: 200, event_index: 5, extrinsic_index: 2, ts: '2026-08-04 10:00:00',
                tx_hash: '0x' + 'aa'.repeat(32), from_address: CALLER, exit_kind: 'Succeed',
              },
              {
                block_height: 199, event_index: 1, extrinsic_index: 1, ts: '2026-08-04 09:59:48',
                tx_hash: '0x' + 'bb'.repeat(32), from_address: CALLER, exit_kind: 'Reverted',
              },
            ]
          }
          if (q.includes('FROM price_data.raw_extrinsics')) {
            return [
              { block_height: 200, extrinsic_index: 2, call_name: 'Ethereum.transact', input_prefix: TRANSFER_SELECTOR },
              { block_height: 199, extrinsic_index: 1, call_name: 'Ethereum.transact', input_prefix: '0xdeadbeef' },
            ]
          }
          // --- events pages ---
          if (q.includes('FROM price_data.raw_evm_logs') && !q.includes('topics')) {
            return [
              { block_height: 200, event_index: 4 },
              { block_height: 198, event_index: 3 },
              { block_height: 197, event_index: 9 },
            ]
          }
          if (q.includes('FROM price_data.raw_evm_logs')) {
            return [
              {
                block_height: 200, event_index: 4, extrinsic_index: 2, ts: '2026-08-04 10:00:00',
                topics: [TRANSFER_TOPIC0, `0x${word(CALLER)}`, `0x${word(CONTRACT)}`], data: `0x${word('f4240')}`,
                decode_status: 'undecoded', event_name: null, decoded_args_json: '{}',
              },
              {
                block_height: 198, event_index: 3, extrinsic_index: 1, ts: '2026-08-04 09:59:36',
                topics: ['0x' + '11'.repeat(32)], data: '0x',
                decode_status: 'decoded', event_name: 'Borrow', decoded_args_json: JSON.stringify({ reserve: CONTRACT, amount: '5' }),
              },
              {
                block_height: 197, event_index: 9, extrinsic_index: null, ts: '2026-08-04 09:59:24',
                topics: ['0x' + '22'.repeat(32)], data: '0x1234',
                decode_status: 'undecoded', event_name: null, decoded_args_json: '{}',
              },
            ]
          }
          throw new Error(`unexpected query: ${q}`)
        },
      }
    },
  } as unknown as ClickHouseClient
}

describe('contract activity pages', () => {
  beforeAll(async () => {
    const client = fakeClient()
    initExplorerService(client)
    initContractRegistryService(client)
    initContractVerificationService(client)
    await loadContractRegistry()
    await loadVerifiedContracts()
    seen.length = 0
  })

  it('returns null for an address that is not a registered contract', async () => {
    expect(await getContractTransactions('0x' + '99'.repeat(20), 0, 25)).toBeNull()
    expect(await getContractEvents('0x' + '99'.repeat(20), 0, 25)).toBeNull()
  })

  it('pages transactions with decoded method chips and account refs', async () => {
    const page = await getContractTransactions(CONTRACT, 0, 25)
    expect(page?.total).toBe(7)
    expect(page?.transactions).toHaveLength(2)
    const [first, second] = page!.transactions
    expect(first).toMatchObject({
      blockHeight: 200,
      extrinsicIndex: 2,
      timestamp: '2026-08-04 10:00:00',
      txHash: '0x' + 'aa'.repeat(32),
      success: true,
      method: { selector: TRANSFER_SELECTOR, name: 'transfer', signature: 'transfer(address,uint256)' },
    })
    expect(first.from?.address).toBeTruthy()
    // Unknown selector on a verified contract: selector-only fallback, no guess.
    expect(second.success).toBe(false)
    expect(second.method).toEqual({ selector: '0xdeadbeef', name: null, signature: null })
  })

  it('keys the page reads by the contract and dedupes replays in SQL', async () => {
    const pageQueries = seen.filter(s => s.query.includes('FROM price_data.evm_executed') && !s.query.includes('uniqExact'))
    expect(pageQueries.length).toBeGreaterThan(0)
    for (const { query, params } of pageQueries) {
      expect(query).toContain('to_address = {address:String}')
      expect(query).toContain('GROUP BY block_height, event_index')
      expect(params).toMatchObject({ address: CONTRACT, limit: 25, offset: 0 })
    }
    const enrich = seen.filter(s => s.query.includes('FROM price_data.raw_extrinsics'))
    for (const { query } of enrich) {
      expect(query).toContain('(block_height, extrinsic_index) IN')
    }
  })

  it('pages events with verified-abi decodes, ingest fallback, and raw remainder', async () => {
    const page = await getContractEvents(CONTRACT, 0, 25)
    // Total comes from the registry's replay-safe bitmap count, not a scan.
    expect(page?.total).toBe(12)
    expect(page?.events).toHaveLength(3)
    const [verified, ingest, raw] = page!.events
    expect(verified).toMatchObject({
      blockHeight: 200,
      eventIndex: 4,
      name: 'Transfer',
      decodedBy: 'verified-abi',
    })
    expect(verified.evmDecoded).toMatchObject({ decoded: true, name: 'Transfer' })
    expect(ingest).toMatchObject({
      blockHeight: 198,
      name: 'Borrow',
      decodedBy: 'ingest',
      args: { reserve: CONTRACT, amount: '5' },
    })
    expect(ingest.evmDecoded).toBeUndefined()
    expect(raw).toMatchObject({ blockHeight: 197, name: null, topics: ['0x' + '22'.repeat(32)], data: '0x1234' })
    expect(raw.decodedBy).toBeUndefined()
  })

  it('walks pages key-first: identities by contract, payload by primary key', async () => {
    const idQueries = seen.filter(s => s.query.includes('FROM price_data.raw_evm_logs') && !s.query.includes('topics'))
    expect(idQueries.length).toBeGreaterThan(0)
    for (const { query, params } of idQueries) {
      expect(query).toContain('contract_address = {address:String}')
      expect(query).toContain('GROUP BY block_height, event_index')
      expect(params).toMatchObject({ address: CONTRACT })
    }
    const payload = seen.filter(s => s.query.includes('FROM price_data.raw_evm_logs') && s.query.includes('topics'))
    for (const { query } of payload) {
      expect(query).toContain('(block_height, event_index) IN')
    }
    // No count scan over raw_evm_logs at all.
    expect(seen.filter(s => s.query.includes('raw_evm_logs') && s.query.includes('uniqExact'))).toEqual([])
  })

  it('serves repeated pages from cache and reads the ABI only once overall', async () => {
    const before = seen.length
    await getContractTransactions(CONTRACT, 0, 25)
    await getContractEvents(CONTRACT, 0, 25)
    expect(seen.length).toBe(before)
    expect(seen.filter(s => s.query.includes('contract_abis') && !s.query.includes('abi_present'))).toHaveLength(1)
  })
})
