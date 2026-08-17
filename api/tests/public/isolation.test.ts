import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix } from 'node:path'

// The public API is a frozen, versioned contract; the explorer's read models are
// not. This test pins the import allow-list from the design spec
// (docs/superpowers/specs/2026-08-12-public-rest-api-design.md, "Isolation
// rule") so neither surface can start depending on the other by accident.
const API_SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const PUBLIC_DIR = 'public/'

// Shared modules api/src/public/** may import, as paths relative to api/src.
const ALLOWED_SHARED = new Set([
  'db/client.ts',
  'config.ts',
  'types.ts',
  'services/cache.ts',
  'services/explorerAssets.ts',
  'services/ohlcvService.ts',
  'services/poolService.ts',
  'services/volumeService.ts',
  // Venue-neutral valuation/money helpers, moved out of poolVolumes.ts so the
  // revenue read models can share them (the public tree is an import leaf).
  'services/valuation.ts',
  // The canonical per-stream revenue definitions — feesCharts reads the same
  // builders the derivations jobs and the explorer revenue surfaces use, so
  // the public series and the explorer can never drift apart.
  'services/revenueStreams.ts',
])

// Not a shared source module: the api package manifest, imported for the
// version string /rest/service/metadata publishes.
const ALLOWED_NON_MODULE = new Set(['../package.json'])

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

// `from '…'`, `import('…')` and bare side-effect `import '…'` specifiers.
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

// A relative specifier as a path relative to api/src ('db/client.ts',
// 'public/app.ts', '../package.json').
function resolveFromSrc(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

const allFiles = walk(API_SRC)
const publicFiles = allFiles.filter(f => f.startsWith(PUBLIC_DIR))
const otherFiles = allFiles.filter(f => !f.startsWith(PUBLIC_DIR))

describe('public API import isolation', () => {
  it('has public source files to check', () => {
    expect(publicFiles.length).toBeGreaterThan(0)
  })

  it('imports only node builtins, npm packages, its own tree, and the shared allow-list', () => {
    const offenders: string[] = []
    for (const file of publicFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith('node:')) continue
        if (!specifier.startsWith('.')) continue // npm package
        const resolved = resolveFromSrc(file, specifier)
        if (resolved.startsWith(PUBLIC_DIR)) continue
        if (ALLOWED_SHARED.has(resolved) || ALLOWED_NON_MODULE.has(resolved)) continue
        offenders.push(`src/${file} imports '${specifier}' (resolves to src/${resolved})`)
      }
    }
    expect(offenders, `public API may only import the shared allow-list:\n${offenders.join('\n')}`).toEqual([])
  })

  it('is imported by nothing outside itself (tests excepted)', () => {
    const offenders: string[] = []
    for (const file of otherFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolveFromSrc(file, specifier)
        if (!resolved.startsWith(PUBLIC_DIR)) continue
        offenders.push(`src/${file} imports '${specifier}' from the public API`)
      }
    }
    expect(offenders, `the public API is a leaf; nothing outside it may import it:\n${offenders.join('\n')}`).toEqual([])
  })
})
