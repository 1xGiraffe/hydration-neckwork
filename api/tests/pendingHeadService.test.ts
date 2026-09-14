import { describe, expect, it } from 'vitest'
import { prunePending, sqdCallName, sqdEventName, type PendingBlock } from '../src/services/pendingHeadService.ts'
import { chTimestamp, chTimestampMs } from '../src/services/clickhouseTime.ts'

// Pending rows must read IDENTICALLY to their finalized versions, or the same
// extrinsic would change its display name the moment it finalizes: SQD names
// pallets capitalized, calls snake_case, events UpperCamel.
describe('sqd naming', () => {
  it('converts polkadot-js camelCase calls to SQD snake_case', () => {
    expect(sqdCallName('balances', 'transferKeepAlive')).toBe('Balances.transfer_keep_alive')
    expect(sqdCallName('omnipool', 'sell')).toBe('Omnipool.sell')
    expect(sqdCallName('dispatcher', 'dispatchWithExtraGas')).toBe('Dispatcher.dispatch_with_extra_gas')
  })

  it('keeps event names UpperCamel with a capitalized pallet', () => {
    expect(sqdEventName('tokens', 'Transfer')).toBe('Tokens.Transfer')
    expect(sqdEventName('system', 'ExtrinsicSuccess')).toBe('System.ExtrinsicSuccess')
  })
})

describe('ClickHouse DateTime literals', () => {
  it('formats like a ClickHouse DateTime string', () => {
    expect(chTimestampMs(Date.UTC(2026, 7, 6, 12, 34, 56))).toBe('2026-08-06 12:34:56')
  })

  // The two differ by a factor of 1000 and were indistinguishable at a call site
  // while both were spelled `chTimestamp`, so the unit is in the name.
  it('reads its argument in the unit its name states', () => {
    const ms = Date.UTC(2026, 7, 6, 12, 34, 56)
    expect(chTimestamp(ms / 1000)).toBe(chTimestampMs(ms))
    expect(chTimestamp(ms)).not.toBe(chTimestampMs(ms))
  })
})

// The map holds ONLY what the finalized pipeline does not yet serve: pruning
// retires everything at or below the checkpoint, and the hard cap bounds the
// map even if ingestion stalls — unfinalized data is never kept long-term.
describe('prunePending', () => {
  const block = (height: number): PendingBlock =>
    ({ height, hash: `0x${height}`, parentHash: `0x${height - 1}`, timestamp: '', specVersion: 0, extrinsics: [], events: [] })

  it('drops heights at or below the finalized floor', () => {
    const map = new Map([[10, block(10)], [11, block(11)], [12, block(12)]])
    prunePending(map, 11)
    expect([...map.keys()]).toEqual([12])
  })

  it('enforces the hard cap oldest-first when ingestion stalls', () => {
    const map = new Map(Array.from({ length: 8 }, (_, i) => [i + 1, block(i + 1)] as const))
    prunePending(map, 0, 3)
    expect([...map.keys()]).toEqual([6, 7, 8])
  })
})
