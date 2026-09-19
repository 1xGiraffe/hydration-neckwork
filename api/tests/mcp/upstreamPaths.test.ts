import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ALLOWED_UPSTREAM_PREFIXES, UpstreamBusyError, UpstreamError, UpstreamPathRefused, createUpstreamClient, isAllowedUpstreamPath, upstreamCostOf } from '../../src/mcp/upstream.ts'
import { toolErrorFromUpstream } from '../../src/mcp/errors.ts'

// The structural guarantee behind the design's privacy claim: the explorer
// api's `/user/*` surface — sessions, lists, notification channels, API tokens,
// everything backed by the `user_*` tables — is unreachable from this server,
// because the client refuses the path before a socket opens. The runtime guard
// is in upstream.ts; these tests pin it and then check the source tree for a
// path that would trip it.
const MCP_SRC = fileURLToPath(new URL('../../src/mcp/', import.meta.url))

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

interface Literal { file: string; value: string }

/** The index just past the string or template literal that starts at `at`. */
function endOfLiteral(source: string, at: number): number {
  const quote = source[at]
  let i = at + 1
  let depth = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') { i += 2; continue }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') { depth += 1; i += 2; continue }
    if (quote === '`' && ch === '}' && depth > 0) { depth -= 1; i += 1; continue }
    if (ch === quote && depth === 0) return i + 1
    if (quote !== '`' && ch === '\n') return i
    i += 1
  }
  return i
}

/**
 * Collects every string/template literal in a TypeScript source, skipping
 * comments. A template contributes its static head (the text before the first
 * `${`) and each static segment after one, which is what a path check needs:
 * `/explorer/address/${a}/activity` yields `/explorer/address/`.
 */
function stringLiterals(file: string, source: string): Literal[] {
  const out: Literal[] = []
  let i = 0
  const push = (value: string) => { out.push({ file, value }) }

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
      i += 1
      let value = ''
      while (i < source.length) {
        const c = source[i]
        if (c === '\\') { value += source[i + 1] ?? ''; i += 2; continue }
        if (c === quote) { i += 1; break }
        // A template's interpolation ends the static segment; scanning resumes
        // in code mode, so the expression is never mistaken for text.
        if (quote === '`' && c === '$' && source[i + 1] === '{') { i += 2; break }
        if (quote !== '`' && c === '\n') { i += 1; break }
        value += c
        i += 1
      }
      push(value)
      continue
    }
    i += 1
  }
  return out
}

/**
 * The source with comments and string contents blanked, so a pattern matches
 * code rather than prose. A template's `${…}` expression stays code, because a
 * call written inside an interpolation is still a call.
 */
function codeOnly(source: string): string {
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
      out += quote
      i += 1
      while (i < source.length) {
        const c = source[i]
        if (c === '\\') { i += 2; continue }
        if (c === quote) { out += quote; i += 1; break }
        if (quote === '`' && c === '$' && source[i + 1] === '{') { out += '${'; i += 2; break }
        if (quote !== '`' && c === '\n') { i += 1; break }
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Every way this tree could open a socket without going through the client. */
const NETWORK_CALLS: Array<[RegExp, string]> = [
  [/(?:^|[^\w.$])(?:globalThis\s*\.\s*)?fetch\s*\(/, 'calls fetch() directly'],
  [/\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b/, 'opens its own transport'],
  [/\b(?:http|https|net|tls|dgram)\s*\.\s*(?:request|get|connect|createConnection)\s*\(/, 'uses a node transport directly'],
]

/** Module specifiers that are a transport, so naming one is the same escape. */
const NETWORK_MODULES = new Set([
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:http2',
  'http', 'https', 'net', 'tls', 'dgram', 'http2',
  'undici', 'axios', 'node-fetch', 'got', 'superagent', 'ws',
])

const files = walk(MCP_SRC)
const literals = files.flatMap(f => stringLiterals(f, readFileSync(join(MCP_SRC, f), 'utf8')))

/** Steps over a balanced generic argument list, e.g. `<Record<string, X>[]>`. */
function skipGenerics(source: string, at: number): number {
  if (source[at] !== '<') return at
  let depth = 0
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '<') depth += 1
    else if (ch === '>') { depth -= 1; if (depth === 0) return i + 1 }
    else if (ch === '(' || ch === ';') return at
  }
  return at
}

/** The source text of the first argument of the call whose `(` is at `open`. */
function firstArgumentText(source: string, open: number): string {
  let depth = 0
  let out = ''
  let i = open
  while (i < source.length) {
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfLiteral(source, i)
      out += source.slice(i, end)
      i = end
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; if (depth > 1) out += ch; i += 1; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; if (depth === 0) break; out += ch; i += 1; continue }
    if (ch === ',' && depth === 1) break
    if (depth >= 1) out += ch
    i += 1
  }
  return out.trim()
}

/**
 * The expressions assigned to a local binding, so a call site that hands
 * `upstream.get` a variable can still be checked. Every branch that writes the
 * name contributes, because any one of them could be the value that travels.
 */
function assignedExpressions(source: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?:^|[^\\w.$])(?:const\\s+|let\\s+|var\\s+)?${name}\\s*(?::[^=\\n]*)?=(?![=>])`, 'g')
  for (const match of source.matchAll(re)) {
    const start = (match.index ?? 0) + match[0].length
    const lines = source.slice(start).split('\n')
    let text = lines[0]
    // A multi-line ternary is the shape these paths are written in, so a
    // continuation line is taken with the assignment it belongs to.
    for (let i = 1; i < lines.length; i += 1) {
      const next = lines[i].trim()
      if (!/[?:+,(&|=]$/.test(text.trimEnd()) && !/^(\?|:|\.|\+|\)|&&|\|\|)/.test(next)) break
      text += `\n${lines[i]}`
    }
    out.push(text)
  }
  return out
}

interface CallSite { file: string; argument: string; heads: string[] | null }

/**
 * Every `upstream.get(...)` call in the tree, with the static path heads its
 * first argument can take.
 *
 * `heads: null` means the argument could not be reduced to literals at all —
 * reported as a failure rather than skipped, because a call site this scan
 * cannot read is exactly where a `/user/` path would hide.
 */
function upstreamCallSites(file: string, source: string): CallSite[] {
  const out: CallSite[] = []
  const re = /upstream\s*\.\s*get\s*/g
  for (const match of source.matchAll(re)) {
    let at = (match.index ?? 0) + match[0].length
    at = skipGenerics(source, at)
    if (source[at] !== '(') continue
    const argument = firstArgumentText(source, at)
    if (argument.length === 0) { out.push({ file, argument, heads: null }); continue }
    if (argument.startsWith("'") || argument.startsWith('"') || argument.startsWith('`')) {
      out.push({ file, argument, heads: stringLiterals(file, argument).slice(0, 1).map(l => l.value) })
      continue
    }
    if (/^[A-Za-z_$][\w$]*$/.test(argument)) {
      const heads = assignedExpressions(source, argument)
        .map(expression => stringLiterals(file, expression).map(l => l.value))
        .flat()
        .filter(value => value.startsWith('/'))
      out.push({ file, argument, heads: heads.length > 0 ? heads : null })
      continue
    }
    out.push({ file, argument, heads: null })
  }
  return out
}

describe('isAllowedUpstreamPath', () => {
  it('accepts the public explorer read surface', () => {
    for (const path of [
      '/health',
      '/assets',
      '/market-stats',
      '/candles',
      '/candles?baseId=5&quoteId=22',
      '/explorer/stats',
      '/explorer/search',
      '/explorer/address/13b6hRRYPHTxFzs9prvL2YGHQepvd4YhdDb9Tc7khySp3hMN/activity',
      '/explorer/referendum/opengov/410',
      '/explorer/pool/v3/0x5c6208a3c316a801f8996750aa7b6f45fc988548',
      // A percent that decodes to a literal `%` — legitimate in a tag name, and
      // the guard must not mistake the failed second decode for an attack.
      '/explorer/tag/100%25',
    ]) {
      expect(isAllowedUpstreamPath(path), path).toBe(true)
    }
  })

  it('refuses the private user surface in every form', () => {
    for (const path of [
      '/user/lists',
      '/user/api-tokens',
      '/explorer/../user/x',
      '/explorer/%2e%2e/user/x',
      '//user/x',
      '/explorer/user/watchlist',
      '/User/Lists',
      '/user',
    ]) {
      expect(isAllowedUpstreamPath(path), path).toBe(false)
    }
  })

  // The shapes a caller reaches for when it is probing a path guard rather than
  // asking a question. Each must be refused on the evidence the guard has
  // before it opens a socket, not on a downstream service's behaviour.
  it('refuses every traversal shape, however it is spelled', () => {
    for (const path of [
      '/explorer/address/..%2F..%2F..%2Fexplorer%2F..%2Fuser%2Ftags',   // encoded slash
      '/explorer/../../user/lists',                                      // plain traversal
      '/explorer/%252e%252e/user/lists',                                 // double-encoded traversal
      '/explorer/%252e%252e/stats',                                      // double-encoded, no /user/
      '/explorer\\..\\user\\lists',                                      // backslash separators
      '/explorer/%5c..%5cuser',                                          // encoded backslash
      '//hydration-neckwork-api:3000/user/lists',                        // protocol-relative
      '/explorer//user/lists',                                           // empty segment
      '/explorer/./../user',                                             // dot segment
      '/EXPLORER/../USER/LISTS',                                         // mixed casing
      '/explorer/address/x/../../user/lists',                            // traversal after a valid head
      'http://hydration-neckwork-api:3000/user/lists',                   // absolute URL
      'https://hydration-neckwork-api:3000/explorer/stats',              // absolute URL, allowed route
      '/explorer/stats?next=/user/lists#/user',                          // private prefix in query/fragment only
    ]) {
      const allowed = isAllowedUpstreamPath(path)
      // The query/fragment case is allowed — it addresses /explorer/stats, and
      // the upstream never routes on either — but it must not reach /user/.
      if (path.includes('?next=')) expect(allowed, path).toBe(true)
      else expect(allowed, path).toBe(false)
    }
  })

  it('refuses anything that is not an origin-relative allowed path', () => {
    for (const path of [
      'explorer/x',
      'http://hydration-neckwork-api:3000/explorer/stats',
      'https://example.invalid/explorer/stats',
      '/v2/contract/0xabc',
      '/explorer',
      '/assetsomething',
      '/healthz',
      '',
      '/',
      '\\explorer\\stats',
    ]) {
      expect(isAllowedUpstreamPath(path), path).toBe(false)
    }
  })

  it('is the client\'s own gate, not advice', async () => {
    const client = createUpstreamClient({
      baseUrl: 'http://upstream.invalid',
      logger: { warn: () => {} },
      fetchImpl: async () => { throw new Error('the client must refuse before it fetches') },
    })
    const err = await client.get('/user/lists').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamPathRefused)
    // The refusal reaches an anonymous caller, so it may not hand out the route
    // map: not the path it refused, not the allow-list, not the existence of a
    // `/user/` surface. The detail belongs in the log, which is why the client
    // takes a logger at all.
    const message = (err as Error).message
    expect(message).not.toMatch(/user/i)
    expect(message).not.toContain('/explorer/')
    expect(message).not.toContain('market-stats')
    expect(toolErrorFromUpstream(err, 'that account').code).toBe('INVALID_ARGUMENT')
    expect(toolErrorFromUpstream(err, 'that account').message).not.toMatch(/user/i)
  })

  it('logs the refused path for the operator', async () => {
    const logged: Array<Record<string, unknown>> = []
    const client = createUpstreamClient({
      baseUrl: 'http://upstream.invalid',
      logger: { warn: details => { logged.push(details) } },
      fetchImpl: async () => { throw new Error('the client must refuse before it fetches') },
    })
    await client.get('/user/lists').catch(() => {})
    expect(logged).toEqual([{ path: '/user/lists' }])
  })

  it('names the allowed prefixes exactly once', () => {
    expect([...ALLOWED_UPSTREAM_PREFIXES]).toEqual(['/explorer/', '/candles', '/assets', '/market-stats', '/health'])
  })
})

describe('the mcp source tree cannot address private data', () => {
  it('has sources to scan', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(literals.length).toBeGreaterThan(0)
  })

  // The real guard. Every path this tree turns into an upstream URL is checked
  // statically here as well as at runtime, so a `/user/` read cannot be
  // introduced even behind a branch a test never executes. A call site whose
  // argument this scan cannot reduce to literals FAILS: silently skipping it is
  // how `const p = '/user/lists'; upstream.get(p)` would pass.
  it('builds every upstream URL from an allowed path', () => {
    const offenders: string[] = []
    let sites = 0
    let checked = 0
    for (const file of files) {
      const source = readFileSync(join(MCP_SRC, file), 'utf8')
      for (const site of upstreamCallSites(file, source)) {
        sites += 1
        if (site.heads === null) {
          offenders.push(`src/mcp/${file}: upstream.get(${site.argument.split('\n')[0]}…) — the path cannot be read statically; build it from a literal in this file`)
          continue
        }
        for (const head of site.heads) {
          checked += 1
          if (!isAllowedUpstreamPath(head)) offenders.push(`src/mcp/${file}: upstream.get(${JSON.stringify(head)}…)`)
        }
      }
    }
    expect(offenders, `every upstream.get() path must start with an allowed prefix, and must be readable from the source:\n${offenders.join('\n')}`).toEqual([])
    // The scan is worthless if it matched nothing: the tools tree holds dozens
    // of call sites, and every one must have contributed at least one path.
    expect(sites).toBeGreaterThan(20)
    expect(checked).toBeGreaterThanOrEqual(sites)
  })

  it('sees the call sites that pass a variable', () => {
    // A guard that only reads literals would report nothing here. These shapes
    // exist in the tools tree — a branch-assigned `let`, a ternary `const`, a
    // module constant — so the scan is pinned against regressing to a regex
    // that quietly skips them.
    const sample = [
      "let path: string\npath = '/explorer/activity'\nupstream.get<Row[]>(path, query, opts)",
      'const path = byHash ? `/explorer/extrinsic/${x}` : `/explorer/extrinsic-at/${h}/${i}`\nupstream.get<Detail>(path)',
      "const ASSETS_PATH = '/explorer/assets'\nctx.upstream.get<Item[]>(ASSETS_PATH, undefined, { ttlMs: 60 })",
    ]
    for (const source of sample) {
      const sites = upstreamCallSites('sample.ts', source)
      expect(sites, source).toHaveLength(1)
      expect(sites[0].heads, source).not.toBeNull()
      for (const head of sites[0].heads!) expect(isAllowedUpstreamPath(head), `${source} -> ${head}`).toBe(true)
    }

    // And the shapes it cannot read must fail rather than pass silently.
    for (const source of [
      "upstream.get(makePath('/user/lists'))",
      'upstream.get(paths[0])',
      'upstream.get(`${base}/user/lists`)',
      "const p = String(x)\nupstream.get(p)",
    ]) {
      const sites = upstreamCallSites('sample.ts', source)
      expect(sites, source).toHaveLength(1)
      const [site] = sites
      const verified = site.heads !== null && site.heads.every(head => isAllowedUpstreamPath(head))
      expect(verified, `this shape must not pass the scan: ${source}`).toBe(false)
    }
  })

  it('contains no literal naming the private user surface', () => {
    const offenders = literals
      // upstream.ts is the guard itself: it names the prefix in order to refuse
      // it, and the unit tests above pin that it does.
      .filter(({ file }) => file !== 'upstream.ts')
      .filter(({ value }) => /\/user(\/|$)/i.test(value))
      .map(({ file, value }) => `src/mcp/${file}: ${JSON.stringify(value)}`)
    expect(offenders, `the /user/ surface is private and must not be named anywhere in the mcp tree:\n${offenders.join('\n')}`).toEqual([])
  })

  // The scan above reads `upstream.get(...)` call sites, and the runtime guard
  // lives inside that client — so both are bypassed by a file that opens a
  // socket itself. `fetch('http://hydration-neckwork-api:3000' + seg)` with the
  // private segment split across two literals passes every other check in this
  // file. Keeping `upstream.ts` the tree's only door to the network is what
  // makes the path allow-list a boundary rather than a convention.
  it('reaches the network only through the guarded client', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === 'upstream.ts') continue
      const source = readFileSync(join(MCP_SRC, file), 'utf8')
      for (const [pattern, what] of NETWORK_CALLS) {
        if (pattern.test(codeOnly(source))) offenders.push(`src/mcp/${file}: ${what}`)
      }
    }
    for (const { file, value } of literals) {
      if (file === 'upstream.ts') continue
      if (NETWORK_MODULES.has(value)) offenders.push(`src/mcp/${file}: names the transport module '${value}'`)
    }
    expect(offenders, `only src/mcp/upstream.ts may reach the network; everything else goes through its path guard:\n${offenders.join('\n')}`).toEqual([])
  })

  it('catches a call that would route around the path guard', () => {
    // The shapes that defeat the literal and call-site scans: a direct fetch,
    // and a transport imported instead of the client.
    expect(NETWORK_CALLS.some(([p]) => p.test(codeOnly("const seg = '/us' + 'er/lists'\nawait fetch(base + seg)")))).toBe(true)
    expect(NETWORK_CALLS.some(([p]) => p.test(codeOnly('await globalThis.fetch(url)')))).toBe(true)
    expect(NETWORK_MODULES.has('node:http')).toBe(true)
    // And the shapes that must not trip it: the word in prose, and the option
    // name the client's own tests pass.
    expect(NETWORK_CALLS.some(([p]) => p.test(codeOnly("// we fetch (over http) the feed\nconst s = 'fetch (the feed)'")))).toBe(false)
    expect(NETWORK_CALLS.some(([p]) => p.test(codeOnly('createUpstreamClient({ fetchImpl })')))).toBe(false)
  })

  it('keeps every explorer path literal inside the allow-list', () => {
    const offenders = literals
      .filter(({ value }) => value.startsWith('/explorer'))
      .filter(({ value }) => !isAllowedUpstreamPath(value))
      .map(({ file, value }) => `src/mcp/${file}: ${JSON.stringify(value)}`)
    expect(offenders, `an /explorer path literal that the client would refuse:\n${offenders.join('\n')}`).toEqual([])
  })
})

// The rest of the upstream boundary: the brakes that keep an agent burst off
// the live explorer, and the 404 split an agent acts on.
describe('upstream client behaviour', () => {
  function countingFetch(body: unknown, status = 200) {
    let calls = 0
    const impl = (async () => {
      calls += 1
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { impl, calls: () => calls }
  }

  // A fetch that hangs for `ms`, so a test can hold permits open.
  function slowFetch(ms: number) {
    let started = 0
    const impl = (async () => {
      started += 1
      await new Promise(resolve => setTimeout(resolve, ms))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    return { impl, started: () => started }
  }

  it('shares one upstream request between concurrent identical reads', async () => {
    const fake = countingFetch({ ok: true })
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: fake.impl })
    const [a, b] = await Promise.all([client.get('/explorer/stats'), client.get('/explorer/stats')])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(fake.calls()).toBe(1)
  })

  it('serves a repeat read from the TTL cache, and skips the cache at ttlMs 0', async () => {
    const cached = countingFetch({ n: 1 })
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', defaultTtlMs: 10_000, fetchImpl: cached.impl })
    await client.get('/explorer/stats')
    await client.get('/explorer/stats')
    expect(cached.calls()).toBe(1)

    const uncached = countingFetch({ n: 2 })
    const live = createUpstreamClient({ baseUrl: 'http://upstream.invalid', defaultTtlMs: 10_000, fetchImpl: uncached.impl })
    await live.get('/explorer/stats', undefined, { ttlMs: 0 })
    await live.get('/explorer/stats', undefined, { ttlMs: 0 })
    expect(uncached.calls()).toBe(2)
  })

  it('never exceeds the configured in-flight bound', async () => {
    let inFlight = 0
    let peak = 0
    const impl = (async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', maxConcurrency: 2, defaultTtlMs: 0, fetchImpl: impl })
    await Promise.all([1, 2, 3, 4, 5, 6].map(n => client.get(`/explorer/block/${n}`)))
    expect(peak).toBeLessThanOrEqual(2)
  })

  // The head-of-line property. Six expensive reads hold every standard permit;
  // a status read must still answer, because an agent asking whether the chain
  // is live gets nothing from an answer that arrives a minute later.
  it('answers a cheap read while the standard lane is saturated', async () => {
    const slow = slowFetch(300)
    const client = createUpstreamClient({
      baseUrl: 'http://upstream.invalid',
      maxConcurrency: 6,
      cheapLaneSlots: 2,
      defaultTtlMs: 0,
      fetchImpl: (async (url: string) => (
        String(url).includes('/explorer/stats')
          ? new Response('{"ok":true}', { status: 200 })
          : await (slow.impl as (u: string) => Promise<Response>)(url)
      )) as unknown as typeof fetch,
    })
    const heavy = [1, 2, 3, 4, 5, 6, 7, 8].map(n => client.get(`/explorer/address/a${n}/activity`))
    await new Promise(resolve => setTimeout(resolve, 20))
    const started = Date.now()
    await expect(client.get('/explorer/stats')).resolves.toEqual({ ok: true })
    expect(Date.now() - started).toBeLessThan(100)
    await Promise.all(heavy)
  })

  it('classifies the cheap lane by path, and lets a call override it', () => {
    expect(upstreamCostOf('/explorer/stats')).toBe('cheap')
    expect(upstreamCostOf('/explorer/blocks')).toBe('cheap')
    expect(upstreamCostOf('/health')).toBe('cheap')
    // An unknown route is standard, so a new heavy call can never take a
    // reserved slot by default.
    expect(upstreamCostOf('/explorer/activity')).toBe('standard')
    expect(upstreamCostOf('/explorer/address/x/history')).toBe('standard')
  })

  // The answer-time property. A queued call is shed with a busy error instead
  // of silently spending someone else's minute in a queue, and never waits past
  // its own budget.
  it('sheds a queued call rather than waiting past its budget', async () => {
    const slow = slowFetch(2_000)
    const client = createUpstreamClient({
      baseUrl: 'http://upstream.invalid',
      maxConcurrency: 2,
      cheapLaneSlots: 0,
      queueTimeoutMs: 5_000,
      defaultTtlMs: 0,
      fetchImpl: slow.impl,
    })
    const holding = [1, 2].map(n => client.get(`/explorer/address/a${n}/activity`))
    await new Promise(resolve => setTimeout(resolve, 20))
    const started = Date.now()
    const err = await client.get('/explorer/address/late/activity', undefined, { timeoutMs: 150 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamBusyError)
    expect(Date.now() - started).toBeLessThan(600)
    expect(toolErrorFromUpstream(err, 'the feed').code).toBe('UPSTREAM_UNAVAILABLE')
    expect(toolErrorFromUpstream(err, 'the feed').message).toMatch(/retry in a few seconds/)
    await Promise.all(holding)
  })

  it('bounds the queue instead of growing it under a burst', async () => {
    const slow = slowFetch(500)
    const client = createUpstreamClient({
      baseUrl: 'http://upstream.invalid',
      maxConcurrency: 2,
      cheapLaneSlots: 0,
      maxQueueDepth: 3,
      queueTimeoutMs: 5_000,
      defaultTtlMs: 0,
      fetchImpl: slow.impl,
    })
    const results = await Promise.allSettled([...Array(12).keys()].map(n => client.get(`/explorer/address/a${n}/activity`)))
    const shed = results.filter(r => r.status === 'rejected' && r.reason instanceof UpstreamBusyError)
    // Two run, three wait, the other seven are refused at once rather than
    // queued behind work that is already oversubscribed.
    expect(shed.length).toBe(7)
    expect(slow.started()).toBe(5)
  })

  it('does not cache a failure', async () => {
    let calls = 0
    const impl = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
    }) as unknown as typeof fetch
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: impl })
    await expect(client.get('/explorer/stats')).rejects.toBeInstanceOf(UpstreamError)
    await expect(client.get('/explorer/stats')).rejects.toBeInstanceOf(UpstreamError)
    expect(calls).toBe(2)
  })

  it('carries the lookup-miss fields off a 404 body', async () => {
    const impl = (async () => new Response(JSON.stringify({ error: 'Block not found', blockIndexed: false, headBound: 14_743_700 }), { status: 404 })) as unknown as typeof fetch
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: impl })
    const err = await client.get('/explorer/block/99999999').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    const miss = err as UpstreamError
    expect(miss.notFound).toBe(true)
    expect(miss.blockIndexed).toBe(false)
    expect(miss.headBound).toBe(14_743_700)
  })

  // Fastify serializes a thrown error as {statusCode, code, error, message},
  // where `error` is only the status text. Reading `error` alone turns an
  // explorer refusal that says exactly what to change into "Service
  // Unavailable", which reads as an outage.
  it('reads the message and the code off a fastify error body', async () => {
    const body = { statusCode: 503, code: 'ACTIVITY_QUERY_TOO_BROAD', error: 'Service Unavailable', message: 'Requested activity page requires too many candidate rows; narrow the filters or date range' }
    const impl = (async () => new Response(JSON.stringify(body), { status: 503 })) as unknown as typeof fetch
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: impl })
    const err = await client.get('/explorer/activity').catch((e: unknown) => e) as UpstreamError
    expect(err.message).toBe(body.message)
    expect(err.upstreamCode).toBe('ACTIVITY_QUERY_TOO_BROAD')

    // A hand-written route sends the sentence in `error` instead.
    const plain = (async () => new Response(JSON.stringify({ error: 'Invalid block height' }), { status: 400 })) as unknown as typeof fetch
    const other = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: plain })
    const err2 = await other.get('/explorer/block/1').catch((e: unknown) => e) as UpstreamError
    expect(err2.message).toBe('Invalid block height')
  })

  it('reports a timeout as a transport failure, not an HTTP status', async () => {
    const impl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    const client = createUpstreamClient({ baseUrl: 'http://upstream.invalid', fetchImpl: impl })
    const err = await client.get('/explorer/stats', undefined, { timeoutMs: 10 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UpstreamError)
    const timedOut = err as UpstreamError
    expect(timedOut.status).toBe(0)
    expect(timedOut.message).toMatch(/timed out/)
  })
})

describe('toolErrorFromUpstream', () => {
  const miss = (path: string, blockIndexed: boolean, headBound?: number) => new UpstreamError(
    'Block not found',
    404,
    { error: 'Block not found', blockIndexed, ...(headBound === undefined ? {} : { headBound }) },
    path,
  )

  it('tells "not indexed yet" from "never existed"', () => {
    expect(toolErrorFromUpstream(miss('/explorer/block/14743705', false, 14_743_700), 'block 14,743,705').code).toBe('NOT_YET_INDEXED')
    expect(toolErrorFromUpstream(miss('/explorer/event/14743669/9999', true, 14_743_700), 'that event').code).toBe('NOT_FOUND')
    const plain = new UpstreamError('Tag not found', 404, { error: 'Tag not found' }, '/explorer/tag/nope')
    expect(toolErrorFromUpstream(plain, 'that tag').code).toBe('NOT_FOUND')
  })

  // "Retry shortly" is only true inside the finality window. A block thousands
  // of heights above the index head is a wrong identifier, and telling an agent
  // to retry sends it into a loop that can never succeed.
  it('scales the retry advice with the distance above the index head', () => {
    const near = toolErrorFromUpstream(miss('/explorer/block/14743705', false, 14_743_700), 'block 14,743,705')
    expect(near.code).toBe('NOT_YET_INDEXED')
    expect(near.message).toMatch(/retry shortly/i)

    // Past finality but still a height the index could reach: still a wait,
    // but the wait is named rather than called "shortly". The figure is the
    // distance at the chain's NOMINAL slot time, 2s — 1,000 blocks is 33
    // minutes, not the 100 a 6s cadence would imply. Naming it here is what
    // catches the mapping drifting off the runtime's real pace.
    const lagging = toolErrorFromUpstream(miss('/explorer/block/14746000', false, 14_745_000), 'block 14,746,000')
    expect(lagging.code).toBe('NOT_YET_INDEXED')
    expect(lagging.message).not.toMatch(/retry shortly/i)
    expect(lagging.message).toMatch(/33 minutes/)

    const far = toolErrorFromUpstream(miss('/explorer/block/99999999', false, 14_746_887), 'block 99,999,999')
    expect(far.code).toBe('NOT_FOUND')
    expect(far.message).not.toMatch(/retry shortly/i)
    expect(far.message).toMatch(/85,253,112 blocks above the index head/)
    expect(far.message).toMatch(/wrong identifier/)

    // The height comes off the path for every coordinate route, and a caller
    // that knows better can say so.
    expect(toolErrorFromUpstream(miss('/explorer/extrinsic/99999999-2', false, 14_746_887), 'that extrinsic').code).toBe('NOT_FOUND')
    expect(toolErrorFromUpstream(miss('/explorer/extrinsic-at/99999999/2/activity', false, 14_746_887), 'that extrinsic').code).toBe('NOT_FOUND')
    expect(toolErrorFromUpstream(miss('/explorer/dca/exec/99999999/2', false, 14_746_887), 'that execution').code).toBe('NOT_FOUND')
    expect(toolErrorFromUpstream(miss('/explorer/tag/whatever', false, 14_746_887), 'that tag', { blockHeight: 99_999_999 }).code).toBe('NOT_FOUND')

    // A number that is not a block height must not be read as one.
    expect(toolErrorFromUpstream(miss('/explorer/referendum/opengov/410', false, 14_746_887), 'that referendum').code).toBe('NOT_YET_INDEXED')
  })

  it('maps transport, client and server failures', () => {
    expect(toolErrorFromUpstream(new UpstreamError('upstream request timed out after 60000ms', 0, null, '/explorer/stats'), 'stats').code).toBe('UPSTREAM_UNAVAILABLE')
    const bad = new UpstreamError('Invalid type; expected all, transfer, trade', 400, { error: 'Invalid type; expected all, transfer, trade' }, '/explorer/activity')
    const mapped = toolErrorFromUpstream(bad, 'the activity feed')
    expect(mapped.code).toBe('INVALID_ARGUMENT')
    expect(mapped.message).toContain('Invalid type')
    expect(toolErrorFromUpstream(new Error('boom'), 'anything').code).toBe('INTERNAL_ERROR')
  })

  // A 503 that says what to change is not an outage: retrying it burns another
  // 34-49s of the shared explorer's capacity and fails the same way.
  it('tells a "narrow your query" refusal from an outage, and passes the message on', () => {
    const tooBroad = new UpstreamError(
      'Requested activity page requires too many candidate rows; narrow the filters or date range',
      503,
      { statusCode: 503, code: 'ACTIVITY_QUERY_TOO_BROAD', error: 'Service Unavailable', message: 'Requested activity page requires too many candidate rows; narrow the filters or date range' },
      '/explorer/activity',
    )
    const refusal = toolErrorFromUpstream(tooBroad, 'the activity feed')
    expect(refusal.code).toBe('TOO_LARGE')
    expect(refusal.message).toContain('too many candidate rows')
    expect(refusal.message).toMatch(/narrow/i)
    expect(refusal.message).not.toMatch(/retry once/)

    const outage = toolErrorFromUpstream(new UpstreamError('upstream responded 502', 502, null, '/explorer/stats'), 'stats')
    expect(outage.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(outage.message).toMatch(/retry once/)
    // The status text alone ("Service Unavailable") is not an answer, so the
    // upstream's own sentence travels with a genuine 5xx too.
    const withMessage = toolErrorFromUpstream(new UpstreamError('index is rebuilding', 503, { message: 'index is rebuilding' }, '/explorer/stats'), 'stats')
    expect(withMessage.message).toContain('index is rebuilding')
  })
})
