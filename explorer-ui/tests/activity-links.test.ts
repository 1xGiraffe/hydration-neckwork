import { describe, it, expect } from 'vitest'
import { activitySlug, activityId, canonicalTarget, parseId, SLUG_TYPES } from '../src/components/ActivityTable'
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
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'Supply' })).toBe('supply')
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'LiquidationCall' })).toBe('liquidate')
    expect(activitySlug({ ...base, type: 'mm', mmAction: 'Repay' })).toBe('repay')
    expect(activitySlug({ ...base, type: 'staking', stakingAction: 'Giga stake' })).toBe('staking')
    expect(activitySlug({ ...base, type: 'vote', voteSide: 'Aye' })).toBe('vote')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Place' })).toBe('otc-place')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Pull' })).toBe('otc-pull')
    expect(activitySlug({ ...base, type: 'otc', otcAction: 'Fill' })).toBe('otc-fill')
  })
})

describe('activityId', () => {
  it('prefers the event index', () => expect(activityId(base)).toBe('100-e7'))
  it('falls back to the extrinsic index', () => expect(activityId({ ...base, eventIndex: null })).toBe('100-2'))
  it('returns null with neither', () => expect(activityId({ ...base, eventIndex: null, extrinsicIndex: null })).toBe(null))
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
    for (const slug of ['supply', 'withdraw', 'borrow', 'repay', 'liquidate'] as const) {
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
})

describe('canonicalTarget (otc)', () => {
  it('redirects on otc slug mismatch (row is a pull, current slug is otc-place)', () => {
    const row: ActivityRow = { ...base, type: 'otc', otcAction: 'Pull', otcOrderId: 42 }
    expect(canonicalTarget(row, 'otc-place', '100-e7')).toBe('/otc-pull/100-e7')
  })
})
