import { setForumSnapshotForTest, type ForumPostMeta } from '../../src/services/forumStore.ts'

// Referendum titles come from the forum snapshot's description posts
// (referendumTitleService.ts). Installs one visible description per row, as the
// snapshot would hold it after a load.
export function installReferendumTitles(rows: readonly { pallet: string; ref_index: number; title: string }[]): void {
  setForumSnapshotForTest({
    posts: new Map(rows.map(r => [`${r.pallet}:${r.ref_index}`, {
      postId: `${r.pallet}:${r.ref_index}`, kind: r.pallet, title: r.title, excerpt: '', bodyFormat: 'markdown', bodyLength: 1, tldr: '',
      labels: [], linked: [], authorAccountId: '', authorLegacyName: '', authority: 'subsquare', source: 'subsquare', sourceId: '', sourceCid: '',
      sourceRemoved: false, bannerCid: '', pollJson: '', revision: 0, hidden: false, hiddenReason: '', deleted: false, locked: false, moderated: false,
      createdAt: 1, editedAt: null, lastActivityAt: 1, updatedAt: 0,
    } satisfies ForumPostMeta])),
  })
}
