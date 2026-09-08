import { describe, expect, it } from 'vitest'
import { activityBadge, categoryColor, intentLabel, CAT, UNFILTERED_COLOR } from '../src/components/activityColors'
import { ACTIVITY_ACTIONS } from '../src/components/ui'
import type { ActivityRow } from '../src/types'

// A row carrying only the fields the badge reads. The rest of ActivityRow is
// irrelevant to the coding, so it is cast in rather than fixtured.
function row(r: Partial<ActivityRow>): ActivityRow {
  return r as ActivityRow
}

// Intents are the Trade filter list's newest values (the chips have no Intent tab),
// so the Trade family admits the violet ramp beside its own orange. The slug each
// filter value carries maps to the action the server fills the row with.
const INTENT_FAMILY = [CAT.intent, CAT.intentFill, CAT.intentCancel, CAT.intentDca]
const INTENT_SLUG_ACTION: Record<string, NonNullable<ActivityRow['intentAction']>> = {
  'intent-place': 'Place', 'intent-fill': 'Fill', 'intent-cancel': 'Cancel', 'intent-expire': 'Expire', 'intent-dca-trade': 'DcaTrade',
}
function slugAction(v: string): NonNullable<ActivityRow['intentAction']> {
  const a = INTENT_SLUG_ACTION[v]
  if (!a) throw new Error(`${v} is not an intent filter value`)
  return a
}
function intentRow(action: ActivityRow['intentAction']): ActivityRow {
  return row({ type: 'intent', intentKind: action === 'DcaTrade' ? 'dca' : 'swap', intentAction: action })
}

// The coding is only worth anything if a hue means one thing. These pin the parts
// that would silently drift: a new action falling through to the grey default, or
// a family leaking into a hue that belongs to another.
describe('activity category coding', () => {
  it('gives every action in the shared filter list a color from its own family', () => {
    const family: Record<string, string[]> = {
      trade: [CAT.trade, CAT.tradeDca, CAT.tradeFill, CAT.tradePlace, CAT.bad, ...INTENT_FAMILY],
      mm: [CAT.borrow, CAT.borrowWithdraw, CAT.borrowLend, CAT.borrowRepay, CAT.borrowClaim, CAT.bad],
      liquidity: [CAT.liquidity, CAT.liquidityRemove, CAT.liquidityCreate, CAT.liquidityClaim],
      stake: [CAT.stake, CAT.stakeExit, CAT.stakeReward, CAT.stakeMigrate, CAT.stakeCancel],
      bond: [CAT.bond, CAT.bondRedeem],
      intent: INTENT_FAMILY,
      vote: [CAT.vote, CAT.aye, CAT.nay],
      xcm: [CAT.xcm],
    }
    // Build the row shape each action arrives in, mirroring how the server fills them.
    const build: Record<string, (v: string) => ActivityRow> = {
      trade: v => v.startsWith('otc-')
        ? row({ type: 'otc', otcAction: (v.slice(4, 5).toUpperCase() + v.slice(5)) as ActivityRow['otcAction'] })
        : v.startsWith('intent-') ? intentRow(slugAction(v))
        : row({ type: 'trade', dca: v.startsWith('dca'), dcaStatus: v === 'dca-failed' ? 'failed' : undefined }),
      mm: v => row({ type: 'mm', mmAction: v }),
      liquidity: v => row({ type: 'liquidity', liqAction: v as ActivityRow['liqAction'] }),
      stake: v => row({ type: 'staking', stakingAction: v }),
      bond: v => row({ type: 'bond', bondAction: v as ActivityRow['bondAction'] }),
      intent: v => intentRow(v as ActivityRow['intentAction']),
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
    const types: ActivityRow['type'][] = ['transfer', 'trade', 'xcm', 'liquidity', 'mm', 'dca', 'staking', 'vote', 'otc', 'bond', 'intent']
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
      bond: (['Issue', 'Redeem'] as const).map(a => row({ type: 'bond', bondAction: a })),
      // PartialFill shares Fill's shade and Expire shares Cancel's (see the grouping
      // test below); what must stay apart is place, fill, leave, and a DCA's trade.
      intent: (['Place', 'Fill', 'Cancel', 'DcaTrade'] as const).map(a => intentRow(a)),
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
    // A partial fill IS a fill, and an expiry IS the order leaving unfilled — each
    // wears its sibling's shade and the label tells them apart.
    expect(activityBadge(intentRow('PartialFill')).col).toBe(activityBadge(intentRow('Fill')).col)
    expect(activityBadge(intentRow('Expire')).col).toBe(activityBadge(intentRow('Cancel')).col)
  })

  // The product calls a swap intent a limit order and a dca intent a DCA intent, and
  // every surface says so in those words. The Trade filter list reads them from the
  // same function the badge does, so the two cannot diverge.
  it('names intents in the product\'s words, on the badge and in the filter list alike', () => {
    expect(activityBadge(intentRow('Place')).label).toBe('Limit order placed')
    expect(activityBadge(intentRow('Fill')).label).toBe('Limit order filled')
    expect(activityBadge(intentRow('PartialFill')).label).toBe('Limit order partially filled')
    expect(activityBadge(intentRow('Cancel')).label).toBe('Limit order cancelled')
    expect(activityBadge(intentRow('Expire')).label).toBe('Limit order expired')
    expect(activityBadge(intentRow('DcaTrade')).label).toBe('DCA intent trade')
    expect(intentLabel('dca', 'Place')).toBe('DCA intent placed')
    expect(intentLabel('dca', 'Cancel')).toBe('DCA intent cancelled')
    expect(intentLabel(undefined, undefined)).toBe('Intent')
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'intent-place', label: 'Limit order placed' })
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'intent-fill', label: 'Limit order filled' })
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'intent-cancel', label: 'Limit order cancelled' })
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'intent-expire', label: 'Limit order expired' })
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'intent-dca-trade', label: 'DCA intent trade' })
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
    // Intents are filed under Trade too, but own their violet where a surface names them.
    expect(categoryColor('intent')).toBe(CAT.intent)
    // An unfiltered view is not a category; it takes a neutral slate no family owns.
    expect(categoryColor('all')).toBe(UNFILTERED_COLOR)
    expect(UNFILTERED_COLOR).toBe('var(--chart-neutral)')
  })
})
