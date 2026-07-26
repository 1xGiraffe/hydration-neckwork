import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mapChunksConcurrently } from '../src/services/explorerService.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// The XCM decoders chunk their candidate blocks to keep each query under the client's
// 100k max_result_rows guard, then concatenate the chunks and sort. The sort key
// (block height, event index) has ties, and Array#sort is stable, so the order chunks
// come back in is part of the response. Concurrency must therefore preserve chunk
// order regardless of which chunk's query finishes first.
describe('mapChunksConcurrently', () => {
  it('returns chunks in input order even when later chunks resolve first', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const started: number[] = []
    const chunks = await mapChunksConcurrently(items, 2, 4, async chunk => {
      started.push(chunk[0])
      // Earlier chunks finish last, so an order-by-completion bug cannot pass.
      await new Promise(resolve => setTimeout(resolve, 20 - chunk[0]))
      return chunk.map(value => value * 10)
    })

    expect(chunks).toEqual([[0, 10], [20, 30], [40, 50], [60, 70], [80, 90]])
    expect(started.slice(0, 4)).toEqual([0, 2, 4, 6])
  })

  it('covers every item exactly once and splits on the chunk size', async () => {
    const items = Array.from({ length: 2501 }, (_, i) => i)
    const chunks = await mapChunksConcurrently(items, 1_000, 4, async chunk => chunk)

    expect(chunks.map(chunk => chunk.length)).toEqual([1_000, 1_000, 501])
    expect(chunks.flat()).toEqual(items)
  })

  it('runs no worker for an empty input', async () => {
    let calls = 0
    const chunks = await mapChunksConcurrently([], 1_000, 4, async chunk => { calls++; return chunk })

    expect(chunks).toEqual([])
    expect(calls).toBe(0)
  })

  it('never caps concurrency above the chunk count', async () => {
    let inFlight = 0
    let peak = 0
    await mapChunksConcurrently([1, 2, 3], 1, 8, async chunk => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return chunk
    })

    expect(peak).toBe(3)
  })
})

describe('the XCM chunk walks are not serial', () => {
  it('leaves no awaited 1,000-key chunk loop behind', () => {
    const serialChunkLoops = explorerService.match(/for \(let start = 0;[^\n]*\+= 1_000\)/g) ?? []

    expect(serialChunkLoops).toEqual([])
  })
})
