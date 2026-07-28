import { describe, it, expect, beforeEach } from 'vitest'
import { setTagMap, resolveTag, allAssociations } from '../src/userTags'
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
