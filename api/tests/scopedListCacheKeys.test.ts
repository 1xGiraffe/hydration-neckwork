import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The shared extrinsic/event list builders compose their cache key as
// `explorer:<cacheKey>:<limit>:<offset>:<from>:<to>:<filterKey>` — nothing in
// the suffix says WHICH list is cached, so the caller's cacheKey must. The
// list-tag pair once passed the same bare scope string to both builders, the
// unfiltered keys collided byte-for-byte, and within one 8s TTL window the
// events tab was served the extrinsics payload (the UI crashed rendering
// extrinsic rows as events). Pin that every getAccountExtrinsics /
// getAccountEvents call site carries a kind-distinct cacheKey prefix.
describe('scoped list cache keys', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/services/explorerService.ts', import.meta.url)), 'utf8')

  const callArgs = (fn: 'getAccountExtrinsics' | 'getAccountEvents'): string[] =>
    [...source.matchAll(new RegExp(`return ${fn}\\((.*)\\)$`, 'gm'))].map(m => m[1])

  it('every extrinsic-list call site names the extrinsics kind in its cacheKey', () => {
    const calls = callArgs('getAccountExtrinsics')
    expect(calls.length).toBeGreaterThanOrEqual(3) // addr, system tag, list tag
    for (const args of calls) expect(args).toMatch(/extrinsics:/)
  })

  it('every event-list call site names the events kind in its cacheKey', () => {
    const calls = callArgs('getAccountEvents')
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const args of calls) expect(args).toMatch(/events:/)
  })

  it('no call site of either builder shares a cacheKey expression with the other', () => {
    const keyOf = (args: string) => args.split(',')[3]
    const extrinsicKeys = callArgs('getAccountExtrinsics').map(keyOf)
    const eventKeys = new Set(callArgs('getAccountEvents').map(keyOf))
    for (const key of extrinsicKeys) expect(eventKeys.has(key), `cacheKey ${key} feeds both list kinds`).toBe(false)
  })
})
