import { describe, expect, it } from 'vitest'
import {
  parseSubsquareTitle,
  planTitleFetches,
  subsquareReferendumPath,
  subsquareReferendumUrl,
  type ReferendumInventoryRow,
  type StoredTitleRow,
} from '../../src/governance/subsquareTitles.ts'

describe('subsquare referendum urls', () => {
  // Hydration has voted through both pallets and both index from 0 (Democracy
  // 0-206, OpenGov 0-369), so the path — and every key derived from it — has to
  // carry the pallet or the two get cross-labelled.
  it('routes each pallet to its own path', () => {
    expect(subsquareReferendumPath('opengov', 369)).toBe('/referenda/369')
    expect(subsquareReferendumPath('democracy', 206)).toBe('/democracy/referenda/206')
    expect(subsquareReferendumPath('opengov', 0)).not.toBe(subsquareReferendumPath('democracy', 0))
  })

  it('joins a base url without doubling the slash', () => {
    expect(subsquareReferendumUrl('https://hydration.subsquare.io', 'opengov', 1)).toBe('https://hydration.subsquare.io/referenda/1')
    expect(subsquareReferendumUrl('https://hydration.subsquare.io/', 'opengov', 1)).toBe('https://hydration.subsquare.io/referenda/1')
  })
})

describe('parseSubsquareTitle', () => {
  it('reads the page title', () => {
    expect(parseSubsquareTitle('<html><head><title>Authorize runtime upgrade 50</title></head></html>'))
      .toBe('Authorize runtime upgrade 50')
  })

  // SubSquare answers 200 with its own branding for a referendum that does not
  // exist (/referenda/9999 verified live), so a naive parse would store that as
  // ref 9999's name — the same absent-value-looks-real trap that made a missing
  // DCA order render as HDX->HDX.
  it('rejects the generic site title a missing referendum returns', () => {
    expect(parseSubsquareTitle('<title>SubSquare | hydradx governance platform</title>')).toBeNull()
    expect(parseSubsquareTitle('<title>  SubSquare  </title>')).toBeNull()
    expect(parseSubsquareTitle('<title>Hydration governance platform</title>')).toBeNull()
  })

  it('decodes the entities SubSquare emits', () => {
    expect(parseSubsquareTitle('<title>Increase vDOT supply cap &amp; other parameter changes</title>'))
      .toBe('Increase vDOT supply cap & other parameter changes')
    expect(parseSubsquareTitle('<title>Fix &#39;stuck&#39; XCM &lt;-&gt; DOT</title>'))
      .toBe("Fix 'stuck' XCM <-> DOT")
  })

  it('collapses whitespace and survives attributes on the tag', () => {
    expect(parseSubsquareTitle('<title data-rh="true">\n  Tip Request for   DIA Oracle\n</title>'))
      .toBe('Tip Request for DIA Oracle')
  })

  it('returns null when there is no title at all', () => {
    expect(parseSubsquareTitle('<html><body>nope</body></html>')).toBeNull()
    expect(parseSubsquareTitle('<title></title>')).toBeNull()
    expect(parseSubsquareTitle('')).toBeNull()
  })

  it('bounds an absurdly long title', () => {
    expect(parseSubsquareTitle(`<title>${'x'.repeat(500)}</title>`)).toHaveLength(300)
  })
})

describe('planTitleFetches', () => {
  const inventory: ReferendumInventoryRow[] = [
    { pallet: 'opengov', refIndex: 369, concluded: false },
    { pallet: 'opengov', refIndex: 368, concluded: true },
    { pallet: 'opengov', refIndex: 367, concluded: true },
    { pallet: 'democracy', refIndex: 206, concluded: true },
  ]
  const HOUR = 3_600_000
  const now = 1_000 * HOUR
  const opts = { nowMs: now, liveRefreshMs: 30 * 60_000, maxFetches: 10 }

  const stored = (rows: Partial<StoredTitleRow>[]): StoredTitleRow[] =>
    rows.map(row => ({ pallet: 'opengov', refIndex: 0, title: 'a title', fetchedAtMs: now, ...row }) as StoredTitleRow)

  it('fetches everything it has never seen, newest first', () => {
    expect(planTitleFetches(inventory, [], opts)).toEqual([
      { pallet: 'opengov', refIndex: 369, reason: 'missing' },
      { pallet: 'opengov', refIndex: 368, reason: 'missing' },
      { pallet: 'opengov', refIndex: 367, reason: 'missing' },
      { pallet: 'democracy', refIndex: 206, reason: 'missing' },
    ])
  })

  // This is the whole point of the policy: a settled referendum's title is frozen,
  // so 576 of them must never be requested again.
  it('never re-fetches a concluded referendum that already has a title', () => {
    const held = stored([
      { refIndex: 368, fetchedAtMs: now - 500 * HOUR },
      { refIndex: 367, fetchedAtMs: now - 500 * HOUR },
      { pallet: 'democracy', refIndex: 206, fetchedAtMs: now - 500 * HOUR },
    ])

    expect(planTitleFetches(inventory, held, opts)).toEqual([{ pallet: 'opengov', refIndex: 369, reason: 'missing' }])
  })

  it('re-fetches a live referendum once its title goes stale', () => {
    const fresh = stored([{ refIndex: 369, fetchedAtMs: now - 60_000 }])
    const stale = stored([{ refIndex: 369, fetchedAtMs: now - 31 * 60_000 }])
    const settled = stored([
      { refIndex: 368, fetchedAtMs: now - 500 * HOUR },
      { refIndex: 367, fetchedAtMs: now - 500 * HOUR },
      { pallet: 'democracy', refIndex: 206, fetchedAtMs: now - 500 * HOUR },
    ])

    expect(planTitleFetches(inventory, [...fresh, ...settled], opts)).toEqual([])
    expect(planTitleFetches(inventory, [...stale, ...settled], opts))
      .toEqual([{ pallet: 'opengov', refIndex: 369, reason: 'live-refresh' }])
  })

  it('treats a stored-but-empty title as missing', () => {
    const held = stored([{ refIndex: 368, title: '', fetchedAtMs: now }])

    expect(planTitleFetches(inventory, held, opts).some(t => t.refIndex === 368 && t.reason === 'missing')).toBe(true)
  })

  it('caps a cycle so a cold start spreads out instead of bursting', () => {
    const many: ReferendumInventoryRow[] = Array.from({ length: 400 }, (_, i) => ({ pallet: 'opengov', refIndex: i, concluded: true }))

    const plan = planTitleFetches(many, [], { ...opts, maxFetches: 40 })

    expect(plan).toHaveLength(40)
    expect(plan[0].refIndex).toBe(399)
    expect(plan.at(-1)!.refIndex).toBe(360)
  })

  // A live refresh is the only fetch whose stored value can be WRONG, so it must
  // not be starved behind a long backfill queue.
  it('puts live refreshes ahead of backfill', () => {
    const held = stored([{ refIndex: 369, fetchedAtMs: now - 10 * HOUR }])

    const plan = planTitleFetches(inventory, held, { ...opts, maxFetches: 2 })

    expect(plan[0]).toEqual({ pallet: 'opengov', refIndex: 369, reason: 'live-refresh' })
  })

  it('keys on the pallet, so Democracy 206 and OpenGov 206 are distinct', () => {
    const both: ReferendumInventoryRow[] = [
      { pallet: 'opengov', refIndex: 206, concluded: true },
      { pallet: 'democracy', refIndex: 206, concluded: true },
    ]
    const held = stored([{ pallet: 'democracy', refIndex: 206, fetchedAtMs: now }])

    expect(planTitleFetches(both, held, opts)).toEqual([{ pallet: 'opengov', refIndex: 206, reason: 'missing' }])
  })
})
