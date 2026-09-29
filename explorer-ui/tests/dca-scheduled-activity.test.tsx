import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTable, activityId } from '../src/components/ActivityTable'
import { activityBadge } from '../src/components/activityColors'
import { emptyActivityReason } from '../src/utils/extrinsicActivity'
import type { ActivityRow, AssetRef } from '../src/types'

// The extrinsic that created a DCA schedule shows the SCHEDULE — the per-trade
// amount, cadence and budget, linked to the schedule page — never its first
// execution, which is its own row on the block that ran it.
const PRIME: AssetRef = { assetId: 143, iconAssetId: 43, symbol: '2-Pool-PRIME', name: null, decimals: 18, parachainId: null }
const USDT: AssetRef = { assetId: 10, iconAssetId: 10, symbol: 'USDT', name: 'Tether', decimals: 6, parachainId: 1000 }
const scheduled: ActivityRow = {
  type: 'trade', blockHeight: 15_176_960, timestamp: '2026-09-29 12:57:36', eventIndex: 9, extrinsicIndex: 2,
  who: null, to: null, asset: null, assetIn: PRIME, assetOut: USDT, amount: null,
  amountIn: '1664301089318880638852', amountOut: null, valueUsd: null,
  dca: true, dcaStatus: 'scheduled', dcaScheduleId: 38019, dcaPeriodBlocks: 18, dcaTotalAmount: '4992903267956641916556',
  linkBlock: 15_176_960, linkIndex: 2,
}

describe('a scheduled DCA row', () => {
  it('is badged as a schedule, not an execution', () => {
    expect(activityBadge(scheduled).label).toBe('DCA scheduled')
  })

  it('links to its schedule even where DCA rows link to their own execution', () => {
    expect(activityId(scheduled, true)).toBe('38019')
    // An execution row on the same page still links to its own execution.
    expect(activityId({ ...scheduled, dcaStatus: undefined }, true)).toBe('15176960-e9')
  })

  it('states the per-trade amount, the cadence and the budget', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[scheduled]} now={Date.now()} dcaExecutionLinks />)
    expect(html).toContain('every 18 blocks')
    expect(html).toContain('per trade')
    expect(html).toContain('budget')
  })

  it('says unbounded when there is no budget', () => {
    const html = renderToStaticMarkup(<ActivityTable rows={[{ ...scheduled, dcaTotalAmount: null }]} now={Date.now()} dcaExecutionLinks />)
    expect(html).toContain('no budget limit')
  })
})

// An empty Activity tab says WHY nothing happened, when the extrinsic shows it.
describe('emptyActivityReason', () => {
  const ev = (...names: string[]) => names.map((name, eventIndex) => ({ eventIndex, name, args: {} }))
  it('names a dispatched call that failed inside a successful wrapper', () => {
    expect(emptyActivityReason({ success: true, events: ev('Multisig.MultisigExecuted'), innerErrorReason: { label: 'Router.TradingLimitReached', docs: '' } }))
      .toBe('Nothing happened: the dispatched call failed (Router.TradingLimitReached).')
  })

  it('names a failed extrinsic', () => {
    expect(emptyActivityReason({ success: false, events: ev('System.ExtrinsicFailed') })).toBe('Nothing happened: the extrinsic failed.')
  })

  it('names a cancelled multisig operation', () => {
    expect(emptyActivityReason({ success: true, events: ev('Multisig.MultisigCancelled') }))
      .toBe('This cancelled a pending multisig operation; nothing else happened.')
  })

  it('names a multisig approval that has not executed yet', () => {
    expect(emptyActivityReason({ success: true, events: ev('Multisig.NewMultisig') }))
      .toBe('A multisig approval: the operation runs once enough signatories approve.')
    expect(emptyActivityReason({ success: true, events: ev('Multisig.MultisigApproval') }))
      .toBe('A multisig approval: the operation runs once enough signatories approve.')
  })

  it('falls back to the plain empty state', () => {
    expect(emptyActivityReason({ success: true, events: ev('System.Remarked') })).toBeNull()
  })
})
