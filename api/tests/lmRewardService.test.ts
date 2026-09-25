import { describe, expect, it } from 'vitest'
import { u8aConcat, u8aToHex } from '@polkadot/util'
import { blake2128Concat, storagePrefix, twox64Concat, u32Le } from '../src/services/chainPrimitives.ts'
import { FIXED_ONE, type FarmEntry, type GlobalFarmData, type YieldFarmData } from '../src/services/lmRewardMath.ts'
import {
  belowEdCode, belowEdOwnerKeys, buildLmRewardRows, depositFromPrimitive, depositIdFromKey, globalFarmFromPrimitive, globalFarmIdFromKey,
  lmRewardChecksumFields, projectActiveFarms, readOwnerFreeBalances, withOwnerBalances, yieldFarmFromPrimitive, yieldFarmKeyParts,
  type LmChainState, type LmYieldFarm,
} from '../src/services/lmRewardService.ts'

const u128Le = (n: bigint): Uint8Array => {
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn)
  return out
}
const hexKey = (...parts: (string | Uint8Array)[]): string =>
  u8aToHex(u8aConcat(...parts.map(p => (typeof p === 'string' ? Uint8Array.from(Buffer.from(p.slice(2), 'hex')) : p))))

describe('storage keys', () => {
  it('reads the deposit id from a Twox64Concat u128 key', () => {
    const key = hexKey(storagePrefix('OmnipoolWarehouseLM', 'Deposit'), twox64Concat(u128Le(77_425n)))
    expect(depositIdFromKey(key)).toBe('77425')
    expect(() => depositIdFromKey(key.slice(0, -2))).toThrow()
  })

  it('reads the global farm id from a Blake2_128Concat u32 key', () => {
    expect(globalFarmIdFromKey(hexKey(storagePrefix('XYKWarehouseLM', 'GlobalFarm'), blake2128Concat(u32Le(133))))).toBe(133)
  })

  it('reads pool, global farm and yield farm from the three-part key of either instance', () => {
    const omni = hexKey(storagePrefix('OmnipoolWarehouseLM', 'YieldFarm'), blake2128Concat(u32Le(222)), blake2128Concat(u32Le(133)), blake2128Concat(u32Le(139)))
    expect(yieldFarmKeyParts(omni, 4)).toEqual({ poolKey: '222', globalFarmId: 133, yieldFarmId: 139 })
    const pool = new Uint8Array(32).fill(0xab)
    const xyk = hexKey(storagePrefix('XYKWarehouseLM', 'YieldFarm'), blake2128Concat(pool), blake2128Concat(u32Le(1)), blake2128Concat(u32Le(2)))
    expect(yieldFarmKeyParts(xyk, 32)).toEqual({ poolKey: `0x${'ab'.repeat(32)}`, globalFarmId: 1, yieldFarmId: 2 })
    // A key of the other instance's width is refused, not misread.
    expect(() => yieldFarmKeyParts(xyk, 4)).toThrow()
  })
})

describe('decoded values → records', () => {
  it('maps a polkadot-js primitive exactly, big numbers as strings included', () => {
    const deposit = depositFromPrimitive({
      shares: '340282366920938463463374607431768211455', ammPoolId: 222,
      yieldFarmEntries: [{ globalFarmId: 133, yieldFarmId: 139, valuedShares: '19436274302104777', accumulatedRpvs: 12, accumulatedClaimedRewards: 0, enteredAt: 33_000_000, updatedAt: 33_000_000, stoppedAtCreation: 0 }],
    })
    expect(deposit.shares).toBe((1n << 128n) - 1n)
    expect(deposit.entries[0]).toEqual({ globalFarmId: 133, yieldFarmId: 139, valuedShares: 19_436_274_302_104_777n, accumulatedRpvs: 12n, accumulatedClaimedRewards: 0n, enteredAt: 33_000_000, updatedAt: 33_000_000, stoppedAtCreation: 0 })
    const yf = yieldFarmFromPrimitive({
      id: 139, updatedAt: 1, totalShares: 2, totalValuedShares: 3, accumulatedRpvs: 4, accumulatedRpz: 5,
      loyaltyCurve: { initialRewardPercentage: '250000000000000000', scaleCoef: 12000 }, multiplier: '1000000000000000000',
      state: 'Stopped', entriesCount: 7, leftToDistribute: 8, totalStopped: 9,
    })
    expect(yf.state).toBe('stopped')
    expect(yf.loyaltyCurve).toEqual({ initialRewardPercentage: 250_000_000_000_000_000n, scaleCoef: 12000 })
    expect(yieldFarmFromPrimitive({ ...yf, loyaltyCurve: null, state: 'Active' } as never).loyaltyCurve).toBeNull()
    const gf = globalFarmFromPrimitive({
      id: 133, updatedAt: 1, totalSharesZ: 2, accumulatedRpz: 3, rewardCurrency: 222, pendingRewards: 4, accumulatedPaidRewards: 5,
      yieldPerPeriod: '1000000000', blocksPerPeriod: 1, incentivizedAsset: 222, maxRewardPerPeriod: 6, priceAdjustment: '1000000000000000000', state: 'Active',
    })
    expect(gf).toMatchObject({ rewardCurrency: 222, yieldPerPeriod: 1_000_000_000n, state: 'active' })
  })

  it('refuses a value that is not an unsigned integer rather than reading it as zero', () => {
    expect(() => depositFromPrimitive({ shares: '-1', yieldFarmEntries: [] })).toThrow()
    expect(() => yieldFarmFromPrimitive({ state: 'Paused' } as never)).toThrow()
  })
})

const OWNER = `0x${'61'.repeat(32)}`
const gf = (over: Partial<GlobalFarmData> = {}): GlobalFarmData => ({
  id: 1, updatedAt: 100, totalSharesZ: 1n, accumulatedRpz: 0n, rewardCurrency: 5, pendingRewards: 0n, accumulatedPaidRewards: 0n,
  yieldPerPeriod: 1n, blocksPerPeriod: 1, incentivizedAsset: 5, maxRewardPerPeriod: 1n, priceAdjustment: FIXED_ONE, state: 'active', ...over,
})
const yfData = (over: Partial<YieldFarmData> = {}): YieldFarmData => ({
  id: 2, updatedAt: 100, totalShares: 1n, totalValuedShares: 1n, accumulatedRpvs: 10n * FIXED_ONE, accumulatedRpz: 0n,
  loyaltyCurve: null, multiplier: FIXED_ONE, state: 'active', entriesCount: 1n, leftToDistribute: 0n, totalStopped: 0, ...over,
})
const entry = (over: Partial<FarmEntry> = {}): FarmEntry => ({
  globalFarmId: 1, yieldFarmId: 2, valuedShares: 100n, accumulatedRpvs: 4n * FIXED_ONE, accumulatedClaimedRewards: 50n,
  enteredAt: 50, updatedAt: 50, stoppedAtCreation: 0, ...over,
})
function chainState(yf: YieldFarmData, entries: FarmEntry[] = [entry()], relayParentNumber = 110): LmChainState {
  const lmYf: LmYieldFarm = { pallet: 'omnipool', poolKey: '5', globalFarmId: 1, farm: yf }
  return {
    blockHeight: 9_000, blockHash: '0x01', relayParentNumber,
    deposits: [{ pallet: 'omnipool', depositId: '77', shares: 1_000n, entries }],
    yieldFarms: new Map([['omnipool:1:2', lmYf]]),
    globalFarms: new Map([['omnipool:1', gf()]]),
    depositPools: new Map([['omnipool:77', '5']]),
    rewardEds: new Map([[5, 100n]]),
    inconsistent: [],
  }
}

describe('buildLmRewardRows', () => {
  const owners = new Map([['omnipool:77', OWNER]])
  const positions = new Map([['77', '4712']])

  it('prices an active farm behind the head at the runtime-projected rpvs', () => {
    const { rows, unowned } = buildLmRewardRows(chainState(yfData()), owners, new Map([['omnipool:1:2', { rpvs: 12n * FIXED_ONE, probeDepositId: '77', probeClaimed: 750n }]]), positions, new Map())
    expect(unowned).toBe(0)
    expect(rows).toHaveLength(1)
    // settled: (10 − 4) · 100 − 50 claimed; projected: (12 − 4) · 100 − 50.
    expect(rows[0]).toMatchObject({ accountId: OWNER, positionId: '4712', claimableSettledRaw: 550n, claimableProjectedRaw: 750n, rpvsProjected: 12n * FIXED_ONE, currentPeriod: 110, farmUpdatedAtPeriod: 100, rewardAssetId: 5 })
  })

  it('publishes no projection — never an estimate — when the dry-run failed', () => {
    const { rows } = buildLmRewardRows(chainState(yfData()), owners, new Map(), positions, new Map())
    expect(rows[0]).toMatchObject({ claimableSettledRaw: 550n, claimableProjectedRaw: null, rpvsProjected: null })
  })

  it('treats a stopped farm, and an active one synced this period, as exact at the head', () => {
    expect(buildLmRewardRows(chainState(yfData({ state: 'stopped' })), owners, new Map(), positions, new Map()).rows[0])
      .toMatchObject({ claimableSettledRaw: 550n, claimableProjectedRaw: 550n, farmState: 'stopped' })
    expect(buildLmRewardRows(chainState(yfData({ updatedAt: 110 })), owners, new Map(), positions, new Map()).rows[0])
      .toMatchObject({ claimableProjectedRaw: 550n })
    expect(buildLmRewardRows(chainState(yfData({ state: 'terminated' })), owners, new Map(), positions, new Map()).rows[0])
      .toMatchObject({ claimableSettledRaw: 0n, claimableProjectedRaw: 0n })
  })

  it('counts a deposit the indexer has no owner for yet', () => {
    expect(buildLmRewardRows(chainState(yfData()), new Map(), new Map(), positions, new Map())).toEqual({ rows: [], unowned: 1, inconsistent: [] })
  })

  it('skips and counts an entry it cannot price, publishing the others', () => {
    const state = chainState(yfData(), [entry({ yieldFarmId: 9 }), entry(), entry({ enteredAt: 200 })])
    const { rows, inconsistent } = buildLmRewardRows(state, owners, new Map([['omnipool:1:2', { rpvs: 12n * FIXED_ONE, probeDepositId: '77', probeClaimed: 750n }]]), positions, new Map())
    expect(rows).toHaveLength(1)
    expect(inconsistent).toHaveLength(2)
    expect(inconsistent[0]).toMatch(/names missing farm omnipool:1:9/)
    expect(inconsistent[1]).toMatch(/invalid entry period/)
  })

  // A claim below the reward asset's ED is paid only to an owner already holding
  // that much; the flag is on the PUBLISHED (projected) amount.
  it('flags a claimable below the reward asset existential deposit, still counting it', () => {
    const state = chainState(yfData())
    state.rewardEds.set(5, 600n)
    const projection = new Map([['omnipool:1:2', { rpvs: 12n * FIXED_ONE, probeDepositId: '77', probeClaimed: 750n }]])
    // Projected 750 ≥ 600 although the settled 550 is below it: the published amount decides.
    expect(buildLmRewardRows(state, owners, projection, positions, new Map()).rows[0]).toMatchObject({ claimableSettledRaw: 550n, claimableProjectedRaw: 750n, belowEd: false })
    // Unprojected, the settled 550 is what is published — and it is below.
    expect(buildLmRewardRows(state, owners, new Map(), positions, new Map()).rows[0]).toMatchObject({ claimableProjectedRaw: null, belowEd: true })
    // Nothing to claim is not "below ED".
    expect(buildLmRewardRows(chainState(yfData({ state: 'terminated' })), owners, new Map(), positions, new Map()).rows[0].belowEd).toBe(false)
  })

  // The pallet's own rule (claim_rewards: rewards < ed && free_balance(who) < ed →
  // treasury): a below-ED entry is payable only while its owner holds the deposit.
  it('decides a below-ED entry\'s payability from the owner\'s free balance of the reward asset', () => {
    const state = chainState(yfData())
    state.rewardEds.set(5, 600n)
    const { rows } = buildLmRewardRows(state, owners, new Map(), positions, new Map())
    expect(rows[0]).toMatchObject({ belowEd: true, payable: true })
    expect(belowEdOwnerKeys(rows)).toEqual([`${OWNER}|5`])
    expect(withOwnerBalances(rows, new Map([[`${OWNER}|5`, 599n]]), state.rewardEds)[0].payable).toBe(false)
    expect(withOwnerBalances(rows, new Map([[`${OWNER}|5`, 600n]]), state.rewardEds)[0].payable).toBe(true)
    // An unread balance is not a zero one.
    expect(() => withOwnerBalances(rows, new Map(), state.rewardEds)).toThrow(/no owner balance/)
    // Stored as the three-state below_ed code, and a change republishes.
    const unpayable = withOwnerBalances(rows, new Map([[`${OWNER}|5`, 0n]]), state.rewardEds)[0]
    expect([belowEdCode({ belowEd: false, payable: true }), belowEdCode(rows[0]), belowEdCode(unpayable)]).toEqual([0, 1, 2])
    expect(lmRewardChecksumFields(unpayable)).not.toBe(lmRewardChecksumFields(rows[0]))
    // Above the deposit no balance is read at all.
    const above = buildLmRewardRows(chainState(yfData()), owners, new Map(), positions, new Map()).rows
    expect(belowEdOwnerKeys(above)).toEqual([])
    expect(withOwnerBalances(above, new Map(), state.rewardEds)[0].payable).toBe(true)
  })

  it('reads owner balances through the runtime\'s CurrenciesApi.free_balance and fails on a missing API', async () => {
    const calls: Array<[number, string]> = []
    const at = { call: { currenciesApi: { freeBalance: async (asset: number, who: string) => { calls.push([asset, who]); return { toString: () => (asset === 69 ? '0' : '1000') } } } } }
    const out = await readOwnerFreeBalances(at as never, [`${OWNER}|0`, `${OWNER}|69`])
    expect(out).toEqual(new Map([[`${OWNER}|0`, 1000n], [`${OWNER}|69`, 0n]]))
    expect(calls.sort()).toEqual([[0, OWNER], [69, OWNER]])
    await expect(readOwnerFreeBalances({ call: {} } as never, [`${OWNER}|0`])).rejects.toThrow(/CurrenciesApi/)
    expect(await readOwnerFreeBalances({ call: {} } as never, [])).toEqual(new Map())
  })

  // With a loyalty curve the head projection also moves the loyalty: the entry
  // has been rewarded for more periods at the head than at the farm's last sync.
  it('prices loyalty at the projected period, not the stored one', () => {
    const curve = { initialRewardPercentage: FIXED_ONE / 2n, scaleCoef: 100 }
    const { rows } = buildLmRewardRows(chainState(yfData({ loyaltyCurve: curve })), owners, new Map([['omnipool:1:2', { rpvs: 12n * FIXED_ONE, probeDepositId: '77', probeClaimed: 0n }]]), positions, new Map())
    // settled: 50 periods → (50 + 50)/150 = 0.666…; gross 600 → floor(400.0) = 399 (the fixed floors) − 50.
    // projected: 60 periods → (60 + 50)/160 = 0.6875; gross 800 → 550 − 50.
    expect(rows[0]).toMatchObject({ periods: 60, loyalty: 687_500_000_000_000_000n, claimableProjectedRaw: 500n })
    expect(rows[0].claimableSettledRaw).toBe(349n)
  })
})

// A block decoration just rich enough for projectActiveFarms: the metadata the
// claim call is built from, the origin type, and a scripted DryRunApi.
function fakeAt(results: Array<{ ok: boolean; claimed?: bigint; rpvs?: bigint }>) {
  const calls: unknown[] = []
  const ev = (section: string, method: string, data: (bigint | number | string)[]) => ({ section, method, data: data.map(d => ({ toString: () => String(d) })) })
  const at = {
    registry: {
      metadata: { pallets: [{ name: { toString: () => 'OmnipoolLiquidityMining' }, index: { toNumber: () => 63 }, calls: { isSome: true, unwrap: () => ({ type: 1 }) } }] },
      lookup: { getSiType: () => ({ def: { asVariant: { variants: [{ name: { toString: () => 'claim_rewards' }, index: { toNumber: () => 10 }, fields: [{}, {}] }] } } }) },
      createType: (type: string, value: unknown) => ({ type, value }),
    },
    call: {
      dryRunApi: {
        dryRunCall: async (origin: unknown, call: unknown) => {
          calls.push({ origin, call })
          const r = results[calls.length - 1] ?? { ok: false }
          return {
            isOk: true,
            asOk: {
              executionResult: { isOk: r.ok },
              emittedEvents: r.ok ? [
                ev('omnipoolWarehouseLM', 'YieldFarmAccRPVSUpdated', [1, 2, r.rpvs ?? 0n, 1]),
                ev('omnipoolLiquidityMining', 'RewardClaimed', [1, 2, OWNER, r.claimed ?? 0n, 5, 77]),
              ] : [],
            },
          }
        },
      },
    },
  }
  return { at: at as never, calls }
}

describe('projectActiveFarms', () => {
  const owners = new Map([['omnipool:77', OWNER], ['omnipool:78', OWNER]])
  const twoEntries = (): LmChainState => {
    const s = chainState(yfData({ entriesCount: 2n }))
    s.deposits.push({ pallet: 'omnipool', depositId: '78', shares: 1n, entries: [entry({ valuedShares: 10n, accumulatedClaimedRewards: 0n })] })
    return s
  }

  it('takes the rpvs of the first probe claim the runtime pays, after checking our number against it', async () => {
    // First probe (the larger entry, deposit 77) fails; the second pays (12 − 4) · 10 = 80.
    const { at, calls } = fakeAt([{ ok: false }, { ok: true, rpvs: 12n * FIXED_ONE, claimed: 80n }])
    const out = await projectActiveFarms(at, twoEntries(), owners)
    expect(out.projections.get('omnipool:1:2')).toEqual({ rpvs: 12n * FIXED_ONE, probeDepositId: '78', probeClaimed: 80n })
    expect(out.failures.size).toBe(0)
    expect(out.dryRuns).toBe(2)
    expect((calls[0] as { call: { value: { callIndex: number[]; args: unknown } } }).call.value)
      .toEqual({ callIndex: [63, 10], args: { deposit_id: '77', yield_farm_id: 2 } })
  })

  it('discards the projection when the runtime paid a different amount than we compute', async () => {
    const { at } = fakeAt([{ ok: true, rpvs: 12n * FIXED_ONE, claimed: 751n }])
    const out = await projectActiveFarms(at, chainState(yfData()), owners)
    expect(out.projections.size).toBe(0)
    expect(out.failures.get('omnipool:1:2')).toMatch(/self-check failed on deposit 77: runtime 751, computed 750/)
  })

  it('dry-runs nothing for a farm that cannot accrue or is synced this period', async () => {
    for (const farm of [yfData({ state: 'stopped' }), yfData({ updatedAt: 110 }), yfData({ state: 'terminated' })]) {
      const { at, calls } = fakeAt([])
      const out = await projectActiveFarms(at, chainState(farm), owners)
      expect(calls).toHaveLength(0)
      expect(out.failures.size + out.projections.size).toBe(0)
    }
  })

  it('never probes an entry already claimed this period (the pallet refuses a double claim)', async () => {
    const { at, calls } = fakeAt([])
    const out = await projectActiveFarms(at, chainState(yfData(), [entry({ updatedAt: 110 })]), owners)
    expect(calls).toHaveLength(0)
    expect(out.failures.get('omnipool:1:2')).toBe('no claimable probe entry')
  })
})

describe('persistLmRewardSnapshot', () => {
  it('writes the generation, verifies it, flips the pointer last and drops the superseded partition', async () => {
    const { persistLmRewardSnapshot } = await import('../src/services/lmRewardService.ts')
    const { rows } = buildLmRewardRows(chainState(yfData()), new Map([['omnipool:77', OWNER]]), new Map(), new Map([['77', '4712']]), new Map())
    const log: string[] = []
    let inserted = 0
    const client = {
      query: async ({ query }: { query: string }) => ({
        json: async () => {
          if (query.includes('lm_reward_snapshot_state')) { log.push('pointer?'); return [] }
          if (query.includes('uniqExact')) { log.push('verify'); return [{ c: String(inserted), u: String(inserted) }] }
          if (query.includes('system.parts')) { log.push('parts'); return [{ partition: '1' }] }
          return []
        },
      }),
      insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => {
        log.push(`insert ${table}`)
        if (table.endsWith('lm_reward_snapshots')) {
          inserted += values.length
          // Nullable columns go out as null, integers as exact decimal strings.
          expect(values[0]).toMatchObject({ rpvs_projected: null, claimable_projected_raw: null, claimable_settled_raw: '550', lp_asset_id: null, position_id: '4712' })
        }
      },
      command: async ({ query }: { query: string }) => { log.push(query.startsWith('ALTER') ? 'drop' : query) },
    }
    const out = await persistLmRewardSnapshot(client as never, rows, { blockHeight: 9_000, blockHash: '0x01', relayHeight: 110, projectedFarms: 0, unprojectedFarms: 1 })
    expect(out).toBe('republished')
    expect(log).toEqual(['pointer?', 'insert price_data.lm_reward_snapshots', 'verify', 'insert price_data.lm_reward_snapshot_state', 'parts', 'drop'])
  })
})
