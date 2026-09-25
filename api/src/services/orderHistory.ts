import type { ClickHouseClient } from '../db/client.ts'
import { cached } from './cache.ts'
import { displayDescriptor } from './explorerAssets.ts'
import { loadHourlyFlowPricer } from './eventTimeCloses.ts'
import {
  DCA_ENDED_EVENTS_SQL, INTENT_ACTION_EVENTS, INTENT_ENDED_EVENTS_SQL,
  accountRef, dcaMigratedIntentId, dcaScheduleStatus, dcaTerminationReason, getIntentOrders, iceSettlementsFor,
  intentOrderStatus, intentSeqOf, liveHeadTag, recoverDcaScheduleOrder, resolveDcaTradedPair,
  type AccountRef, type AssetRef, type IntentOrder, type RawIntentEvent,
} from './explorerService.ts'
import { accountSetKey } from './lpRewardClaims.ts'
import { tagged } from './queryTag.ts'
import { renderUsd } from './valuation.ts'

// Order history — an account's (or a tag's) FINISHED orders: pallet DCA schedules
// that completed, terminated, were cancelled or migrated, and ICE intents (limit
// orders and DCA intents) that filled, completed, were cancelled or expired. The
// live ones are activeDcas / openLimitOrders; the ended-event lists and the status
// mappings are theirs and the detail pages' (DCA_ENDED_EVENTS_SQL,
// INTENT_ENDED_EVENTS_SQL, dcaScheduleStatus, intentOrderStatus), never restated.
//
// Pagination is deterministic over the FULL finished set: both sources' finished-id
// lists are read key-prefixed (dca_events_by_account by `who`, intent_orders_by_account
// by `owner` + the intents' terminal events), merged, filtered by kind, ordered by
// (endedBlock DESC, endedEventIndex DESC, kind, id), counted and sliced — and only
// the page is enriched (primary-key reads of the page's own orders).
//
// soldUsd sums every execution / fill at the hourly candle fully closed by its time
// (eventTimeCloses.ts); one unpriced execution-hour — or a budget-exhausting DCA-intent
// trade whose amounts the settlement legs cannot state — makes it null.

let client: ClickHouseClient
export function initOrderHistory(c: ClickHouseClient): void { client = c }

export type OrderHistoryKindFilter = 'all' | 'dca' | 'limit'
export type OrderHistoryRowKind = 'dca' | 'dca-intent' | 'limit'
export type OrderHistoryStatus = 'completed' | 'terminated' | 'cancelled' | 'migrated' | 'migration-cancelled' | 'filled' | 'expired'

export interface OrderHistoryRow {
  kind: OrderHistoryRowKind
  id: string
  seq?: number
  who: AccountRef | null
  assetIn: AssetRef; assetOut: AssetRef
  direction: 'Sell' | 'Buy' | null
  status: OrderHistoryStatus
  statusReason: string | null
  migratedToIntentId: string | null
  budgetAmount: string | null
  soldAmount: string
  receivedAmount: string
  soldUsd: number | null
  trades: number
  failedTrades: number
  openedBlock: number; openedIndex: number | null; openedAt: string
  endedBlock: number; endedEventIndex: number; endedAt: string
}
export interface OrderHistoryPage { total: number; offset: number; limit: number; rows: OrderHistoryRow[] }

/** One finished order as the id phase knows it: identity, where it ended, its status. */
export interface OrderHistoryEntry {
  kind: OrderHistoryRowKind
  id: string
  endedBlock: number
  endedEventIndex: number
  endedAt: string
  status: OrderHistoryStatus
  /** DCA: the hook termination to read a reason for (a signed terminate is the owner's cancel and has none). */
  hookTermination?: { bh: number; ei: number }
  /** DCA: the DCA.Migrated row naming the intent that replaced the schedule. */
  migration?: { bh: number; ei: number }
}

export interface DcaEndRow { id: string; event_name: string; block_height: number; event_index: number; extrinsic_index: number | null; ts: string }
export interface IntentEndRow { intent_id: string; event_name: string; block_height: number; event_index: number; ts: string }

const later = (a: { block_height: number; event_index: number }, b: { block_height: number; event_index: number }) =>
  a.block_height !== b.block_height ? a.block_height > b.block_height : a.event_index > b.event_index

/**
 * DCA end events → one entry per schedule. Per event name the latest row, then the
 * schedule page's own reading (getDcaSchedule): ended at terminated ?? completed ??
 * migrated ?? migration-cancelled, status from dcaScheduleStatus with a signed
 * DCA.Terminated being the owner's cancel. Pure.
 */
export function dcaHistoryEntries(rows: readonly DcaEndRow[]): OrderHistoryEntry[] {
  const byId = new Map<string, Map<string, DcaEndRow>>()
  for (const r of rows) {
    const life = byId.get(r.id) ?? byId.set(r.id, new Map()).get(r.id)!
    const prev = life.get(r.event_name)
    if (!prev || later(r, prev)) life.set(r.event_name, r)
  }
  const out: OrderHistoryEntry[] = []
  for (const [id, life] of byId) {
    const terminated = life.get('DCA.Terminated')
    const completed = life.get('DCA.Completed')
    const migrated = life.get('DCA.Migrated')
    const migrationCancelled = life.get('DCA.MigrationCancelled')
    const ended = terminated ?? completed ?? migrated ?? migrationCancelled
    if (!ended) continue
    const signed = terminated != null && terminated.extrinsic_index != null
    const status = dcaScheduleStatus(!!terminated, !!completed, signed, !!migrated, !!migrationCancelled)
    if (status === 'active') continue
    out.push({
      kind: 'dca', id, endedBlock: Number(ended.block_height), endedEventIndex: Number(ended.event_index), endedAt: ended.ts, status,
      ...(terminated && !signed ? { hookTermination: { bh: Number(terminated.block_height), ei: Number(terminated.event_index) } } : {}),
      ...(migrated ? { migration: { bh: Number(migrated.block_height), ei: Number(migrated.event_index) } } : {}),
    })
  }
  return out
}

/**
 * Intents with a terminal event → one entry each, ended at the FIRST terminal event
 * (nothing follows it), status from intentOrderStatus over the terminal names. Pure.
 */
export function intentHistoryEntries(orders: ReadonlyArray<{ intent_id: string; kind: string }>, rows: readonly IntentEndRow[]): OrderHistoryEntry[] {
  const byId = new Map<string, IntentEndRow[]>()
  for (const r of rows) (byId.get(r.intent_id) ?? byId.set(r.intent_id, []).get(r.intent_id)!).push(r)
  const out: OrderHistoryEntry[] = []
  for (const o of orders) {
    const ends = byId.get(o.intent_id)
    if (!ends?.length) continue
    const kind = o.kind === 'dca' ? 'dca' : 'swap'
    const status = intentOrderStatus(kind, ends.map(e => e.event_name))
    if (status === 'open' || status === 'partially-filled') continue
    const first = ends.reduce((a, b) => (later(a, b) ? b : a))
    out.push({ kind: kind === 'dca' ? 'dca-intent' : 'limit', id: o.intent_id, endedBlock: Number(first.block_height), endedEventIndex: Number(first.event_index), endedAt: first.ts, status })
  }
  return out
}

const idCompare = (a: string, b: string): number => {
  const x = BigInt(a), y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}
/** The history's total order: endedBlock DESC, endedEventIndex DESC, kind, id (numeric). */
export function compareOrderHistory(a: OrderHistoryEntry, b: OrderHistoryEntry): number {
  if (a.endedBlock !== b.endedBlock) return b.endedBlock - a.endedBlock
  if (a.endedEventIndex !== b.endedEventIndex) return b.endedEventIndex - a.endedEventIndex
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  return idCompare(a.id, b.id)
}
/** 'dca' covers both pallet schedules and DCA intents; 'limit' the swap intents. */
export function matchesOrderKind(entry: OrderHistoryEntry, kind: OrderHistoryKindFilter): boolean {
  if (kind === 'all') return true
  return kind === 'limit' ? entry.kind === 'limit' : entry.kind !== 'limit'
}
/** Filter, order and slice the full finished set. Pure. */
export function orderHistorySlice(entries: readonly OrderHistoryEntry[], kind: OrderHistoryKindFilter, offset: number, limit: number): { total: number; page: OrderHistoryEntry[] } {
  const all = entries.filter(e => matchesOrderKind(e, kind)).sort(compareOrderHistory)
  return { total: all.length, page: all.slice(offset, offset + limit) }
}

const ACCOUNT_RE = /^0x[0-9a-f]{64}$/
const validAccounts = (accounts: readonly string[]): string[] =>
  [...new Set(accounts.map(a => a.toLowerCase()))].filter(a => ACCOUNT_RE.test(a)).sort()
// A page's intents (≤ 100 ids) as a literal list; the whole set is a key-prefixed subquery instead.
const intentIdList = (ids: readonly string[]): string =>
  ids.filter(id => /^\d+$/.test(id)).map(id => `toUInt128('${id}')`).join(',') || 'toUInt128(0)'

async function select<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await client.query(tagged({ query, query_params: params, format: 'JSONEachRow' as const }))
  return res.json<T>()
}

/**
 * The account set's finished orders, unordered. Head-keyed like activeDcas: the
 * reads are key-prefixed and cheap (the heaviest DCA account, the treasury, is one
 * ~2M-row prefix at ~20 ms), so the list turns over exactly when a block lands.
 */
export async function loadFinishedOrders(accountsIn: readonly string[]): Promise<OrderHistoryEntry[]> {
  const accs = validAccounts(accountsIn)
  if (!accs.length) return []
  return cached(`explorer:order-history-ids:${await liveHeadTag()}:${accountSetKey(accs)}`, 5_000, async () => {
    const [dcaRows, orders] = await Promise.all([
      // dca_events_by_account replaces on (who, block_height, event_index); LIMIT 1 BY
      // collapses a replayed range before the rows are read as a lifecycle.
      select<DcaEndRow>(`-- orders:dca-ended
          SELECT toString(id) AS id, event_name, block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts
          FROM price_data.dca_events_by_account
          WHERE who IN {accs:Array(String)} AND event_name IN (${DCA_ENDED_EVENTS_SQL})
          LIMIT 1 BY who, block_height, event_index`, { accs }),
      select<{ intent_id: string; kind: string; block_height: number }>(`-- orders:intents-owned
          SELECT toString(intent_id) AS intent_id, kind, block_height
          FROM price_data.intent_orders_by_account FINAL
          WHERE owner IN {accs:Array(String)}`, { accs }),
    ])
    let intentEnds: IntentEndRow[] = []
    if (orders.length) {
      // intent_events is block-keyed: no event of an order precedes its placement,
      // so the owner's first placement bounds the read.
      const minb = Math.min(...orders.map(o => Number(o.block_height)))
      intentEnds = await select<IntentEndRow>(`-- orders:intents-ended
          SELECT toString(iid) AS intent_id, event_name, block_height, event_index, toString(block_timestamp) AS ts
          FROM (
            SELECT intent_id AS iid, event_name, block_height, event_index, block_timestamp
            FROM price_data.intent_events FINAL
            WHERE block_height >= {minb:UInt32} AND event_name IN (${INTENT_ENDED_EVENTS_SQL})
              AND intent_id IN (SELECT intent_id FROM price_data.intent_orders_by_account WHERE owner IN {accs:Array(String)})
          )`, { minb, accs })
    }
    return [...dcaHistoryEntries(dcaRows), ...intentHistoryEntries(orders, intentEnds)]
  })
}

interface HourSum { id: string; assetId: number; hourSec: number; amount: bigint }

/** soldUsd over an order's execution-hour sums: null when any hour is unpriced. */
async function soldUsdByOrder(sums: readonly HourSum[], incomplete: ReadonlySet<string>): Promise<Map<string, number | null>> {
  const pricer = await loadHourlyFlowPricer(client, sums.filter(s => s.amount > 0n))
  const acc = new Map<string, bigint | null>()
  for (const s of sums) {
    if (!acc.has(s.id)) acc.set(s.id, 0n)
    if (s.amount === 0n) continue
    const prev = acc.get(s.id)
    const usd = pricer.usd(s.assetId, s.amount, s.hourSec)
    acc.set(s.id, prev == null || usd == null ? null : prev + usd)
  }
  const out = new Map<string, number | null>()
  for (const [id, v] of acc) out.set(id, v == null || incomplete.has(id) ? null : Number(renderUsd(v)))
  return out
}

const direction = (d: string): 'Sell' | 'Buy' | null => (d === 'Sell' || d === 'Buy' ? d : null)

async function enrichDca(entries: OrderHistoryEntry[], accs: string[]): Promise<Map<string, OrderHistoryRow>> {
  const out = new Map<string, OrderHistoryRow>()
  if (!entries.length) return out
  const ids = entries.map(e => Number(e.id))
  const scheds = await select<{ id: string; block_height: number; ts: string; extrinsic_index: number | null; who: string; asset_in: number; asset_out: number; direction: string; total_amount: string }>(`-- orders:dca-schedules
      SELECT toString(sid) AS id, block_height, toString(block_timestamp) AS ts, extrinsic_index, who, asset_in, asset_out, direction, toString(total) AS total_amount
      FROM (
        SELECT id AS sid, block_height, block_timestamp, extrinsic_index, who, asset_in, asset_out, direction, total_amount AS total
        FROM price_data.dca_schedules FINAL WHERE id IN {ids:Array(UInt64)}
      )`, { ids })
  const schedById = new Map(scheds.map(s => [String(s.id), s]))
  const minb = Math.min(...scheds.map(s => Number(s.block_height)), ...entries.map(e => e.endedBlock))
  const maxb = Math.max(...entries.map(e => e.endedBlock))
  const hookTerms = entries.filter(e => e.hookTermination)
  const [hours, termRows] = await Promise.all([
    // The page's executions, account-prefixed and bounded by the page's block span,
    // replay-collapsed, summed per (schedule, hour) — every execution in one hour
    // prices at the same closed candle.
    select<{ id: string; h: number; n: string | number; f: string | number; tin: string; tout: string }>(`-- orders:dca-execution-hours
        SELECT toString(id) AS id, toUInt32(toUnixTimestamp(toStartOfHour(block_timestamp))) AS h,
               countIf(event_name = 'DCA.TradeExecuted') AS n, countIf(event_name = 'DCA.TradeFailed') AS f,
               toString(sumIf(toUInt256OrZero(amount_in), event_name = 'DCA.TradeExecuted')) AS tin,
               toString(sumIf(toUInt256OrZero(amount_out), event_name = 'DCA.TradeExecuted')) AS tout
        FROM (
          SELECT who, block_height, event_index, id, event_name, block_timestamp, amount_in, amount_out
          FROM price_data.dca_events_by_account
          WHERE who IN {accs:Array(String)} AND block_height >= {minb:UInt32} AND block_height <= {maxb:UInt32}
            AND id IN {ids:Array(UInt64)} AND event_name IN ('DCA.TradeExecuted', 'DCA.TradeFailed')
          LIMIT 1 BY who, block_height, event_index
        )
        GROUP BY id, h`, { accs, minb, maxb, ids }),
    // A hook termination's reason is only in raw_events (dca_events_mv writes '' for
    // it): primary-key point reads of the page's own terminations.
    hookTerms.length
      ? select<{ block_height: number; event_index: number; error: string }>(`-- orders:dca-termination-reasons
          SELECT block_height, event_index, JSONExtractRaw(args_json, 'error') AS error FROM price_data.raw_events
          WHERE block_height IN {hs:Array(UInt32)} AND event_name = 'DCA.Terminated'`, { hs: [...new Set(hookTerms.map(e => e.hookTermination!.bh))] })
      : Promise.resolve([]),
  ])
  const reasonAt = new Map(termRows.map(r => [`${r.block_height}:${r.event_index}`, dcaTerminationReason(r.error)]))
  const [pairs, recovered, migratedTo] = await Promise.all([
    Promise.all(entries.map(e => {
      const s = schedById.get(e.id)
      return s ? resolveDcaTradedPair(Number(e.id), Number(s.asset_in), Number(s.asset_out), s.who) : Promise.resolve(null)
    })),
    // A blank direction is the pre-router marker; the scheduling call still names it.
    Promise.all(entries.map(e => {
      const s = schedById.get(e.id)
      return s && s.direction === '' ? recoverDcaScheduleOrder(Number(s.block_height), s.extrinsic_index) : Promise.resolve(null)
    })),
    Promise.all(entries.map(e => (e.migration ? dcaMigratedIntentId(e.migration) : Promise.resolve(null)))),
  ])
  const totals = new Map<string, { n: number; f: number; tin: bigint; tout: bigint }>()
  const sums: HourSum[] = []
  const assetInOf = new Map<string, number>()
  entries.forEach((e, i) => { const p = pairs[i]; if (p) assetInOf.set(e.id, p.assetIn) })
  for (const h of hours) {
    const t = totals.get(h.id) ?? totals.set(h.id, { n: 0, f: 0, tin: 0n, tout: 0n }).get(h.id)!
    const tin = BigInt(h.tin || '0')
    t.n += Number(h.n); t.f += Number(h.f); t.tin += tin; t.tout += BigInt(h.tout || '0')
    const assetId = assetInOf.get(h.id)
    if (assetId != null) sums.push({ id: h.id, assetId, hourSec: Number(h.h), amount: tin })
  }
  const soldUsd = await soldUsdByOrder(sums, new Set())
  entries.forEach((e, i) => {
    const s = schedById.get(e.id)
    const pair = pairs[i]
    if (!s || !pair) return
    const t = totals.get(e.id) ?? { n: 0, f: 0, tin: 0n, tout: 0n }
    out.set(`dca:${e.id}`, {
      kind: 'dca', id: e.id,
      who: ACCOUNT_RE.test(s.who) ? accountRef(s.who) : null,
      assetIn: displayDescriptor(pair.assetIn), assetOut: displayDescriptor(pair.assetOut),
      direction: direction(recovered[i]?.direction ?? s.direction),
      status: e.status,
      statusReason: e.hookTermination ? reasonAt.get(`${e.hookTermination.bh}:${e.hookTermination.ei}`) ?? null : null,
      migratedToIntentId: migratedTo[i],
      budgetAmount: recovered[i]?.total_amount ?? s.total_amount,
      soldAmount: t.tin.toString(), receivedAmount: t.tout.toString(),
      soldUsd: soldUsd.get(e.id) ?? (t.tin === 0n ? 0 : null),
      trades: t.n, failedTrades: t.f,
      openedBlock: Number(s.block_height), openedIndex: s.extrinsic_index, openedAt: s.ts,
      endedBlock: e.endedBlock, endedEventIndex: e.endedEventIndex, endedAt: e.endedAt,
    })
  })
  return out
}

const INTENT_FILL_NAMES = [...INTENT_ACTION_EVENTS.Fill, ...INTENT_ACTION_EVENTS.PartialFill, ...INTENT_ACTION_EVENTS.DcaTrade]
const INTENT_COMPLETION = 'Intent.DcaCompleted'

async function enrichIntents(entries: OrderHistoryEntry[]): Promise<Map<string, OrderHistoryRow>> {
  const out = new Map<string, OrderHistoryRow>()
  if (!entries.length) return out
  const orders = await getIntentOrders(entries.map(e => e.id))
  if (!orders.size) return out
  const minb = Math.min(...[...orders.values()].map(o => o.blockHeight))
  const fills = await select<RawIntentEvent & { intent_id: string; amount_in: string; amount_out: string }>(`-- orders:intent-fills
      SELECT toString(iid) AS intent_id, block_height, toString(block_timestamp) AS ts, event_index, extrinsic_index, event_name, args_json, amount_in, amount_out
      FROM (
        SELECT intent_id AS iid, block_height, block_timestamp, event_index, extrinsic_index, event_name, args_json, amount_in, amount_out
        FROM price_data.intent_events FINAL
        WHERE block_height >= {minb:UInt32} AND event_name IN {names:Array(String)}
          AND intent_id IN (${intentIdList([...orders.keys()])})
      )`, { minb, names: INTENT_FILL_NAMES })
  // The budget-exhausting DCA trade states no amounts; the settlement legs do.
  const settlements = await iceSettlementsFor(fills.filter(f => f.event_name === INTENT_COMPLETION), new Map<string, IntentOrder>(orders))
  const totals = new Map<string, { n: number; tin: bigint; tout: bigint }>()
  const hourSums = new Map<string, HourSum>()
  const incomplete = new Set<string>()
  const big = (v: string | null | undefined): bigint | null => (v != null && /^\d+$/.test(v) ? BigInt(v) : null)
  for (const f of fills) {
    const order = orders.get(f.intent_id)
    if (!order) continue
    const t = totals.get(f.intent_id) ?? totals.set(f.intent_id, { n: 0, tin: 0n, tout: 0n }).get(f.intent_id)!
    t.n++
    let ain: bigint | null, aout: bigint | null
    if (f.event_name === INTENT_COMPLETION) {
      const s = settlements.get(`${f.block_height}:${f.event_index}`)
      ain = big(s?.amountIn); aout = big(s?.amountOut)
      if (ain == null) incomplete.add(f.intent_id)
    } else {
      ain = big(f.amount_in); aout = big(f.amount_out)
    }
    t.tin += ain ?? 0n
    t.tout += aout ?? 0n
    if (ain != null) {
      const hourSec = Math.floor(Date.parse(`${f.ts.replace(' ', 'T')}Z`) / 3_600_000) * 3_600
      const key = `${f.intent_id}:${hourSec}`
      const sum = hourSums.get(key) ?? hourSums.set(key, { id: f.intent_id, assetId: order.assetIn, hourSec, amount: 0n }).get(key)!
      sum.amount += ain
    }
  }
  const soldUsd = await soldUsdByOrder([...hourSums.values()], incomplete)
  for (const e of entries) {
    const order = orders.get(e.id)
    if (!order) continue
    const t = totals.get(e.id) ?? { n: 0, tin: 0n, tout: 0n }
    out.set(`${e.kind}:${e.id}`, {
      kind: e.kind, id: e.id, seq: intentSeqOf(e.id),
      who: ACCOUNT_RE.test(order.owner) ? accountRef(order.owner) : null,
      assetIn: displayDescriptor(order.assetIn), assetOut: displayDescriptor(order.assetOut),
      direction: null,
      status: e.status, statusReason: null, migratedToIntentId: null,
      // A swap intent places its whole amount; a DCA intent's budget is optional on
      // chain and an empty one is the open-ended order ('0', as activeDcas spells it).
      budgetAmount: order.kind === 'dca' ? (order.budget && order.budget !== '' ? order.budget : '0') : order.amountIn,
      soldAmount: t.tin.toString(), receivedAmount: t.tout.toString(),
      soldUsd: soldUsd.get(e.id) ?? (t.tin === 0n && !incomplete.has(e.id) ? 0 : null),
      trades: t.n, failedTrades: 0,
      openedBlock: order.blockHeight, openedIndex: order.extrinsicIndex, openedAt: order.timestamp,
      endedBlock: e.endedBlock, endedEventIndex: e.endedEventIndex, endedAt: e.endedAt,
    })
  }
  return out
}

export const ORDER_HISTORY_MAX_LIMIT = 100

/**
 * One page of the account set's order history. The page's enrichment is cached by
 * the page's identities for a minute, so a head that moved without finishing an
 * order reuses it.
 */
export async function orderHistoryPage(accountsIn: readonly string[], kind: OrderHistoryKindFilter, offset: number, limit: number): Promise<OrderHistoryPage> {
  const accs = validAccounts(accountsIn)
  const entries = await loadFinishedOrders(accs)
  const { total, page } = orderHistorySlice(entries, kind, offset, limit)
  if (!page.length) return { total, offset, limit, rows: [] }
  const identity = page.map(e => `${e.kind}:${e.id}:${e.endedBlock}:${e.endedEventIndex}`).join(',')
  // A minute, not longer: a finished order's figures are final, but what names it
  // can land late (the intent a schedule migrated to, a termination's reason).
  const rows = await cached(`explorer:order-history-page:${accountSetKey(accs)}:${accountSetKey([identity])}`, 60_000, async () => {
    const [dca, intents] = await Promise.all([
      enrichDca(page.filter(e => e.kind === 'dca'), accs),
      enrichIntents(page.filter(e => e.kind !== 'dca')),
    ])
    const byKey = new Map([...dca, ...intents])
    return page.map(e => byKey.get(`${e.kind}:${e.id}`)).filter((r): r is OrderHistoryRow => r != null)
  })
  return { total, offset, limit, rows }
}

/** The finished-order count (kind=all) — the positions-presence probe. */
export async function orderHistoryCount(accounts: readonly string[]): Promise<number> {
  return (await loadFinishedOrders(accounts)).length
}
