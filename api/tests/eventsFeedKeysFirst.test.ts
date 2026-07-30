import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// The body of getRecentEvents, comments dropped, so every count below is of code rather
// than of prose that happens to quote it.
const body = (() => {
  const at = explorerService.indexOf('export async function getRecentEvents')
  expect(at).toBeGreaterThan(-1)
  const end = explorerService.indexOf('\n// trades (swaps)', at)
  expect(end).toBeGreaterThan(at)
  return explorerService.slice(at, end).split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
})()

// A page cut by SQL OFFSET reads every row it skips as well as the ones it returns, and
// raw_events.args_json is ZSTD(6) — the feed's entire weight. At the pager's deepest
// published offset (20,000,000) the payload read costs 22.0M rows / 5.19 GiB / 765 MiB
// peak / 2,478 ms; the same page located on the sort key alone costs 23.3M rows /
// 177 MiB / 56 MiB peak / 79 ms, and the payload then comes back for 25 keys.
describe('the global events feed locates its page before reading the payload', () => {
  it('reads the payload only for the keys the located page named', () => {
    // One projection names the payload; the key pass must not.
    expect(occurrences(body, 'args_json')).toBe(1)
    expect(occurrences(body, 'FROM price_data.raw_events')).toBe(2)
    expect(occurrences(body, '(block_height, event_index) IN (')).toBe(1)
    // OFFSET belongs to the key pass alone: a payload read that carried it would skip
    // the page's own rows a second time.
    expect(occurrences(body, 'OFFSET {offset:UInt32}')).toBe(1)
    expect(occurrences(body, 'LIMIT {limit:UInt32}')).toBe(1)
  })

  it('gives both passes the same order and the same event filter', () => {
    // (block_height, event_index) is raw_events' ORDER BY, so restating it on the
    // payload pass reproduces the key pass's order exactly.
    expect(occurrences(body, 'ORDER BY block_height DESC, event_index DESC')).toBe(2)
    expect(occurrences(body, '${eventFilter}')).toBe(2)
    expect(occurrences(body, "textNameParams('eventName', filters.event)")).toBe(2)
  })

  // raw_events is replayable, so a key can hold more than one stored row. The one-read
  // version counted those duplicates against its LIMIT and let uniqueEventRows collapse
  // them; the two passes have to keep that reading rather than paging on distinct keys.
  it('keeps the duplicate collapse on the rows, not on the located keys', () => {
    expect(occurrences(body, 'uniqueEventRows(rows)')).toBe(1)
    expect(occurrences(body, 'SELECT DISTINCT')).toBe(0)
    expect(body).toContain('const tuples = [...new Set(keys.map(key => `(${key.block_height},${key.event_index})`))]')
  })

  // withFeedWindow decides "the recency window did not hold a full page" from the rows
  // this returns, so an empty key pass has to answer with no rows and let it widen.
  it('lets the feed window widen when the located page is empty', () => {
    expect(occurrences(body, 'if (!keys.length) return []')).toBe(1)
    expect(occurrences(body, 'withFeedWindow(tw, limit, offset + limit,')).toBe(1)
  })
})

// A referral claim's amount is the 256-bit sum of two reward legs. That sum was stated
// twice — once as the SQL the min-value predicate is pushed down as, once as a BigInt add
// over a shipped payload — so the page could filter on a value its rows did not show. The
// projection now returns the same expression the filter uses, which also stops shipping a
// payload whose only other field is `who`.
describe('a referral claim states its amount once', () => {
  const claims = (() => {
    const at = explorerService.indexOf('const referralAmountExpr')
    expect(at).toBeGreaterThan(-1)
    return explorerService.slice(at, explorerService.indexOf('const transferAssetExpr', at))
  })()

  it('projects the filter expression rather than re-adding the legs in TypeScript', () => {
    // Declared once, then reached by exactly two readers: the value filter and the projection.
    expect(occurrences(claims, 'referralAmountExpr')).toBe(3)
    expect(claims).toContain('${referralAmountExpr} AS amount')
    expect(claims).toContain("eventValueFilterSql('0', referralAmountExpr,")
    expect(claims).toContain("JSONExtractString(e.args_json,'who') AS who")
    expect(claims).toContain('amount: r.amount')
    // No payload on the outer projection and no second sum.
    expect(occurrences(claims, 'e.extrinsic_index, e.args_json')).toBe(0)
    expect(occurrences(claims, 'safeJson(r.args_json)')).toBe(0)
    expect(occurrences(claims, 'BigInt(')).toBe(0)
  })

  it('keeps the sum in 256-bit integers, never floats', () => {
    expect(claims).toContain("toString(toUInt256OrZero(JSONExtractString(e.args_json,'referrerRewards')) + toUInt256OrZero(JSONExtractString(e.args_json,'tradeRewards')))")
    expect(occurrences(claims, 'toFloat')).toBe(0)
  })
})
