import { describe, it, expect } from 'vitest'
import { registeredFloor } from '../src/services/explorerService.ts'

const row = (asset_id: number, block_height: number, event_index = 0) => ({ asset_id, block_height, event_index })

describe('registeredFloor', () => {
  // ZEC (1001357) was registered days ago; a walk filtered to it can stop there.
  it('is the earliest registration among the assets', () => {
    expect(registeredFloor([1001357], [row(1001357, 15_700_000), row(5, 10)])).toBe(15_700_000)
    expect(registeredFloor([1001357, 1001358], [row(1001357, 15_700_000), row(1001358, 15_650_000)])).toBe(15_650_000)
  })

  // A re-registration must not raise the floor past the asset's first existence.
  it('takes the first registration of an asset seen twice', () => {
    expect(registeredFloor([7], [row(7, 900), row(7, 100)])).toBe(100)
  })

  // A genesis asset has no Registered event; bounding by the others would hide its rows.
  it('does not bound when any asset has no registration indexed', () => {
    expect(registeredFloor([5, 1001357], [row(1001357, 15_700_000)])).toBe(0)
    expect(registeredFloor([], [row(1, 1)])).toBe(0)
  })
})
