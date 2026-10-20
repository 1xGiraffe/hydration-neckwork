import type { ClickHouseClient } from './client.ts'

// The catch-up of an account_activity_v3_mv swap (schemaBootstrap MV_UPGRADES): raw
// events inserted while the view was being replaced reached no view, so their blocks
// are re-read through the view's own SELECT and only the (account, block_height,
// event_index) keys the table lacks are inserted. account_activity_bounds_mv reads
// account_activity_v3, so the bounds follow from the same insert.
//
// Which blocks: raw_blocks carries ingested_at and is tiny next to raw_events (a
// block's events are written by the same ingestion), so the window's blocks are found
// there rather than by scanning raw_events. Which SELECT: the view's LIVE definition,
// read back from system.tables — after a clean swap that is the new one, after a
// restore the old one, and either way exactly what the live view would have written.

export const ACCOUNT_ACTIVITY_MV = 'price_data.account_activity_v3_mv'
const BUCKET_BLOCKS = 100_000
const MARGIN_SECONDS = 300

/** The SELECT of a `CREATE MATERIALIZED VIEW … TO … (columns) AS <select>` statement. */
export function viewSelectFromCreate(create: string): string {
  const at = create.indexOf(') AS ')
  if (at < 0) throw new Error('no ") AS " in the view definition')
  const select = create.slice(at + ') AS '.length).trim().replace(/;$/, '')
  if (!/FROM price_data\.raw_events$/.test(select)) throw new Error('the view SELECT does not end in FROM price_data.raw_events')
  return select
}

export async function catchUpAccountActivityWindow(
  c: ClickHouseClient,
  window: { from: string; to: string },
  marginSeconds = MARGIN_SECONDS,
): Promise<string> {
  const liveRes = await c.query({
    query: `SELECT create_table_query AS q FROM system.tables WHERE concat(database, '.', name) = {name:String}`,
    query_params: { name: ACCOUNT_ACTIVITY_MV }, format: 'JSONEachRow',
  })
  const live = (await liveRes.json<{ q: string }>())[0]?.q
  if (!live) throw new Error(`${ACCOUNT_ACTIVITY_MV} is not live; nothing can be replayed through it`)
  const select = viewSelectFromCreate(live)
  const bucketRes = await c.query({
    query: `SELECT min(block_height) AS lo, max(block_height) AS hi FROM price_data.raw_blocks
            WHERE ingested_at BETWEEN {from:DateTime} - INTERVAL {margin:UInt32} SECOND AND {to:DateTime} + INTERVAL {margin:UInt32} SECOND
            GROUP BY intDiv(block_height, {size:UInt32}) ORDER BY lo`,
    query_params: { from: window.from, to: window.to, margin: marginSeconds, size: BUCKET_BLOCKS }, format: 'JSONEachRow',
  })
  const buckets = (await bucketRes.json<{ lo: number | string; hi: number | string }>()).map(b => ({ lo: Number(b.lo), hi: Number(b.hi) }))
  for (const { lo, hi } of buckets) {
    // One PREWHERE on the block range, appended to the view's own FROM — never an
    // explicit PREWHERE beside a separate WHERE on the source (CH 26.3 returns a
    // fraction of the rows); the anti-join sits on the outer query.
    await c.command({
      query: `INSERT INTO price_data.account_activity_v3
              SELECT * FROM (${select} PREWHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32})
              WHERE (account, block_height, event_index) NOT IN (
                SELECT account, block_height, event_index FROM price_data.account_activity_v3
                WHERE block_height BETWEEN {lo:UInt32} AND {hi:UInt32})`,
      query_params: { lo, hi },
      clickhouse_settings: { max_threads: 4, max_memory_usage: '3000000000' },
    })
  }
  return `${buckets.length} block range(s) ingested ${window.from}..${window.to} ±${marginSeconds}s re-read through the live view, missing keys inserted`
}
