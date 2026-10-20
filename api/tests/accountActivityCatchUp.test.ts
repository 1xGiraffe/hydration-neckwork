import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { catchUpAccountActivityWindow, viewSelectFromCreate } from '../src/db/accountActivityCatchUp.ts'
import type { ClickHouseClient } from '../src/db/client.ts'
import { MV_UPGRADES, createStatementFor, splitSqlStatements } from '../src/db/schemaBootstrap.ts'

const schema = splitSqlStatements(readFileSync(new URL('../../clickhouse/schema/003_materialized_views.sql', import.meta.url), 'utf8'))
const create = createStatementFor(schema, 'price_data.account_activity_v3_mv')!

describe('account_activity_v3_mv upgrade', () => {
  it('is listed with a marker its schema definition carries', () => {
    const upgrade = MV_UPGRADES.find(u => u.name === 'price_data.account_activity_v3_mv')
    expect(upgrade).toBeDefined()
    expect(create).toContain(upgrade!.marker)
  })

  // The catch-up replays the view's own SELECT; the CREATE's column list must not
  // leak into it, and it must end on the source so a PREWHERE can follow.
  it('takes the SELECT out of the view definition', () => {
    const select = viewSelectFromCreate(create)
    expect(select.startsWith('WITH ')).toBe(true)
    expect(select).not.toContain('CREATE MATERIALIZED VIEW')
    expect(select.endsWith('FROM price_data.raw_events')).toBe(true)
  })

  it('refuses a definition it cannot read', () => {
    expect(() => viewSelectFromCreate('CREATE VIEW x AS SELECT 1')).toThrow()
    expect(() => viewSelectFromCreate('CREATE MATERIALIZED VIEW x TO y (a String) AS SELECT a FROM t')).toThrow()
  })
})

// A client that answers the two reads and records every command.
function fakeClient(buckets: Array<{ lo: number; hi: number }>) {
  const queries: Array<{ query: string; params?: Record<string, unknown> }> = []
  const commands: Array<{ query: string; params?: Record<string, unknown> }> = []
  const client = {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query, params: query_params })
      const rows = query.includes('system.tables') ? [{ q: create }] : buckets
      return { json: async () => rows }
    },
    command: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push({ query, params: query_params })
    },
  } as unknown as ClickHouseClient
  return { client, queries, commands }
}

describe('catchUpAccountActivityWindow', () => {
  const window = { from: '2026-10-20 07:00:00', to: '2026-10-20 07:00:30' }

  it('re-reads each window bucket through the live view and inserts only missing keys', async () => {
    const { client, queries, commands } = fakeClient([{ lo: 15990000, hi: 15990120 }, { lo: 16000000, hi: 16000040 }])
    await catchUpAccountActivityWindow(client, window)
    expect(queries[1].params).toMatchObject({ from: window.from, to: window.to, margin: 300, size: 100000 })
    expect(queries[1].query).toContain('FROM price_data.raw_blocks')
    expect(commands.map(c => c.params)).toEqual([{ lo: 15990000, hi: 15990120 }, { lo: 16000000, hi: 16000040 }])
    const insert = commands[0].query
    expect(insert).toContain('INSERT INTO price_data.account_activity_v3')
    // The PREWHERE follows the view's own FROM; the anti-join is on the outer query.
    expect(insert).toContain('FROM price_data.raw_events PREWHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32})')
    expect(insert).toMatch(/\)\s*WHERE \(account, block_height, event_index\) NOT IN \(/)
    expect(insert).toContain('hash_fields')
  })

  it('inserts nothing for a window that ingested no blocks', async () => {
    const { client, commands } = fakeClient([])
    expect(await catchUpAccountActivityWindow(client, window)).toMatch(/^0 block range/)
    expect(commands).toEqual([])
  })
})
