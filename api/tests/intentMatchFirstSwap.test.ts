import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { intentActivityParts } from '../src/services/explorerService.ts'
import { MV_UPGRADES, createStatementFor, splitSqlStatements, viewReplaySql } from '../src/db/schemaBootstrap.ts'

// Runtime 455 added a MatchFirstSwap intent: its terms sit under `intent.data.swap`
// (a struct variant's own field name) where Swap/Dca put them under `data.value`,
// beside a `matchUntil` window. Read only from `value`, DotThor's first two decoded
// as HDX → HDX with blank amounts, and their fills as ~$74k of HDX — about $10 each.
const SUBMITTED = {
  id: '33080100068218148468595621893084',
  owner: '0x1ad9d16ce64de2df5b556e1c0cf58b8428e6ce66d68d6b3eb28b69706cf8a829',
  intent: {
    data: { swap: { assetIn: 0, assetOut: 222, amountIn: '1379887321072961', amountOut: '10000000000000000000', partial: { __kind: 'No' } }, matchUntil: '1793276118000', __kind: 'MatchFirstSwap' },
    deadline: '1793276172000',
  },
}
const schema = readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8')
const statements = splitSqlStatements(schema)

describe('MatchFirstSwap intents', () => {
  it('decodes a placed MatchFirstSwap from data.swap', () => {
    expect(intentActivityParts('Intent.IntentSubmitted', SUBMITTED)).toMatchObject({
      action: 'Place', owner: SUBMITTED.owner, amountIn: '1379887321072961', amountOut: '10000000000000000000',
    })
  })

  it('stores it as a swap, its terms from either field, with its matching window', () => {
    const mv = createStatementFor(statements, 'price_data.intent_orders_mv')!
    expect(mv).toContain("JSONExtractRaw(args_json, 'intent', 'data', 'value'), JSONExtractRaw(args_json, 'intent', 'data', 'swap')) AS body")
    expect(mv).toContain("if(dkind = 'MatchFirstSwap', 'swap', lower(dkind)) AS kind")
    expect(mv).toContain('AS match_until_ms')
    expect(mv).not.toMatch(/'data', 'value', '/)
    // The histogram's asset refs read both fields too.
    expect(createStatementFor(statements, 'price_data.activity_histogram_events_mv')).toContain("JSONExtractInt(args_json, 'intent', 'data', 'swap', 'assetIn')")
  })

  it('upgrades both live views, each marked by text only the new definition has', () => {
    for (const name of ['price_data.intent_orders_mv', 'price_data.activity_histogram_events_mv']) {
      const u = MV_UPGRADES.find(x => x.name === name)!
      expect(u, name).toBeDefined()
      expect(createStatementFor(statements, name), name).toContain(u.marker)
    }
  })
})

describe('viewReplaySql', () => {
  it('replays a view over a block range in ONE PREWHERE with its own predicate', () => {
    const sql = viewReplaySql("CREATE MATERIALIZED VIEW price_data.x_mv TO price_data.x (`a` UInt32) AS SELECT block_height AS a FROM price_data.raw_events WHERE event_name = 'E.F'", 'price_data.x')
    expect(sql).toContain('INSERT INTO price_data.x SELECT block_height AS a FROM price_data.raw_events')
    expect(sql).toContain("PREWHERE block_height >= {lo:UInt32} AND block_height <= {hi:UInt32} AND (event_name = 'E.F')")
    expect(sql).not.toMatch(/\bWHERE event_name/)
  })
})
