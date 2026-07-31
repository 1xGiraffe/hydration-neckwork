import { describe, expect, it } from 'vitest'
import { activityBadge, categoryColor, CAT, UNFILTERED_COLOR } from '../src/components/activityColors'
import { ACTIVITY_ACTIONS } from '../src/components/ui'
import type { ActivityRow } from '../src/types'

// A row carrying only the fields the badge reads. The rest of ActivityRow is
// irrelevant to the coding, so it is cast in rather than fixtured.
function row(r: Partial<ActivityRow>): ActivityRow {
  return r as ActivityRow
}

// The coding is only worth anything if a hue means one thing. These pin the parts
// that would silently drift: a new action falling through to the grey default, or
// a family leaking into a hue that belongs to another.
describe('activity category coding', () => {
  it('gives every action in the shared filter list a color from its own family', () => {
    const family: Record<string, string[]> = {
      trade: [CAT.trade, CAT.tradeDca, CAT.tradeFill, CAT.tradePlace, CAT.bad],
      mm: [CAT.borrow, CAT.borrowWithdraw, CAT.borrowLend, CAT.borrowRepay, CAT.borrowClaim, CAT.bad],
      liquidity: [CAT.liquidity, CAT.liquidityRemove, CAT.liquidityCreate, CAT.liquidityClaim],
      stake: [CAT.stake, CAT.stakeExit, CAT.stakeReward, CAT.stakeMigrate, CAT.stakeCancel],
      vote: [CAT.vote, CAT.aye, CAT.nay],
      xcm: [CAT.xcm],
    }
    // Build the row shape each action arrives in, mirroring how the server fills them.
    const build: Record<string, (v: string) => ActivityRow> = {
      trade: v => v.startsWith('otc-')
        ? row({ type: 'otc', otcAction: (v.slice(4, 5).toUpperCase() + v.slice(5)) as ActivityRow['otcAction'] })
        : row({ type: 'trade', dca: v.startsWith('dca'), dcaStatus: v === 'dca-failed' ? 'failed' : undefined }),
      mm: v => row({ type: 'mm', mmAction: v }),
      liquidity: v => row({ type: 'liquidity', liqAction: v as ActivityRow['liqAction'] }),
      stake: v => row({ type: 'staking', stakingAction: v }),
      vote: v => row({ type: 'vote', voteAction: v }),
      xcm: () => row({ type: 'xcm' }),
    }
    for (const [type, actions] of Object.entries(ACTIVITY_ACTIONS)) {
      for (const a of actions) {
        const { col, label } = activityBadge(build[type](a.v))
        expect(family[type], `${type} has no declared family`).toBeDefined()
        expect(family[type], `${type}/${a.v} (${label}) fell outside its family`).toContain(col)
      }
    }
  })

  it('never falls through to the unstyled default for a known activity type', () => {
    const types: ActivityRow['type'][] = ['transfer', 'trade', 'xcm', 'liquidity', 'mm', 'dca', 'staking', 'vote', 'otc']
    for (const type of types) {
      expect(activityBadge(row({ type })).col, type).not.toBe('var(--text-medium)')
    }
  })

  // Valence beats category wherever a row has a side, so these read the same here
  // as in the votes table and the bubble map.
  it('keeps AYE green and NAY red, and leaves lavender for a sideless vote', () => {
    expect(activityBadge(row({ type: 'vote', voteAction: 'Aye' })).col).toBe(CAT.aye)
    expect(activityBadge(row({ type: 'vote', voteAction: 'Nay' })).col).toBe(CAT.nay)
    expect(activityBadge(row({ type: 'vote', voteAction: null })).col).toBe(CAT.vote)
    expect(CAT.aye).toBe('var(--green)')
    expect(CAT.nay).toBe('var(--red)')
  })

  it('names the act "Vote", not the feed\'s "Voted"', () => {
    expect(activityBadge(row({ type: 'vote', voteAction: 'Voted' })).label).toBe('Vote')
    expect(activityBadge(row({ type: 'vote', voteAction: null })).label).toBe('Vote')
    expect(activityBadge(row({ type: 'vote', voteAction: 'Aye' })).label).toBe('Aye')
  })

  it('sends the bad outcomes to red whatever produced them', () => {
    expect(activityBadge(row({ type: 'mm', mmAction: 'LiquidationCall' })).col).toBe(CAT.bad)
    expect(activityBadge(row({ type: 'mm', mmAction: 'Liquidate' })).col).toBe(CAT.bad)
    expect(activityBadge(row({ type: 'trade', dca: true, dcaStatus: 'failed' })).col).toBe(CAT.bad)
  })

  // The whole point of the ramp: two actions a reader sees side by side in one
  // feed must never resolve to the same shade. This is the assertion that would
  // have caught Lend / Repay / Claim rewards sharing one colour.
  it('gives every action in a family its own shade', () => {
    const families: Record<string, ActivityRow[]> = {
      mm: ['Borrow', 'Withdraw', 'Supply', 'Repay', 'ClaimRewards'].map(a => row({ type: 'mm', mmAction: a })),
      liquidity: ['Add', 'Remove', 'Create', 'Claim'].map(a => row({ type: 'liquidity', liqAction: a as ActivityRow['liqAction'] })),
      // Place and Pull deliberately share a shade (see OTC_COLORS), so Pull is
      // covered by the grouping test below rather than the distinctness one.
      trade: [row({ type: 'trade' }), row({ type: 'trade', dca: true }),
        ...['Fill', 'Place'].map(a => row({ type: 'otc', otcAction: a as ActivityRow['otcAction'] }))],
      // Staking groups the GIGAHDX/plain variants of one act deliberately; what must
      // stay apart is what the act DOES.
      staking: ['Stake', 'Unstake', 'Staking reward', 'GIGAHDX Migrate', 'GIGAHDX Cancel Unstake']
        .map(a => row({ type: 'staking', stakingAction: a })),
    }
    for (const [fam, rows] of Object.entries(families)) {
      const cols = rows.map(r => activityBadge(r).col)
      expect(new Set(cols).size, `${fam}: ${cols.join(', ')}`).toBe(cols.length)
    }
  })

  it('keeps the GIGAHDX and plain variants of one act on the same shade', () => {
    const same = (a: string, b: string) =>
      expect(activityBadge(row({ type: 'staking', stakingAction: a })).col)
        .toBe(activityBadge(row({ type: 'staking', stakingAction: b })).col)
    same('Stake', 'GIGAHDX Stake')
    same('Unstake', 'GIGAHDX Unstake')
    same('Staking reward', 'GIGAHDX Reward')
    expect(activityBadge(row({ type: 'otc', otcAction: 'Pull' })).col)
      .toBe(activityBadge(row({ type: 'otc', otcAction: 'Place' })).col)
  })

  it('keeps movement grey and out of the hues that carry meaning elsewhere', () => {
    const transfer = activityBadge(row({ type: 'transfer' })).col
    const xcm = activityBadge(row({ type: 'xcm' })).col
    expect(transfer).toBe(CAT.transfer)
    expect(xcm).toBe(CAT.xcm)
    expect(transfer).not.toBe(xcm)
    for (const col of [transfer, xcm]) {
      expect([CAT.trade, CAT.borrow, CAT.liquidity, CAT.stake, CAT.vote, CAT.bad]).not.toContain(col)
    }
  })

  // The runtime emits "Supply"; this app calls it Lend. The value has to stay the
  // chain's (it is the filter and the indexed field), so only the words change —
  // and no surface may leak the chain's word to a reader.
  it('calls the money-market inflow Lend while filtering on the chain\'s Supply', () => {
    expect(activityBadge(row({ type: 'mm', mmAction: 'Supply' })).label).toBe('Lend')
    expect(activityBadge(row({ type: 'mm' })).label).toBe('Lend')   // defaulted rows too
    expect(ACTIVITY_ACTIONS.mm).toContainEqual({ v: 'Supply', label: 'Lend' })
    for (const a of ACTIVITY_ACTIONS.mm) expect(a.label).not.toBe('Supply')
  })

  it('maps a category to one color for the chips and the histogram, and never colors "all"', () => {
    expect(categoryColor('trade')).toBe(CAT.trade)
    expect(categoryColor('mm')).toBe(CAT.borrow)
    expect(categoryColor('liquidity')).toBe(CAT.liquidity)
    expect(categoryColor('stake')).toBe(CAT.stake)
    expect(categoryColor('vote')).toBe(CAT.vote)
    // dca and otc are surfaced under the Trade feed, so they answer to its color.
    expect(categoryColor('dca')).toBe(CAT.trade)
    expect(categoryColor('otc')).toBe(CAT.trade)
    // An unfiltered view is not a category; it takes a neutral slate no family owns.
    expect(categoryColor('all')).toBe(UNFILTERED_COLOR)
    expect(UNFILTERED_COLOR).toBe('var(--chart-neutral)')
  })
})
