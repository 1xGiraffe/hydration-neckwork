import { describe, expect, it } from 'vitest'
import { ICE_POT_ACCOUNT_ID, foldIcePotTrades } from '../src/utils/extrinsicActivity'

// Extrinsic 15264500-2: one intent filled through two pot trades. A list showing all
// three read as three trades where one intent filled.
describe('foldIcePotTrades', () => {
  const pot = { accountId: ICE_POT_ACCOUNT_ID }
  const owner = { accountId: '0x45544800400feaa2119f40c540920451b3992027df0b7e290000000000000000' }
  const row = (type: string, who: { accountId: string }, extrinsicIndex: number | null = 2, blockHeight = 15264500) =>
    ({ type, who, extrinsicIndex, blockHeight }) as Parameters<typeof foldIcePotTrades>[0][number]

  it('keeps the fill and drops the pot trades that produced it', () => {
    const rows = [row('trade', pot), row('trade', pot), row('intent', owner)]
    expect(foldIcePotTrades(rows).map(r => r.type)).toEqual(['intent'])
  })

  it('keeps a pot trade with no fill in its extrinsic, and other accounts\' trades beside a fill', () => {
    expect(foldIcePotTrades([row('trade', pot, 3), row('intent', owner, 2)]).map(r => r.extrinsicIndex)).toEqual([3, 2])
    expect(foldIcePotTrades([row('trade', owner), row('intent', owner)])).toHaveLength(2)
  })
})
