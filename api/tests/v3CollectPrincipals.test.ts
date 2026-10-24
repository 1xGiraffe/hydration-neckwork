import { describe, it, expect } from 'vitest'
import { collectPrincipals, type V3EventRow } from '../src/services/uniswapV3Service.ts'

const ev = (block_height: number, event_index: number, event_name: string, amount1: string, extra: Partial<V3EventRow> = {}): V3EventRow => ({
  block_height, event_index, extrinsic_index: 2, ts: '', contract_address: '0xmgr', kind: 'manager', event_name,
  actor: '', counterparty: '', owner: '', token_id: '7', tick_lower: 0, tick_upper: 0, tick: 0, liquidity: '0',
  amount0: '0', amount1, sqrt_price_x96: '0', aux0: '0', aux1: '0', ...extra,
} as V3EventRow)

describe('collectPrincipals', () => {
  // Real: aDOT/HOLLAR position decreased at 14,395,783 and collected at 14,395,788.
  // The collect paid principal + 0.000138 HOLLAR of fees, not 0.346 HOLLAR of fees.
  it('takes the principal a decrease freed in an earlier extrinsic', () => {
    const p = collectPrincipals([
      ev(14395783, 8, 'DecreaseLiquidity', '346042755608716748'),
      ev(14395788, 9, 'Collect', '346181299507238463'),
    ])
    expect(p.get('14395788:9')).toEqual({ a0: 0n, a1: 346042755608716748n })
  })

  it('starts each collect from what the previous one left owed', () => {
    const p = collectPrincipals([
      ev(1, 1, 'DecreaseLiquidity', '100'),
      ev(2, 1, 'Collect', '60'),   // took less than owed: 40 stays owed
      ev(3, 1, 'Collect', '50'),   // 40 principal, 10 fees
      ev(4, 1, 'Collect', '5'),    // nothing owed: all fees
    ])
    expect(p.get('2:1')?.a1).toBe(60n)
    expect(p.get('3:1')?.a1).toBe(40n)
    expect(p.get('4:1')?.a1).toBe(0n)
  })

  it('keeps positions apart', () => {
    const p = collectPrincipals([
      ev(1, 1, 'DecreaseLiquidity', '100', { token_id: '1' }),
      ev(2, 1, 'Collect', '100', { token_id: '2' }),
      ev(2, 2, 'Burn', '30', { kind: 'pool', contract_address: '0xpool', owner: '0xo', tick_lower: -10, tick_upper: 10 }),
      ev(3, 1, 'Collect', '31', { kind: 'pool', contract_address: '0xpool', owner: '0xo', tick_lower: -10, tick_upper: 10 }),
    ])
    expect(p.get('2:1')?.a1).toBe(0n)
    expect(p.get('3:1')?.a1).toBe(30n)
  })
})
