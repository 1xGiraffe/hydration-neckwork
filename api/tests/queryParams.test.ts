import { describe, expect, it } from 'vitest'
import { assertQueryParamsFit, chunkByParamBytes, encodedParamBytes, HTTP_FIELD_VALUE_LIMIT, mapParamChunks, QUERY_PARAM_BYTE_BUDGET, QueryParamTooLargeError } from '../src/db/queryParams.ts'
import { drainQueryResponses, type ClickHouseClient } from '../src/db/client.ts'

const blocks = (n: number, from = 15_000_000) => Array.from({ length: n }, (_, i) => from + i)
const accounts = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'))

describe('bound query parameter sizing', () => {
  it('measures the URL-encoded value ClickHouse checks', () => {
    // 8-digit blocks cost 11 bytes each: the digits plus an encoded `%2C`.
    expect(encodedParamBytes(blocks(1_000))).toBe(1_000 * 8 + 999 * 3 + 6)
    // A 64-hex account costs 72: quotes and separator encoded.
    expect(encodedParamBytes(accounts(10))).toBe(10 * 70 + 9 * 3 + 6)
  })

  it('refuses a list past the server ceiling before sending it', () => {
    // The production shape: a v3 pool past ~11.9k distinct swap blocks.
    expect(() => assertQueryParamsFit({ blocks: blocks(12_000) })).toThrow(QueryParamTooLargeError)
    expect(() => assertQueryParamsFit({ accounts: accounts(1_900) })).toThrow(/"accounts" is \d+ encoded bytes/)
    expect(() => assertQueryParamsFit({ blocks: blocks(11_000), accounts: accounts(1_700), n: 5 })).not.toThrow()
  })

  it('measures a non-ASCII string exactly: 漢 costs 9 encoded bytes, not 3', () => {
    expect(encodedParamBytes('漢')).toBe(9)
    // 20k characters: 60k by a "×3" estimate (under the ceiling), 180k encoded.
    const han = '漢'.repeat(20_000)
    expect(() => assertQueryParamsFit({ title: han })).toThrow(QueryParamTooLargeError)
    // Escaped backslashes double before encoding (6 bytes each).
    expect(() => assertQueryParamsFit({ s: '\\'.repeat(22_000) })).toThrow(QueryParamTooLargeError)
    // Short strings stay on the fast path, and a long ASCII one under the ceiling passes.
    expect(() => assertQueryParamsFit({ title: '漢'.repeat(14_000), a: 'a'.repeat(120_000) })).not.toThrow()
    // Emoji (surrogate pairs) encode to 12 bytes per 2 units.
    expect(encodedParamBytes('😀')).toBe(12)
  })

  it('measures Map and object params too, not only arrays and strings', () => {
    const big = new Map(accounts(2_000).map((a, i) => [a, i]))
    expect(() => assertQueryParamsFit({ weights: big })).toThrow(/"weights" is \d+ encoded bytes/)
    expect(() => assertQueryParamsFit({ weights: Object.fromEntries(big) })).toThrow(QueryParamTooLargeError)
    expect(() => assertQueryParamsFit({ weights: new Map([['a', 1]]), n: 5, b: 5n, f: true, d: new Date(0), z: null })).not.toThrow()
  })

  it('never puts a value in the error', () => {
    try { assertQueryParamsFit({ accounts: accounts(2_000) }) } catch (err) {
      expect((err as Error).message).not.toMatch(/[0-9a-f]{64}/)
      return
    }
    throw new Error('expected a throw')
  })

  it('chunks every list under the budget, in order, without loss', () => {
    for (const list of [blocks(40_000), accounts(9_000) as unknown[]]) {
      const chunks = chunkByParamBytes(list)
      expect(chunks.flat()).toEqual(list)
      for (const c of chunks) expect(encodedParamBytes(c)).toBeLessThanOrEqual(QUERY_PARAM_BYTE_BUDGET)
      expect(chunks.length).toBeGreaterThan(1)
    }
    expect(chunkByParamBytes([])).toEqual([])
    expect(chunkByParamBytes(blocks(10), undefined, 3).map(c => c.length)).toEqual([3, 3, 3, 1])
  })

  it('maps chunks concurrently and keeps chunk order', async () => {
    const out = await mapParamChunks(blocks(30_000), async c => { await new Promise(r => setTimeout(r, Math.random() * 5)); return c }, { concurrency: 3 })
    expect(out.flat()).toEqual(blocks(30_000))
  })

  it('every client query is guarded', async () => {
    let sent = 0
    const stub = { query: async () => { sent++; throw new Error('should not reach the server') } } as unknown as ClickHouseClient
    const client = drainQueryResponses(stub)
    await expect(client.query({ query: 'SELECT 1', query_params: { blocks: blocks(20_000) } })).rejects.toThrow(QueryParamTooLargeError)
    expect(sent).toBe(0)
    expect(HTTP_FIELD_VALUE_LIMIT).toBe(131_072)
  })
})
