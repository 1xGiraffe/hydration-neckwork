import type { ClickHouseClient } from '../db/client.ts'
import { lbpPaymentWeight, lbpReplay, lbpSpotWad, paysInFaceUnits, primaryOtcSaleKind, type BondLbpTerms, type BondSale, type BondSaleFill, type BondSaleKind } from './bonds.ts'

// The primary-sale SOURCES of the bonds (bonds.ts BondSale): ONE read per venue, shared
// by the asset registry (every process: the bond price's sale anchor, explorerAssets.ts)
// and the explorer's bond state (bondState.ts: the pages, positions and their checks).
// A venue is one entry of BOND_SALE_SOURCES; the HDX bonds' LBP pools are one more.
//
// OTC: the orders whose Placed event names a bond as `assetOut`, kept when the one
// primary-sale rule says so (bonds.ts primaryOtcSaleKind: placed with no extrinsic, by
// governance), with every fill and the pull read by order id. The maker is resolved by
// the caller that needs it (the issuer side, bondState.ts); the registry does not.
//
// LBP: every liquidity bootstrapping pool whose distributed asset is a bond (lbp_activity,
// 020_lbp.sql) — its terms, seed, trades both ways and what its owner took back. The pool
// account itself is the issuer side while it holds unsold bonds. Its payments are not the
// bond's face units (the HDX bonds sold for DOT), so each fill carries its event-time
// face value (bonds.ts header).
//
// Every source is bounded by `toBlock` when the caller reads at a pinned block.

/** What a source needs to know about the bonds beyond their ids. */
export interface BondSaleContext {
  isBond: (assetId: number) => boolean
  underlyingOf: (bondId: number) => number | undefined
  decimalsOf: (assetId: number) => number
}
export interface BondSaleSource {
  venue: BondSale['venue']
  load(client: ClickHouseClient, bondIds: readonly number[], ctx: BondSaleContext, toBlock?: number): Promise<BondSale[]>
}

type EventRow = { block_height: number; event_index: number; extrinsic_index: number | null; ts: number; event_name: string; args_json: string }
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const isRaw = (s: string) => /^\d+$/.test(s)

/** The OTC sources from their Placed rows and their fill / pull rows (pure, for the tests). */
export function otcBondSales(placed: readonly EventRow[], events: readonly EventRow[], isBond: (assetId: number) => boolean): BondSale[] {
  const out = new Map<number, BondSale>()
  for (const r of placed) {
    const a = parse(r.args_json)
    const orderId = Number(a.orderId), assetIn = Number(a.assetIn), assetOut = Number(a.assetOut)
    const kind = primaryOtcSaleKind({ governance: r.extrinsic_index == null, assetIn, assetOut }, isBond)
    if (!kind || !Number.isInteger(orderId) || !isRaw(str(a.amountIn)) || !isRaw(str(a.amountOut))) continue
    out.set(orderId, {
      venue: 'otc', id: String(orderId), bondId: assetOut, kind, paymentAssetId: assetIn, issuerAccounts: [],
      offered: str(a.amountOut), asked: str(a.amountIn), openedBlock: r.block_height, openedMs: r.ts * 1000,
      openedEvent: { eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index },
      closedBlock: null, closedMs: null, fills: [],
    })
  }
  for (const e of [...events].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)) {
    const a = parse(e.args_json)
    const sale = out.get(Number(a.orderId))
    if (!sale) continue
    if (e.event_name === 'OTC.Cancelled') { sale.closedBlock = e.block_height; sale.closedMs = e.ts * 1000; sale.closedEvent = { eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index }; continue }
    const paid = str(a.amountIn), bonds = str(a.amountOut), fee = str(a.fee)
    if (!isRaw(paid) || !isRaw(bonds)) continue
    sale.fills.push({
      block: e.block_height, eventIndex: e.event_index, extrinsicIndex: e.extrinsic_index, atMs: e.ts * 1000,
      taker: str(a.who).toLowerCase(), paid, bonds, fee: isRaw(fee) ? fee : '0', partial: e.event_name === 'OTC.PartiallyFilled',
    })
  }
  return [...out.values()].sort((a, b) => a.openedBlock - b.openedBlock || Number(a.id) - Number(b.id))
}

const select = async <T>(ch: ClickHouseClient, query: string, query_params: Record<string, unknown>): Promise<T[]> =>
  (await ch.query({ query, query_params, format: 'JSONEachRow' })).json<T>()

export const OTC_BOND_SALE_SOURCE: BondSaleSource = {
  venue: 'otc',
  async load(ch, bondIds, { isBond }, toBlock) {
    if (!bondIds.length) return []
    const bound = toBlock != null ? 'AND block_height <= {b:UInt32}' : ''
    const placed = await select<EventRow>(ch, `-- bond:sales-placed
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.otc_activity FINAL
      WHERE event_name = 'OTC.Placed' ${bound}
        AND toUInt32(JSONExtractInt(args_json,'assetOut')) IN ({ids:Array(UInt32)})`, { ids: [...bondIds], b: toBlock ?? 0 })
    const ids = placed.map(r => Number(parse(r.args_json).orderId)).filter(n => Number.isInteger(n) && n > 0)
    const events = ids.length ? await select<EventRow>(ch, `-- bond:sales-events
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.otc_activity FINAL
      WHERE event_name IN ('OTC.Filled', 'OTC.PartiallyFilled', 'OTC.Cancelled') ${bound}
        AND toUInt32(JSONExtractUInt(args_json,'orderId')) IN ({ids:Array(UInt32)})`, { ids, b: toBlock ?? 0 }) : []
    return otcBondSales(placed, events, isBond)
  },
}

// ── LBP ───────────────────────────────────────────────────────────────────────

/** The LBP events a source reads (020_lbp.sql's lbp_activity holds exactly these). */
export const LBP_EVENT_NAMES = ['LBP.PoolCreated', 'LBP.PoolUpdated', 'LBP.LiquidityAdded', 'LBP.LiquidityRemoved', 'LBP.SellExecuted', 'LBP.BuyExecuted'] as const
export const LBP_TRADE_EVENT_NAMES = ['LBP.SellExecuted', 'LBP.BuyExecuted'] as const

/**
 * pallet-lbp's `fee: (u32, u32)`. The indexer writes a numeric tuple whose elements
 * all fit a byte as its bytes in hex (`(1, 200)` → "0x01c8"), a wider one as an array.
 */
export function lbpFeeOf(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length === 2 && v.every(x => Number.isInteger(Number(x)))) return [Number(v[0]), Number(v[1])]
  if (typeof v === 'string' && /^0x[0-9a-f]{4}$/i.test(v)) return [parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
  return null
}


/** An LBP pool's normalized rows: its terms, liquidity and trades, keyed by the pool account (pure, for the tests). */
export interface LbpPoolRows {
  pool: string
  created: EventRow
  updated: EventRow[]
  added: EventRow[]
  removed: EventRow[]
  trades: EventRow[]
}
export function lbpPoolsOf(rows: readonly EventRow[]): LbpPoolRows[] {
  const pools = new Map<string, LbpPoolRows>()
  const byPair = new Map<string, LbpPoolRows>()
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const sorted = [...rows].sort((a, b) => a.block_height - b.block_height || a.event_index - b.event_index)
  for (const r of sorted) {
    const a = parse(r.args_json)
    if (r.event_name === 'LBP.PoolCreated') {
      const pool = str(a.pool).toLowerCase()
      const assets = (a.data as { assets?: unknown[] } | undefined)?.assets
      if (!/^0x[0-9a-f]{64}$/.test(pool) || !Array.isArray(assets) || assets.length !== 2) continue
      const p: LbpPoolRows = { pool, created: r, updated: [], added: [], removed: [], trades: [] }
      pools.set(pool, p)
      // A pair holds one pool at a time (its account derives from the pair): a later pool over it replaces the earlier for trades.
      byPair.set(pairKey(Number(assets[0]), Number(assets[1])), p)
      continue
    }
    if (r.event_name === 'LBP.PoolUpdated') { pools.get(str(a.pool).toLowerCase())?.updated.push(r); continue }
    if (r.event_name === 'LBP.LiquidityAdded') { pools.get(str(a.who).toLowerCase())?.added.push(r); continue }
    if (r.event_name === 'LBP.LiquidityRemoved') { pools.get(str(a.who).toLowerCase())?.removed.push(r); continue }
    if (r.event_name === 'LBP.SellExecuted' || r.event_name === 'LBP.BuyExecuted') byPair.get(pairKey(Number(a.assetIn), Number(a.assetOut)))?.trades.push(r)
  }
  return [...pools.values()]
}

/** A pool's terms as they stand: its creation's, each PoolUpdated restating the whole pool (start and end only once set). */
export function lbpPoolTerms(p: Pick<LbpPoolRows, 'created' | 'updated'>): Record<string, unknown> {
  const terms = { ...((parse(p.created.args_json).data ?? {}) as Record<string, unknown>) }
  for (const u of p.updated) Object.assign(terms, (parse(u.args_json).data ?? {}) as Record<string, unknown>)
  return terms
}

/**
 * One LBP pool as a bond's primary-sale source, or null when it does not sell a bond.
 * `relayOf` maps a fill's block to the relay block it executed at; `window` dates a
 * relay block of the sale window (null for one the chain has not reached); `faceRate`
 * is how many face units (raw, bond decimals) one whole payment unit was worth at an
 * instant, at that hour's closes (null when unpriced) — read once per fill, it gives
 * both the fill's face value and the curve's conversion.
 */
export function lbpBondSale(p: LbpPoolRows, ctx: Pick<BondSaleContext, 'isBond' | 'underlyingOf'>, at: {
  relayOf: (block: number) => number | null
  window: (relay: number) => { block: number; ms: number } | null
  faceRate: (bondId: number, paymentId: number, ms: number) => bigint | null
  paymentDecimals: (assetId: number) => number
  /** The fill blocks' swap-family events (lbpFillRowEvents); absent, a fill is named by its own event. */
  blockEvents?: readonly BlockSwapEvent[]
}): BondSale | null {
  const terms = lbpPoolTerms(p)
  // Asset A is the accumulated asset (the payment, the fee asset); B is distributed.
  const assets = (terms.assets as unknown[] | undefined)?.map(Number) ?? []
  if (assets.length !== 2) return null
  const [paymentAssetId, bondId] = assets
  if (!ctx.isBond(bondId)) return null
  const underlyingId = ctx.underlyingOf(bondId)
  if (underlyingId == null) return null
  const kind: BondSaleKind = ctx.isBond(paymentAssetId) ? 'rollover' : 'sale'
  const fee = lbpFeeOf(terms.fee)
  const startRelay = Number(terms.start), endRelay = Number(terms.end)
  if (!fee || !Number.isInteger(startRelay) || !Number.isInteger(endRelay) || startRelay <= 0 || endRelay <= startRelay) return null
  let seedPay = 0n, seedBonds = 0n
  for (const r of p.added) {
    const a = parse(r.args_json)
    if (Number(a.assetA) !== paymentAssetId || !isRaw(str(a.amountA)) || !isRaw(str(a.amountB))) continue
    seedPay += BigInt(str(a.amountA)); seedBonds += BigInt(str(a.amountB))
  }
  if (!p.added.length) return null
  const rem = p.removed.length ? p.removed[p.removed.length - 1] : null
  const remArgs = rem ? parse(rem.args_json) : null
  const start = at.window(startRelay), end = at.window(endRelay)
  const faced = !paysInFaceUnits(paymentAssetId, underlyingId)
  const unit = 10n ** BigInt(at.paymentDecimals(paymentAssetId))
  const rateAt = (ms: number | null | undefined): bigint | null => (faced && ms != null ? at.faceRate(bondId, paymentAssetId, ms) : null)
  const fills: BondSaleFill[] = []
  const fillRelay: Array<number | null> = []
  const fillRate: Array<string | null> = []
  for (const r of p.trades) {
    const a = parse(r.args_json)
    // LBP.SellExecuted and LBP.BuyExecuted both carry `amount` in and salePrice / buyPrice out.
    const amountIn = str(a.amount), amountOut = str(r.event_name === 'LBP.SellExecuted' ? a.salePrice : a.buyPrice), feeAmount = str(a.feeAmount)
    if (!isRaw(amountIn) || !isRaw(amountOut)) continue
    const buy = Number(a.assetIn) === paymentAssetId
    const paymentFee = isRaw(feeAmount) ? feeAmount : '0'
    // The pool prices a buy on its GROSS amount (fee included) and the buyer pays that
    // gross, the pool keeping `amount` and the collector the fee; a sell receives
    // `salePrice`/`buyPrice` (the pool pays the fee besides).
    const paid = buy ? (BigInt(amountIn) + BigInt(paymentFee)).toString() : amountOut
    const ms = r.ts * 1000
    const rate = rateAt(ms)
    const who = str(a.who).toLowerCase()
    fills.push({
      block: r.block_height, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index, atMs: ms,
      taker: who, side: buy ? 'buy' : 'sell', paid, bonds: buy ? amountOut : amountIn, fee: '0', paymentFee,
      rowEvents: lbpFillRowEvents({ block: r.block_height, eventIndex: r.event_index, extrinsicIndex: r.extrinsic_index }, who, at.blockEvents ?? []),
      ...(faced ? { paidFace: rate == null ? null : (BigInt(paid) * rate / unit).toString() } : {}), partial: false,
    })
    fillRelay.push(at.relayOf(r.block_height))
    fillRate.push(rate?.toString() ?? null)
  }
  const lbp: BondLbpTerms = {
    pool: p.pool, owner: str(terms.owner).toLowerCase(), feeCollector: str(terms.feeCollector).toLowerCase(), fee,
    initialWeight: Number(terms.initialWeight), finalWeight: Number(terms.finalWeight),
    startRelay, endRelay, startMs: start?.ms ?? null, endMs: end?.ms ?? null,
    seed: { block: p.added[0].block_height, payment: seedPay.toString(), bonds: seedBonds.toString() },
    returned: rem && remArgs && isRaw(str(remArgs.amountA)) && isRaw(str(remArgs.amountB))
      ? { block: rem.block_height, atMs: rem.ts * 1000, payment: str(remArgs.amountA), bonds: str(remArgs.amountB) } : null,
    fillRelay,
    faceRate: { start: rateAt(start?.ms)?.toString() ?? null, end: rateAt(end?.ms)?.toString() ?? null, fills: fillRate },
  }
  return {
    venue: 'lbp', id: p.pool, bondId, kind, paymentAssetId, issuerAccounts: [p.pool],
    offered: seedBonds.toString(), asked: null,
    openedBlock: start?.block ?? p.created.block_height, openedMs: start?.ms ?? p.created.ts * 1000,
    // The sale closes at its end block (trading stops there), not when the owner empties the pool.
    closedBlock: end?.block ?? null, closedMs: end?.ms ?? null,
    fills, ...(faced ? { facedAtEventTime: true } : {}), lbp,
  }
}

/** An open sale's price now: its spot at `relay` from its replayed reserves, and that in face units at `nowMs`'s close (pure, for the tests). */
export function lbpSpotNow(s: BondSale, relay: number, faceRateAt: (ms: number) => bigint | null, nowMs: number, decimalsOf: (assetId: number) => number): BondLbpTerms['spot'] {
  const r = lbpReplay(s, decimalsOf)
  if (!r || !s.lbp) return null
  const pay = lbpSpotWad(r.reservePay, r.reserveBond, lbpPaymentWeight(s.lbp, relay), decimalsOf(s.paymentAssetId), decimalsOf(s.bondId))
  if (pay == null) return null
  const rate = faceRateAt(nowMs)
  return { relay, payWad: pay.toString(), faceWad: rate == null ? null : (pay * rate / 10n ** BigInt(decimalsOf(s.bondId))).toString() }
}

const LBP_WINDOW_BLOCKS = new Map<string, { block: number; ms: number }>()
const BLOCK_SWAP_EVENT_NAMES = ['Router.Executed', 'Router.RouteExecuted', 'Omnipool.SellExecuted', 'Omnipool.BuyExecuted', 'Stableswap.SellExecuted', 'Stableswap.BuyExecuted', 'XYK.SellExecuted', 'XYK.BuyExecuted', 'LBP.SellExecuted', 'LBP.BuyExecuted', 'DCA.TradeExecuted']
export const LBP_BOND_SALE_SOURCE: BondSaleSource = {
  venue: 'lbp',
  async load(ch, bondIds, ctx, toBlock) {
    if (!bondIds.length) return []
    const bound = toBlock != null ? 'AND block_height <= {b:UInt32}' : ''
    const rows = await select<EventRow>(ch, `-- bond:lbp-events
      SELECT block_height, event_index, extrinsic_index, toUnixTimestamp(block_timestamp) AS ts, event_name, args_json
      FROM price_data.lbp_activity FINAL WHERE 1 ${bound}`, { b: toBlock ?? 0 })
    const ids = new Set(bondIds)
    const pools = lbpPoolsOf(rows).map(p => ({ p, terms: lbpPoolTerms(p) }))
      .filter(({ terms }) => Array.isArray(terms.assets) && ids.has(Number((terms.assets as unknown[])[1])))
    if (!pools.length) return []
    // The relay block every fill executed at, the swap-family events of the fills'
    // blocks (each fill's trade-row identity, lbpFillRowEvents), and the Hydration
    // block the sale window's relay blocks first reached — each a primary-key read.
    const tradeBlocks = [...new Set(pools.flatMap(({ p }) => p.trades.map(t => t.block_height)))]
    const [relayRows, blockEvents] = tradeBlocks.length ? await Promise.all([
      select<{ block_height: number; relay: number }>(ch, `-- bond:lbp-relay
        SELECT block_height, any(relay_parent_number) AS relay FROM price_data.block_relay_height
        WHERE block_height IN {bs:Array(UInt32)} GROUP BY block_height`, { bs: tradeBlocks }),
      select<BlockSwapEvent>(ch, `-- bond:lbp-row-events
        SELECT block_height, event_index, extrinsic_index, event_name, lower(JSONExtractString(args_json, 'who')) AS who
        FROM price_data.raw_events
        WHERE block_height IN {bs:Array(UInt32)} AND event_name IN {names:Array(String)}`, { bs: tradeBlocks, names: BLOCK_SWAP_EVENT_NAMES }),
    ]) : [[], []]
    const relayByBlock = new Map(relayRows.map(r => [Number(r.block_height), Number(r.relay)]))
    const windows = new Map<number, { block: number; ms: number } | null>()
    for (const { p, terms } of pools) {
      for (const relay of [Number(terms.start), Number(terms.end)]) {
        if (!Number.isInteger(relay) || relay <= 0 || windows.has(relay)) continue
        // A relay block's first Hydration block is a chain fact: once found it is kept.
        const known = LBP_WINDOW_BLOCKS.get(`${p.pool}:${relay}`)
        if (known) { windows.set(relay, toBlock == null || known.block <= toBlock ? known : null); continue }
        const [hit] = await select<{ block_height: number; ts: number }>(ch, `-- bond:lbp-window
          SELECT r.first_block AS block_height, toUnixTimestamp(b.block_timestamp) AS ts
          FROM (SELECT min(block_height) AS first_block FROM price_data.block_relay_height
                WHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32} AND relay_parent_number >= {r:UInt32}) r
          INNER JOIN (SELECT block_height, block_timestamp FROM price_data.raw_blocks WHERE block_height >= {lo:UInt32} AND block_height < {hi:UInt32}) b ON b.block_height = r.first_block
          WHERE r.first_block > 0 ${toBlock != null ? 'AND r.first_block <= {b:UInt32}' : ''}`,
        { lo: p.created.block_height, hi: p.created.block_height + 1_000_000, r: relay, b: toBlock ?? 0 })
        const found = hit ? { block: Number(hit.block_height), ms: Number(hit.ts) * 1000 } : null
        if (found) LBP_WINDOW_BLOCKS.set(`${p.pool}:${relay}`, found)
        windows.set(relay, found)
      }
    }
    // Event-time face rates: the payment's hourly USD close over the underlying's, the
    // flows rule (services/eventTimeCloses.ts: the newest candle closed by the instant,
    // at most PRICE_LOOKBACK_DAYS old). Imported on use: it reads the registry this
    // module is a dependency of.
    const { loadHourlyFlowPricer } = await import('./eventTimeCloses.ts')
    const hour = (ms: number) => Math.floor(ms / 3_600_000) * 3_600
    const flows: Array<{ assetId: number; hourSec: number }> = []
    for (const { p, terms } of pools) {
      const assets = (terms.assets as unknown[]).map(Number)
      const u = ctx.underlyingOf(assets[1])
      if (u == null) continue
      const instants = [...p.trades.map(t => t.ts * 1000), ...[Number(terms.start), Number(terms.end)].map(r => windows.get(r)?.ms).filter((m): m is number => m != null)]
      // A sale whose end the chain has not reached is valued now (lbpSpotNow).
      if (windows.get(Number(terms.end)) == null) instants.push(Date.now())
      for (const ms of instants) flows.push({ assetId: assets[0], hourSec: hour(ms) }, { assetId: u, hourSec: hour(ms) })
    }
    const pricer = await loadHourlyFlowPricer(ch, flows)
    const faceRate = (bondId: number, paymentId: number, ms: number): bigint | null => {
      const u = ctx.underlyingOf(bondId)
      if (u == null) return null
      // Face units per whole payment unit: (its USD) × 10^face decimals ÷ (one whole underlying's USD).
      const pay = pricer.usd(paymentId, 10n ** BigInt(ctx.decimalsOf(paymentId)), hour(ms))
      const und = pricer.usd(u, 10n ** BigInt(ctx.decimalsOf(u)), hour(ms))
      return pay == null || und == null || und <= 0n ? null : pay * 10n ** BigInt(ctx.decimalsOf(bondId)) / und
    }
    const sales = pools.map(({ p }) => lbpBondSale(p, ctx, {
      relayOf: b => relayByBlock.get(b) ?? null, window: r => windows.get(r) ?? null, faceRate, paymentDecimals: ctx.decimalsOf, blockEvents,
    })).filter((s): s is BondSale => s != null)
    // A sale still standing is valued at what a buy executes at now (bonds.ts saleAnchor):
    // the pool's spot at the newest relay block, from its replayed reserves.
    const open = sales.filter(s => s.closedMs == null)
    if (open.length) {
      const [head] = await select<{ relay: number }>(ch, `-- bond:lbp-head
        SELECT max(relay_parent_number) AS relay FROM price_data.block_relay_height
        WHERE block_height >= {lo:UInt32} ${toBlock != null ? 'AND block_height <= {b:UInt32}' : ''}`,
      { lo: Math.min(...open.map(s => s.openedBlock)), b: toBlock ?? 0 })
      const nowMs = Date.now()
      for (const s of open) s.lbp!.spot = head && Number(head.relay) > 0 ? lbpSpotNow(s, Number(head.relay), ms => faceRate(s.bondId, s.paymentAssetId, ms), nowMs, ctx.decimalsOf) : null
    }
    return sales
  },
}

/** A block's swap-family events, for naming the trade row each LBP fill is. */
export interface BlockSwapEvent { block_height: number; event_index: number; extrinsic_index: number | null; event_name: string; who: string }
const ROUTER_NET = new Set(['Router.Executed', 'Router.RouteExecuted'])
/** The route executor's pallet account: a routed hop names it as `who`. */
export const ROUTER_PALLET_ACCOUNT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'
/**
 * The event(s) each fill's trade row carries as its identity, by the trade feed's
 * grouping (explorerService groupSwapRows / swapRouteReps): a signed fill belongs to the
 * route whose net summary (Router.Executed / RouteExecuted) first follows it in its
 * extrinsic, which stands for it; a signed fill with none after it shares the
 * extrinsic's tail group, whose newest swap event stands for it; an unsigned routed hop
 * (the router pallet's `who`) is its block's next net summary, an unsigned direct fill
 * itself; and a DCA execution is identified by the DCA.TradeExecuted that follows its
 * swap. Two fills one route closes share its row.
 */
export function lbpFillRowEvents(fill: Pick<BondSaleFill, 'block' | 'eventIndex' | 'extrinsicIndex'>, who: string, events: readonly BlockSwapEvent[]): number[] {
  const inBlock = events.filter(e => e.block_height === fill.block).sort((a, b) => a.event_index - b.event_index)
  let rep: number
  if (fill.extrinsicIndex != null) {
    const same = inBlock.filter(e => e.extrinsic_index === fill.extrinsicIndex)
    const closing = same.find(e => ROUTER_NET.has(e.event_name) && e.event_index > fill.eventIndex)
    if (closing) rep = closing.event_index
    else {
      const lastNet = Math.max(-1, ...same.filter(e => ROUTER_NET.has(e.event_name)).map(e => e.event_index))
      rep = Math.max(fill.eventIndex, ...same.filter(e => !ROUTER_NET.has(e.event_name) && e.event_name !== 'DCA.TradeExecuted' && e.event_index > lastNet).map(e => e.event_index))
    }
  } else {
    const hop = who === ROUTER_PALLET_ACCOUNT
    rep = hop ? inBlock.find(e => e.extrinsic_index == null && ROUTER_NET.has(e.event_name) && e.event_index > fill.eventIndex)?.event_index ?? fill.eventIndex : fill.eventIndex
  }
  const out = [rep]
  if (fill.extrinsicIndex == null) {
    const dca = inBlock.find(e => e.extrinsic_index == null && e.event_name === 'DCA.TradeExecuted' && e.event_index > rep)
    if (dca) out.push(dca.event_index)
  }
  return out
}


/** Every venue's primary-sale sources. */
export const BOND_SALE_SOURCES: readonly BondSaleSource[] = [OTC_BOND_SALE_SOURCE, LBP_BOND_SALE_SOURCE]
export async function loadBondSales(ch: ClickHouseClient, bondIds: readonly number[], ctx: BondSaleContext, toBlock?: number): Promise<BondSale[]> {
  return (await Promise.all(BOND_SALE_SOURCES.map(s => s.load(ch, bondIds, ctx, toBlock)))).flat()
}
