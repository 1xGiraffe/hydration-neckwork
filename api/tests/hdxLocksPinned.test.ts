import { describe, expect, it, vi } from 'vitest'
import { u8aToHex } from '@polkadot/util'
import type { ClickHouseClient } from '../src/db/client.ts'
import { storagePrefix } from '../src/services/chainPrimitives.ts'

// The hdx-locks cycle reads ~15 storage maps and values. Each must name the
// cycle's ONE pinned block hash — locks, vesting and votes are combined per
// account, so a cycle that straddles blocks can count a lock that was already
// released — and the breakdown generation is stamped with that block.
const PIN = { block: 15_600_000, blockHash: '0x' + 'cd'.repeat(32), indexedHead: 15_600_003, finalizedHead: 15_600_000 }
const readsAt: (string | null | undefined)[] = []

const LOCKS = storagePrefix('Balances', 'Locks')
const VESTING = storagePrefix('Vesting', 'VestingSchedules')
const VOTING = storagePrefix('ConvictionVoting', 'VotingFor')
const RELAY = storagePrefix('ParachainSystem', 'LastRelayChainBlockNumber')
const GIGA_LOCKED = storagePrefix('GigaHdx', 'TotalLocked')
const ISSUANCE = storagePrefix('Tokens', 'TotalIssuance')
const ACCOUNT = 'aa'.repeat(32)
const le = (v: bigint, bytes: number) => { const b = new Uint8Array(bytes); for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn); return u8aToHex(b).slice(2) }

vi.mock('../src/services/substrateRpc.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/substrateRpc.ts')>()),
  substrateAllKeys: async (prefix: string, _p?: number, _s?: number, at?: string | null) => {
    readsAt.push(at)
    if (prefix === LOCKS) return [LOCKS + '00'.repeat(16) + ACCOUNT]
    if (prefix === VESTING) return [VESTING + '00'.repeat(16) + ACCOUNT]
    if (prefix === VOTING) return [VOTING + '00'.repeat(8) + ACCOUNT + '00'.repeat(8) + '0000']
    return []
  },
  substrateStorageBatch: async (keys: string[], at?: string | null) => {
    readsAt.push(at)
    return keys.map(k => {
      if (k.startsWith(LOCKS)) return '0x04' + Buffer.from('pyconvot').toString('hex') + le(10n ** 12n, 16) + '00'
      if (k.startsWith(VESTING)) return '0x00'
      if (k.startsWith(VOTING)) return '0x0000' + '00'.repeat(32 + 4 + 16)
      if (k === RELAY) return '0x' + le(30_000_000n, 4)
      if (k === GIGA_LOCKED) return '0x' + le(1_100n, 16)
      if (k.startsWith(ISSUANCE)) return '0x' + le(1_000n, 16)
      return null
    })
  },
}))
vi.mock('../src/services/pinnedBlock.ts', () => ({ loadPinnedSubstrateBlock: async () => PIN }))
vi.mock('../src/services/blockTime.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/blockTime.ts')>()),
  paraBlockMs: async () => 2_000,
}))
const persisted: { blockHeight: number; relayHeight: number }[] = []
vi.mock('../src/services/lockBreakdownService.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/lockBreakdownService.ts')>()),
  persistLockSnapshot: async (_c: unknown, _rows: unknown, meta: { blockHeight: number; relayHeight: number }) => { persisted.push(meta); return 'republished' },
}))

const { initHdxService, refreshHdxSnapshot } = await import('../src/services/hdxService.ts')

describe('hdx-locks cycle', () => {
  it('reads every map and value at the one pinned hash and stamps the generation with that block', async () => {
    const blockQueries: unknown[] = []
    initHdxService({
      query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
        json: async () => {
          if (query.includes('FROM price_data.blocks WHERE block_height')) { blockQueries.push(query_params?.b); return [{ t: 1_790_000_000, n: 1 }] }
          return []
        },
      }),
    } as unknown as ClickHouseClient)
    await refreshHdxSnapshot()
    // locks, unstakes, vesting, votes (keys + values), relay, rate, switch, and
    // the breakdown's eleven maps — all of them at the pinned hash.
    expect(readsAt.length).toBeGreaterThan(15)
    expect(new Set(readsAt)).toEqual(new Set([PIN.blockHash]))
    expect(blockQueries).toEqual([PIN.block])
    expect(persisted).toEqual([{ blockHeight: PIN.block, relayHeight: 30_000_000 }])
  })
})
