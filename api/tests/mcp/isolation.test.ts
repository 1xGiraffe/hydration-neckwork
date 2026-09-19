import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, posix } from 'node:path'
import { isBuiltin } from 'node:module'

// The MCP server is a pure HTTP client over the explorer api: it opens no
// ClickHouse connection, reads no schema, and shares no service. That makes its
// import boundary TOTAL rather than an allow-list — node builtins, npm packages
// and its own tree, nothing else — which is the design's own isolation claim
// (AGENTS.md § MCP server) and
// the reason the private `user_*` surface cannot be reached from here by any
// route: the code that reads it is not importable.
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const API_SRC = join(API_ROOT, 'src/')
const MCP_DIR = 'mcp/'

// Deliberately empty, unlike the public and data trees. Adding an entry here
// means the mcp tree has stopped being a pure HTTP client; say why in the same
// change or do not add it.
const ALLOWED_SHARED = new Set<string>()

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

interface Reference { specifier: string; how: string }

/**
 * Drops comments, keeping string literals intact.
 *
 * Prose is full of sentences that look like `from 'somewhere'`, and a scan that
 * reads them reports imports nobody wrote — which is how a scan gets weakened
 * until it no longer bites.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === quote) { j += 1; break }
        if (quote !== '`' && source[j] === '\n') break
        j += 1
      }
      out += source.slice(i, j)
      i = j
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Every module specifier a file names, by any mechanism that loads code.
 *
 * `require` and `createRequire` are covered as well as `import`: the tree is
 * ESM, so neither should appear at all, and a scan that only reads `import`
 * would let `createRequire(import.meta.url)('../db/client.ts')` through the
 * boundary this test exists to hold.
 */
function moduleReferences(text: string): Reference[] {
  const source = stripComments(text)
  const out: Reference[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch !== "'" && ch !== '"' && ch !== '`') { i += 1; continue }
    // The end of this literal, so prose inside it is never read as code.
    let end = i + 1
    while (end < source.length) {
      if (source[end] === '\\') { end += 2; continue }
      if (source[end] === ch) { end += 1; break }
      if (ch !== '`' && source[end] === '\n') break
      end += 1
    }
    // A literal is a module specifier only where the loader syntax puts one:
    // what precedes it decides, not what it contains. `'…from "never existed"…'`
    // is a sentence in a rendered document, not an import.
    const before = source.slice(Math.max(0, i - 40), i).trimEnd()
    const how = /\bfrom$/.test(before) ? 'import'
      : /\bimport$/.test(before) ? 'bare import'
        : /\bimport\s*\($/.test(before) ? 'dynamic import'
          : /\brequire\s*\($/.test(before) ? 'require'
            : null
    if (how && ch !== '`') out.push({ specifier: source.slice(i + 1, end - 1), how })
    i = end
  }
  return out
}

/** Loader calls whose target is computed, which no static scan can follow. */
function computedLoads(text: string): string[] {
  const source = stripComments(text)
  const out: string[] = []
  const patterns: Array<[RegExp, string]> = [
    // A loader call whose argument is anything other than one complete literal
    // — a concatenation, a variable, a helper — cannot be read here.
    [/\bimport\s*\((?!\s*['"][^'"]*['"]\s*\))/g, 'import() with a computed specifier'],
    [/\brequire\s*\((?!\s*['"][^'"]*['"]\s*\))/g, 'require() with a computed specifier'],
    [/\bcreateRequire\b/g, 'createRequire'],
    [/\bprocess\s*\.\s*binding\b/g, 'process.binding'],
  ]
  for (const [re, what] of patterns) {
    if (re.test(source)) out.push(what)
  }
  return out
}

function resolveFromSrc(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

const allFiles = walk(API_SRC)
const mcpFiles = allFiles.filter(f => f.startsWith(MCP_DIR))
const otherFiles = allFiles.filter(f => !f.startsWith(MCP_DIR))
const packageJson = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declaredPackages = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})])

/** `@scope/name/sub/path` and `name/sub/path` both name the package `…/name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

describe('MCP server import isolation', () => {
  it('has mcp source files to check', () => {
    expect(mcpFiles.length).toBeGreaterThan(0)
  })

  // A scan that reads nothing passes everything, so what it does read is
  // pinned against a file whose imports are known.
  it('reads the imports that are actually there', () => {
    const found = moduleReferences(readFileSync(join(API_SRC, 'mcp/app.ts'), 'utf8')).map(r => r.specifier)
    expect(found).toContain('fastify')
    expect(found).toContain('@fastify/cors')
    expect(found).toContain('./config.ts')
    expect(found).toContain('node:crypto')
  })

  // A bare specifier is only "an npm package" because nothing maps one onto a
  // repository path. If tsconfig ever grows `paths`/`baseUrl`, `db/client.ts`
  // becomes importable from here and the whole-tree rule below stops meaning
  // what it says — so the absence of aliases is part of the contract.
  it('has no path aliases that could turn a bare specifier into a repo import', () => {
    const tsconfig = readFileSync(join(API_ROOT, 'tsconfig.json'), 'utf8')
    // Comments are legal in tsconfig; strip the line ones before parsing.
    const options = (JSON.parse(tsconfig.replace(/^\s*\/\/.*$/gm, '')) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {}
    expect(options.paths, 'a path alias would let the mcp tree import the rest of the api by a bare specifier').toBeUndefined()
    expect(options.baseUrl, 'a baseUrl would let the mcp tree import the rest of the api by a bare specifier').toBeUndefined()
  })

  it('imports only node builtins, declared npm packages and its own tree', () => {
    const offenders: string[] = []
    for (const file of mcpFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const { specifier, how } of moduleReferences(source)) {
        if (specifier.startsWith('node:') || isBuiltin(specifier)) continue
        if (!specifier.startsWith('.')) {
          // A bare specifier must name a package this workspace actually
          // depends on; anything else is a resolution this tree does not own.
          if (!declaredPackages.has(packageName(specifier))) {
            offenders.push(`src/${file} ${how}s '${specifier}', which is not a declared dependency of api/package.json`)
          }
          continue
        }
        const resolved = resolveFromSrc(file, specifier)
        if (resolved.startsWith(MCP_DIR)) continue
        if (ALLOWED_SHARED.has(resolved)) continue
        offenders.push(`src/${file} ${how}s '${specifier}' (resolves to src/${resolved})`)
      }
    }
    expect(offenders, `the MCP server may import nothing outside its own tree:\n${offenders.join('\n')}`).toEqual([])
  })

  it('loads nothing through a specifier this scan cannot read', () => {
    const offenders: string[] = []
    for (const file of mcpFiles) {
      for (const what of computedLoads(readFileSync(join(API_SRC, file), 'utf8'))) {
        offenders.push(`src/${file} uses ${what}`)
      }
    }
    expect(offenders, `a module this scan cannot name is a hole in the boundary it enforces:\n${offenders.join('\n')}`).toEqual([])
  })

  it('is imported by nothing outside itself (tests excepted)', () => {
    const offenders: string[] = []
    for (const file of otherFiles) {
      const source = readFileSync(join(API_SRC, file), 'utf8')
      for (const { specifier, how } of moduleReferences(source)) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolveFromSrc(file, specifier)
        if (!resolved.startsWith(MCP_DIR)) continue
        offenders.push(`src/${file} ${how}s '${specifier}' from the MCP server`)
      }
    }
    expect(offenders, `the MCP server is a leaf; nothing outside it may import it:\n${offenders.join('\n')}`).toEqual([])
  })

  it('catches the shapes the import scan used to miss', () => {
    // Regression cover for the scan itself: each of these reaches outside the
    // tree, and each was invisible to a scan that only read relative `import`.
    const sneaky = [
      "const { query } = require('../db/client.ts')",
      "const load = createRequire(import.meta.url)\nload('../services/explorerService.ts')",
      "await import('../db/' + name)",
      "import { client } from 'db/client.ts'",
    ]
    for (const source of sneaky) {
      const relative = moduleReferences(source).filter(r => r.specifier.startsWith('.'))
      const bare = moduleReferences(source).filter(r => !r.specifier.startsWith('.') && !r.specifier.startsWith('node:'))
      const computed = computedLoads(source)
      const caught = relative.length > 0
        || computed.length > 0
        || bare.some(r => !declaredPackages.has(packageName(r.specifier)))
      expect(caught, `this escape must not pass the scan: ${source}`).toBe(true)
    }
  })
})
