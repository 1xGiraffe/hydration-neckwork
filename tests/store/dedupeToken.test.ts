import { describe, expect, it } from 'vitest'
import { buildInsertDedupeToken } from '../../src/store/dedupeToken.ts'

describe('buildInsertDedupeToken', () => {
  it('is stable across object-key ordering', () => {
    const left = buildInsertDedupeToken('rows', 'replay', [
      { a: 1, b: 'two' },
      { a: 2, b: 'three' },
    ])
    const right = buildInsertDedupeToken('rows', 'replay', [
      { b: 'two', a: 1 },
      { b: 'three', a: 2 },
    ])

    expect(left).toBe(right)
  })

  it('changes when row content changes despite identical bounds and counts', () => {
    const left = buildInsertDedupeToken('rows', 'replay', [{ id: 1, value: 'old' }], [10, 10])
    const right = buildInsertDedupeToken('rows', 'replay', [{ id: 1, value: 'new' }], [10, 10])

    expect(left).not.toBe(right)
  })
})
