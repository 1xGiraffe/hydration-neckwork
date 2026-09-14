import { describe, expect, it } from 'vitest'
import {
  LEGACY_SWAP_EVENT_NAMES,
  UNIFIED_SWAP_EVENT_NAMES,
  isSwapEvent,
} from '../../src/registry/swapEvents.ts'
import { ALL_SWAP_EVENT_NAMES } from '../../src/scripts/tradeEventDecoder.ts'

// Three things name the swap events: the two era name sets, the version-less
// EVENT_CLASSIFICATION map behind them, and the repair tooling's SQL selection.
// They have to agree, or a repair rebuilds a different set of trades than
// ingestion booked — which is exactly what a second hand-written copy produces
// the moment one of them gains an event and the others do not.

// The runtime that replaced the per-pallet *Executed events with Broadcast.Swapped*.
const UNIFIED_FROM = 282

describe('swap event names', () => {
  it('selects exactly the two registry name sets, with no third copy', () => {
    expect([...ALL_SWAP_EVENT_NAMES].sort())
      .toEqual([...LEGACY_SWAP_EVENT_NAMES, ...UNIFIED_SWAP_EVENT_NAMES].sort())
  })

  it('classifies every selected name as a swap in the era that emits it', () => {
    expect(ALL_SWAP_EVENT_NAMES.length).toBeGreaterThan(0)
    for (const name of LEGACY_SWAP_EVENT_NAMES) {
      expect(isSwapEvent(name, UNIFIED_FROM - 1), name).toBe(true)
      expect(isSwapEvent(name, UNIFIED_FROM), name).toBe(false)
    }
    for (const name of UNIFIED_SWAP_EVENT_NAMES) {
      expect(isSwapEvent(name, UNIFIED_FROM), name).toBe(true)
      expect(isSwapEvent(name, UNIFIED_FROM - 1), name).toBe(false)
    }
  })

  // The version-less arm reads a separately written classification map, so it is
  // the copy most able to drift without any caller noticing.
  it('keeps the version-less classification in step with both name sets', () => {
    for (const name of ALL_SWAP_EVENT_NAMES) {
      expect(isSwapEvent(name), name).toBe(true)
    }
  })

  it('does not classify a neighbouring pool event as a swap', () => {
    for (const version of [UNIFIED_FROM - 1, UNIFIED_FROM, undefined]) {
      expect(isSwapEvent('Omnipool.TokenAdded', version)).toBe(false)
      expect(isSwapEvent('XYK.PoolCreated', version)).toBe(false)
    }
  })
})
