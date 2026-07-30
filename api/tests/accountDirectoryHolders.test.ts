import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

// An EVM account's id is 0x45544800 + its H160 + zeros, so its money-market holder
// key is the bytes AFTER the prefix. Truncating the id's first 20 bytes yields a
// 40-hex string that passes every format check and matches nothing, silently
// dropping the row's supplied collateral from its top-holding icons — while the same
// row still reports suppliedUsd.
describe('accounts directory money-market holders', () => {
  it('derives row holders with the shared account→H160 derivation', () => {
    const at = explorerService.indexOf('const rowH160s')
    expect(at).toBeGreaterThan(-1)
    const line = explorerService.slice(at, explorerService.indexOf('\n', explorerService.indexOf('\n', at) + 1))

    expect(line).toContain('mmH160ForAccount')
    expect(line).not.toContain('slice(2, 42)')
  })

  it('keeps the derivation itself prefix-aware', () => {
    const at = explorerService.indexOf('function mmH160ForAccount')
    const fn = explorerService.slice(at, explorerService.indexOf('}\n', at))

    expect(fn).toContain('evmFromAccountId')
  })
})
