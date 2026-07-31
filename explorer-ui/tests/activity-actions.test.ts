import { describe, expect, it } from 'vitest'
import { assetIconCandidates, normalizeActivityAction, originChainIconUrl, ACTIVITY_ACTIONS } from '../src/components/ui'
import { activitySlug, SLUG_TYPES } from '../src/components/ActivityTable'
import { activityBadge } from '../src/components/activityColors'
import type { ActivityRow } from '../src/types'

describe('trade activity actions', () => {
  it('offers failed DCA on every surface using the shared action list', () => {
    expect(ACTIVITY_ACTIONS.trade).toContainEqual({ v: 'dca-failed', label: 'Failed DCA' })
    expect(normalizeActivityAction('trade', 'dca-failed')).toBe('dca-failed')
  })

  it('does not accept the trade-only action on another activity family', () => {
    expect(normalizeActivityAction('liquidity', 'dca-failed')).toBe('')
  })
})

describe('origin asset icons', () => {
  const ethereumUsdc = { ecosystem: 'ethereum', chainId: '1', assetId: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' } as const

  it('prefers the canonical Ethereum contract icon over the missing local icon', () => {
    const sources = assetIconCandidates(1000766, ethereumUsdc)
    expect(sources[0]).toContain('/ethereum/1/assets/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/icon.svg')
    // `not.toContain(expect.stringContaining(...))` compares array members with
    // Object.is, and an asymmetric matcher is never identical to a string, so that
    // form passed for every input. Map to booleans instead: the list length is part
    // of the assertion, so a candidate appearing or vanishing both fail here.
    expect(sources.map(source => source.includes('/polkadot/2034/assets/1000766/'))).toEqual([false, false])
  })

  it('derives the matching origin-chain badge', () => {
    expect(originChainIconUrl(ethereumUsdc)).toContain('/ethereum/1/icon.svg')
  })
})

describe('reward claim classification', () => {
  it('offers and routes incentives claims as claim-rewards activities', () => {
    expect(ACTIVITY_ACTIONS.mm).toContainEqual({ v: 'ClaimRewards', label: 'Claim Lend Rewards' })
    expect(normalizeActivityAction('mm', 'ClaimRewards')).toBe('ClaimRewards')
    expect(activitySlug({ type: 'mm', mmAction: 'ClaimRewards' } as ActivityRow)).toBe('claim-rewards')
    expect(SLUG_TYPES['claim-rewards']).toEqual(expect.arrayContaining(['mm', 'liquidity']))
  })

  // Two unrelated claims share one slug, so the label is the only thing telling a
  // reader which position paid out. They met in the merged feed as one word.
  it('names the lending claim and the liquidity claim apart', () => {
    expect(activityBadge({ type: 'mm', mmAction: 'ClaimRewards' } as ActivityRow).label).toBe('Claim Lend Rewards')
    expect(activityBadge({ type: 'liquidity', liqAction: 'Claim' } as ActivityRow).label).toBe('Claim LP Rewards')
    expect(ACTIVITY_ACTIONS.liquidity).toContainEqual({ v: 'Claim', label: 'Claim LP Rewards' })
  })
})
