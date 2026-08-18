import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getFilterNames, initExplorerService } from '../src/services/explorerService.ts'
import type { ClickHouseClient } from '../src/db/client.ts'

const explorerService = readFileSync(new URL('../src/services/explorerService.ts', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../src/routes/explorer.ts', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
const evaluator = readFileSync(new URL('../src/notifications/evaluator.ts', import.meta.url), 'utf8')

// Every query the call made, so what the endpoint actually asks ClickHouse for is
// assertable rather than inferred from its answer.
function recordingClient(rowsByTable: Record<string, { name: string }[]>): { client: ClickHouseClient; queries: string[] } {
  const queries: string[] = []
  const client = {
    query: async ({ query }: { query: string }) => {
      queries.push(query)
      const table = Object.keys(rowsByTable).find(t => query.includes(t))
      return { json: async () => (table ? rowsByTable[table] : []) }
    },
    insert: async () => {},
    close: async () => {},
  } as unknown as ClickHouseClient
  return { client, queries }
}

// The name catalogue behind the Extrinsics/Events filter boxes and the alert
// form's pallet/name pickers. Its whole value is that a suggested name is one the
// data — and the notification matcher — can actually match, so these pin both the
// source tables and the bound that keeps the distinct off a full scan.
describe('the call/event name catalogue', () => {
  // getFilterNames is cached for an hour on a fixed key, so the call below is the
  // only one this file can observe; everything else is pinned against the source.
  it('reads distinct names off the two raw tables, bounded to a recent block window', async () => {
    const { client, queries } = recordingClient({
      raw_extrinsics: [{ name: 'Omnipool.sell' }, { name: 'Router.sell' }],
      raw_events: [{ name: 'Referenda.Submitted' }, { name: 'Tokens.Transfer' }],
    })
    initExplorerService(client)

    expect(await getFilterNames()).toEqual({
      calls: ['Omnipool.sell', 'Router.sell'],
      events: ['Referenda.Submitted', 'Tokens.Transfer'],
    })

    expect(queries).toHaveLength(2)
    const calls = queries.find(q => q.includes('raw_extrinsics'))!
    const events = queries.find(q => q.includes('raw_events'))!
    expect(calls).toContain('SELECT DISTINCT call_name AS name')
    expect(events).toContain('SELECT DISTINCT event_name AS name')
    // Bounded on the sort-key prefix of each table: a window, never the whole
    // table, and the upper end comes from part metadata rather than a scan.
    for (const query of [calls, events]) {
      expect(query).toContain('WHERE block_height > (SELECT max(block_height)')
      expect(query).toContain('- {window:UInt32}')
      expect(query).toContain('ORDER BY name')
    }
  })

  it('drops empty names, so a blank never becomes an option', async () => {
    // Same cached entry as above — assert on the projection instead.
    const projection = explorerService.slice(
      explorerService.indexOf('async function distinctNames'),
      explorerService.indexOf('export async function getFilterNames'),
    )
    expect(projection).toContain('.filter(Boolean)')
  })

  // A suggestion the matcher cannot match is worse than no suggestion: the
  // extrinsic lane windows raw_extrinsics.call_name and the event lane
  // raw_events.event_name, so the catalogue must read those exact two columns.
  it('reads the same columns the notification matchers window over', () => {
    expect(evaluator).toContain('SELECT block_height, extrinsic_index, call_name')
    expect(evaluator).toContain('FROM price_data.raw_extrinsics')
    expect(evaluator).toContain('SELECT block_height, event_index, extrinsic_index, event_name')
    expect(evaluator).toContain('FROM price_data.raw_events')
    expect(explorerService).toContain("distinctNames('raw_extrinsics', 'call_name')")
    expect(explorerService).toContain("distinctNames('raw_events', 'event_name')")
  })

  it('is served through the shared single-flight cache for an hour', () => {
    expect(explorerService).toContain('const FILTER_NAME_CACHE_MS = 3_600_000')
    expect(explorerService).toContain("cached('explorer:filter-names', FILTER_NAME_CACHE_MS")
    expect(explorerService).toContain('const FILTER_NAME_WINDOW_BLOCKS = 1_000_000')
  })

  it('is a plain GET with its own hour-long browser cache entry', () => {
    expect(routes).toContain("fastify.get('/explorer/filter-names', async () => getFilterNames())")
    // Its own entry, anchored on the exact path: without it the route would fall
    // through to the generic 5s /explorer/ bucket.
    expect(server).toContain('[/^\\/explorer\\/filter-names$/, 3600],')
    const at = server.indexOf('[/^\\/explorer\\/filter-names$/, 3600],')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(server.indexOf('[/^\\/explorer\\//, 5],'))
  })
})
