import { describe, expect, it } from 'vitest'
import { dcaOrderFromSchedule, dcaScheduledRow, wrappedDispatchError } from '../src/services/explorerService.ts'

// A DCA.schedule extrinsic is shown as the SCHEDULE it created — its fixed
// per-trade leg, cadence and budget, linked to the schedule page — not as the
// schedule's first execution: that execution is its own row on the block that
// ran it, and a schedule that never traded would otherwise show nothing at all.

const OWNER = '0xa32d0f5749bd74dcddfed48e959f42529f8365c5bf321378d7d5209342f1eca1'
const SCHEDULED = {
  id: 38019, who: OWNER, period: 18, totalAmount: '4992903267956641916556',
  order: { assetIn: 143, assetOut: 10, amountIn: '1664301089318880638852', minAmountOut: '1688452530', route: [], __kind: 'Sell' },
}
const at = { block_height: 15_176_960, ts: '2026-09-29 12:57:36', event_index: 9, extrinsic_index: 2 }

describe('dcaOrderFromSchedule', () => {
  it('reads a DCA.Scheduled event the way it reads the schedule call', () => {
    expect(dcaOrderFromSchedule(SCHEDULED)).toEqual({
      asset_in: 143, asset_out: 10, direction: 'Sell', amount_per: '1664301089318880638852',
      total_amount: '4992903267956641916556', period: 18, max_retries: 0,
    })
  })

  it('takes a Buy order\'s fixed amountOut', () => {
    const buy = { ...SCHEDULED, order: { assetIn: 5, assetOut: 0, amountOut: '1000', maxAmountIn: '9', route: [], __kind: 'Buy' } }
    expect(dcaOrderFromSchedule(buy)).toMatchObject({ direction: 'Buy', amount_per: '1000' })
  })

  it('refuses a pre-router event that carries no order', () => {
    expect(dcaOrderFromSchedule({ id: 1, who: OWNER })).toBeNull()
  })
})

describe('dcaScheduledRow', () => {
  it('is the schedule: its own extrinsic, the per-trade leg, cadence and budget', () => {
    const row = dcaScheduledRow(at, 38019, OWNER, dcaOrderFromSchedule(SCHEDULED)!)
    expect(row).toMatchObject({
      type: 'trade', dca: true, dcaStatus: 'scheduled', dcaScheduleId: 38019,
      blockHeight: 15_176_960, extrinsicIndex: 2, eventIndex: 9,
      amountIn: '1664301089318880638852', amountOut: null,
      dcaPeriodBlocks: 18, dcaTotalAmount: '4992903267956641916556',
      linkBlock: 15_176_960, linkIndex: 2,
    })
    expect(row.who?.accountId).toBe(OWNER)
    expect(row.assetIn?.assetId).toBe(143)
    expect(row.assetOut?.assetId).toBe(10)
  })

  it('states an unbounded schedule as having no budget', () => {
    const order = { ...dcaOrderFromSchedule(SCHEDULED)!, total_amount: '0' }
    expect(dcaScheduledRow(at, 1, OWNER, order).dcaTotalAmount).toBeNull()
  })
})

// A wrapper call (multisig, proxy, batch) can succeed while the call it
// dispatched fails. The extrinsic then did nothing, and the page must say why.
describe('wrappedDispatchError', () => {
  const err = { __kind: 'Module', value: { index: 67, error: '0x09000000' } }
  it('reads a failed multisig execution', () => {
    expect(wrappedDispatchError([
      { name: 'Balances.Withdraw', args: {} },
      { name: 'Multisig.MultisigExecuted', args: { result: { __kind: 'Err', value: err } } },
    ])).toEqual(err)
  })

  it('takes the innermost failure — a proxied call fails before its multisig reports', () => {
    const inner = { __kind: 'Module', value: { index: 1, error: '0x01000000' } }
    expect(wrappedDispatchError([
      { name: 'Proxy.ProxyExecuted', args: { result: { __kind: 'Err', value: inner } } },
      { name: 'Multisig.MultisigExecuted', args: { result: { __kind: 'Ok' } } },
    ])).toEqual(inner)
  })

  it('reads an interrupted batch', () => {
    expect(wrappedDispatchError([{ name: 'Utility.BatchInterrupted', args: { index: 1, error: err } }])).toEqual(err)
  })

  it('is null when every dispatch succeeded', () => {
    expect(wrappedDispatchError([
      { name: 'Proxy.ProxyExecuted', args: { result: { __kind: 'Ok' } } },
      { name: 'Multisig.MultisigExecuted', args: { result: { __kind: 'Ok' } } },
    ])).toBeNull()
  })
})
