import { afterEach, describe, expect, it } from 'vitest'
import {
  DISTRIBUTOR_ROW_ASSET, REWARDS_DISTRIBUTOR, accountStages, distributorOwed, hasProgramEnded, isProgramLatestStale, parseClaimsTree,
  parseProgramLatest, programAccounts, programAprPctScaled, programMetaFields, programReserveRates, readDistributorAt, setProgramLatestForTest, usdScaled,
  type ClaimsTree, type ProgramLatest,
} from '../src/services/mmRewardsProgram.ts'
import { buildDistributorRows } from '../src/services/mmIncentiveService.ts'

// The off-chain PRIME programme: the file shapes, the rate's integer arithmetic,
// the not-yet-claimable stages (the Hydration UI's rules) and the distributor's
// claimable rows.

const PRIME = '0x000000000000000000000000000000010000002b'
const A = `0x${'aa'.repeat(20)}`
const B = `0x${'bb'.repeat(20)}`
const ROOT1 = `0x${'11'.repeat(32)}`
const ROOT2 = `0x${'22'.repeat(32)}`
const HOUR = 1_795_197_600

const latestJson = (over: Record<string, unknown> = {}) => ({
  format: 'hydration-rewards-latest/1',
  asOf: { hour: HOUR, block: 17_241_261, blockTime: HOUR + 700 },
  reward: { symbol: 'PRIME', address: PRIME, decimals: 6 },
  program: { name: 'HUSDC and HUSDT, no HOLLAR borrowers', sha256: '0x00', maxHollarDebtUsd: '5.00', endsAt: 1_800_028_800 },
  assets: { HUSDC: { budgetPerDay: '275616000', eligibleUsd: '836326.19' }, HUSDT: { budgetPerDay: null, eligibleUsd: '803311.20' } },
  accounts: { [A.toUpperCase().replace('0X', '0x')]: { earning: true }, [B]: { earning: false, reason: 'hollar_debt', hollarDebtUsd: '12.50' } },
  latestTree: null,
  openEpoch: { id: '2026-11-20', start: 1_795_190_400, end: 1_795_276_800, snapshots: 3, expectedSnapshots: 24, accruing: { [A]: '1500000' } },
  ...over,
})
const tree = (root: string, claims: Record<string, string>): ClaimsTree =>
  parseClaimsTree({ format: 'hydration-rewards-claims/1', reward: PRIME, root, leafEncoding: ['address', 'address', 'uint256'], claims: Object.fromEntries(Object.entries(claims).map(([a, c]) => [a, { claimable: c, proof: [] }])) }, root)

afterEach(() => setProgramLatestForTest(null))

describe('files', () => {
  it('parses latest.json, lower-casing accounts and keeping a null budget as undecided', () => {
    const f = parseProgramLatest(latestJson())
    expect(f.accounts.get(A)).toEqual({ earning: true, reason: null, hollarDebtUsd: null })
    expect(f.accounts.get(B)).toEqual({ earning: false, reason: 'hollar_debt', hollarDebtUsd: '12.50' })
    expect(f.assets.get('HUSDC')?.budgetPerDay).toBe(275_616_000n)
    expect(f.assets.get('HUSDT')?.budgetPerDay).toBeNull()
    expect(f.openEpoch?.accruing?.get(A)).toBe(1_500_000n)
  })

  it('keeps the rest of the file when openEpoch is malformed, and rejects another format', () => {
    expect(parseProgramLatest(latestJson({ openEpoch: { id: 1 } })).openEpoch).toBeNull()
    expect(() => parseProgramLatest(latestJson({ format: 'other/1' }))).toThrow()
  })

  it('rejects a tree file that holds another root, and totals a tree', () => {
    expect(() => tree(ROOT1, {}) && parseClaimsTree({ format: 'hydration-rewards-claims/1', reward: PRIME, root: ROOT2, leafEncoding: ['address', 'address', 'uint256'], claims: {} }, ROOT1)).toThrow(/holds root/)
    expect(tree(ROOT1, { [A]: '10', [B]: '5' }).total).toBe(15n)
  })
})

describe('the rate', () => {
  it('is budget × 365 × price over the eligible USD, in 10^-6 %', () => {
    // 275.616 PRIME/day × 365 × $1.20 / $836,326.19 = 14.4345…%
    const apr = programAprPctScaled(275_616_000n, 6, 1_200_000_000_000n, '836326.19')!
    expect(apr).toBe(14_434_536n)
  })

  it('is null when undecided, unpriced or nothing is eligible', () => {
    expect(programAprPctScaled(null, 6, 1n, '1')).toBeNull()
    expect(programAprPctScaled(1n, 6, null, '1')).toBeNull()
    expect(programAprPctScaled(1n, 6, 1n, '0.00')).toBeNull()
  })

  it('reads USD strings exactly', () => {
    expect(usdScaled('836326.19')).toBe(836_326_190_000_000_000n)
    expect(usdScaled('5')).toBe(5_000_000_000_000n)
  })

  it('rates the reserves of the programme\'s assets from a fresh file only', () => {
    setProgramLatestForTest(parseProgramLatest(latestJson()))
    const now = (HOUR + 3_600) * 1000
    const rates = programReserveRates(addr => (addr === PRIME ? 1_200_000_000_000n : null), now)
    expect([...rates.keys()]).toEqual(['0x000000000000000000000000000000010000006e', '0x000000000000000000000000000000010000006f'])
    expect(rates.get('0x000000000000000000000000000000010000006e')?.aprPct).toBe(14_434_536n)
    expect(rates.get('0x000000000000000000000000000000010000006f')?.aprPct).toBeNull()
    expect(programReserveRates(() => 1n, (HOUR + 7 * 3_600) * 1000).size).toBe(0)
    expect(programReserveRates(() => 1n, 1_800_028_800 * 1000).size).toBe(0)
  })

  it('rates the Wormhole HUSDC/HUSDT reserves under the programme\'s .wh names', () => {
    const asset = { budgetPerDay: '275616000', eligibleUsd: '836326.19' }
    setProgramLatestForTest(parseProgramLatest(latestJson({ assets: { HUSDC: asset, HUSDT: asset, 'HUSDC.wh': asset, 'HUSDT.wh': asset } })))
    const rates = programReserveRates(addr => (addr === PRIME ? 1_200_000_000_000n : null), (HOUR + 3_600) * 1000)
    // 2-Pool-HUSDC (Wormhole) is asset 114 (0x72), 2-Pool-HUSDT (Wormhole) 115 (0x73).
    expect([...rates.keys()]).toEqual([
      '0x000000000000000000000000000000010000006e', '0x000000000000000000000000000000010000006f',
      '0x0000000000000000000000000000000100000072', '0x0000000000000000000000000000000100000073',
    ])
    for (const r of rates.values()) expect(r.aprPct).toBe(14_434_536n)
  })

  it('judges staleness and the end in milliseconds', () => {
    expect(isProgramLatestStale(HOUR, (HOUR + 6 * 3_600) * 1000)).toBe(false)
    expect(isProgramLatestStale(HOUR, (HOUR + 6 * 3_600) * 1000 + 1)).toBe(true)
    expect(hasProgramEnded(null, Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(hasProgramEnded(10, 10_000)).toBe(true)
  })
})

describe('stages', () => {
  const base = { account: A, timelock: 43_200, nowMs: (HOUR + 3_600) * 1000 }

  it('lists the pending root\'s increment, the closed epoch and the open estimate, in order', () => {
    const live = tree(ROOT1, { [A]: '100' })
    const pending = tree(ROOT2, { [A]: '160', [B]: '1' })
    const closedRoot = `0x${'33'.repeat(32)}`
    const closed = tree(closedRoot, { [A]: '200', [B]: '1' })
    const latest = parseProgramLatest(latestJson({ latestTree: { epoch: 'e', root: closedRoot } }))
    const stages = accountStages({ ...base, claimed: 40n, liveRoot: ROOT1, liveTree: live, pending: { root: ROOT2, validAt: HOUR + 7_200 }, pendingTree: pending, latest, closedTree: closed })
    expect(stages).toEqual([
      { stage: 'pending', amount: 60n, claimableAtMs: (HOUR + 7_200) * 1000 },
      { stage: 'closed', amount: 40n, claimableAtMs: null },
      { stage: 'accruing', amount: 1_500_000n, claimableAtMs: (1_795_276_800 + 43_200) * 1000 },
    ])
  })

  it('stops at the first input not read, and states no estimate from a stale file', () => {
    expect(accountStages({ ...base, claimed: undefined, liveRoot: null, liveTree: null, pending: null, pendingTree: null, latest: null, closedTree: null })).toEqual([])
    const latest = parseProgramLatest(latestJson())
    expect(accountStages({ ...base, nowMs: (HOUR + 7 * 3_600) * 1000, claimed: 0n, liveRoot: null, liveTree: null, pending: null, pendingTree: null, latest, closedTree: null })).toEqual([])
    expect(accountStages({ ...base, claimed: 0n, liveRoot: null, liveTree: null, pending: null, pendingTree: null, latest, closedTree: null }))
      .toEqual([{ stage: 'accruing', amount: 1_500_000n, claimableAtMs: (1_795_276_800 + 43_200) * 1000 }])
  })

  it('drops a closed epoch the chain is already past (a file behind the chain)', () => {
    const live = tree(ROOT1, { [A]: '100', [B]: '50' })
    const closedRoot = `0x${'33'.repeat(32)}`
    const latest = parseProgramLatest(latestJson({ latestTree: { epoch: 'e', root: closedRoot } }))
    const stages = accountStages({ ...base, claimed: 0n, liveRoot: ROOT1, liveTree: live, pending: null, pendingTree: null, latest, closedTree: tree(closedRoot, { [A]: '100' }) })
    expect(stages).toEqual([])
  })
})

describe('the distributor', () => {
  it('owes the tree\'s cumulative amount less what was claimed, where positive', () => {
    const t = tree(ROOT1, { [A]: '100', [B]: '50' })
    expect([...distributorOwed(t, new Map([[A, 30n], [B, 50n]]))]).toEqual([[A, 70n]])
    expect(distributorOwed(null, new Map()).size).toBe(0)
  })

  it('publishes one row per owed account under the main market, flagged below the ED', () => {
    const t = tree(ROOT1, { [A]: '100', [B]: '5000000' })
    const rows = buildDistributorRows({ rowsTree: t, claimed: new Map() }, 17_250_000, new Map([[43, 1_000n]]))
    expect(rows.map(r => [r.holder, r.claimableRaw, r.assetAddress, r.marketKey, r.belowEd, r.rewardAssetId])).toEqual([
      [A, 100n, DISTRIBUTOR_ROW_ASSET, 'core', true, 43],
      [B, 5_000_000n, DISTRIBUTOR_ROW_ASSET, 'core', false, 43],
    ])
  })

  it('reads roots, timelock and claimed at the pinned block; a live root without a tree and no earlier live one lists nothing', async () => {
    const calls: Array<{ data: string; tag: unknown }> = []
    const word = (v: string | bigint) => (typeof v === 'string' ? v.slice(2) : v.toString(16).padStart(64, '0'))
    const ethCall = async (cs: Array<{ to: string; data: string }>, tag: unknown) => cs.map(c => {
      calls.push({ data: c.data, tag })
      expect(c.to).toBe(REWARDS_DISTRIBUTOR)
      if (c.data === '0xebf0c717') return `0x${word(ROOT2)}`
      if (c.data === '0x750588cf') return `0x${'0'.repeat(64)}${'0'.repeat(64)}${'0'.repeat(64)}`
      if (c.data === '0xd33219b4') return `0x${word(43_200n)}`
      if (c.data.startsWith('0x0c9cbf0e')) return `0x${word(c.data.includes('aa'.repeat(20)) ? 10n : 0n)}`
      throw new Error(`unexpected ${c.data}`)
    })
    const older = tree(ROOT1, { [A]: '100' })
    const state = await readDistributorAt(ethCall, { blockHash: '0xhash' }, 17_250_000, async root => (root === ROOT1 ? older : null))
    expect(state.liveRoot).toBe(ROOT2)
    expect(state.pending).toBeNull()
    expect(state.timelock).toBe(43_200)
    // No tree for ROOT2 and no earlier live root: no claimables (never a newer, non-live tree).
    expect(state.rowsTree).toBeNull()
    expect(calls.every(c => (c.tag as { blockHash: string }).blockHash === '0xhash')).toBe(true)
  })

  it('falls back to the previous live root\'s tree when the new live root\'s is not served yet', async () => {
    const word = (v: string | bigint) => (typeof v === 'string' ? v.slice(2) : v.toString(16).padStart(64, '0'))
    let live = ROOT1
    const ethCall = async (cs: Array<{ to: string; data: string }>) => cs.map(c => {
      if (c.data === '0xebf0c717') return `0x${word(live)}`
      if (c.data === '0x750588cf') return `0x${'0'.repeat(192)}`
      if (c.data === '0xd33219b4') return `0x${word(43_200n)}`
      return `0x${word(0n)}`
    })
    const first = tree(ROOT1, { [A]: '100' })
    const fetchTree = async (root: string) => (root === ROOT1 ? first : null)
    expect((await readDistributorAt(ethCall, 'latest', 1, fetchTree)).rowsTree).toBe(first)
    live = ROOT2
    const next = await readDistributorAt(ethCall, 'latest', 2, fetchTree)
    expect(next.liveRoot).toBe(ROOT2)
    expect(next.rowsTree).toBe(first)
  })
})

describe('accounts', () => {
  it('states eligibility from the file and leaves out an account it never listed that holds nothing', () => {
    setProgramLatestForTest(parseProgramLatest(latestJson()))
    const now = (HOUR + 3_600) * 1000
    const out = programAccounts([A, B, `0x${'cc'.repeat(20)}`], now)!
    expect(out.accounts.map(a => [a.holder, a.status, a.reason, a.hollarDebtUsd])).toEqual([
      [A, 'earning', null, null],
      [B, 'not-earning', 'hollar_debt', '12.50'],
    ])
    expect(programAccounts([A], (HOUR + 7 * 3_600) * 1000)).toBeNull()
  })

  it('names the programme\'s assets for the not-earning notice', () => {
    setProgramLatestForTest(parseProgramLatest(latestJson()))
    expect(programMetaFields((HOUR + 3_600) * 1000)).toMatchObject({ assets: ['HUSDC', 'HUSDT'], maxHollarDebtUsd: '5.00', marketKey: 'core' })
  })
})

// Typed fixture guard: ProgramLatest stays the parsed shape the readers use.
export type _Latest = ProgramLatest
