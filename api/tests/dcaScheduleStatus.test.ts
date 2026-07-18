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

  it('omits module errors, which need runtime metadata to name', () => {
    expect(dcaTerminationReason('{"__kind":"Module","value":{"index":66,"error":"0x0a000000"}}')).toBeNull()
  })

  it('maps Other to a generic runtime error', () => {
    expect(dcaTerminationReason('{"__kind":"Other"}')).toBe('runtime error')
  })

  it('handles absent or malformed errors', () => {
    expect(dcaTerminationReason(undefined)).toBeNull()
    expect(dcaTerminationReason('not json')).toBeNull()
  })
})
