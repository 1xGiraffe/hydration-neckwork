import type { ClickHouseClient } from '../../src/db/client.ts'

export interface FakeClient extends ClickHouseClient { inserts: { table: string; values: Record<string, unknown>[] }[] }

// Minimal ClickHouse stand-in for the user services: query() routes on table
// name (longest name first, so user_tag_members never matches user_tags rows),
// insert() records rows for assertions. The services' in-memory maps are the
// system under test; ClickHouse is only their durability sink.
//
// The one predicate reproduced is `deleted = 0`, because soft-deleted rows DO
// come back from a real `FROM … FINAL` and it is the WHERE that hides them — a
// query that deliberately omits the filter (the notification dedup seed, which
// must remember what was sent even after the inbox was emptied) has to be able
// to see them here too.
export function fakeClient(rowsByTable: Record<string, Record<string, unknown>[]> = {}): FakeClient {
  const tables = Object.keys(rowsByTable).sort((a, b) => b.length - a.length)
  const inserts: { table: string; values: Record<string, unknown>[] }[] = []
  return {
    inserts,
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        const hit = tables.find(t => query.includes(t))
        if (!hit) return []
        const rows = rowsByTable[hit]
        return query.includes('deleted = 0') ? rows.filter(r => Number(r.deleted ?? 0) !== 1) : rows
      },
    }),
    insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => { inserts.push({ table, values }) },
    close: async () => {},
  } as unknown as FakeClient
}

export function insertedRows(c: FakeClient, table: string): Record<string, unknown>[] {
  return c.inserts.filter(i => i.table === `price_data.${table}`).flatMap(i => i.values)
}
