import { describe, expect, it } from 'vitest'
import { dispatchErrorReason } from '../src/services/explorerService.ts'

const resolve = (s: number, p: number, e: number) =>
  s === 428 && p === 67 && e === 0
    ? { pallet: 'Omnipool', name: 'InsufficientLiquidity', docs: 'Not enough liquidity.' }
    : null

describe('dispatchErrorReason', () => {
  it('names a module error from the lookup', () => {
    const r = dispatchErrorReason({ __kind: 'Module', value: { index: 67, error: '0x00000000' } }, 428, resolve)
    expect(r).toEqual({ label: 'Omnipool.InsufficientLiquidity', docs: 'Not enough liquidity.' })
  })

  it('falls back honestly for an unknown module error', () => {
    const r = dispatchErrorReason({ __kind: 'Module', value: { index: 99, error: '0x02000000' } }, 428, resolve)
    expect(r).toEqual({ label: 'pallet 99 · error #2', docs: null })
  })

  it('formats a nested named kind', () => {
    const r = dispatchErrorReason({ __kind: 'Token', value: { __kind: 'FundsUnavailable' } }, 428, resolve)
    expect(r).toEqual({ label: 'Token · funds unavailable', docs: null })
  })

  it('formats a bare named kind', () => {
    expect(dispatchErrorReason({ __kind: 'BadOrigin' }, 428, resolve)).toEqual({ label: 'bad origin', docs: null })
  })

  it('accepts a JSON string and returns null for malformed/empty input', () => {
    expect(dispatchErrorReason('{"__kind":"BadOrigin"}', 428, resolve)).toEqual({ label: 'bad origin', docs: null })
    expect(dispatchErrorReason(null, 428, resolve)).toBeNull()
    expect(dispatchErrorReason('', 428, resolve)).toBeNull()
  })
})
