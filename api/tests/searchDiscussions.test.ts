import { afterEach, describe, expect, it } from 'vitest'
import { initExplorerService, search, type SearchResult } from '../src/services/explorerService.ts'
import { initGovernanceService } from '../src/services/governanceService.ts'
import { setForumSnapshotForTest, type ForumPostMeta } from '../src/services/forumStore.ts'

// Forum discussions in the explorer's search: found by title, by excerpt and by
// number (a native id is a decimal, an imported one 's' + Subsquare's post number),
// from the in-process forum snapshot. A hidden or deleted discussion is never
// offered — its title is served nowhere else either.

const post = (p: Partial<ForumPostMeta> & { postId: string }): ForumPostMeta => ({
  kind: 'discussion', title: 't', excerpt: '', bodyFormat: 'markdown', bodyLength: 1, tldr: '', labels: [], linked: [],
  authorAccountId: '', authorLegacyName: 'alice', authority: 'subsquare', source: 'subsquare', sourceId: 'x', sourceCid: '',
  sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0, hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false,
  createdAt: 1, editedAt: null, lastActivityAt: 1, updatedAt: 0,
  ...p,
})

function init(): void {
  const client = { query: async () => ({ json: async () => [] }) }
  initExplorerService(client as never)
  initGovernanceService(client as never)
  setForumSnapshotForTest({
    posts: new Map([
      ['s248', post({ postId: 's248', title: 'Omnipool fee rework', excerpt: 'Lower the asset fee floor', lastActivityAt: 5 })],
      ['248', post({ postId: '248', title: 'Native follow-up', excerpt: 'A reply to the fee rework', lastActivityAt: 6 })],
      ['s9', post({ postId: 's9', title: 'Rework the referral program', excerpt: 'nothing', lastActivityAt: 9 })],
      ['s3', post({ postId: 's3', title: 'Hidden fee rework probe', hidden: true })],
      ['s4', post({ postId: 's4', title: 'Deleted fee rework', deleted: true })],
      ['opengov:7', post({ postId: 'opengov:7', kind: 'opengov', title: 'Fee rework referendum' })],
      ['s50', post({ postId: 's50', title: 'Équipe Straße — 中文提案', excerpt: 'Ｆｕｌｌ-width budget', lastActivityAt: 2 })],
    ]),
    threads: new Map([['s248', { comments: 3, replies: 1, updates: 0, lastCommentAt: null, commenters: 2 }]]),
  })
}

const discussions = (r: SearchResult[]) => r.filter(x => x.type === 'discussion')

afterEach(() => setForumSnapshotForTest(null))

describe('search: discussions', () => {
  it('ranks a title prefix over a word-start match, then excerpt matches, and never offers hidden, deleted or non-discussion posts', async () => {
    init()
    const hits = discussions(await search('Omnipool fee'))
    expect(hits.map(h => h.value)).toEqual(['s248'])
    expect(hits[0]).toMatchObject({ label: 'Omnipool fee rework', desc: 'Discussion · 3 comments' })

    const rework = discussions(await search('rework'))
    // Title word-start ('… rework', 'Rework …' is a prefix and ranks first), then the excerpt-only match.
    expect(rework.map(h => h.value)).toEqual(['s9', 's248', '248'])
    expect(rework.some(h => ['s3', 's4', 'opengov:7'].includes(h.value))).toBe(false)
  })

  it('finds both the native and the imported discussion by number, and the imported one by its s-id', async () => {
    init()
    expect(discussions(await search('248')).map(h => h.value)).toEqual(['248', 's248'])
    expect(discussions(await search('s248')).map(h => h.value)).toEqual(['s248'])
  })

  it('matches any script, case-insensitively and across Unicode normal forms', async () => {
    init()
    expect(discussions(await search('équipe')).map(h => h.value)).toEqual(['s50'])
    // A decomposed accent (e + U+0301) matches the composed one.
    expect(discussions(await search('E\u0301quipe')).map(h => h.value)).toEqual(['s50'])
    expect(discussions(await search('中文')).map(h => h.value)).toEqual(['s50'])
    // A full-width excerpt matches its plain spelling (NFKC).
    expect(discussions(await search('full-width')).map(h => h.value)).toEqual(['s50'])
  })

  it('answers no discussion hits while the forum snapshot is loading', async () => {
    init()
    setForumSnapshotForTest(null)
    expect(discussions(await search('referral program'))).toEqual([])
  })
})
