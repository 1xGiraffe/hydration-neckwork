import { describe, it, expect } from 'vitest'
import { suppressGigaCompanionEvents } from '../src/services/explorerService.ts'

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
