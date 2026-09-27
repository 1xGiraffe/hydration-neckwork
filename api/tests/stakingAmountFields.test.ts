import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { STAKING_EVENT_NAMES, mmStakingPlumbingExclusionSql, stakingAmountAndAsset, stakingAmountSql } from '../src/services/explorerService.ts'
import { STAKING_EVENT_NAMES as DATA_STAKING_EVENT_NAMES } from '../src/data/services/stakingFeed.ts'

// Staking rows are dropped when their amount resolves empty or zero, so an
// amount expression that reads a key the event does not emit silently deletes a
// whole action from every classified surface instead of failing loudly. These
// are the arg shapes the chain has actually emitted per event (verified against
// indexed raw_events); every shape must yield the documented field's value both
// in the TS builder and in the SQL push-down that pre-filters by USD value.
interface Shape { field: string; args: Record<string, string>; assetId?: number }
const SHAPES: Record<string, { action: string; shapes: Shape[] }> = {
  'CollatorRewards.CollatorRewarded': {
    action: 'Collator payout',
    shapes: [{ field: 'amount', args: { amount: '3300000000000', currency: '0' } }],
  },
  'GigaHdx.Staked': {
    action: 'GIGAHDX Stake',
    shapes: [
      { field: 'amount', args: { amount: '32000000000000000', gigahdx: '29000000000000000' } },
      { field: 'gigahdx', args: { amount: '32000000000000000', gigahdx: '29000000000000000' }, assetId: 670 },
    ],
  },
  'GigaHdx.Unstaked': {
    action: 'GIGAHDX Unstake',
    shapes: [
      { field: 'payout', args: { payout: '11000000000000000', gigahdxAmount: '10000000000000000', positionId: '3', expiresAt: '99', yieldShare: '1' } },
      { field: 'gigahdxAmount', args: { payout: '11000000000000000', gigahdxAmount: '10000000000000000', positionId: '3', expiresAt: '99', yieldShare: '1' }, assetId: 670 },
    ],
  },
  'GigaHdx.UnstakeCancelled': {
    action: 'GIGAHDX Cancel Unstake',
    shapes: [
      { field: 'amount', args: { amount: '5000000000000000', gigahdx: '4500000000000000', positionId: '7' } },
      { field: 'gigahdx', args: { amount: '5000000000000000', gigahdx: '4500000000000000', positionId: '7' }, assetId: 670 },
    ],
  },
  // Unlocked releases the HDX principal after the unstake period — it has no
  // stHDX leg, so it only carries an asset-0 shape (an stHDX-scoped view
  // drops the row via the empty amount).
  'GigaHdx.Unlocked': {
    action: 'GIGAHDX Unlock',
    shapes: [{ field: 'amount', args: { who: '0xf61d983487817667805f61db0f5ba60b29efa3b8563ed79379e56872d394207f', positionId: '13035834', amount: '1002030864126735184' } }],
  },
  'GigaHdx.MigratedFromLegacy': {
    action: 'GIGAHDX Migrate',
    shapes: [
      { field: 'hdxUnlocked', args: { hdxUnlocked: '80000000000000000', gigahdxReceived: '72000000000000000' } },
      { field: 'gigahdxReceived', args: { hdxUnlocked: '80000000000000000', gigahdxReceived: '72000000000000000' }, assetId: 670 },
    ],
  },
  // realize_yield pays accrued yield from the gigahdx! pot into the staker's locked
  // HDX; no stHDX moves, so like Unlocked it only carries an asset-0 shape.
  'GigaHdx.YieldRealized': {
    action: 'GIGAHDX Yield',
    shapes: [{ field: 'amount', args: { who: '0xea8057c0e08d8832d8ae590bd9d4711f6b6bf5b255494b164fcc8e4491afd15a', amount: '6031885551040644' } }],
  },
  'GigaHdxRewards.RewardsClaimed': {
    action: 'GIGAHDX Reward',
    shapes: [
      { field: 'totalHdx', args: { totalHdx: '1400000000000000', gigahdxReceived: '1300000000000000' } },
      { field: 'gigahdxReceived', args: { totalHdx: '1400000000000000', gigahdxReceived: '1300000000000000' }, assetId: 670 },
    ],
  },
  'Staking.PositionCreated': {
    action: 'Stake',
    shapes: [{ field: 'stake', args: { positionId: '8144', stake: '112000000000000000' } }],
  },
  'Staking.StakeAdded': {
    action: 'Add stake',
    // `stake` is the added amount; `totalStake` is the resulting position size.
    shapes: [
      { field: 'stake', args: { positionId: '8015', stake: '2000000000000000000', totalStake: '5000000000000000000', lockedRewards: '0', slashedPoints: '0' } },
      { field: 'stake', args: { positionId: '8015', stake: '2000000000000000000', totalStake: '5000000000000000000', lockedRewards: '0', slashedPoints: '0', payablePercentage: '0' } },
    ],
  },
  'Staking.Unstaked': {
    action: 'Unstake',
    // Both shapes report the released principal as `unlockedStake`; neither has
    // ever carried `amount` or `stake`. Early blocks add reward fields only.
    shapes: [
      { field: 'unlockedStake', args: { positionId: '7907', unlockedStake: '1900000000000000000' } },
      { field: 'unlockedStake', args: { positionId: '531', unlockedStake: '1000000000000000000', rewards: '0', unlockedRewards: '0' } },
    ],
  },
  'Staking.ForceUnstaked': {
    action: 'Force unstake',
    // Every indexed occurrence shares its extrinsic with a
    // GigaHdx.MigratedFromLegacy and is dropped by suppressGigaCompanionEvents,
    // so this only pins the field the amount would be read from.
    shapes: [{ field: 'paidRewards', args: { positionId: '4', stake: '9000000000000000', paidRewards: '120000000000000', lockedRewards: '0' } }],
  },
  'Staking.RewardsClaimed': {
    action: 'Staking reward',
    shapes: [
      { field: 'paidRewards', args: { positionId: '9', paidRewards: '77000000000000', unlockedRewards: '0', slashedPoints: '0', slashedUnpaidRewards: '0' } },
      { field: 'paidRewards', args: { positionId: '9', paidRewards: '77000000000000', unlockedRewards: '0', slashedPoints: '0', slashedUnpaidRewards: '0', payablePercentage: '0' } },
    ],
  },
}

describe('staking amount fields', () => {
  it('covers every classified staking event', () => {
    expect(Object.keys(SHAPES).sort()).toEqual([...STAKING_EVENT_NAMES].sort())
  })

  for (const [eventName, { action, shapes }] of Object.entries(SHAPES)) {
    for (const shape of shapes) {
      const perspective = shape.assetId === 670 ? ' as stHDX' : ''
      it(`reads ${eventName}.${shape.field}${perspective}`, () => {
        const parts = stakingAmountAndAsset(eventName, shape.args, shape.assetId)
        // An unread key yields '' and makes the builders drop the row entirely.
        expect(parts?.amount).toBe(shape.args[shape.field])
        expect(parts?.action).toBe(action)
      })
    }
  }

  // The value-filtered feed path pre-filters in ClickHouse, so a SQL branch that
  // reads a different key than the TS builder would make the min-USD filter and
  // the rendered row disagree about the same event.
  for (const [eventName, { shapes }] of Object.entries(SHAPES)) {
    for (const assetId of [0, 670]) {
      const fields = new Set(shapes.filter(s => (s.assetId ?? 0) === assetId).map(s => s.field))
      if (!fields.size) continue
      it(`pushes down ${eventName} amount as ${[...fields].join('/')} for asset ${assetId}`, () => {
        const sql = stakingAmountSql(assetId)
        const branch = sql.split(`event_name='${eventName}'`)[1] ?? ''
        expect(branch).not.toBe('')
        const clause = branch.split('\n')[0]
        for (const field of fields) expect(clause).toContain(`'${field}'`)
      })
    }
  }
})

// Every classified staking event has to reach the feed's sources: the windowed and
// account feeds read staking_activity, and the daily bars read the histogram MV. An
// event classified here but missing from either renders on the block page and
// nowhere else (GigaHdx.YieldRealized was absent from both, so a realized yield
// showed as a bare transfer from the gigahdx! pot).
describe('staking event sources', () => {
  const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
  const mvLine = (name: string) => views.split('\n').find(line => line.includes(`price_data.${name} TO`)) ?? ''
  it('staking_activity_mv selects exactly STAKING_EVENT_NAMES', () => {
    const where = mvLine('staking_activity_mv').split(' WHERE ')[1] ?? ''
    expect([...where.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1]).sort()).toEqual([...STAKING_EVENT_NAMES].sort())
  })
  it('the activity histogram counts every staking event in both arms', () => {
    const mv = mvLine('activity_histogram_events_mv')
    for (const name of STAKING_EVENT_NAMES) expect(mv.match(new RegExp(`'${name.replace('.', '\\.')}'`, 'g'))?.length, name).toBe(2)
  })
  it('the Data API staking vocabulary follows the MV', () => {
    expect([...DATA_STAKING_EVENT_NAMES].sort()).toEqual([...STAKING_EVENT_NAMES].sort())
  })
  it('a yield realization is no evidence of a GIGAHDX collateral leg', () => {
    expect(mmStakingPlumbingExclusionSql()).toContain("event_name != 'GigaHdx.YieldRealized'")
  })
})
