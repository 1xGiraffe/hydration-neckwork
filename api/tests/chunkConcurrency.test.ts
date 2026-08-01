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

// The chunked reads an Activity page issues — candidate-block decodes, the key
// lookups that resolve semantic ownership, the liquidity transfer legs, the DCA
// execution and swap-leg joins, the hourly closes — used to await one chunk at a
// time. One filtered global page summed 51 s of ClickHouse time against a 37 s
// wall because of it.
describe('the chunked reads are not serial', () => {
  it('leaves no awaited chunk loop behind at the sizes those reads use', () => {
    const serialChunkLoops = explorerService.match(/for \(let (?:start|i) = 0;[^\n]*\+= (?:legChunk|500|1_000|2_000|5_000|5000)\)/g) ?? []

    expect(serialChunkLoops).toEqual([])
  })

  // Pin the site count: the guard above passes just as happily when the reads have
  // been deleted, renamed or re-chunked to a size it does not look for.
  it('routes every one of them through the one bounded helper', () => {
    const sites = explorerService.match(/mapChunksConcurrently\(/g) ?? []
    const bound = explorerService.match(/CHUNK_QUERY_CONCURRENCY/g) ?? []

    expect(sites).toHaveLength(25)
    // The shared bound, plus its own declaration. Every site takes it: a site with
    // a hand-rolled concurrency is the thing this count exists to catch.
    expect(bound).toHaveLength(sites.length + 1)
    expect(explorerService).toMatch(/const CHUNK_QUERY_CONCURRENCY = 4$/m)
  })

  // The 500-key chunk in fillMissingLiquidityAmounts is not a round number: that
  // read returns EVERY leg of each key, and at 5,000 keys one chunk came back with
  // 94k rows and the next crossed the client's 100k result guard. Concurrency must
  // not be an excuse to widen it back.
  it('keeps the liquidity leg chunk at the size the result guard allows', () => {
    expect(explorerService).toMatch(/const legChunk = 500$/m)
    expect(explorerService.match(/mapChunksConcurrently\((?:extKeys|nullExtBlocks), legChunk,/g)).toHaveLength(2)
  })
})
