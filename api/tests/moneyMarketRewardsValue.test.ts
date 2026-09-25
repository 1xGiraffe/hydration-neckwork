import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assembleFarmRewards, assembleMoneyMarketRewards, chartMmIncentiveSeries, unclaimedRewardValue, withMarketRewards, withUnclaimedRewardsInValue,
  type MoneyMarketPosition,
} from '../src/services/explorerService.ts'
import { mmCountedIncentiveRowsSql, type MmIncentiveSnapshotView } from '../src/services/mmIncentiveSnapshot.ts'
import type { LmRewardRow } from '../src/services/lmRewardSnapshot.ts'

// Claimable money-market incentives count in the ACCOUNT value everywhere, by the
// farm rewards' rules — once, priced, HDX-denominated ones out of ex-HDX — and are
// listed beside each market, never inside its collateral.

const H160 = `0x${'4a'.repeat(20)}`
const A690 = '0x34d5ffb83d14d82f87aaf2f13be895a3c814c2ad'
const snapshot = (over: Partial<MmIncentiveSnapshotView> = {}): MmIncentiveSnapshotView => ({
  asOfBlock: 15_000_000,
  rewards: [
    // 3 GDOT (asset 69, $1 a unit here), reconciled.
    { accountId: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, marketKey: 'core', rewardAssetId: 69, rewardAddress: '0x0000000000000000000000000000000100000045', claimable: 3_000_000_000_000n, model: 3_000_000_000_000n, accrued: 0n, reconciled: true, belowExistentialDeposit: false, legs: [{ assetAddress: A690, scaledBalance: 1n, userIndex: 1n, assetIndex: 2n, pending: 3_000_000_000_000n }] },
    // 2 HDX, below the ED: owed and counted, but out of the ex-HDX twin.
    { accountId: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, marketKey: 'core', rewardAssetId: 0, rewardAddress: '0x0000000000000000000000000000000100000000', claimable: 2_000_000_000_000n, model: 1n, accrued: 1n, reconciled: false, belowExistentialDeposit: true, legs: [] },
    // An unpriced reward (asset 9): listed, in no sum.
    { accountId: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, marketKey: 'core', rewardAssetId: 9, rewardAddress: '0x0000000000000000000000000000000100000009', claimable: 5n, model: 5n, accrued: 5n, reconciled: true, belowExistentialDeposit: false, legs: [] },
    // Nothing claimable: not listed.
    { accountId: `0x45544800${H160.slice(2)}0000000000000000`, holder: H160, marketKey: 'core', rewardAssetId: 14, rewardAddress: '0x000000000000000000000000000000010000000e', claimable: 0n, model: 0n, accrued: 0n, reconciled: true, belowExistentialDeposit: false, legs: [] },
  ],
  ...over,
})
const value = (assetId: number, raw: bigint): number | null => (assetId === 9 ? null : Number(raw) / 1e12)
const aTokenOf = (addr: string) => (addr === A690 ? ({ assetId: 1006, symbol: 'aGDOT' } as never) : null)

describe('assembleMoneyMarketRewards', () => {
  it('lists every claimable reward, sums the priced ones', () => {
    const r = assembleMoneyMarketRewards(snapshot(), value, aTokenOf)!
    expect(r.asOfBlock).toBe(15_000_000)
    expect(r.items.map(i => [i.asset.assetId, i.claimable, i.claimableUsd, i.reconciled, i.belowExistentialDeposit])).toEqual([
      [69, '3000000000000', 3, true, false],
      [0, '2000000000000', 2, false, true],
      [9, '5', null, true, false],
    ])
    expect(r.items[0].legs).toEqual([{ aToken: { assetId: 1006, symbol: 'aGDOT' }, aTokenAddress: A690, pending: '3000000000000' }])
    expect(r.totalUsd).toBe(5)
  })

  it('is absent without a fresh snapshot or anything claimable', () => {
    expect(assembleMoneyMarketRewards({ asOfBlock: null, rewards: [] }, value, aTokenOf)).toBeUndefined()
    expect(assembleMoneyMarketRewards(snapshot({ rewards: [] }), value, aTokenOf)).toBeUndefined()
  })
})

describe('both reward kinds in the account value', () => {
  const lmRow = (over: Partial<LmRewardRow>): LmRewardRow => ({
    accountId: `0x${'61'.repeat(32)}`, pallet: 'omnipool', depositId: '77', yieldFarmId: 139, globalFarmId: 133, poolKey: '5', positionId: '4712', lpAssetId: null,
    rewardAssetId: 5, farmState: 'active', claimable: 4_000_000_000_000n, projected: true, maxReward: 0n, forfeitIfWithdrawnNow: 0n, loyalty: 0n,
    farmUpdatedAtPeriod: 1, currentPeriod: 2, belowExistentialDeposit: false, payable: true, ...over,
  })
  const farmRewards = assembleFarmRewards(9_000, [lmRow({})], [], value).farmRewards
  const moneyMarketRewards = assembleMoneyMarketRewards(snapshot(), value, aTokenOf)

  it('adds the priced claimable of both, HDX-denominated ones out of ex-HDX', () => {
    expect(unclaimedRewardValue({ farmRewards, moneyMarketRewards })).toEqual({ usd: 9, exHdxUsd: 7 })
    expect(unclaimedRewardValue({ moneyMarketRewards })).toEqual({ usd: 5, exHdxUsd: 3 })
    expect(unclaimedRewardValue({})).toEqual({ usd: 0, exHdxUsd: 0 })
  })

  it('adds both to a reward-free tag build and its pinned last point, once', () => {
    const build = { portfolioUsd: 100, portfolioExHdxUsd: 50, portfolioSeries: [80, 95], portfolioSeriesExHdx: [40, 45] }
    expect(withUnclaimedRewardsInValue(build, { farmRewards, moneyMarketRewards })).toEqual({ portfolioUsd: 109, portfolioExHdxUsd: 57, portfolioSeries: [80, 104], portfolioSeriesExHdx: [40, 52] })
    expect(build.portfolioUsd).toBe(100)
  })

  it('lists each market\'s incentives beside its position, never in its collateral', () => {
    const core = { marketKey: 'core', totalCollateralBase: '100' } as MoneyMarketPosition
    const giga = { marketKey: 'gigahdx', totalCollateralBase: '7' } as MoneyMarketPosition
    const [c, g] = withMarketRewards([core, giga], moneyMarketRewards)
    expect(c.unclaimedRewards).toHaveLength(3)
    expect(c.totalCollateralBase).toBe('100')
    expect(g).toBe(giga)
    expect(withMarketRewards([core], undefined)[0]).toBe(core)
  })
})

describe('the chart and the directory take the incentives the same way', () => {
  it('values each bucket\'s settled items at the chart price, HDX out of ex-HDX', () => {
    const curves = chartMmIncentiveSeries({
      anchorBlock: 1, rewardAssetIds: [0, 69], incompleteByBucket: [0, 0],
      itemsByBucket: [[], [
        { holder: H160, marketKey: 'core', rewardAssetId: 69, amount: 2_000_000_000_000n, settledAtBlock: 1 },
        { holder: H160, marketKey: 'core', rewardAssetId: 0, amount: 1_000_000_000_000n, settledAtBlock: null },
      ]],
    }, (_id, b) => (b === 1 ? 2 : 0), () => 12)
    expect(curves).toEqual({ total: [0, 6], exHdx: [0, 4] })
  })

  const src = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
  const page = src.slice(src.indexOf('async function accountsPage('), src.indexOf('\n}\n', src.indexOf('async function accountsPage(')))
  it('ranks the directory by the chain claimable of the current, fresh generation — total rows only', () => {
    // Keyed like mm_grouped: the actor's money-market holder (ETH-form) id.
    expect(page).toContain("LEFT JOIN mmr_acct mmr ON mmr.account_id = ${MM_ETH_FORM_SQL('latest.account_id')}")
    expect(page).toContain("INNER JOIN mm_latest m ON lower(m.account_id) = ${MM_ETH_FORM_SQL('a.account_id')}")
    expect(page).toContain('FROM (${mmCountedIncentiveRowsSql(currentMmIncentiveGenerationSql())}) i')
    expect(page).toContain('sum(toFloat64(i.counted_raw) * transform(toString(i.reward_asset_id), ${idsSql}, ${unitsSql}, 0.)) AS usd')
    // Pair totals only, less the claims indexed after the snapshot block.
    const sql = mmCountedIncentiveRowsSql("'gen'")
    expect(sql).toContain("WHERE snapshot_id = 'gen' AND asset_address = ''")
    expect(sql).toContain('toUInt256(greatest(toInt256(i.claimable_raw) - toInt256(ifNull(c.claimed, 0)), toInt256(0)))')
    expect(sql).toContain('GROUP BY u, reward, block_height, event_index')
  })

  it('reads the page\'s, the tag\'s and the chart\'s incentives for one holder set (moneyMarketIdentities)', () => {
    expect(src).toContain('await getUnclaimedRewards([...related], moneyMarketIdentities([...related], norm).h160s, lpPositions)')
    expect(src).toContain('const rewardH160s = moneyMarketIdentities(members).h160s')
    expect(src).toContain('const historyH160s = moneyMarketIdentities(accounts).h160s')
    expect(src).toContain('const { h160s, primary } = moneyMarketIdentities(accounts, owner)')
    expect(src).toContain('const rewardValue = unclaimedRewardValue({ farmRewards, moneyMarketRewards })')
  })
})
