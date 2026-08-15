import { describe, expect, it } from 'vitest'
import { dispatchErrorReason } from '../src/services/explorerService.ts'

const NAMES: Record<string, { pallet: string; name: string; docs: string }> = {
  '428/67/0': { pallet: 'Omnipool', name: 'InsufficientLiquidity', docs: 'Not enough liquidity.' },
  // The 2022-era triples the flat Module shape carries; `runtime_error_names`
  // names all 601 of them, so the parser is the only thing standing in the way.
  '104/0/5': { pallet: 'System', name: 'CallFiltered', docs: 'The origin filter prevent the call to be dispatched.' },
  '104/1/5': { pallet: 'Balances', name: 'KeepAlive', docs: 'Transfer/payment would kill account.' },
  '104/53/0': { pallet: 'DCA', name: 'ScheduleNotFound', docs: 'Schedule not exist.' },
}
const resolve = (s: number, p: number, e: number) => NAMES[`${s}/${p}/${e}`] ?? null

describe('dispatchErrorReason', () => {
  it('names a module error from the lookup', () => {
    const r = dispatchErrorReason({ __kind: 'Module', value: { index: 67, error: '0x00000000' } }, 428, resolve)
    expect(r).toEqual({ label: 'Omnipool.InsufficientLiquidity', docs: 'Not enough liquidity.' })
  })

  it('falls back honestly for an unknown module error', () => {
    const r = dispatchErrorReason({ __kind: 'Module', value: { index: 99, error: '0x02000000' } }, 428, resolve)
    expect(r).toEqual({ label: 'pallet 99 · error #2', docs: null })
  })

  // Blocks 692,900 … 1,475,949 (2022-07-06 … 2022-11-29) carry a DIFFERENT Module
  // shape: `index` and `error` sit at the top level and `error` is a plain integer
  // rather than a 4-byte little-endian hex array. Measured on the live table: 601
  // extrinsics, and `runtime_error_names` names all 601 — so reading only the
  // modern shape left every one of them unnamed while the metadata to name them
  // was already indexed.
  it('names the pre-2022-11 flat Module shape, whose error index is an integer', () => {
    // The most common flat triple on the live table: 425 of the 601 rows.
    expect(dispatchErrorReason('{"index":1,"error":5,"__kind":"Module"}', 104, resolve))
      .toEqual({ label: 'Balances.KeepAlive', docs: 'Transfer/payment would kill account.' })
    // Pallet 0 is the System pallet, not "no pallet" — block 692,900's own failure.
    expect(dispatchErrorReason('{"index":0,"error":5,"__kind":"Module"}', 104, resolve))
      .toEqual({ label: 'System.CallFiltered', docs: 'The origin filter prevent the call to be dispatched.' })
    // Error index 0 is a real error, and the flat shape states it as the integer 0.
    expect(dispatchErrorReason('{"index":53,"error":0,"__kind":"Module"}', 104, resolve))
      .toEqual({ label: 'DCA.ScheduleNotFound', docs: 'Schedule not exist.' })
  })

  it('falls back honestly for an unknown flat Module triple', () => {
    expect(dispatchErrorReason('{"index":19,"error":24,"__kind":"Module"}', 104, resolve))
      .toEqual({ label: 'pallet 19 · error #24', docs: null })
  })

  // A row that somehow carried both shapes cannot flip meaning with parse order.
  it('prefers the nested value over top-level indices when both are present', () => {
    expect(dispatchErrorReason({ __kind: 'Module', index: 1, error: 5, value: { index: 67, error: '0x00000000' } }, 428, resolve))
      .toEqual({ label: 'Omnipool.InsufficientLiquidity', docs: 'Not enough liquidity.' })
  })

  // 0 is a real pallet index and a real error index, so a Module error neither
  // reader understands must report nothing rather than resolve a valid triple it
  // invented. Pre-fix this named pallet 67 error #0 for a row that never said 0.
  it('reports nothing for a Module error whose indices are unreadable', () => {
    expect(dispatchErrorReason({ __kind: 'Module', value: { index: 67 } }, 428, resolve)).toBeNull()
    expect(dispatchErrorReason('{"__kind":"Module"}', 428, resolve)).toBeNull()
    expect(dispatchErrorReason('{"__kind":"Module","index":"notanumber","error":5}', 428, resolve)).toBeNull()
    expect(dispatchErrorReason({ __kind: 'Module', value: { index: 67, error: '0x' } }, 428, resolve)).toBeNull()
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
