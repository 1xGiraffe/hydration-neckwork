import { describe, expect, it } from 'vitest'
import {
  accountStateDefaults,
  compareAccountState,
  enumerateAccountState,
  reconcileAccountState,
  repairTargets,
  seedRows,
  type AccountStateEnumerationRuntime,
  type OpenAccountStateWarning,
} from '../../src/scripts/accountStateCapture.ts'
import { OPEN_ACCOUNT_STATE_WARNINGS_SQL } from '../../src/scripts/accountStatePorts.ts'
import type { AccountStateRow } from '../../src/raw/accountState.ts'

const ALICE = '0x4e2a16e182e406a9885b2bb2a20136cc7152bc6de166c10feaf8313671d056c1'
const BOB = '0xbc8006a97ffd6e63954e799235eedaab8b9187ed210686843855ebd964756167'

const warning = (block: number, kind: OpenAccountStateWarning['kind'], account: string, triggers = ['ConvictionVoting.Voted']): OpenAccountStateWarning =>
  ({ blockHeight: block, blockTimestamp: '2026-10-10 10:00:00', kind, account, triggers })

function runtime(state: Record<string, Record<string, unknown>>, failing = new Set<string>()): AccountStateEnumerationRuntime {
  return {
    specVersion: 447,
    hasStorageItem: () => true,
    getStorageFallback: name => (name === 'Proxy.Proxies' ? [[], 0n] : []),
    getStorage: async () => 1_760_000_000_000n,
    queryStorage: async (_hash, name, keys) => {
      if (failing.has(name)) throw new Error(`${name} pruned`)
      return keys.map(k => state[name]?.[String(k)])
    },
    getStoragePairs: async (_hash, name, account) => Object.entries((state[name]?.[String(account)] ?? {}) as Record<string, unknown>).map(([c, v]) => [[account, Number(c)], v]),
    async *getStoragePairsPaged(_size, _hash, name) {
      const entries = Object.entries(state[name] ?? {})
      if (name === 'ConvictionVoting.VotingFor') {
        yield entries.flatMap(([account, classes]) => Object.entries(classes as Record<string, unknown>).map(([c, v]) => [[account, Number(c)], v] as [unknown, unknown]))
      } else {
        yield entries.map(([account, v]) => [account, v] as [unknown, unknown])
      }
    },
  }
}

const STATE = {
  'Balances.Locks': { [ALICE]: [{ id: '0x7079636f6e766f74', amount: 5n, reasons: { __kind: 'All' } }] },
  'Vesting.VestingSchedules': {},
  'Proxy.Proxies': { [BOB]: [[{ delegate: ALICE, proxyType: { __kind: 'Any' }, delay: 0 }], 1n] },
  'ConvictionVoting.VotingFor': { [ALICE]: { 1: { __kind: 'Casting' }, 0: { __kind: 'Delegating' } } },
}

describe('account-state repair', () => {
  it('groups open warnings into one capture per block, each account with the kinds that failed', () => {
    const plan = repairTargets([warning(20, 'proxies', BOB), warning(10, 'balances_locks', ALICE), warning(10, 'conviction_voting', ALICE, ['Balances.Locked'])])
    expect([...plan.keys()]).toEqual([10, 20])
    expect(plan.get(10)!.targets).toEqual([{ account: ALICE, triggers: ['Balances.Locked', 'ConvictionVoting.Voted'], kinds: ['balances_locks', 'conviction_voting'] }])
    // A failed undelegation is repaired whole: its delegation targets are found again.
    expect(repairTargets([warning(5, 'conviction_voting', BOB, ['ConvictionVoting.Undelegated'])]).get(5)!.targets[0].expandDelegations).toBe(true)
    expect(repairTargets([warning(5, 'balances_locks', BOB, ['ConvictionVoting.Undelegated'])]).get(5)!.targets[0].expandDelegations).toBeUndefined()
  })

  it('re-reads only what failed, inserts it, and reports the open set before and after', async () => {
    let open = [warning(10, 'balances_locks', ALICE), warning(11, 'proxies', BOB)]
    const inserted: AccountStateRow[] = []
    const result = await reconcileAccountState({ openWarnings: async () => open }, {
      chain: { blockHash: async h => `0xhash${h}`, executingRuntime: async () => runtime(STATE) },
      sink: { insert: async rows => { inserted.push(...rows); open = [] } },
    }, { dryRun: false, limit: 100 })
    expect(inserted.map(r => [r.block_height, r.block_hash, r.kind, r.account_id, r.ingest_source])).toEqual([
      [10, '0xhash10', 'balances_locks', ALICE, 'repair'],
      [11, '0xhash11', 'proxies', BOB, 'repair'],
    ])
    expect(result).toEqual({ openBefore: 2, truncated: false, blocks: 2, rows: 2, failed: [], openAfter: 0 })
  })

  it('keeps a block that still cannot be read open, without holding back the others', async () => {
    const inserted: AccountStateRow[] = []
    const result = await reconcileAccountState({ openWarnings: async () => [warning(10, 'proxies', BOB), warning(11, 'balances_locks', ALICE)] }, {
      chain: {
        blockHash: async h => `0x${h}`,
        executingRuntime: async h => runtime(STATE, h === 10 ? new Set(['Proxy.Proxies']) : new Set()),
      },
      sink: { insert: async rows => { inserted.push(...rows) } },
    }, { dryRun: false, limit: 2 })
    expect(result.failed).toEqual([{ block: 10, reason: 'Proxy.Proxies pruned' }])
    expect(result.truncated).toBe(true)
    expect(inserted.map(r => r.block_height)).toEqual([11])
  })

  it('writes nothing in a dry run', async () => {
    const result = await reconcileAccountState({ openWarnings: async () => [warning(10, 'proxies', BOB)] }, {
      chain: { blockHash: async () => '0x', executingRuntime: async () => runtime(STATE) },
      sink: { insert: async () => { throw new Error('dry run wrote') } },
    }, { dryRun: true, limit: 10 })
    expect(result).toMatchObject({ rows: 1, openAfter: null })
  })

  it('states the open set as the anti-join of warnings against observation rows, never the bare count', () => {
    expect(OPEN_ACCOUNT_STATE_WARNINGS_SQL).toContain("PREWHERE parser = 'raw_account_state' AND warning_code = 'account_state_read_failed'")
    expect(OPEN_ACCOUNT_STATE_WARNINGS_SQL).toContain('LEFT ANTI JOIN')
    expect(OPEN_ACCOUNT_STATE_WARNINGS_SQL).toContain('c.block_height = w.block_height AND c.kind = w.kind AND c.account_id = w.account')
  })
})

describe('seed and verify', () => {
  it('enumerates every account of every kind exactly as the hook encodes it', async () => {
    const e = await enumerateAccountState(runtime(STATE), '0xs')
    expect(e.get('balances_locks')).toEqual(new Map([[ALICE, '[{"amount":"5","id":"0x7079636f6e766f74","reasons":{"__kind":"All"}}]']]))
    expect(e.get('conviction_voting')).toEqual(new Map([[ALICE, '{"0":{"__kind":"Delegating"},"1":{"__kind":"Casting"}}']]))
    expect(e.get('proxies')).toEqual(new Map([[BOB, `[[{"delay":0,"delegate":"${ALICE}","proxyType":{"__kind":"Any"}}],"1"]`]]))
    expect(e.get('vesting_schedules')).toEqual(new Map())
    const rows = seedRows(e, { height: 9, hash: '0xs', timestamp: 't', specVersion: 447 })
    expect(rows.map(r => [r.kind, r.account_id, r.triggers, r.ingest_source])).toEqual([
      ['balances_locks', ALICE, ['seed'], 'seed'],
      ['conviction_voting', ALICE, ['seed'], 'seed'],
      ['proxies', BOB, ['seed'], 'seed'],
    ])
  })

  it('compares the latest observation of each observed account with the chain, defaults included', async () => {
    const rt = runtime(STATE)
    const e = await enumerateAccountState(rt, '0xs')
    const observed = new Map([
      ['balances_locks', new Map([[ALICE, e.get('balances_locks')!.get(ALICE)!], [BOB, '[]']])],
      ['proxies', new Map([[BOB, '[[],"0"]']])],
    ] as const)
    const result = compareAccountState(e, observed as never, accountStateDefaults(rt))
    expect(result.balances_locks).toMatchObject({ observed: 2, matched: 2, mismatched: 0, unobserved: 0 })
    expect(result.proxies).toMatchObject({ observed: 1, matched: 0, mismatched: 1, unobserved: 0 })
    expect(result.conviction_voting).toMatchObject({ observed: 0, unobserved: 1 })
  })
})
