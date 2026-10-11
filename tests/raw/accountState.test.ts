import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_STATE_STORAGE,
  accountStateBalanceCandidates,
  accountStateTargets,
  canonicalJson,
  captureAccountState,
  delegationTargets,
  signedOriginAccount,
  votingByClass,
  type AccountStateRuntime,
} from '../../src/raw/accountState.ts'
import { RawClickHouseStore } from '../../src/raw/store.ts'

const ALICE = '0x4e2a16e182e406a9885b2bb2a20136cc7152bc6de166c10feaf8313671d056c1'
const BOB = '0xbc8006a97ffd6e63954e799235eedaab8b9187ed210686843855ebd964756167'
const CAROL = '0x641768da63aab1ad01b2ffed1a44b41c4475f3efdcb74d1e45cf3c490db0c11b'
const BLOCK = { height: 15_600_000, hash: '0xabc', timestamp: '2026-10-10 10:00:00' }

const event = (index: number, name: string, args: unknown) => ({ event_index: index, event_name: name, args_json: JSON.stringify(args), call_address: '0' })
const call = (name: string, args: unknown, origin: string | null, success: number | null = 1, address = '0') => ({
  call_name: name, args_json: JSON.stringify(args), success, call_address: address,
  origin_json: origin == null ? null : JSON.stringify({ __kind: 'system', value: { __kind: 'Signed', value: origin } }),
})

describe('which accounts a block names', () => {
  it('reads the named fields of the governance, vesting, staking, lock and proxy events', () => {
    const { targets } = accountStateTargets([
      event(1, 'ConvictionVoting.Voted', { who: ALICE, vote: { __kind: 'Standard', vote: 130, balance: '1' } }),
      event(2, 'Balances.Locked', { who: ALICE, amount: '1' }),
      event(3, 'Proxy.ProxyAdded', { delegator: BOB, delegatee: CAROL, proxyType: { __kind: 'Any' }, delay: 0 }),
      event(4, 'Tokens.Transfer', { from: ALICE, to: BOB }),
      event(5, 'Staking.AccumulatedRpsUpdated', { accumulatedRps: '1', totalStake: '2' }),
    ], [])
    expect(targets).toEqual([
      { account: ALICE, triggers: ['Balances.Locked', 'ConvictionVoting.Voted'] },
      { account: CAROL, triggers: ['Proxy.ProxyAdded'] },
      { account: BOB, triggers: ['Proxy.ProxyAdded'] },
    ].sort((a, b) => a.account.localeCompare(b.account)))
  })

  it('takes every account of a tuple event (Delegated(who, target)) and a single unnamed one (Undelegated(who))', () => {
    const { targets } = accountStateTargets([
      event(1, 'ConvictionVoting.Delegated', [BOB, CAROL]),
      event(2, 'ConvictionVoting.Undelegated', ALICE),
    ], [])
    expect(targets.map(t => t.account).sort()).toEqual([ALICE, BOB, CAROL].sort())
  })

  it('names the origin of a successful remove_proxies (no per-delegate event) and the target of an unlock', () => {
    const { targets } = accountStateTargets([], [
      call('Proxy.remove_proxies', {}, ALICE),
      call('ConvictionVoting.unlock', { class: 0, target: BOB }, CAROL),
      call('Proxy.remove_proxies', {}, CAROL, 0), // failed: changed nothing
      call('Balances.transfer_keep_alive', { dest: CAROL, value: '1' }, CAROL),
    ])
    expect(targets).toEqual([
      { account: ALICE, triggers: ['Proxy.remove_proxies'] },
      { account: BOB, triggers: ['ConvictionVoting.unlock'] },
    ].sort((a, b) => a.account.localeCompare(b.account)))
  })

  it('reads only a Signed origin', () => {
    expect(signedOriginAccount(JSON.stringify({ __kind: 'system', value: { __kind: 'Signed', value: ALICE } }))).toBe(ALICE)
    expect(signedOriginAccount(JSON.stringify({ __kind: 'system', value: { __kind: 'Root' } }))).toBeNull()
    expect(signedOriginAccount(null)).toBeNull()
  })

  it('asks the balance phase for a System.Account observation per naming event, except a Balances event (already a source)', () => {
    const { sources } = accountStateTargets([
      event(1, 'ConvictionVoting.Voted', { who: ALICE }),
      event(2, 'Balances.Locked', { who: ALICE }),
    ], [call('Proxy.remove_proxies', {}, BOB, 1, '0.1')])
    expect(accountStateBalanceCandidates(sources)).toEqual([
      expect.objectContaining({ accountId: ALICE, assetId: '0', assetKind: 'substrate', sourceKind: 'event', sourceName: 'ConvictionVoting.Voted', sourceEventIndex: 1 }),
      expect.objectContaining({ accountId: BOB, assetId: '0', sourceKind: 'call', sourceName: 'Proxy.remove_proxies', sourceEventIndex: null, sourceCallAddress: '0.1' }),
    ])
  })
})

describe('value encoding', () => {
  it('writes canonical JSON: bigints as strings, bytes as hex, sorted keys, small-integer lists kept as lists', () => {
    expect(canonicalJson({ b: 2n, a: new Uint8Array([1, 2]), c: [1, 2, 3], d: undefined })).toBe('{"a":"0x0102","b":"2","c":[1,2,3],"d":null}')
  })

  it('folds VotingFor pairs of one account into {class: voting}, classes ascending', () => {
    expect(votingByClass([[[ALICE, 8], { v: 8 }], [[ALICE, 0], { v: 0 }]])).toEqual({ 0: { v: 0 }, 8: { v: 8 } })
    expect(() => votingByClass([[[ALICE, 'x'], {}]])).toThrow()
  })
})

function fakeRuntime(state: Record<string, Record<string, unknown>>, opts: { missing?: string[]; fail?: string[]; failAccount?: string } = {}) {
  const calls: string[] = []
  const runtime: AccountStateRuntime = {
    specVersion: 447,
    hasStorageItem: name => !(opts.missing ?? []).includes(name),
    getStorageFallback: name => (name === 'Proxy.Proxies' ? [[], 0n] : []),
    queryStorage: async (hash, name, keys) => {
      calls.push(`${name}@${hash}`)
      if ((opts.fail ?? []).includes(name)) throw new Error(`${name} unavailable`)
      return keys.map(k => state[name]?.[String(k)])
    },
    getStoragePairs: async (hash, name, account) => {
      calls.push(`${name}@${hash}:${String(account)}`)
      if (account === opts.failAccount) throw new Error('pruned')
      const classes = (state[name]?.[String(account)] ?? {}) as Record<string, unknown>
      return Object.entries(classes).map(([c, v]) => [[account, Number(c)], v] as [unknown, unknown])
    },
  }
  return { runtime, calls }
}

describe('captureAccountState', () => {
  const state = {
    [ACCOUNT_STATE_STORAGE.balances_locks]: { [ALICE]: [{ id: '0x7079636f6e766f74', amount: 250n, reasons: { __kind: 'All' } }] },
    [ACCOUNT_STATE_STORAGE.proxies]: { [BOB]: [[{ delegate: CAROL, proxyType: { __kind: 'Any' }, delay: 0 }], 202n] },
    [ACCOUNT_STATE_STORAGE.conviction_voting]: { [ALICE]: { 4: { __kind: 'Casting' }, 0: { __kind: 'Casting', prior: [16409160, 250n] } } },
  }

  it('reads every kind at the block\'s own hash, writing the storage default where an account holds nothing', async () => {
    const { runtime, calls } = fakeRuntime(state)
    const r = await captureAccountState(BLOCK, [{ account: ALICE, triggers: ['ConvictionVoting.Voted'] }, { account: BOB, triggers: ['Proxy.ProxyAdded'] }], runtime, 'rpc')
    expect(r.warnings).toEqual([])
    expect(r.rows.map(row => [row.kind, row.account_id, row.value_json])).toEqual([
      ['balances_locks', ALICE, '[{"amount":"250","id":"0x7079636f6e766f74","reasons":{"__kind":"All"}}]'],
      ['balances_locks', BOB, '[]'],
      ['conviction_voting', ALICE, '{"0":{"__kind":"Casting","prior":[16409160,"250"]},"4":{"__kind":"Casting"}}'],
      ['conviction_voting', BOB, '{}'],
      ['proxies', ALICE, '[[],"0"]'],
      ['proxies', BOB, `[[{"delay":0,"delegate":"${CAROL}","proxyType":{"__kind":"Any"}}],"202"]`],
      ['vesting_schedules', ALICE, '[]'],
      ['vesting_schedules', BOB, '[]'],
    ])
    expect(r.rows[0]).toMatchObject({ block_height: BLOCK.height, block_hash: BLOCK.hash, spec_version: 447, sub_key: '', triggers: ['ConvictionVoting.Voted'], ingest_source: 'rpc' })
    expect(calls.every(c => c.includes(`@${BLOCK.hash}`))).toBe(true)
  })

  it('a failed read is a warning for that (kind, account) only; the block keeps every other row', async () => {
    const { runtime } = fakeRuntime(state, { fail: [ACCOUNT_STATE_STORAGE.proxies], failAccount: BOB })
    const r = await captureAccountState(BLOCK, [{ account: ALICE, triggers: ['x'] }, { account: BOB, triggers: ['y'] }], runtime, 'rpc')
    expect(r.warnings.map(w => [w.parser, w.source_kind, w.source_name, w.source_index, w.warning_code])).toEqual([
      ['raw_account_state', 'storage', 'ConvictionVoting.VotingFor', `conviction_voting:${BOB}`, 'account_state_read_failed'],
      ['raw_account_state', 'storage', 'Proxy.Proxies', `proxies:${ALICE}`, 'account_state_read_failed'],
      ['raw_account_state', 'storage', 'Proxy.Proxies', `proxies:${BOB}`, 'account_state_read_failed'],
    ])
    expect(JSON.parse(r.warnings[0].evidence_json)).toEqual({ kind: 'conviction_voting', account: BOB, triggers: ['y'], spec_version: 447 })
    expect(r.rows.some(row => row.kind === 'proxies')).toBe(false)
    expect(r.rows.filter(row => row.kind === 'conviction_voting').map(row => row.account_id)).toEqual([ALICE])
  })

  it('skips an item the executing runtime does not have (no state, no warning), and reads only the asked kinds', async () => {
    const { runtime, calls } = fakeRuntime(state, { missing: [ACCOUNT_STATE_STORAGE.conviction_voting, ACCOUNT_STATE_STORAGE.vesting_schedules] })
    const r = await captureAccountState(BLOCK, [{ account: ALICE, triggers: ['x'], kinds: ['proxies'] }], runtime, 'repair')
    expect(r.rows.map(row => row.kind)).toEqual(['proxies'])
    expect(r.warnings).toEqual([])
    expect(calls).toEqual([`Proxy.Proxies@${BLOCK.hash}`])
  })

  it('makes no read for a block that names nobody', async () => {
    const { runtime, calls } = fakeRuntime(state)
    expect(await captureAccountState(BLOCK, [], runtime, 'rpc')).toEqual({ rows: [], warnings: [], reads: 0 })
    expect(calls).toEqual([])
  })
})

describe('the raw store and indexer wiring', () => {
  it('flushes account state and oracle prices in flushAll and counts them toward the flush policy', async () => {
    const inserts: Array<{ table: string; values: unknown[] }> = []
    const store = new RawClickHouseStore({ insert: async (o: { table: string; values: unknown[] }) => { inserts.push(o) } } as never, 10_000)
    const { runtime } = fakeRuntime({})
    const { rows } = await captureAccountState(BLOCK, [{ account: ALICE, triggers: ['x'] }], runtime, 'rpc')
    store.addAccountStateObservations(rows)
    store.addMoneyMarketOraclePrices([{ block_height: 1, block_timestamp: 't', pool_address: 'p', reserve_address: 'r', oracle_address: 'o', price: '1', is_change: 1 }])
    expect(store.pendingRows()).toBe(rows.length)
    await store.flushAll()
    expect(inserts.filter(i => i.table === 'price_data.raw_account_state_observations').flatMap(i => i.values)).toEqual(rows)
    expect(inserts.filter(i => i.table === 'price_data.raw_money_market_oracle_prices').flatMap(i => i.values)).toHaveLength(1)
  })

  it('captures with the executing runtime at the block\'s own hash, and feeds the balance phase', () => {
    const indexer = readFileSync(new URL('../../src/raw/indexer.ts', import.meta.url), 'utf8')
    const capture = indexer.slice(indexer.indexOf('captureAccountState('), indexer.indexOf('const balances = await'))
    expect(capture).toContain('block.header._runtime as unknown as AccountStateRuntime')
    expect(capture).toContain('hash: block.header.hash')
    expect(indexer).toContain('accountStateBalanceCandidates(accountState.sources)')
    expect(indexer).toContain('accountStateTargets(eventRows, [...callRows, ...synthetic.rows])')
  })
})

describe('an undelegation reads its delegation targets too', () => {
  const PARENT = '0xparent'
  const delegating = { __kind: 'Delegating', value: { balance: 1n, target: CAROL, conviction: { __kind: 'Locked1x' }, delegations: {}, prior: [0, 0n] } }

  it('marks the undelegating account and finds Delegating targets in its pairs', () => {
    const { targets } = accountStateTargets([event(1, 'ConvictionVoting.Undelegated', BOB)], [])
    expect(targets).toEqual([{ account: BOB, triggers: ['ConvictionVoting.Undelegated'], expandDelegations: true }])
    expect(delegationTargets([[[BOB, 0], delegating], [[BOB, 1], { __kind: 'Casting', value: {} }], [[BOB, 2], delegating]])).toEqual([CAROL])
  })

  it('reads the target\'s VotingFor at the block, found in the delegator\'s at the parent', async () => {
    const calls: string[] = []
    const runtime: AccountStateRuntime = {
      specVersion: 447,
      hasStorageItem: () => true,
      getStorageFallback: () => [],
      queryStorage: async (_hash, _name, keys) => keys.map(() => undefined),
      getStoragePairs: async (hash, _name, account) => {
        calls.push(`${hash}:${String(account)}`)
        if (hash === PARENT && account === BOB) return [[[BOB, 0], delegating]]
        if (hash === BLOCK.hash && account === CAROL) return [[[CAROL, 0], { __kind: 'Casting', value: { delegations: { capital: '0', votes: '0' } } }]]
        return []
      },
    }
    const { targets } = accountStateTargets([event(1, 'ConvictionVoting.Undelegated', BOB)], [])
    const r = await captureAccountState({ ...BLOCK, parentHash: PARENT }, targets, runtime, 'rpc')
    expect(r.warnings).toEqual([])
    expect(r.rows.filter(row => row.kind === 'conviction_voting').map(row => [row.account_id, row.triggers, row.value_json])).toEqual([
      [CAROL, ['ConvictionVoting.Undelegated'], '{"0":{"__kind":"Casting","value":{"delegations":{"capital":"0","votes":"0"}}}}'],
      [BOB, ['ConvictionVoting.Undelegated'], '{}'],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    // The target is read for conviction_voting only.
    expect(r.rows.filter(row => row.account_id === CAROL).map(row => row.kind)).toEqual(['conviction_voting'])
    expect(calls).toContain(`${PARENT}:${BOB}`)
  })

  it('holds back the delegator\'s row with an open warning when the targets cannot be read', async () => {
    const runtime: AccountStateRuntime = {
      specVersion: 447, hasStorageItem: () => true, getStorageFallback: () => [],
      queryStorage: async (_h, _n, keys) => keys.map(() => undefined),
      getStoragePairs: async hash => { if (hash === PARENT) throw new Error('pruned'); return [] },
    }
    const { targets } = accountStateTargets([event(1, 'ConvictionVoting.Undelegated', BOB)], [])
    const r = await captureAccountState({ ...BLOCK, parentHash: PARENT }, targets, runtime, 'rpc')
    expect(r.warnings.map(w => [w.source_index, w.warning])).toEqual([[`conviction_voting:${BOB}`, 'delegation targets unread: pruned']])
    expect(r.rows.some(row => row.kind === 'conviction_voting')).toBe(false)
    expect(r.rows.map(row => row.kind).sort()).toEqual(['balances_locks', 'proxies', 'vesting_schedules'])
  })
})
