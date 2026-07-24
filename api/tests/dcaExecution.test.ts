import { describe, expect, it } from 'vitest'
import { dcaExecutionOutcome } from '../src/services/explorerService.ts'

describe('dcaExecutionOutcome', () => {
  it('reports a failed attempt with the intended sell amount and no output', () => {
    // A DCA.TradeFailed event carries no amounts; the intended sell is the
    // schedule's amount-per, and there is no output or execution price.
    expect(dcaExecutionOutcome('DCA.TradeFailed', '1000000000000', '', '', 12, 18)).toEqual({
      status: 'failed', amountIn: '1000000000000', amountOut: null, executionPrice: null,
    })
  })

  it('reports an executed trade with amounts and an execution price', () => {
    // sell 1 HDX (12 dec) → 2 units out (18 dec): execution price = 2 out per in.
    expect(dcaExecutionOutcome('DCA.TradeExecuted', '1000000000000', '1000000000000', '2000000000000000000', 12, 18)).toEqual({
      status: 'executed', amountIn: '1000000000000', amountOut: '2000000000000000000', executionPrice: 2,
    })
  })

  it('leaves execution price null when either leg is zero', () => {
    expect(dcaExecutionOutcome('DCA.TradeExecuted', '0', '1000000000000', '0', 12, 18).executionPrice).toBeNull()
  })
})
