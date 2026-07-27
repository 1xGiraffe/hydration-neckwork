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
    // The parent's own name, minus the by_account mentions that contain it as a prefix.
    expect(occurrences(explorerService, 'price_data.xcm_event_activity')
      - occurrences(explorerService, 'price_data.xcm_event_activity_by_account')).toBe(1)
  })

  it('routes the three account-scoped reads to the account-first table, and only those', () => {
    // One definition + three call sites: the inbound candidate arm, the remote-outbound
    // candidate arm, and the remote-outbound withdrawal decode.
    expect(occurrences(explorerService, 'xcmEventActivityByAccountTable(')).toBe(4)
    for (const site of ['getRecentXcmIn', 'getRecentXcmOutRemote', 'xcmOutRemoteRowsForBlocks']) {
      expect(functionBody(site), site).toContain('${xcmEventActivityByAccountTable()}')
    }
    // The block-keyed reads stay on the parent: the inbound deposit run needs a whole
    // block (a missing neighbour would end the walk early), the MessageQueue barriers
    // carry the payload the account-first table projects away, and the asset surface is
    // asset-keyed. One definition + nine call sites.
    expect(occurrences(explorerService, 'xcmEventActivityTable(')).toBe(12)
    expect(functionBody('xcmInRowsForBlocks')).not.toContain('xcmEventActivityByAccountTable')
  })

  // Both tables are ReplacingMergeTree and neither is read with FINAL: every consumer
  // folds these rows by their stable (block_height, event_index) identity while decoding,
  // so an un-merged replacement duplicate cannot reach a row, while FINAL would forfeit
  // exactly the primary-key pruning each table exists to provide.
  it('reads neither table with FINAL, and says why at the read site', () => {
    expect(occurrences(explorerService, 'xcm_event_activity FINAL')).toBe(0)
    expect(occurrences(explorerService, 'xcm_event_activity_by_account FINAL')).toBe(0)
    expect(occurrences(explorerService, "price_data.xcm_event_activity${alias ? ` AS ${alias}` : ''}`")).toBe(1)
    expect(occurrences(explorerService, "price_data.xcm_event_activity_by_account${alias ? ` AS ${alias}` : ''}`")).toBe(1)
    const helpers = explorerService.slice(
      explorerService.indexOf('// Every XCM consumer collapses'),
      explorerService.indexOf('function xcmEventActivityByAccountTable'))
      + functionBody('xcmEventActivityByAccountTable')
    expect(occurrences(helpers, 'Avoid FINAL here')).toBe(1)
    expect(occurrences(helpers, 'no-FINAL contract')).toBe(1)
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

  // The account-first key IS the pruning, so the account_activity reference prefilter is
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

  // Both decoders build their rows from the pre-extracted columns, not from re-parsed
  // JSON. The payload survives on exactly one read per decoder — the MessageQueue.Processed
  // barrier, whose success/id/origin are not columns — and on nothing else, so a credit's
  // `who`, currency and amount are decided in one place instead of twice.
  it('decodes credits and withdrawals from columns, not args_json', () => {
    const sites = [
      { site: 'xcmInRowsForBlocks', row: 'e', barrier: 'b' },
      { site: 'xcmOutRemoteRowsForBlocks', row: 'w', barrier: 'barrier' },
    ]
    for (const { site, row, barrier } of sites) {
      const body = functionBody(site)
      expect(body, site).toContain('who, asset_id, amount')
      expect(occurrences(body, `safeJson(${row}.args_json)`), site).toBe(0)
      expect(occurrences(body, 'args.currencyId'), site).toBe(0)
      expect(occurrences(body, 'JSONExtract'), site).toBe(0)
      // Exactly one barrier read; it is the only projection that still selects the
      // payload and the only place the decoder parses it.
      expect(occurrences(body, "event_name = 'MessageQueue.Processed'"), site).toBe(1)
      expect(occurrences(body, 'event_index, args_json'), site).toBe(1)
      expect(occurrences(body, `safeJson(${barrier}.args_json)`), site).toBe(1)
    }
  })
})

describe('the two XCM materialized views cannot drift apart', () => {
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

  it('declares each view exactly once, both sourced from raw_events', () => {
    expect(occurrences(views, 'price_data.xcm_event_activity_mv')).toBe(1)
    expect(occurrences(views, 'price_data.xcm_event_activity_by_account_mv')).toBe(1)
  })

  it('filters the same raw events, byte for byte', () => {
    const parent = selectAndWhere('xcm_event_activity_mv')
    const child = selectAndWhere('xcm_event_activity_by_account_mv')
    expect(child.where).toBe(parent.where)
    expect(occurrences(parent.where, "'")).toBe(24) // twelve event names
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

  it('keys the sibling on the account and holds no payload', () => {
    expect(occurrences(tables, 'price_data.xcm_event_activity_by_account')).toBe(1)
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity_by_account (`who` String, `block_height` UInt32, `event_index` UInt32, `extrinsic_index` Nullable(UInt32), `block_timestamp` DateTime, `event_name` LowCardinality(String), `asset_id` UInt32, `amount` String, `ingested_at` DateTime) ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp) ORDER BY (who, block_height, event_index)')
    // The parent keeps its own key and its payload; the pair is not one table renamed.
    expect(tables).toContain('CREATE TABLE IF NOT EXISTS price_data.xcm_event_activity (`block_height` UInt32')
    expect(tables).toContain('ORDER BY (event_name, asset_id, block_height, event_index)')
  })
})
