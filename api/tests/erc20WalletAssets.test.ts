import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CATCHUP_BUCKET_BLOCKS,
  CATCHUP_INSERT_SQL,
  CATCHUP_MAX_BUCKETS_PER_CYCLE,
  DESIRED_WALLET_CONTRACTS_SQL,
  TRANSFER_DELTAS_MV_CONTRACT_FILTER,
  TRANSFER_DELTAS_PROJECTION,
  TRANSFER_DELTAS_ROW_FILTER,
  catchUpPlan,
  walletContractChanges,
} from '../src/services/erc20WalletService.ts'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const tables = read('../../clickhouse/schema/001_tables.sql')
const materializedViews = read('../../clickhouse/schema/003_materialized_views.sql')
const accountBalances = read('../src/public/services/accountBalances.ts')
const explorerService = read('../src/services/explorerService.ts')

const deltasMv = materializedViews
  .split('\n')
  .find(line => line.startsWith('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.erc20_transfer_deltas_mv ')) ?? ''

// An `Erc20`-kind registry asset is settled in its contract, not orml_tokens, so
// nothing about it reaches account_asset_latest_balances. Its holders exist only
// where three things agree: erc20_transfer_deltas_mv captures the contract's
// Transfer logs, erc20WalletService reads that holder set and publishes balances,
// and every account surface asks for the asset. They used to agree through three
// hand-kept lists — and four Gamma vault shares registered on 2026-10-01 read as an
// unremarkable zero everywhere until all three were edited. The set is now DERIVED
// once (erc20_wallet_contracts) and every one of the three reads it; these tests pin
// that mechanism, so no list can creep back.
describe('ERC-20-backed wallet assets: one derived set', () => {
  it('declares the set table ahead of the MV that reads it', () => {
    expect(tables).toMatch(/CREATE TABLE IF NOT EXISTS price_data\.erc20_wallet_contracts \(`contract` String, `asset_id` UInt32, `active` UInt8, `updated_at` DateTime DEFAULT now\(\)\) ENGINE = ReplacingMergeTree\(updated_at\) ORDER BY contract/)
  })

  it('filters the transfer-deltas MV by the set table, with the shared projection', () => {
    // The catch-up insert reuses these exact strings; an MV that drifted from them
    // would decode a backfilled Transfer differently from a live one.
    expect(deltasMv).toContain(` AS ${TRANSFER_DELTAS_PROJECTION} WHERE ${TRANSFER_DELTAS_MV_CONTRACT_FILTER} AND ${TRANSFER_DELTAS_ROW_FILTER};`)
    expect(deltasMv, 'no hand-listed contract may return to the MV').not.toMatch(/'0x[0-9a-f]{40}'/)
    // NULL-safe on raw_evm_logs: a topic0-only log carries event_name NULL, and the
    // comparison drops it (WHERE treats NULL as false) — nothing Nullable reaches an
    // ordinary column, which would fail every raw insert.
    expect(TRANSFER_DELTAS_ROW_FILTER).toContain("(event_name = 'Transfer')")
  })

  it('derives the set from the registry, minus every aToken, both ways', () => {
    expect(DESIRED_WALLET_CONTRACTS_SQL).toContain("FROM price_data.assets FINAL\n  WHERE evm_address != '' AND lower(evm_address) NOT IN (SELECT lower(atoken) FROM price_data.atoken_reserve_map)")
    // AToken Initialized(address,address,address,address,uint8,string,string,bytes):
    // emitted once by every aToken (GIGAHDX included), by nothing else in the set.
    expect(DESIRED_WALLET_CONTRACTS_SQL).toContain("topic0 = '0xb19e051f8af41150ccccb3fc2c2d8d15f4a4cf434f32a559ba75fe73d6eea20b'")
  })

  it('leaves no restated asset list on any surface', () => {
    expect(accountBalances).not.toMatch(/const ERC20_WALLET_ASSET_IDS = \[/)
    expect(accountBalances).toContain('FROM price_data.erc20_wallet_contracts FINAL WHERE active = 1')
    expect(explorerService).not.toMatch(/ERC20_WALLET_ASSET/)
  })
})

describe('walletContractChanges', () => {
  const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
  const VAULT = '0x18542081631cc92cbeb73c8bf45d2f74bd46bb8e'

  it('activates a newly registered contract and writes nothing for an unchanged one', () => {
    const current = [{ contract: HOLLAR, asset_id: '222', active: 1 }]
    expect(walletContractChanges([{ asset_id: '222', contract: HOLLAR }, { asset_id: 1001359, contract: VAULT.toUpperCase().replace('0X', '0x') }], current))
      .toEqual([{ contract: VAULT, asset_id: 1001359, active: 1 }])
    expect(walletContractChanges([{ asset_id: 222, contract: HOLLAR }], current)).toEqual([])
  })

  it('deactivates a contract that left the set, never deletes it, and re-activates it', () => {
    const current = [{ contract: HOLLAR, asset_id: 222, active: 1 }, { contract: VAULT, asset_id: 1001359, active: 1 }]
    expect(walletContractChanges([{ asset_id: 222, contract: HOLLAR }], current))
      .toEqual([{ contract: VAULT, asset_id: 1001359, active: 0 }])
    expect(walletContractChanges([{ asset_id: 1001359, contract: VAULT }], [{ contract: VAULT, asset_id: 1001359, active: 0 }]))
      .toEqual([{ contract: VAULT, asset_id: 1001359, active: 1 }])
  })

  it('re-points a contract whose asset id changed and keeps the lower id on a duplicate', () => {
    expect(walletContractChanges([{ asset_id: 7, contract: VAULT }], [{ contract: VAULT, asset_id: 9, active: 1 }]))
      .toEqual([{ contract: VAULT, asset_id: 7, active: 1 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(walletContractChanges([{ asset_id: 9, contract: VAULT }, { asset_id: 7, contract: VAULT }], []))
      .toEqual([{ contract: VAULT, asset_id: 7, active: 1 }])
    warn.mockRestore()
  })
})

describe('transfer-deltas catch-up', () => {
  it('inserts only keys the log index has and the deltas lack, from the MV projection', () => {
    expect(CATCHUP_INSERT_SQL.startsWith(`INSERT INTO price_data.erc20_transfer_deltas ${TRANSFER_DELTAS_PROJECTION}\n`)).toBe(true)
    expect(CATCHUP_INSERT_SQL).toMatch(/\(block_height, event_index\) IN \(\s*SELECT block_height, event_index FROM price_data\.evm_logs_by_contract/)
    expect(CATCHUP_INSERT_SQL).toMatch(/\(block_height, event_index\) NOT IN \(\s*SELECT block_height, event_index FROM price_data\.erc20_transfer_deltas/)
    expect(CATCHUP_INSERT_SQL).toContain(`AND ${TRANSFER_DELTAS_ROW_FILTER}`)
  })

  it('plans oldest buckets first under the per-cycle cap', () => {
    const { plan, truncated } = catchUpPlan([{ contract: '0xa', buckets: [152] }, { contract: '0xb', buckets: [92, 93] }], 2)
    expect(plan).toEqual([
      { contract: '0xa', lo: 152 * CATCHUP_BUCKET_BLOCKS, hi: 153 * CATCHUP_BUCKET_BLOCKS - 1 },
      { contract: '0xb', lo: 92 * CATCHUP_BUCKET_BLOCKS, hi: 93 * CATCHUP_BUCKET_BLOCKS - 1 },
    ])
    expect(truncated).toBe(true)
    expect(catchUpPlan([{ contract: '0xa', buckets: [1] }]).truncated).toBe(false)
    expect(CATCHUP_MAX_BUCKETS_PER_CYCLE).toBeGreaterThan(0)
  })

  describe('syncTransferDeltas', () => {
    beforeEach(() => { vi.resetModules() })

    // A fake whose deltas side gains what the insert wrote, so a second pass sees
    // the gap closed — the idempotence a re-run must have.
    function fake(rawByBucket: Record<number, number>) {
      const deltas: Record<number, number> = {}
      const commands: Record<string, unknown>[] = []
      const rows = (r: unknown[]) => ({ json: async () => r })
      const client = {
        query: async ({ query }: { query: string }) => {
          if (query.includes('-- erc20:catchup:totals')) {
            const raw = Object.values(rawByBucket).reduce((a, b) => a + b, 0)
            const got = Object.values(deltas).reduce((a, b) => a + b, 0)
            return rows(raw > got ? [{ contract: '0xv', raw_n: raw, delta_n: got }] : [])
          }
          if (query.includes('-- erc20:catchup:buckets')) {
            return rows(Object.entries(rawByBucket).filter(([b, n]) => n > (deltas[Number(b)] ?? 0)).map(([b]) => ({ bucket: Number(b) })))
          }
          throw new Error(`unexpected query ${query.slice(0, 60)}`)
        },
        command: async (c: { query: string; query_params: { lo: number } }) => {
          commands.push(c.query_params)
          const b = c.query_params.lo / CATCHUP_BUCKET_BLOCKS
          deltas[b] = rawByBucket[b]
        },
      }
      return { client, commands }
    }

    it('fills a missing bucket once and then finds nothing to do', async () => {
      const mod = await import('../src/services/erc20WalletService.ts')
      const { client, commands } = fake({ 152: 3 })
      mod.initErc20WalletService(client as never)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await mod.syncTransferDeltas([{ assetId: 1001359, contract: '0xv' }])
      expect(commands).toEqual([{ c: '0xv', lo: 15_200_000, hi: 15_299_999 }])
      // Within the recheck window nothing is re-read; past it the check runs and
      // inserts nothing, because the gap is closed.
      await mod.syncTransferDeltas([{ assetId: 1001359, contract: '0xv' }])
      vi.useFakeTimers({ now: Date.now() + mod.CATCHUP_RECHECK_MS + 1 })
      await mod.syncTransferDeltas([{ assetId: 1001359, contract: '0xv' }])
      vi.useRealTimers()
      expect(commands).toHaveLength(1)
      log.mockRestore()
    })

    it('re-checks at once when the set changes', async () => {
      const mod = await import('../src/services/erc20WalletService.ts')
      const { client, commands } = fake({ 150: 1 })
      mod.initErc20WalletService(client as never)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      await mod.syncTransferDeltas([{ assetId: 1, contract: '0xv' }])
      await mod.syncTransferDeltas([{ assetId: 1, contract: '0xv' }, { assetId: 2, contract: '0xw' }])
      expect(commands).toHaveLength(1) // the second pass ran its totals read and found the gap closed
      log.mockRestore()
    })
  })

  describe('syncWalletContracts', () => {
    beforeEach(() => { vi.resetModules() })

    function fake(reserveMapRows: number, desired: unknown[], current: unknown[]) {
      const inserts: unknown[] = []
      const rows = (r: unknown[]) => ({ json: async () => r })
      const client = {
        query: async ({ query }: { query: string }) => {
          if (query.includes('-- erc20:wallet-contracts:reserve-map')) return rows([{ n: reserveMapRows }])
          if (query.includes('-- erc20:wallet-contracts:desired')) return rows(desired)
          if (query.includes('-- erc20:wallet-contracts:current')) return rows(current)
          throw new Error('unexpected query')
        },
        insert: async ({ values }: { values: unknown[] }) => { inserts.push(...values) },
      }
      return { client, inserts }
    }

    it('writes a newly registered contract and serves it as an active wallet asset', async () => {
      const mod = await import('../src/services/erc20WalletService.ts')
      const VAULT = '0x2d608c585d19866871aeeb22589b5c4867f2c2ad'
      const { client, inserts } = fake(31, [{ asset_id: 1001360, contract: VAULT }], [{ contract: VAULT, asset_id: 1001360, active: 1 }])
      mod.initErc20WalletService(client as never)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      expect(await mod.syncWalletContracts()).toEqual([{ assetId: 1001360, contract: VAULT }])
      expect(inserts).toEqual([])
      log.mockRestore()
    })

    it('changes nothing without a reserve map, which is what keeps aTokens out', async () => {
      const mod = await import('../src/services/erc20WalletService.ts')
      const ATOKEN = '0x02639ec01313c8775fae74f2dad1118c8a8a86da'
      const { client, inserts } = fake(0, [{ asset_id: 1001, contract: ATOKEN }], [])
      mod.initErc20WalletService(client as never)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await mod.syncWalletContracts()).toEqual([])
      expect(inserts).toEqual([])
      warn.mockRestore()
    })
  })
})
