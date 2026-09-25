import { createLongOpClickHouseClient, type ClickHouseClient } from './client.ts'
import { onBehalfActorsFor } from '../services/onBehalfActors.ts'

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

// The account a signed extrinsic dispatched AS, keyed by (block, extrinsic index):
// the proxied account of a Proxy.proxy, the multisig of a Multisig.as_multi
// (onBehalfActorsFor). Its swaps are that account's trades — the block and extrinsic
// feeds already say so (actorsFor) — so the projection keys them there rather than on
// the signatory, whose page would otherwise carry trades its funds never made while
// the account whose funds moved showed none.
export type OnBehalfActors = Map<string, string>

export function accountSwapDestinationRows(
  queued: AccountSwapQueueRow[],
  extrinsics: AccountSwapExtrinsic[],
  hookActors: HookSwapActors = new Map(),
  onBehalf: OnBehalfActors = new Map(),
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
    const signer = extrinsic.signer || extrinsic.effective_signer || ''
    // An on-behalf dispatch is keyed to the account it ran AS; the signatory stays in
    // the signer column as the extrinsic's own fact, never as a key.
    const actor = onBehalf.get(tupleKey(row.block_height, row.extrinsic_index))
    const accounts = actor ? [actor] : [...new Set([extrinsic.signer, extrinsic.effective_signer].filter((account): account is string => !!account))]
    if (!accounts.length) {
      // An UNSIGNED extrinsic — ICE.submit_solution, the off-chain worker's solution —
      // has an extrinsic and no signer of any form; its Router swaps are the ICE pot's,
      // which only the Broadcast event names. Read like a hook swap's actor.
      const swapper = hookActors.get(tupleKey(row.block_height, row.event_index))
      if (!swapper) continue
      out.push({
        account: swapper,
        block_height: row.block_height,
        event_index: row.event_index,
        extrinsic_index: row.extrinsic_index,
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

// The cursor only ever moves FORWARD over `queued_at`, which the MV stamps with
// `now64(3)` at insert time — so a row is lost for good if it becomes visible
// only after a row with a LATER stamp has already been drained. That happens
// routinely: an insert evaluates `now64(3)` before it commits, so several
// inserts are in flight at once and they do not become visible in stamp order.
//
// Draining only up to `now64(3) - QUEUE_SETTLE_MS` closes the window: by the
// time a stamp is that old, every insert that could carry it has committed. The
// bound is evaluated by ClickHouse, so no clock skew between this process and
// the server can reopen it.
const QUEUE_SETTLE_MS = 10_000

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
              AND q.queued_at <= subtractMilliseconds(now64(3), {settleMs:UInt32})
            ORDER BY q.queued_at, q.block_height, q.event_index, q.ingested_at
            LIMIT {limit:UInt32}`,
    query_params: {
      queuedAt: cursor.queued_at,
      block: cursor.block_height,
      event: cursor.event_index,
      ingestedAt: cursor.ingested_at,
      settleMs: QUEUE_SETTLE_MS,
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

// Resolve the actorless rows of a batch — hook swaps, and the swaps of an unsigned
// extrinsic — against swap_actor, which pairs the Broadcast event's swapper with the
// Router operation id that Router.Executed reports as `eventId`. via_dca = 0 keeps
// DCA executions out: they are already the DCA path's rows, and a second copy here
// would double every schedule on its owner's page.
async function hookSwapActors(client: ClickHouseClient, rows: AccountSwapQueueRow[], extrinsics: AccountSwapExtrinsic[] = []): Promise<HookSwapActors> {
  const out: HookSwapActors = new Map()
  const signed = new Set(extrinsics.filter(e => e.signer || e.effective_signer).map(e => tupleKey(e.block_height, e.extrinsic_index)))
  const hooks = rows.filter(row => row.extrinsic_index == null || !signed.has(tupleKey(row.block_height, row.extrinsic_index)))
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
    const extrinsics = await queueExtrinsics(client, queued)
    const [hookActors, onBehalf] = await Promise.all([
      hookSwapActors(client, queued, extrinsics),
      onBehalfActorsFor(client, extrinsics.map(e => [e.block_height, e.extrinsic_index] as [number, number])),
    ])
    const destination = accountSwapDestinationRows(queued, extrinsics, hookActors, onBehalf)
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
let drainClient: ClickHouseClient | undefined

// The drain is a batch job on a one-second tick, not a request: each cycle
// reads and inserts up to five pages of 2,000 rows. It therefore runs on its
// OWN long-op client rather than the shared request client, whose ten sockets
// and 20s execution cap belong to the explorer's readers.
export function startAccountSwapActivityQueueDrain(): void {
  if (drainTimer) return
  const client = drainClient ?? (drainClient = createLongOpClickHouseClient())
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

export async function stopAccountSwapActivityQueueDrain(): Promise<void> {
  if (drainTimer) clearInterval(drainTimer)
  drainTimer = undefined
  const closing = drainClient
  drainClient = undefined
  if (closing) await closing.close().catch(() => {})
}
