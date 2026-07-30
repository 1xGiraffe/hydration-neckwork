import { describe, it, expect } from 'vitest'
import { isDcaFeeLegSwap } from '../src/services/explorerService.ts'

// DCA keeper-fee swaps are owner-attributed but have no extrinsic. The paired
// Router.Executed event is the user-facing trade; pallet accounts remain visible.
const OWNER = `0x${'11'.repeat(32)}`
const ROUTEREX = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'

describe('isDcaFeeLegSwap', () => {
  it('flags a pallet-internal swap attributed to a real user (the DCA fee leg)', () => {
    expect(isDcaFeeLegSwap(null, OWNER)).toBe(true)
  })

  it('keeps the DCA net trade (Router.Executed carries no who)', () => {
    expect(isDcaFeeLegSwap(null, '')).toBe(false)
  })

  it('keeps router hops / pool legs (0x6d6f646c pallet who)', () => {
    expect(isDcaFeeLegSwap(null, ROUTEREX)).toBe(false)
    expect(isDcaFeeLegSwap(null, '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000')).toBe(false)
  })

  it('keeps genuine signed user swaps (they carry an extrinsic)', () => {
    expect(isDcaFeeLegSwap(3, OWNER)).toBe(false)
    expect(isDcaFeeLegSwap(0, OWNER)).toBe(false)
  })
})
