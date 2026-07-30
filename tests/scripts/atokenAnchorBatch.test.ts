import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../src/scripts/snapshot-atoken-anchors.ts', import.meta.url), 'utf8')

// A missing balanceOf is indistinguishable from a zero one. The batch reader used to
// return null for a dropped chunk or a per-item JSON-RPC error, anchorForContract
// skipped those holders, and runOnce published the short anchor — after which the
// table was non-empty, so no later cycle would ever recompute it. The anchor is pinned
// at B0 and every reconstructed balance builds on it, so it has to be all or nothing.
describe('aToken anchor batch reads', () => {
  const batch = source.slice(source.indexOf('async function ethCallBatchAt'), source.indexOf('async function readReserveMap'))

  it('returns non-nullable results', () => {
    expect(batch).toContain('Promise<string[]>')
    expect(batch).toContain('return out as string[]')
  })

  it('treats a per-item JSON-RPC error as a batch failure', () => {
    expect(batch).toContain("typeof r.result !== 'string'")
    expect(batch).toMatch(/throw new Error\([^)]*calls errored/)
  })

  it('throws instead of leaving a slot unfilled', () => {
    expect(batch).toContain('failed after retries')
    expect(batch).toContain('returned no result for request')
    // No silent per-chunk continue: every failure path ends in a throw.
    expect(batch).not.toMatch(/console\.error\([^)]*failed after retries/)
  })

  it('keeps an empty return as a legitimate skip, not a failure', () => {
    // '0x' means reverted or no code at B0 — a real answer.
    expect(source).toContain("if (b === '0x') return")
    expect(source).toContain("if (d === '0x') return")
  })

  it('records why the stored liquidity index is used for the anchor', () => {
    expect(source).toContain('getReserveNormalizedIncome')
    expect(source).toContain('0.00000007%')
  })
})
