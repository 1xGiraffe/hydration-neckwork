import type { ClickHouseClient } from './client.ts'

const SWAP_EVENTS_SQL = `'Router.Executed','Router.RouteExecuted','Omnipool.SellExecuted','Omnipool.BuyExecuted','Stableswap.SellExecuted','Stableswap.BuyExecuted','XYK.SellExecuted','XYK.BuyExecuted','LBP.SellExecuted','LBP.BuyExecuted'`

export interface AccountSwapQueueRow {
  queued_at: string
  block_height: number
  event_index: number
  // Null for a swap dispatched from a block hook — see hookSwapActors.
  extrinsic_index: number | null
  block_timestamp: string
  event_name: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  ingested_at: string
}

export interface AccountSwapExtrinsic {
  block_height: number
  extrinsic_index: number
  signer: string | null
  effective_signer: string | null
}

interface AccountSwapDestinationRow {
  account: string
  block_height: number
  event_index: number
  extrinsic_index: number | null
  block_timestamp: string
  event_name: string
  signer: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  ingested_at: string
}

const tupleKey = (block: number, index: number) => `${block}:${index}`

// The swapper behind a hook-dispatched routed swap, keyed by (block, event index).
// Only non-DCA operations belong here: a DCA execution is already attributed and
// rendered by the DCA path, so admitting it would show every schedule's executions
// twice on its owner's page.
export type HookSwapActors = Map<string, string>

export function accountSwapDestinationRows(
  queued: AccountSwapQueueRow[],
  extrinsics: AccountSwapExtrinsic[],
  hookActors: HookSwapActors = new Map(),
): AccountSwapDestinationRow[] {
  const byTuple = new Map(extrinsics.map(row => [tupleKey(row.block_height, row.extrinsic_index), row]))
  const out: AccountSwapDestinationRow[] = []
  for (const row of queued) {
    if (row.extrinsic_index == null) {
      // No extrinsic means no signer; the actor comes from the Broadcast event.
      // Unresolved (pre-Broadcast, placeholder swapper, or a DCA execution) stays
      // out rather than being attributed to the router pallet.
      const swapper = hookActors.get(tupleKey(row.block_height, row.event_index))
      if (!swapper) continue
      out.push({
        account: swapper,
        block_height: row.block_height,
        event_index: row.event_index,
        extrinsic_index: null,
        block_timestamp: row.block_timestamp,
        event_name: row.event_name,
        signer: '',
        asset_in: row.asset_in,
        asset_out: row.asset_out,
        amount_in: row.amount_in,
        amount_out: row.amount_out,
        ingested_at: row.ingested_at,
      })
      continue
    }
    const extrinsic = byTuple.get(tupleKey(row.block_height, row.extrinsic_index))
    if (!extrinsic) continue
    const accounts = [...new Set([extrinsic.signer, extrinsic.effective_signer].filter((account): account is string => !!account))]
    const signer = extrinsic.signer || extrinsic.effective_signer || ''
    for (const account of accounts) {
      out.push({
        account,
        block_height: row.block_height,
        event_index: row.event_index,
        extrinsic_index: row.extrinsic_index,
        block_timestamp: row.block_timestamp,
        event_name: row.event_name,
        signer,
        asset_in: row.asset_in,
        asset_out: row.asset_out,
        amount_in: row.amount_in,
        amount_out: row.amount_out,
        ingested_at: row.ingested_at,
      })
    }
  }
  return out
}

// One-time historical repair. Routed swaps ingested before the queue MV existed
// are missing their Router.Executed/RouteExecuted *net* row in
// account_swap_activity — only an internal hop (e.g. Stableswap aDOT→vDOT) was
// stored. The activity feed prefers the net row per extrinsic (see the swap
// query's `event_name IN (ROUTER_NET) DESC … LIMIT 1 BY extrinsic`), so without
// it the swap renders as the hop (aDOT→vDOT) instead of the true pair (DOT→SOL).
// This backfills every net event as its signer's row, exactly as the live drain
// attributes them. Idempotent: account_swap_activity is a ReplacingMergeTree, so
// re-inserting present rows is a no-op and only the missing net rows are added.
const NET_BACKFILL_FLAG_ID = 2

export async function backfillAccountSwapNetRows(
  client: ClickHouseClient,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const flag = await client.query({
    query: `SELECT 1 FROM price_data.account_swap_activity_queue_seed FINAL WHERE id = ${NET_BACKFILL_FLAG_ID} LIMIT 1`,
    format: 'JSONEachRow',
  })
  if ((await flag.json<Record<string, number>>()).length) return 0

  const batchSize = options.batchSize ?? 10_000
  const maxBatches = options.maxBatches ?? 1_000_000
  let lastBlock = 0
  let lastEvent = 0
  let processed = 0
  for (let batch = 0; batch < maxBatches; batch++) {
    const res = await client.query({
      query: `SELECT block_height, event_index, toUInt32(extrinsic_index) AS extrinsic_index,
                toString(block_timestamp) AS block_timestamp, event_name,
                toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in,
                toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out,
                JSONExtractString(args_json, 'amountIn') AS amount_in,
                JSONExtractString(args_json, 'amountOut') AS amount_out,
                toString(ingested_at) AS ingested_at
              FROM price_data.raw_events
              WHERE event_name IN ('Router.Executed', 'Router.RouteExecuted')
                AND extrinsic_index IS NOT NULL
                AND tuple(block_height, event_index) > tuple({block:UInt32}, {event:UInt32})
              ORDER BY block_height, event_index
              LIMIT {limit:UInt32}`,
      query_params: { block: lastBlock, event: lastEvent, limit: batchSize },
      format: 'JSONEachRow',
    })
    const rows = (await res.json<Omit<AccountSwapQueueRow, 'queued_at'>>())
      .map(row => ({ ...row, queued_at: '' } as AccountSwapQueueRow))
    if (!rows.length) break
    const destination = accountSwapDestinationRows(rows, await queueExtrinsics(client, rows))
    if (destination.length) {
      await client.insert({ table: 'price_data.account_swap_activity', values: destination, format: 'JSONEachRow' })
    }
    const last = rows.at(-1)!
    lastBlock = last.block_height
    lastEvent = last.event_index
    processed += rows.length
    if (rows.length < batchSize) break
  }
  await client.insert({
    table: 'price_data.account_swap_activity_queue_seed',
    values: [{ id: NET_BACKFILL_FLAG_ID }],
    format: 'JSONEachRow',
  })
  return processed
}

interface QueueCursor {
  queued_at: string
  block_height: number
  event_index: number
  ingested_at: string
}

async function queueCursor(client: ClickHouseClient): Promise<QueueCursor> {
  const result = await client.query({
    query: `SELECT toString(queued_at) AS queued_at, block_height, event_index, toString(ingested_at) AS ingested_at
            FROM price_data.account_swap_activity_queue_state FINAL WHERE id=1 LIMIT 1`,
    format: 'JSONEachRow',
  })
  return (await result.json<QueueCursor>())[0] ?? {
    queued_at: '1970-01-01 00:00:00.000', block_height: 0, event_index: 0, ingested_at: '1970-01-01 00:00:00',
  }
}

async function queuePage(client: ClickHouseClient, cursor: QueueCursor, limit: number): Promise<AccountSwapQueueRow[]> {
  const result = await client.query({
    query: `SELECT toString(q.queued_at) AS queued_at,
              q.block_height, q.event_index, q.extrinsic_index,
              toString(q.block_timestamp) AS block_timestamp, q.event_name,
              q.asset_in, q.asset_out, q.amount_in, q.amount_out,
              toString(q.ingested_at) AS ingested_at
            FROM price_data.account_swap_activity_queue AS q
            WHERE tuple(q.queued_at, q.block_height, q.event_index, q.ingested_at) >
              tuple({queuedAt:DateTime64(3)}, {block:UInt32}, {event:UInt32}, {ingestedAt:DateTime})
            ORDER BY q.queued_at, q.block_height, q.event_index, q.ingested_at
            LIMIT {limit:UInt32}`,
    query_params: {
      queuedAt: cursor.queued_at,
      block: cursor.block_height,
      event: cursor.event_index,
      ingestedAt: cursor.ingested_at,
      limit,
    },
    format: 'JSONEachRow',
  })
  return result.json<AccountSwapQueueRow>()
}

async function queueExtrinsics(client: ClickHouseClient, rows: AccountSwapQueueRow[]): Promise<AccountSwapExtrinsic[]> {
  const tuples = [...new Set(rows.filter(row => row.extrinsic_index != null).map(row => `(${row.block_height},${row.extrinsic_index})`))]
  if (!tuples.length) return []
  const out: AccountSwapExtrinsic[] = []
  for (let start = 0; start < tuples.length; start += 5_000) {
    const result = await client.query({
      query: `SELECT block_height, extrinsic_index,
                argMax(signer, ingested_at) AS signer,
                argMax(effective_signer, ingested_at) AS effective_signer
              FROM price_data.raw_extrinsics
              WHERE (block_height, extrinsic_index) IN (${tuples.slice(start, start + 5_000).join(',')})
              GROUP BY block_height, extrinsic_index`,
      format: 'JSONEachRow',
    })
    out.push(...await result.json<AccountSwapExtrinsic>())
  }
  return out
}

// Resolve the hook rows of a batch against swap_actor, which pairs the Broadcast
// event's swapper with the Router operation id that Router.Executed reports as
// `eventId`. via_dca = 0 keeps DCA executions out: they are already the DCA path's
// rows, and a second copy here would double every schedule on its owner's page.
async function hookSwapActors(client: ClickHouseClient, rows: AccountSwapQueueRow[]): Promise<HookSwapActors> {
  const out: HookSwapActors = new Map()
  const hooks = rows.filter(row => row.extrinsic_index == null)
  if (!hooks.length) return out
  const tuples = [...new Set(hooks.map(row => `(${row.block_height},${row.event_index})`))]
  for (let start = 0; start < tuples.length; start += 5_000) {
    const result = await client.query({
      query: `SELECT e.block_height AS block_height, e.event_index AS event_index, a.swapper AS swapper
              FROM price_data.raw_events AS e
              INNER JOIN price_data.swap_actor AS a
                ON a.block_height = e.block_height
               AND a.operation_event_id = toUInt64(greatest(0, JSONExtractInt(e.args_json, 'eventId')))
              WHERE (e.block_height, e.event_index) IN (${tuples.slice(start, start + 5_000).join(',')})
                AND a.via_dca = 0`,
      format: 'JSONEachRow',
    })
    for (const row of await result.json<{ block_height: number; event_index: number; swapper: string }>()) {
      if (/^0x[0-9a-f]{64}$/.test(row.swapper)) out.set(tupleKey(row.block_height, row.event_index), row.swapper)
    }
  }
  return out
}

export async function seedAccountSwapActivityQueue(client: ClickHouseClient): Promise<void> {
  const seeded = await client.query({
    query: `SELECT 1 FROM price_data.account_swap_activity_queue_seed FINAL WHERE id=1 LIMIT 1`,
    format: 'JSONEachRow',
  })
  if ((await seeded.json<Record<string, number>>()).length) return

  const status = await client.query({
    query: `SELECT count() AS rows, toString(max(ingested_at)) AS last_ingested
            FROM price_data.account_swap_activity`,
    format: 'JSONEachRow',
  })
  const model = (await status.json<{ rows: string; last_ingested: string }>())[0]
  if (Number(model?.rows ?? 0) > 0 && model?.last_ingested) {
    // Cover the deployment hand-off from the former synchronous MV. The small
    // overlap is deliberate: destination replacement makes it idempotent and
    // avoids losing rows that share a one-second ingested_at value.
    await client.command({
      query: `INSERT INTO price_data.account_swap_activity_queue
        SELECT now64(3) AS queued_at,
          block_height, event_index, toUInt32(extrinsic_index) AS extrinsic_index,
          block_timestamp, event_name,
          toUInt32(greatest(0, JSONExtractInt(args_json, 'assetIn'))) AS asset_in,
          toUInt32(greatest(0, JSONExtractInt(args_json, 'assetOut'))) AS asset_out,
          multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json, 'amount'),
                  event_name IN ('XYK.BuyExecuted','LBP.BuyExecuted'), JSONExtractString(args_json, 'buyPrice'),
                  JSONExtractString(args_json, 'amountIn')) AS amount_in,
          multiIf(event_name IN ('XYK.SellExecuted','LBP.SellExecuted'), JSONExtractString(args_json, 'salePrice'),
                  event_name IN ('XYK.BuyExecuted','LBP.BuyExecuted'), JSONExtractString(args_json, 'amount'),
                  JSONExtractString(args_json, 'amountOut')) AS amount_out, ingested_at
        FROM price_data.raw_events
        WHERE ingested_at >= {lastIngested:DateTime} - INTERVAL 2 MINUTE
          AND event_name IN (${SWAP_EVENTS_SQL}) AND extrinsic_index IS NOT NULL`,
      query_params: { lastIngested: model.last_ingested },
      clickhouse_settings: { max_threads: 4 },
    })
  }
  await client.insert({
    table: 'price_data.account_swap_activity_queue_seed',
    values: [{ id: 1 }],
    format: 'JSONEachRow',
  })
}

export async function drainAccountSwapActivityQueue(
  client: ClickHouseClient,
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 2_000
  const maxBatches = options.maxBatches ?? 10
  let cursor = await queueCursor(client)
  let processed = 0
  for (let batch = 0; batch < maxBatches; batch++) {
    const queued = await queuePage(client, cursor, batchSize)
    if (!queued.length) break
    const [extrinsics, hookActors] = await Promise.all([queueExtrinsics(client, queued), hookSwapActors(client, queued)])
    const destination = accountSwapDestinationRows(queued, extrinsics, hookActors)
    if (destination.length) {
      await client.insert({ table: 'price_data.account_swap_activity', values: destination, format: 'JSONEachRow' })
    }
    const last = queued.at(-1)!
    cursor = {
      queued_at: last.queued_at,
      block_height: last.block_height,
      event_index: last.event_index,
      ingested_at: last.ingested_at,
    }
    await client.insert({
      table: 'price_data.account_swap_activity_queue_state',
      values: [{ id: 1, ...cursor }],
      format: 'JSONEachRow',
    })
    processed += queued.length
    if (queued.length < batchSize) break
  }
  return processed
}

let drainTimer: NodeJS.Timeout | undefined
let drainRunning = false

export function startAccountSwapActivityQueueDrain(client: ClickHouseClient): void {
  if (drainTimer) return
  const run = async () => {
    if (drainRunning) return
    drainRunning = true
    try {
      await drainAccountSwapActivityQueue(client, { maxBatches: 5 })
    } catch (error) {
      console.error('[API] account swap queue drain failed', error)
    } finally {
      drainRunning = false
    }
  }
  drainTimer = setInterval(() => { void run() }, 1_000)
  drainTimer.unref()
  void run()
}

export function stopAccountSwapActivityQueueDrain(): void {
  if (drainTimer) clearInterval(drainTimer)
  drainTimer = undefined
}
