import { describe, it, expect } from 'vitest'
import {
  buildContractRegistry, pageContracts, deployerWhitelistFromEvents,
  initContractRegistryService, loadContractRegistry,
  contractByH160, isContractAccount, allContracts,
  type ContractRegistryInputs, type ContractRegistryEntry,
} from '../src/services/contractRegistryService.ts'
import { accountRef, getContracts } from '../src/services/explorerService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const ATOKEN = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const FACTORY = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
const DEPLOYER = '0x45544800aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000'

const snap = (address: string, destroyed = 0) =>
  ({ address, kind: 'contract', code_hash: '0x' + 'ab'.repeat(32), code_size: 100, destroyed })

function inputs(over: Partial<ContractRegistryInputs> = {}): ContractRegistryInputs {
  return {
    snapshot: [], creates: [], createExecuted: [],
    executedStats: [], palletCallStats: [], logStats: [], firstLogExecuted: [],
    deployerWhitelist: new Set(),
    ...over,
  }
}

// The registry merge is the single source of contract identity for the
// directory, the account page and the tag — it must join creations by chain
// evidence only, never invent a deployer, and stay exact under replayed rows.
describe('buildContractRegistry', () => {
  it('joins a successful create to its Ethereum.Executed row (Succeed only)', () => {
    const { entries, warnings } = buildContractRegistry(inputs({
      snapshot: [snap(HOLLAR)],
      creates: [{ block_height: 100, extrinsic_index: 2, block_timestamp: '2024-01-01 00:00:00', deployer: DEPLOYER, success: 1 }],
      createExecuted: [{ to_address: HOLLAR, block_height: 100, extrinsic_index: 2, tx_hash: '0xabc', exit_kind: 'Succeed', block_timestamp: '2024-01-01 00:00:00' }],
    }))
    const entry = entries.get(HOLLAR)!
    expect(entry.creation).toEqual({
      method: 'create', deployer: DEPLOYER, deployerWhitelisted: false,
      blockHeight: 100, extrinsicIndex: 2, timestamp: '2024-01-01 00:00:00', txHash: '0xabc',
    })
    expect(warnings).toEqual([])
  })

  it('ignores creates whose Executed exit is not Succeed or whose extrinsic failed', () => {
    const { entries, warnings } = buildContractRegistry(inputs({
      snapshot: [snap(HOLLAR)],
      creates: [
        { block_height: 200, extrinsic_index: 1, block_timestamp: '2024-01-02 00:00:00', deployer: DEPLOYER, success: 1 },
        { block_height: 201, extrinsic_index: 1, block_timestamp: '2024-01-02 00:01:00', deployer: DEPLOYER, success: 0 },
      ],
      createExecuted: [
        { to_address: HOLLAR, block_height: 200, extrinsic_index: 1, tx_hash: '0xdead', exit_kind: 'Reverted', block_timestamp: '2024-01-02 00:00:00' },
        { to_address: HOLLAR, block_height: 201, extrinsic_index: 1, tx_hash: '0xbeef', exit_kind: 'Succeed', block_timestamp: '2024-01-02 00:01:00' },
      ],
    }))
    expect(entries.get(HOLLAR)!.creation).toEqual({ method: 'unknown' })
    // A reverted create is not a conservation violation.
    expect(warnings).toEqual([])
  })

  it('warns (and never synthesizes a row) when a successful create is missing from the snapshot', () => {
    const { entries, warnings } = buildContractRegistry(inputs({
      creates: [{ block_height: 300, extrinsic_index: 0, block_timestamp: '2024-01-03 00:00:00', deployer: DEPLOYER, success: 1 }],
      createExecuted: [{ to_address: ATOKEN, block_height: 300, extrinsic_index: 0, tx_hash: '0xfeed', exit_kind: 'Succeed', block_timestamp: '2024-01-03 00:00:00' }],
    }))
    expect(entries.size).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(ATOKEN)
  })

  it('marks the whitelisted deployer annotation from the reconstructed ContractDeployer set', () => {
    const { entries } = buildContractRegistry(inputs({
      snapshot: [snap(HOLLAR)],
      creates: [{ block_height: 100, extrinsic_index: 2, block_timestamp: '2024-01-01 00:00:00', deployer: DEPLOYER, success: 1 }],
      createExecuted: [{ to_address: HOLLAR, block_height: 100, extrinsic_index: 2, tx_hash: '0xabc', exit_kind: 'Succeed', block_timestamp: '2024-01-01 00:00:00' }],
      deployerWhitelist: new Set(['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
    }))
    const creation = entries.get(HOLLAR)!.creation
    expect(creation.method).toBe('create')
    expect(creation.method === 'create' && creation.deployerWhitelisted).toBe(true)
  })

  it('attributes factory children from the first log, labelled first-log', () => {
    const { entries } = buildContractRegistry(inputs({
      snapshot: [snap(ATOKEN)],
      logStats: [{ address: ATOKEN, c: 7, first_ts: '2024-02-01 00:00:00', last_ts: '2024-03-01 00:00:00', first_block: 500 }],
      firstLogExecuted: [{ address: ATOKEN, to_address: FACTORY, tx_hash: '0xdef', block_height: 500, block_timestamp: '2024-02-01 00:00:00' }],
    }))
    expect(entries.get(ATOKEN)!.creation).toEqual({
      method: 'factory', factory: FACTORY, attribution: 'first-log',
      blockHeight: 500, timestamp: '2024-02-01 00:00:00', txHash: '0xdef',
    })
  })

  it('keeps method unknown when the first-log tx targeted the contract itself, or when no evidence exists', () => {
    const { entries } = buildContractRegistry(inputs({
      snapshot: [snap(ATOKEN), snap(HOLLAR)],
      logStats: [{ address: ATOKEN, c: 1, first_ts: '2024-02-01 00:00:00', last_ts: '2024-02-01 00:00:00', first_block: 500 }],
      // to == self: the contract already existed when it first logged.
      firstLogExecuted: [{ address: ATOKEN, to_address: ATOKEN, tx_hash: '0xdef', block_height: 500, block_timestamp: '2024-02-01 00:00:00' }],
    }))
    expect(entries.get(ATOKEN)!.creation).toEqual({ method: 'unknown' })
    expect(entries.get(HOLLAR)!.creation).toEqual({ method: 'unknown' })
  })

  it('keeps destroyed contracts in the registry, flagged', () => {
    const { entries } = buildContractRegistry(inputs({ snapshot: [snap(ATOKEN, 1)] }))
    expect(entries.get(ATOKEN)!.destroyed).toBe(true)
  })

  it('merges tx/log counts and activity bounds across the three sources', () => {
    const { entries } = buildContractRegistry(inputs({
      snapshot: [snap(HOLLAR)],
      executedStats: [{ address: HOLLAR, c: 3, first_ts: '2024-01-01 00:00:00', last_ts: '2024-01-02 00:00:00' }],
      palletCallStats: [{ address: HOLLAR, c: 2, first_ts: '2024-01-03 00:00:00', last_ts: '2024-01-05 00:00:00' }],
      logStats: [{ address: HOLLAR, c: 7, first_ts: '2024-01-01 12:00:00', last_ts: '2024-01-04 00:00:00', first_block: 10 }],
    }))
    const e = entries.get(HOLLAR)!
    expect(e.txCount).toBe(5)
    expect(e.logCount).toBe(7)
    expect(e.firstActivity).toBe('2024-01-01 00:00:00')
    expect(e.lastActivity).toBe('2024-01-05 00:00:00')
  })

  it('leaves counts and creations unchanged under replay-duplicated inputs', () => {
    const base = inputs({
      snapshot: [snap(HOLLAR)],
      creates: [{ block_height: 100, extrinsic_index: 2, block_timestamp: '2024-01-01 00:00:00', deployer: DEPLOYER, success: 1 }],
      createExecuted: [{ to_address: HOLLAR, block_height: 100, extrinsic_index: 2, tx_hash: '0xabc', exit_kind: 'Succeed', block_timestamp: '2024-01-01 00:00:00' }],
      executedStats: [{ address: HOLLAR, c: 3, first_ts: '2024-01-01 00:00:00', last_ts: '2024-01-02 00:00:00' }],
    })
    const doubled = inputs({
      snapshot: [...base.snapshot, ...base.snapshot],
      creates: [...base.creates, ...base.creates],
      createExecuted: [...base.createExecuted, ...base.createExecuted],
      executedStats: [...base.executedStats, ...base.executedStats],
    })
    const a = buildContractRegistry(base)
    const b = buildContractRegistry(doubled)
    expect([...b.entries.entries()]).toEqual([...a.entries.entries()])
    expect(b.warnings).toEqual(a.warnings)
  })
})

describe('deployerWhitelistFromEvents', () => {
  it('applies adds and removes in order', () => {
    const set = deployerWhitelistFromEvents([
      { event_name: 'EVMAccounts.DeployerAdded', who: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { event_name: 'EVMAccounts.DeployerAdded', who: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { event_name: 'EVMAccounts.DeployerRemoved', who: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ])
    expect(set).toEqual(new Set(['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']))
  })
})

describe('pageContracts', () => {
  const entry = (address: string, over: Partial<ContractRegistryEntry> = {}): ContractRegistryEntry => ({
    address, codeHash: '0x00', codeSize: 1, destroyed: false,
    creation: { method: 'unknown' }, txCount: 0, logCount: 0, firstActivity: null, lastActivity: null,
    ...over,
  })
  const a = entry('0x' + 'aa'.repeat(20), { txCount: 5, logCount: 1, lastActivity: '2024-01-01 00:00:00', creation: { method: 'create', deployer: null, deployerWhitelisted: false, blockHeight: 10, extrinsicIndex: 0, timestamp: '2023-01-01 00:00:00', txHash: '0x1' } })
  const b = entry('0x' + 'bb'.repeat(20), { txCount: 5, logCount: 9, lastActivity: '2024-06-01 00:00:00', creation: { method: 'factory', factory: '0x' + 'cc'.repeat(20), attribution: 'first-log', blockHeight: 20, timestamp: '2023-06-01 00:00:00', txHash: '0x2' } })
  const c = entry('0x' + 'cc'.repeat(20), { txCount: 2, logCount: 3 })

  it('sorts by tx count with a deterministic address-asc tiebreak', () => {
    const { rows, total } = pageContracts([c, b, a], 0, 10, 'txs')
    expect(rows.map(r => r.address)).toEqual([a.address, b.address, c.address])
    expect(total).toBe(3)
  })

  it('sorts created (newest first, unknown last) and active (latest first, never-active last)', () => {
    expect(pageContracts([a, b, c], 0, 10, 'created').rows.map(r => r.address)).toEqual([b.address, a.address, c.address])
    expect(pageContracts([a, b, c], 0, 10, 'active').rows.map(r => r.address)).toEqual([b.address, a.address, c.address])
    expect(pageContracts([a, b, c], 0, 10, 'logs').rows.map(r => r.address)).toEqual([b.address, c.address, a.address])
  })

  it('slices offset/limit while reporting the full total', () => {
    const { rows, total } = pageContracts([a, b, c], 1, 1, 'txs')
    expect(rows.map(r => r.address)).toEqual([b.address])
    expect(total).toBe(3)
  })
})

// End-to-end load: the five bounded queries land in the accessors, and the
// contract flag answers in BOTH address forms (H160 and ETH-prefixed
// truncated AccountId32) so accountRef can flag any list row for free.
describe('loadContractRegistry + accessors', () => {
  const truncated = '0x45544800531a654d1696ed52e7275a8cede955e82620f99a0000000000000000'

  function fakeClient(): ClickHouseClient {
    return {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes('evm_contract_code_snapshot')) {
            return [{ address: HOLLAR, kind: 'contract', code_hash: '0x' + 'ab'.repeat(32), code_size: 10719, destroyed: 0 }]
          }
          if (query.includes('evm_create_transactions FINAL')) {
            return [{ block_height: 100, extrinsic_index: 2, block_timestamp: '2024-01-01 00:00:00', deployer: DEPLOYER, success: 1 }]
          }
          if (query.includes('SELECT DISTINCT to_address')) {
            return [{ to_address: HOLLAR, block_height: 100, extrinsic_index: 2, tx_hash: '0xabc', exit_kind: 'Succeed', block_timestamp: '2024-01-01 00:00:00' }]
          }
          if (query.includes('FROM price_data.evm_executed') && query.includes('uniqExact')) {
            return [{ address: HOLLAR, c: 42, first_ts: '2024-01-01 00:00:00', last_ts: '2024-05-01 00:00:00' }]
          }
          if (query.includes('evm_pallet_calls')) {
            return [{ address: HOLLAR, c: 8, first_ts: '2024-02-01 00:00:00', last_ts: '2024-06-01 00:00:00' }]
          }
          if (query.includes('evm_contract_log_stats')) {
            return [{ address: HOLLAR, c: 900, first_ts: '2024-01-01 00:00:00', last_ts: '2024-05-15 00:00:00', first_block: 100 }]
          }
          if (query.includes('DeployerAdded')) return []
          throw new Error(`Unexpected query: ${query}`)
        },
      }),
    } as unknown as ClickHouseClient
  }

  it('loads the registry and answers accessors in both address forms', async () => {
    initContractRegistryService(fakeClient())
    await loadContractRegistry()
    expect(allContracts()).toHaveLength(1)
    const entry = contractByH160(HOLLAR)!
    expect(entry.txCount).toBe(50)
    expect(entry.creation.method).toBe('create')
    expect(isContractAccount(HOLLAR)).toBe(true)
    expect(isContractAccount(truncated)).toBe(true)
    expect(isContractAccount('0x' + 'aa'.repeat(20))).toBe(false)
  })

  it('flags accountRef for contract accounts and leaves others untouched', async () => {
    initContractRegistryService(fakeClient())
    await loadContractRegistry()
    expect(accountRef(truncated).isContract).toBe(true)
    // A random substrate account and a non-contract EVM account stay unflagged.
    expect(accountRef('0x' + '11'.repeat(32)).isContract).toBeUndefined()
    expect(accountRef('0x45544800' + 'aa'.repeat(20) + '0000000000000000').isContract).toBeUndefined()
  })

  it('serves directory rows with account refs, creation evidence and null verification', async () => {
    initContractRegistryService(fakeClient())
    await loadContractRegistry()
    const { contracts, total } = getContracts(0, 10, 'txs')
    expect(total).toBe(1)
    const row = contracts[0]
    expect(row.address).toBe(HOLLAR)
    expect(row.account.isContract).toBe(true)
    expect(row.account.address).toBe(HOLLAR)   // contract pills display the H160
    expect(row.verified).toBeNull()
    expect(row.verification).toBeNull()
    expect(row.creation.method).toBe('create')
    expect(row.creation.deployer?.accountId).toBe(DEPLOYER)
    expect(row.creation.txHash).toBe('0xabc')
    expect(row).toMatchObject({ codeSize: 10719, destroyed: false, txCount: 50, logCount: 900 })
  })
})
