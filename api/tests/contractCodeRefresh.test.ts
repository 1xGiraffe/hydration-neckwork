import { describe, it, expect, vi, beforeEach } from 'vitest'
import { keccakAsHex } from '@polkadot/util-crypto'
import type { ClickHouseClient } from '../src/db/client.ts'

// The snapshot refresher is the only writer of evm_contract_code_snapshot.
// The failures pinned here: a truncated enumeration mass-flagging destruction,
// a planted 0x00 code entering the registry as a contract, and a redeploy
// keeping its stale destroyed flag.
const allKeys = vi.fn<(prefix: string) => Promise<string[]>>()
const storageBatch = vi.fn<(keys: string[]) => Promise<(string | null)[]>>()
vi.mock('../src/services/substrateRpc.ts', () => ({
  substrateAllKeys: (prefix: string) => allKeys(prefix),
  substrateStorageBatch: (keys: string[]) => storageBatch(keys),
}))

const { refreshContractCode, initContractRegistryService } = await import('../src/services/contractRegistryService.ts')

const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const ATOKEN = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
const ASSET_PRECOMPILE = '0x0000000000000000000000000000000100000005'
const PLANTED = '0x1234567890abcdef1234567890abcdef12345678'

const storageKey = (h160: string) => '0x' + 'f'.repeat(96) + h160.slice(2)

type SnapRow = { address: string; kind: string; code_hash: string; code_size: number; destroyed: number }

function fakeClient(prevSnapshot: SnapRow[]) {
  const inserts: { table: string; values: Record<string, unknown>[] }[] = []
  const client = {
    inserts,
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes('evm_contract_code_snapshot')) {
          // The loader's own snapshot read filters to contracts; the refresher
          // reads every kind to know which addresses are already snapshotted.
          if (query.includes("kind = 'contract'")) return prevSnapshot.filter(r => r.kind === 'contract')
          return prevSnapshot
        }
        return []
      },
    }),
    insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => { inserts.push({ table, values }) },
  }
  return client as unknown as ClickHouseClient & { inserts: typeof inserts }
}

const snapshotRows = (client: { inserts: { table: string; values: Record<string, unknown>[] }[] }) =>
  client.inserts.filter(i => i.table === 'price_data.evm_contract_code_snapshot').flatMap(i => i.values)

beforeEach(() => {
  allKeys.mockReset()
  storageBatch.mockReset()
})

describe('refreshContractCode', () => {
  it('keeps the previous snapshot when enumeration throws (truncation) or returns empty', async () => {
    const client = fakeClient([{ address: HOLLAR, kind: 'contract', code_hash: '0xaa', code_size: 3, destroyed: 0 }])
    initContractRegistryService(client)
    allKeys.mockRejectedValueOnce(new Error('state_getKeysPaged failed'))
    await refreshContractCode()
    expect(snapshotRows(client)).toHaveLength(0)

    allKeys.mockResolvedValueOnce([])
    await refreshContractCode()
    expect(snapshotRows(client)).toHaveLength(0)
  })

  it('classifies and hashes newly enumerated addresses, planted 0x00 never becoming a contract', async () => {
    const client = fakeClient([])
    initContractRegistryService(client)
    allKeys.mockResolvedValueOnce([storageKey(HOLLAR), storageKey(ASSET_PRECOMPILE), storageKey(PLANTED)])
    storageBatch.mockResolvedValueOnce(['0x0c600080', '0x0400', '0x0400'])
    await refreshContractCode()
    const rows = snapshotRows(client)
    expect(rows).toHaveLength(3)
    const byAddr = new Map(rows.map(r => [r.address, r]))
    expect(byAddr.get(HOLLAR)).toMatchObject({
      kind: 'contract', code_size: 3, code_hash: keccakAsHex(new Uint8Array([0x60, 0x00, 0x80])), destroyed: 0,
    })
    expect(byAddr.get(ASSET_PRECOMPILE)).toMatchObject({ kind: 'asset-erc20', code_size: 1 })
    expect(byAddr.get(PLANTED)).toMatchObject({ kind: 'planted-unknown', code_size: 1 })
  })

  it('does not refetch code for addresses already snapshotted, and skips new ones whose read failed', async () => {
    const client = fakeClient([{ address: HOLLAR, kind: 'contract', code_hash: '0xaa', code_size: 3, destroyed: 0 }])
    initContractRegistryService(client)
    allKeys.mockResolvedValueOnce([storageKey(HOLLAR), storageKey(ATOKEN)])
    storageBatch.mockImplementationOnce(async keys => {
      // Only the new address is fetched; its read fails this pass.
      expect(keys).toEqual([storageKey(ATOKEN)])
      return [null]
    })
    await refreshContractCode()
    const rows = snapshotRows(client)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ address: HOLLAR, kind: 'contract', code_hash: '0xaa', code_size: 3, destroyed: 0 })
  })

  it('flags addresses absent from a fully successful enumeration as destroyed, preserving code identity', async () => {
    const client = fakeClient([
      { address: HOLLAR, kind: 'contract', code_hash: '0xaa', code_size: 3, destroyed: 0 },
      { address: ATOKEN, kind: 'contract', code_hash: '0xbb', code_size: 9, destroyed: 0 },
    ])
    initContractRegistryService(client)
    allKeys.mockResolvedValueOnce([storageKey(HOLLAR)])
    storageBatch.mockResolvedValue([])
    await refreshContractCode()
    const rows = snapshotRows(client)
    const gone = rows.find(r => r.address === ATOKEN)
    expect(gone).toMatchObject({ kind: 'contract', code_hash: '0xbb', code_size: 9, destroyed: 1 })
  })

  it('flips a destroyed address back with a fresh code hash on redeploy', async () => {
    const client = fakeClient([{ address: ATOKEN, kind: 'contract', code_hash: '0xbb', code_size: 9, destroyed: 1 }])
    initContractRegistryService(client)
    allKeys.mockResolvedValueOnce([storageKey(ATOKEN)])
    storageBatch.mockResolvedValueOnce(['0x0c600080'])
    await refreshContractCode()
    const rows = snapshotRows(client)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      address: ATOKEN, kind: 'contract', code_size: 3,
      code_hash: keccakAsHex(new Uint8Array([0x60, 0x00, 0x80])), destroyed: 0,
    })
  })
})
