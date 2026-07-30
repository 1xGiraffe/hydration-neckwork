import { describe, it, expect, beforeEach } from 'vitest'
import { setTagMap, setTagMapError, resolveTag, allAssociations, searchUserTags, listForTag, tagMapStatus, looksLikeUserTagId } from '../src/userTags'
import type { AccountRef } from '../src/types'

const ACC = '0x' + 'ab'.repeat(32)
const account: AccountRef = {
  accountId: ACC, address: '15xx', emoji: '🦊',
  tag: { id: 'kraken', name: 'Kraken', color: '#a78bfa', icon: '🦑' },
  identity: null, profile: null,
}
const mine = { tagId: 't1', name: 'My Exchange', color: '#0f0', icon: '', members: [ACC] }
const theirs = { tagId: 't2', name: 'Their CEX', color: '#00f', icon: '', members: [ACC] }

describe('resolveTag', () => {
  beforeEach(() => setTagMap(null))

  it('falls back to the system tag when logged out', () => {
    expect(resolveTag(account)).toMatchObject({ kind: 'system', id: 'kraken' })
  })

  it('resolves by list priority, with the system slot in its place', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [mine] },
      { listId: 'system', name: 'Hydration', tags: [] },
      { listId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    expect(resolveTag(account)).toMatchObject({ kind: 'user', id: 't1', listId: 'lib1' })
    // reorder: system first now wins
    setTagMap({ lists: [
      { listId: 'system', name: 'Hydration', tags: [] },
      { listId: 'lib1', name: 'Personal', tags: [mine] },
    ] })
    expect(resolveTag(account)).toMatchObject({ kind: 'system', id: 'kraken' })
    // an account with NO system tag falls through the system slot
    expect(resolveTag({ ...account, tag: null })).toMatchObject({ kind: 'user', id: 't1' })
  })

  it('lists every association for the detail/hover surfaces', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [mine] },
      { listId: 'system', name: 'Hydration', tags: [] },
      { listId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    const all = allAssociations(account)
    expect(all.map(a => a.id)).toEqual(['t1', 'kraken', 't2'])
    expect(all[2]).toMatchObject({ listName: 'Sub' })
  })
})

describe('listForTag', () => {
  beforeEach(() => setTagMap(null))

  it('returns null when logged out (no map)', () => {
    expect(listForTag('t1')).toBeNull()
  })

  it('finds the owning list by tag id, skipping the system slot', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [mine] },
      { listId: 'system', name: 'Hydration', tags: [] },
      { listId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    expect(listForTag('t1')).toEqual({ listId: 'lib1', listName: 'Personal' })
    expect(listForTag('t2')).toEqual({ listId: 'lib2', listName: 'Sub' })
  })

  it('returns null for an id no list claims (e.g. a system tag slug)', () => {
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(listForTag('kraken')).toBeNull()
  })
})

describe('tagMapStatus', () => {
  beforeEach(() => setTagMap(null))

  it('is "anonymous" with no session (the default null reset)', () => {
    expect(tagMapStatus()).toBe('anonymous')
  })

  it('is "loading" once a session exists but the map has not arrived yet', () => {
    setTagMap(null, true)
    expect(tagMapStatus()).toBe('loading')
  })

  it('is "ready" once a map arrives — hasSession defaults from a real map', () => {
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(tagMapStatus()).toBe('ready')
  })

  it('goes back to "anonymous" on logout (setTagMap(null) with its default)', () => {
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(tagMapStatus()).toBe('ready')
    setTagMap(null)
    expect(tagMapStatus()).toBe('anonymous')
  })

  // Regression: useTagMapSync's effect used to key off [session, q.data] only.
  // react-query leaves `data` undefined on a failed fetch, same as "still
  // loading" — with no distinct error signal, a query that exhausted its
  // retries and failed never fired the effect again, and tagMapStatus() read
  // 'loading' forever (a UUID-shaped /tag/:id page's skeleton never resolved).
  it('is "error" — a TERMINAL state, never "loading" — once the fetch fails outright', () => {
    setTagMapError()
    expect(tagMapStatus()).toBe('error')
  })

  it('setTagMapError() implies a session, even with no prior setTagMap(_, true)', () => {
    // No setTagMap call at all yet this test — sessionActive starts false.
    setTagMapError()
    expect(tagMapStatus()).not.toBe('anonymous')
    expect(tagMapStatus()).toBe('error')
  })

  it('a later successful setTagMap() clears a prior error back to "ready"', () => {
    setTagMapError()
    expect(tagMapStatus()).toBe('error')
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(tagMapStatus()).toBe('ready')
  })

  it('logging out clears a prior error back to "anonymous"', () => {
    setTagMapError()
    setTagMap(null)
    expect(tagMapStatus()).toBe('anonymous')
  })
})

describe('looksLikeUserTagId', () => {
  it('matches a UUID shape, case-insensitively', () => {
    expect(looksLikeUserTagId('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe(true)
    expect(looksLikeUserTagId('3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toBe(true)
  })

  it('rejects system tag slugs, including hyphenated ones', () => {
    for (const slug of ['kraken', 'treasury', 'fee-processor', 'hdx-kraken-lp', 'personal-watch', 't1']) {
      expect(looksLikeUserTagId(slug)).toBe(false)
    }
  })
})

describe('searchUserTags', () => {
  beforeEach(() => setTagMap(null))

  it('returns [] when logged out (no map)', () => {
    expect(searchUserTags('exch')).toEqual([])
  })

  it('returns [] for a blank query', () => {
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(searchUserTags('')).toEqual([])
    expect(searchUserTags('   ')).toEqual([])
  })

  it('matches by case-insensitive substring, skipping the system slot', () => {
    setTagMap({ lists: [
      { listId: 'lib1', name: 'Personal', tags: [mine] },        // 'My Exchange'
      { listId: 'system', name: 'Hydration', tags: [{ tagId: 'exchange-sys', name: 'Exchange (system)', color: '', icon: '', members: [] }] },
      { listId: 'lib2', name: 'Sub', tags: [theirs] },            // 'Their CEX'
    ] })
    const hits = searchUserTags('exch')
    expect(hits).toEqual([{ listId: 'lib1', listName: 'Personal', tagId: 't1', name: 'My Exchange', color: '#0f0', icon: '' }])
  })

  it('caps results at the given limit, defaulting to 3', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ tagId: `g${i}`, name: `Giraffe ${i}`, color: '#0f0', icon: '', members: [] }))
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: many }] })
    expect(searchUserTags('giraffe')).toHaveLength(3)
    expect(searchUserTags('giraffe', 2)).toHaveLength(2)
    expect(searchUserTags('giraffe', 10)).toHaveLength(5)
  })

  // Regression: hits used to come back in list-then-insertion order, so an
  // exact "Kraken" tag created after "HDX Kraken LP" rendered below it. Ranks
  // exact match first, then a prefix, then a word-start match, mirroring the
  // server's tag/referendum-title tiering (nameMatchRank in
  // api/src/services/explorerService.ts).
  it('ranks an exact tag name first, then a prefix, then a word-start match — not creation order', () => {
    const lpTag = { tagId: 'hdx-kraken-lp', name: 'HDX Kraken LP', color: '#0f0', icon: '', members: [] }
    const exactTag = { tagId: 'kraken', name: 'Kraken', color: '#0f0', icon: '', members: [] }
    const whalesTag = { tagId: 'kraken-whales', name: 'Kraken Whales', color: '#0f0', icon: '', members: [] }
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [lpTag, exactTag, whalesTag] }] })

    expect(searchUserTags('kraken', 10).map(h => h.tagId)).toEqual(['kraken', 'kraken-whales', 'hdx-kraken-lp'])
  })

  it('breaks a tie in match quality alphabetically by tag name', () => {
    const polkadot = { tagId: 'polkadot-treasury', name: 'Polkadot Treasury', color: '#0f0', icon: '', members: [] }
    const moonbeam = { tagId: 'moonbeam-treasury', name: 'Moonbeam Treasury', color: '#0f0', icon: '', members: [] }
    const exact = { tagId: 'treasury', name: 'Treasury', color: '#0f0', icon: '', members: [] }
    setTagMap({ lists: [{ listId: 'lib1', name: 'Personal', tags: [polkadot, moonbeam, exact] }] })

    expect(searchUserTags('treasury', 10).map(h => h.tagId)).toEqual(['treasury', 'moonbeam-treasury', 'polkadot-treasury'])
  })
})
