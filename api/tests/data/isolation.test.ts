import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix } from 'node:path'

// The Data API is a versioned, frozen contract like the public API; the
// explorer's read models are not. This pins the import allow-list from the
// concept (~/.g/hydraken-api-concept.md § 2 "Isolation test") so neither
// surface can start depending on the other by accident. Notably absent:
// explorerService, userAuthService, and the whole public/ tree.
const API_SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const DATA_DIR = 'data/'

const ALLOWED_SHARED = new Set([
  'db/client.ts',
  'config.ts',
  'types.ts',
  'services/cache.ts',
  'services/explorerAssets.ts',
  'services/valuation.ts',
  'services/lpMath.ts',
  // The price limit an ICE intent states, both directions, from the raw integer
  // amounts. A leaf (no imports at all); shared so the explorer, this surface and
  // the other API cannot quote one order's limit two ways.
  'services/intentLimitPrice.ts',
  // The candle reader, so which view answers a bucket — and the decimal quoting
  // that keeps a Decimal(38,12) out of a double — is stated once for every surface
  // that serves candles. A local copy is how `1M` (monthly) and the `*min` family
  // come to mean different tables on different routes.
  'services/ohlcvService.ts',
  // The concentrated-liquidity position reader (pure math + its own SQL over the
  // uniswap_v3_* projection); a leaf like lpMath — it imports only the client type.
  'services/uniswapV3Positions.ts',
  // The same pool's range book (active liquidity, tick table, segments): one
  // definition shared by the explorer, the public API and this one. Also a leaf.
  'services/uniswapV3Ranges.ts',
])

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel))
    else if (entry.endsWith('.ts')) out.push(rel)
  }
  return out
}

function importSpecifiers(source: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]
  for (const re of patterns) {
    for (const match of source.matchAll(re)) out.push(match[1])
  }
  return out
}

function resolveFromSrc(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

const allFiles = walk(API_SRC)
const dataFiles = allFiles.filter(f => f.startsWith(DATA_DIR))
const otherFiles = allFiles.filter(f => !f.startsWith(DATA_DIR))

describe('data API import isolation', () => {
  it('has data source files to check', () => {
    expect(dataFiles.length).toBeGreaterThan(0)
  })

  it('imports only node builtins, npm packages, its own tree, and the shared allow-list', () => {
    const offenders: string[] = []
    for (const file of dataFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('node:')) continue
        if (!specifier.startsWith('.')) continue // npm package
        const resolved = resolveFromSrc(file, specifier)
        if (resolved.startsWith(DATA_DIR)) continue
        if (ALLOWED_SHARED.has(resolved)) continue
        offenders.push(`src/${file} imports '${specifier}' (resolves to src/${resolved})`)
      }
    }
    expect(offenders, `data API may only import the shared allow-list:\n${offenders.join('\n')}`).toEqual([])
  })

  it('is imported by nothing outside itself (tests excepted)', () => {
    const offenders: string[] = []
    for (const file of otherFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolveFromSrc(file, specifier)
        if (!resolved.startsWith(DATA_DIR)) continue
        offenders.push(`src/${file} imports '${specifier}' from the data API`)
      }
    }
    expect(offenders, `the data API is a leaf; nothing outside it may import it:\n${offenders.join('\n')}`).toEqual([])
  })
})
