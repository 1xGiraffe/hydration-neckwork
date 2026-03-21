import { describe, it, expect } from 'vitest'
// This import will fail until Task 1 exports extractParachainId
import { extractParachainId } from '../src/registry/tracker'

describe('extractParachainId', () => {
  it('returns null for null/undefined location', () => {
    expect(extractParachainId(null)).toBeNull()
    expect(extractParachainId(undefined)).toBeNull()
  })

  it('returns null for native Hydration assets (parents: 0)', () => {
    expect(extractParachainId({ parents: 0, interior: { __kind: 'Here' } })).toBeNull()
  })

  it('returns null for native parachain token — X1(Parachain(id)) only', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: { __kind: 'Parachain', value: 1000 }
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('returns null for native parachain token — X1 array format (V5)', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'Parachain', value: 2004 }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })

  it('extracts parachainId from X2(Parachain(id), GeneralKey(...))', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X2',
        value: [
          { __kind: 'Parachain', value: 1000 },
          { __kind: 'GeneralKey', value: { length: 2, data: '0x0001' } }
        ]
      }
    }
    expect(extractParachainId(location)).toBe(1000)
  })

  it('returns null when interior is Here', () => {
    expect(extractParachainId({ parents: 1, interior: { __kind: 'Here' } })).toBeNull()
  })

  it('returns null when no Parachain junction exists', () => {
    const location = {
      parents: 1,
      interior: {
        __kind: 'X1',
        value: [{ __kind: 'AccountKey20', value: '0xabc' }]
      }
    }
    expect(extractParachainId(location)).toBeNull()
  })
})
