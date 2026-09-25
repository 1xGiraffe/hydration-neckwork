import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../src/db/schemaBootstrap.ts'

// Executable SQL only: the splitter keeps each statement's leading comment block.
const statementsOf = (file: string) =>
  splitSqlStatements(readFileSync(new URL(`../../clickhouse/schema/${file}`, import.meta.url), 'utf8'))
    .map(s => s.replace(/^[ \t]*--.*$/gm, '').trim())
const tables = statementsOf('001_tables.sql')
const views = statementsOf('003_materialized_views.sql')

// Compare modulo SHOW CREATE's formatting (backticks, whitespace), so the pins survive a
// schema regeneration. Expected fragments are written in SHOW CREATE's own parenthesization.
const norm = (text: string) => text.replace(/`/g, '').replace(/\s+/g, '')

function one(list: string[], prefix: string): string {
  const found = list.filter(s => s.startsWith(prefix))
  expect(found, prefix).toHaveLength(1)
  return found[0]
}
const mv = (name: string) => one(views, `CREATE MATERIALIZED VIEW IF NOT EXISTS price_data.${name} `)
const table = (name: string) => one(tables, `CREATE TABLE IF NOT EXISTS price_data.${name} `)
const selectOf = (statement: string) => statement.slice(statement.indexOf(' AS WITH ') >= 0 ? statement.indexOf(' AS WITH ') : statement.indexOf(' AS SELECT '))

describe('atoken scaled-delta MVs', () => {
  const holderFirst = mv('atoken_scaled_deltas_mv')
  const contractFirst = mv('atoken_scaled_deltas_by_contract_mv')

  it('derive both projections from one identical SELECT', () => {
    expect(selectOf(holderFirst)).toBe(selectOf(contractFirst))
    expect(holderFirst).toContain('TO price_data.atoken_scaled_deltas ')
    expect(contractFirst).toContain('TO price_data.atoken_scaled_deltas_by_contract ')
  })

  // Aave's _mintScaled/_burnScaled move amount.rayDiv(index) = (amount·RAY + index/2) / index.
  // ClickHouse's intDiv truncates toward zero, so the half-up term goes on the magnitude and
  // the sign is applied after: a Mint whose value is below its balanceIncrease (the interest
  // exceeded the amount burned) has a negative amount and must round away from zero too.
  it('rounds every Mint/Burn amount half-up, on its magnitude', () => {
    for (const statement of [holderFirst, contractFirst]) {
      const s = norm(statement)
      expect(s).toContain(norm("greatest(toInt256(toUInt256OrZero(JSONExtractString(ar, 'index'))), toInt256(1)) AS idx"))
      expect(s).toContain(norm("toInt256(toUInt256('1000000000000000000000000000')) AS ray"))
      expect(s).toContain(norm(
        "event_name = 'Mint', if(amount >= balance_increase, intDiv(((amount - balance_increase) * ray) + intDiv(idx, 2), idx), -intDiv(((balance_increase - amount) * ray) + intDiv(idx, 2), idx))"))
      expect(s).toContain(norm("event_name = 'Burn', -intDiv(((amount + balance_increase) * ray) + intDiv(idx, 2), idx)"))
      // Every intDiv by the index carries the half-up term — a truncating one would drift a
      // unit per event.
      const products = s.split('*ray)').length - 1
      expect(products).toBe(3)
      expect(s.split('*ray)+intDiv(idx,2),idx)').length - 1).toBe(products)
      expect(s).not.toContain('*ray,idx)')
    }
  })

  it('keeps the Mint/Burn/BalanceTransfer conventions (value scaled only on BalanceTransfer)', () => {
    for (const statement of [holderFirst, contractFirst]) {
      const s = norm(statement)
      expect(s).toContain(norm("toInt256(toUInt256OrZero(JSONExtractString(ar, 'value'))) AS amount"))
      expect(s).toContain(norm("toInt256(toUInt256OrZero(JSONExtractString(ar, 'balanceIncrease'))) AS balance_increase"))
      expect(s).toContain(norm("if(event_name = 'BalanceTransfer', -amount, toInt256(0))] AS deltas"))
      expect(s).toContain(norm("WHERE (event_name IN ('Mint', 'Burn', 'BalanceTransfer')) AND (tupleElement(leg, 1) != '')"))
      expect(s).not.toMatch(/GROUP BY/)
    }
  })
})

describe('account_money_market_position_history risk figures', () => {
  const ddl = table('account_money_market_position_history')
  const view = mv('account_money_market_position_history_mv')

  it('carries every getUserAccountData figure verbatim as the raw String', () => {
    for (const column of ['total_collateral_base', 'total_debt_base', 'available_borrows_base',
                          'current_liquidation_threshold', 'ltv', 'health_factor']) {
      expect(ddl, column).toContain(`\`${column}\` String`)
      expect(view, column).toContain(`\`${column}\` String`)
      // copied, never recomputed or cast
      expect(norm(view.slice(view.indexOf(' AS SELECT ')))).toContain(`,${column},`)
    }
  })
})

describe('money_market_emode_events', () => {
  const ddl = table('money_market_emode_events')
  const view = mv('money_market_emode_events_mv')

  it('is user-first and replaces on the event identity', () => {
    expect(ddl).toContain('ENGINE = ReplacingMergeTree(ingested_at)')
    expect(ddl).toContain('ORDER BY (user_address, pool_address, block_height, event_index)')
    expect(ddl).toContain('`category_id` UInt8')
    expect(view).toContain('TO price_data.money_market_emode_events ')
    expect(view).toContain('ingested_at FROM price_data.raw_money_market_events')
    expect(view).not.toMatch(/GROUP BY/)
  })

  it('reads UserEModeSet rows only, and never turns a missing category into 0 (E-mode off)', () => {
    expect(view).toContain("WHERE (event_name = 'UserEModeSet')")
    expect(view).toContain("JSONHas(decoded_args_json, 'categoryId')")
    expect(view).toContain("(ifNull(user_address, '') != '')")
    expect(view).toContain("toUInt8(JSONExtractUInt(decoded_args_json, 'categoryId')) AS category_id")
  })

  it('resolves user and pool exactly as the collateral-flag MV does', () => {
    const flags = mv('money_market_collateral_flags_mv')
    for (const expr of ["lower(ifNull(user_address, '')) AS user_address",
                        "lower(if(ifNull(pool_address, '') = '', contract_address, pool_address)) AS pool_address"]) {
      expect(flags).toContain(expr)
      expect(view).toContain(expr)
    }
  })
})
