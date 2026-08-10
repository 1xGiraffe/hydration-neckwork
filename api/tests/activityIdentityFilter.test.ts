import { describe, expect, it } from 'vitest'
import { accountIsNamed, activityRowMatchesFilters } from '../src/services/explorerService.ts'
import type { AccountRef, ActivityRow } from '../src/services/explorerService.ts'

// "Named" is whatever lets the explorer print something other than bare hex —
// the four sources a pill already draws from. A viewer's OWN tags are not part
// of it: they live in the browser, and a server-paged feed cannot honour a
// predicate only the client can evaluate without returning ragged pages.
const ref = (over: Partial<AccountRef>): AccountRef => ({
  accountId: '0x' + 'ab'.repeat(32), address: '1abc', emoji: '🦊', tag: null, identity: null, profile: null, ...over,
} as AccountRef)

describe('accountIsNamed', () => {
  it('counts every name the explorer can already show', () => {
    expect(accountIsNamed(ref({ tag: { id: 'kraken', name: 'Kraken', color: '#fff', icon: '', memberCount: 2 } }))).toBe(true)
    expect(accountIsNamed(ref({ identity: { display: 'Alice', verified: true, email: '', web: '', twitter: '' } }))).toBe(true)
    expect(accountIsNamed(ref({ profile: { name: 'my wallet', avatarVersion: 0 } }))).toBe(true)
    expect(accountIsNamed(ref({ contractName: 'Router' }))).toBe(true)
  })

  it('is false for a bare address, and for no account at all', () => {
    expect(accountIsNamed(ref({}))).toBe(false)
    expect(accountIsNamed(null)).toBe(false)
    // An identity row with an empty display names nothing.
    expect(accountIsNamed(ref({ identity: { display: '', verified: false, email: '', web: '', twitter: '' } }))).toBe(false)
    // A profile that only carries an avatar is not a name either.
    expect(accountIsNamed(ref({ profile: { name: '', avatarVersion: 3 } }))).toBe(false)
  })
})

describe('the activity identity filter', () => {
  const row = (who: AccountRef | null): ActivityRow =>
    ({ type: 'transfer', blockHeight: 1, timestamp: '2026-08-10 00:00:00', extrinsicIndex: 0, who, to: null,
       asset: null, assetIn: null, assetOut: null, amount: null, amountIn: null, amountOut: null, valueUsd: null } as ActivityRow)
  const named = row(ref({ identity: { display: 'Treasury', verified: true, email: '', web: '', twitter: '' } }))
  const anon = row(ref({}))

  it('keeps only named actors, or only unnamed ones', () => {
    expect(activityRowMatchesFilters(named, { identity: 'named' })).toBe(true)
    expect(activityRowMatchesFilters(anon, { identity: 'named' })).toBe(false)
    expect(activityRowMatchesFilters(anon, { identity: 'unnamed' })).toBe(true)
    expect(activityRowMatchesFilters(named, { identity: 'unnamed' })).toBe(false)
  })

  it('leaves every row alone when the filter is absent', () => {
    for (const r of [named, anon, row(null)]) expect(activityRowMatchesFilters(r, {})).toBe(true)
  })

  it('treats a row with no actor as unnamed — it has no account to name', () => {
    // Block hooks and scheduler payouts have no signer at all.
    expect(activityRowMatchesFilters(row(null), { identity: 'unnamed' })).toBe(true)
    expect(activityRowMatchesFilters(row(null), { identity: 'named' })).toBe(false)
  })

  it('still applies alongside the other filters rather than replacing them', () => {
    const cheap = { ...named, valueUsd: 5 }
    expect(activityRowMatchesFilters(cheap, { identity: 'named', min: 100 })).toBe(false)
  })
})
