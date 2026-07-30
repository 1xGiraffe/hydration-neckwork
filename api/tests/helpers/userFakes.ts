import type { ClickHouseClient } from '../../src/db/client.ts'

export interface FakeClient extends ClickHouseClient { inserts: { table: string; values: Record<string, unknown>[] }[] }

// Minimal ClickHouse stand-in for the user services: query() routes on table
// name (longest name first, so user_tag_members never matches user_tags rows),
// insert() records rows for assertions. The services' in-memory maps are the
// system under test; ClickHouse is only their durability sink.
export function fakeClient(rowsByTable: Record<string, Record<string, unknown>[]> = {}): FakeClient {
  const tables = Object.keys(rowsByTable).sort((a, b) => b.length - a.length)
  const inserts: { table: string; values: Record<string, unknown>[] }[] = []
  return {
    inserts,
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        const hit = tables.find(t => query.includes(t))
        return hit ? rowsByTable[hit] : []
      },
    }),
    insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => { inserts.push({ table, values }) },
    close: async () => {},
  } as unknown as FakeClient
}

export function insertedRows(c: FakeClient, table: string): Record<string, unknown>[] {
  return c.inserts.filter(i => i.table === `price_data.${table}`).flatMap(i => i.values)
}
