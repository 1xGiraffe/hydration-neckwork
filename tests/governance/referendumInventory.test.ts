import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const snapshot = readFileSync(new URL('../../src/scripts/snapshot-referendum-titles.ts', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// The inventory runs every cycle and only ever needs 580 (pallet, index) pairs, but it used
// to find them by matching the pallet name as a prefix over raw_events — which the
// `set(200)` skip index on event_name cannot prune — and decoding the index out of
// args_json on every row it reached: 1.71 GiB a cycle, 357 GiB over three days.
//
// Each assertion pins how many sites it matched, so a rename cannot leave it asserting
// nothing.
describe('the title fetcher reads its inventory from the referendum projection', () => {
  it('leaves no LIKE-prefix scan and no index decode', () => {
    expect(occurrences(snapshot, `LIKE 'Referenda.%'`)).toBe(0)
    expect(occurrences(snapshot, `LIKE 'Democracy.%'`)).toBe(0)
    expect(occurrences(snapshot, 'JSONExtractInt(args_json')).toBe(0)
    expect(occurrences(snapshot, 'price_data.raw_events')).toBe(0)
  })

  // The projection's rows are grouped per referendum, so a replayed range has to be
  // collapsed before `maxIf` reads it — the same reason the detail page uses FINAL.
  it('reads both pallet arms from the projection, with FINAL', () => {
    expect(occurrences(snapshot, 'price_data.referendum_lifecycle_events AS e FINAL')).toBe(2)
  })

  // `'opengov' AS pallet` shadows the projection's own `pallet` column, so an unqualified
  // `WHERE pallet = 'opengov'` compares the literal to itself and is constantly true. Left
  // unqualified, both arms grouped the whole table and the inventory reported 746 referenda
  // instead of 580, every OpenGov index also appearing under democracy.
  it('qualifies the source columns past the pallet output alias', () => {
    expect(occurrences(snapshot, `WHERE e.pallet = 'opengov'`)).toBe(1)
    expect(occurrences(snapshot, `WHERE e.pallet = 'democracy'`)).toBe(1)
    expect(occurrences(snapshot, 'GROUP BY e.ref_index')).toBe(2)
    expect(occurrences(snapshot, 'e.event_name IN (')).toBe(2)
  })

  // planTitleFetches sorts by index within each reason and JS sort is stable, so the arm
  // order decides which of two same-index referenda is fetched first when maxFetches cuts
  // the plan. Keeping the UNION ALL keeps that tie-break where it was.
  it('keeps the opengov arm ahead of the democracy arm', () => {
    const og = snapshot.indexOf(`WHERE e.pallet = 'opengov'`)
    const dm = snapshot.indexOf(`WHERE e.pallet = 'democracy'`)
    expect(og).toBeGreaterThan(-1)
    expect(dm).toBeGreaterThan(og)
    expect(occurrences(snapshot, 'UNION ALL')).toBe(1)
  })
})
