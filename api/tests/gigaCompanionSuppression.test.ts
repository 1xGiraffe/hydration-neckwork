import { describe, it, expect } from 'vitest'
import { gigaCompanionExclusionSql, mmStakingPlumbingExclusionSql, suppressGigaCompanionEvents } from '../src/services/explorerService.ts'

const ev = (block: number, extrinsic: number | null, eventName: string, who: string) => ({
  block_height: block,
  extrinsic_index: extrinsic,
  event_name: eventName,
  args_json: JSON.stringify({ who }),
})

describe('suppressGigaCompanionEvents', () => {
  it('collapses a Giga migration extrinsic to the migration row only', () => {
    const who = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const rows = [
      ev(10, 2, 'Staking.ForceUnstaked', who),
      ev(10, 2, 'GigaHdx.Staked', who),
      ev(10, 2, 'GigaHdx.MigratedFromLegacy', who),
    ]

    expect(suppressGigaCompanionEvents(rows).map(r => r.event_name)).toEqual(['GigaHdx.MigratedFromLegacy'])
  })

  it('keeps normal companion-named events outside the matching migration tuple', () => {
    const who = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const other = '0x2222222222222222222222222222222222222222222222222222222222222222'
    const rows = [
      ev(10, 1, 'GigaHdx.MigratedFromLegacy', who),
      ev(10, 1, 'GigaHdx.Staked', other),
      ev(10, 2, 'Staking.ForceUnstaked', who),
    ]

    expect(suppressGigaCompanionEvents(rows).map(r => r.event_name)).toEqual([
      'GigaHdx.MigratedFromLegacy',
      'GigaHdx.Staked',
      'Staking.ForceUnstaked',
    ])
  })

  it('collapses a Giga reward extrinsic to the reward row only', () => {
    const who = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const rows = [
      ev(20, 3, 'GigaHdx.Staked', who),
      ev(20, 3, 'GigaHdxRewards.RewardsClaimed', who),
    ]

    expect(suppressGigaCompanionEvents(rows).map(r => r.event_name)).toEqual(['GigaHdxRewards.RewardsClaimed'])
  })

  it('collapses a cancelled unstake to the cancel row only', () => {
    // cancel_unstake stakes the position's HDX again and emits GigaHdx.Staked for
    // the same amount right before UnstakeCancelled.
    const who = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const rows = [
      ev(30, 3, 'GigaHdx.Staked', who),
      ev(30, 3, 'GigaHdx.UnstakeCancelled', who),
    ]

    expect(suppressGigaCompanionEvents(rows).map(r => r.event_name)).toEqual(['GigaHdx.UnstakeCancelled'])
  })

  it('does not hide a separate account stake in the reward extrinsic', () => {
    const rewardOwner = '0x1111111111111111111111111111111111111111111111111111111111111111'
    const other = '0x2222222222222222222222222222222222222222222222222222222222222222'
    const rows = [
      ev(10, 1, 'GigaHdx.Staked', other),
      ev(10, 1, 'GigaHdxRewards.RewardsClaimed', rewardOwner),
    ]

    expect(suppressGigaCompanionEvents(rows).map(r => r.event_name)).toEqual([
      'GigaHdx.Staked',
      'GigaHdxRewards.RewardsClaimed',
    ])
  })
})

// The paged staking feeds drop the same companions in SQL, before their LIMIT: a page
// that dropped them afterwards came back one row short per reward claim while more
// rows existed, and every pager (the explorer UI's, the MCP's "page until a page
// comes back short") read that as the end of the feed. The predicate is generated
// from the table suppressGigaCompanionEvents reads, so the two cannot drift; its
// parity with the JS rule over all indexed history is verified against the live
// stack, and these pin the decisions it encodes.
describe('gigaCompanionExclusionSql', () => {
  const sql = gigaCompanionExclusionSql('1')
  const key = 'block_height, assumeNotNull(extrinsic_index), lower(who)'

  it('removes events by identity, so it can prune the account activity references too', () => {
    expect(sql).toMatch(/^\(block_height, event_index\) NOT IN \(/)
  })

  it('hides a stake behind a reward claim, a cancelled unstake or a migration, a force-unstake behind a migration only', () => {
    expect(sql).toContain(`event_name = 'GigaHdx.Staked' AND (${key}) IN (`)
    expect(sql).toContain("event_name IN ('GigaHdxRewards.RewardsClaimed','GigaHdx.UnstakeCancelled','GigaHdx.MigratedFromLegacy')")
    expect(sql).toContain(`event_name = 'Staking.ForceUnstaked' AND (${key}) IN (`)
    expect(sql).toContain("event_name IN ('GigaHdx.MigratedFromLegacy')")
    // Nothing else is ever a companion.
    expect(sql).toContain("event_name IN ('GigaHdx.Staked','Staking.ForceUnstaked')")
  })

  it('pairs the extrinsic and the account, never the block alone', () => {
    // Mirrors stakingActivityKey: an event without an extrinsic or an account is
    // never a companion, and another account's stake in the claim's extrinsic stays.
    expect(sql.match(/extrinsic_index IS NOT NULL AND who != ''/g)).toHaveLength(3)
  })

  it('applies the caller\'s block-granular bound to every lookup', () => {
    const bounded = gigaCompanionExclusionSql("block_timestamp >= '2026-09-01 00:00:00'")
    expect(bounded.match(/WHERE block_timestamp >= '2026-09-01 00:00:00' AND/g)).toHaveLength(3)
  })
})

// The other half of the same collapse: a GIGAHDX stake also supplies the minted
// stHDX into the isolated GIGAHDX market, and unstaking withdraws it. Those legs are
// the pallet's, so they are excluded in SQL — before every LIMIT, so a suppressed leg
// never costs a page one of its rows. Nothing here can run the SQL, so these pin the
// decisions the predicate encodes; the counts it produces are verified against the
// live stack.
describe('GIGAHDX collateral plumbing exclusion', () => {
  const GIGAHDX_POOL = '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923'
  const CORE_POOL = '0x1b02e051683b5cfac5929c25e84adb26ecf87b38'
  const sql = mmStakingPlumbingExclusionSql()

  it('takes only the collateral legs, and only in the staking-backed market', () => {
    expect(sql).toContain("event_name NOT IN ('Supply','Withdraw')")
    // Borrowing, repaying and being liquidated are the user's own acts in this
    // market whatever put the collateral there, so they must not be swept up.
    for (const kept of ['Borrow', 'Repay', 'Liquidation']) expect(sql).not.toContain(kept)
    expect(sql).toContain(GIGAHDX_POOL)
    expect(sql).not.toContain(CORE_POOL)
  })

  it('pairs the block with the account, never the block alone', () => {
    // Someone supplying stHDX they already hold, in the same block as an unrelated
    // account's GIGAHDX stake, is a Lend of its own; a block-only test deletes it.
    expect(sql).toMatch(/\(block_height, lower\(ifNull\(account_id, ''\)\)\) NOT IN/)
  })

  it('folds the staking account into the form the money-market models key on', () => {
    // staking_activity keys by AccountId32 and the money-market models by the
    // truncated-H160 id, so comparing them unfolded matches nothing and suppresses
    // nothing. 3/40 is 1-based "skip 0x, take the first 20 bytes".
    expect(sql).toContain("concat('0x45544800', substring(lower(who), 3, 40), '0000000000000000')")
    expect(sql).toContain("event_name LIKE 'GigaHdx%'")
  })
})
