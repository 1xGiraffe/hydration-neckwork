import { describe, expect, it, vi } from 'vitest'

// Treasury spends in the explorer's search, by index ("spend 3", "spend #3",
// "treasury spend 3"), from the same fold the MCP's treasury view reads.

vi.mock('../src/services/governanceTreasury.ts', () => ({
  treasuryFold: async () => ({ headBlock: 1, proposals: [], spends: [{ index: 3, amount: '2052272000000000000', state: 'paid' }] }),
}))

const { initExplorerService, search } = await import('../src/services/explorerService.ts')
const { initGovernanceService } = await import('../src/services/governanceService.ts')

describe('search: treasury spends', () => {
  it('finds a spend by its index in the forms a reader types, and nothing for an unknown index', async () => {
    const client = { query: async () => ({ json: async () => [] }) }
    initExplorerService(client as never)
    initGovernanceService(client as never)
    for (const q of ['spend 3', 'Spend #3', 'treasury spend 3']) {
      const hits = (await search(q)).filter(h => h.type === 'spend')
      expect(hits).toEqual([{ type: 'spend', value: '3', label: 'Treasury spend #3', desc: '2,052,272 HDX · paid' }])
    }
    expect((await search('spend 9')).filter(h => h.type === 'spend')).toEqual([])
  })
})
