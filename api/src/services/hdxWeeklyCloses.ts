import { createLongOpClickHouseClient, type ClickHouseClient } from '../db/client.ts'

// HDX's weekly closes for the /hdx history: the holder structure, the rotation links
// behind its holding ages and the realized price each read every account's whole
// series of weekly closes. From account_balance_weekly (every asset, account-first,
// one argMax state per row) that was a 1.2 GiB read and ~7 CPU-s per statement on a
// quiet server — 15–25 CPU-s and up to the api's 20 s cap under load — for three
// statements an hour plus every zoomed structure or cost-basis chart.
//
// A GENERATION (clickhouse/schema/024_hdx_weekly_closes.sql) holds the weeks before
// its `cut` (a Monday) of HDX and the HDX bonds, each (account, asset) series stated
// only where its close CHANGES: ~0.36M of HDX's ~2.0M closes, 10 MiB. Every reader
// carries a close forward through the weeks it has none for (the structure's
// buckets and steps, the rotation links' births and exits, the cost basis's
// increases and decreases), so a series stated at its changes reads exactly as the
// whole series does. The weeks from the cut on come from raw_balance_observations by
// account_balance_weekly_mv's own argMax over their block range — the rows of a week
// or two — so nothing the generation lacks is ever missing, only read from raw.
//
// The `hdx-history` refresher (backgroundRefresh.ts) keeps it current: a new
// generation when a week has closed (an hour after Monday 00:00, so the week's last
// blocks have landed), when the HDX bonds outgrow the generation's assets, or when
// account_balance_weekly took an insert into a week before the cut at or after the
// moment the generation's read began (account_balance_weekly_marks, the server clock
// of the newest insert per week) — a backfill or a late block, which would otherwise
// leave a closed week short; that last one at most every ten minutes, the bound by
// which a closed week can trail its inserts. A generation is built off the request
// path on the long-op client (~5 CPU-s, 1 GiB), written as its own partition,
// published by the pointer row in hdx_weekly_closes_state once its rows are in, and
// the generation before it is kept until the next one is published, so a read that
// began on it finishes on it. A reader builds one itself only when none is published
// that covers its assets (a fresh database, a bond the refresher has not reached).

export interface HdxClosesGeneration {
  snapshotId: string
  /** First week NOT in the generation (YYYY-MM-DD, a Monday); raw states it and every later one. */
  cut: string
  /** The newest block timestamped before `cut`: the raw read's block bound. */
  cutHeight: number
  /** The server time the generation's read began, less a minute: an insert into a week before the cut at or after it is not in the generation. */
  sourceAt: string
  assets: string[]
}

let read: ClickHouseClient
let build: ClickHouseClient | null = null
let current: HdxClosesGeneration | null = null
let pointerLoad: Promise<HdxClosesGeneration | null> | null = null
let buildInflight: Promise<HdxClosesGeneration> | null = null

/** `buildClient` defaults to a long-op client created on the first build. */
export function initHdxWeeklyCloses(c: ClickHouseClient, buildClient?: ClickHouseClient): void {
  read = c
  build = buildClient ?? null
  current = null
  pointerLoad = null
  buildInflight = null
  lastBuildAt = 0
}

const builder = () => (build ??= createLongOpClickHouseClient())

/** HDX and the given bonds, the asset set a generation must cover. */
export function closesAssets(bonds: readonly string[]): string[] {
  return [...new Set(['0', ...bonds])].sort()
}

const covers = (g: HdxClosesGeneration, assets: readonly string[]) => assets.every(a => g.assets.includes(a))

async function loadPointer(): Promise<HdxClosesGeneration | null> {
  const res = await read.query({
    query: `
      -- hdx:closes-pointer
      SELECT argMax(snapshot_id, computed_at) AS snapshot_id, toString(argMax(cut, computed_at)) AS cut,
        argMax(cut_height, computed_at) AS cut_height, toString(argMax(source_at, computed_at)) AS source_at,
        argMax(assets, computed_at) AS assets, count() AS n
      FROM price_data.hdx_weekly_closes_state WHERE snapshot_key = 'current'`,
    query_params: {},
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ snapshot_id: string; cut: string; cut_height: number | string; source_at: string; assets: string[]; n: number | string }>())[0]
  if (!r || Number(r.n) === 0 || !r.snapshot_id) return null
  return { snapshotId: String(r.snapshot_id), cut: String(r.cut), cutHeight: Number(r.cut_height), sourceAt: String(r.source_at), assets: (r.assets ?? []).map(String) }
}

// Ids lead with their build's epoch milliseconds, so the newer of two is the larger:
// a pointer read that began before a build published never steps back over it.
function adopt(g: HdxClosesGeneration | null): HdxClosesGeneration | null {
  if (g && (!current || g.snapshotId >= current.snapshotId)) current = g
  return current
}

function refreshPointer(): Promise<HdxClosesGeneration | null> {
  pointerLoad ??= loadPointer().then(adopt).finally(() => { pointerLoad = null })
  return pointerLoad
}

/**
 * The published generation covering `assets`, for a reader: the one in hand, else
 * the stored pointer's, else one built now (a fresh database, or a new HDX bond the
 * refresher has not reached yet) — never a generation that lacks a requested asset.
 */
export async function hdxClosesFor(assets: readonly string[]): Promise<HdxClosesGeneration> {
  if (current && covers(current, assets)) return current
  const stored = await refreshPointer()
  if (stored && covers(stored, assets)) return stored
  return buildGeneration(closesAssets([...assets, ...(stored?.assets ?? [])]))
}

/**
 * Why the generation `g` no longer states every closed week before the cut the
 * clock asks for, or null: none yet or an asset missing, a week has closed since, or
 * account_balance_weekly took an insert into one of its weeks after its read began.
 */
async function staleness(g: HdxClosesGeneration | null, assets: readonly string[]): Promise<'missing' | 'cut' | 'touched' | null> {
  if (!g || !covers(g, assets)) return 'missing'
  const res = await read.query({
    query: `
      -- hdx:closes-marks
      SELECT toString(toMonday(now() - INTERVAL 1 HOUR)) AS cut,
        (SELECT max(inserted_at) FROM price_data.account_balance_weekly_marks WHERE week_start < {cut:Date}) >= toDateTime({sourceAt:String}) AS touched`,
    query_params: { cut: g.cut, sourceAt: g.sourceAt },
    format: 'JSONEachRow',
  })
  const r = (await res.json<{ cut: string; touched: number | string | boolean }>())[0]
  if (!r) return null
  if (String(r.cut) > g.cut) return 'cut'
  return Number(r.touched) === 1 || r.touched === true ? 'touched' : null
}

// Inserts below the cut that keep coming (a backfill running through old weeks)
// rebuild at most this often: the closed weeks trail them by up to this long.
export const HDX_CLOSES_TOUCHED_REBUILD_MS = 10 * 60_000
let lastBuildAt = 0

/** The refresher's step: publish a new generation when the current one is stale. */
export async function refreshHdxWeeklyCloses(bonds: readonly string[]): Promise<'unchanged' | 'rebuilt'> {
  const g = await refreshPointer()
  const assets = closesAssets([...bonds, ...(g?.assets ?? [])])
  const why = await staleness(g, assets)
  if (!why || (why === 'touched' && Date.now() - lastBuildAt < HDX_CLOSES_TOUCHED_REBUILD_MS)) return 'unchanged'
  await buildGeneration(assets)
  return 'rebuilt'
}

// One build at a time. A build already running serves this caller only if it
// covers the assets asked for; otherwise this caller's build follows it.
async function buildGeneration(assets: string[]): Promise<HdxClosesGeneration> {
  while (buildInflight) {
    const running = await buildInflight.catch(() => null)
    if (running && covers(running, assets)) return running
  }
  // Builds are serial here, so the one just written is the newest this process knows.
  buildInflight = writeGeneration(assets).then(g => { lastBuildAt = Date.now(); return (current = g) }).finally(() => { buildInflight = null })
  return buildInflight
}

async function writeGeneration(assets: string[]): Promise<HdxClosesGeneration> {
  const ch = builder()
  const t0 = Date.now()
  // The clock first: whatever lands in a week before the cut from `source_at` on is
  // what the marks compare against, so it is read before the source is.
  const headRes = await ch.query({
    query: `
      -- hdx:closes-cut
      SELECT toString(toMonday(now() - INTERVAL 1 HOUR)) AS cut, toString(now() - INTERVAL 60 SECOND) AS source_at,
        (SELECT max(block_height) FROM price_data.blocks WHERE block_timestamp < toDateTime(toMonday(now() - INTERVAL 1 HOUR))) AS cut_height`,
    query_params: {},
    format: 'JSONEachRow',
  })
  const head = (await headRes.json<{ cut: string; source_at: string; cut_height: number | string | null }>())[0]
  if (!head) throw new Error('[hdx] weekly closes: no clock row')
  const snapshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const g: HdxClosesGeneration = { snapshotId, cut: String(head.cut), cutHeight: Number(head.cut_height ?? 0), sourceAt: String(head.source_at), assets }
  const insert = await ch.command({
    query: `
      INSERT INTO price_data.hdx_weekly_closes (snapshot_id, account_id, asset_id, week_start, balance)
      SELECT {snapshotId:String}, account_id, asset_id, p.1, p.2
      FROM (
        SELECT account_id, asset_id, arraySort(groupArray((week_start, toUInt256OrZero(close)))) AS s
        FROM (
          SELECT account_id, asset_id, week_start, argMaxMerge(balance_state) AS close
          FROM price_data.account_balance_weekly
          WHERE asset_id IN {assets:Array(String)} AND week_start < {cut:Date}
          GROUP BY account_id, asset_id, week_start)
        GROUP BY account_id, asset_id)
      -- each series at its first close and wherever the close differs from the one before
      ARRAY JOIN arrayFilter((p, i) -> i = 1 OR p.2 != s[i - 1].2, s, arrayEnumerate(s)) AS p`,
    query_params: { snapshotId, assets, cut: g.cut },
    clickhouse_settings: { log_comment: 'hdx:closes-build', optimize_aggregation_in_order: 1 },
  })
  const countRes = await ch.query({
    query: `-- hdx:closes-count
      SELECT count() AS n FROM price_data.hdx_weekly_closes WHERE snapshot_id = {snapshotId:String}`,
    query_params: { snapshotId },
    format: 'JSONEachRow',
  })
  const n = Number((await countRes.json<{ n: number | string }>())[0]?.n ?? 0)
  const written = (insert as { summary?: { written_rows?: string } }).summary?.written_rows
  if (n === 0 || (written != null && Number(written) !== n)) {
    throw new Error(`[hdx] weekly closes generation ${snapshotId} incomplete: ${n} rows, ${written ?? '?'} written`)
  }
  // The pointer last, so a partial generation is never read.
  await ch.insert({
    table: 'price_data.hdx_weekly_closes_state',
    values: [{ snapshot_key: 'current', snapshot_id: snapshotId, cut: g.cut, cut_height: g.cutHeight, source_at: g.sourceAt, assets, row_count: n }],
    format: 'JSONEachRow',
  })
  // Every generation but this one and the one readers held until now.
  const keep = [snapshotId, current?.snapshotId ?? ''].filter(Boolean)
  const parts = await ch.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database = 'price_data' AND table = 'hdx_weekly_closes' AND active AND partition NOT IN {keep:Array(String)}`,
    query_params: { keep },
    format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await ch.command({ query: 'ALTER TABLE price_data.hdx_weekly_closes DROP PARTITION {partition:String}', query_params: { partition: row.partition } })
  }
  console.info('[hdx] weekly closes generation', { snapshotId, cut: g.cut, rows: n, assets: assets.length, ms: Date.now() - t0 })
  return g
}

/**
 * Every (account_id, asset_id, week_start) close of the generation's assets as `wbal`
 * (the close's raw amount as text, which every reader parses with toUInt256OrZero):
 * the generation's change points before its cut, then each later week from raw by
 * account_balance_weekly_mv's own argMax (`ACCOUNT_BALANCE_WEEKLY_CLOSE`). `filter` is
 * a predicate over account_id, asset_id and week_start, applied inside both reads.
 * Parameters: hdxClosesParams.
 */
export function hdxWeeklyCloseRowsSql(filter: string): string {
  return `
          SELECT account_id, asset_id, week_start, toString(balance) AS wbal
          FROM price_data.hdx_weekly_closes
          WHERE snapshot_id = {closesGen:String} AND week_start < {closesCut:Date} AND (${filter})
          UNION ALL
          SELECT account_id, asset_id, toMonday(block_timestamp) AS week_start, ${ACCOUNT_BALANCE_WEEKLY_CLOSE} AS wbal
          FROM price_data.raw_balance_observations
          WHERE block_height > {closesCutHeight:UInt32} AND block_timestamp >= toDateTime({closesCut:Date})
            AND account_id != '' AND asset_id IN {closesAssets:Array(String)} AND (${filter})
          GROUP BY account_id, asset_id, week_start`
}

/** account_balance_weekly_mv's close (003_materialized_views.sql), as a plain aggregate over raw rows. */
export const ACCOUNT_BALANCE_WEEKLY_CLOSE =
  "argMax(coalesce(total, '0'), tuple(block_height, ifNull(source_event_index, toUInt32(4294967295)), observation_id, ingested_at))"

export function hdxClosesParams(g: HdxClosesGeneration): { closesGen: string; closesCut: string; closesCutHeight: number; closesAssets: string[] } {
  return { closesGen: g.snapshotId, closesCut: g.cut, closesCutHeight: g.cutHeight, closesAssets: g.assets }
}
