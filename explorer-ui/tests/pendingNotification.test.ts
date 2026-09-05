import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PENDING_NOTIFICATION_KEY, claimPendingNotification, clearPendingNotification,
  readPendingNotification, stashPendingNotification,
} from '../src/pendingNotification'
import { notifiableFilters } from '../src/pages/Activity'
import { buildRuleParams } from '../src/components/NewAlertDialog'

// jsdom/happy-dom aren't project dependencies, so there is no ambient
// `localStorage` under the default Node test environment — stand one in, same
// as tests/session.test.ts does for the session store.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

const OWL = '1NPoMQbiA6trJKkjB35uk96MeJD4PGWkLQLH7k7hXEkZpiba'

describe('pending notification handoff', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

  it('round-trips the intended rule across a login', async () => {
    stashPendingNotification({ kind: 'account-activity', params: { address: OWL }, name: 'Owl watch' })
    // What survives is exactly a create-rule body — the same object the button
    // would have POSTed had there been a session.
    expect(readPendingNotification()).toEqual({ kind: 'account-activity', params: { address: OWL }, name: 'Owl watch' })

    const posted: unknown[] = []
    const claimed = await claimPendingNotification(async rule => { posted.push(rule) })
    expect(claimed?.kind).toBe('account-activity')
    expect(posted).toEqual([{ kind: 'account-activity', params: { address: OWL }, name: 'Owl watch' }])
    // Single-shot: nothing is left to re-POST on the next session change.
    expect(readPendingNotification()).toBeNull()
    expect(await claimPendingNotification(async () => { throw new Error('must not run') })).toBeNull()
  })

  it('drops the intent before the request, so a failed create cannot loop', async () => {
    stashPendingNotification({ kind: 'safety', params: {} })
    await expect(claimPendingNotification(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(readPendingNotification()).toBeNull()
  })

  it('ignores a stashed value an older build wrote', () => {
    localStorage.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({ kind: 'whale-watch', params: {} }))
    expect(readPendingNotification()).toBeNull()
    localStorage.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({ kind: 'safety', params: 'all' }))
    expect(readPendingNotification()).toBeNull()
    localStorage.setItem(PENDING_NOTIFICATION_KEY, '{broken')
    expect(() => readPendingNotification()).not.toThrow()
    expect(readPendingNotification()).toBeNull()
  })

  it('omits an empty name rather than storing one', () => {
    stashPendingNotification({ kind: 'safety', params: {}, name: '' })
    expect(readPendingNotification()).toEqual({ kind: 'safety', params: {} })
    clearPendingNotification()
    expect(readPendingNotification()).toBeNull()
  })
})

describe('activity filters → alert rule', () => {
  it('expresses a token + USD floor as a large-trade rule', () => {
    // No name: the server describes the rule, and it is the side that holds the
    // asset registry — naming it here read "on asset 1000625" where the server says
    // "on sUSDe", and put Title case in the same slot as a lowercase summary.
    expect(notifiableFilters('all', '0', '10000')).toEqual({
      kind: 'large-trade',
      params: { assetId: 0, minUsd: 10_000 },
    })
    expect(notifiableFilters('trade', '0', '10000')?.kind).toBe('large-trade')
  })

  // The transfer tab has its own trigger kind, over the same two filters.
  it('expresses the same filters on the transfer tab as a large-transfer rule', () => {
    expect(notifiableFilters('transfer', '0', '10000')).toEqual({
      kind: 'large-transfer',
      params: { assetId: 0, minUsd: 10_000 },
    })
  })

  it('hides rather than dropping half a filter it cannot express', () => {
    expect(notifiableFilters('all', '0', undefined)).toBeNull()      // no floor
    expect(notifiableFilters('all', undefined, '10000')).toBeNull()  // no token
    // Below the server's own floor a "large trade" rule would match every trade.
    expect(notifiableFilters('all', '0', '50')).toBeNull()
    expect(notifiableFilters('all', 'not-an-id', '10000')).toBeNull()
    // A tab with no trigger kind behind it: a trade rule would silently drop the
    // category the reader is actually looking at.
    expect(notifiableFilters('liquidity', '0', '10000')).toBeNull()
    expect(notifiableFilters('xcm', '0', '10000')).toBeNull()
  })
})

describe('new-alert form → rule params', () => {
  const noSets = { phases: [], safetyKinds: [] }

  it('builds each kind\'s params and omits every unset optional', () => {
    // A bare address in the box is still accepted, and always written as the
    // target union — the legacy flat shape is read, never written.
    expect(buildRuleParams('account-activity', { address: OWL, type: 'all', minUsd: '' }, noSets))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: OWL } } })
    expect(buildRuleParams('account-activity', { address: OWL, type: 'trade', minUsd: '500' }, noSets))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: OWL }, type: 'trade', minUsd: 500 } })
    expect(buildRuleParams('large-trade', { minUsd: '10000', assetId: '5' }, noSets))
      .toEqual({ ok: true, params: { minUsd: 10_000, assetId: 5 } })
    expect(buildRuleParams('large-transfer', { minUsd: '10000', assetId: '' }, noSets))
      .toEqual({ ok: true, params: { minUsd: 10_000 } })
    expect(buildRuleParams('price', { assetId: '0', direction: 'below', price: '0.02' }, noSets))
      .toEqual({ ok: true, params: { assetId: 0, direction: 'below', price: 0.02 } })
    // The market is the one default sent explicitly: the server fills it in
    // too, and a stored rule has to compare equal to the button that made it.
    expect(buildRuleParams('health-factor', { address: OWL, threshold: '' }, noSets))
      .toEqual({ ok: true, params: { target: { kind: 'address', address: OWL }, threshold: 1.1, market: 'core' } })
    expect(buildRuleParams('extrinsic', { section: 'Omnipool', method: '', success: 'no', signer: '' }, noSets))
      .toEqual({ ok: true, params: { section: 'Omnipool', success: false } })
    expect(buildRuleParams('event', { section: 'Referenda', method: 'Submitted' }, noSets))
      .toEqual({ ok: true, params: { section: 'Referenda', method: 'Submitted' } })
  })

  it('treats an empty multi-select as "all of them" by omitting the key', () => {
    expect(buildRuleParams('safety', {}, noSets)).toEqual({ ok: true, params: {} })
    expect(buildRuleParams('safety', {}, { phases: [], safetyKinds: ['pause', 'freeze'] }))
      .toEqual({ ok: true, params: { kinds: ['pause', 'freeze'] } })
    expect(buildRuleParams('referendum', { track: '' }, noSets)).toEqual({ ok: true, params: {} })
    expect(buildRuleParams('referendum', { track: 'root' }, { phases: ['deciding'], safetyKinds: [] }))
      .toEqual({ ok: true, params: { phases: ['deciding'], track: 'root' } })
  })

  it('names what is wrong before spending a round trip', () => {
    expect(buildRuleParams('account-activity', { address: 'nope' }, noSets))
      .toEqual({ ok: false, error: 'Pick an account or tag to watch, or paste an SS58 or 0x address' })
    expect(buildRuleParams('large-trade', { minUsd: '50' }, noSets))
      .toEqual({ ok: false, error: 'Set a floor of at least $100' })
    expect(buildRuleParams('large-transfer', { minUsd: '' }, noSets))
      .toEqual({ ok: false, error: 'Set a floor of at least $100' })
    expect(buildRuleParams('price', { assetId: '', price: '1' }, noSets))
      .toEqual({ ok: false, error: 'Pick a token' })
    expect(buildRuleParams('health-factor', { address: OWL, threshold: '99' }, noSets))
      .toEqual({ ok: false, error: 'The threshold must be between 0.5 and 10' })
    expect(buildRuleParams('extrinsic', { section: '9lives' }, noSets))
      .toEqual({ ok: false, error: 'Enter a pallet name, e.g. Omnipool' })
  })
})
