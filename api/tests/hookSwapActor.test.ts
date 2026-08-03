import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

// A routed swap dispatched from a block hook has neither a `who` on its event
// (Router.Executed never carries one) nor an extrinsic to take a signer from, so
// before swap_actor the feeds could name only the DCA ones. Everything else — a
// governance batch run by the Scheduler, an HSM arbitrage — rendered with a blank
// account, including a $90k Treasury swap.

describe('swap_actor — the model behind a hook swap\'s account', () => {
  it('is declared, and replaces on the operation rather than the Broadcast row', () => {
    const table = tables.match(/CREATE TABLE IF NOT EXISTS price_data\.swap_actor \(([^;]+);/)?.[0]
    expect(table).toBeTruthy()
    // One Broadcast row per hop, all naming the same swapper: replacing on the
    // operation collapses them, and makes a replayed range idempotent.
    expect(table).toMatch(/ENGINE = ReplacingMergeTree\(ingested_at\)/)
    expect(table).toMatch(/ORDER BY \(block_height, operation_event_id\)/)
  })

  it('is fed row-wise from the Broadcast event, so it needs no join and no backfill job', () => {
    const mv = views.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS price_data\.swap_actor_mv ([^;]+);/)?.[0]
    expect(mv).toBeTruthy()
    // All three generations of the event carry swapper + operationStack.
    for (const name of ['Broadcast.Swapped', 'Broadcast.Swapped2', 'Broadcast.Swapped3']) {
      expect(mv).toContain(`'${name}'`)
    }
    // Only the Router entry identifies the swap event; Batch/Omnipool/DCA entries
    // would collide across sibling swaps in the same operation.
    expect(mv).toMatch(/JSONExtractString\(x, '__kind'\) = 'Router'/)
    // An actorless row is worse than no row: it would mask the real swapper.
    expect(mv).toMatch(/JSONExtractString\(args_json, 'swapper'\) NOT IN \(''/)
  })

  // Broadcast names a swapper it does not have with a placeholder, most often for
  // an XCM-originated swap with no local origin. Stored, it would render as a
  // perfectly valid-looking SS58 account and assert an actor that does not exist —
  // 180 of the 212 non-DCA hook swaps in indexed history carry one.
  it('drops the placeholder swappers rather than asserting a fake actor', () => {
    const mv = views.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS price_data\.swap_actor_mv ([^;]+);/)?.[0] ?? ''
    expect(mv).toContain("'0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a'")
    expect(mv).toContain("'0x506172656e740000000000000000000000000000000000000000000000000000'")
    // Exactly, never by prefix: 0x2a2afcf3a91dda69… is an ordinary account that
    // merely starts the same way, and two of its swaps are in the model.
    expect(mv).not.toMatch(/swapper[^)]*LIKE '0x2a2a/)
  })
})

describe('attachHookSwapActors — one resolution shared by every surface', () => {
  it('joins on the operation id Router.Executed reports, not on amounts', () => {
    expect(explorerService).toMatch(/a\.operation_event_id = toUInt64\(greatest\(0, JSONExtractInt\(e\.args_json, 'eventId'\)\)\)/)
    // Both sides are primary-key matched.
    expect(explorerService).toMatch(/\(e\.block_height, e\.event_index\) IN \(\$\{tuples\}\)/)
  })

  // Only rows nothing cheaper attributed: a signer, or the DCA execution that
  // claimed the swap. Asking for the rest would be wasted work on every page.
  it('asks only for hook rows that are still actorless', () => {
    const body = explorerService.match(/async function attachHookSwapActors[^]*?\n}/)?.[0] ?? ''
    expect(body).toMatch(/!r\.who && r\.extrinsicIndex == null && r\.eventIndex != null/)
    expect(body).toMatch(/if \(!pending\.length\) return/)
  })

  // Classification has to stay symmetric across surfaces (AGENTS.md), so the swap
  // detail, the trade feed, the asset feed and the block page all run the same pass.
  it('runs on every surface that renders a swap', () => {
    expect(explorerService.match(/await attachHookSwapActors\(/g)).toHaveLength(4)
  })
})

// An extrinsic's swap events are collected together, then split into their routes. A
// hook swap has no extrinsic, so its own event is its identity: the Treasury has put
// six separate swaps in one block, and collecting them under a shared null rendered —
// and counted — exactly one of them.
describe('swap events are collected per extrinsic, hook swaps per event', () => {
  // Extrinsic indices are non-negative, so the negative space a hook row uses can
  // never collide with a real extrinsic in the same block.
  it('cannot collide a hook swap with an extrinsic', () => {
    const key = (extrinsicIndex: number | null, eventIndex: number) => extrinsicIndex ?? -eventIndex - 1
    const hookKeys = [17, 59, 82, 114, 146, 183].map(ev => key(null, ev))
    const extrinsicKeys = [0, 1, 2, 3].map(xi => key(xi, 0))
    expect(new Set([...hookKeys, ...extrinsicKeys]).size).toBe(hookKeys.length + extrinsicKeys.length)
  })

  it('is the collection key the SQL uses, in the page read and its count arm alike', () => {
    expect(explorerService).toMatch(/const SWAP_GROUP_KEY_SQL = 'ifNull\(toInt64\(extrinsic_index\), -toInt64\(event_index\) - 1\)'/)
    expect(explorerService.match(/\$\{SWAP_GROUP_KEY_SQL\}/g)?.length).toBeGreaterThanOrEqual(2)
  })

  // The page read and its count arm must arrive at the same trades, or the tab counts
  // rows it will not render. Both split collected events into routes; neither may
  // reduce an extrinsic to a single row before that split. `LIMIT 1 BY` over the
  // collection key is exactly that mistake, and it undercounted a two-route batch by
  // half on the account, tag and asset feeds.
  it('never collapses a collection to one row before its routes are split', () => {
    expect(explorerService).not.toMatch(/LIMIT 1 BY block_height, \$\{SWAP_GROUP_KEY_SQL\}/)
    expect(explorerService).not.toMatch(/LIMIT 1 BY block_height, ifNull\(toString\(extrinsic_index\)/)
  })

  // Every feed that rebuilds trades from swap events goes through the one seam, so a
  // route means the same thing on the account, tag, asset and global surfaces.
  it('builds every feed\'s trade rows from the shared route seam', () => {
    expect(explorerService.match(/swapRouteReps\(/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
