import { describe, expect, it } from 'vitest'
import { dcaScheduleStatus, dcaTerminationReason } from '../src/services/explorerService.ts'

describe('dcaScheduleStatus', () => {
  it('labels a termination from a signed dca.terminate call as cancelled', () => {
    expect(dcaScheduleStatus(true, false, true)).toBe('cancelled')
  })

  it('labels a hook (error) termination as terminated', () => {
    expect(dcaScheduleStatus(true, false, false)).toBe('terminated')
  })

  it('preserves completed and active states', () => {
    expect(dcaScheduleStatus(false, true, false)).toBe('completed')
    expect(dcaScheduleStatus(false, false, false)).toBe('active')
  })
})

describe('dcaTerminationReason', () => {
  it('names token-kind dispatch errors', () => {
    expect(dcaTerminationReason('{"__kind":"Token","value":{"__kind":"Frozen"}}')).toBe('token frozen')
  })

  it('splits camel-cased error names', () => {
    expect(dcaTerminationReason('{"__kind":"Token","value":{"__kind":"CannotCreate"}}')).toBe('token cannot create')
  })

  it('names a nested Token/FundsUnavailable error', () => {
    expect(dcaTerminationReason('{"__kind":"Token","value":{"__kind":"FundsUnavailable"}}')).toBe('token funds unavailable')
  })

  it('omits module errors, which need runtime metadata to name', () => {
    expect(dcaTerminationReason('{"__kind":"Module","value":{"index":66,"error":"0x0a000000"}}')).toBeNull()
    expect(dcaTerminationReason('{"__kind":"Module","value":{"index":67,"error":"0x00000000"}}')).toBeNull()
  })

  it('maps Other to a generic runtime error', () => {
    expect(dcaTerminationReason('{"__kind":"Other"}')).toBe('runtime error')
  })

  // Locks the legacy contract: bare (no sub-kind) named DispatchError kinds
  // other than Other collapse to the raw kind's lowercase form with NO
  // space, unlike dispatchErrorReason's own humanized/spaced label (e.g.
  // "bad origin"). See explorerService.ts dcaTerminationReason for why.
  it('collapses a bare named kind to a single lowercase word, no spaces', () => {
    expect(dcaTerminationReason('{"__kind":"BadOrigin"}')).toBe('badorigin')
    expect(dcaTerminationReason('{"__kind":"NoProviders"}')).toBe('noproviders')
    expect(dcaTerminationReason('{"__kind":"ConsumerRemaining"}')).toBe('consumerremaining')
  })

  it('handles absent or malformed errors', () => {
    expect(dcaTerminationReason(undefined)).toBeNull()
    expect(dcaTerminationReason(null)).toBeNull()
    expect(dcaTerminationReason('')).toBeNull()
    expect(dcaTerminationReason('not json')).toBeNull()
  })
})
