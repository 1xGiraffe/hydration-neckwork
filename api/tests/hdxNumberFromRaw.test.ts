import { describe, expect, it } from 'vitest'
import { hdxNumberFromRaw } from '../src/services/hdxService.ts'

describe('hdxNumberFromRaw', () => {
  it('converts an exact planck sum once, to the nearest double', () => {
    // The 125 pending GIGAHDX unstakes at block 15,027,984.
    expect(hdxNumberFromRaw(18680902224463829615n)).toBe(Number('18680902.224463829615'))
    expect(hdxNumberFromRaw(1n)).toBe(1e-12)
    expect(hdxNumberFromRaw(0n)).toBe(0)
    expect(hdxNumberFromRaw(-1500000000000n)).toBe(-1.5)
  })
})
