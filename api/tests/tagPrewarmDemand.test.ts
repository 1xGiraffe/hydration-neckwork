import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tagsStillInDemand } from '../src/services/explorerService.ts'

// The tag-count and tag-detail prewarms rebuild a tag only while a reader is still
// asking for it. Both ways this goes wrong are silent: a set that is never pruned
// rebuilds every tag ever opened every few minutes until the process restarts, and a
// prewarm whose own rebuild counts as a request keeps every tag it touches in demand
// forever — which is the same thing. Neither shows up as an error, so it is pinned.

const source = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const HOUR = 60 * 60_000

function body(signature: string): string {
  const at = source.indexOf(signature)
  expect(at, signature).toBeGreaterThan(-1)
  return source.slice(at, at + source.slice(at).indexOf('\n}\n'))
}

describe('tagsStillInDemand', () => {
  it('keeps a tag for an hour after its last request and drops it after', () => {
    const now = 10 * HOUR
    const demand = new Map([
      ['juicer', now - 5 * 60_000],
      ['treasury', now - HOUR],
      ['xyk-pools', now - HOUR - 1],
      ['omnipool', now - 3 * HOUR],
    ])
    expect([...tagsStillInDemand(demand, now)].sort()).toEqual(['juicer', 'treasury'])
    // Dropped from the map itself, so a lapsed tag is gone until a reader asks again.
    expect([...demand.keys()].sort()).toEqual(['juicer', 'treasury'])
  })

  it('takes a tag back the moment a reader asks for it again', () => {
    const demand = new Map([['xyk-pools', 0]])
    expect(tagsStillInDemand(demand, 2 * HOUR).size).toBe(0)
    demand.set('xyk-pools', 2 * HOUR)
    expect([...tagsStillInDemand(demand, 2 * HOUR + 1)]).toEqual(['xyk-pools'])
  })
})

describe('only a reader records demand', () => {
  it('records detail demand on a full request, never on the prewarm rebuild or the hover card', () => {
    const getTag = body('export async function getTag(')
    expect(getTag).toContain('if (!summary && !refresh) hotTagDetails.set(tagId, Date.now())')
    // The prewarm rebuilds through getTag with refresh: true — that call is what must
    // not count as a request.
    const prewarm = source.slice(source.indexOf('const prewarmDetails ='))
    expect(prewarm.slice(0, prewarm.indexOf('\n  }\n'))).toContain('getTag(tagId, { refresh: true })')
  })

  it('records count demand on the counts request only', () => {
    expect(body('export async function getTagTabCounts(')).toContain('hotTagCounts.set(tagId, Date.now())')
    expect(body('async function prewarmTagTabCountsUncached(')).not.toContain('hotTagCounts.set(')
  })

  it('has no other writer of either demand map', () => {
    expect(source.match(/hotTagDetails\.(set|add)\(/g)).toHaveLength(1)
    expect(source.match(/hotTagCounts\.(set|add)\(/g)).toHaveLength(1)
  })
})

describe('both prewarms read demand through the idle rule', () => {
  it('prunes the counts set before a pass', () => {
    const pass = body('async function prewarmTagTabCountsUncached(')
    expect(pass).toContain('tagsStillInDemand(hotTagCounts, Date.now())')
    expect(pass).not.toContain('hotTagCounts.has(')
  })

  it('prunes the detail set before a pass, keeping only the pinned tags past it', () => {
    const at = source.indexOf('const prewarmDetails =')
    const pass = source.slice(at, at + source.slice(at).indexOf('\n  }\n'))
    expect(pass).toContain('tagsStillInDemand(hotTagDetails, Date.now())')
    expect(pass).not.toMatch(/of hotTagDetails\b/)
  })

  it('ages tags out on the activity prewarm\'s hour', () => {
    expect(source).toContain('const TAG_PREWARM_IDLE_MS = 60 * 60_000')
    expect(source).toContain('const HOT_ACTIVITY_SCOPE_IDLE_MS = 60 * 60_000')
  })
})
