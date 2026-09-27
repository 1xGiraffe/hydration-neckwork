import { describe, expect, it } from 'vitest'
import { composeAccountBlocks, prewarmedAccountBlocks, prewarmedBlocksCovering, type AccountsPage, type TopAccountRow } from '../src/services/explorerService.ts'

// A directory window inside the prewarmed 50-row blocks is sliced out of them
// instead of paying its own cold whole-directory ranking. The slice must be the
// rows a direct read of that window returns: same order, nothing dropped at a
// block seam, nothing read past the directory's end.
const row = (n: number): TopAccountRow => ({
  account: null, tag: { tagId: `t${n}`, name: '', color: '', icon: '', memberCount: 1 },
  portfolioUsd: 1000 - n, lastBlock: 1, suppliedUsd: null, borrowedUsd: null,
})
const block = (from: number, count: number, total = 120): AccountsPage => ({
  rows: Array.from({ length: count }, (_, i) => row(from + i)), total,
})
const ids = (p: AccountsPage) => p.rows.map(r => r.tag?.tagId)

describe('account directory block composition', () => {
  it('covers a window only with blocks the background pass keeps warm', () => {
    expect(prewarmedBlocksCovering(0, 100, 'value')).toEqual([0, 50])
    expect(prewarmedBlocksCovering(0, 25, 'health')).toEqual([0])
    expect(prewarmedBlocksCovering(60, 30, 'value')).toEqual([50])
    expect(prewarmedBlocksCovering(40, 20, 'health')).toBeNull() // page two is warm for value only
    expect(prewarmedBlocksCovering(0, 101, 'value')).toBeNull()
    expect(prewarmedBlocksCovering(0, 0, 'value')).toBeNull()
  })

  it('names every prewarmed block once, at a block-aligned offset', () => {
    const blocks = prewarmedAccountBlocks()
    expect(new Set(blocks.map(b => `${b.sort}:${b.offset}`)).size).toBe(blocks.length)
    for (const b of blocks) expect(b.offset % 50).toBe(0)
  })

  it('slices across a block seam without a gap or overlap', () => {
    const page = composeAccountBlocks([block(0, 50), block(50, 50)], 30, 40)
    expect(ids(page)).toEqual(Array.from({ length: 40 }, (_, i) => `t${30 + i}`))
    expect(page.total).toBe(120)
  })

  it('stops at a short block, the end of the directory', () => {
    const page = composeAccountBlocks([block(0, 20, 20), block(50, 50, 20)], 10, 50)
    expect(ids(page)).toEqual(Array.from({ length: 10 }, (_, i) => `t${10 + i}`))
  })

  it('keeps the ordering depth of an activity ranking', () => {
    const page = composeAccountBlocks([{ ...block(0, 50), rankedDepth: 16 }], 10, 20)
    expect(page.rankedDepth).toBe(16)
    expect('rankedDepth' in composeAccountBlocks([block(0, 50)], 0, 10)).toBe(false)
  })
})
