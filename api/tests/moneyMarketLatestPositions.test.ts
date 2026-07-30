import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

const explorerService = read('../src/services/explorerService.ts')
const rawMoneyMarket = read('../../src/raw/moneyMarket.ts')
const tables = read('../../clickhouse/schema/001_tables.sql')
const materializedViews = read('../../clickhouse/schema/003_materialized_views.sql')

const line = (file: string, prefix: string) =>
  file.split('\n').find(candidate => candidate.startsWith(prefix)) ?? ''

const ddl = line(tables, 'CREATE TABLE IF NOT EXISTS price_data.money_market_latest_positions ')
const mv = line(materializedViews, 'CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.money_market_latest_positions_mv ')

// The winning observation used to be re-derived by re-aggregating all of
// raw_money_market_positions every five minutes: 4.65 GiB / 17.8M rows / 3.3 s
// per call, 331 calls and 8,295 ClickHouse CPU-seconds a day, whether or not
// anyone was browsing. money_market_latest_positions resolves the same ordering
// once per insert instead.
describe('money_market_latest_positions schema', () => {
  it('is declared alongside its materialized view', () => {
    expect(ddl).not.toBe('')
    expect(mv).not.toBe('')
  })

  it('merges to one row per holder and market', () => {
    expect(ddl).toContain('ENGINE = AggregatingMergeTree')
    expect(ddl).toContain('ORDER BY (user_address, pool_address)')
  })

  // MM_MARKETS is extensible at runtime through EXPLORER_MM_MARKETS while the
  // schema is static, so a baked-in market list would silently drop a market's
  // positions. Neither configured pool proxy may appear in the view.
  it('does not bake the configured market set into the view', () => {
    for (const pool of ['0x1b02e051683b5cfac5929c25e84adb26ecf87b38', '0x2ce2cfff743cdb6637f4b5d351937a541b8c8923']) {
      expect(mv, pool).not.toContain(pool)
    }
    expect(mv).toContain('GROUP BY user_address, pool_address')
  })

  // THE load-bearing assertion. Eight separate argMax states could each pick a
  // different observation and assemble a row that never existed — row counts,
  // key sets and survivor counts would all still match. One state over one tuple
  // makes that unrepresentable, so the ordering is written exactly once.
  it('resolves all nine values through a single argMax state', () => {
    expect(mv.match(/argMax\w*\(/g)).toEqual(['argMaxState('])
    expect(mv).toContain('argMaxState(tuple(')
    for (const field of [
      'total_collateral_base', 'total_debt_base', 'available_borrows_base',
      'current_liquidation_threshold', 'ltv', 'health_factor',
      'block_height', 'block_timestamp', 'account_id',
    ]) {
      expect(collapse(mv), field).toContain(`${field} `)
    }
  })

  // Every amount round-trips exactly through UInt256 (verified over all 17.9M
  // raw rows on all six columns), and health_factor's no-debt sentinel is
  // 2^256-1, which UInt256 holds exactly. Storing them as text would reintroduce
  // string comparison and reparsing on every read.
  it('stores the six amounts as UInt256', () => {
    for (const field of [
      'total_collateral_base', 'total_debt_base', 'available_borrows_base',
      'current_liquidation_threshold', 'ltv', 'health_factor',
    ]) {
      expect(collapse(ddl), field).toContain(`${field} UInt256`)
      expect(collapse(mv), field).toContain(`toUInt256OrZero(${field})`)
    }
    expect(collapse(ddl)).toContain('block_height UInt32')
    expect(collapse(ddl)).toContain('block_timestamp DateTime')
    expect(collapse(ddl)).toContain('account_id String')
  })

  // account_id is 1:1 with user_address (5,510/5,510) and constant inside every
  // key, so carrying it lets account-keyed readers use the same projection
  // instead of a second model.
  it('carries account_id in the state', () => {
    expect(collapse(mv)).toContain("ifNull(account_id, '')")
  })

  // block_height, then the observation's rank, then ingest time — packed into
  // one UInt128 so the version is a single scalar. observation_id is left out
  // deliberately: no (holder, market, block_height, rank) group holds two of
  // them, so it can never break a tie the first three do not already decide.
  it('packs the tie-break into one UInt128 version without observation_id', () => {
    const packed = collapse(mv)
    expect(packed).toContain('bitShiftLeft(toUInt128(block_height), 64)')
    expect(packed).toContain('), 32)')
    expect(packed).toContain('toUInt128(toUInt32(ingested_at))')
    expect(packed.match(/bitShiftLeft\(/g)).toHaveLength(2)
    expect(packed.match(/toUInt128\(/g)).toHaveLength(3)
    // observation_id appears only inside the rank arm, never as its own component.
    expect(packed.match(/observation_id/g)).toHaveLength(2)
  })

  // The history passes still order rows with moneyMarketPositionOrderSql, so the
  // rank arm now exists in two places. They must stay character-identical or the
  // current-state and history views of the same block could disagree.
  it('ranks observations exactly as the history reader does', () => {
    const rankArm = /if\(startsWith\(observation_id, 'money-market-periodic:'\), toUInt32\(4294967295\), toUInt32OrZero\(arrayElement\(splitByChar\(':', observation_id\), 3\)\)\)/

    const fromView = collapse(mv).match(rankArm)
    // The history reader interpolates the column through `observation`, which is
    // `${prefix}observation_id` — unprefixed here, since only its own subquery
    // aliases the table.
    const fromReader = collapse(explorerService.slice(
      explorerService.indexOf('function moneyMarketPositionOrderSql('),
      explorerService.indexOf('function latestMoneyMarketPositionsSql('),
    )).replaceAll('${observation}', 'observation_id').match(rankArm)

    expect(fromView).toHaveLength(1)
    expect(fromReader).toHaveLength(1)
    expect(fromView?.[0]).toBe(fromReader?.[0])
  })
})

describe('money-market current-state readers', () => {
  // Five current-state readers share one projection query. Pinned so a sixth
  // reader cannot quietly reintroduce a raw re-aggregation, and so removing one
  // is a deliberate edit rather than an assertion that stops asserting.
  it('routes every per-holder current-state read through one projection query', () => {
    expect(explorerService.match(/latestMoneyMarketPositionsSql\(/g)).toHaveLength(6)
    expect(explorerService).toContain('FROM price_data.money_market_latest_positions')
    expect(explorerService.match(/FROM price_data\.money_market_latest_positions/g)).toHaveLength(1)
  })

  // Exactly two raw reads survive, both by necessity: the account-detail
  // fallback picks ONE winner across a whole alias group (not per holder), and
  // the history carry-in prunes on `block_height <` against a block-first key.
  it('leaves only the two reads a per-key projection cannot serve', () => {
    expect(explorerService.match(/FROM price_data\.raw_money_market_positions/g)).toHaveLength(2)
    expect(explorerService.match(/\$\{moneyMarketPositionOrderSql\(\)\}/g)).toHaveLength(11)
  })

  // Fields come out of the state by name, so no reader can pair one
  // observation's collateral with another's health factor.
  it('addresses the winning observation s fields by name', () => {
    expect(explorerService).toContain("return `tupleElement(position, '${field}')`")
    expect(explorerService.match(/mmPositionField\('/g)).toHaveLength(33)
  })
})

// A future observation_id matching neither arm would take toUInt32OrZero's 0 and
// lose every same-block tie. In a request-time query that is recoverable by
// fixing the query; frozen into insert-time state it is corrupt stored data.
describe('observation_id rank coverage', () => {
  const rank = (observationId: string): number | null => {
    if (observationId.startsWith('money-market-periodic:')) return 4294967295
    const third = observationId.split(':')[2]
    return third !== undefined && /^[0-9]+$/.test(third) ? Number(third) : null
  }

  // Every observation_id template the raw writer can emit. Pinned: a new shape
  // added to the writer fails here until it is checked against the rank arms.
  const templates = rawMoneyMarket.match(/`money-market[^`]*`/g) ?? []

  it('finds every observation_id the raw writer builds', () => {
    expect(templates).toHaveLength(3)
    expect(templates).toContain('`money-market:${row.block_height}:${row.event_index}:${userAddress}`')
    expect(templates).toContain('`money-market-periodic:${blockHeight}:${userAddress}`')
    expect(templates).toContain('`money-market-periodic:${market.key}:${blockHeight}:${userAddress}`')
  })

  it('ranks every emitted shape through one of the two arms', () => {
    const substitutions: Record<string, string[]> = {
      '${row.block_height}': ['1', '13346562'],
      '${row.event_index}': ['0', '1955'],
      '${blockHeight}': ['1', '13346562'],
      '${market.key}': ['core', 'gigahdx', 'market1'],
      '${userAddress}': ['0x' + 'ab'.repeat(20)],
    }
    let checked = 0
    for (const template of templates) {
      let shapes = [template.slice(1, -1)]
      for (const [placeholder, values] of Object.entries(substitutions)) {
        shapes = shapes.flatMap(shape => shape.includes(placeholder)
          ? values.map(value => shape.replace(placeholder, value))
          : [shape])
      }
      for (const shape of shapes) {
        expect(shape, shape).not.toContain('${')
        expect(rank(shape), shape).not.toBeNull()
        checked++
      }
    }
    expect(checked).toBe(12)
  })

  // The periodic sentinel must outrank every event index in the same block: a
  // periodic observation is the block's state after all of its events.
  it('lets a periodic observation win its block', () => {
    const periodic = rank('money-market-periodic:gigahdx:13346562:0x00')
    expect(periodic).toBe(4294967295)
    expect(periodic).toBeGreaterThan(rank('money-market:13346562:1955:0x00') as number)
  })

  it('reports a shape neither arm ranks', () => {
    expect(rank('money-market-hourly:gigahdx:0xab:13346562')).toBeNull()
  })
})
