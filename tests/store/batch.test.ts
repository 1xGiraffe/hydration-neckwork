import { describe, expect, it } from 'vitest'
import { BatchAccumulator, chunkRows } from '../../src/store/batch.ts'

describe('BatchAccumulator', () => {
  it.each([0, -1, 1.5, Number.NaN])('rejects invalid flush threshold %s', (threshold) => {
    expect(() => new BatchAccumulator(threshold)).toThrow(RangeError)
  })

  it('accepts batches larger than the JavaScript argument limit', () => {
    const accumulator = new BatchAccumulator<number>(200_000)
    const rows = Array.from({ length: 150_000 }, (_, index) => index)

    expect(() => accumulator.add(rows)).not.toThrow()
    expect(accumulator.size).toBe(rows.length)
    expect(accumulator.flush()).toEqual(rows)
  })

  it('drains rows in threshold-sized chunks', () => {
    const accumulator = new BatchAccumulator<number>(2)
    accumulator.add([1, 2, 3, 4, 5])

    expect(accumulator.flushChunks()).toEqual([[1, 2], [3, 4], [5]])
    expect(accumulator.size).toBe(0)
  })

  it('chunks retained rows without mutating the source', () => {
    const rows = [1, 2, 3, 4, 5]

    expect([...chunkRows(rows, 2)]).toEqual([[1, 2], [3, 4], [5]])
    expect(rows).toEqual([1, 2, 3, 4, 5])
  })
})
