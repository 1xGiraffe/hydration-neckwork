import { afterEach, describe, expect, it } from 'vitest'
import { applyLocalPost, forumPost, setForumSnapshotForTest } from '../src/services/forumStore.ts'
import { highestReferendumIndex, referendumTitleFor, referendumTitles } from '../src/services/referendumTitleService.ts'
import { installReferendumTitles } from './helpers/referendumTitles.ts'

// Referendum titles are the forum snapshot's description posts, rebuilt whenever
// its generation moves — so a moderator's hide (patched into the snapshot before the
// write answers) drops a title from every surface at once, not on a timer.

afterEach(() => setForumSnapshotForTest(null))

describe('referendum titles from the forum snapshot', () => {
  it('has no titles, and no highest index, before the snapshot loads', async () => {
    setForumSnapshotForTest(null)
    expect(referendumTitleFor('opengov', 1)).toBeNull()
    expect(highestReferendumIndex('opengov')).toBeNull()
    expect((await referendumTitles()).size).toBe(0)
  })

  it('drops a title the moment its description is hidden or deleted, and only description kinds count', () => {
    installReferendumTitles([
      { pallet: 'opengov', ref_index: 7, title: '  Fund the thing ' },
      { pallet: 'democracy', ref_index: 7, title: 'Old system' },
    ])
    expect(referendumTitleFor('opengov', 7)).toBe('Fund the thing')
    expect(referendumTitleFor('democracy', 7)).toBe('Old system')
    expect(highestReferendumIndex('opengov')).toBe(7)

    applyLocalPost({ ...forumPost('opengov:7')!, hidden: true, hiddenReason: 'spam' })
    expect(referendumTitleFor('opengov', 7)).toBeNull()
    expect(referendumTitleFor('democracy', 7)).toBe('Old system')

    applyLocalPost({ ...forumPost('democracy:7')!, deleted: true })
    expect(referendumTitleFor('democracy', 7)).toBeNull()

    applyLocalPost({ ...forumPost('opengov:7')!, postId: '12', kind: 'discussion', hidden: false })
    expect(referendumTitleFor('opengov', 12)).toBeNull()
  })
})
