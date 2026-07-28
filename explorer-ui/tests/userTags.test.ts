import { describe, it, expect, beforeEach } from 'vitest'
import { setTagMap, resolveTag, allAssociations, searchUserTags, libraryForTag } from '../src/userTags'
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

  it('resolves by library priority, with the system slot in its place', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [mine] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
      { libraryId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    expect(resolveTag(account)).toMatchObject({ kind: 'user', id: 't1', libraryId: 'lib1' })
    // reorder: system first now wins
    setTagMap({ libraries: [
      { libraryId: 'system', name: 'Hydration', tags: [] },
      { libraryId: 'lib1', name: 'Personal', tags: [mine] },
    ] })
    expect(resolveTag(account)).toMatchObject({ kind: 'system', id: 'kraken' })
    // an account with NO system tag falls through the system slot
    expect(resolveTag({ ...account, tag: null })).toMatchObject({ kind: 'user', id: 't1' })
  })

  it('lists every association for the detail/hover surfaces', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [mine] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
      { libraryId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    const all = allAssociations(account)
    expect(all.map(a => a.id)).toEqual(['t1', 'kraken', 't2'])
    expect(all[2]).toMatchObject({ libraryName: 'Sub' })
  })
})

describe('libraryForTag', () => {
  beforeEach(() => setTagMap(null))

  it('returns null when logged out (no map)', () => {
    expect(libraryForTag('t1')).toBeNull()
  })

  it('finds the owning library by tag id, skipping the system slot', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [mine] },
      { libraryId: 'system', name: 'Hydration', tags: [] },
      { libraryId: 'lib2', name: 'Sub', tags: [theirs] },
    ] })
    expect(libraryForTag('t1')).toEqual({ libraryId: 'lib1', libraryName: 'Personal' })
    expect(libraryForTag('t2')).toEqual({ libraryId: 'lib2', libraryName: 'Sub' })
  })

  it('returns null for an id no library claims (e.g. a system tag slug)', () => {
    setTagMap({ libraries: [{ libraryId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(libraryForTag('kraken')).toBeNull()
  })
})

describe('searchUserTags', () => {
  beforeEach(() => setTagMap(null))

  it('returns [] when logged out (no map)', () => {
    expect(searchUserTags('exch')).toEqual([])
  })

  it('returns [] for a blank query', () => {
    setTagMap({ libraries: [{ libraryId: 'lib1', name: 'Personal', tags: [mine] }] })
    expect(searchUserTags('')).toEqual([])
    expect(searchUserTags('   ')).toEqual([])
  })

  it('matches by case-insensitive substring, skipping the system slot', () => {
    setTagMap({ libraries: [
      { libraryId: 'lib1', name: 'Personal', tags: [mine] },        // 'My Exchange'
      { libraryId: 'system', name: 'Hydration', tags: [{ tagId: 'exchange-sys', name: 'Exchange (system)', color: '', icon: '', members: [] }] },
      { libraryId: 'lib2', name: 'Sub', tags: [theirs] },            // 'Their CEX'
    ] })
    const hits = searchUserTags('exch')
    expect(hits).toEqual([{ libraryId: 'lib1', libraryName: 'Personal', tagId: 't1', name: 'My Exchange', color: '#0f0', icon: '' }])
  })

  it('caps results at the given limit, defaulting to 3', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ tagId: `g${i}`, name: `Giraffe ${i}`, color: '#0f0', icon: '', members: [] }))
    setTagMap({ libraries: [{ libraryId: 'lib1', name: 'Personal', tags: many }] })
    expect(searchUserTags('giraffe')).toHaveLength(3)
    expect(searchUserTags('giraffe', 2)).toHaveLength(2)
    expect(searchUserTags('giraffe', 10)).toHaveLength(5)
  })
})
