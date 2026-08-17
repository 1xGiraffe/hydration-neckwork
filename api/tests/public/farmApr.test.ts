import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Liquidity-mining (farm) APR. The pinned numbers below come from the pallet's
// own reward rule as the Hydration SDK implements it (LiquidityMiningApi.farmData),
// not from this implementation's output:
//
//   periodsPerYear = 365.2425 d / (6 s · blocksPerPeriod)
//   uncapped       = 100 · multiplier · yieldPerPeriod · periodsPerYear
//   capped         = 100 · maxRewardPerPeriod · periodsPerYear
//                          · rewardPrice / farmedValueUsd
//   apr            = min(uncapped, capped)
//
// The capped branch carries no multiplier because the pallet's total_shares_z is
// Σ(valued_shares · multiplier): with one yield farm per global farm the factor
// appears on both sides and cancels.
//
// The `min` is the pallet's `max_reward_per_period` ceiling: the global reward of a
// period is `total_shares_z · price_adjustment · yield_per_period` CAPPED at
// `max_reward_per_period`, and dividing that by the same stake cancels the stake in
// the uncapped branch. So an under-subscribed farm pays its full yield rate and an
// over-subscribed one splits a fixed budget.
type Row = Record<string, unknown>

function result(rows: Row[]) {
  return { json: vi.fn(async () => rows) }
}

const ASSET_ROWS: Row[] = [
  { asset_id: 0, symbol: 'HDX', name: 'HDX', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1, symbol: 'H2O', name: 'H2O', decimals: 12, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 5, symbol: 'DOT', name: 'Polkadot', decimals: 10, parachain_id: 0, origin_ecosystem: 'polkadot', origin_chain_id: '0', origin_asset_id: null },
  { asset_id: 222, symbol: 'HOLLAR', name: 'Hydrated Dollar', decimals: 18, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
  { asset_id: 1001, symbol: 'aDOT', name: 'aDOT', decimals: 10, parachain_id: null, origin_ecosystem: null, origin_chain_id: null, origin_asset_id: null },
]

const ANCHOR = '2026-08-12 18:22:36'

interface Seen { query: string; params: Record<string, unknown> }

function fakeClient(byMarker: Record<string, Row[]> = {}) {
  const seen: Seen[] = []
  return {
    seen,
    query: vi.fn(({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query, params: query_params ?? {} })
      if (query.includes('FROM price_data.assets FINAL')) return result(ASSET_ROWS)
      if (query.includes('Bonds.TokenCreated')) return result([])
      for (const [marker, rows] of Object.entries(byMarker)) {
        if (query.includes(marker)) return result(rows)
      }
      throw new Error(`unexpected query: ${query.slice(0, 160)}`)
    }),
  }
}

let stopAssets: () => void

beforeAll(async () => {
  const { loadExplorerAssets, stopExplorerAssetsRefresh } = await import('../../src/services/explorerAssets.ts')
  await loadExplorerAssets(fakeClient() as never)
  stopAssets = stopExplorerAssetsRefresh
})

afterAll(() => { stopAssets?.() })

// The six farms Hydration created in one block on 2026-04-27, in the exact arg
// shapes `farm_config_events.args_json` carries (OmnipoolLiquidityMining events).
const GLOBAL_ARGS = JSON.stringify({
  id: 133,
  owner: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000',
  totalRewards: '126000000000000000000000',
  rewardCurrency: 222,
  yieldPerPeriod: '41856925419',
  plannedYieldingPeriods: 2628000,
  blocksPerPeriod: 1,
  maxRewardPerPeriod: '47945205479452054',
  minDeposit: '1326259946950',
  lrnaPriceAdjustment: '754000000000000000000',
})
const YIELD_ARGS = JSON.stringify({
  globalFarmId: 133,
  yieldFarmId: 139,
  assetId: 222,
  multiplier: '1000000000000000000',
  loyaltyCurve: { initialRewardPercentage: '250000000000000000', scaleCoef: 12000 },
})

// Global farm 59 / yield farm 60 on asset 15 (vDOT): created 2024-06-29 with a
// 1 314 000-period schedule, so its planned end is 2024-09-28 — long past.
const OLD_FARM_ROWS: Row[] = [
  {
    event_name: 'GlobalFarmCreated', global_farm_id: '59', yield_farm_id: '',
    block_height: '5300000', event_index: '1', block_timestamp: '2024-06-29 11:58:36',
    args_json: JSON.stringify({
      id: 59, owner: '0x', totalRewards: '100000000000000000', rewardCurrency: 14,
      yieldPerPeriod: '7610350076', plannedYieldingPeriods: 1314000, blocksPerPeriod: 1,
      maxRewardPerPeriod: '76103500761', minDeposit: '1', lrnaPriceAdjustment: '1',
    }),
  },
  {
    event_name: 'YieldFarmCreated', global_farm_id: '59', yield_farm_id: '60',
    block_height: '5300000', event_index: '2', block_timestamp: '2024-06-29 11:58:36',
    args_json: JSON.stringify({ globalFarmId: 59, yieldFarmId: 60, assetId: 15, multiplier: '1000000000000000000' }),
  },
]

function cfgRow(event: string, args: string, over: Partial<Row> = {}): Row {
  return {
    event_name: event,
    global_farm_id: '133',
    yield_farm_id: event.startsWith('Yield') ? '139' : '',
    block_height: '12228202',
    event_index: '10',
    block_timestamp: '2026-04-27 09:10:36',
    args_json: args,
    ...over,
  }
}

async function fold(rows: Row[]) {
  const { foldLiveFarms } = await import('../../src/public/services/farmApr.ts')
  return foldLiveFarms(rows as never)
}

describe('foldLiveFarms', () => {
  it('folds a created global + yield farm into one active farm', async () => {
    const farms = await fold([cfgRow('GlobalFarmCreated', GLOBAL_ARGS), cfgRow('YieldFarmCreated', YIELD_ARGS)])
    expect(farms).toEqual([{
      globalFarmId: 133,
      yieldFarmId: 139,
      assetId: 222,
      rewardAssetId: 222,
      multiplier: 1000000000000000000n,
      yieldPerPeriod: 41856925419n,
      maxRewardPerPeriod: 47945205479452054n,
      blocksPerPeriod: 1,
      plannedYieldingPeriods: 2628000,
      startedAt: new Date('2026-04-27T09:10:36Z'),
      // 2 628 000 periods of one 6-second relay block = 182.5 days.
      endsAt: new Date('2026-10-26T21:10:36Z'),
    }])
  })

  it('drops a yield farm that was stopped and restores it when resumed', async () => {
    const created = [cfgRow('GlobalFarmCreated', GLOBAL_ARGS), cfgRow('YieldFarmCreated', YIELD_ARGS)]
    const stopped = cfgRow('YieldFarmStopped', JSON.stringify({ globalFarmId: 133, yieldFarmId: 139, assetId: 222 }), { block_height: '12300000' })
    expect(await fold([...created, stopped])).toEqual([])

    const resumed = cfgRow('YieldFarmResumed', JSON.stringify({ globalFarmId: 133, yieldFarmId: 139, assetId: 222, multiplier: '500000000000000000' }), { block_height: '12400000' })
    const back = await fold([...created, stopped, resumed])
    expect(back).toHaveLength(1)
    expect(back[0].multiplier).toBe(500000000000000000n)
  })

  it('drops a terminated yield farm and a terminated global farm', async () => {
    const created = [cfgRow('GlobalFarmCreated', GLOBAL_ARGS), cfgRow('YieldFarmCreated', YIELD_ARGS)]
    expect(await fold([...created, cfgRow('YieldFarmTerminated', JSON.stringify({ globalFarmId: 133, yieldFarmId: 139 }), { block_height: '12300000' })])).toEqual([])
    expect(await fold([...created, cfgRow('GlobalFarmTerminated', JSON.stringify({ globalFarmId: 133 }), { block_height: '12300000' })])).toEqual([])
  })

  it('applies a global-farm update and re-derives the period budget from it', async () => {
    // GlobalFarmUpdated carries no maxRewardPerPeriod; the pallet keeps
    // max = totalRewards / plannedYieldingPeriods, the identity every
    // GlobalFarmCreated in the chain's history satisfies exactly.
    const updated = cfgRow('GlobalFarmUpdated', JSON.stringify({
      id: 133, plannedYieldingPeriods: 5256000, yieldPerPeriod: '83713850838', minDeposit: '1326259946950',
    }), { block_height: '12300000', yield_farm_id: '' })
    const [farm] = await fold([cfgRow('GlobalFarmCreated', GLOBAL_ARGS), cfgRow('YieldFarmCreated', YIELD_ARGS), updated])
    expect(farm.yieldPerPeriod).toBe(83713850838n)
    expect(farm.plannedYieldingPeriods).toBe(5256000)
    expect(farm.maxRewardPerPeriod).toBe(126000000000000000000000n / 5256000n)
    // The planned end moves with the schedule, counted from the original start.
    expect(farm.endsAt).toEqual(new Date('2027-04-27T09:10:36Z'))
  })

  it('keeps a farm past its planned schedule and dates its end', async () => {
    // Farms 59 and 61 are still in ActiveYieldFarm storage but their pots are empty;
    // the SDK reports 0 % for them. The fold keeps them — whether their rate can be
    // known is the caller's decision — and dates the end two years back.
    const rows = OLD_FARM_ROWS
    const [farm] = await fold(rows)
    expect(farm.assetId).toBe(15)
    expect(farm.endsAt).toEqual(new Date('2024-09-28T17:58:36Z'))
  })

  it('reads the farm identity from the columns, not from the arg names', async () => {
    // GlobalFarmCreated names the farm `id`, every other event `globalFarmId`;
    // the MV already normalised both into the column.
    const [farm] = await fold([
      cfgRow('GlobalFarmCreated', GLOBAL_ARGS, { global_farm_id: '133' }),
      cfgRow('YieldFarmCreated', YIELD_ARGS, { global_farm_id: '133', yield_farm_id: '139' }),
    ])
    expect(farm.globalFarmId).toBe(133)
    expect(farm.yieldFarmId).toBe(139)
  })

  it('ignores a yield farm whose global farm was never created', async () => {
    expect(await fold([cfgRow('YieldFarmCreated', YIELD_ARGS)])).toEqual([])
  })

  it('consumes the events in chain order whatever order the rows arrive in', async () => {
    const created = cfgRow('YieldFarmCreated', YIELD_ARGS)
    const stopped = cfgRow('YieldFarmStopped', JSON.stringify({ globalFarmId: 133, yieldFarmId: 139 }), { block_height: '12300000' })
    expect(await fold([stopped, created, cfgRow('GlobalFarmCreated', GLOBAL_ARGS)])).toEqual([])
  })

  it('orders heights as NUMBERS, so a 7-digit height is not read as later than an 8-digit one', async () => {
    // Distinct from the test above, which cannot catch this: the heights there are
    // both 8 digits, so a string comparator agrees with a numeric one and either
    // passes. Here the create is at 9 000 000 and the stop at 12 300 000, where the
    // two orders DISAGREE ('9000000' > '12300000' as text). The rows are handed over
    // in that text order on purpose — it is the order the config query itself
    // produced before its ORDER BY was fixed (measured live: 10 430 015, then
    // 12 228 202, then 5 305 748) — so `chainOrder`'s numeric compare is the only
    // thing standing between a stopped farm and a published rate. A chainOrder that
    // compared the strings would replay stop-before-create and report this farm live.
    const create = [
      cfgRow('GlobalFarmCreated', GLOBAL_ARGS, { block_height: '9000000' }),
      cfgRow('YieldFarmCreated', YIELD_ARGS, { block_height: '9000000' }),
    ]
    const stopped = cfgRow('YieldFarmStopped', JSON.stringify({ globalFarmId: 133, yieldFarmId: 139 }), { block_height: '12300000' })
    const lexicographic = [...create, stopped].sort((a, b) =>
      String(a.block_height).localeCompare(String(b.block_height)))
    // The premise: text order really does put the LATER event first here.
    expect(lexicographic.map(row => row.block_height)).toEqual(['12300000', '9000000', '9000000'])

    // The control, so the empty result below is the stop being applied LAST and not
    // the fold failing to read a farm at this height at all.
    const [live] = await fold(create)
    expect(live.assetId).toBe(222)
    expect(live.startedAt).toEqual(new Date('2026-04-27T09:10:36Z'))

    expect(await fold(lexicographic)).toEqual([])
  })
})

const FARM = {
  globalFarmId: 133,
  yieldFarmId: 139,
  assetId: 222,
  rewardAssetId: 222,
  multiplier: 1000000000000000000n,
  yieldPerPeriod: 41856925419n,
  maxRewardPerPeriod: 47945205479452054n,
  blocksPerPeriod: 1,
  plannedYieldingPeriods: 2628000,
  startedAt: new Date('2026-04-27T09:10:36Z'),
  endsAt: new Date('2026-10-26T09:10:36Z'),
}

const USD = 10n ** 12n

async function apr(farm: typeof FARM, farmedValueUsd: bigint | null, rewardPriceUsd: bigint | null) {
  const { farmAprPercScaled, renderPerc } = await import('../../src/public/services/farmApr.ts')
  const scaled = farmAprPercScaled(farm, farmedValueUsd, rewardPriceUsd)
  return scaled == null ? null : renderPerc(scaled)
}

describe('farmAprPercScaled', () => {
  it('pays the full yield rate while nothing is staked', async () => {
    // 41856925419e-18 · (365.2425 · 86400 / 6) periods = 22.0146 %/yr.
    expect(await apr(FARM, 0n, USD)).toBe('22.0146')
  })

  it('splits the period budget across the stake once the cap binds', async () => {
    // 0.01 reward token per period at $1, over $1 000 000 staked:
    // 0.01 · 5 259 492 · 1 / 1 000 000 = 5.259492 %.
    const farm = { ...FARM, maxRewardPerPeriod: 10n ** 16n }
    expect(await apr(farm, 1_000_000n * USD, USD)).toBe('5.2595')
  })

  it('never publishes more than the farm\'s own yield rate', async () => {
    // A stake so small the budget would imply 5 259 492 % — the pallet pays the
    // uncapped rate instead, and so do we.
    const farm = { ...FARM, maxRewardPerPeriod: 10n ** 16n }
    expect(await apr(farm, 1n * USD, USD)).toBe('22.0146')
  })

  it('scales with the reward asset\'s price', async () => {
    const farm = { ...FARM, maxRewardPerPeriod: 10n ** 16n }
    expect(await apr(farm, 1_000_000n * USD, 2n * USD)).toBe('10.5190')
  })

  it('scales the uncapped branch with the yield farm multiplier', async () => {
    const half = { ...FARM, multiplier: 500000000000000000n }
    expect(await apr(half, 0n, USD)).toBe('11.0073')
  })

  it('does not re-apply the multiplier to the capped branch', async () => {
    // The pallet's total_shares_z is Σ(valued_shares · multiplier), so the yield
    // farm's own multiplier divides straight back out; `farmedValueUsd` is
    // un-weighted stake, and weighting the budget by it too would halve the rate a
    // multiplier=0.5 farm really pays.
    const capped = { ...FARM, multiplier: 500000000000000000n, maxRewardPerPeriod: 10n ** 16n }
    expect(await apr(capped, 1_000_000n * USD, USD)).toBe('5.2595')
    expect(await apr({ ...capped, multiplier: 1000000000000000000n }, 1_000_000n * USD, USD)).toBe('5.2595')
  })

  it('counts periods in blocks, not in blocks per period', async () => {
    // Two relay blocks per period halves the number of periods in a year.
    expect(await apr({ ...FARM, blocksPerPeriod: 2 }, 0n, USD)).toBe('11.0073')
  })

  it('honours the reward asset\'s own decimals', async () => {
    // 0.01 aDOT (10 decimals) per period at $1 is the same rate as 0.01 of an
    // 18-decimal token at $1.
    const farm = { ...FARM, rewardAssetId: 1001, maxRewardPerPeriod: 10n ** 8n }
    expect(await apr(farm, 1_000_000n * USD, USD)).toBe('5.2595')
  })

  it('reports null when an input is missing rather than a rate without a denominator', async () => {
    expect(await apr(FARM, null, USD)).toBeNull()
    expect(await apr(FARM, 1_000_000n * USD, null)).toBeNull()
  })
})

describe('omnipoolFarmAprByAsset', () => {
  const TVL_ROW = {
    asset_id: '222',
    positions: '3',
    // Half the pool's shares are farmed, so half of a 2 000 000 HOLLAR reserve is.
    farmed_shares: '2000000000000000000000000',
    pool_shares: '4000000000000000000000000',
    reserve_raw: '2000000000000000000000000',
    sample_time: '2026-08-12 18:00:00',
  }
  const PRICE_ROW = { asset_id: '222', close: '1.000000000000', price_time: '2026-08-12 18:00:00' }

  async function run(byMarker: Record<string, Row[]>) {
    const client = fakeClient(byMarker)
    const { omnipoolFarmAprByAsset } = await import('../../src/public/services/farmApr.ts')
    return { client, apr: await omnipoolFarmAprByAsset(client as never, ANCHOR) }
  }

  it('values the farmed share of the pool at the current price', async () => {
    // 0.01 HOLLAR/period · 5 259 492 periods = 52 594.92 $/yr over $1 000 000.
    const global = JSON.parse(GLOBAL_ARGS)
    const { apr, client } = await run({
      '-- pub:farm:config': [
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
        cfgRow('YieldFarmCreated', YIELD_ARGS),
      ],
      '-- pub:farm:tvl': [TVL_ROW],
      '-- pub:farm:price': [PRICE_ROW],
    })
    expect(apr.get('222')).toEqual({ farmAprPerc: '5.2595', rewardAssetIds: ['222'] })
    // Only the farmed assets are read, and only prices they need.
    const tvl = client.seen.find(s => s.query.includes('-- pub:farm:tvl'))!
    expect(tvl.params.assets).toEqual([222])
    expect(tvl.params.anchor).toBe(ANCHOR)
  })

  it('adds up every farm running on the same asset', async () => {
    const global = JSON.parse(GLOBAL_ARGS)
    const second = { ...global, id: 200, maxRewardPerPeriod: '10000000000000000', rewardCurrency: 1001 }
    const { apr } = await run({
      '-- pub:farm:config': [
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
        cfgRow('YieldFarmCreated', YIELD_ARGS),
        cfgRow('GlobalFarmCreated', JSON.stringify(second), { global_farm_id: '200', event_index: '11' }),
        cfgRow('YieldFarmCreated', JSON.stringify({ globalFarmId: 200, yieldFarmId: 201, assetId: 222, multiplier: '1000000000000000000' }),
          { global_farm_id: '200', yield_farm_id: '201', event_index: '12' }),
      ],
      '-- pub:farm:tvl': [TVL_ROW],
      '-- pub:farm:price': [PRICE_ROW, { asset_id: '5', close: '1.000000000000', price_time: '2026-08-12 18:00:00' }],
    })
    // The second farm pays 1e16 raw of a 10-decimal reward token — a million times
    // more value per period — so its own rate is capped by its yield instead.
    expect(apr.get('222')).toEqual({ farmAprPerc: '27.2741', rewardAssetIds: ['222', '1001'] })
  })

  it('reports null for the whole asset when one of its farms cannot be valued', async () => {
    const global = JSON.parse(GLOBAL_ARGS)
    const { apr } = await run({
      '-- pub:farm:config': [
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
        cfgRow('YieldFarmCreated', YIELD_ARGS),
      ],
      '-- pub:farm:tvl': [TVL_ROW],
      '-- pub:farm:price': [],
    })
    expect(apr.get('222')).toEqual({ farmAprPerc: null, rewardAssetIds: ['222'] })
  })

  it('reports null when the asset has no fresh pool-state sample', async () => {
    const global = JSON.parse(GLOBAL_ARGS)
    const { apr } = await run({
      '-- pub:farm:config': [
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
        cfgRow('YieldFarmCreated', YIELD_ARGS),
      ],
      '-- pub:farm:tvl': [],
      '-- pub:farm:price': [PRICE_ROW],
    })
    expect(apr.get('222')).toEqual({ farmAprPerc: null, rewardAssetIds: ['222'] })
  })

  it('refuses to read an empty farmed-position model as an empty farm', async () => {
    // Every asset reporting zero farmed positions is the LP-reconstruction model
    // being down, not six farms losing all their liquidity at once. Publishing the
    // uncapped rate there would be a 22 % number nothing supports.
    const global = JSON.parse(GLOBAL_ARGS)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { apr } = await run({
        '-- pub:farm:config': [
          cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
          cfgRow('YieldFarmCreated', YIELD_ARGS),
        ],
        '-- pub:farm:tvl': [{ ...TVL_ROW, positions: '0', farmed_shares: '0' }],
        '-- pub:farm:price': [PRICE_ROW],
      })
      expect(apr.get('222')).toEqual({ farmAprPerc: null, rewardAssetIds: ['222'] })
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  it('reads nothing at all when no farm is running', async () => {
    const { apr, client } = await run({ '-- pub:farm:config': [] })
    expect(apr.size).toBe(0)
    expect(client.seen.some(s => s.query.includes('-- pub:farm:tvl'))).toBe(false)
  })

  it('keeps a past-schedule farm listed with a null rate, and reads nothing for it', async () => {
    // "A farm is here, its rate is unknown" — assets 15 and 33 are the live examples.
    // An asset with NO farm has no entry at all, which is how the two are told apart.
    const { apr, client } = await run({ '-- pub:farm:config': OLD_FARM_ROWS })
    expect(apr.get('15')).toEqual({ farmAprPerc: null, rewardAssetIds: ['14'] })
    expect(apr.has('222')).toBe(false)
    expect(client.seen.some(s => s.query.includes('-- pub:farm:tvl'))).toBe(false)
  })

  it('reports null for every asset of a global farm running two live yield farms', async () => {
    // total_shares_z is summed across a global farm's yield farms, so its budget is
    // split between them — but the staked value here is per asset, which would hand
    // each of them the whole budget.
    const global = JSON.parse(GLOBAL_ARGS)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { apr } = await run({
        '-- pub:farm:config': [
          cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
          cfgRow('YieldFarmCreated', YIELD_ARGS),
          cfgRow('YieldFarmCreated', JSON.stringify({ globalFarmId: 133, yieldFarmId: 141, assetId: 5, multiplier: '1000000000000000000' }),
            { yield_farm_id: '141', event_index: '12' }),
        ],
        '-- pub:farm:tvl': [TVL_ROW],
        '-- pub:farm:price': [PRICE_ROW],
      })
      expect(apr.get('222')).toEqual({ farmAprPerc: null, rewardAssetIds: ['222'] })
      expect(apr.get('5')).toEqual({ farmAprPerc: null, rewardAssetIds: ['222'] })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('133'))
    } finally { warn.mockRestore() }
  })

  it('lists a reward asset once when two farms on an asset pay the same token', async () => {
    const global = JSON.parse(GLOBAL_ARGS)
    const { apr } = await run({
      '-- pub:farm:config': [
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, maxRewardPerPeriod: '10000000000000000' })),
        cfgRow('YieldFarmCreated', YIELD_ARGS),
        cfgRow('GlobalFarmCreated', JSON.stringify({ ...global, id: 200, maxRewardPerPeriod: '10000000000000000' }),
          { global_farm_id: '200', event_index: '11' }),
        cfgRow('YieldFarmCreated', JSON.stringify({ globalFarmId: 200, yieldFarmId: 201, assetId: 222, multiplier: '1000000000000000000' }),
          { global_farm_id: '200', yield_farm_id: '201', event_index: '12' }),
      ],
      '-- pub:farm:tvl': [TVL_ROW],
      '-- pub:farm:price': [PRICE_ROW],
    })
    expect(apr.get('222')).toEqual({ farmAprPerc: '10.5190', rewardAssetIds: ['222'] })
  })
})

describe('farm SQL invariants', () => {
  it('reads only the Omnipool liquidity-mining farms', async () => {
    const { buildFarmConfigSql } = await import('../../src/public/services/farmApr.ts')
    // XYK farms incentivise XYK shares, which no yield endpoint serves.
    expect(buildFarmConfigSql()).toContain("pallet = 'omnipool_lm'")
  })

  it('orders the lifecycle NUMERICALLY, not by the string the columns carry', async () => {
    const { buildFarmConfigSql } = await import('../../src/public/services/farmApr.ts')
    // The projected columns are toString()ed for the wire, and ClickHouse resolves
    // ORDER BY against those aliases — so a bare `ORDER BY block_height` sorts
    // '5305748' after '12228202'. The TS fold re-sorts numerically, so this is a
    // trap rather than a live bug; pin the numeric form so the two agree.
    expect(buildFarmConfigSql()).toContain('ORDER BY toUInt64(block_height), toUInt64(event_index)')
    expect(buildFarmConfigSql()).not.toContain('ORDER BY block_height, event_index')
  })

  it('deduplicates every replayable source before it aggregates', async () => {
    const { buildFarmConfigSql, buildFarmTvlSql } = await import('../../src/public/services/farmApr.ts')
    expect(buildFarmConfigSql()).toContain('argMax(args_json, ingested_at)')
    const tvl = buildFarmTvlSql()
    expect(tvl).toContain('argMax(valid_to_block, run_id)')
    expect(tvl).toContain('argMax(reserve_raw, ingested_at)')
    expect(tvl).toContain('argMax(shares_raw, ingested_at)')
    expect(tvl).toContain('DISTINCT position_id')
  })

  it('bounds the pool-state sample and the price candle against staleness', async () => {
    const { buildFarmTvlSql, buildFarmPriceSql } = await import('../../src/public/services/farmApr.ts')
    // A delisted asset keeps its last state row forever and a dead feed its last
    // close; both would value today's stake at a months-old number.
    expect(buildFarmTvlSql()).toContain('block_timestamp > {anchor:DateTime} - INTERVAL {stateHours:UInt32} HOUR')
    expect(buildFarmPriceSql()).toContain('interval_start > {anchor:DateTime} - INTERVAL {lookbackDays:UInt32} DAY')
    // …and never a candle that had not closed by the anchor.
    expect(buildFarmPriceSql()).toContain('interval_start + INTERVAL 1 HOUR <= {anchor:DateTime}')
  })
})
