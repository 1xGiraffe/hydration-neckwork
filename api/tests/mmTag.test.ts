import { describe, it, expect } from 'vitest'
import { mmTagMemberRows, MM_TAG } from '../src/services/tagService.ts'

// The "Supply & Borrow" tag is derived, not hand-listed: every aToken/vDebt/pool
// contract from the indexed reserve map becomes a member (truncated-account
// form), so newly listed reserves join automatically on the next sync.
describe('mmTagMemberRows', () => {
  const reserves = [
    { atoken: '0x4c892a298a9c6b4ced988b3d6e9cf93333aadcf7', vdebt: '0xE3A3b04D701b965c77BA903376b7F92c83c866C5', pool_proxy: '0x1b02E051683b5cfaC5929C25E84adb26ECf87B38' },
    { atoken: '0x02639ec01313c8775fae74f2dad1118c8a8a86da', vdebt: '0x2a29e04eb5cd42d0f22d9d8cf5f96f5b8e9e0c4a', pool_proxy: '0x1b02E051683b5cfaC5929C25E84adb26ECf87B38' },
  ]

  it('derives truncated account ids for every distinct contract', () => {
    const rows = mmTagMemberRows(reserves, new Set())
    // 4 distinct atoken/vdebt + 1 shared pool proxy
    expect(rows).toHaveLength(5)
    expect(rows[0].label_id).toBe(MM_TAG.tagId)
    const ids = rows.map(r => r.account_id)
    expect(ids).toContain('0x455448004c892a298a9c6b4ced988b3d6e9cf93333aadcf70000000000000000')
    // Mixed-case contract addresses normalize to lowercase before truncation.
    expect(ids).toContain('0x45544800e3a3b04d701b965c77ba903376b7f92c83c866c50000000000000000')
    for (const id of ids) expect(id).toMatch(/^0x45544800[0-9a-f]{40}0{16}$/)
  })

  it('skips accounts that are already members', () => {
    const existing = new Set(['0x455448004c892a298a9c6b4ced988b3d6e9cf93333aadcf70000000000000000'])
    const rows = mmTagMemberRows(reserves, existing)
    expect(rows).toHaveLength(4)
    expect(rows.map(r => r.account_id)).not.toContain('0x455448004c892a298a9c6b4ced988b3d6e9cf93333aadcf70000000000000000')
  })

  it('ignores malformed addresses', () => {
    expect(mmTagMemberRows([{ atoken: 'nope', vdebt: '', pool_proxy: '0x123' }], new Set())).toHaveLength(0)
  })
})
