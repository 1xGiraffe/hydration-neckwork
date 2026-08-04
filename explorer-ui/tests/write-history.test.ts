import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fieldHistory, fieldKey, historyKey, recordFieldValues, removeFieldValue, suggestionsFor,
} from '../src/writeHistory'

const STORAGE_KEY = 'contract-write-inputs:v2'
const LEGACY_KEY = 'contract-write-inputs:v1'

// The same Map-backed Storage stand-in the session/wallet tests use — no jsdom
// in this repo.
function memoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
}

const TRANSFER = {
  type: 'function' as const,
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [],
}
const SIG = 'transfer(address to,uint256 amount)'
const ALICE = '0x000000000000000000000000000000000000dEaD'
const BOB = '0xf34e845538cc8a498edd97d7cde16fdfef3d4d99'

beforeEach(() => { vi.stubGlobal('window', { localStorage: memoryStorage() }) })

describe('historyKey', () => {
  it('keys by function name, parameter types AND parameter names', () => {
    expect(historyKey(TRANSFER)).toBe(SIG)
    expect(historyKey({ ...TRANSFER, inputs: [] })).toBe('transfer()')
  })

  it('falls back to the bare type for an unnamed parameter, as ABIs allow', () => {
    expect(historyKey({ ...TRANSFER, inputs: [{ name: '', type: 'address' }, { name: 'amount', type: 'uint256' }] }))
      .toBe('transfer(address,uint256 amount)')
  })

  // The point of keying on the signature: the same call on a different contract
  // shares its remembered values, while a different shape does not.
  it('separates same-named functions with different parameter types', () => {
    const other = { ...TRANSFER, inputs: [{ name: 'to', type: 'address' }] }
    expect(historyKey(other)).not.toBe(historyKey(TRANSFER))
  })

  it('separates identical types whose parameter names differ', () => {
    const renamed = { ...TRANSFER, inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] }
    expect(historyKey(renamed)).toBe('transfer(address spender,uint256 value)')
    expect(historyKey(renamed)).not.toBe(historyKey(TRANSFER))
  })
})

describe('recordFieldValues', () => {
  it('remembers per field, most recent first, without duplicates', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE, [fieldKey(1)]: '1000' })
    recordFieldValues(SIG, { [fieldKey(0)]: BOB, [fieldKey(1)]: '2000' })
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE, [fieldKey(1)]: '1000' })
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([ALICE, BOB])
    expect(fieldHistory(SIG, fieldKey(1))).toEqual(['1000', '2000'])
  })

  it('keeps fields and signatures apart', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE })
    recordFieldValues('approve(address spender,uint256 amount)', { [fieldKey(0)]: BOB })
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([ALICE])
    expect(fieldHistory(SIG, fieldKey(1))).toEqual([])
    expect(fieldHistory('approve(address spender,uint256 amount)', fieldKey(0))).toEqual([BOB])
  })

  it('ignores blank and whitespace-only entries, and trims what it keeps', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: '   ', [fieldKey(1)]: '  42  ' })
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([])
    expect(fieldHistory(SIG, fieldKey(1))).toEqual(['42'])
  })

  it('caps a field at eight values, dropping the oldest', () => {
    for (let i = 1; i <= 10; i++) recordFieldValues(SIG, { [fieldKey(1)]: String(i) })
    expect(fieldHistory(SIG, fieldKey(1))).toEqual(['10', '9', '8', '7', '6', '5', '4', '3'])
  })
})

describe('removeFieldValue', () => {
  it('forgets one value and leaves the rest', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE })
    recordFieldValues(SIG, { [fieldKey(0)]: BOB })
    removeFieldValue(SIG, fieldKey(0), ALICE)
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([BOB])
  })

  it('cleans up the field and the signature once nothing is left', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE })
    removeFieldValue(SIG, fieldKey(0), ALICE)
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{}')
  })

  it('is a no-op for a value that was never recorded', () => {
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE })
    removeFieldValue(SIG, fieldKey(0), BOB)
    removeFieldValue('nothing()', fieldKey(0), ALICE)
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([ALICE])
  })
})

// v1 keyed on types alone, so nothing under it can ever match again.
describe('legacy storage', () => {
  it('drops the v1 entry the first time anything is recorded', () => {
    window.localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'transfer(address,uint256)': { 0: [ALICE] } }))
    recordFieldValues(SIG, { [fieldKey(0)]: BOB })
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([BOB])
  })
})

describe('suggestionsFor', () => {
  it('offers everything when nothing is typed', () => {
    expect(suggestionsFor([ALICE, BOB], '')).toEqual([ALICE, BOB])
  })

  it('narrows case-insensitively by substring, not just prefix', () => {
    expect(suggestionsFor([ALICE, BOB], 'F34E')).toEqual([BOB])
    expect(suggestionsFor([ALICE, BOB], 'dead')).toEqual([ALICE])
  })

  it('drops an exact match — offering what is already typed is noise', () => {
    expect(suggestionsFor([ALICE, BOB], ALICE.toLowerCase())).toEqual([])
  })
})

describe('corrupt or hostile storage', () => {
  it('reads as empty rather than throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not json')
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([])
    window.localStorage.setItem(STORAGE_KEY, '["an array"]')
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([])
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ [SIG]: { 0: [1, null, 'ok'] } }))
    expect(fieldHistory(SIG, fieldKey(0))).toEqual(['ok'])
  })

  it('recovers by overwriting on the next record', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not json')
    recordFieldValues(SIG, { [fieldKey(0)]: ALICE })
    expect(fieldHistory(SIG, fieldKey(0))).toEqual([ALICE])
  })
})
