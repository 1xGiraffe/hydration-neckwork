import { describe, it, expect } from 'vitest'
import { activityTypeMatchesFamily, activityRowMatchesAction, type ActivityRow } from '../src/services/explorerService.ts'

// OTC folded under the Trade chip/type: otc rows keep `type: 'otc'` (their own
// badges/slugs/detail pages are unchanged) but a `type=trade` request must also
// match them, and the trade family's action filter must accept the three
// hyphenated otc-place/otc-pull/otc-fill values without letting them leak onto
// plain swap/dca rows (or vice versa).

const tradeRow = (dca = false): ActivityRow => ({
  type: 'trade', blockHeight: 1, timestamp: '', eventIndex: 0, extrinsicIndex: 0,
  who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
  dca,
})
const failedDcaRow = (): ActivityRow => ({ ...tradeRow(true), dcaStatus: 'failed' })
const otcRow = (otcAction: 'Place' | 'Pull' | 'Fill'): ActivityRow => ({
  type: 'otc', blockHeight: 1, timestamp: '', eventIndex: 0, extrinsicIndex: 0,
  who: null, to: null, asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null,
  otcAction,
})

describe('activityTypeMatchesFamily', () => {
  it('type=trade matches both trade and otc rows', () => {
    expect(activityTypeMatchesFamily('trade', 'trade')).toBe(true)
    expect(activityTypeMatchesFamily('otc', 'trade')).toBe(true)
  })
  it('type=otc matches only otc rows', () => {
    expect(activityTypeMatchesFamily('otc', 'otc')).toBe(true)
    expect(activityTypeMatchesFamily('trade', 'otc')).toBe(false)
  })
  it('other types are unaffected (exact match only)', () => {
    expect(activityTypeMatchesFamily('transfer', 'transfer')).toBe(true)
    expect(activityTypeMatchesFamily('otc', 'transfer')).toBe(false)
    expect(activityTypeMatchesFamily('mm', 'trade')).toBe(false)
  })
})

describe('activityRowMatchesAction — trade family with folded-in otc', () => {
  it('no action matches everything', () => {
    expect(activityRowMatchesAction(tradeRow(), undefined)).toBe(true)
    expect(activityRowMatchesAction(otcRow('Fill'), undefined)).toBe(true)
  })
  // Note: getDailyActivity must use consistent (block_height, event_index) dedup
  // for both type=trade&action=otc-* and type=otc branches. Two OTC.Placed
  // events in the same block with NULL extrinsic_index (different event_index)
  // must be counted separately. Dedup key (block_height, extrinsic_index) would
  // collapse distinct event indexes incorrectly.
  it('swap/dca still filter plain trade rows as before', () => {
    expect(activityRowMatchesAction(tradeRow(false), 'swap')).toBe(true)
    expect(activityRowMatchesAction(tradeRow(true), 'swap')).toBe(false)
    expect(activityRowMatchesAction(tradeRow(true), 'dca')).toBe(true)
    expect(activityRowMatchesAction(tradeRow(false), 'dca')).toBe(false)
    expect(activityRowMatchesAction(failedDcaRow(), 'dca')).toBe(true)
    expect(activityRowMatchesAction(failedDcaRow(), 'dca-failed')).toBe(true)
    expect(activityRowMatchesAction(tradeRow(true), 'dca-failed')).toBe(false)
  })
  it('otc-place/otc-pull/otc-fill match only the corresponding otc row', () => {
    expect(activityRowMatchesAction(otcRow('Place'), 'otc-place')).toBe(true)
    expect(activityRowMatchesAction(otcRow('Pull'), 'otc-place')).toBe(false)
    expect(activityRowMatchesAction(otcRow('Pull'), 'otc-pull')).toBe(true)
    expect(activityRowMatchesAction(otcRow('Fill'), 'otc-fill')).toBe(true)
    expect(activityRowMatchesAction(otcRow('Fill'), 'otc-pull')).toBe(false)
  })
  it('otc action values never match plain trade rows, and swap/dca never match otc rows', () => {
    expect(activityRowMatchesAction(tradeRow(false), 'otc-fill')).toBe(false)
    expect(activityRowMatchesAction(tradeRow(true), 'otc-fill')).toBe(false)
    expect(activityRowMatchesAction(otcRow('Fill'), 'swap')).toBe(false)
    expect(activityRowMatchesAction(otcRow('Fill'), 'dca')).toBe(false)
  })
  it('type=otc API nicety: the raw Place/Pull/Fill values keep working too', () => {
    expect(activityRowMatchesAction(otcRow('Place'), 'Place')).toBe(true)
    expect(activityRowMatchesAction(otcRow('Pull'), 'Fill')).toBe(false)
  })
})
