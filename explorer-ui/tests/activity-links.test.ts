import { describe, it, expect } from 'vitest'
import { activitySlug, activityId, activityHref, activityLabel, canonicalTarget, subordinateActivityTarget, parseId, SLUG_TYPES } from '../src/components/ActivityTable'
import { LIQ_LABELS } from '../src/components/activityColors'
import { paths } from '../src/router'
import type { ActivityRow } from '../src/types'

const base: ActivityRow = {
  type: 'transfer', blockHeight: 100, timestamp: '2026-07-10 00:00:00',
  eventIndex: 7, extrinsicIndex: 2, who: null, to: null, asset: null,
  assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
}

describe('activitySlug', () => {
  it('maps rows to canonical slugs', () => {
    expect(activitySlug({ ...base, type: 'trade' })).toBe('swap')
    expect(activitySlug({ ...base, type: 'trade', dca: true })).toBe('dca')
    expect(activitySlug({ ...base, type: 'dca' })).toBe('dca')
    expect(activitySlug(base)).toBe('transfer')
    expect(activitySlug({ ...base, type: 'xcm' })).toBe('cross-chain')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Add' })).toBe('add-liquidity')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Remove' })).toBe('remove-liquidity')
    expect(activitySlug({ ...base, type: 'liquidity', liqAction: 'Destroy' })).toBe('destroy-pool')
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'Supply' })).toBe('lend')
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'LiquidationCall' })).toBe('liquidate')
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'Repay' })).toBe('repay')
    expect(activitySlug({ ...base, type: 'staking', stakingAction: 'GIGAHDX Stake' })).toBe('staking')
    expect(activitySlug({ ...base, type: 'bond', bondAction: 'Issue' })).toBe('bond-issue')
    expect(activitySlug({ ...base, type: 'bond', bondAction: 'Redeem' })).toBe('bond-redeem')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'Place' })).toBe('intent-place')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'Fill' })).toBe('intent-fill')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'PartialFill' })).toBe('intent-fill')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'Cancel' })).toBe('intent-cancel')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'Expire' })).toBe('intent-expire')
    expect(activitySlug({ ...base, type: 'intent', intentAction: 'DcaTrade' })).toBe('intent-dca-trade')
    expect(activitySlug({ ...base, type: 'vote', voteSide: 'Aye' })).toBe('vote')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Place' })).toBe('otc-place')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Pull' })).toBe('otc-pull')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Fill' })).toBe('otc-fill')
  })
})

// The slug label (crumbs/route title) and the liqAction label (the detail page's
// Action field, via LIQ_LABELS[row.liqAction ?? ''] ?? LIQ_LABELS.Add in
// ActivityDetail) are two independent maps that must still agree on a pool
// destruction — the same double-naming reward-claim rows already need.
describe('destroy-pool labels', () => {
  it('names the slug and the liquidity action the same way', () => {
    expect(activityLabel('destroy-pool')).toBe('Destroy pool')
    expect(LIQ_LABELS.Destroy).toBe('Destroy pool')
  })
})

describe('activityId', () => {
  it('prefers the event index', () => expect(activityId(base)).toBe('100-e7'))
  it('falls back to the extrinsic index', () => expect(activityId({ ...base, eventIndex: null })).toBe('100-2'))
  it('returns null with neither', () => expect(activityId({ ...base, eventIndex: null, extrinsicIndex: null })).toBe(null))
  it('links a DCA row to its owning schedule by default', () => {
    expect(activityId({ ...base, type: 'dca', dca: true, dcaScheduleId: 42, eventIndex: 7 })).toBe('42')
  })
  it('links a DCA row to its own execution when the execution flag is set', () => {
    expect(activityId({ ...base, type: 'dca', dca: true, dcaScheduleId: 42, eventIndex: 7 }, true)).toBe('100-e7')
  })
  // An intent row's link is its ORDER page, not the one event — as a DCA row's is its
  // schedule. The id is the u128 as a decimal string (it survives as text where a
  // number would not); the short #seq handle is display only.
  it('links an intent row to its order by the full intent id', () => {
    expect(activityId({ ...base, type: 'intent', intentAction: 'Fill', intentId: '18446744073709551617', intentSeq: 1 })).toBe('18446744073709551617')
  })
  // The block, extrinsic and order pages pass the execution flag because there a row
  // IS one event: the intent event's own detail page is where it must lead — the same
  // rule DCA follows, and the only way that page is ever reached.
  it('links an intent row to its own event when the execution flag is set', () => {
    expect(activityId({ ...base, type: 'intent', intentAction: 'Fill', intentId: '18446744073709551617', intentSeq: 1 }, true)).toBe('100-e7')
  })
  it('falls back to the coordinate id for an intent row without an order id', () => {
    expect(activityId({ ...base, type: 'intent', intentAction: 'Fill' })).toBe('100-e7')
    expect(activityId({ ...base, type: 'intent', intentAction: 'Fill' }, true)).toBe('100-e7')
  })
})

// A slug addresses an activity detail page by coordinates; an order is addressed by
// its id under /intent. /intent-fill/<intentId> is a URL the router turns away, so
// the row link goes through this and an intent row lands on its order page.
describe('activityHref', () => {
  const intent: ActivityRow = { ...base, type: 'intent', intentAction: 'Fill', intentId: '7', intentSeq: 7 }
  it('sends an intent row to its order page when handed its order id', () => expect(activityHref(intent, '7')).toBe('/intent/7'))
  // The href keys on the id's VALUE, not the row's type: coordinates go under the slug
  // whatever the row is, so /intent/<h>-e<i> can never be built.
  it('sends an intent row to its slug page when handed its coordinates', () => {
    expect(activityHref(intent, '100-e7')).toBe('/intent-fill/100-e7')
    expect(activityHref({ ...intent, intentAction: 'Place' }, '100-e7')).toBe('/intent-place/100-e7')
    expect(activityHref({ ...base, type: 'intent', intentAction: 'Fill' }, '100-e7')).toBe('/intent-fill/100-e7')
  })
  it('round-trips activityId on both surfaces', () => {
    expect(activityHref(intent, activityId(intent)!)).toBe('/intent/7')
    expect(activityHref(intent, activityId(intent, true)!)).toBe('/intent-fill/100-e7')
  })
  it('sends every other row to its slug detail page', () => expect(activityHref(base, '100-e7')).toBe('/transfer/100-e7'))
  it('agrees with paths.intent', () => expect(paths.intent('18446744073709551616')).toBe('/intent/18446744073709551616'))
})

describe('canonicalTarget', () => {
  it('returns null when the row already matches the current slug and event-form id', () => {
    expect(canonicalTarget(base, 'transfer', '100-e7')).toBe(null)
  })

  it('canonicalizes on slug mismatch (row is dca, current slug is swap)', () => {
    const row: ActivityRow = { ...base, type: 'trade', dca: true }
    expect(canonicalTarget(row, 'swap', '100-e7')).toBe('/dca/100-e7')
  })

  it('upgrades an extrinsic-form id to the event form when the slug already matches', () => {
    expect(canonicalTarget(base, 'transfer', '100-2')).toBe('/transfer/100-e7')
  })

  it('canonicalizes both slug and id when both are wrong', () => {
    const row: ActivityRow = { ...base, type: 'trade', dca: true }
    expect(canonicalTarget(row, 'swap', '100-2')).toBe('/dca/100-e7')
  })

  // The page for one intent EVENT is addressed by coordinates like every other
  // activity page, so it must not canonicalise onto the order id activityId() hands
  // the row link — /intent-fill/<intentId> is not a page.
  it('keeps an intent event on its coordinates rather than its order id', () => {
    const row: ActivityRow = { ...base, type: 'intent', intentAction: 'PartialFill', intentId: '7', intentSeq: 7 }
    expect(canonicalTarget(row, 'intent-fill', '100-e7')).toBe(null)
    expect(canonicalTarget(row, 'intent-place', '100-e7')).toBe('/intent-fill/100-e7')
    expect(canonicalTarget(row, 'intent-fill', '100-2')).toBe('/intent-fill/100-e7')
  })
})

describe('parseId', () => {
  it('parses the event-index form', () => {
    expect(parseId('123-e45')).toEqual({ height: 123, eventIndex: 45, extrinsicIndex: null })
  })
  it('parses the extrinsic-index form', () => {
    expect(parseId('123-45')).toEqual({ height: 123, eventIndex: null, extrinsicIndex: 45 })
  })
  it('returns null for non-numeric input', () => expect(parseId('abc')).toBe(null))
  it('returns null for a dangling separator', () => expect(parseId('12-')).toBe(null))
})

describe('SLUG_TYPES', () => {
  it('maps swap and dca to the trade coarse type', () => {
    expect(SLUG_TYPES.swap).toEqual(['trade', 'dca'])
    expect(SLUG_TYPES.dca).toEqual(['trade', 'dca'])
  })
  it('maps cross-chain to xcm', () => expect(SLUG_TYPES['cross-chain']).toEqual(['xcm']))
  it('maps the five mm slugs to mm', () => {
    for (const slug of ['lend', 'withdraw', 'borrow', 'repay', 'liquidate'] as const) {
      expect(SLUG_TYPES[slug]).toEqual(['mm'])
    }
  })
  it('maps liquidity slugs to liquidity', () => {
    expect(SLUG_TYPES['add-liquidity']).toEqual(['liquidity'])
    expect(SLUG_TYPES['remove-liquidity']).toEqual(['liquidity'])
  })
  it('maps transfer, staking and vote to their own singleton types', () => {
    expect(SLUG_TYPES.transfer).toEqual(['transfer'])
    expect(SLUG_TYPES.staking).toEqual(['staking'])
    expect(SLUG_TYPES.vote).toEqual(['vote'])
  })
  it('maps the three otc slugs to the otc coarse type', () => {
    expect(SLUG_TYPES['otc-place']).toEqual(['otc'])
    expect(SLUG_TYPES['otc-pull']).toEqual(['otc'])
    expect(SLUG_TYPES['otc-fill']).toEqual(['otc'])
  })
  it('maps both bond slugs to the bond type and labels them like the badges', () => {
    expect(SLUG_TYPES['bond-issue']).toEqual(['bond'])
    expect(SLUG_TYPES['bond-redeem']).toEqual(['bond'])
    expect(activityLabel('bond-issue')).toBe('Bond issue')
    expect(activityLabel('bond-redeem')).toBe('Bond redeem')
  })
  it('maps the five intent slugs to the intent type and labels them in the product\'s words', () => {
    for (const slug of ['intent-place', 'intent-fill', 'intent-cancel', 'intent-expire', 'intent-dca-trade'] as const) {
      expect(SLUG_TYPES[slug]).toEqual(['intent'])
    }
    expect(activityLabel('intent-place')).toBe('Limit order placed')
    expect(activityLabel('intent-fill')).toBe('Limit order filled')
    expect(activityLabel('intent-cancel')).toBe('Limit order cancelled')
    expect(activityLabel('intent-expire')).toBe('Limit order expired')
    expect(activityLabel('intent-dca-trade')).toBe('DCA intent trade')
  })
})

describe('canonicalTarget (otc)', () => {
  it('redirects on otc slug mismatch (row is a pull, current slug is otc-place)', () => {
    const row: ActivityRow = { ...base, type: 'otc', otcAction: 'Pull', otcOrderId: 42 }
    expect(canonicalTarget(row, 'otc-place', '100-e7')).toBe('/otc-pull/100-e7')
  })
})

// An id can name an event that is real, is part of an activity, and is deliberately
// not a row of its own: the transfer legs and fee withdrawals of an OTC fill, a swap
// or a money-market call. Before this, such an id answered "No transfer activity
// found" under a page titled "Transfer" — asserting a family the event never belonged
// to, and stranding the reader one click from what it actually is.
describe('subordinateActivityTarget', () => {
  const at = (extrinsicIndex: number | null, over: Partial<ActivityRow> = {}): ActivityRow => ({
    type: 'transfer', blockHeight: 13278487, timestamp: '2026-07-23 01:43:42', eventIndex: 12,
    extrinsicIndex, who: null, to: null, asset: null, assetIn: null, assetOut: null,
    amount: null, amountIn: null, amountOut: null, valueUsd: null, ...over,
  } as ActivityRow)

  it('hands a plumbing event over to the activity owning its extrinsic', () => {
    // The real case: OTC.fill_order emits transfer legs at e6/e8 and the fill at e12.
    const rows = [at(2, { type: 'otc', otcAction: 'Fill', eventIndex: 12 })]
    expect(subordinateActivityTarget(rows, 2)).toBe('/otc-fill/13278487-e12')
  })

  it('refuses to guess when the extrinsic holds several activities', () => {
    const rows = [
      at(2, { type: 'otc', otcAction: 'Fill', eventIndex: 12 }),
      at(2, { type: 'otc', otcAction: 'Fill', eventIndex: 20 }),
    ]
    expect(subordinateActivityTarget(rows, 2)).toBeNull()
  })

  it('has nowhere to hand over when nothing owns the extrinsic', () => {
    expect(subordinateActivityTarget([at(9, { type: 'swap' })], 2)).toBeNull()
    expect(subordinateActivityTarget([], 2)).toBeNull()
    // A hook event has no extrinsic to be owned by.
    expect(subordinateActivityTarget([at(2, { type: 'otc' })], null)).toBeNull()
  })

  // A DCA execution's own id is its schedule, so an owner with no addressable row
  // falls back to the extrinsic rather than building a broken activity URL.
  it('falls back to the extrinsic when the owner has no id of its own', () => {
    const rows = [at(2, { type: 'transfer', eventIndex: null, extrinsicIndex: 2 })]
    expect(subordinateActivityTarget(rows, 2)).toBe('/transfer/13278487-2')
  })

  // A fill's transfer legs belong to the fill EVENT in that block, so the handover is
  // to its own detail page — as an OTC fill's is — not to the order page.
  it('hands an intent fill\'s plumbing over to the fill event, not the order', () => {
    const rows = [at(2, { type: 'intent', intentAction: 'Fill', intentId: '7', intentSeq: 7, eventIndex: 12 })]
    expect(subordinateActivityTarget(rows, 2)).toBe('/intent-fill/13278487-e12')
  })
})
