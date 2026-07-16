import { describe, it, expect } from 'vitest'
import { parseRoute, paths, shouldMorphSearch } from '../src/router'

const p = (hash: string) => parseRoute(hash.replace(/^#/, ''))

describe('parseRoute (clean-path routing, design routes)', () => {
  it('maps the design routes', () => {
    expect(p('/')).toEqual({ name: 'dashboard' })
    expect(p('/activity')).toEqual({ name: 'activity' })
    expect(p('/votes')).toEqual({ name: 'legacy', to: '/activity?tab=vote' })
    expect(p('/blocks')).toEqual({ name: 'blocks' })
    expect(p('/block/12847348')).toEqual({ name: 'block', height: 12847348 })
    expect(p('/extrinsics')).toEqual({ name: 'extrinsics' })
    expect(p('/extrinsic/12847348-2')).toEqual({ name: 'extrinsic', id: '12847348-2' })
    expect(p('/trade/12847348-e77')).toEqual({ name: 'legacy', to: '/swap/12847348-e77' })
    expect(p('/events')).toEqual({ name: 'events' })
    expect(p('/transfers')).toEqual({ name: 'legacy', to: '/activity?tab=transfer' })
    expect(p('/trades')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(p('/accounts')).toEqual({ name: 'accounts' })
    expect(p('/account/7P6Agw')).toEqual({ name: 'account', address: '7P6Agw' })
    expect(p('/assets')).toEqual({ name: 'assets' })
    expect(p('/hdx')).toEqual({ name: 'hdx' })
    expect(p('/hollar')).toEqual({ name: 'hollar' })
    expect(p('/asset/5')).toEqual({ name: 'asset', assetId: 5 })
    expect(p('/holders/0')).toEqual({ name: 'holders', assetId: 0 })
    expect(p('/nope')).toEqual({ name: 'notfound', path: '/nope' })
  })
  it('path builders round-trip', () => {
    expect(p(paths.block(42))).toEqual({ name: 'block', height: 42 })
    expect(p(paths.hollar())).toEqual({ name: 'hollar' })
    expect(p(paths.asset(5))).toEqual({ name: 'asset', assetId: 5 })
    expect(p(paths.extrinsicAt(100, 3))).toEqual({ name: 'extrinsic', id: '100-3' })
  })
  it('rejects malformed encodings and unsafe numeric identifiers without throwing', () => {
    expect(p('/account/%E0%A4%A')).toEqual({ name: 'notfound', path: '/account/%E0%A4%A' })
    expect(p('/block/01')).toEqual({ name: 'blocks' })
    expect(p('/block/9007199254740992')).toEqual({ name: 'blocks' })
    expect(p('/asset/1x')).toEqual({ name: 'assets' })
  })
})

describe('activity detail routes', () => {
  it('parses every activity slug', () => {
    for (const slug of ['swap', 'transfer', 'cross-chain', 'add-liquidity', 'remove-liquidity', 'supply', 'withdraw', 'borrow', 'repay', 'liquidate', 'staking', 'vote', 'otc-place', 'otc-pull', 'otc-fill']) {
      expect(p(`/${slug}/13072380-e2`)).toEqual({ name: 'activity-detail', slug, id: '13072380-e2' })
      expect(p(`/${slug}/13072380-4`)).toEqual({ name: 'activity-detail', slug, id: '13072380-4' })
    }
    // DCA is a schedule page: numeric ids open it, legacy per-execution links
    // redirect to the underlying extrinsic.
    expect(p('/dca/33546')).toEqual({ name: 'dca-schedule', scheduleId: 33546 })
    expect(p('/dca/13072380-4')).toEqual({ name: 'dca-resolve', height: 13072380, index: 4, kind: 'extrinsic' })
    expect(p('/dca/13072380-e2')).toEqual({ name: 'dca-resolve', height: 13072380, index: 2, kind: 'event' })
  })
  it('rejects malformed activity ids', () => {
    expect(p('/swap/abc')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(p('/cross-chain/')).toEqual({ name: 'legacy', to: '/activity?tab=xcm' })
    // OTC folds under the Trade activity tab (rows keep their own otc-* slugs).
    expect(p('/otc-place/abc')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(p('/otc-pull/')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
    expect(p('/otc-fill/abc')).toEqual({ name: 'legacy', to: '/activity?tab=trade' })
  })
  it('redirects legacy /trade to /swap', () => {
    expect(p('/trade/12847348-e77')).toEqual({ name: 'legacy', to: '/swap/12847348-e77' })
  })
  it('round-trips the path builder', () => {
    expect(p(paths.activityDetail('cross-chain', '13072380-e2'))).toEqual({ name: 'activity-detail', slug: 'cross-chain', id: '13072380-e2' })
  })
})

describe('shouldMorphSearch — hero ⇄ topbar search morph gate', () => {
  // Node test env: fabricate the two globals the gate consults.
  const stub = (reducedMotion: boolean) => {
    const g = globalThis as Record<string, unknown>
    g.document = { startViewTransition: () => {} }
    g.window = { matchMedia: (q: string) => ({ matches: q.includes('prefers-reduced-motion') ? reducedMotion : false }) }
  }

  it('morphs when crossing the "/" boundary — on any viewport, including mobile', () => {
    stub(false)
    expect(shouldMorphSearch('/', '/activity')).toBe(true)
    expect(shouldMorphSearch('/blocks', '/')).toBe(true)
  })

  it('never morphs within the same side of the boundary', () => {
    stub(false)
    expect(shouldMorphSearch('/activity', '/blocks')).toBe(false)
    expect(shouldMorphSearch('/', '/')).toBe(false)
  })

  it('respects prefers-reduced-motion', () => {
    stub(true)
    expect(shouldMorphSearch('/', '/activity')).toBe(false)
  })
})
