import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { accountIsNamed } from '../src/services/explorerService.ts'
import type { AccountRef } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// A viewer's own and subscribed tags make an account named FOR THEM, so the
// filtered page differs per viewer. That makes the tag set part of the cache
// key — and a Set stringifies to "[object Set]", which would key every
// viewer's page to the same entry and serve one person's filter result to
// another. This is the guard on that.
describe('the viewer tag set keys its own cache entry', () => {
  it('serializes membership, never the bare object tag', () => {
    const at = explorerService.indexOf('function filterKey')
    const body = explorerService.slice(at, explorerService.indexOf('\n}', at))
    expect(body).toContain('v instanceof Set')
    expect(body).toContain("[...v].sort().join('+')")
  })
})

describe('accountIsNamed with a viewer', () => {
  const bare = (id: string): AccountRef =>
    ({ accountId: id, address: '1abc', emoji: '🦊', tag: null, identity: null, profile: null } as AccountRef)

  it("counts the viewer's own tag as a name", () => {
    const id = '0x' + 'cd'.repeat(32)
    expect(accountIsNamed(bare(id))).toBe(false)
    expect(accountIsNamed(bare(id), new Set([id]))).toBe(true)
  })

  it('matches case-insensitively, since account ids travel in both cases', () => {
    const id = '0x' + 'AB'.repeat(32)
    expect(accountIsNamed(bare(id), new Set([id.toLowerCase()]))).toBe(true)
  })

  it('leaves an untagged account unnamed for that viewer', () => {
    expect(accountIsNamed(bare('0x' + '11'.repeat(32)), new Set(['0x' + '22'.repeat(32)]))).toBe(false)
  })
})
