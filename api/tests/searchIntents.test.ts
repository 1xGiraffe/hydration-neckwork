import { describe, expect, it } from 'vitest'
import { initExplorerService, search } from '../src/services/explorerService.ts'
import { initGovernanceService } from '../src/services/governanceService.ts'
import { initReferendumTitleService } from '../src/services/referendumTitleService.ts'

// An ICE intent is found by its whole u128 id or by the "#n" handle its pages print
// (the id's low 64 bits, the pallet's incremental counter).
const ID = '33094287864913608106353623046266'
const SEQ = Number(BigInt(ID) & ((1n << 64n) - 1n))

function init(seen: { query: string; params?: Record<string, unknown> }[]): void {
  const client = {
    query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
      seen.push({ query: opts.query, params: opts.query_params })
      if (opts.query.includes('price_data.intent_orders')) {
        const p = opts.query_params ?? {}
        const hit = p.id === ID || Number(p.seq) === SEQ
        return { json: async () => hit ? [{ id: ID, kind: 'swap', asset_in: 0, asset_out: 5 }] : [] }
      }
      if (opts.query.includes('max(block_height) AS head')) return { json: async () => [{ head: '1' }] }
      if (opts.query.includes('price_data.raw_blocks')) return { json: async () => [{ c: '0' }] }
      return { json: async () => [] }
    },
  }
  initExplorerService(client as never)
  initGovernanceService(client as never)
  initReferendumTitleService(client as never)
}

describe('search: ICE intents', () => {
  it('finds an intent by its whole id, by primary key', async () => {
    const seen: { query: string; params?: Record<string, unknown> }[] = []
    init(seen)
    const hits = (await search(ID)).filter(h => h.type === 'intent')
    expect(hits).toEqual([{ type: 'intent', value: ID, label: `Limit order #${SEQ}`, desc: expect.stringContaining('→') }])
    expect(seen.some(s => s.query.includes('intent_id = toUInt128({id:String})'))).toBe(true)
  })
  it('finds it by the short handle, with or without the #', async () => {
    for (const q of [`#${SEQ}`, String(SEQ)]) {
      init([])
      expect((await search(q)).filter(h => h.type === 'intent').map(h => h.value)).toEqual([ID])
    }
  })
  it('offers no intent for a number no intent carries', async () => {
    init([])
    expect((await search('424242')).filter(h => h.type === 'intent')).toEqual([])
  })
})
