import { afterEach, describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { getModerationLog, initForumRead } from '../src/services/forumRead.ts'
import { setForumSnapshotForTest, type ForumCommentMeta } from '../src/services/forumStore.ts'

// A comment id is no address of its own: the moderation log's link to a hidden
// comment went to /discussions/<comment id>, a page that does not exist. Each
// comment target carries its thread, so the log can link into it.
const logRow = (target_id: string) => ({
  action_id: `hide:${target_id}`, target_id, action: 'hide', reason_code: 'spam',
  moderator_account_id: 'subsquare', created_at: '2026-11-08 20:26:57.135',
})

describe('getModerationLog', () => {
  afterEach(() => setForumSnapshotForTest(null))

  it('names the thread of a comment target, and nothing for a post or an unknown comment', async () => {
    const comment = { commentId: 's6adf3cd4ea3e297430dc39eb', threadKey: 's353' } as ForumCommentMeta
    setForumSnapshotForTest({ comments: new Map([[comment.commentId, comment]]) })
    const rows = [logRow('s6adf3cd4ea3e297430dc39eb'), logRow('s353'), logRow('s0000000000000000000000ff')]
    initForumRead({ query: async () => ({ json: async () => rows }) } as unknown as ClickHouseClient)

    const page = await getModerationLog(0, 10)
    expect(page.rows.map(r => [r.targetId, r.threadKey])).toEqual([
      ['s6adf3cd4ea3e297430dc39eb', 's353'],
      ['s353', undefined],
      ['s0000000000000000000000ff', undefined],
    ])
    expect('threadKey' in page.rows[1]).toBe(false)
  })
})
