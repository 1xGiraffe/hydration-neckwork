import { describe, expect, it } from 'vitest'
import type { ClickHouseClient } from '../src/db/client.ts'
import { normalizeAddress } from '../src/services/addressIdentity.ts'
import { initTagService, loadTags, retireDroppedDefaultMembers, tagForAccount } from '../src/services/tagService.ts'

// retireDroppedDefaultMembers tombstones only the memberships a DEFAULT_TAGS definition
// no longer lists — the BIL vault moving from bil-originator to bil-vault — and leaves
// every other tag's rows, and the default tags' still-listed members, alone.
describe('retiring dropped default-tag members', () => {
  const id = (h160: string) => normalizeAddress(h160)!.accountId!
  const VAULT = id('0x6a21891db0940491603f3cca0a9f4dba4c6e810c')
  const BORROWER = id('0x2333aa052610012c27e4fc176bc27095651dcbc6')
  const ZAP = id('0x646fd203bbcf19b35d79f58413bb07450fdbb1db')
  const OTHER = '0x' + '11'.repeat(32)
  const row = (label_id: string, account_id: string) => ({ label_id, label_name: label_id, color: '#000', note: '', icon: 'x', account_id })

  it('drops only the stale member of a default tag', async () => {
    let rows = [row('bil-originator', BORROWER), row('bil-originator', VAULT), row('bil-issuer', ZAP), row('someone-elses-tag', OTHER), row('someone-elses-tag', VAULT)]
    const commands: Array<{ query: string; query_params?: Record<string, unknown> }> = []
    const client = {
      query: async () => ({ json: async () => rows }),
      command: async (c: { query: string; query_params?: Record<string, unknown> }) => {
        commands.push(c)
        const ids = c.query_params!.ids as string[]
        rows = rows.filter(r => !(r.label_id === c.query_params!.tagId && ids.includes(r.account_id)))
      },
    } as unknown as ClickHouseClient
    initTagService(client)
    await loadTags()
    await retireDroppedDefaultMembers()
    expect(commands).toHaveLength(1)
    expect(commands[0].query_params).toEqual({ tagId: 'bil-originator', ids: [VAULT] })
    expect(tagForAccount(BORROWER)?.tagId).toBe('bil-originator')
    expect(tagForAccount(ZAP)?.tagId).toBe('bil-issuer')
    expect(tagForAccount(OTHER)?.tagId).toBe('someone-elses-tag')
    // A tag no definition names keeps all its rows (retireUnknownTagMemberships owns those).
    expect(rows.filter(r => r.label_id === 'someone-elses-tag')).toHaveLength(2)
  })
})
