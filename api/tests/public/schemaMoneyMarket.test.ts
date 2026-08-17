import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectSchemaFiles, splitSqlStatements } from '../../src/db/schemaBootstrap.ts'

const sql = readFileSync(new URL('../../../clickhouse/schema/007_money_market_history.sql', import.meta.url), 'utf8')
const materializedViews = readFileSync(new URL('../../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
// The splitter keeps each statement's leading comment block, which is where this
// file's rationale lives. Assertions run against the executable SQL alone so a
// word in a comment can neither satisfy nor break one.
const statements = splitSqlStatements(sql).map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())

// Compare SQL modulo the formatting ClickHouse's own SHOW CREATE applies (backtick
// quoting and whitespace), so these assertions survive a schema regeneration.
function noSpace(text: string): string {
  return text.replace(/`/g, '').replace(/\s+/g, '')
}

function statementFor(name: string): string {
  const found = statements.filter(s =>
    s.startsWith(`CREATE TABLE IF NOT EXISTS price_data.${name} `)
    || s.startsWith(`CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `)
    || s.startsWith(`CREATE VIEW IF NOT EXISTS price_data.${name} `))
  expect(found, name).toHaveLength(1)
  return found[0]
}

const RAY = '1000000000000000000000000000'

// 007_money_market_history.sql is the /v1 API's money-market read layer: one MV-fed
// rates projection, and two read-time views for per-reserve supplied/debt. Every
// assertion pins a durable invariant of the declaration — a schema file is applied
// once to an empty database and never migrated, so drift here surfaces only as wrong
// public numbers.
describe('007_money_market_history.sql', () => {
  it('is picked up by schema bootstrap after 006', () => {
    const files = selectSchemaFiles([
      '000_database.sql', '001_tables.sql', '002_views.sql', '003_materialized_views.sql',
      '004_user.sql', '005_contracts.sql', '006_public.sql', '007_money_market_history.sql',
    ])
    expect(files[files.length - 1]).toBe('007_money_market_history.sql')
    expect(files[files.length - 2]).toBe('006_public.sql')
  })

  it('every statement parses through the bootstrap splitter and only creates', () => {
    expect(statements).toHaveLength(4)
    for (const statement of statements) expect(statement.startsWith('CREATE ')).toBe(true)
    // The file is re-applied on every deployment start, so a destructive or additive
    // statement here would wipe or double-count live data. Checked on the executable
    // SQL only — a comment may document a one-time rollout INSERT … SELECT.
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|ALTER|INSERT|TRUNCATE|EXCHANGE)\b/)
    }
  })

  it('declares every object idempotently and the table before its MV', () => {
    for (const name of ['money_market_reserve_rates', 'money_market_reserve_rates_mv',
                        'money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      expect(sql).toMatch(new RegExp(`CREATE (TABLE|MATERIALIZED VIEW|VIEW) IF NOT EXISTS price_data\\.${name}`))
    }
    const table = sql.indexOf('CREATE TABLE IF NOT EXISTS price_data.money_market_reserve_rates ')
    const view = sql.indexOf('CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.money_market_reserve_rates_mv')
    expect(table).toBeGreaterThan(-1)
    expect(view).toBeGreaterThan(table)
  })

  // Replay safety (AGENTS.md): raw ranges are re-insertable, so the projection must
  // replace on the event's natural identity rather than accumulate.
  it('keys the rates projection on a replay-safe natural identity', () => {
    const table = statementFor('money_market_reserve_rates')
    expect(noSpace(table)).toContain(noSpace(
      `ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(block_timestamp)
       ORDER BY (pool_address, reserve_address, block_height, event_index)`))
    expect(table).not.toMatch(/SummingMergeTree|AggregatingMergeTree/)
  })

  it('declares the rate columns as UInt256', () => {
    const table = noSpace(statementFor('money_market_reserve_rates'))
    for (const column of [
      'pool_address String', 'reserve_address String', 'block_height UInt32',
      'event_index UInt32', 'block_timestamp DateTime', 'liquidity_rate UInt256',
      'variable_borrow_rate UInt256', 'ingested_at DateTime',
    ]) expect(table, column).toContain(noSpace(column))
    // RAY-scaled rates routinely exceed 2^64 (1,307,030 of 1,761,062 rows measured on
    // 2026-08-12, up to 28 digits), so a narrower or floating type silently truncates.
    for (const wrong of ['liquidity_rate UInt64', 'liquidity_rate UInt128', 'liquidity_rate Float64',
                         'variable_borrow_rate UInt64', 'variable_borrow_rate Float64']) {
      expect(table, wrong).not.toContain(noSpace(wrong))
    }
  })

  it('extracts the RAY rates as strings, not as 64-bit JSON integers', () => {
    const mv = noSpace(statementFor('money_market_reserve_rates_mv'))
    expect(mv).toContain(noSpace(`toUInt256OrZero(JSONExtractString(metrics_json, 'liquidityRate'))`))
    expect(mv).toContain(noSpace(`toUInt256OrZero(JSONExtractString(metrics_json, 'variableBorrowRate'))`))
    // JSONExtractUInt caps at 2^64 and would truncate most of the table.
    expect(mv).not.toMatch(/JSONExtractUInt\(metrics_json,'liquidityRate'\)/)
    expect(mv).not.toMatch(/JSONExtractUInt\(metrics_json,'variableBorrowRate'\)/)
  })

  it('projects only ReserveDataUpdated rows that name a reserve', () => {
    const mv = statementFor('money_market_reserve_rates_mv')
    expect(mv).toContain(`FROM price_data.raw_money_market_reserves`)
    expect(mv).toContain(`event_name = 'ReserveDataUpdated'`)
    // raw_money_market_reserves carries five other event shapes (facilitator bucket
    // levels alone outnumber the rate updates); none of them carry a rate.
    expect(mv).not.toContain('FacilitatorBucketLevelUpdated')
    expect(mv).not.toContain('IsolationModeTotalDebtUpdated')
    // Both filtered columns are table-qualified: this SELECT aliases a column to
    // reserve_address, and ClickHouse resolves a bare column in WHERE against the
    // SELECT's aliases first, so an unqualified filter can silently mean something else.
    expect(noSpace(mv)).toContain(noSpace(`raw_money_market_reserves.event_name = 'ReserveDataUpdated'`))
    expect(noSpace(mv)).toContain(noSpace(`ifNull(raw_money_market_reserves.reserve_address, '') != ''`))
  })

  it('resolves the pool address exactly as the sibling indices MV does', () => {
    // ReserveDataUpdated leaves pool_address empty on the large majority of rows, so
    // both MVs fall back to contract_address. The two must agree character for
    // character, or the rates and the indices of one reserve key differently and no
    // join between them ever matches.
    const fallback = `lower(if(pool_address = '', contract_address, pool_address)) AS pool_address`
    expect(noSpace(materializedViews), 'money_market_reserve_indices_mv').toContain(noSpace(fallback))
    expect(noSpace(statementFor('money_market_reserve_rates_mv'))).toContain(noSpace(fallback))
  })

  it('carries ingested_at through the MV and never reads with FINAL', () => {
    const mv = statementFor('money_market_reserve_rates_mv')
    expect(mv).toContain('ingested_at')
    // now() as the replacement version would let a replayed range beat the row it
    // replaces on wall-clock order instead of ingest order, defeating deduplication
    // for backward backfill.
    expect(mv).not.toContain('now()')
    // An MV is an insert trigger over the inserted block; deduplication is the
    // destination table's replacement key's job.
    expect(mv).not.toContain('FINAL')
  })

  // Reserve state is deliberately NOT a stored table: the scaled total is a running
  // sum (not row-wise, so no MV) whose base is a node-sourced totalSupply() anchor
  // rather than raw, and indexed EVM-log coverage below that anchor block is
  // incomplete. A table would have to invent the pre-anchor era or accumulate under
  // replay, so the model ships as two read-time views with an explicit coverage floor.
  it('ships reserve state as views, never as an accumulating table', () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS price_data\.money_market_reserve_state/)
    for (const name of ['money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      expect(statementFor(name), name).toMatch(/^CREATE VIEW IF NOT EXISTS/)
      expect(statementFor(name), name).not.toMatch(/SummingMergeTree|AggregatingMergeTree|ENGINE =/)
    }
  })

  it('writes RAY as a string literal in every scaled-to-actual multiply', () => {
    for (const name of ['money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      const view = noSpace(statementFor(name))
      // Each view divides twice — once for supplied, once for debt. Counting the
      // occurrences is what makes this a real guard: toContain alone passes while the
      // OTHER divisor is the Float64 form, which is exactly how a half-converted edit
      // would leave the file.
      const quoted = view.match(new RegExp(`toInt256\\(toUInt256\\('${RAY}'\\)\\)`, 'g')) ?? []
      expect(quoted, `${name} quoted RAY divisors`).toHaveLength(2)
      const bare = view.match(new RegExp(`${RAY}`, 'g')) ?? []
      expect(bare, `${name} total RAY literals`).toHaveLength(2)
      // The bare literal is out of UInt64 range, so ClickHouse parses it as Float64
      // and toInt256 of that is 1000000000013300453828 too large. The wrong divisor
      // is invisible in review: the SQL text reads exactly right.
      expect(view, name).not.toMatch(new RegExp(`[^']${RAY}[^']`))
    }
  })

  it('reconstructs the scaled total from the anchor plus post-anchor deltas only', () => {
    for (const name of ['money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      const view = noSpace(statementFor(name))
      // holder = '' is the totalSupply() anchor row; a holder-keyed row would be one
      // account's balance standing in for the reserve.
      expect(view, name).toContain(noSpace(`FROM price_data.atoken_scaled_anchor WHERE holder = ''`))
      expect(view, name).toContain(noSpace(`(SELECT max(anchor_block) FROM price_data.atoken_scaled_anchor) AS anchor_block`))
      expect(view, name).toContain(noSpace(`block_height > anchor_block`))
      // FINAL is required here, unlike in an MV: summing unmerged duplicates of a
      // replayed raw range double-counts the reserve's supply.
      expect(view, name).toContain(noSpace(`FROM price_data.atoken_scaled_deltas_by_contract FINAL`))
      // The indices resolve by argMax over the table's full replacement key plus its
      // version column, which a replayed duplicate cannot change — so no FINAL there.
      // The history view qualifies those columns because its index branch reads
      // through a subquery it joins to the reserve map.
      const rank = name === 'money_market_reserve_state_history'
        ? `tuple(x.block_height, x.event_index, x.ingested_at)`
        : `tuple(block_height, event_index, ingested_at)`
      expect(view, name).toContain(noSpace(rank))
      expect(view, name).not.toContain(noSpace(`money_market_reserve_indices FINAL`))
    }
  })

  it('bounds the history running sum by end_time but never by start_time', () => {
    const view = statementFor('money_market_reserve_state_history')
    // end_time is pushed into both sources — a delta or an index update after the
    // window must not count toward the window's closing state.
    const endTimes = view.match(/\{end_time:DateTime\}/g) ?? []
    expect(endTimes).toHaveLength(3)
    expect(noSpace(view)).toContain(noSpace(`FROM price_data.atoken_scaled_deltas_by_contract FINAL WHERE (block_height > anchor_block) AND (block_timestamp <= {end_time:DateTime})`))
    expect(noSpace(view)).toContain(noSpace(`FROM price_data.money_market_reserve_indices WHERE (block_height > anchor_block) AND (block_timestamp <= {end_time:DateTime})`))
    // start_time appears exactly once, in the outer filter that runs AFTER the window
    // functions. Pushing it into the sum's input would silently rebase every series to
    // zero at the left edge of the requested window.
    const startTimes = view.match(/\{start_time:DateTime\}/g) ?? []
    expect(startTimes).toHaveLength(1)
    const outer = view.lastIndexOf('FROM running AS r')
    expect(view.indexOf('{start_time:DateTime}')).toBeGreaterThan(outer)
    expect(noSpace(view)).toContain(noSpace(`WHERE (r.bucket_start >= {start_time:DateTime}) AND (r.bucket_start <= {end_time:DateTime})`))
  })

  it('accumulates the history over a per-reserve ordered window', () => {
    const view = noSpace(statementFor('money_market_reserve_state_history'))
    expect(view).toContain(noSpace(
      `WINDOW w AS (PARTITION BY b.pool_address, b.reserve_address ORDER BY b.bucket_start ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`))
    expect(view).toContain(noSpace(`a.supplied_anchor + (sum(b.supplied_delta) OVER w) AS supplied_scaled`))
    expect(view).toContain(noSpace(`a.debt_anchor + (sum(b.debt_delta) OVER w) AS debt_scaled`))
    // A bucket with deltas but no ReserveDataUpdated carries the previous bucket's
    // index forward; taking the bucket's own index would multiply the total by zero.
    expect(view).toContain(noSpace(`argMax(b.liquidity_index, b.bucket_rank) OVER w AS liquidity_index`))
    expect(view).toContain(noSpace(`argMax(b.variable_borrow_index, b.bucket_rank) OVER w AS variable_borrow_index`))
    expect(view).toContain(noSpace(`tuple(toUInt32(0), toUInt32(0), toDateTime(0)) AS index_rank`))
  })

  it('exposes the history grid as caller-chosen buckets', () => {
    const view = statementFor('money_market_reserve_state_history')
    expect(noSpace(view)).toContain(noSpace(`toIntervalSecond({bucket_seconds:UInt32}) AS bucket`))
    expect(noSpace(view)).toContain(noSpace(`toStartOfInterval(d.block_timestamp, bucket) AS bucket_start`))
    expect(noSpace(view)).toContain(noSpace(`toStartOfInterval(x.block_timestamp, bucket) AS bucket_start`))
  })

  it('returns nothing rather than an understated total when the anchor is missing', () => {
    // Proved on a scratch rebuild, not reasoned: with the reserve map populated and
    // atoken_scaled_anchor empty — the partial state an RPC failure leaves, since the
    // map is refreshed every cycle and the anchor only when it is empty — the
    // unguarded views returned 22 reserves with 20 non-zero totals built from post-B0
    // deltas alone. Silently understated supply, not an absent answer.
    for (const name of ['money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      const view = noSpace(statementFor(name))
      const guards = view.match(/FROMprice_data\.atoken_reserve_mapFINALWHEREanchor_block>0/g) ?? []
      expect(guards, `${name} anchor guards`).toHaveLength(2)
    }
    // The history view's index branch does not go through the contract list, so it
    // needs its own gate: read unfiltered it emitted 120 all-zero rows on an empty
    // map, which is the "0 standing in for a value" AGENTS.md forbids.
    const history = noSpace(statementFor('money_market_reserve_state_history'))
    expect(history).toContain(noSpace(`reserves AS (SELECT DISTINCT pool_address, reserve_address FROM contracts)`))
    expect(history).toContain(noSpace(
      `INNER JOIN reserves AS m ON (m.pool_address = x.pool_address) AND (m.reserve_address = x.reserve_address)`))
  })

  it('reports the reserve total, never a holder sum scaled up to it', () => {
    // AGENTS.md's receipt-token rule: total_scaled = Σ holder_scaled + anchor_gap, and
    // the gap (holders the anchor enumeration missed) must stay visible rather than be
    // smeared over known holders. So neither view may read the per-holder tables.
    for (const name of ['money_market_reserve_state_current', 'money_market_reserve_state_history']) {
      expect(statementFor(name), name).not.toContain('atoken_scaled_deltas FINAL')
      expect(statementFor(name), name).not.toContain('money_market_account_value_snapshots')
    }
  })
})
