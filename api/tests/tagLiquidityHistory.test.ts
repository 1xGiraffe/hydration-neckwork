import { beforeEach, describe, expect, it, vi } from 'vitest'

// The tag twin of the address LP history builds over the tag's member set plus
// the members' EVM twins (the set the tag's value chart covers) and keys on the
// tag's scope AND that set's fingerprint.
const A = `0x${'aa'.repeat(32)}`
const B = `0x${'bb'.repeat(32)}`
const twin = (acc: string) => `0x45544800${acc.slice(2, 42)}0000000000000000`
vi.mock('../src/services/tagService.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/tagService.ts')>(),
  getTag: (tagId: string) => (tagId === 't1' ? { tagId: 't1', name: 'T', color: '#000', icon: '', note: '', members: [A, B] } : undefined),
}))

const svc = await import('../src/services/explorerService.ts')
const { resetCacheForTests, cacheExpiry } = await import('../src/services/cache.ts')

const seen: Array<{ query: string; params: Record<string, unknown> }> = []
function rows(query: string): Array<Record<string, unknown>> {
  if (query.includes('min(block_height) AS minb') || query.includes('minMerge(first_block_state) AS minb')) {
    return [{ minb: 0, maxb: 0, mint: 0, maxt: 0 }]
  }
  return []
}
svc.initExplorerService({
  query: async (o: { query: string; query_params?: Record<string, unknown> }) => {
    seen.push({ query: o.query, params: o.query_params ?? {} })
    return { json: async () => rows(o.query) }
  },
} as never)

const TAG_SET = [A, twin(A), B, twin(B)]

describe('tag liquidity history', () => {
  beforeEach(() => { resetCacheForTests(); seen.length = 0 })

  it('LP: builds over the members and their EVM twins, keyed on the tag scope and set fingerprint', async () => {
    const out = await svc.getTagLiquidityHistory('t1')
    expect(out).toMatchObject({ dates: [], positions: [] })
    const range = seen.find(s => s.query.includes('AS minb'))!.query
    for (const acc of TAG_SET) expect(range).toContain(acc)
    expect(cacheExpiry(svc.liquidityHistoryKey('tag:t1', TAG_SET))).not.toBeNull()
    // A window has its own key; the whole range's entry is not reused for it.
    await svc.getTagLiquidityHistory('t1', { fromBlock: 10, toBlock: 20 })
    expect(cacheExpiry(svc.liquidityHistoryKey('tag:t1', TAG_SET, { fromBlock: 10, toBlock: 20 }))).not.toBeNull()
    expect(await svc.getTagLiquidityHistory('nope')).toBeNull()
  })

  it('the key carries the account-set fingerprint', () => {
    const one = svc.liquidityHistoryKey('tag:t1', [A, B])
    expect(svc.liquidityHistoryKey('tag:t1', [B.toUpperCase().replace('0X', '0x'), A])).toBe(one)
    expect(svc.liquidityHistoryKey('tag:t1', [A])).not.toBe(one)
    expect(one).toMatch(/^explorer:lp-history:tag:t1:all:[0-9a-f]{12}$/)
  })

  it('list tag: a membership edit reads a fresh entry, never the previous set\'s', async () => {
    await svc.getListTagLiquidityHistory('L', 'T', [A])
    const first = seen.length
    await svc.getListTagLiquidityHistory('L', 'T', [A])
    expect(seen.length).toBe(first) // cached
    await svc.getListTagLiquidityHistory('L', 'T', [A, B])
    expect(seen.length).toBeGreaterThan(first) // rebuilt for the new set
    expect(await svc.getListTagLiquidityHistory('L', 'T', ['not-an-account'])).toBeNull()
  })

})
