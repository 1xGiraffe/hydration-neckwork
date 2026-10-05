// The User Revenue fold: one computation over a window of chain-time hours of
// ONE calendar month that yields, per (account, hour), every stream's income —
// summed by the account fold into day-grain facts
// (price_data.account_user_revenue_daily) and by the hourly fold into global
// hourly facts (price_data.user_revenue_hourly). Both folds call
// computeUserRevenueWindow, so for any month
//   Σ account_user_revenue_daily == Σ user_revenue_hourly   per (stream, month, holder_class)
// holds exactly: both are sums of the same per-(account, hour) cells, each valued
// once and truncated once. Semantics: services/userRevenueStreams.ts; integer
// rules: services/userRevenueMath.ts; schema: clickhouse/schema/016_user_revenue.sql.
//
// Shape of the computation:
//   * a WINDOW is [fromHour, toHour) inside one month, dated by block time: per
//     hour its first and last block (price_data.blocks), and the last block before
//     it (the state the window opens from);
//   * every stream builder emits LEDGERS — per (holder, stream, pot, asset) an
//     amount per hour — from the window's sources plus the month's opening
//     exposure ANCHOR (price_data.user_revenue_exposure_anchor, month m = what was
//     held at m's start), and returns the exposure it ends the window holding
//     (the next month's anchor when the window is the whole month);
//   * a ledger whose holder is a CUSTODY (the Omnipool account, a stableswap or
//     XYK pool account, an aToken contract holding a share, …) is passed through
//     to the custody's claimants by the custody's own payoff rule, with the
//     custody named in `via`, up to MAX_CUSTODY_DEPTH; what a custody cannot pass
//     on is booked unattributed with a named cause — never left on a pool account
//     to read as the protocol's;
//   * every resolved cell is classified (holder_class), valued at the hour's
//     closed candle and added to the day and hour aggregates at once, so no
//     per-cell table is ever held in memory.

import type { ClickHouseClient } from '../db/client.ts'
import { chTimestamp } from './clickhouseTime.ts'
import { assetDecimalsOrNull, priceAssetId } from './explorerAssets.ts'
import {
  BRIDGE_CUSTODY_TAGS,
  FOREIGN_TREASURY_TAGS,
  PROTOCOL_HOLDER_TAGS,
  UNATTRIBUTED_VIA,
  custodyRemainderVia,
  ethMappedAccount,
  holderClassOf,
  unattributedHolderVia,
  type HolderClass,
  type HolderSets,
} from './userRevenueStreams.ts'
import { formatUsd1e12, parseUsd1e12, splitProRata, usd1e12 } from './userRevenueMath.ts'

/** Every query of the fold runs under these caps (the bounded catch-up lane). */
export const USER_REVENUE_QUERY_SETTINGS = { max_threads: 4, max_memory_usage: '6000000000' } as const

/** A custody passes to its claimants at most this deep (pool → aToken → Omnipool → farm). */
export const MAX_CUSTODY_DEPTH = 4

export const HOUR = 3_600
export const DAY = 86_400

// ── the window ─────────────────────────────────────────────────────────────────

export interface HourBlocks { first: number; last: number; lastTs: number }

export interface FoldWindow {
  /** YYYYMM of the month the window lies in. */
  month: number
  monthStart: number
  monthEnd: number
  /** Unix seconds of the first hour, and the hour count. */
  fromHour: number
  hours: number
  /** The last block before the window and its timestamp (0 before the chain's first block). */
  openBlock: number
  openTs: number
  /** Per hour; an hour without a block carries the previous hour's last block (first = 0). */
  hourBlocks: HourBlocks[]
  /** The last block inside the window (openBlock when the window holds none). */
  lastBlock: number
}

export function monthBoundsOf(month: number): { start: number; end: number } {
  const y = Math.floor(month / 100)
  const m = month % 100
  return { start: Date.UTC(y, m - 1, 1) / 1000, end: Date.UTC(y, m, 1) / 1000 }
}

export const monthOf = (unixSeconds: number): number => {
  const d = new Date(unixSeconds * 1000)
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1
}

export const nextMonth = (month: number): number => (month % 100 === 12 ? (Math.floor(month / 100) + 1) * 100 + 1 : month + 1)

async function rows<T>(client: ClickHouseClient, query: string, params: Record<string, unknown> = {}, tag = 'ur'): Promise<T[]> {
  const res = await client.query({
    query: `-- ${tag}\n${query}`,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { ...USER_REVENUE_QUERY_SETTINGS, log_comment: tag, output_format_json_quote_64bit_integers: 1, output_format_json_quote_decimals: 1 },
  })
  return res.json<T>()
}
export { rows as userRevenueRows }

/** A large read as positional rows (JSONCompactEachRow: a third of JSONEachRow's bytes), every value a string. */
export async function userRevenueCompactRows(client: ClickHouseClient, query: string, params: Record<string, unknown> = {}, tag = 'ur'): Promise<string[][]> {
  const res = await client.query({
    query: `-- ${tag}\n${query}`,
    query_params: params,
    format: 'JSONCompactEachRow',
    clickhouse_settings: { ...USER_REVENUE_QUERY_SETTINGS, log_comment: tag, output_format_json_quote_64bit_integers: 1, output_format_json_quote_decimals: 1 },
  })
  const text = await res.text()
  const out: string[][] = []
  let start = 0
  while (start < text.length) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    if (end > start) out.push((JSON.parse(text.slice(start, end)) as unknown[]).map(v => String(v)))
    start = end + 1
  }
  return out
}

/** The window over [fromHour, toHour) of `month`, dated by block time. */
export async function loadFoldWindow(client: ClickHouseClient, month: number, fromHour: number, toHour: number): Promise<FoldWindow> {
  const { start, end } = monthBoundsOf(month)
  if (fromHour < start || toHour > end || toHour <= fromHour || fromHour % HOUR || toHour % HOUR) {
    throw new Error(`user revenue: window ${fromHour}..${toHour} is not whole hours inside ${month}`)
  }
  const hours = (toHour - fromHour) / HOUR
  const [byHour, open] = await Promise.all([
    rows<{ h: string; first: string; last: string; ts: string }>(client, `
      SELECT toUnixTimestamp(toStartOfHour(block_timestamp)) AS h, min(block_height) AS first, max(block_height) AS last,
             toUnixTimestamp(max(block_timestamp)) AS ts
      FROM price_data.blocks
      WHERE block_timestamp >= {from:DateTime} AND block_timestamp < {to:DateTime} AND block_height > 0
      GROUP BY h ORDER BY h`, { from: chTimestamp(fromHour), to: chTimestamp(toHour) }, 'ur:window'),
    rows<{ b: string; ts: string }>(client, `
      SELECT max(block_height) AS b, toUnixTimestamp(max(block_timestamp)) AS ts
      FROM price_data.blocks
      WHERE block_timestamp < {from:DateTime} AND block_timestamp >= {from:DateTime} - INTERVAL 30 DAY AND block_height > 0`,
    { from: chTimestamp(fromHour) }, 'ur:window-open'),
  ])
  const openBlock = Number(open[0]?.b ?? 0)
  const openTs = openBlock ? Number(open[0]?.ts ?? 0) : 0
  const got = new Map(byHour.map(r => [Number(r.h), r]))
  const hourBlocks: HourBlocks[] = []
  let last = openBlock
  let lastTs = openTs
  for (let i = 0; i < hours; i++) {
    const r = got.get(fromHour + i * HOUR)
    if (r) { last = Number(r.last); lastTs = Number(r.ts); hourBlocks.push({ first: Number(r.first), last, lastTs }) }
    else hourBlocks.push({ first: 0, last, lastTs })
  }
  return { month, monthStart: start, monthEnd: end, fromHour, hours, openBlock, openTs, hourBlocks, lastBlock: last }
}

/** The window hour a block lies in (−1 at or before the window's open block, `hours` past its end). */
export function hourIndexOfBlock(w: FoldWindow, block: number): number {
  if (block <= w.openBlock) return -1
  if (block > w.lastBlock) return w.hours
  let lo = 0
  let hi = w.hours - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (w.hourBlocks[mid].last >= block) hi = mid
    else lo = mid + 1
  }
  return lo
}

// ── prices ─────────────────────────────────────────────────────────────────────

/** How far back a missing candle is carried (AGENTS: historical flows carry ≤ 30 days). */
export const PRICE_CARRY_SECONDS = 30 * DAY

/**
 * Closed 1h candles per price asset over the window (and the carry before it).
 * A continuous accrual of hour h is valued at h's own closing candle (closed at
 * the hour's end); a discrete event inside hour h at the newest candle fully
 * closed at or before it — h−1's. A missing candle carries the newest earlier
 * one up to PRICE_CARRY_SECONDS; beyond that the cell is unpriced, never 0.
 */
/**
 * A priced asset whose own candle series starts late or has holes, and the
 * on-chain series of the SAME economic asset that fills them: ETH (34) has
 * candles only from 2025-08-04 and misses hours after, while Wormhole WETH (20)
 * — wrapped ETH, redeemable 1:1 — trades on chain since 2023. A cell takes the
 * newest candle of either series at or before its hour (its own on a tie), within
 * the carry; with neither it stays unpriced.
 */
export const PRICE_SERIES_FILL: ReadonlyMap<number, number> = new Map([[34, 20]])

/** Half a cent at 1e-12 USD: the bound under which every surface shows 0 (userRevenueRead.USER_REVENUE_DUST_1E12). */
export const USER_REVENUE_CELL_DUST_1E12 = 5_000_000_000n

export class HourPricer {
  private series = new Map<number, { t: number[]; c: bigint[] }>()
  constructor(private readonly w: FoldWindow) {}

  async load(client: ClickHouseClient, assetIds: Iterable<number>): Promise<void> {
    const base = [...new Set([...assetIds].map(a => priceAssetId(a)))]
    const ids = [...new Set([...base, ...base.flatMap(a => (PRICE_SERIES_FILL.has(a) ? [PRICE_SERIES_FILL.get(a)!] : []))])].filter(a => !this.series.has(a))
    if (!ids.length) return
    const from = this.w.fromHour - HOUR - PRICE_CARRY_SECONDS
    const to = this.w.fromHour + this.w.hours * HOUR
    const got = await rows<{ a: string; t: string; c: string }>(client, `
      SELECT asset_id AS a, toUnixTimestamp(interval_start) AS t, toString(argMaxMerge(close_state)) AS c
      FROM price_data.ohlc_1h
      WHERE asset_id IN {ids:Array(UInt32)} AND interval_start >= {from:DateTime} AND interval_start < {to:DateTime}
      GROUP BY a, t ORDER BY a, t`, { ids, from: chTimestamp(from), to: chTimestamp(to) }, 'ur:prices')
    for (const id of ids) this.series.set(id, { t: [], c: [] })
    for (const r of got) {
      const s = this.series.get(Number(r.a))!
      s.t.push(Number(r.t))
      s.c.push(parseUsd1e12(r.c))
    }
  }

  /** The close (1e-12 USD per whole unit) of the newest candle starting at or before `candleStart`, within the carry. */
  closeAt(assetId: number, candleStart: number): bigint | null {
    const id = priceAssetId(assetId)
    const own = this.newestAt(id, candleStart)
    const fillId = PRICE_SERIES_FILL.get(id)
    const fill = fillId == null ? null : this.newestAt(fillId, candleStart)
    const best = fill && (!own || fill.t > own.t) ? fill : own
    return best && candleStart - best.t <= PRICE_CARRY_SECONDS ? best.c : null
  }

  private newestAt(id: number, candleStart: number): { t: number; c: bigint } | null {
    const s = this.series.get(id)
    if (!s || !s.t.length || s.t[0] > candleStart) return null
    let lo = 0
    let hi = s.t.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (s.t[mid] <= candleStart) lo = mid
      else hi = mid - 1
    }
    return { t: s.t[lo], c: s.c[lo] }
  }

  /**
   * The nearest close the loaded series hold for an asset (own or fill series; the newest at or before
   * `candleStart` at any age, else the first after) — never a valuation: it only decides whether an UNPRICED cell is
   * dust (USER_REVENUE dust bound), so a 1-wei leg in a price gap is not counted as an unpriced fact.
   */
  nearestClose(assetId: number, candleStart: number): bigint | null {
    const id = priceAssetId(assetId)
    for (const sid of [id, PRICE_SERIES_FILL.get(id)]) {
      if (sid == null) continue
      const before = this.newestAt(sid, candleStart)
      if (before) return before.c
    }
    for (const sid of [id, PRICE_SERIES_FILL.get(id)]) {
      const s = sid == null ? null : this.series.get(sid)
      if (s?.c.length) return s.c[0]
    }
    return null
  }

  /** The close a cell of hour index `h` is valued at. */
  cellClose(assetId: number, h: number, mode: PriceMode): bigint | null {
    const hourStart = this.w.fromHour + h * HOUR
    return this.closeAt(assetId, mode === 'accrual' ? hourStart : hourStart - HOUR)
  }
}

/** 'accrual': continuous over the hour, valued at its own closing candle; 'event': discrete, at the candle closed before it. */
export type PriceMode = 'accrual' | 'event'

// ── ledgers and the sink ───────────────────────────────────────────────────────

export interface Ledger {
  /** The account the income accrued to, as booked (32-byte form; an EVM holder in the ETH-mapped form). */
  holder: string
  stream: string
  pot: string
  /** The custody path so far ('' for a direct holding). */
  via: string
  /** Valuation asset: the amounts are raw units of it. */
  asset: number
  /** The registry asset the holder HOLDS that earned this (what a custody resolver passes through by); null when not a holding. */
  held: number | null
  price: PriceMode
  amounts: bigint[]
  /**
   * The holder's units of `held` at each hour start (when the producer knows
   * them): the claims rule divides a custody's income by them.
   */
  units?: bigint[]
  /**
   * Set when what the ledger earns cannot pass through a custody holder (a
   * money-market reward only the holder's own key can claim): held by a custody,
   * it is booked unattributed under this cause instead of passed on.
   */
  custodyVia?: string
}

/** marker: a zero-amount statement row (an 'unmeasured:<reason>' via) kept although it sums to nothing. */
interface Cell { amount: bigint; usd: bigint; unpriced: number; marker?: boolean }

const SEP = '\u0001'

/**
 * Where resolved cells land: the per-day account aggregate and the per-hour
 * global aggregate, each cell classified, valued and truncated once.
 */
export class FactSink {
  readonly day = new Map<string, Cell>()
  readonly hour = new Map<string, Cell>()
  cells = 0
  /**
   * `boundOwners`: an ETH-mapped account (0x45544800 + H160 + padding) whose H160
   * a substrate account bound (EVMAccounts.Bound) → that account, lowercase — the
   * explorer's display identity (resolveDisplayAccountId), applied at write time
   * so one person keeps one key.
   */
  constructor(
    private readonly w: FoldWindow, private readonly pricer: HourPricer, private readonly protocolSet: ReadonlySet<string> | HolderSets,
    private readonly boundOwners: ReadonlyMap<string, string> = new Map(),
  ) {}

  classOf(account: string): HolderClass { return holderClassOf(account, this.protocolSet) }

  /** The cause an unattributed direct holder names (owner unknown, bridge custody, sovereign). */
  unattributedVia(account: string): string { return unattributedHolderVia(account, this.protocolSet) }

  /**
   * An unpriced cell worth less than the dust bound at the asset's nearest known close (HourPricer.nearestClose) is
   * dust, not an unpriced fact: it keeps its amount and a 0 USD, and is not counted unpriced. An asset with no close at
   * all, or unknown decimals, stays unpriced.
   */
  private isDust(asset: number, h: number, amount: bigint, decimals: number | null): boolean {
    if (decimals == null) return false
    const ref = this.pricer.nearestClose(asset, this.w.fromHour + h * HOUR)
    if (ref == null) return false
    const v = usd1e12(amount, ref, decimals)
    return v < USER_REVENUE_CELL_DUST_1E12 && v > -USER_REVENUE_CELL_DUST_1E12
  }

  /** The key a holder's facts are booked under: its bound substrate owner for an ETH-mapped account, else itself. */
  ownerOf(account: string): string { return this.boundOwners.get(account) ?? account }

  emit(account: string, cls: HolderClass, h: number, stream: string, pot: string, via: string, asset: number, amount: bigint, mode: PriceMode): void {
    if (amount === 0n) return
    const decimals = assetDecimalsOrNull(asset)
    const close = decimals == null ? null : this.pricer.cellClose(asset, h, mode)
    const usd = close == null || decimals == null ? 0n : usd1e12(amount, close, decimals)
    const unpriced = close == null || decimals == null ? (this.isDust(asset, h, amount, decimals) ? 0 : 1) : 0
    const dayIdx = Math.floor((this.w.fromHour + h * HOUR - this.w.monthStart) / DAY)
    const tail = `${stream}${SEP}${pot}${SEP}${via}${SEP}${asset}${SEP}${cls}`
    add(this.day, `${account}${SEP}${dayIdx}${SEP}${tail}`, amount, usd, unpriced)
    add(this.hour, `${h}${SEP}${tail}`, amount, usd, unpriced)
    this.cells++
  }

  /**
   * A whole ledger row at once: the same cells emit() would book hour by hour
   * (each valued and truncated per hour), with the key built once and the day
   * aggregate added once per day.
   */
  emitRow(account: string, cls: HolderClass, stream: string, pot: string, via: string, asset: number, amounts: readonly bigint[], mode: PriceMode): void {
    const decimals = assetDecimalsOrNull(asset)
    const tail = `${stream}${SEP}${pot}${SEP}${via}${SEP}${asset}${SEP}${cls}`
    let day = -1
    let dAmount = 0n
    let dUsd = 0n
    let dUnpriced = 0
    const flush = () => {
      if (day >= 0 && (dAmount !== 0n || dUsd !== 0n || dUnpriced)) add(this.day, `${account}${SEP}${day}${SEP}${tail}`, dAmount, dUsd, dUnpriced)
      dAmount = 0n; dUsd = 0n; dUnpriced = 0
    }
    for (let h = 0; h < amounts.length; h++) {
      const amount = amounts[h]
      if (amount === 0n) continue
      const close = decimals == null ? null : this.pricer.cellClose(asset, h, mode)
      const usd = close == null || decimals == null ? 0n : usd1e12(amount, close, decimals)
      const unpriced = close == null || decimals == null ? (this.isDust(asset, h, amount, decimals) ? 0 : 1) : 0
      const dayIdx = Math.floor((this.w.fromHour + h * HOUR - this.w.monthStart) / DAY)
      if (dayIdx !== day) { flush(); day = dayIdx }
      dAmount += amount; dUsd += usd; dUnpriced += unpriced
      add(this.hour, `${h}${SEP}${tail}`, amount, usd, unpriced)
      this.cells++
    }
    flush()
  }

  /**
   * A zero-amount UNMEASURED marker for hour h: what the fold could not measure
   * there, stated per (hour, asset) — account '' and holder class '' (it is no
   * one's income), via 'unmeasured:<reason>'. Surfaces list these and keep them
   * out of every sum.
   */
  mark(h: number, stream: string, pot: string, reason: string, asset: number): void {
    const dayIdx = Math.floor((this.w.fromHour + h * HOUR - this.w.monthStart) / DAY)
    const tail = `${stream}${SEP}${pot}${SEP}unmeasured:${reason}${SEP}${asset}${SEP}`
    for (const [m, k] of [[this.day, `${SEP}${dayIdx}${SEP}${tail}`], [this.hour, `${h}${SEP}${tail}`]] as const) {
      if (!m.has(k)) m.set(k, { amount: 0n, usd: 0n, unpriced: 0, marker: true })
    }
  }

  /** Daily rows for the staging insert, plus the month's MARKER row (stream '', every key empty). */
  dailyRows(openingFp: string, closingFp: string, registryFp: string, computedAt: string): Record<string, unknown>[] {
    const foldedThrough = chTimestamp(this.w.fromHour + this.w.hours * HOUR)
    const out: Record<string, unknown>[] = []
    for (const [k, c] of this.day) {
      if (!written(c)) continue
      const [account, dayIdx, stream, pot, via, asset, cls] = k.split(SEP)
      out.push({
        account, day: chTimestamp(this.w.monthStart + Number(dayIdx) * DAY).slice(0, 10), stream, pot, via,
        asset_id: Number(asset), holder_class: cls, amount: c.amount.toString(), amount_usd: formatUsd1e12(c.usd),
        unpriced: c.unpriced, opening_fp: openingFp, closing_fp: closingFp, registry_fp: registryFp, computed_at: computedAt,
      })
    }
    out.push({
      account: '', day: chTimestamp(this.w.monthStart).slice(0, 10), stream: '', pot: '', via: '', asset_id: 0, holder_class: '',
      amount: '0', amount_usd: '0', unpriced: 0, opening_fp: openingFp, closing_fp: closingFp, registry_fp: registryFp, computed_at: computedAt,
      folded_through: foldedThrough,
    })
    return out
  }

  /** Every asset a cell of the window was valued in (the registry fingerprint's input). */
  /** The accounts the daily rows will carry a fact for (the month's holder fingerprint is taken over these). */
  accounts(): string[] {
    const out = new Set<string>()
    for (const [k, c] of this.day) {
      if (!written(c)) continue
      const parts = k.split(SEP)
      if (parts[0] !== '' && parts[2] !== '') out.add(parts[0])
    }
    return [...out]
  }

  assets(): number[] {
    const out = new Set<number>()
    for (const [k, c] of this.hour) if (written(c)) out.add(Number(k.split(SEP)[4]))
    return [...out].sort((a, b) => a - b)
  }

  /** Per window hour, the assets its cells were valued in. */
  hourAssets(): Map<number, number[]> {
    const out = new Map<number, Set<number>>()
    for (const [k, c] of this.hour) {
      if (!written(c)) continue
      const parts = k.split(SEP)
      const h = Number(parts[0])
      const set = out.get(h) ?? new Set<number>()
      set.add(Number(parts[4]))
      out.set(h, set)
    }
    return new Map([...out].map(([h, set]) => [h, [...set].sort((a, b) => a - b)]))
  }

  /** Hourly rows (plus one marker row per window hour) for the staging insert. */
  hourlyRows(registryFp: (hourStart: number) => string, computedAt: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = []
    for (const [k, c] of this.hour) {
      if (!written(c)) continue
      const [h, stream, pot, via, asset, cls] = k.split(SEP)
      const hourStart = this.w.fromHour + Number(h) * HOUR
      out.push({
        hour: chTimestamp(hourStart), stream, pot, via, asset_id: Number(asset), holder_class: cls,
        amount: c.amount.toString(), amount_usd: formatUsd1e12(c.usd), unpriced: c.unpriced,
        registry_fp: registryFp(hourStart), computed_at: computedAt,
      })
    }
    for (let h = 0; h < this.w.hours; h++) {
      const hourStart = this.w.fromHour + h * HOUR
      out.push({ hour: chTimestamp(hourStart), stream: '', pot: '', via: '', asset_id: 0, holder_class: '', amount: '0', amount_usd: '0', unpriced: 0, registry_fp: registryFp(hourStart), computed_at: computedAt })
    }
    return out
  }
}

/**
 * A cell is written when it states something: a non-zero amount or value, an
 * unpriced count or an unmeasured marker. A key whose cells netted to zero is no
 * row — and no input of the fingerprints, which the staleness SQL recomputes from
 * the WRITTEN rows' assets (a fingerprinted asset with no row would re-mark its
 * bucket forever).
 */
const written = (c: Cell): boolean => c.amount !== 0n || c.usd !== 0n || c.unpriced > 0 || c.marker === true

function add(m: Map<string, Cell>, k: string, amount: bigint, usd: bigint, unpriced: number): void {
  const c = m.get(k)
  if (c) { c.amount += amount; c.usd += usd; c.unpriced += unpriced }
  else m.set(k, { amount, usd, unpriced })
}

// ── custody ────────────────────────────────────────────────────────────────────

/**
 * A custody's pass-through for one ledger: the claimants' ledgers (amounts per
 * hour; their sum per hour may fall short of the input — the rest is booked as
 * the remainder with the named `via` the resolver returns).
 */
export interface CustodyResolution {
  parts: Ledger[]
  /** Per hour, what no claimant took, booked unattributed with `remainderVia`. */
  remainder: bigint[]
  remainderVia: string
  /** Further named remainders (a cause other than the resolver's usual one). */
  more?: Array<{ via: string; amounts: bigint[] }>
}

export interface CustodyResolver {
  /** A short kind for `via` ('omnipool', 'stableswap:690', 'atoken:…'). */
  kind: string
  resolve(ledger: Ledger): Promise<CustodyResolution>
}

/** The registry of custodies the fold passes through, by holder account (lowercase). */
export interface CustodyRegistry {
  resolverFor(holder: string, ledger: Ledger): CustodyResolver | null
  /** A custody account no resolver passes through: the named `via` its income is booked unattributed under ('custody:<kind>', 'v3-pool-surplus'). */
  unresolvedKind(holder: string): string | null
}

const zeros = (n: number): bigint[] => new Array<bigint>(n).fill(0n)

/**
 * Books a ledger: straight into the sink when its holder is no custody, else
 * through the custody's resolver (recursively, MAX_CUSTODY_DEPTH deep).
 */
export async function bookLedger(sink: FactSink, custody: CustodyRegistry, ledger: Ledger, depth = 0): Promise<void> {
  const holder = ledger.holder.toLowerCase()
  if (ledger.custodyVia && (custody.resolverFor(holder, ledger) || custody.unresolvedKind(holder) != null)) {
    sink.emitRow(holder, 'unattributed', ledger.stream, ledger.pot, joinVia(ledger.via, ledger.custodyVia), ledger.asset, ledger.amounts, ledger.price)
    return
  }
  const resolver = depth < MAX_CUSTODY_DEPTH ? custody.resolverFor(holder, ledger) : null
  if (resolver) {
    const { parts, remainder, remainderVia, more } = await resolver.resolve(ledger)
    for (const part of parts) await bookLedger(sink, custody, part, depth + 1)
    sink.emitRow('', 'unattributed', ledger.stream, ledger.pot, joinVia(ledger.via, remainderVia), ledger.asset, remainder, ledger.price)
    for (const m of more ?? []) sink.emitRow('', 'unattributed', ledger.stream, ledger.pot, joinVia(ledger.via, m.via), ledger.asset, m.amounts, ledger.price)
    return
  }
  const unresolved = custody.unresolvedKind(holder)
  if (unresolved != null || (depth >= MAX_CUSTODY_DEPTH && custody.resolverFor(holder, ledger))) {
    const via = joinVia(ledger.via, unresolved ?? custodyRemainderVia('depth'))
    sink.emitRow(holder, 'unattributed', ledger.stream, ledger.pot, via, ledger.asset, ledger.amounts, ledger.price)
    return
  }
  const owner = sink.ownerOf(holder)
  const cls = sink.classOf(owner)
  // Every unattributed amount names its cause last: another chain's sovereign, or an owner no record names.
  const via = cls === 'unattributed' && !namesCause(ledger.via)
    ? joinVia(ledger.via, sink.unattributedVia(owner))
    : ledger.via
  sink.emitRow(owner, cls, ledger.stream, ledger.pot, via, ledger.asset, ledger.amounts, ledger.price)
}

export const joinVia = (a: string, b: string): string => (a ? (b ? `${a}>${b}` : a) : b)

const CAUSES = new Set<string>([...Object.values(UNATTRIBUTED_VIA), 'mm-before-b0', 'mm-index-unknown', 'v3-no-liquidity', 'gigahdx-no-supply'])
/** Does a via already end in a named cause of unattribution (not just a custody path or a booking label)? */
export const namesCause = (via: string): boolean => {
  const last = via.slice(via.lastIndexOf('>') + 1)
  return CAUSES.has(last) || last.startsWith('custody:') || last.startsWith('unmeasured:')
}

/**
 * The pro-rata pass-through every share-like custody shares: per hour, the
 * ledger's amount split over the claimants' units at the hour's start
 * (cumulative floors, so nothing is lost but the split's own dust, which is
 * booked 'rounding'). `claimantsAt(h)` lists (account, units) in a deterministic
 * order; a claimant ledger carries its units so a nested claims rule can use them.
 */
export function proRataResolution(
  ledger: Ledger, kind: string, held: (account: string) => number | null,
  claimantsAt: (h: number) => ReadonlyArray<readonly [string, bigint]>,
): CustodyResolution {
  const H = ledger.amounts.length
  const parts = new Map<string, Ledger>()
  const remainder = zeros(H)
  for (let h = 0; h < H; h++) {
    const total = ledger.amounts[h]
    if (total === 0n) continue
    const claimants = claimantsAt(h)
    const split = splitProRata(total, claimants)
    if (!split.length) { remainder[h] += total; continue }
    let given = 0n
    const unitsOf = new Map(claimants)
    for (const [account, part] of split) {
      let l = parts.get(account)
      if (!l) {
        l = { holder: account, stream: ledger.stream, pot: ledger.pot, via: joinVia(ledger.via, kind), asset: ledger.asset, held: held(account), price: ledger.price, amounts: zeros(H), units: zeros(H) }
        parts.set(account, l)
      }
      l.amounts[h] += part
      l.units![h] = unitsOf.get(account) ?? 0n
      given += part
    }
    remainder[h] += total - given
  }
  return { parts: [...parts.values()], remainder, remainderVia: UNATTRIBUTED_VIA.rounding }
}

// ── the protocol holder set ────────────────────────────────────────────────────

/**
 * Every tag-driven holder set in both id forms (lowercase) — the protocol's
 * members, other chains' treasuries (user) and bridge custodies (unattributed) —
 * plus one fingerprint over all three (a tag change re-marks every bucket).
 */
export async function loadProtocolHolders(client: ClickHouseClient): Promise<{ set: Set<string>; user: Set<string>; custody: Set<string>; fp: string; members: HolderMembers }> {
  const got = await rows<{ a: string; t: string }>(client, `
    SELECT DISTINCT lower(account_id) AS a, label_id AS t FROM price_data.account_tags FINAL
    WHERE deleted = 0 AND label_id IN {tags:Array(String)}`,
  { tags: [...PROTOCOL_HOLDER_TAGS, ...FOREIGN_TREASURY_TAGS, ...BRIDGE_CUSTODY_TAGS] }, 'ur:protocol-holders')
  const set = new Set<string>()
  const user = new Set<string>()
  const custody = new Set<string>()
  const foreign = new Set<string>(FOREIGN_TREASURY_TAGS)
  const bridge = new Set<string>(BRIDGE_CUSTODY_TAGS)
  for (const { a, t } of got) {
    const target = foreign.has(t) ? user : bridge.has(t) ? custody : set
    target.add(a)
    if (a.length === 66 && !a.startsWith('0x45544800')) target.add(ethMappedAccount(a.slice(0, 42)))
  }
  // The protocol set alone keeps its historical fingerprint input; the other two are tagged in.
  const sorted = [...set].sort().concat([...user].sort().map(a => `u:${a}`), [...custody].sort().map(a => `c:${a}`))
  let h = 1469598103934665603n
  for (const s of sorted) for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 1099511628211n) & 0xffffffffffffffffn }
  return { set, user, custody, fp: h.toString(), members: holderMembers({ set, user, custody }) }
}

/** Every tag-driven holder (both id forms) with its set's letter — p protocol, u user, c custody — sorted by account. */
export interface HolderMembers { accounts: string[]; classes: string[] }
export function holderMembers(sets: { set: ReadonlySet<string>; user: ReadonlySet<string>; custody: ReadonlySet<string> }): HolderMembers {
  const all = new Map<string, string>()
  for (const [letter, set] of [['p', sets.set], ['u', sets.user], ['c', sets.custody]] as const) for (const a of set) all.set(a, `${all.get(a) ?? ''}${letter}`)
  const accounts = [...all.keys()].sort()
  return { accounts, classes: accounts.map(a => all.get(a)!) }
}
