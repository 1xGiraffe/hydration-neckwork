import { describe, expect, it } from 'vitest'
import {
  compareOrderHistory, dcaHistoryEntries, intentHistoryEntries, matchesOrderKind, orderHistorySlice,
  type DcaEndRow, type IntentEndRow, type OrderHistoryEntry,
} from '../src/services/orderHistory.ts'

// Order history: the finished-order list the Orders tab pages through. Status comes
// from the detail pages' own mappings (dcaScheduleStatus / intentOrderStatus), and
// the pages must tile the full ordered set exactly — no overlap, no gap, the same
// identities on every read.

const dcaEnd = (id: string, event_name: string, block_height: number, event_index: number, extrinsic_index: number | null = null): DcaEndRow =>
  ({ id, event_name, block_height, event_index, extrinsic_index, ts: `t${block_height}` })
const intentEnd = (intent_id: string, event_name: string, block_height: number, event_index: number): IntentEndRow =>
  ({ intent_id, event_name, block_height, event_index, ts: `t${block_height}` })

describe('dcaHistoryEntries', () => {
  it('maps each end event the way the schedule page does', () => {
    const entries = dcaHistoryEntries([
      dcaEnd('1', 'DCA.Completed', 100, 3),
      dcaEnd('2', 'DCA.Terminated', 110, 4, null), // block hook: the pallet ended it on an error
      dcaEnd('3', 'DCA.Terminated', 120, 5, 2), // signed: the owner's own terminate
      dcaEnd('4', 'DCA.Migrated', 130, 6),
      dcaEnd('5', 'DCA.MigrationCancelled', 140, 7),
    ])
    const by = new Map(entries.map(e => [e.id, e]))
    expect(by.get('1')).toMatchObject({ kind: 'dca', status: 'completed', endedBlock: 100, endedEventIndex: 3, endedAt: 't100' })
    expect(by.get('2')).toMatchObject({ status: 'terminated', hookTermination: { bh: 110, ei: 4 } })
    expect(by.get('3')?.status).toBe('cancelled')
    expect(by.get('3')?.hookTermination).toBeUndefined()
    expect(by.get('4')).toMatchObject({ status: 'migrated', migration: { bh: 130, ei: 6 } })
    expect(by.get('5')?.status).toBe('migration-cancelled')
  })

  it('collapses a replayed end event to one entry', () => {
    const entries = dcaHistoryEntries([dcaEnd('9', 'DCA.Completed', 100, 3), dcaEnd('9', 'DCA.Completed', 100, 3)])
    expect(entries).toHaveLength(1)
  })
})

describe('intentHistoryEntries', () => {
  const orders = [
    { intent_id: '10', kind: 'swap' }, { intent_id: '11', kind: 'swap' }, { intent_id: '12', kind: 'dca' },
    { intent_id: '13', kind: 'dca' }, { intent_id: '14', kind: 'swap' }, { intent_id: '15', kind: 'swap' },
  ]
  const entries = intentHistoryEntries(orders, [
    intentEnd('10', 'Intent.IntentResolved', 200, 1),
    intentEnd('11', 'Intent.IntentCanceled', 210, 2),
    intentEnd('12', 'Intent.DcaCompleted', 220, 3),
    intentEnd('13', 'Intent.IntentCanceled', 230, 4),
    intentEnd('14', 'Intent.IntentExpired', 240, 5),
  ])
  const by = new Map(entries.map(e => [e.id, e]))

  it('maps terminal events through intentOrderStatus and kinds DCA intents apart', () => {
    expect(by.get('10')).toMatchObject({ kind: 'limit', status: 'filled', endedBlock: 200 })
    expect(by.get('11')).toMatchObject({ kind: 'limit', status: 'cancelled' })
    expect(by.get('12')).toMatchObject({ kind: 'dca-intent', status: 'completed' })
    expect(by.get('13')).toMatchObject({ kind: 'dca-intent', status: 'cancelled' })
    expect(by.get('14')).toMatchObject({ kind: 'limit', status: 'expired' })
  })

  it('leaves resting orders (no terminal event) out', () => {
    expect(by.has('15')).toBe(false)
  })
})

describe('order history pagination', () => {
  // Ties on purpose: several orders end in one block, two at the same event index
  // (a DCA and an intent of the same solution cannot, but the order must still be
  // total), and ids that sort differently as strings and as numbers.
  const entries: OrderHistoryEntry[] = []
  for (let i = 0; i < 53; i++) {
    const kind = (['dca', 'dca-intent', 'limit'] as const)[i % 3]
    entries.push({ kind, id: String(1000 - i * 7 + (i % 5 === 0 ? 100000 : 0)), endedBlock: 500 - Math.floor(i / 4), endedEventIndex: i % 2, endedAt: '', status: kind === 'limit' ? 'filled' : 'completed' })
  }
  const identity = (e: OrderHistoryEntry) => `${e.kind}:${e.id}`

  it('tiles the full ordered set with consecutive pages — no overlap, no gap', () => {
    const full = [...entries].sort(compareOrderHistory).map(identity)
    const seen: string[] = []
    for (let offset = 0; offset < 60; offset += 10) {
      const { total, page } = orderHistorySlice(entries, 'all', offset, 10)
      expect(total).toBe(53)
      seen.push(...page.map(identity))
    }
    expect(seen).toEqual(full)
    expect(new Set(seen).size).toBe(53)
  })

  it('is stable whatever order the sources arrive in', () => {
    const a = orderHistorySlice(entries, 'all', 20, 10).page.map(identity)
    const b = orderHistorySlice([...entries].reverse(), 'all', 20, 10).page.map(identity)
    expect(b).toEqual(a)
  })

  it('orders by ended block and event index descending, then kind, then numeric id', () => {
    const e = (kind: OrderHistoryEntry['kind'], id: string, endedBlock: number, endedEventIndex: number): OrderHistoryEntry => ({ kind, id, endedBlock, endedEventIndex, endedAt: '', status: 'completed' })
    const sorted = [e('limit', '9', 10, 1), e('dca', '10', 10, 1), e('dca', '9', 10, 1), e('dca', '1', 11, 0), e('dca', '2', 10, 2)].sort(compareOrderHistory)
    expect(sorted.map(identity)).toEqual(['dca:1', 'dca:2', 'dca:9', 'dca:10', 'limit:9'])
  })

  it('filters by kind before counting: dca covers DCA intents, limit only swap intents', () => {
    const dca = orderHistorySlice(entries, 'dca', 0, 100)
    const limit = orderHistorySlice(entries, 'limit', 0, 100)
    expect(dca.total + limit.total).toBe(53)
    expect(dca.page.every(x => x.kind === 'dca' || x.kind === 'dca-intent')).toBe(true)
    expect(limit.page.every(x => x.kind === 'limit')).toBe(true)
    expect(matchesOrderKind({ ...entries[1], kind: 'dca-intent' }, 'dca')).toBe(true)
    expect(matchesOrderKind({ ...entries[1], kind: 'dca-intent' }, 'limit')).toBe(false)
  })

  it('answers an offset past the end with the total and no rows', () => {
    expect(orderHistorySlice(entries, 'all', 100, 25)).toEqual({ total: 53, page: [] })
  })
})
