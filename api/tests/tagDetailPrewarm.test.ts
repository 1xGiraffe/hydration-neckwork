import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tagDetailMembershipKey, tagMembershipList } from '../src/services/explorerService.ts'

// The hot-tag detail prewarm skips a tag whose persisted payload a request would
// still accept, instead of rebuilding balances, locks, money market, LP, DCA,
// portfolio history and volume every tick. That skip is only correct while the
// key it compares is byte-identical to the one getTag persists, and it fails
// silently in both directions: a key that never matches rebuilds every tick and
// saves nothing, a key that always matches serves a payload past the age a
// request would tolerate. Nothing at runtime reports either, so it is pinned
// here.

const source = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

const members = [
  '0x6D6F646C70792F74727372790000000000000000000000000000000000000000',
  '0x6d6f646c70792f74727372790862741100000000000000000000000000000000',
]

describe('tag membership keys', () => {
  it('derives the detail key as the model version over the shared member list', () => {
    const list = tagMembershipList(members)
    const key = tagDetailMembershipKey(members)
    // The two forms differ only by the prefix: tag_activity_counts keys on the
    // bare list, tag_detail_snapshots on the same list behind the account-value
    // model version. Reusing the counts form for the detail table is the failure
    // this pins.
    expect(key.endsWith(`|${list}`)).toBe(true)
    expect(key.slice(0, key.indexOf('|'))).toMatch(/^v[123]$/)
    expect(key).not.toBe(list)
  })

  it('is stable under member order and case', () => {
    const key = tagDetailMembershipKey(members)
    expect(tagDetailMembershipKey([...members].reverse())).toBe(key)
    expect(tagDetailMembershipKey(members.map(m => m.toUpperCase()))).toBe(key)
    expect(tagMembershipList(members)).toBe(members.map(m => m.toLowerCase()).sort().join(','))
  })

  it('separates tags that share a prefix of members', () => {
    expect(tagDetailMembershipKey(members)).not.toBe(tagDetailMembershipKey([members[0]]))
  })

  // getTag persists this key and the prewarm compares against it. Both call the
  // one function above, so agreement reduces to the function being pure — and
  // the mistake it forecloses is using the counts form, which never matches.
  it('gives the persisting and comparing sites byte-identical keys', () => {
    const persisted = tagDetailMembershipKey(members)
    const compared = tagDetailMembershipKey(members)
    expect(compared).toBe(persisted)
    expect([...compared]).toEqual([...persisted])
    expect(tagMembershipList(members)).not.toBe(persisted)
  })
})

// Counts are pinned so a new call site cannot quietly shrink these assertions,
// and so a hand-rolled copy of the derivation fails here rather than in
// production.
describe('the membership-key derivation lives in one place', () => {
  it('has exactly one definition of each form', () => {
    expect(source.match(/^export function tagMembershipList\(/gm)).toHaveLength(1)
    expect(source.match(/^export function tagDetailMembershipKey\(/gm)).toHaveLength(1)
  })

  it('is never hand-rolled outside tagMembershipList', () => {
    const joins = [...source.matchAll(/\.map\(member => member\.toLowerCase\(\)\)\.sort\(\)\.join\(','\)/g)]
    expect(joins).toHaveLength(1)
    expect(source.slice(0, joins[0].index).endsWith('export function tagMembershipList(members: string[]): string {\n  return [...members]')).toBe(true)
  })

  it('routes both tag_detail_snapshots readers through the detail form', () => {
    const calls = [...source.matchAll(/tagDetailMembershipKey\(tag(\?)?\.members\)/g)]
    // getTag, which persists the payload, and the prewarm's skip decision.
    expect(calls).toHaveLength(2)
    const getTag = source.indexOf('export async function getTag(')
    const prewarm = source.indexOf('const prewarmDetails =')
    expect(getTag).toBeGreaterThan(-1)
    expect(prewarm).toBeGreaterThan(getTag)
    expect(calls.filter(c => (c.index ?? 0) > getTag && (c.index ?? 0) < prewarm)).toHaveLength(1)
    expect(calls.filter(c => (c.index ?? 0) > prewarm)).toHaveLength(1)
  })

  it('routes the tag_activity_counts sites through the bare form', () => {
    const calls = [...source.matchAll(/tagMembershipList\((members|tag\.members)\)/g)]
    // getTagTabCounts, the counts prewarm, the detail form composing on top, and
    // the library-tag aggregate view's membershipFingerprint — a live,
    // owner-editable membership needs its own cache-scope fingerprint (system tags
    // don't: their membership only changes on a code deploy), and it composes
    // through this same bare form rather than hand-rolling the sort/join again.
    expect(calls).toHaveLength(4)
    const composed = source.indexOf('export function tagDetailMembershipKey(')
    const inside = calls.filter(c => (c.index ?? 0) > composed && (c.index ?? 0) < composed + 160)
    expect(inside).toHaveLength(1)
    expect(calls.length - inside.length).toBe(3)
  })
})

describe('prewarm freshness threshold', () => {
  it('rebuilds two wake intervals before a request stops accepting the payload', () => {
    const interval = /const TAG_DETAIL_PREWARM_INTERVAL_MS = (.+)\n/.exec(source)?.[1]
    const request = /const TAG_DETAIL_REQUEST_MAX_AGE_SECONDS = (.+)\n/.exec(source)?.[1]
    expect(interval).toBe('2 * 60_000')
    expect(request).toBe('10 * 60')
    // Derived, never a second literal, and TWO intervals of headroom: 600 - 240 =
    // 360s. One interval was measured to yield replacement periods of both 480s and
    // 600s, because `age` is whole-second arithmetic over a second-precision column
    // and a rebuild landing a second past the tick grid reads 479 at the fourth tick
    // and 599 at the fifth. At 600s a request stops accepting the payload and pays
    // the reconstruction in the foreground — a path a hot tag could not reach before
    // this guard existed. Two intervals holds the period at 360-480s.
    expect(source).toContain(
      'const TAG_DETAIL_PREWARM_REBUILD_AGE_SECONDS = TAG_DETAIL_REQUEST_MAX_AGE_SECONDS - 2 * (TAG_DETAIL_PREWARM_INTERVAL_MS / 1000)',
    )
    // The old name asserted an age bound the code never enforced.
    expect(source).not.toContain('TAG_DETAIL_SNAPSHOT_MAX_AGE_SECONDS')
  })

  it('applies the two clauses that make a stored payload usable, with its own threshold', () => {
    const at = source.indexOf('async function tagDetailSnapshotServesUntilNextTick(')
    expect(at).toBeGreaterThan(-1)
    const body = source.slice(at, at + source.slice(at).indexOf('\n}\n'))
    expect(body).toContain('membership_key === membershipKey')
    expect(body).toContain('TAG_DETAIL_PREWARM_REBUILD_AGE_SECONDS')
    // Metadata only — the skip decision must not pull the multi-megabyte payload.
    expect(body).not.toContain('payload_json')
    // The serving read keeps the serving bound.
    const serve = source.indexOf('async function loadTagDetailSnapshot(')
    const serveBody = source.slice(serve, serve + source.slice(serve).indexOf('\n}\n'))
    expect(serveBody).toContain('TAG_DETAIL_REQUEST_MAX_AGE_SECONDS')
    expect(serveBody).not.toContain('TAG_DETAIL_PREWARM_REBUILD_AGE_SECONDS')
  })

  it('still refreshes past the cache key that keeps requests off the rebuild', () => {
    const at = source.indexOf('const prewarmDetails =')
    const body = source.slice(at, at + source.slice(at).indexOf('\n  }\n'))
    // Dropping refresh: true would change the cached() key and make foreground
    // requests join the in-flight reconstruction instead of being served the
    // last complete snapshot.
    expect(body).toContain("getTag(tagId, { refresh: true })")
    expect(body).toContain('tagDetailSnapshotServesUntilNextTick')
    expect(body).toContain('continue')
  })
})
