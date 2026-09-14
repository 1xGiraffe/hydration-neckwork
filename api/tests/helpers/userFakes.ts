import type { ClickHouseClient } from '../../src/db/client.ts'

export interface FakeClient extends ClickHouseClient {
  inserts: { table: string; values: Record<string, unknown>[] }[]
  /**
   * What the notification evaluator's source watermark
   * (`SELECT max(block_height) AS head FROM price_data.raw_events`) answers.
   *
   * It is a SECOND head, and the clamp it feeds exists precisely because it can
   * lag the ingestion head: ClickHouse orders nothing between the insert that
   * moves `raw_ingestion_state` and the inserts carrying a block's rows. Left
   * unset it tracks the fixture's ingestion head — rows visible as soon as the
   * head names them, the non-racing case. Set it lower to hold rows back, or to
   * null to make the watermark unreadable.
   */
  sourceHead?: number | null
}

// The evaluator's watermark query, verbatim: other `max(block_height) AS head`
// readers (blocks, revenue_events, a bounded raw_events probe) must fall through
// to the normal table routing.
const SOURCE_WATERMARK_SQL = 'SELECT max(block_height) AS head FROM price_data.raw_events'

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
  const ingestionHead = (): number => Number(rowsByTable.raw_ingestion_state?.[0]?.head ?? 0)
  const fake = {
    inserts,
    sourceHead: undefined as number | null | undefined,
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.trim() === SOURCE_WATERMARK_SQL) {
          const head = fake.sourceHead === undefined ? ingestionHead() : fake.sourceHead
          return head == null ? [] : [{ head }]
        }
        const hit = tables.find(t => query.includes(t))
        if (!hit) return []
        const rows = rowsByTable[hit]
        return query.includes('deleted = 0') ? rows.filter(r => Number(r.deleted ?? 0) !== 1) : rows
      },
    }),
    insert: async ({ table, values }: { table: string; values: Record<string, unknown>[] }) => { inserts.push({ table, values }) },
    close: async () => {},
  }
  return fake as unknown as FakeClient
}

export function insertedRows(c: FakeClient, table: string): Record<string, unknown>[] {
  return c.inserts.filter(i => i.table === `price_data.${table}`).flatMap(i => i.values)
}
