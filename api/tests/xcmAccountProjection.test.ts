import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const tables = readFileSync(new URL('../../clickhouse/schema/001_tables.sql', import.meta.url), 'utf8')
const views = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// One function's source, ending where the next top-level declaration or comment begins.
function functionBody(name: string): string {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const rest = explorerService.slice(at + 1)
  const next = rest.search(/\n(?:async function |function |export |interface |type |const |\/\/)/)
  expect(next, name).toBeGreaterThan(-1)
  return rest.slice(0, next)
}

// The contiguous `//` block immediately above a top-level function.
function commentAbove(name: string): string {
  const at = explorerService.indexOf(`function ${name}`)
  expect(at, name).toBeGreaterThan(-1)
  const lines = explorerService.slice(0, at).split('\n')
  const out: string[] = []
  for (let i = lines.length - 2; i >= 0 && lines[i].startsWith('//'); i--) out.unshift(lines[i])
  expect(out.length, name).toBeGreaterThan(0)
  return out.join('\n')
}

// The event names of a `const NAME = [...]` array literal in explorerService.ts,
// following one level of spread into another such constant.
function eventNameConstant(name: string): string[] {
  const at = explorerService.indexOf(`const ${name} = [`)
  expect(at, name).toBeGreaterThan(-1)
  const literal = explorerService.slice(at, explorerService.indexOf(']', at) + 1)
  const spread = /\.\.\.([A-Z_]+)/.exec(literal)
  const own = [...literal.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1])
  return spread ? [...eventNameConstant(spread[1]), ...own] : own
}

// `who` is not in xcm_event_activity's sort key at all, so an account-scoped read of it
// cannot prune: the busiest cross-chain account's exact XCM count read 518M rows / 9.79 GiB
// across 149 queries there, and 50M rows / 2.02 GiB across the same 149 once the
// account-scoped arms moved to the account-first sibling — same answer, 10x fewer rows.
//
// Every assertion below also pins HOW MANY sites it found. A bare "does not contain" guard
// passes just as happily when the thing it guards has been renamed out from under it, which
// is how two earlier guards in this repo degraded to asserting nothing.
describe('the account-scoped XCM readers use the account-first projection', () => {
  it('names each XCM table in exactly one place', () => {
    expect(occurrences(explorerService, 'price_data.xcm_event_activity_by_account')).toBe(1)
    expect(occurrences(explorerService, 'price_data.xcm_inbound_walk_events')).toBe(1)
    // The parent's own name, minus the by_account mentions that contain it as a prefix.
    expect(occurrences(explorerService, 'price_data.xcm_event_activity')
      - occurrences(explorerService, 'price_data.xcm_event_activity_by_account')).toBe(1)
  })

  it('routes the account-scoped reads to the account-first table, and only those', () => {
    // One definition + six call sites: the inbound candidate arm, the remote-outbound
    // candidate arm, the remote-outbound withdrawal decode, the NTT arrival candidate
    // arm, and both halves of the executed-send arm (its candidate walk and its
    // withdrawal decode — that arm's candidate IS a Currencies.Withdrawn row, so it is
    // account-first for exactly the reason the others are).
    expect(occurrences(explorerService, 'xcmEventActivityByAccountTable(')).toBe(7)
    for (const site of ['getRecentXcmIn', 'getRecentXcmOutRemote', 'xcmOutRemoteRowsForBlocks', 'getRecentNttIn', 'getRecentXcmExecuted', 'xcmExecutedRowsForBlocks']) {
      expect(functionBody(site), site).toContain('${xcmEventActivityByAccountTable()}')
    }
    // What stays on the parent: the global candidate walks, the outbound reads, the
    // barrier reads (whose payload neither sibling carries), the global arm of the
    // remote-pull withdrawal decode, the pre-migration inherent-context family read
    // (the hook-only walk projection cannot hold those rows), the asset surface, and
    // the NTT arrival candidates' global arm. One definition + nine call sites — the
    // hook-context inbound deposit run moved to the block-first projection below.
    //
    // The executed-send arm's GLOBAL withdrawal half is deliberately not among them.
    // That read names an event family with no asset, which leaves block_height
    // unreachable in this table's key, so it scanned every asset range of
    // Currencies.Withdrawn however few blocks it asked about — 2.00M rows for 46.
    // raw_events is keyed by block_height and answers the same rows from the
    // claimed blocks for 81.7k, with the MV's own extraction inlined.
    expect(occurrences(explorerService, 'xcmEventActivityTable(')).toBe(14)
    expect(functionBody('xcmExecutedRowsForBlocks')).not.toContain('${xcmEventActivityTable()}')
    expect(functionBody('xcmInRowsForBlocks')).not.toContain('xcmEventActivityByAccountTable')
  })

  // None of the three tables is read with FINAL: every consumer folds these rows by their
  // stable (block_height, event_index) identity while decoding, so an un-merged
  // replacement duplicate cannot reach a row, while FINAL would forfeit exactly the
  // primary-key pruning each table exists to provide.
  it('reads none of the three tables with FINAL, and says why at the read site', () => {
    for (const table of ['xcm_event_activity', 'xcm_event_activity_by_account', 'xcm_inbound_walk_events']) {
      expect(occurrences(explorerService, `${table} FINAL`), table).toBe(0)
      expect(occurrences(explorerService, `price_data.${table}\${alias ? \` AS \${alias}\` : ''}\``), table).toBe(1)
    }
    // Stated once for the family, then restated by each sibling for its own key, because
    // what FINAL would forfeit differs per table.
    expect(occurrences(commentAbove('xcmEventActivityTable'), 'Avoid FINAL here')).toBe(1)
    for (const helper of ['xcmEventActivityByAccountTable', 'xcmInboundWalkTable']) {
      expect(occurrences(commentAbove(helper), 'no-FINAL contract'), helper).toBe(1)
    }
  })

  // The account-scoped arms carry the reserved-account exclusion their global twins
  // carry. The decoders drop every module/sovereign beneficiary anyway, so stating it in
  // SQL cannot change a row — but omitting it lets a structural pot walk its whole
  // hook-context history to produce nothing (the Omnipool pallet account's exact XCM
  // count took 124.7s without it and 0.12s with it).
  it('excludes reserved beneficiaries in all four candidate arms', () => {
    expect(occurrences(explorerService, "NOT match(${candidateWho}, '${RESERVED_ACCOUNT_RE.source}')")).toBe(4)
    for (const site of ['getRecentXcmIn', 'getRecentXcmOutRemote']) {
      expect(occurrences(functionBody(site), "NOT match(${candidateWho}"), site).toBe(2)
    }
  })

  // The account-first key IS the pruning, so the account_activity_v3 reference prefilter is
  // gone from both XCM candidate arms. It was never only a granule shrinker there: its own
  // LIMIT counts references that the arm's `extrinsic_index IS NULL` then discards, so a
  // page came back short, the deep walk read that as end-of-data and stopped — silently
  // dropping the busiest account's whole pre-2025 inbound history behind `complete: true`.
  it('drops the reference prefilter from the XCM candidate arms', () => {
    for (const site of ['getRecentXcmIn', 'getRecentXcmOutRemote']) {
      expect(occurrences(functionBody(site), 'accountActivityRefsSql'), site).toBe(0)
    }
    // Still used where the arm and the references agree on their conditions.
    expect(occurrences(explorerService, 'accountActivityRefsSql(')).toBeGreaterThan(3)
  })

  // Both decoders build their rows from extracted columns and never from re-parsed JSON.
  // The credits' who/currency/amount are the projection's own columns; the barrier's
  // success/id/origin are not, so they are extracted in SQL instead — the barrier is read
  // once per block of every XCM page and account feed (164,581 times over two weeks,
  // 20.78 GiB of result bytes) and half its payload is a `weightUsed` nothing reads.
  it('decodes credits and barriers from extracted fields, not args_json', () => {
    const sites = [
      { site: 'xcmInRowsForBlocks', row: 'e', barrier: 'b' },
      { site: 'xcmOutRemoteRowsForBlocks', row: 'w', barrier: 'barrier' },
    ]
    for (const { site, row, barrier } of sites) {
      const body = functionBody(site)
      expect(body, site).toContain('who, asset_id, amount')
      expect(occurrences(body, `safeJson(${row}.args_json)`), site).toBe(0)
      expect(occurrences(body, 'args.currencyId'), site).toBe(0)
      // No decoder ships or parses a payload any more: the barrier read names the shared
      // extracted projection and nothing here touches args_json. The name list covers
      // both runtime eras (XCM_BARRIER_EVENTS), never the new barrier alone.
      expect(occurrences(body, 'event_name IN (${XCM_BARRIER_EVENTS_SQL})'), site).toBe(1)
      expect(occurrences(body, '${XCM_BARRIER_COLUMNS}'), site).toBe(1)
      expect(occurrences(body, 'event_index, args_json'), site).toBe(0)
      expect(occurrences(body, '.args_json'), site).toBe(0)
      expect(occurrences(body, `safeJson(${barrier}.args_json)`), site).toBe(0)
    }
    // The barrier projection states exactly the three fields the decodes read, era-aware:
    // success comes from MessageQueue's `success`, DmpQueue's `outcome.__kind` (only
    // Complete executed) or XcmpQueue's event name; the topic id falls back through the
    // old events' messageId/messageHash — including the oldest XcmpQueue rows whose
    // args are a bare JSON string holding the hash; and the origin is synthesized for
    // the eras whose events never carried one (DMP is from the relay by construction).
    // A barrier that stops naming its outcome stays a barrier rather than being dropped.
    const columns = explorerService.slice(
      explorerService.indexOf('const XCM_BARRIER_COLUMNS'),
      explorerService.indexOf('function xcmOrigin'))
    expect(columns).toContain("event_name = 'DmpQueue.ExecutedDownward', toUInt8(JSONExtractString(args_json,'outcome','__kind') = 'Complete')")
    expect(columns).toContain("event_name = 'XcmpQueue.Fail', toUInt8(0)")
    expect(columns).toContain("JSONHas(args_json,'success'), toUInt8(JSONExtractBool(args_json,'success'))")
    expect(columns).toContain("JSONType(args_json) = 'String', JSONExtractString(args_json)")
    expect(columns).toContain("JSONHas(args_json,'id'), JSONExtractString(args_json,'id')")
    expect(columns).toContain("JSONHas(args_json,'messageId'), JSONExtractString(args_json,'messageId')")
    expect(columns).toContain("JSONExtractString(args_json,'messageHash')) AS message_id")
    expect(columns).toContain("event_name = 'DmpQueue.ExecutedDownward', 'Parent'")
    expect(columns).toContain("event_name IN ('XcmpQueue.Success','XcmpQueue.Fail'), 'SiblingUnknown'")
    expect(columns).toContain("JSONExtractUInt(args_json,'origin','value') AS origin_value")
    expect(occurrences(explorerService, '${XCM_BARRIER_COLUMNS}')).toBe(2)
    // The unidentified-sibling origin renders as a plain "Parachain", never a made-up id.
    const origin = functionBody('xcmOrigin')
    expect(origin).toContain("if (barrier.origin_kind === 'SiblingUnknown') return { fromChain: 'Parachain', fromParachainId: null }")
    // No barrier consumer anywhere still filters on the new-era name alone, and no
    // outbound consumer names the renamed XTokens event without its pre-migration twin.
    expect(occurrences(explorerService, "event_name = 'MessageQueue.Processed'")).toBe(0)
    expect(occurrences(explorerService, "'XTokens.TransferredAssets','PolkadotXcm.Sent'")).toBe(0)
    expect(occurrences(explorerService, "name='XTokens.TransferredAssets'")).toBe(0)
    // Exactly the barrier sites read the era-wide list: the two block decoders + the
    // value-events gate, plus the definition itself.
    expect(occurrences(explorerService, 'XCM_BARRIER_EVENTS_SQL')).toBe(4)
  })

  // The inbound deposit run is the one read that has to see a block's WHOLE run, so it can
  // be neither account-scoped nor prefiltered. It reads the block-first projection, where
  // those blocks are a primary-key lookup instead of eight whole event-name slices:
  // replaying one cold count's 59 chunk reads gives 45.5M rows / 2.71 GiB / 754 ms on the
  // parent against 13.4M rows / 964.6 MiB / 382 ms here, for the same 279,336 rows out.
  it('reads the inbound deposit run from the block-first projection, and nothing else does', () => {
    // One definition + one call site, and the call site is inside the inbound decoder.
    expect(occurrences(explorerService, 'xcmInboundWalkTable(')).toBe(2)
    const body = functionBody('xcmInRowsForBlocks')
    expect(occurrences(body, '${xcmInboundWalkTable()}')).toBe(1)
    // Two family reads, one per execution context: the hook-context run from the walk
    // projection, and the pre-migration inherent-context run from the parent (the walk
    // projection is hook-only by its own filter, so the old rows can never be there).
    expect(occurrences(body, '${sqlEventNameList(XCM_IN_WALK_EVENTS)}')).toBe(2)
    // The decoder's parent reads: the barrier (kept on the parent for its payload) and
    // the inherent-context family slice.
    expect(occurrences(body, '${xcmEventActivityTable()}')).toBe(2)
    // Context is stated era-aware: the barrier accepts the old events' inherent context
    // (XCM_BARRIER_CONTEXT_SQL), the old family read is inherent-only, and the
    // crossable-index read relaxes hook-only for pre-migration blocks. Pairing then
    // requires each leg to share its barrier's own context, so a run can never cross
    // execution contexts in either era.
    expect(occurrences(body, '${XCM_BARRIER_CONTEXT_SQL}')).toBe(1)
    expect(occurrences(body, 'AND extrinsic_index IS NOT NULL')).toBe(1)
    expect(occurrences(body, '(extrinsic_index IS NULL OR block_height < ${MESSAGE_QUEUE_MIGRATION_BLOCK})')).toBe(1)
    expect(occurrences(body, 'e.ext === bExt')).toBe(1)
    expect(occurrences(body, 'c === bExt')).toBe(1)
    expect(occurrences(body, '${sqlEventNameList(XCM_WALK_CROSSABLE_EVENTS)}')).toBe(1)
    expect(occurrences(body, 'FROM price_data.raw_events')).toBe(1)
    // Set semantics, so a replay duplicate cannot change which indices are crossable.
    expect(occurrences(body, 'raw_events FINAL')).toBe(0)
  })
})

// raw_xcm_activity is ordered (block_height, source_kind, source_index, name), so the
// outbound page's `block_height DESC, event_index DESC` can never be a readable key order.
// The cost was never the sort: it was decompressing the ZSTD(6) args_json for every
// candidate row before the LIMIT threw it away — 2.15M rows / 755.27 MiB / 306.94 MiB peak
// to return one 25,000-row page, against 100.02 MiB / 44.51 MiB peak once the page's keys
// are resolved first, for byte-identical JSON.
//
// Every assertion below also pins HOW MANY sites it found, so a rename cannot quietly
// turn a "does not contain" guard into one that asserts nothing.
describe('the outbound XCM page reads its payload for one page of keys', () => {
  // Comment lines dropped, so every count below is of code rather than of prose that
  // happens to quote it.
  const body = functionBody('getRecentXcm').split('\n').filter(line => !line.trim().startsWith('//')).join('\n')

  it('selects the payload once, and bounds that read by the page keys when unscoped', () => {
    expect(occurrences(body, 'args_json')).toBe(3) // the projection, its row type, the decode
    expect(occurrences(body, 'FROM price_data.raw_xcm_activity')).toBe(3) // payload, keys, legacy pairs
    expect(occurrences(body, '(block_height, event_index) IN (')).toBe(1)
    // The account-scoped page is already key-bounded through the account index, so it
    // keeps the single read rather than resolving the same keys twice.
    expect(occurrences(body, 'const rowBound = acctList\n        ? candidateBound')).toBe(1)
  })

  it('gives both passes one order, one limit and one row predicate', () => {
    expect(occurrences(body, "const pageOrder = 'ORDER BY block_height DESC, event_index DESC LIMIT {limit:UInt32}'")).toBe(1)
    expect(occurrences(body, '${pageOrder}')).toBe(2)
    expect(occurrences(body, 'ORDER BY block_height DESC, event_index DESC')).toBe(1)
    expect(occurrences(body, 'const xcmRows =')).toBe(1)
    expect(occurrences(body, '${xcmRows}')).toBe(2)
    // One page-size parameter for both passes: a key pass with a different limit would
    // hand the payload pass a set that does not cover its own page.
    expect(occurrences(body, 'query_params: { limit: pageLimit }')).toBe(1)
    expect(occurrences(body, '{limit:UInt32}')).toBe(1)
  })

  // The cursor the deep walk pages from is the last returned row's (block, event index),
  // so the payload pass must not be able to return a row the key pass did not choose.
  it('keeps the payload pass on the same rows the key pass selected', () => {
    expect(occurrences(body, "source_kind='event'")).toBe(2) // xcmRows, and the legacy-pairs read
    expect(occurrences(body, 'AND ${xcmRows}`')).toBe(1)
    expect(occurrences(body, 'eventIndex: last.event_index')).toBe(1)
    expect(occurrences(body, 'row => row.eventIndex ?? -1')).toBe(1)
  })
})

describe('the three XCM materialized views cannot drift apart', () => {
  function mvStatement(name: string): string {
    const marker = `CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `
    const at = views.indexOf(marker)
    expect(at, name).toBeGreaterThan(-1)
    const end = views.indexOf(';', at)
    expect(end, name).toBeGreaterThan(at)
    return views.slice(at, end)
  }

  // Split a SELECT projection on its top-level commas (the asset_id expression nests
  // multiIf/JSONHas calls whose own commas must not split it).
  function projectionExpressions(list: string): string[] {
    const out: string[] = []
    let depth = 0
    let quoted = false
    let start = 0
    for (let i = 0; i < list.length; i++) {
      const ch = list[i]
      if (ch === "'") quoted = !quoted
      else if (!quoted && ch === '(') depth++
      else if (!quoted && ch === ')') depth--
      else if (!quoted && ch === ',' && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1 }
    }
    out.push(list.slice(start).trim())
    return out
  }

  const SOURCE = ' FROM price_data.raw_events WHERE '
  function selectAndWhere(name: string): { select: string[]; where: string } {
    const stmt = mvStatement(name)
    const asAt = stmt.indexOf(' AS SELECT ')
    expect(asAt, name).toBeGreaterThan(-1)
    const body = stmt.slice(asAt + ' AS SELECT '.length)
    const fromAt = body.indexOf(SOURCE)
    expect(fromAt, name).toBeGreaterThan(-1)
    return { select: projectionExpressions(body.slice(0, fromAt)), where: body.slice(fromAt + SOURCE.length) }
  }

  it('declares each view exactly once, all of them sourced from raw_events', () => {
    for (const name of ['xcm_event_activity_mv', 'xcm_event_activity_by_account_mv', 'xcm_inbound_walk_events_mv']) {
      expect(occurrences(views, `price_data.${name}`), name).toBe(1)
      expect(mvStatement(name), name).toContain(SOURCE)
    }
  })

  it('filters the same raw events, byte for byte', () => {
    const parent = selectAndWhere('xcm_event_activity_mv')
    const child = selectAndWhere('xcm_event_activity_by_account_mv')
    expect(child.where).toBe(parent.where)
    expect(occurrences(parent.where, "'")).toBe(32) // sixteen event names
    // Both runtime eras' barriers and sends, so pre-MessageQueue (block 5,433,625)
    // cross-chain history exists in the read model at all.
    for (const name of ['DmpQueue.ExecutedDownward', 'XcmpQueue.Success', 'XcmpQueue.Fail', 'XTokens.TransferredMultiAssets']) {
      expect(parent.where).toContain(`'${name}'`)
    }
  })

  // The sibling projects args_json away and reorders to lead with its sort key; every
  // other expression — the asset_id fallback chain, the who and amount extractions — has
  // to be the parent's, or the two tables would hold different rows for the same event.
  it('extracts every kept column with the parent view expression', () => {
    const parent = selectAndWhere('xcm_event_activity_mv')
    const child = selectAndWhere('xcm_event_activity_by_account_mv')
    expect(parent.select).toHaveLength(10)
    expect(child.select).toHaveLength(9)
    expect([...child.select].sort()).toEqual(parent.select.filter(e => e !== 'args_json').sort())
    expect(child.select[0]).toBe("JSONExtractString(args_json, 'who') AS who")
  })

  // The walk projection is a narrower slice of the same rows, so its filter is the one
  // thing that legitimately differs from the parent's — and it has to be exactly the family
  // the decoder walks. A name added to XCM_IN_WALK_EVENTS and not here would silently
  // shorten runs rather than fail: the walk stops at the first event index it cannot find,
  // so every credit behind the gap would disappear from the feed.
  it('filters the walk projection to exactly the walk family the decoder uses', () => {
    const walk = selectAndWhere('xcm_inbound_walk_events_mv')
    const names = [...walk.where.matchAll(/'([A-Za-z]+\.[A-Za-z]+)'/g)].map(m => m[1])
    expect(names).toHaveLength(8)
    expect(names).toEqual(eventNameConstant('XCM_IN_WALK_EVENTS'))
    // Hook context only, which is what lets the read drop `extrinsic_index IS NULL`.
    expect(walk.where).toBe(`event_name IN (${names.map(n => `'${n}'`).join(', ')}) AND extrinsic_index IS NULL`)
    // A strict subset of the parent's twelve names, so this table can only ever hold rows
    // the parent holds too — which is what makes the set-equality check meaningful.
    const parent = selectAndWhere('xcm_event_activity_mv')
    for (const name of names) expect(parent.where, name).toContain(`'${name}'`)
    expect(occurrences(parent.where, "'")).toBe(32)
  })

  it('extracts the walk projection with the parent view expressions', () => {
    const parent = selectAndWhere('xcm_event_activity_mv')
    const walk = selectAndWhere('xcm_inbound_walk_events_mv')
    // Everything but the payload and extrinsic_index, every expression the parent's.
    expect(walk.select).toHaveLength(8)
    expect([...walk.select].sort())
      .toEqual(parent.select.filter(e => e !== 'args_json' && e !== 'extrinsic_index').sort())
    // Leading with the sort key, so the view writes rows in the target's own order.
    expect(walk.select.slice(0, 2)).toEqual(['block_height', 'event_index'])
  })

  it('keys the walk projection on the block and carries no payload or extrinsic index', () => {
    expect(occurrences(tables, 'price_data.xcm_inbound_walk_events')).toBe(1)
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.xcm_inbound_walk_events (`block_height` UInt32, `event_index` UInt32, `block_timestamp` DateTime, `event_name` LowCardinality(String), `who` String, `asset_id` UInt32, `amount` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (block_height, event_index) SETTINGS index_granularity = 4096;')
  })

  it('keys the sibling on the account and holds no payload', () => {
    expect(occurrences(tables, 'price_data.xcm_event_activity_by_account')).toBe(1)
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `asset_id` UInt32, `amount` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (who, block_height, event_index)')
    // The parent keeps its own key and its payload; the pair is not one table renamed.
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity (`block_height` UInt32')
    expect(tables).toContain('ORDER BY (event_name, asset_id, block_height, event_index)')
  })
})
