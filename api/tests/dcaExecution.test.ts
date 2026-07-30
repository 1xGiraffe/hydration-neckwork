import { describe, expect, it } from 'vitest'
import { dcaExecutionOutcome, dcaPerTradeLegs } from '../src/services/explorerService.ts'

describe('dcaPerTradeLegs', () => {
  it('denominates a Sell schedule per-trade amount in the sold (in) asset', () => {
    expect(dcaPerTradeLegs('Sell', '1000000000000')).toEqual({ amountIn: '1000000000000', amountOut: null })
  })

  it('denominates a Buy schedule per-trade amount in the bought (out) asset', () => {
    expect(dcaPerTradeLegs('Buy', '1666666666666666')).toEqual({ amountIn: null, amountOut: '1666666666666666' })
  })

  it('treats an unknown (pre-router) direction as a sell', () => {
    expect(dcaPerTradeLegs('', '0')).toEqual({ amountIn: '0', amountOut: null })
  })

  it('yields no legs when the schedule stored no per-trade amount', () => {
    // Pre-router schedules recorded no order at all: the intended trade of a
    // failed attempt is unknown rather than zero.
    expect(dcaPerTradeLegs('', '')).toEqual({ amountIn: null, amountOut: null })
  })
})

describe('dcaExecutionOutcome', () => {
  it('reports a failed sell attempt with the intended sell amount and no output', () => {
    // A DCA.TradeFailed event carries no amounts; the intended sell is the
    // schedule's amount-per, and there is no output or execution price.
    expect(dcaExecutionOutcome('DCA.TradeFailed', 'Sell', '1000000000000', '', '', 12, 18)).toEqual({
      status: 'failed', amountIn: '1000000000000', amountOut: null, executionPrice: null,
    })
  })

  it('reports a failed buy attempt with the intended buy amount and no input', () => {
    // A Buy schedule's amount-per is denominated in the bought (out) asset;
    // the input that would have been spent is unknown for a failed attempt.
    expect(dcaExecutionOutcome('DCA.TradeFailed', 'Buy', '1666666666666666', '', '', 6, 12)).toEqual({
      status: 'failed', amountIn: null, amountOut: '1666666666666666', executionPrice: null,
    })
  })

  it('reports an executed trade with amounts and an execution price', () => {
    // sell 1 HDX (12 dec) → 2 units out (18 dec): execution price = 2 out per in.
    expect(dcaExecutionOutcome('DCA.TradeExecuted', 'Sell', '1000000000000', '1000000000000', '2000000000000000000', 12, 18)).toEqual({
      status: 'executed', amountIn: '1000000000000', amountOut: '2000000000000000000', executionPrice: 2,
    })
  })

  it('leaves execution price null when either leg is zero', () => {
    expect(dcaExecutionOutcome('DCA.TradeExecuted', 'Sell', '0', '1000000000000', '0', 12, 18).executionPrice).toBeNull()
  })
})
