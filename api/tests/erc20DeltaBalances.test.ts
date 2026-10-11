import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'

// erc20_wallet_balances is produced from erc20_transfer_deltas (FINAL, summed per
// holder up to the cycle's pinned block), recomputed only when a contract's delta
// watermark moves; eth_call balanceOf survives as an hourly audit at the same
// pinned block that logs and counts every (contract, holder) mismatch.
const PIN = { block: 15_600_000, blockHash: '0x' + 'cd'.repeat(32), indexedHead: 15_600_003, finalizedHead: 15_600_000 }
const ETH_HASH = '0x' + 'ef'.repeat(32)
vi.mock('../src/services/pinnedBlock.ts', () => ({
  loadPinnedSubstrateBlock: async () => PIN,
  withEthBlockHash: async (p: typeof PIN) => ({ ...p, ethBlockHash: ETH_HASH }),
}))

const svc = await import('../src/services/erc20WalletService.ts')
const { refreshErc20Wallets, initErc20WalletService, resetErc20BalanceStateForTest, erc20BalanceAuditStats, balancesFromDeltaRows, auditMismatches, deltaWatermarkKey, DELTA_BALANCES_SQL, DELTA_WATERMARKS_SQL } = svc

const HOLLAR = '0x531a654d1696ed52e7275a8cede955e82620f99a'
const h = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const eth = (evm: string) => `0x45544800${evm.slice(2)}0000000000000000`
const SUBSTRATE = '0x' + 'ab'.repeat(32)

interface World {
  watermark: { n: number; ingested: string; top: number }
  sums: { holder: string; balance: string }[]
  alias: { evm: string; account_id: string }[]
  chain: Map<string, bigint>
  gapBuckets: number[]
}
let world: World
const seen = { sumQueries: [] as Record<string, unknown>[], watermarkQueries: [] as Record<string, unknown>[], inserts: [] as { account_id: string; asset_id: string; total: string }[][], ethAt: [] as unknown[] }

function fakeClient(): ClickHouseClient {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => ({
      json: async () => {
        if (query.includes('erc20:wallet-contracts:reserve-map')) return [{ n: 0 }]
        if (query.includes('erc20:wallet-contracts:desired')) return []
        if (query.includes('erc20:wallet-contracts:current')) return [{ contract: HOLLAR, asset_id: 222, active: 1 }]
        if (query.includes('erc20:balances:watermarks')) { seen.watermarkQueries.push(query_params ?? {}); return [{ contract: HOLLAR, ...world.watermark }] }
        if (query.includes('erc20:balances:sum')) { seen.sumQueries.push(query_params ?? {}); return world.sums.map(s => ({ contract: HOLLAR, ...s })) }
        if (query.includes('account_alias_directory')) return world.alias
        if (query.includes('erc20:catchup:totals')) return world.gapBuckets.length ? [{ contract: HOLLAR, raw_n: 99, delta_n: 10 }] : []
        if (query.includes('erc20:catchup:buckets')) return world.gapBuckets.map(bucket => ({ bucket }))
        return []
      },
    }),
    insert: async ({ table, values }: { table: string; values: { account_id: string; asset_id: string; total: string }[] }) => {
      if (table === 'price_data.erc20_wallet_balances') seen.inserts.push(values)
    },
    command: async () => {},
  } as unknown as ClickHouseClient
}

beforeEach(() => {
  resetErc20BalanceStateForTest()
  world = {
    watermark: { n: 10, ingested: '2026-10-10 08:00:00', top: 15_599_990 },
    sums: [{ holder: h(1), balance: '500' }, { holder: h(2), balance: '0' }, { holder: h(3), balance: '7' }],
    alias: [],
    chain: new Map([[h(1), 500n], [h(2), 0n], [h(3), 7n]]),
    gapBuckets: [],
  }
  seen.sumQueries.length = 0
  seen.watermarkQueries.length = 0
  seen.inserts.length = 0
  seen.ethAt.length = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const calls = JSON.parse(init.body) as { id: number; params: [{ data: string }, unknown] }[]
    return {
      ok: true,
      json: async () => calls.map(c => {
        seen.ethAt.push(c.params[1])
        const holder = '0x' + c.params[0].data.slice(-40)
        const v = world.chain.get(holder)
        return v == null ? { id: c.id, error: { message: 'x' } } : { id: c.id, result: '0x' + v.toString(16) }
      }),
    } as unknown as Response
  }))
  initErc20WalletService(fakeClient())
})
afterEach(() => { vi.unstubAllGlobals() })

describe('erc20 wallet balances from transfer deltas', () => {
  it('publishes every holder from the delta sums at the pinned block, then audits balanceOf at that block', async () => {
    await refreshErc20Wallets()
    expect(seen.watermarkQueries).toEqual([{ cs: [HOLLAR], b: PIN.block }])
    expect(seen.sumQueries[0]).toEqual({ cs: [HOLLAR], b: PIN.block })
    expect(seen.inserts).toEqual([[
      { account_id: eth(h(1)), asset_id: '222', total: '500' },
      { account_id: eth(h(2)), asset_id: '222', total: '0' },
      { account_id: eth(h(3)), asset_id: '222', total: '7' },
    ]])
    // The audit: one eth_call per holder, every one at the pinned block's Ethereum hash.
    expect(seen.ethAt).toHaveLength(3)
    for (const at of seen.ethAt) expect(at).toEqual({ blockHash: ETH_HASH })
    expect(erc20BalanceAuditStats()).toMatchObject({ runs: 1, lastBlock: PIN.block, lastChecked: 3, lastMismatches: 0, totalMismatches: 0, lastUnread: 0 })
  })

  it('does nothing while the watermark and the anchors stand still, and recomputes when the watermark moves', async () => {
    await refreshErc20Wallets()
    seen.inserts.length = 0
    seen.sumQueries.length = 0
    await refreshErc20Wallets()
    expect(seen.sumQueries).toHaveLength(0)
    expect(seen.inserts).toHaveLength(0)
    expect(erc20BalanceAuditStats().runs).toBe(1) // hourly, not per cycle

    // A catch-up insert carries raw's old ingested_at: only the count moves.
    world.watermark = { ...world.watermark, n: 12 }
    world.sums = [{ holder: h(1), balance: '400' }, { holder: h(2), balance: '100' }, { holder: h(3), balance: '7' }]
    await refreshErc20Wallets()
    expect(seen.sumQueries).toHaveLength(1)
    expect(seen.inserts[0]).toContainEqual({ account_id: eth(h(1)), asset_id: '222', total: '400' })
    expect(seen.inserts[0]).toContainEqual({ account_id: eth(h(2)), asset_id: '222', total: '100' })
  })

  it('re-keys a balance when an alias appears, without re-summing the deltas', async () => {
    await refreshErc20Wallets()
    seen.inserts.length = 0
    seen.sumQueries.length = 0
    world.alias = [{ evm: h(1), account_id: SUBSTRATE }]
    await refreshErc20Wallets()
    expect(seen.sumQueries).toHaveLength(0)
    expect(seen.inserts).toHaveLength(1)
    expect(seen.inserts[0]).toContainEqual({ account_id: SUBSTRATE, asset_id: '222', total: '500' })
  })

  it('keeps the previous rows of a contract whose deltas sum negative for a holder', async () => {
    world.sums = [{ holder: h(1), balance: '-5' }, { holder: h(3), balance: '7' }]
    await refreshErc20Wallets()
    expect(seen.inserts).toHaveLength(0)
  })

  it('keeps the previous rows of a contract whose catch-up gap this cycle cannot reach', async () => {
    world.gapBuckets = Array.from({ length: 13 }, (_, i) => i) // one past the per-cycle cap
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await refreshErc20Wallets()
    expect(seen.inserts).toHaveLength(0)
    world.gapBuckets = [12] // the next check finds the rest, all within the cap
    vi.useFakeTimers({ now: Date.now() + 7 * 3600_000, toFake: ['Date'] })
    await refreshErc20Wallets()
    vi.useRealTimers()
    expect(seen.inserts).toHaveLength(1)
    vi.restoreAllMocks()
    warn.mockRestore()
  })

  it('counts and logs every (contract, holder) the audit finds off, without publishing the chain value', async () => {
    world.chain = new Map([[h(1), 501n], [h(2), 0n]]) // h(1) differs, h(3) unread
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await refreshErc20Wallets()
    expect(erc20BalanceAuditStats()).toMatchObject({ lastChecked: 2, lastUnread: 1, lastMismatches: 1, totalMismatches: 1 })
    expect(warn.mock.calls.some(c => String(c[0]).includes(`AUDIT MISMATCH asset 222 (${HOLLAR}) holder ${h(1)} at block ${PIN.block}: deltas 500, balanceOf 501`))).toBe(true)
    expect(seen.inserts[0]).toContainEqual({ account_id: eth(h(1)), asset_id: '222', total: '500' })
    warn.mockRestore()
  })
})

describe('erc20 delta balance pieces', () => {
  it('sums FINAL deltas up to the pinned block and never counts the zero address', () => {
    expect(DELTA_BALANCES_SQL).toContain('FROM price_data.erc20_transfer_deltas FINAL')
    expect(DELTA_BALANCES_SQL).toContain('block_height <= {b:UInt32}')
    expect(DELTA_BALANCES_SQL).toContain("holder != '0x0000000000000000000000000000000000000000'")
    expect(DELTA_WATERMARKS_SQL).toContain('count() AS n')
    expect(DELTA_WATERMARKS_SQL).toContain('block_height <= {b:UInt32}')
  })

  it('keys the watermark on the row count too, so a catch-up with an old ingested_at still moves it', () => {
    const a = deltaWatermarkKey({ n: 10, ingested: '2026-10-10 08:00:00', top: 5 })
    expect(deltaWatermarkKey({ n: '11', ingested: '2026-10-10 08:00:00', top: '5' })).not.toBe(a)
    expect(deltaWatermarkKey({ n: '10', ingested: '2026-10-10 08:00:00', top: '5' })).toBe(a)
  })

  it('reports negative holders and drops the zero address', () => {
    const { balances, negative } = balancesFromDeltaRows([
      { contract: HOLLAR, holder: h(1), balance: '5' },
      { contract: HOLLAR, holder: h(2), balance: '-1' },
      { contract: HOLLAR, holder: h(0), balance: '-6' },
    ])
    expect([...balances.get(HOLLAR)!.keys()]).toEqual([h(1), h(2)])
    expect(negative.get(HOLLAR)).toEqual([h(2)])
  })

  it('separates unread holders from mismatches', () => {
    expect(auditMismatches(new Map([[h(1), 1n], [h(2), 2n], [h(3), 3n]]), new Map([[h(1), 1n], [h(2), 9n]])))
      .toEqual({ checked: 2, unread: 1, mismatches: [{ holder: h(2), deltas: '2', chain: '9' }] })
  })
})
