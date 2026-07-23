import { describe, expect, it } from 'vitest'
import { extractRuntimeErrorNames } from '../../src/raw/runtimeErrorNames.ts'
import type { Metadata } from '@subsquid/substrate-runtime/lib/metadata'

// Minimal V14 metadata: one pallet (index 67) whose error enum (type 5) has two
// variants. lookup.types is keyed by `id`.
const metadata = {
  __kind: 'V14',
  value: {
    lookup: {
      types: [
        { id: 5, type: { path: ['pallet_omnipool', 'pallet', 'Error'], params: [], docs: [], def: {
          __kind: 'Variant', value: { variants: [
            { name: 'InsufficientLiquidity', fields: [], index: 0, docs: ['Not enough liquidity.'] },
            { name: 'BuyLimitNotReached', fields: [], index: 3, docs: ['Buy', 'limit exceeded.'] },
          ] } } } },
      ],
    },
    pallets: [
      { name: 'Omnipool', index: 67, storage: undefined, calls: undefined, events: undefined, constants: [], errors: { type: 5 } },
      { name: 'NoErrors', index: 9, storage: undefined, calls: undefined, events: undefined, constants: [], errors: undefined },
    ],
  },
} as unknown as Metadata

describe('extractRuntimeErrorNames', () => {
  it('emits one row per error variant with name + joined docs', () => {
    const rows = extractRuntimeErrorNames(metadata, 428)
    expect(rows).toEqual([
      { spec_version: 428, pallet_index: 67, error_index: 0, pallet_name: 'Omnipool', error_name: 'InsufficientLiquidity', docs: 'Not enough liquidity.' },
      { spec_version: 428, pallet_index: 67, error_index: 3, pallet_name: 'Omnipool', error_name: 'BuyLimitNotReached', docs: 'Buy limit exceeded.' },
    ])
  })

  it('skips pallets without an error enum', () => {
    const rows = extractRuntimeErrorNames(metadata, 428)
    expect(rows.some(r => r.pallet_index === 9)).toBe(false)
  })

  it('returns [] for pre-V14 metadata', () => {
    expect(extractRuntimeErrorNames({ __kind: 'V13', value: {} } as unknown as Metadata, 100)).toEqual([])
  })
})
