import { describe, expect, it } from 'vitest'
import { dcaScheduleStatus } from '../src/services/explorerService.ts'

describe('dcaScheduleStatus', () => {
  it('matches Hydration UI cancellation semantics for a terminated planned execution', () => {
    expect(dcaScheduleStatus(true, false, 'DCA.ExecutionPlanned')).toBe('cancelled')
  })

  it('keeps automatic termination distinct from cancellation', () => {
    expect(dcaScheduleStatus(true, false, 'DCA.TradeFailed')).toBe('terminated')
  })

  it('preserves completed and active states', () => {
    expect(dcaScheduleStatus(false, true, 'DCA.TradeExecuted')).toBe('completed')
    expect(dcaScheduleStatus(false, false, 'DCA.ExecutionPlanned')).toBe('active')
  })
})
