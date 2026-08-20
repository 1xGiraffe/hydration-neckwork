import { describe, expect, it } from 'vitest'
import { revenueRowMatches, liquidationRowMatches } from '../src/notifications/evaluator.ts'
import { parseRuleParams } from '../src/notifications/notificationRules.ts'

const row = (over: Record<string, unknown> = {}) => ({
  type: 'trade', blockHeight: 100, extrinsicIndex: 1, eventIndex: 2,
  timestamp: '2026-08-20 12:00:00', valueUsd: 1000, ...over,
} as never)

describe('a protocol-revenue rule', () => {
  it('matches an extrinsic at or above the floor', () => {
    expect(revenueRowMatches(row({ revenue: { protocolUsd: 12, lpUsd: 0, streams: [] } }), { minUsd: 10 })).toBe(true)
    expect(revenueRowMatches(row({ revenue: { protocolUsd: 10, lpUsd: 0, streams: [] } }), { minUsd: 10 })).toBe(true)
  })

  it('does not match below the floor', () => {
    expect(revenueRowMatches(row({ revenue: { protocolUsd: 9.99, lpUsd: 0, streams: [] } }), { minUsd: 10 })).toBe(false)
  })

  // The field is absent for a block whose events are not queryable yet. Reading that
  // as 0 would decide "no match" permanently, and the lane's cursor moves forward
  // only — the row would never be reconsidered once its events landed.
  it('does not match a row whose revenue is not known yet', () => {
    expect(revenueRowMatches(row(), { minUsd: 10 })).toBe(false)
  })

  // The LP half is not the protocol's, so a trade paying LPs handsomely and the
  // protocol nothing must not fire a protocol-revenue rule.
  it('judges the protocol share only, not what went to LPs', () => {
    expect(revenueRowMatches(row({ revenue: { protocolUsd: 1, lpUsd: 500, streams: [] } }), { minUsd: 10 })).toBe(false)
  })

  it('requires a floor, since every extrinsic earns something', () => {
    expect(parseRuleParams('protocol-revenue', {}).ok).toBe(false)
    expect(parseRuleParams('protocol-revenue', { minUsd: 0 }).ok).toBe(false)
    expect(parseRuleParams('protocol-revenue', { minUsd: 10 }).ok).toBe(true)
  })
})

describe('a liquidation rule', () => {
  const liq = (over: Record<string, unknown> = {}) =>
    row({ type: 'mm', mmAction: 'LiquidationCall', ...over })

  it('matches a liquidation call', () => {
    expect(liquidationRowMatches(liq(), {})).toBe(true)
  })

  it('ignores money-market activity that is not a liquidation', () => {
    expect(liquidationRowMatches(row({ type: 'mm', mmAction: 'Borrow' }), {})).toBe(false)
    expect(liquidationRowMatches(row({ type: 'mm', mmAction: 'Supply' }), {})).toBe(false)
  })

  it('ignores a non-money-market row', () => {
    expect(liquidationRowMatches(row(), {})).toBe(false)
  })

  it('honours an optional value floor', () => {
    expect(liquidationRowMatches(liq({ valueUsd: 5000 }), { minUsd: 1000 })).toBe(true)
    expect(liquidationRowMatches(liq({ valueUsd: 500 }), { minUsd: 1000 })).toBe(false)
  })

  // An unvalued row must not slip past a floor the owner set deliberately.
  it('does not match an unvalued liquidation when a floor is set', () => {
    expect(liquidationRowMatches(liq({ valueUsd: null }), { minUsd: 1000 })).toBe(false)
  })

  it('still matches an unvalued liquidation when no floor is set', () => {
    expect(liquidationRowMatches(liq({ valueUsd: null }), {})).toBe(true)
  })

  it('needs no floor, since liquidations are rare', () => {
    expect(parseRuleParams('liquidation', {}).ok).toBe(true)
  })
})
