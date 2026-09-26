import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assembleFarmRewards, unclaimedRewardValue, withUnclaimedRewardsInValue, type LpPosition } from '../src/services/explorerService.ts'
import { LM_BELOW_ED_UNPAYABLE, LM_CLAIMABLE_RAW_SQL, LM_REWARD_MAX_AGE_SECONDS, currentLmRewardGenerationSql, lmCountedRewardRowsSql, type LmRewardRow } from '../src/services/lmRewardSnapshot.ts'

// The account page states unclaimed farm rewards as a figure of their own
// (farmRewards) and on the farmed LP rows they belong to — never inside a
// position's value — and counts the priced total in the account's value.

const row = (over: Partial<LmRewardRow>): LmRewardRow => ({
  accountId: `0x${'61'.repeat(32)}`, pallet: 'omnipool', depositId: '77', yieldFarmId: 139, globalFarmId: 133,
  poolKey: '5', positionId: '4712', lpAssetId: null, rewardAssetId: 0, farmState: 'active',
  claimable: 2_000_000_000_000n, projected: true, maxReward: 3_000_000_000_000n, forfeitIfWithdrawnNow: 1_000_000_000_000n,
  loyalty: 666_666_666_666_666_666n, farmUpdatedAtPeriod: 100, currentPeriod: 110, belowExistentialDeposit: false, payable: true, ...over,
})

const lp = (over: Partial<LpPosition>): LpPosition => ({
  positionId: '4712', asset: { assetId: 5 } as never, amount: '1', shares: '1', valueUsd: 10, venue: 'Omnipool Farm', ...over,
})

// $1 per whole unit of a 12-decimal asset; asset 9 has no price.
const value = (assetId: number, raw: bigint): number | null => (assetId === 9 ? null : Number(raw) / 1e12)

describe('assembleFarmRewards', () => {
  it('lists every entry, sums the priced ones, and attaches each to its farmed row', () => {
    const positions = [
      lp({}),
      lp({ positionId: '4711', venue: 'Omnipool' }),
      lp({ positionId: 'xyk:1000086:farm', venue: 'XYK Farm' }),
      lp({ positionId: 'xyk:1000086:direct', venue: 'XYK' }),
    ]
    const { farmRewards, lpPositions } = assembleFarmRewards(9_000, [
      row({}),
      row({ yieldFarmId: 140, globalFarmId: 134, farmState: 'stopped', rewardAssetId: 9, claimable: 5n, belowExistentialDeposit: true }),
      row({ pallet: 'xyk', depositId: '3', yieldFarmId: 2, globalFarmId: 1, positionId: null, lpAssetId: 1000086, claimable: 4_000_000_000_000n, projected: false }),
    ], positions, value)

    expect(farmRewards?.asOfBlock).toBe(9_000)
    expect(farmRewards?.items).toHaveLength(3)
    expect(farmRewards?.items[0]).toMatchObject({ depositId: '77', positionId: '4712', venue: 'Omnipool Farm', claimable: '2000000000000', claimableUsd: 2, loyaltyPct: 66.66, projected: true, lastSyncPeriod: 100, forfeitIfWithdrawnNow: '1000000000000' })
    // An unpriced reward is listed with a null value and left out of the total.
    expect(farmRewards?.items[1]).toMatchObject({ claimableUsd: null, farmState: 'stopped', belowExistentialDeposit: true })
    expect(farmRewards?.totalUsd).toBe(6)

    expect(lpPositions[0].unclaimedRewards?.map(r => r.yieldFarmId)).toEqual([139, 140])
    expect(lpPositions[0].valueUsd).toBe(10)
    expect(lpPositions[1].unclaimedRewards).toBeUndefined()
    expect(lpPositions[2].unclaimedRewards).toEqual([{ depositId: '3', globalFarmId: 1, yieldFarmId: 2, asset: expect.anything(), amount: '4000000000000', valueUsd: 4, projected: false, belowExistentialDeposit: false, payable: true }])
    expect(lpPositions[3].unclaimedRewards).toBeUndefined()
  })

  // A claim below the existential deposit to an owner holding less than it pays
  // nothing: the entry stays listed with its amount, but values at 0.
  it('lists an unpayable entry with its amount and counts it 0', () => {
    const { farmRewards, lpPositions } = assembleFarmRewards(9_000, [
      row({}),
      row({ yieldFarmId: 140, claimable: 700_000_000_000n, belowExistentialDeposit: true, payable: false }),
    ], [lp({})], value)
    expect(farmRewards?.items[1]).toMatchObject({ claimable: '700000000000', claimableUsd: 0, belowExistentialDeposit: true, payable: false })
    expect(farmRewards?.totalUsd).toBe(2)
    expect(unclaimedRewardValue({ farmRewards }).usd).toBe(2)
    expect(lpPositions[0].unclaimedRewards?.[1]).toMatchObject({ amount: '700000000000', valueUsd: 0, payable: false })
  })

  it('is absent without a published snapshot or without entries', () => {
    const positions = [lp({})]
    expect(assembleFarmRewards(null, [row({})], positions, value)).toEqual({ farmRewards: undefined, lpPositions: positions })
    expect(assembleFarmRewards(9_000, [], positions, value)).toEqual({ farmRewards: undefined, lpPositions: positions })
  })
})

describe('farm rewards in the account value', () => {
  const rewards = () => assembleFarmRewards(9_000, [
    // 2 HDX (asset 0), 4 of asset 5, and an unpriced entry of asset 9.
    row({}),
    row({ yieldFarmId: 140, rewardAssetId: 5, claimable: 4_000_000_000_000n }),
    row({ yieldFarmId: 141, rewardAssetId: 9, claimable: 5n }),
  ], [], value).farmRewards

  it('counts the priced claimable, and takes the HDX-denominated part out of ex-HDX', () => {
    expect(unclaimedRewardValue({ farmRewards: rewards() })).toEqual({ usd: 6, exHdxUsd: 4 })
    // The value part is exactly the figure the page states beside it.
    expect(unclaimedRewardValue({ farmRewards: rewards() }).usd).toBe(rewards()?.totalUsd)
    expect(unclaimedRewardValue({})).toEqual({ usd: 0, exHdxUsd: 0 })
  })

  // The tag build is reward-free and pinned to value − debt; the overlay adds
  // the rewards to the value and to the pinned last point, once.
  it('adds them to a reward-free tag build and to its pinned last point', () => {
    const build = { portfolioUsd: 100, portfolioExHdxUsd: 50, portfolioSeries: [80, 90, 95], portfolioSeriesExHdx: [40, 45, 45] }
    const out = withUnclaimedRewardsInValue(build, { farmRewards: rewards() })
    expect(out).toEqual({ portfolioUsd: 106, portfolioExHdxUsd: 54, portfolioSeries: [80, 90, 101], portfolioSeriesExHdx: [40, 45, 49] })
    // The build itself is untouched, so the cached/persisted blob stays reward-free.
    expect(build.portfolioUsd).toBe(100)
    expect(build.portfolioSeries).toEqual([80, 90, 95])
  })

  it('leaves a build without ex-HDX or series shape alone apart from the value', () => {
    const out = withUnclaimedRewardsInValue({ portfolioUsd: 10, portfolioSeries: [], portfolioSeriesExHdx: [] }, { farmRewards: rewards() })
    expect(out).toEqual({ portfolioUsd: 16, portfolioSeries: [], portfolioSeriesExHdx: [] })
    expect('portfolioExHdxUsd' in out).toBe(false)
    const none = { portfolioUsd: 10, portfolioSeries: [10], portfolioSeriesExHdx: [] }
    expect(withUnclaimedRewardsInValue(none, {})).toBe(none)
  })
})

// The directory ranks by the value the account page prints, so it takes the
// rewards in by the same rows, claimable rule and staleness gate.
describe('farm rewards in the accounts directory', () => {
  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  const page = src.slice(src.indexOf('async function accountsPage('), src.indexOf('\n}\n', src.indexOf('async function accountsPage(')))

  it('adds the group\'s counted, priced claimable to usd_total from the current, fresh generation', () => {
    expect(page).toContain('g.usd + ${lpValue} + g.lm_usd + g.mmr_usd + ifNull(mg.value_delta, 0) / 1e8 AS usd_total')
    expect(page).toContain('FROM (${lmCountedRewardRowsSql(currentLmRewardGenerationSql())}) r')
    expect(page).toContain('sum(toFloat64(r.counted_raw) * transform(toString(r.reward_asset_id), ${idsSql}, ${unitsSql}, 0.)) AS usd')
    // Per account, joined into `grouped` (which carries the tag join) once per account.
    expect(page).toContain('LEFT JOIN lm_acct lm ON lm.account_id = latest.account_id')
    expect(page).toContain('arraySum(x -> tupleElement(x, 2), groupUniqArrayIf((latest.account_id, lm.usd), lm.usd != 0)) AS lm_usd')
  })

  // loadLmRewards' rules, restated once for SQL: unpayable entries 0, claims
  // indexed after the snapshot block subtracted and floored, withdrawn/destroyed 0.
  it('counts each entry by the loader\'s rules', () => {
    const sql = lmCountedRewardRowsSql("'gen'")
    expect(sql).toContain(`r.below_ed = ${LM_BELOW_ED_UNPAYABLE}`)
    expect(sql).toContain("toUInt256(greatest(toInt256(ifNull(claimable_projected_raw, claimable_settled_raw)) - toInt256(ifNull(ev.claimed, 0)), toInt256(0)))")
    expect(sql).toContain('block_height > (SELECT max(snapshot_block) FROM (SELECT * FROM price_data.lm_reward_snapshots WHERE snapshot_id = \'gen\'))')
    expect(sql).toContain("event_kind = 'destroyed'")
    expect(sql).toContain('GROUP BY pallet, deposit_id, block_height, event_index')
  })

  it('gates the generation exactly as the account page does', () => {
    const sql = currentLmRewardGenerationSql()
    expect(sql).toContain(`<= ${LM_REWARD_MAX_AGE_SECONDS}`)
    expect(sql).toContain("snapshot_key = 'current'")
    // Projected where the runtime projected it, else settled: lmRewardRowFromStored's rule.
    expect(LM_CLAIMABLE_RAW_SQL).toBe('ifNull(claimable_projected_raw, claimable_settled_raw)')
  })

  it('keys its pages on a model version that carries the rewards', () => {
    const version = src.slice(src.indexOf('function accountDirectoryModelVersion('), src.indexOf('\n}\n', src.indexOf('function accountDirectoryModelVersion(')))
    // `-r3` brought the rewards in; `-r4` also leaves a pool account's own hub
    // reserve out (poolOwnHubHolding.test.ts); `-r5` values money-market collateral
    // by the folded reserves (mmUnstatedCollateral.test.ts). Either way a page
    // persisted under a reward-free value is never served as this one.
    expect(version).toContain("return 'v3-r5'")
    expect(version).not.toMatch(/return 'v3'\s*$/m)
  })
})
