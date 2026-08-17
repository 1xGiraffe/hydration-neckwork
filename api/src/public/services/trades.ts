import type { ClickHouseClient } from '../../db/client.ts'
import { cached } from '../../services/cache.ts'
import { iso } from '../schemas/common.ts'
import { resolveSingleAccountForms } from './accountBalances.ts'

// Market swaps for GET /v1/trades and GET /v1/trades/routed. Public-owned: it
// reads the same swap models the explorer's trade feed reads, but never imports
// explorerService (spec: "Isolation rule"), so the rules that decide WHICH row is
// a user trade are restated here rather than shared.
//
// One row per user-level trade, never a per-hop leg: `swap_activity` and
// `account_swap_activity` hold both the router's net summary (Router.Executed,
// assetIn→assetOut end to end) and the AMM events of each hop, so a row set that
// took every event would report a 3-hop route as three trades in intermediate
// assets the user never named.

/** The route-executor pallet account ('modlrouterex'), the `who` of every router hop. */
const ROUTER_PALLET_ACCOUNT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'

/**
 * The router's net-trade summary. It was emitted as Router.RouteExecuted before the
 * pallet renamed it to Router.Executed (block ~4,542,080); both carry the same
 * {assetIn, assetOut, amountIn, amountOut} and an empty `who`.
 */
const ROUTER_NET_EVENTS = ['Router.Executed', 'Router.RouteExecuted']
const ROUTER_NET_RENAME_BLOCK = 4_542_080

/** A 32-byte substrate public key — the only `who`/swapper form worth reporting. */
const ACCOUNT_RE = /^0x[0-9a-f]{64}$/

/**
 * The net-trade row set of the GLOBAL feed, expressed on `swap_activity`'s own
 * columns. Three pallet-internal swap kinds are excluded, and they are disjoint on
 * (extrinsic_index, who):
 *  - a router hop carries the route-executor pallet as `who`;
 *  - a DCA keeper-fee leg is unsigned, attributed to a real (non-pallet) account,
 *    and its user-visible trade is the paired Router.Executed;
 *  - before the router event rename the AMM legs of a DCA execution ran under the
 *    owner's own account (including module pots, which the `who` triple above
 *    cannot catch), so unsigned non-net hops in blocks where a DCA trade executed
 *    are hidden too. Hook swaps in DCA-free blocks stay visible.
 */
const GLOBAL_NET_ROWS_SQL = `
    who != {routerPallet:String}
    AND NOT (extrinsic_index IS NULL AND who != '' AND who NOT LIKE '0x6d6f646c%')
    AND NOT (extrinsic_index IS NULL AND block_height < {renameBlock:UInt32}
      AND event_name NOT IN {netEvents:Array(String)}
      AND block_height IN (
        SELECT block_height FROM price_data.dca_events
        WHERE event_name = 'DCA.TradeExecuted' AND block_height < {renameBlock:UInt32}))`

/**
 * The net-trade row set of the ACCOUNT-scoped feed. `account_swap_activity` carries
 * no `who` (the actor is the key), so the rule is stated on the extrinsic instead: a
 * routed trade's hops share their extrinsic with its net event, and a direct pool
 * call has no net event, so its own row IS the trade. A batch dispatching two routes
 * keeps both net rows — collapsing per extrinsic would lose one leg of every
 * round-trip arbitrage.
 *
 * The candidate set is the account's own rows, so the extra pass stays inside the
 * primary-key prefix the page already reads.
 */
const ACCOUNT_NET_ROWS_CTE = `
    WITH net_extrinsics AS (
      SELECT DISTINCT block_height, extrinsic_index
      FROM price_data.account_swap_activity
      WHERE account IN {accounts:Array(String)}
        AND event_name IN {netEvents:Array(String)} AND extrinsic_index IS NOT NULL
    )`
const ACCOUNT_NET_ROWS_SQL = `
    account IN {accounts:Array(String)}
    AND (event_name IN {netEvents:Array(String)} OR extrinsic_index IS NULL
      OR (block_height, extrinsic_index) NOT IN net_extrinsics)`

export interface TradeRow {
  blockHeight: number
  eventIndex: number
  extrinsicIndex: number | null
  timestamp: string
  swapper: string | null
  operationType: 'exactIn' | 'exactOut' | null
  assetIn: string
  amountIn: string
  assetOut: string
  amountOut: string
  dca: { scheduleId: number } | null
}

export interface TradesOptions {
  /** Scope to one account's trades; null reads the global feed. */
  swapper: string | null
  /** Registry ids as decimal strings; matches either side of the pair. */
  assets: string[]
  limit: number
  offset: number
}

interface RawTradeRow {
  block_height: number
  event_index: number
  extrinsic_index: number | null
  ts: string
  event_name: string
  who: string
  asset_in: number
  asset_out: number
  amount_in: string
  amount_out: string
  /**
   * Account-scoped path only: the stored form the row is filed under. It is the
   * account id even when the caller asked by the H160 half of a bound EVM identity,
   * which the requested address itself is not.
   */
  account?: string
}

/**
 * Which side of the trade the user fixed. A pool event names it directly; the
 * router's net event does not, so it is read from the extrinsic's call. A batched
 * or hook-dispatched route leaves it genuinely unknown rather than guessed.
 */
export function operationTypeOf(eventName: string, callName: string | null): 'exactIn' | 'exactOut' | null {
  if (eventName.endsWith('.SellExecuted')) return 'exactIn'
  if (eventName.endsWith('.BuyExecuted')) return 'exactOut'
  const call = callName?.toLowerCase() ?? ''
  // Router.sell_all fixes the complete available input balance just as
  // Router.sell fixes an explicit input amount. It is not an unknown/batched
  // route merely because the method carries the `_all` suffix.
  if (call.endsWith('.sell') || call.endsWith('.sell_all')) return 'exactIn'
  if (call.endsWith('.buy')) return 'exactOut'
  return null
}

export interface DcaExecutionLink {
  scheduleId: number
  blockHeight: number
  eventIndex: number
  who: string
  amountIn: string
}

/**
 * Pair each hook-dispatched swap with the DCA execution it belongs to, keyed
 * `block:eventIndex`.
 *
 * Same-block executions with the same per-trade amount are common (popular round
 * DCA sizes), so (block, amountIn) alone collides across schedules. DCA.TradeExecuted
 * follows its swap's events, so a swap claims the nearest matching execution AFTER
 * its own event index and consumes it — two swaps can never share one. A signed swap
 * is never a DCA execution, whatever else its block holds.
 */
export function linkDcaExecutions(
  rows: Array<{ blockHeight: number; eventIndex: number; extrinsicIndex: number | null; amountIn: string }>,
  executions: DcaExecutionLink[],
): Map<string, { scheduleId: number; who: string }> {
  const candidates = new Map<string, DcaExecutionLink[]>()
  for (const execution of executions) {
    const key = `${execution.blockHeight}:${execution.amountIn}`
    const list = candidates.get(key) ?? []
    list.push(execution)
    candidates.set(key, list)
  }
  for (const list of candidates.values()) list.sort((a, b) => a.eventIndex - b.eventIndex)

  const claimed = new Set<DcaExecutionLink>()
  const out = new Map<string, { scheduleId: number; who: string }>()
  // Ascending event order, so the nearest-after claim is stable however the page
  // happened to be ordered.
  const hooks = rows
    .filter(row => row.extrinsicIndex == null)
    .sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)
  for (const row of hooks) {
    const list = candidates.get(`${row.blockHeight}:${row.amountIn}`)
    if (!list) continue
    const hit = list.find(execution => !claimed.has(execution) && execution.eventIndex > row.eventIndex)
    if (!hit) continue
    claimed.add(hit)
    out.set(`${row.blockHeight}:${row.eventIndex}`, { scheduleId: hit.scheduleId, who: hit.who })
  }
  return out
}

/** Raw on-chain amounts stay integer strings end to end; anything else reads as 0. */
function rawAmount(value: unknown): string {
  const input = String(value ?? '').trim()
  return /^\d+$/.test(input) ? input : '0'
}

/**
 * The event-level key as one integer, so a page's rows can be matched exactly while
 * the leading `block_height IN (...)` predicate still prunes by the primary key.
 * Event and extrinsic indices are far below the 10^6 stride.
 */
// A composite key stays a JS number (a head block is ~1.4e13, far inside the safe
// integer range) because the client renders a string array with quotes, which
// ClickHouse cannot read as Array(UInt64).
const INDEX_STRIDE = 1_000_000
const eventKey = (blockHeight: number, index: number) => blockHeight * INDEX_STRIDE + index

// An asset filter matches either side of the pair, so a request for one token
// returns the trades that bought it and the trades that sold it.
const ASSETS_FILTER_SQL = ' AND (asset_in IN {assets:Array(UInt32)} OR asset_out IN {assets:Array(UInt32)})'
const ASSET_PROJECTION_FILTER_SQL = ' AND asset_id IN {assets:Array(UInt32)}'

/** Trades matching the filter, newest first, plus the count of the whole filter. */
export async function queryTrades(client: ClickHouseClient, options: TradesOptions): Promise<{ items: TradeRow[]; totalCount: number }> {
  const assets = options.assets.map(Number).filter(Number.isInteger)
  const assetFilter = assets.length ? ASSETS_FILTER_SQL : ''
  const rows = options.swapper
    ? await accountRows(client, options, assets, assetFilter)
    : await globalRows(client, options, assets)
  const items = await decorate(client, rows.rows, options.swapper)
  return { items, totalCount: rows.totalCount }
}

const KEY_COLUMNS_SQL = 'block_height, event_index, extrinsic_index, event_name, asset_in, asset_out, amount_in, amount_out, who'

/** Extra rows read past the page so replay duplicates cannot shorten it. */
const DEDUP_SLACK = 200

async function globalRows(
  client: ClickHouseClient,
  options: TradesOptions,
  assets: number[],
): Promise<{ rows: RawTradeRow[]; totalCount: number }> {
  const params = {
    routerPallet: ROUTER_PALLET_ACCOUNT,
    renameBlock: ROUTER_NET_RENAME_BLOCK,
    netEvents: ROUTER_NET_EVENTS,
    assets,
  }
  const want = options.limit + options.offset
  // A token filter belongs on the asset-first projection. It carries the same
  // trade row once per referenced asset, so the event identity below collapses
  // a trade that matches both sides. The unfiltered feed stays on the time-first
  // source, whose ORDER BY permits a newest-first early stop.
  const source = assets.length ? 'price_data.asset_swap_activity' : 'price_data.swap_activity'
  const sourceAssetFilter = assets.length ? ASSET_PROJECTION_FILTER_SQL : ''
  const [rows, totalCount] = await Promise.all([
    (async () => {
      // Deduplication happens BEFORE the page is cut, and the read stays bounded.
      //
      // Both SQL shapes that dedup before the LIMIT — `LIMIT 1 BY` and `SELECT
      // DISTINCT` — defeat ClickHouse's read-in-order early stop: measured on the
      // live table, a 25-row page went from 266 k rows read to 10.2 M (LIMIT 1 BY)
      // and 7.7 M (DISTINCT). So the window is over-fetched by a slack margin, the
      // replacement key is deduplicated here, and only then is the page sliced.
      //
      // Replays and (on the asset-first source) a trade matching both sides can
      // duplicate an event at the HEAD. Read successive keyset chunks instead of
      // re-reading an ever wider prefix. The cursor always advances, so even a
      // duplicate run larger than the normal slack cannot silently shorten a page.
      const deduped: RawTradeRow[] = []
      const seen = new Set<string>()
      let beforeBlock: number | null = null
      let beforeEvent: number | null = null
      while (deduped.length < want) {
        const cursorFilter: string = beforeBlock == null
          ? ''
          : ' AND (block_height, event_index) < ({beforeBlock:UInt32}, {beforeEvent:UInt32})'
        const bound = Math.max(DEDUP_SLACK, want - deduped.length + DEDUP_SLACK)
        const res: { json<T>(): Promise<T[]> } = await client.query({
          query: `-- pub:trades:global-page
              SELECT ${KEY_COLUMNS_SQL}, toString(block_timestamp) AS ts
              FROM ${source}
              WHERE ${GLOBAL_NET_ROWS_SQL}${sourceAssetFilter}${cursorFilter}
              ORDER BY block_height DESC, event_index DESC
              LIMIT {bound:UInt32}`,
          query_params: {
            ...params,
            bound,
            ...(beforeBlock == null ? {} : { beforeBlock, beforeEvent }),
          },
          format: 'JSONEachRow',
        })
        const raw: RawTradeRow[] = await res.json<RawTradeRow>()
        for (const row of raw) {
          const key = `${row.block_height}:${row.event_index}`
          if (seen.has(key)) continue
          seen.add(key)
          deduped.push(row)
          if (deduped.length >= want) break
        }
        if (raw.length < bound || raw.length === 0) break
        const tail: RawTradeRow = raw[raw.length - 1]
        beforeBlock = Number(tail.block_height)
        beforeEvent = Number(tail.event_index)
      }
      return deduped.slice(options.offset, options.offset + options.limit)
    })(),
    // One count per filter, shared by every page of it: the predicate spans the
    // whole table, so it is the one read worth holding longer than the page cache.
    cached(`pub:trades-count:global:${assets.join(',')}`, 30_000, async () => {
      const res = await client.query({
        // uniqExact over the replacement key, not count(): a replayed row must not
        // inflate the total the pager sizes itself on.
        query: `-- pub:trades:global-count
            SELECT toString(uniqExact(bitOr(bitShiftLeft(toUInt64(block_height), 32), toUInt64(event_index)))) AS total
            FROM ${source}
            WHERE ${GLOBAL_NET_ROWS_SQL}${sourceAssetFilter}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      return Number((await res.json<{ total: string }>())[0]?.total ?? 0)
    }),
  ])
  return { rows, totalCount }
}

async function accountRows(
  client: ClickHouseClient,
  options: TradesOptions,
  assets: number[],
  assetFilter: string,
): Promise<{ rows: RawTradeRow[]; totalCount: number }> {
  // Both halves of an EVM identity resolve to one account, exactly as the accounts
  // endpoints resolve them, so asking by either address finds the same trades.
  const accounts = await resolveSingleAccountForms(client, options.swapper!)
  const params = { accounts, netEvents: ROUTER_NET_EVENTS, assets }
  const [pageRes, totalRes] = await Promise.all([
    client.query({
      // FINAL, bounded by the account prefix: the model is keyed
      // (account, block_height, event_index) and replays replace in place. The
      // extra LIMIT 1 BY covers the multi-form case, where one event can be stored
      // under both halves of a bound EVM identity.
      query: `-- pub:trades:account-page
          ${ACCOUNT_NET_ROWS_CTE}
          SELECT account, block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts,
                 event_name, asset_in, asset_out, amount_in, amount_out, signer AS who
          FROM price_data.account_swap_activity FINAL
          WHERE ${ACCOUNT_NET_ROWS_SQL}${assetFilter}
          ORDER BY block_height DESC, event_index DESC
          LIMIT 1 BY block_height, event_index
          LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      query_params: { ...params, limit: options.limit, offset: options.offset },
      format: 'JSONEachRow',
    }),
    client.query({
      query: `-- pub:trades:account-count
          ${ACCOUNT_NET_ROWS_CTE}
          SELECT toString(uniqExact((block_height, event_index))) AS total
          FROM price_data.account_swap_activity
          WHERE ${ACCOUNT_NET_ROWS_SQL}${assetFilter}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ])
  return {
    rows: await pageRes.json<RawTradeRow>(),
    totalCount: Number((await totalRes.json<{ total: string }>())[0]?.total ?? 0),
  }
}

/**
 * Page-scoped enrichment: who made each trade, which side was fixed, and which DCA
 * schedule an execution belongs to. Every read is keyed on the page's own rows, so
 * none of them scales with the table.
 *
 * The swapper is resolved in order of authority:
 *  1. `swap_actor` — Broadcast.Swapped records the account the router swapped FOR,
 *     which is the proxied/multisig account when the extrinsic ran on behalf of one;
 *  2. the DCA execution's own owner, for a schedule's hook-dispatched swap;
 *  3. the extrinsic's signatory (its EVM effective signer when unsigned by a
 *     substrate key);
 *  4. the event's own `who`, for a direct pool call.
 * A hook swap older than the Broadcast events (block 6,837,789) that no DCA
 * execution claims stays null rather than being credited to a pallet.
 */
async function decorate(client: ClickHouseClient, rows: RawTradeRow[], scopedTo: string | null): Promise<TradeRow[]> {
  if (!rows.length) return []
  const signed = rows.filter(row => row.extrinsic_index != null)
  const hooks = rows.filter(row => row.extrinsic_index == null)
  const netRows = rows.filter(row => ROUTER_NET_EVENTS.includes(row.event_name))
  const blocks = [...new Set(rows.map(row => Number(row.block_height)))]

  const [extrinsics, actors, executions] = await Promise.all([
    signed.length
      ? client.query({
        query: `
            SELECT block_height, extrinsic_index,
              argMax(call_name, ingested_at) AS call_name,
              argMax(ifNull(signer, ''), ingested_at) AS signer,
              argMax(ifNull(effective_signer, ''), ingested_at) AS effective_signer
            FROM price_data.raw_extrinsics
            WHERE block_height IN {blocks:Array(UInt32)}
              AND toUInt64(block_height) * {stride:UInt64} + extrinsic_index IN {keys:Array(UInt64)}
            GROUP BY block_height, extrinsic_index`,
        query_params: {
          blocks: [...new Set(signed.map(row => Number(row.block_height)))],
          keys: signed.map(row => eventKey(Number(row.block_height), Number(row.extrinsic_index))),
          stride: INDEX_STRIDE,
        },
        format: 'JSONEachRow',
      })
      : null,
    // Only the global feed needs it: on the scoped path every row is, by
    // construction, a trade of the account that was asked about.
    !scopedTo && netRows.length
      ? client.query({
        // Router.Executed reports the router operation as `eventId` in its raw args,
        // and swap_actor is keyed by that same id — the only pairing that names the
        // actor of a swap with no extrinsic and no `who`.
        query: `
            SELECT e.block_height AS block_height, e.event_index AS event_index,
                   argMax(a.swapper, a.ingested_at) AS swapper
            FROM price_data.raw_events AS e
            INNER JOIN price_data.swap_actor AS a
              ON a.block_height = e.block_height
             AND a.operation_event_id = toUInt64(greatest(0, JSONExtractInt(e.args_json, 'eventId')))
            WHERE e.block_height IN {blocks:Array(UInt32)}
              AND toUInt64(e.block_height) * {stride:UInt64} + e.event_index IN {keys:Array(UInt64)}
            GROUP BY block_height, event_index`,
        query_params: {
          blocks: [...new Set(netRows.map(row => Number(row.block_height)))],
          keys: netRows.map(row => eventKey(Number(row.block_height), Number(row.event_index))),
          stride: INDEX_STRIDE,
        },
        format: 'JSONEachRow',
      })
      : null,
    !scopedTo && hooks.length
      ? client.query({
        // event_name leads this table's key, so one event name over a page's blocks
        // is a bounded key range. LIMIT 1 BY is the replay dedup.
        query: `
            SELECT toString(id) AS id, block_height, event_index, who, amount_in
            FROM price_data.dca_events
            WHERE event_name = 'DCA.TradeExecuted' AND block_height IN {blocks:Array(UInt32)}
            LIMIT 1 BY id, block_height, event_index`,
        query_params: { blocks },
        format: 'JSONEachRow',
      })
      : null,
  ])

  interface ExtrinsicRow { block_height: number; extrinsic_index: number; call_name: string; signer: string; effective_signer: string }
  const byExtrinsic = new Map<string, ExtrinsicRow>()
  for (const row of extrinsics ? await extrinsics.json<ExtrinsicRow>() : []) {
    byExtrinsic.set(`${row.block_height}:${row.extrinsic_index}`, row)
  }
  const bySwapActor = new Map<string, string>()
  for (const row of actors ? await actors.json<{ block_height: number; event_index: number; swapper: string }>() : []) {
    if (ACCOUNT_RE.test(row.swapper)) bySwapActor.set(`${row.block_height}:${row.event_index}`, row.swapper)
  }
  const executionRows = executions
    ? (await executions.json<{ id: string; block_height: number; event_index: number; who: string; amount_in: string }>()).map(row => ({
      scheduleId: Number(row.id),
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      who: row.who,
      amountIn: rawAmount(row.amount_in),
    }))
    : []
  const dcaLinks = linkDcaExecutions(
    rows.map(row => ({
      blockHeight: Number(row.block_height),
      eventIndex: Number(row.event_index),
      extrinsicIndex: row.extrinsic_index == null ? null : Number(row.extrinsic_index),
      amountIn: rawAmount(row.amount_in),
    })),
    executionRows,
  )

  return rows.map(row => {
    const blockHeight = Number(row.block_height)
    const eventIndex = Number(row.event_index)
    const extrinsicIndex = row.extrinsic_index == null ? null : Number(row.extrinsic_index)
    const extrinsic = extrinsicIndex == null ? undefined : byExtrinsic.get(`${blockHeight}:${extrinsicIndex}`)
    const dca = dcaLinks.get(`${blockHeight}:${eventIndex}`) ?? null
    // On the scoped path the row's own storage key IS the actor, and it is the one
    // form that is always an account id: a caller may have asked by the H160 half of
    // a bound EVM identity, which is not one, and echoing that back reported null.
    const candidates = scopedTo
      ? [row.account, scopedTo]
      : [
        bySwapActor.get(`${blockHeight}:${eventIndex}`),
        dca?.who,
        extrinsic?.signer || extrinsic?.effective_signer,
        row.who,
      ]
    const swapper = candidates.find(candidate => candidate && ACCOUNT_RE.test(candidate)) ?? null
    return {
      blockHeight,
      eventIndex,
      extrinsicIndex,
      timestamp: iso(row.ts),
      swapper,
      operationType: operationTypeOf(row.event_name, extrinsic?.call_name ?? null),
      assetIn: String(row.asset_in),
      amountIn: rawAmount(row.amount_in),
      assetOut: String(row.asset_out),
      amountOut: rawAmount(row.amount_out),
      dca: dca ? { scheduleId: dca.scheduleId } : null,
    }
  })
}
