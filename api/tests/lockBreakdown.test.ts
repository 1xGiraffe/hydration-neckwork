import { describe, it, expect } from 'vitest'
import { hexToU8a } from '@polkadot/util'
import {
  decodeIdAmountVec,
  decodeHoldVec,
  decodeIdentityDeposit,
  decodeSubsOfDeposit,
  decodeProxiesDeposit,
  decodeAnnouncementsDeposit,
  decodeMultisigDeposit,
  decodeReferendumDeposits,
  decodePreimageLegacyDeposit,
  unvestedByAccountRaw,
  voteLockTranches,
  gigaUnstakeTranches,
  vestingTranches,
  mergeTranches,
  buildBindingTimeline,
  mergeTimelines,
  type TimelineSource,
} from '../src/services/lockBreakdownService.ts'
import { attachLockBreakdowns, type AddressBalance } from '../src/services/explorerService.ts'

// Byte fixtures are real Hydration storage values captured from the archive
// node (block ~13,270,841); expected amounts cross-checked against the runtime
// deposit constants (identity 500 + 84×10, proxy 200.24 + 3×0.99, multisig
// 202.64 + 4×0.96 HDX, referenda submission 100 HDX / track-5 decision 750k).

describe('lock/reserve vec decoding', () => {
  it('decodes Balances.Reserves entries (24-byte items)', () => {
    const dca = decodeIdAmountVec(hexToU8a('0x046463616f726465727c4f7ec96fffa8000000000000000000'), 24)
    expect(dca).toEqual([{ id: 'dcaorder', amount: 47568651674341244n }])
    const otc = decodeIdAmountVec(hexToU8a('0x046f74636f7264657200407a10f35a00000000000000000000'), 24)
    expect(otc).toEqual([{ id: 'otcorder', amount: 100000000000000n }])
  })

  it('decodes Balances.Locks entries (25-byte items, trailing reasons byte)', () => {
    // Two locks: ormlvest 500e9 + pyconvot 300e9, id(8) + amount(16 LE) + reasons(1).
    const item = (id: string, amountLeHex: string) => Buffer.from(id, 'latin1').toString('hex') + amountLeHex + '02'
    const vec = '0x08' + item('ormlvest', '0088526a740000000000000000000000') + item('pyconvot', '00b864d9450000000000000000000000')
    expect(decodeIdAmountVec(hexToU8a(vec), 25)).toEqual([
      { id: 'ormlvest', amount: 500000000000n },
      { id: 'pyconvot', amount: 300000000000n },
    ])
  })

  it('decodes Balances.Holds (RuntimeHoldReason pallet/variant pairs)', () => {
    const holds = decodeHoldVec(hexToU8a('0x040f00006c081b807101000000000000000000'))
    expect(holds).toEqual([{ pallet: 15, variant: 0, amount: 406270000000000n }])
  })
})

describe('deposit decoding', () => {
  it('identity registration deposit (empty judgements)', () => {
    const value = hexToU8a('0x0000c0ff0fb9c2040000000000000000000408446973636f7264')
    expect(decodeIdentityDeposit(value)).toBe(1340000000000000n)
  })

  it('identity registration deposit skips FeePaid judgement payloads', () => {
    // One judgement (registrar 0, FeePaid(7)) then the deposit.
    const value = hexToU8a('0x04' + '00000000' + '01' + '07000000000000000000000000000000' + '00c0ff0fb9c204000000000000000000')
    expect(decodeIdentityDeposit(value)).toBe(1340000000000000n)
  })

  it('subs deposit', () => {
    expect(decodeSubsOfDeposit(hexToU8a('0x0080f420e6b5000000000000000000001012'))).toBe(200000000000000n)
  })

  it('proxy definitions deposit (3 × 37-byte items)', () => {
    const value = hexToU8a('0x0c' +
      '4d5184fcebd910b43badc23531209a3d1546dd4a1853114e20005d61c49725fb' + '00' + '00000000' +
      'ee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf52' + '02' + '00000000' +
      'ee24cdac0c090625c7ac9110d9dc9a9fedd76d6588bffc23660d4eca2b5edf52' + '03' + '00000000' +
      '0064dd83d1b800000000000000000000')
    expect(decodeProxiesDeposit(value)).toBe(203210000000000n)
  })

  it('announcements deposit (empty vec)', () => {
    const value = hexToU8a('0x00' + '00407a10f35a00000000000000000000')
    expect(decodeAnnouncementsDeposit(value)).toBe(100000000000000n)
  })

  it('multisig deposit attributed to the depositor', () => {
    const value = hexToU8a('0x19d4af000200000000a00ddfcabb00000000000000000000bc96ec00952efa8f0e3e08b36bf5096bcb877acac536e478aecb72868db5db0204bc96ec00952efa8f0e3e08b36bf5096bcb877acac536e478aecb72868db5db02')
    expect(decodeMultisigDeposit(value)).toEqual({
      depositor: '0xbc96ec00952efa8f0e3e08b36bf5096bcb877acac536e478aecb72868db5db02',
      amount: 206480000000000n,
    })
  })

  it('finished referendum: submission deposit kept until refunded, decision refunded', () => {
    const value = hexToU8a('0x011120be00018aee4e164d5d70ac67308f303c7e063e9156903e42c1087bbc530447487fa47f00407a10f35a0000000000000000000000')
    expect(decodeReferendumDeposits(value)).toEqual([
      { who: '0x8aee4e164d5d70ac67308f303c7e063e9156903e42c1087bbc530447487fa47f', amount: 100000000000000n },
    ])
  })

  it('ongoing referendum: submission + decision deposits (track origin, Lookup call)', () => {
    const value = hexToU8a('0x000500260502c7e1cbabc8072a2bdfad76c57e38abcd007271e3748413b5a16973d8309a34ec3d000000016400000009ffc90004af48429474c23181d08f1f41434b269da3df7798bdd540799629aabb33c32100407a10f35a000000000000000000000104af48429474c23181d08f1f41434b269da3df7798bdd540799629aabb33c32100008bbd0689680a0000000000000000016101ca0000f7eedad9fe90d1e3470000000000000058714be32d6d2a350400000000000000ff6d2c968d20db1c1100000000000000000126e9ca0026e9ca0000000000')
    expect(decodeReferendumDeposits(value)).toEqual([
      { who: '0x04af48429474c23181d08f1f41434b269da3df7798bdd540799629aabb33c321', amount: 100000000000000n },
      { who: '0x04af48429474c23181d08f1f41434b269da3df7798bdd540799629aabb33c321', amount: 750000000000000000n },
    ])
  })

  it('killed referendum has no reserved deposits', () => {
    expect(decodeReferendumDeposits(hexToU8a('0x0505000000'))).toEqual([])
  })

  it('legacy preimage deposits', () => {
    const unrequested = hexToU8a('0x000c691601793de060491dab143dfae19f5f6413d4ce4c363637e5ceacb2836a4e008034d829700100000000000000000060000000')
    expect(decodePreimageLegacyDeposit(unrequested)).toEqual({
      who: '0x0c691601793de060491dab143dfae19f5f6413d4ce4c363637e5ceacb2836a4e',
      amount: 404800000000000n,
    })
    // Requested without deposit → nothing reserved.
    expect(decodePreimageLegacyDeposit(hexToU8a('0x0100010000000132010000'))).toBeNull()
  })
})

describe('vesting claimable math', () => {
  const account = '0x' + 'aa'.repeat(32)
  it('counts only future periods as still vesting', () => {
    // 100 periods of 10 relay blocks starting at 1000, 5 HDX-raw per period.
    const schedules = [{ accountId: account, start: 1000, period: 10, periodCount: 100, perPeriod: 5_000000000000n }]
    // 40 periods elapsed → 60 remain.
    expect(unvestedByAccountRaw(schedules, 1400).get(account)).toBe(300_000000000000n)
    // Before start nothing vested.
    expect(unvestedByAccountRaw(schedules, 900).get(account)).toBe(500_000000000000n)
    // After the last period the schedule is done — no entry at all.
    expect(unvestedByAccountRaw(schedules, 3000).has(account)).toBe(false)
  })
  it('sums multiple schedules per account', () => {
    const schedules = [
      { accountId: account, start: 0, period: 10, periodCount: 10, perPeriod: 1n },
      { accountId: account, start: 0, period: 10, periodCount: 20, perPeriod: 1n },
    ]
    expect(unvestedByAccountRaw(schedules, 50).get(account)).toBe(5n + 15n)
  })
})

describe('vote lock tranches', () => {
  const cls = (activeAmount: bigint, priorUnlock: number, priorBalance: bigint, hasActiveVotes = activeAmount > 0n) =>
    ({ activeAmount, hasActiveVotes, priorUnlock, priorBalance })

  it('decomposes partially overlapping prior locks into envelope drops', () => {
    // Class A: prior 300 until block 200; class B: prior 500 until block 400.
    // Envelope: 500 now → 500 at 200 (B still binds) → 0 at 400.
    const tranches = voteLockTranches(500n, [cls(0n, 200, 300n), cls(0n, 400, 500n)], 100)
    expect(tranches).toEqual([{ state: 'scheduled', amount: 500n, untilBlock: 400 }])
  })

  it('separates the releasable, scheduled and open-ended parts', () => {
    // Lock 1000; expired prior (600, already past), a future prior of 500 at
    // block 300, and an active vote holding 200 open-ended.
    const tranches = voteLockTranches(1000n, [cls(0n, 50, 600n), cls(0n, 300, 500n), cls(200n, 0, 0n)], 100)
    expect(tranches).toEqual([
      { state: 'releasable', amount: 500n },
      { state: 'scheduled', amount: 300n, untilBlock: 300 },
      { state: 'active', amount: 200n },
    ])
  })

  it('a stepped release across classes drops in date order and sums to the lock', () => {
    // Priors 800@200, 500@400, 200@600 (overlapping): drops of 300, 300, 200.
    const tranches = voteLockTranches(800n, [cls(0n, 200, 800n), cls(0n, 400, 500n), cls(0n, 600, 200n)], 100)
    expect(tranches).toEqual([
      { state: 'scheduled', amount: 300n, untilBlock: 200 },
      { state: 'scheduled', amount: 300n, untilBlock: 400 },
      { state: 'scheduled', amount: 200n, untilBlock: 600 },
    ])
    const sum = tranches.reduce((s, t) => s + t.amount, 0n)
    expect(sum).toBe(800n)
  })

  it('lock with no voting state is fully releasable', () => {
    expect(voteLockTranches(100n, [], 100)).toEqual([{ state: 'releasable', amount: 100n }])
  })
})

describe('gigahdx unstake tranches', () => {
  it('matured unstakes are releasable, pending scheduled, rest staked', () => {
    const tranches = gigaUnstakeTranches(1000n, [
      { expiryBlock: 90, payoutRaw: 100n },
      { expiryBlock: 500, payoutRaw: 300n },
    ], 100)
    expect(tranches).toEqual([
      { state: 'releasable', amount: 100n },
      { state: 'scheduled', amount: 300n, untilBlock: 500 },
      { state: 'active', amount: 600n },
    ])
  })
})

describe('vesting tranches', () => {
  it('splits claimable-now from the linear tail', () => {
    expect(vestingTranches(1000n, 400n, 12345)).toEqual([
      { state: 'releasable', amount: 400n },
      { state: 'scheduled', amount: 600n, untilBlock: 12345, linear: true },
    ])
  })
})

describe('mergeTranches (tag aggregation)', () => {
  it('sums per state and per release date across accounts', () => {
    const a = JSON.stringify([{ state: 'releasable', amount: '100' }, { state: 'scheduled', amount: '200', until: '2026-08-01 00:00:00' }])
    const b = JSON.stringify([{ state: 'scheduled', amount: '50', until: '2026-08-01 00:00:00' }, { state: 'active', amount: '25' }])
    expect(mergeTranches([a, b], 375n)).toEqual([
      { state: 'releasable', amount: '100' },
      { state: 'scheduled', amount: '250', until: '2026-08-01 00:00:00' },
      { state: 'active', amount: '25' },
    ])
  })

  it('keeps uncovered amount open-ended instead of dropping it', () => {
    const a = JSON.stringify([{ state: 'releasable', amount: '100' }])
    expect(mergeTranches([a], 150n)).toEqual([
      { state: 'releasable', amount: '100' },
      { state: 'active', amount: '50' },
    ])
  })

  it('folds a long tail of release dates into the latest tranche', () => {
    const details = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify([{ state: 'scheduled', amount: '10', until: `2026-0${(i % 9) + 1}-01 00:00:00`, linear: true }]))
    const merged = mergeTranches(details, 90n)
    expect(merged.length).toBe(6)
    expect(merged[5]).toEqual({ state: 'scheduled', amount: '40', until: '2026-09-01 00:00:00', linear: true })
  })
})

describe('buildBindingTimeline (cross-lock binding schedule)', () => {
  const NOW = 1_000_000
  const flat = (source: string, onchain: bigint): TimelineSource =>
    ({ source, onchain, open: onchain, steps: [], env: () => onchain })
  // Act-now instant exit (Hydration staking): binds nothing past the snapshot.
  const instant = (source: string, onchain: bigint): TimelineSource =>
    ({ source, onchain, open: 0n, steps: [], env: () => 0n })
  const dated = (source: string, onchain: bigint, drops: [number, bigint, boolean?][], open = 0n): TimelineSource => ({
    source, onchain, open,
    steps: drops.map(([atMs, , conditional]) => ({ atMs, ...(conditional ? { conditional: true } : {}) })),
    // envelope = open floor + every dated portion not yet released
    env: t => drops.reduce((s, [atMs, amount]) => s + (atMs > t ? amount : 0n), open),
  })

  it('a releasable vote lock frees NOTHING while a delegation still binds the same tokens', () => {
    // vote 350 fully unlockable (no active/prior), democracy delegation 350
    // open-ended: the account-level truth is 350 open-ended.
    const timeline = buildBindingTimeline([dated('vote', 350n, []), flat('democracy', 350n)], NOW)
    expect(timeline).toEqual([{ state: 'active', cause: 'democracy', amount: 350n }])
  })

  it('instant-exit staking lands in the releasable slice, not an open floor', () => {
    const timeline = buildBindingTimeline([instant('staking', 350n)], NOW)
    expect(timeline).toEqual([{ state: 'releasable', cause: 'staking', amount: 350n }])
  })

  it('slices release in date order, attributed to the lock that was binding', () => {
    // vote: 1000 total — 400 drops at t=2M, 600 at t=3M; elections: 500 stuck.
    const timeline = buildBindingTimeline([
      dated('vote', 1000n, [[2_000_000, 400n], [3_000_000, 600n]]),
      flat('elections', 500n),
    ], NOW)
    expect(timeline).toEqual([
      { state: 'scheduled', cause: 'vote', amount: 400n, untilMs: 2_000_000, linear: undefined, conditional: undefined },
      { state: 'scheduled', cause: 'vote', amount: 100n, untilMs: 3_000_000, linear: undefined, conditional: undefined },
      // The stuck elections floor is ALSO covered by the vote's dated locks
      // until 3M — its not-before date reflects that.
      { state: 'active', cause: 'elections', amount: 500n, untilMs: 3_000_000 },
    ])
    // total = frozen (max lock), never the sum of locks
    expect(timeline.reduce((s, t) => s + t.amount, 0n)).toBe(1000n)
  })

  // A still-cast vote: soft floor (act-now removable), dated priors optional.
  const softVote = (onchain: bigint, open: bigint, priors: [number, bigint][]): TimelineSource => ({
    source: 'vote', onchain, open, soft: true,
    steps: priors.map(([atMs]) => ({ atMs })),
    env: t => priors.reduce((m, [atMs, amount]) => { const p = atMs > t ? amount : 0n; return p > m ? p : m }, open),
    envDated: t => priors.reduce((m, [atMs, amount]) => { const p = atMs > t ? amount : 0n; return p > m ? p : m }, 0n),
  })

  it('a still-cast vote fully covered by other locks is not shown at all', () => {
    // GIGAHDX staked 700 (conditional step at 2M) covers the ongoing vote 500:
    // the vote appears nowhere — the whole 700 frees at the conditional step.
    const timeline = buildBindingTimeline([
      dated('gigahdx', 700n, [[2_000_000, 700n, true]]),
      softVote(500n, 500n, []),
    ], NOW)
    expect(timeline).toEqual([
      { state: 'scheduled', cause: 'gigahdx', amount: 700n, untilMs: 2_000_000, linear: undefined, conditional: true },
    ])
  })

  it('a still-cast vote covered by its own conviction priors shows as the dated prior only', () => {
    // The 12VN case: ongoing 5x vote of the same amount as the 6x priors —
    // no "open votes", just the dated conviction lock.
    const timeline = buildBindingTimeline([softVote(500n, 500n, [[3_000_000, 500n], [5_000_000, 500n]])], NOW)
    expect(timeline).toEqual([
      { state: 'scheduled', cause: 'vote', amount: 500n, untilMs: 5_000_000, linear: undefined, conditional: undefined },
    ])
  })

  it('an ongoing vote shows open only for the amount exceeding all coverage', () => {
    // Ongoing vote 500, priors cover only 100 until 3M: 400 is genuinely open,
    // the covered 100 frees at the prior date.
    const timeline = buildBindingTimeline([softVote(500n, 500n, [[3_000_000, 100n]])], NOW)
    expect(timeline).toEqual([
      { state: 'active', cause: 'vote', amount: 400n },
      { state: 'scheduled', cause: 'vote', amount: 100n, untilMs: 3_000_000, linear: undefined, conditional: undefined },
    ])
  })

  it('a purely ongoing vote (no priors) is open-ended, never "releasable"', () => {
    const timeline = buildBindingTimeline([softVote(500n, 500n, [])], NOW)
    expect(timeline).toEqual([{ state: 'active', cause: 'vote', amount: 500n }])
  })

  it('releasable-now is the gap between the on-chain lock and today\'s envelope', () => {
    const timeline = buildBindingTimeline([dated('vote', 900n, [[2_000_000, 300n]])], NOW)
    expect(timeline).toEqual([
      { state: 'releasable', cause: 'vote', amount: 600n },
      { state: 'scheduled', cause: 'vote', amount: 300n, untilMs: 2_000_000, linear: undefined, conditional: undefined },
    ])
  })

  it('ties on the open floor join causes', () => {
    const timeline = buildBindingTimeline([flat('elections', 200n), flat('democracy', 200n)], NOW)
    expect(timeline).toEqual([{ state: 'active', cause: 'elections+democracy', amount: 200n }])
  })

  it('a hard open floor carries the not-before date of dated locks underneath', () => {
    // A hard floor (e.g. legacy delegation) holds 500 open-ended; dated locks hold the SAME 500
    // until t=3M and t=5M: the residual can't free before t=5M.
    const vote: TimelineSource = {
      source: 'vote', onchain: 500n, open: 500n,
      steps: [{ atMs: 3_000_000 }, { atMs: 5_000_000 }],
      env: () => 500n,
      envDated: t => (t < 5_000_000 ? 500n : t < 3_000_000 ? 500n : 0n),
    }
    const timeline = buildBindingTimeline([vote], NOW)
    expect(timeline).toEqual([{ state: 'active', cause: 'vote', amount: 500n, untilMs: 5_000_000 }])
  })

  it('no not-before date when the dated coverage is below the open floor', () => {
    const vote: TimelineSource = {
      source: 'vote', onchain: 500n, open: 500n,
      steps: [{ atMs: 3_000_000 }],
      env: () => 500n,
      envDated: t => (t < 3_000_000 ? 100n : 0n), // priors only cover 100
    }
    const timeline = buildBindingTimeline([vote], NOW)
    expect(timeline).toEqual([{ state: 'active', cause: 'vote', amount: 500n }])
  })
})

describe('mergeTimelines (tag aggregation)', () => {
  it('sums per cause and release date, keeps time order, fills uncovered as open-ended', () => {
    const a = JSON.stringify([
      { state: 'releasable', cause: 'vote', amount: '100' },
      { state: 'scheduled', cause: 'vote', amount: '200', until: '2026-08-01 00:00:00' },
    ])
    const b = JSON.stringify([
      { state: 'scheduled', cause: 'gigahdx', amount: '50', until: '2026-07-25 00:00:00' },
      { state: 'active', cause: 'staking', amount: '25' },
    ])
    expect(mergeTimelines([a, b], 400n)).toEqual([
      { state: 'releasable', cause: 'vote', amount: '100' },
      { state: 'scheduled', cause: 'gigahdx', amount: '50', until: '2026-07-25 00:00:00' },
      { state: 'scheduled', cause: 'vote', amount: '200', until: '2026-08-01 00:00:00' },
      { state: 'active', cause: 'staking', amount: '25' },
      { state: 'active', cause: 'other', amount: '25' },
    ])
  })
})

describe('attachLockBreakdowns', () => {
  const asset = (assetId: number, decimals: number, symbol: string) => ({ assetId, iconAssetId: assetId, symbol, name: symbol, decimals, parachainId: 0, origin: null })
  const balance = (assetId: number, decimals: number, symbol: string): AddressBalance => ({
    asset: asset(assetId, decimals, symbol), total: '1000', free: '900', reserved: '100', lastBlock: 1, valueUsd: null,
  })

  it('attaches components and frozen to the matching display row', () => {
    const balances = [balance(0, 12, 'HDX'), balance(5, 10, 'DOT')]
    const out = attachLockBreakdowns(balances, new Map([[0, {
      assetId: 0, frozen: '350',
      components: [
        { kind: 'lock' as const, source: 'vesting', amount: '350', claimable: '50' },
        { kind: 'reserve' as const, source: 'dca', amount: '100' },
      ],
    }]]))
    expect(out[0].frozen).toBe('350')
    expect(out[0].breakdown).toEqual([
      { kind: 'lock', source: 'vesting', amount: '350', claimable: '50' },
      { kind: 'reserve', source: 'dca', amount: '100' },
    ])
    expect(out[1].frozen).toBeUndefined()
    expect(out[1].breakdown).toBeUndefined()
  })

  it('leaves rows untouched when there is no breakdown', () => {
    const balances = [balance(0, 12, 'HDX')]
    expect(attachLockBreakdowns(balances, new Map())).toBe(balances)
  })
})
