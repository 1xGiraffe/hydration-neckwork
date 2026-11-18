import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUBJECT_LABELS, subsquarePathTarget } from '../../src/governance/subsquare/explorerPaths'
import { SUBJECT_ROUTES, forumPostPath } from '../src/governanceSubjects'
import { parseRoute } from '../src/router'

// The Subsquare sync rewrites links to Subsquare's Hydration pages to explorer paths
// (src/governance/subsquare/explorerPaths.ts, outside this package: the sync image
// cannot import the UI). Pinned here against the three places the explorer itself
// maps the same paths, so the four never disagree: the router's legacy redirects,
// nginx's 301s, and the subject routes every forum post id resolves through.

const HASH = '0x0efd368890dc84b19d4a7eb5c09724a7e03e14b4123653ef9be67df0b8dfdc05'
const ADDR = '7KTFfPoa44KxwZsa5N3syqxoSPddApcioLEMUEjYY8cohVos'

describe('Subsquare paths the router redirects', () => {
  it.each([
    '/referenda/12', '/referenda/0', '/referenda/tracks/3', '/referenda', '/posts/45', '/posts', '/democracy/referenda/18',
    '/democracy/proposals/4', '/council/motions/132', '/treasury/proposals/9', '/treasury/spends/0',
    `/democracy/externals/6820789_${HASH}`, `/democracy/externals/6820789_${HASH.toUpperCase().replace('0X', '0x')}`, '/democracy/externals',
    `/treasury/tips/6327088_${HASH}`, '/treasury/tips', '/treasury/tips/12', '/techcomm/proposals/7', `/techcomm/proposals/6327088_${HASH}`,
    '/techcomm', '/tech-comm/motions/3', '/council', '/democracy', `/user/${ADDR}`, `/user/${ADDR}/votes`, `/user/0x${'ab'.repeat(20)}`,
  ])('%s: the sync maps it where the router redirects it', path => {
    const route = parseRoute(path)
    expect(route.name).toBe('legacy')
    expect(subsquarePathTarget(path).path).toBe(route.name === 'legacy' ? route.to : null)
  })
})

describe('Subsquare paths nginx answers with a 301', () => {
  const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
  // A regex holding `{n}` is quoted in nginx; each capture group is filled with a
  // sample of what it matches, in order, and `$n` in the target with the same value.
  const rules = [...conf.matchAll(/location\s+(=|~)\s+("[^"]+"|\S+)\s*\{\s*return 301 ([^;]+);\s*\}/g)]
    .map(m => ({ exact: m[1] === '=', from: m[2].replace(/^"|"$/g, ''), to: m[3] }))
    .filter(r => /^\^?\/(referenda|posts|democracy|council|treasury|calendar|techcomm|user)\b/.test(r.from))
  const SAMPLES: Record<string, (id: string) => string[]> = {
    '([0-9]+)': id => [id],
    '([1-9][0-9]{0,9})': id => [id === '0' ? '7' : id],
    '(0x[0-9a-f]{64})': () => [HASH],
    '([1-9A-HJ-NP-Za-km-z]{40,50}|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})': () => [ADDR, `0x${'ab'.repeat(20)}`],
    '(/[A-Za-z0-9_-]*)?': () => ['', '/votes'],
  }
  function expand(r: { from: string; to: string }, id: string): Array<{ path: string; to: string }> {
    const groups = r.from.match(/\((?:[^()]|\([^()]*\))*\)\??/g) ?? []
    let out = [{ path: r.from.replace(/^\^/, '').replace(/\$$/, ''), to: r.to }]
    groups.forEach((g, i) => {
      const values = SAMPLES[g]?.(id)
      if (!values) throw new Error(`no sample for ${g} in ${r.from}`)
      out = out.flatMap(o => values.map(v => ({ path: o.path.replace(g, v), to: o.to.split(`$${i + 1}`).join(v) })))
    })
    return out
  }

  it('covers the Subsquare block', () => expect(rules.length).toBeGreaterThanOrEqual(13))

  it.each(['12', '0', '450'])('every rule, with id %s, agrees with the sync', id => {
    for (const r of rules) {
      for (const { path, to } of r.exact ? [{ path: r.from, to: r.to }] : expand(r, id)) {
        expect(new RegExp(r.exact ? `^${r.from.replace(/[.?]/g, '\\$&')}$` : r.from).test(path), `${r.from} matches ${path}`).toBe(true)
        expect(subsquarePathTarget(path).path, `${path} (nginx: ${to})`).toBe(to)
      }
    }
  })
})

describe('every record the sync links to is a canonical explorer page', () => {
  const cases: Array<[string, string | null]> = [
    ['/referenda/12', 'opengov:12'],
    ['/posts/45', 's45'],
    ['/democracy/referenda/18', 'democracy:18'],
    ['/democracy/proposals/4', 'democracy_proposal:4'],
    [`/democracy/externals/6820789_${HASH}`, `external:${HASH}@6820789`],
    ['/council/motions/132', 'council:132'],
    ['/techcomm/proposals/7', 'tc:7'],
    ['/treasury/proposals/9', 'treasury:9'],
    ['/treasury/spends/0', 'spend:0'],
    [`/treasury/tips/6327088_${HASH}`, `tip:${HASH}@6327088`],
    [`/user/${ADDR}`, null],
  ]
  it.each(cases)('%s', (path, postId) => {
    const target = subsquarePathTarget(path)
    expect(target.exact).toBe(true)
    const route = parseRoute(target.path!)
    expect(route.name).not.toBe('notfound')
    expect(route.name).not.toBe('legacy')
    // A forum record: the very page its post id resolves to.
    if (postId) expect(target.path).toBe(forumPostPath(postId))
  })

  it('labels each subject as the explorer does', () => {
    for (const [kind, label] of Object.entries(SUBJECT_LABELS)) {
      expect(SUBJECT_ROUTES.find(s => s.kind === kind)?.label, kind).toBe(label)
    }
  })
})
