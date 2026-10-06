// User Revenue — liquidity provision (A1 lp_fee_omnipool, A2 lp_fee_stableswap,
// A3 lp_fee_xyk, lp_exit_fee) and the custodies a pool account or an aToken
// contract is for the income its holdings earn.
//
// LP income is FEE / INCOME FLOW measured by its effect on the holder's claim,
// never by share-price growth:
//   * stableswap and XYK are pro-rata: an inflow into the pool (a trade fee leg
//     to the pool account, a remove fee left in the pool, the pool account's own
//     holdings' income) is shared by the share units held at the end of the
//     block before it (start-of-block semantics);
//   * the Omnipool is NOT pro-rata: a position captures c(x) of its pro-rata
//     slice by its own remove-liquidity payoff (userRevenueMath.omnipoolCapture),
//     protocol-owned shares c = ½, and the remainder is booked unattributed
//     'omnipool-hub-channel'.
// The pool's state for the Omnipool rule is the 600-block grid
// (omnipool_pool_state_history) at or before the block before the inflow; the
// positions are omnipool_position_state_events, owned per
// omnipool_position_owner_intervals (bare, or farmed → the depositor).

import { calculate_shares } from '@galacticcouncil/math-stableswap'
import type { ClickHouseClient } from '../db/client.ts'
import { assetDecimalsOrNull } from './explorerAssets.ts'
import {
  HOUR,
  bookLedger,
  hourIndexOfBlock,
  joinVia,
  proRataResolution,
  userRevenueCompactRows as compactRows,
  userRevenueRows as rows,
  type CustodyResolution,
  type CustodyResolver,
  type FactSink,
  type FoldWindow,
  type Ledger,
} from './userRevenueFold.ts'
import { OMNI_FIXED, omnipoolRemoveLiquidity } from './lpMath.ts'
import { OMNIPOOL_AT_SPOT_CAPTURE, omnipoolCapture, omnipoolPositionIncome, splitProRata, type OmnipoolInflowKind } from './userRevenueMath.ts'
import { UNATTRIBUTED_VIA } from './userRevenueStreams.ts'

export const OMNIPOOL_ACCOUNT = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'
/** The hub fee is credited to the HDX sub-pool (a hub inflow) from this block on (2026-02-16 11:28:24). */
export const HUB_FEE_TO_HDX_SUBPOOL_BLOCK = 11_394_695
/** Before the Broadcast cutover an Omnipool asset-fee leg is the WHOLE fee (legacy MVs, fee_recipient ''). */
export const LEGACY_FEE_LEG_END_BLOCK = 6_837_788
const REFERRAL_POT = '0x6d6f646c726566657272616c0000000000000000000000000000000000000000'
export const STAKING_POT = '0x6d6f646c7374616b696e67230000000000000000000000000000000000000000'

const zeros = (n: number): bigint[] => new Array<bigint>(n).fill(0n)

/** Accumulates per-(holder, stream, pot, via, asset, held) hourly amounts into ledgers. */
export class LedgerMap {
  private m = new Map<string, Ledger>()
  constructor(private readonly hours: number) {}
  add(holder: string, stream: string, pot: string, via: string, asset: number, held: number | null, price: Ledger['price'], h: number, amount: bigint, units?: bigint): void {
    if (amount === 0n || h < 0 || h >= this.hours) return
    const k = `${holder}|${stream}|${pot}|${via}|${asset}|${held ?? ''}|${price}`
    let l = this.m.get(k)
    if (!l) {
      l = { holder, stream, pot, via, asset, held, price, amounts: zeros(this.hours) }
      this.m.set(k, l)
    }
    l.amounts[h] += amount
    if (units != null) { l.units ??= zeros(this.hours); l.units[h] = units }
  }
  /** A whole row of hourly amounts at once. */
  addRow(holder: string, stream: string, pot: string, via: string, asset: number, held: number | null, price: Ledger['price'], amounts: readonly bigint[]): void {
    const k = `${holder}|${stream}|${pot}|${via}|${asset}|${held ?? ''}|${price}`
    let l = this.m.get(k)
    if (!l) {
      l = { holder, stream, pot, via, asset, held, price, amounts: zeros(this.hours) }
      this.m.set(k, l)
    }
    for (let h = 0; h < this.hours; h++) if (amounts[h] !== 0n) l.amounts[h] += amounts[h]
  }
  ledgers(): Ledger[] { return [...this.m.values()] }
}

// ── balances of share-like tokens ──────────────────────────────────────────────

/**
 * End-of-block balances of a set of registry assets over the window: the
 * opening (at the window's open block) and every change after it, in block
 * order. A balance observation's last value in its block wins (the highest
 * event index; a storage snapshot row, which carries none, is the block's end).
 */
export class BalanceBook {
  readonly opening = new Map<number, Map<string, bigint>>()
  readonly changes = new Map<number, Array<{ block: number; account: string; units: bigint }>>()

  static async load(
    client: ClickHouseClient, w: FoldWindow, assets: readonly number[],
    anchor: ReadonlyMap<number, ReadonlyMap<string, bigint>> | null, anchorBlock: number,
    source: 'balances' | 'xyk' = 'balances',
  ): Promise<BalanceBook> {
    const book = new BalanceBook()
    for (const a of assets) { book.opening.set(a, new Map()); book.changes.set(a, []) }
    if (!assets.length) return book
    const ids = assets.map(String)
    const readRange = async (lo: number, hi: number, tag: string) => (source === 'xyk'
      ? await compactRows(client, `
          SELECT block_height, asset_id, account_id, argMax(ifNull(total, '0'), (observation_id, ingested_at))
          FROM price_data.xyk_lp_share_observations
          WHERE asset_id IN {ids:Array(Int32)} AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
          GROUP BY block_height, asset_id, account_id ORDER BY block_height`, { ids: assets, lo, hi }, tag)
      : await compactRows(client, `
          SELECT block_height, asset_id, account_id,
                 argMax(ifNull(total, '0'), (ifNull(source_event_index, 4294967295), observation_id, ingested_at))
          FROM price_data.raw_balance_observations
          WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32} AND asset_kind = 'substrate'
            AND asset_id IN {ids:Array(String)} AND account_id != ''
          GROUP BY block_height, asset_id, account_id ORDER BY block_height`, { ids, lo, hi }, tag)
    ).map(r => ({ b: r[0], a: r[1], acct: r[2], t: r[3] }))
    if (anchor) {
      for (const [a, m] of anchor) { const o = book.opening.get(a); if (o) for (const [acct, u] of m) o.set(acct, u) }
      // Advance the anchor (month start) to the window's open block.
      if (w.openBlock > anchorBlock) {
        for (const r of await readRange(anchorBlock, w.openBlock, 'ur:bal-advance')) {
          const o = book.opening.get(Number(r.a))!
          o.set(r.acct, BigInt(r.t || '0'))
        }
      }
    } else if (w.openBlock > 0) {
      // From scratch: each holder's last observation at or before the open block.
      const got = source === 'xyk'
        ? await rows<{ a: string; acct: string; t: string }>(client, `
            SELECT asset_id AS a, account_id AS acct, argMax(ifNull(total, '0'), (block_height, observation_id, ingested_at)) AS t
            FROM price_data.xyk_lp_share_observations
            WHERE asset_id IN {ids:Array(Int32)} AND block_height <= {hi:UInt32}
            GROUP BY a, acct`, { ids: assets, hi: w.openBlock }, 'ur:bal-scratch')
        : await rows<{ a: string; acct: string; t: string }>(client, `
            SELECT asset_id AS a, account_id AS acct,
                   argMax(ifNull(total, '0'), (block_height, ifNull(source_event_index, 4294967295), observation_id, ingested_at)) AS t
            FROM price_data.raw_balance_observations
            WHERE block_height <= {hi:UInt32} AND asset_kind = 'substrate' AND asset_id IN {ids:Array(String)} AND account_id != ''
            GROUP BY a, acct`, { ids, hi: w.openBlock }, 'ur:bal-scratch')
      for (const r of got) book.opening.get(Number(r.a))!.set(r.acct, BigInt(r.t || '0'))
    }
    for (const r of await readRange(w.openBlock, w.lastBlock, 'ur:bal-window')) {
      book.changes.get(Number(r.a))!.push({ block: Number(r.b), account: r.acct, units: BigInt(r.t || '0') })
    }
    return book
  }

  /** A forward cursor over one asset's balances. */
  cursor(asset: number): BalanceCursor { return new BalanceCursor(this.opening.get(asset) ?? new Map(), this.changes.get(asset) ?? []) }

  /** Every asset's balances at the window's end (the next anchor). */
  closing(): Map<number, Map<string, bigint>> {
    const out = new Map<number, Map<string, bigint>>()
    for (const a of this.opening.keys()) {
      const c = this.cursor(a)
      c.advanceTo(Number.MAX_SAFE_INTEGER)
      out.set(a, new Map([...c.balances].filter(([, v]) => v > 0n)))
    }
    return out
  }
}

export class BalanceCursor {
  readonly balances: Map<string, bigint>
  private i = 0
  /** Bumped by every applied change (a distribution segment ends at a change). */
  epoch = 0
  constructor(opening: ReadonlyMap<string, bigint>, private readonly changes: ReadonlyArray<{ block: number; account: string; units: bigint }>) {
    this.balances = new Map(opening)
  }
  /** Whether a change at or before `block` is still to be applied. */
  pendingUpTo(block: number): boolean {
    return this.i < this.changes.length && this.changes[this.i].block <= block
  }
  /** Applies every change at or before `block` (end of that block). */
  advanceTo(block: number): void {
    while (this.i < this.changes.length && this.changes[this.i].block <= block) {
      const c = this.changes[this.i++]
      if (c.units > 0n) this.balances.set(c.account, c.units)
      else this.balances.delete(c.account)
      this.epoch++
    }
  }
  private cached: { epoch: number; list: Array<[string, bigint]> } | null = null
  /** The positive holdings, in account order (cached until the next change). */
  holders(): Array<[string, bigint]> {
    if (this.cached?.epoch !== this.epoch) {
      this.cached = { epoch: this.epoch, list: [...this.balances.entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) }
    }
    return this.cached.list
  }
}

// ── pro-rata pools: stableswap and XYK ─────────────────────────────────────────

export interface PoolInflow { block: number; asset: number; amount: bigint; stream: string }

/**
 * Shares block-level inflows of one pool over its share holders at the end of the
 * block before each (start-of-block semantics), aggregated per (hour, balance
 * segment) so a distribution runs once per stretch of unchanged holdings.
 * Holders' income lands as ledgers (a custody holder's is passed on later).
 */
export function distributePoolInflows(
  w: FoldWindow, out: LedgerMap, pot: string, cursor: BalanceCursor, inflows: readonly PoolInflow[], shareAsset: number,
): void {
  const sorted = [...inflows].sort((a, b) => a.block - b.block)
  let acc = new Map<string, bigint>() // `${asset}|${stream}` → amount
  let segHour = -1
  const flush = () => {
    if (!acc.size || segHour < 0 || segHour >= w.hours) { acc = new Map(); return }
    const holders = cursor.holders()
    for (const [k, total] of acc) {
      const [asset, stream] = k.split('|')
      const split = splitProRata(total, holders)
      if (!split.length) { out.add('', stream, pot, UNATTRIBUTED_VIA.rounding, Number(asset), null, 'event', segHour, total); continue }
      let given = 0n
      for (const [account, part] of split) {
        out.add(account, stream, pot, '', Number(asset), shareAsset, 'event', segHour, part, cursor.balances.get(account))
        given += part
      }
      if (total !== given) out.add('', stream, pot, UNATTRIBUTED_VIA.rounding, Number(asset), null, 'event', segHour, total - given)
    }
    acc = new Map()
  }
  for (const f of sorted) {
    const h = hourIndexOfBlock(w, f.block)
    // A segment closes BEFORE the holdings move, so it is split by the holdings it accrued under.
    if (h !== segHour || cursor.pendingUpTo(f.block - 1)) { flush(); segHour = h }
    cursor.advanceTo(f.block - 1)
    if (h < 0 || h >= w.hours) continue
    const k = `${f.asset}|${f.stream}`
    acc.set(k, (acc.get(k) ?? 0n) + f.amount)
  }
  flush()
}

export interface StableswapPool { poolId: number; account: string }

/** Every stableswap pool and its account (the fee legs' recipient), from the legs themselves. */
export async function loadStableswapPools(client: ClickHouseClient): Promise<StableswapPool[]> {
  const got = await rows<{ p: string; acct: string }>(client, `
    SELECT toUInt32OrZero(pool_key) AS p, any(fee_recipient) AS acct FROM price_data.pool_swap_legs
    WHERE venue = 'stableswap' AND leg_kind = 'fee' AND fee_recipient != '' AND block_height >= ${LEGACY_FEE_LEG_END_BLOCK}
    GROUP BY p ORDER BY p`, {}, 'ur:ss-pools')
  return got.map(r => ({ poolId: Number(r.p), account: r.acct.toLowerCase() })).filter(p => p.poolId > 0)
}

export interface XykPool { lpAsset: number; account: string }
export async function loadXykPools(client: ClickHouseClient): Promise<XykPool[]> {
  const got = await rows<{ lp: string; acct: string }>(client, `
    SELECT lp_asset_id AS lp, lower(argMax(pool_account, ingested_at)) AS acct FROM price_data.xyk_pool_registry GROUP BY lp ORDER BY lp`, {}, 'ur:xyk-pools')
  return got.map(r => ({ lpAsset: Number(r.lp), account: r.acct }))
}

/** A venue's fee legs retained by its pools in the window, deduplicated on the leg identity, summed per (pool, block, asset). */
async function feeLegs(client: ClickHouseClient, w: FoldWindow, venue: string): Promise<Array<{ pool: string; block: number; asset: number; amount: bigint; recipient: string }>> {
  const got = await compactRows(client, `
    SELECT pool_key, block_height, asset_id, fee_recipient, toString(sum(leg_amount)) FROM (
      SELECT pool_key, block_height, event_index, leg_index,
             argMax(asset_id, ingested_at) AS asset_id, argMax(toUInt256OrZero(amount), ingested_at) AS leg_amount,
             argMax(fee_recipient, ingested_at) AS fee_recipient
      FROM price_data.pool_swap_legs
      WHERE venue = {venue:String} AND leg_kind = 'fee'
        AND block_timestamp >= {from:DateTime} AND block_timestamp < {to:DateTime}
        AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
      GROUP BY pool_key, block_height, event_index, leg_index)
    GROUP BY pool_key, block_height, asset_id, fee_recipient`, {
    venue, lo: w.openBlock, hi: w.lastBlock,
    from: new Date((w.fromHour - HOUR) * 1000).toISOString().slice(0, 19).replace('T', ' '),
    to: new Date((w.fromHour + (w.hours + 1) * HOUR) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  }, `ur:legs-${venue}`)
  return got.map(r => ({ pool: r[0], block: Number(r[1]), asset: Number(r[2]), amount: BigInt(r[4]), recipient: r[3].toLowerCase() }))
}

/** Stableswap remove fees (Stableswap.LiquidityRemoved.fee, in the withdrawn asset): income to the pool, paid by the remover. */
async function stableswapRemoveFees(client: ClickHouseClient, w: FoldWindow): Promise<Array<{ pool: number; block: number; asset: number; fee: bigint; who: string }>> {
  const got = await rows<{ b: string; args: string }>(client, `
    SELECT block_height AS b, argMax(args_json, ingested_at) AS args FROM price_data.raw_events
    WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32} AND event_name = 'Stableswap.LiquidityRemoved'
    GROUP BY block_height, event_index`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:ss-remove-fees')
  const out: Array<{ pool: number; block: number; asset: number; fee: bigint; who: string }> = []
  for (const r of got) {
    const a = JSON.parse(r.args) as { poolId: number; who: string; amounts?: Array<{ assetId: number }>; fee?: string }
    const fee = BigInt(a.fee ?? '0')
    // A fee is charged only on a single-asset withdrawal; a proportional one names every asset and pays 0.
    if (fee <= 0n || a.amounts?.length !== 1) continue
    out.push({ pool: Number(a.poolId), block: Number(r.b), asset: Number(a.amounts[0].assetId), fee, who: a.who.toLowerCase() })
  }
  return out
}

/** The Router pallet account: a share bought or sold through it is a routed trade, whose fee is a swap fee (out on the payer's side). */
export const ROUTER_ACCOUNT = '0x6d6f646c726f7574657265780000000000000000000000000000000000000000'

/**
 * Stableswap ADD imbalance fees: an add whose amounts are off the pool's
 * balance mints fewer shares than a fee-free add would — the difference stays
 * with the existing holders. No event field carries it, so it is the pool's own
 * math (math-stableswap calculate_shares, with the pool's fee and with fee 0)
 * applied to the add: the fee fraction 1 − shares(fee)/shares(no fee) is taken
 * at the pool's 600-block state grid row at or before the block
 * (stableswap_pool_state_history — reserves, amplification, fee, issuance,
 * pegs) and applied to the shares the add actually minted. The grid row is up
 * to 600 blocks before the add: the fee fraction carries the composition's
 * drift over that stretch (the stated approximation; the exact pre-block state
 * would be a raw_block_snapshots read whose payload granules cost ~0.8 GB of
 * decompression per add).
 */
async function stableswapAddFees(client: ClickHouseClient, w: FoldWindow): Promise<Array<{ pool: number; block: number; shares: bigint; who: string }>> {
  const adds = await rows<{ b: string; args: string }>(client, `
    SELECT block_height AS b, argMax(args_json, ingested_at) AS args FROM price_data.raw_events
    WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32} AND event_name = 'Stableswap.LiquidityAdded'
    GROUP BY block_height, event_index ORDER BY block_height, event_index`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:ss-adds')
  if (!adds.length) return []
  const poolIds = [...new Set(adds.map(a => Number((JSON.parse(a.args) as { poolId: number }).poolId)))]
  const grid = await rows<{ p: string; b: string; ids: string[]; res: string[]; amp: string; fee: string; ti: string; pn: string[]; pd: string[] }>(client, `
    SELECT pool_id AS p, block_height AS b, argMax(asset_ids, ingested_at) AS ids, argMax(reserves_raw, ingested_at) AS res,
           toString(argMax(amplification, ingested_at)) AS amp, toString(argMax(fee_permill, ingested_at)) AS fee,
           argMax(total_issuance_raw, ingested_at) AS ti, argMax(peg_num, ingested_at) AS pn, argMax(peg_den, ingested_at) AS pd
    FROM price_data.stableswap_pool_state_history
    WHERE pool_id IN {pools:Array(UInt32)} AND block_height <= {hi:UInt32} AND (block_height > {lo:UInt32} OR (pool_id, block_height) IN (
      SELECT pool_id, max(block_height) FROM price_data.stableswap_pool_state_history WHERE pool_id IN {pools:Array(UInt32)} AND block_height <= {lo:UInt32} GROUP BY pool_id))
    GROUP BY p, b ORDER BY p, b`, { pools: poolIds, lo: w.openBlock, hi: w.lastBlock }, 'ur:ss-add-grid')
  const byPool = new Map<number, typeof grid>()
  for (const g of grid) { const l = byPool.get(Number(g.p)) ?? []; l.push(g); byPool.set(Number(g.p), l) }
  const out: Array<{ pool: number; block: number; shares: bigint; who: string }> = []
  for (const a of adds) {
    const args = JSON.parse(a.args) as { poolId: number; who: string; shares: string; assets: Array<{ assetId: number; amount: string }> }
    const minted = BigInt(args.shares ?? '0')
    const rowsOf = byPool.get(Number(args.poolId)) ?? []
    let g: (typeof grid)[number] | undefined
    for (const r of rowsOf) { if (Number(r.b) <= Number(a.b) - 1) g = r; else break }
    if (!g || minted <= 0n || !args.assets?.length || BigInt(g.ti || '0') <= 0n) continue
    const ids = g.ids.map(Number)
    const reserves = JSON.stringify(ids.map((id, i) => ({ asset_id: id, amount: String(g!.res[i] ?? '0'), decimals: assetDecimalsOrNull(id) ?? 12 })))
    const pegs = JSON.stringify(ids.map((_, i) => (g!.pn?.length === ids.length ? [String(g!.pn[i]), String(g!.pd[i])] : ['1', '1'])))
    const assets = JSON.stringify(args.assets.map(x => ({ asset_id: Number(x.assetId), amount: String(x.amount) })))
    try {
      const withFee = BigInt(calculate_shares(reserves, assets, g.amp, g.ti, String(Number(g.fee) / 1e6), pegs) || '0')
      const noFee = BigInt(calculate_shares(reserves, assets, g.amp, g.ti, '0', pegs) || '0')
      if (withFee <= 0n || noFee <= withFee) continue
      // The add's own minted shares, grossed up by the fee fraction the grid state gives.
      const fee = (minted * (noFee - withFee)) / withFee
      if (fee > 0n) out.push({ pool: Number(args.poolId), block: Number(a.b), shares: fee, who: String(args.who).toLowerCase() })
    } catch { /* the math refuses the state: nothing booked */ }
  }
  return out
}

export interface PoolBuild {
  ledgers: Ledger[]
  balances: BalanceBook
}

/** A2: stableswap fee legs and remove fees, shared pro rata by the pool's share holders; the remover's remove fee as lp_exit_fee. */
export async function buildStableswap(client: ClickHouseClient, w: FoldWindow, pools: readonly StableswapPool[], balances: BalanceBook): Promise<Ledger[]> {
  const out = new LedgerMap(w.hours)
  const [legs, removes, adds] = await Promise.all([feeLegs(client, w, 'stableswap'), stableswapRemoveFees(client, w), stableswapAddFees(client, w)])
  const byPool = new Map<number, PoolInflow[]>()
  const accountOf = new Map(pools.map(p => [p.poolId, p.account]))
  for (const l of legs) {
    const pool = Number(l.pool)
    // Every stableswap fee leg stays in the pool: recipient = the pool account (legacy rows name none).
    if (l.recipient !== '' && l.recipient !== accountOf.get(pool)) continue
    const list = byPool.get(pool) ?? []
    list.push({ block: l.block, asset: l.asset, amount: l.amount, stream: 'lp_fee_stableswap' })
    byPool.set(pool, list)
  }
  // A remove or add fee stays in the pool for its holders; the payer's side is booked unless it is the
  // Router's (a share bought or sold along a route is a trade, and a trade's fee is out on the payer's side).
  for (const r of removes) {
    const list = byPool.get(r.pool) ?? []
    list.push({ block: r.block, asset: r.asset, amount: r.fee, stream: 'lp_fee_stableswap' })
    byPool.set(r.pool, list)
    if (r.who !== ROUTER_ACCOUNT) out.add(r.who, 'lp_exit_fee', `stableswap:${r.pool}`, '', r.asset, null, 'event', hourIndexOfBlock(w, r.block), -r.fee)
  }
  for (const a of adds) {
    const list = byPool.get(a.pool) ?? []
    list.push({ block: a.block, asset: a.pool, amount: a.shares, stream: 'lp_fee_stableswap' })
    byPool.set(a.pool, list)
    if (a.who !== ROUTER_ACCOUNT) out.add(a.who, 'lp_exit_fee', `stableswap:${a.pool}`, '', a.pool, null, 'event', hourIndexOfBlock(w, a.block), -a.shares)
  }
  for (const [pool, inflows] of byPool) {
    distributePoolInflows(w, out, `stableswap:${pool}`, balances.cursor(pool), inflows, pool)
  }
  return out.ledgers()
}

/** A3: XYK fee legs (to the pair's account), shared pro rata by its LP share holders. */
export async function buildXyk(client: ClickHouseClient, w: FoldWindow, pools: readonly XykPool[], shares: BalanceBook): Promise<Ledger[]> {
  const out = new LedgerMap(w.hours)
  const legs = await feeLegs(client, w, 'xyk')
  const lpOf = new Map(pools.map(p => [p.account, p.lpAsset]))
  const byPool = new Map<number, PoolInflow[]>()
  for (const l of legs) {
    const lp = lpOf.get(l.pool.toLowerCase())
    if (lp == null || (l.recipient !== '' && l.recipient !== l.pool.toLowerCase())) continue
    const list = byPool.get(lp) ?? []
    list.push({ block: l.block, asset: l.asset, amount: l.amount, stream: 'lp_fee_xyk' })
    byPool.set(lp, list)
  }
  for (const [lp, inflows] of byPool) distributePoolInflows(w, out, `xyk:${lp}`, shares.cursor(lp), inflows, lp)
  return out.ledgers()
}

// ── the Omnipool ───────────────────────────────────────────────────────────────

interface PosEvent { block: number; event: number; asset: number; shares: bigint; price: bigint; active: boolean }
interface OwnerInterval { fromBlock: number; toBlock: number; account: string }
interface GridRow { block: number; reserve: bigint; hub: bigint; shares: bigint; protocolShares: bigint }

/**
 * The Omnipool's positions, owners and state grid over a window, and the A1
 * capture rule applied to an inflow at a block.
 */
export class OmnipoolBook {
  private posEvents = new Map<string, PosEvent[]>()
  private positionsByAsset = new Map<number, string[]>()
  private owners = new Map<string, OwnerInterval[]>()
  private grid = new Map<number, GridRow[]>()
  /** Inflows a capture could not state (no grid state yet): booked whole as the remainder. */
  unstated = 0

  static async load(client: ClickHouseClient, w: FoldWindow): Promise<OmnipoolBook> {
    const book = new OmnipoolBook()
    const [events, owners, grid] = await Promise.all([
      rows<{ p: string; b: string; e: string; a: string; s: string; px: string; act: string; k: string }>(client, `
        SELECT position_id AS p, block_height AS b, event_index AS e, argMax(asset_id, ingested_at) AS a,
               argMax(shares_raw, ingested_at) AS s, argMax(price_raw, ingested_at) AS px,
               argMax(active, ingested_at) AS act, toString(argMax(event_kind, ingested_at)) AS k
        FROM price_data.omnipool_position_state_events
        WHERE block_height <= {hi:UInt32} AND position_id IN (
          SELECT position_id FROM price_data.omnipool_position_state_events
          GROUP BY position_id
          HAVING max(block_height) > {lo:UInt32} OR argMax(event_kind, (block_height, event_index)) != 'destroyed')
        GROUP BY p, b, e ORDER BY p, b, e`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:omni-positions'),
      rows<{ acct: string; p: string; fb: string; tb: string }>(client, `
        SELECT account_id AS acct, position_id AS p, valid_from_block AS fb, valid_to_block AS tb
        FROM price_data.omnipool_position_owner_intervals FINAL
        WHERE valid_from_block <= {hi:UInt32} AND (valid_to_block = 0 OR valid_to_block > {lo:UInt32})`,
      { lo: w.openBlock, hi: w.lastBlock }, 'ur:omni-owners'),
      rows<{ a: string; b: string; r: string; q: string; s: string; ps: string }>(client, `
        SELECT asset_id AS a, block_height AS b, argMax(reserve_raw, ingested_at) AS r, argMax(hub_reserve_raw, ingested_at) AS q,
               argMax(shares_raw, ingested_at) AS s, argMax(protocol_shares_raw, ingested_at) AS ps
        FROM price_data.omnipool_pool_state_history
        WHERE block_height <= {hi:UInt32} AND (block_height > {lo:UInt32} OR (asset_id, block_height) IN (
          SELECT asset_id, max(block_height) FROM price_data.omnipool_pool_state_history WHERE block_height <= {lo:UInt32} GROUP BY asset_id))
        GROUP BY a, b ORDER BY a, b`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:omni-grid'),
    ])
    for (const r of events) {
      const list = book.posEvents.get(r.p) ?? []
      list.push({
        block: Number(r.b), event: Number(r.e), asset: Number(r.a), shares: r.k === 'destroyed' ? 0n : BigInt(r.s || '0'),
        price: r.k === 'destroyed' ? 0n : BigInt(r.px || '0'), active: r.k !== 'destroyed' && Number(r.act) === 1,
      })
      book.posEvents.set(r.p, list)
    }
    for (const [p, list] of book.posEvents) {
      const asset = list.find(e => e.asset)?.asset ?? list[0].asset
      const ids = book.positionsByAsset.get(asset) ?? []
      ids.push(p)
      book.positionsByAsset.set(asset, ids)
    }
    for (const ids of book.positionsByAsset.values()) ids.sort()
    for (const r of owners) {
      const list = book.owners.get(r.p) ?? []
      list.push({ fromBlock: Number(r.fb), toBlock: Number(r.tb) || Number.MAX_SAFE_INTEGER, account: r.acct.toLowerCase() })
      book.owners.set(r.p, list)
    }
    for (const list of book.owners.values()) list.sort((a, b) => a.fromBlock - b.fromBlock)
    for (const r of grid) {
      const list = book.grid.get(Number(r.a)) ?? []
      list.push({ block: Number(r.b), reserve: BigInt(r.r || '0'), hub: BigInt(r.q || '0'), shares: BigInt(r.s || '0'), protocolShares: BigInt(r.ps || '0') })
      book.grid.set(Number(r.a), list)
    }
    return book
  }

  assets(): number[] { return [...this.positionsByAsset.keys()].sort((a, b) => a - b) }

  /** The grid row at or before `block`, and its index (a segment key). */
  gridAt(asset: number, block: number): { row: GridRow; idx: number } | null {
    const list = this.grid.get(asset)
    if (!list?.length || list[0].block > block) return null
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (list[mid].block <= block) lo = mid
      else hi = mid - 1
    }
    return { row: list[lo], idx: lo }
  }

  /** A position's state at the END of `block`. */
  stateAt(positionId: string, block: number): PosEvent | null {
    const list = this.posEvents.get(positionId)
    if (!list?.length || list[0].block > block) return null
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (list[mid].block <= block) lo = mid
      else hi = mid - 1
    }
    return list[lo].active && list[lo].shares > 0n ? list[lo] : null
  }

  /** The owner (depositor for a farmed position) at the END of `block`. */
  ownerAt(positionId: string, block: number): string | null {
    const list = this.owners.get(positionId)
    if (!list) return null
    let owner: string | null = null
    for (const iv of list) {
      if (iv.fromBlock > block) break
      if (block < iv.toBlock) owner = iv.account
    }
    return owner
  }

  private changeBlocks = new Map<number, number[]>()
  /** How many position or owner changes of `asset` lie at or before `block` — a distribution segment ends at each. */
  changeEpoch(asset: number, block: number): number {
    let list = this.changeBlocks.get(asset)
    if (!list) {
      list = []
      for (const p of this.positionsByAsset.get(asset) ?? []) {
        for (const e of this.posEvents.get(p)!) list.push(e.block)
        for (const iv of this.owners.get(p) ?? []) { list.push(iv.fromBlock); if (iv.toBlock !== Number.MAX_SAFE_INTEGER) list.push(iv.toBlock) }
      }
      list.sort((a, b) => a - b)
      this.changeBlocks.set(asset, list)
    }
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid] <= block) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Distributes an inflow D into sub-pool `asset` landing at `block`: the
   * sub-pool's state (its grid row) as of the end of block − 1, the positions as
   * of the end of `positionsAt` (block − 1; an exit fee passes `block`, the
   * post-burn positions, so a remover never captures its own fee). Returns
   * per-owner captures, the protocol shares' capture and the hub-channel
   * remainder (sum = D exactly).
   */
  // The active positions (with their owners) of each asset, advanced incrementally: every position or owner
  // change is a record; moving to a later block recomputes only the positions whose records lie in between
  // (a request for an earlier block replays the asset's records from the start).
  private records = new Map<number, Array<{ block: number; pos: string }>>()
  private cursors = new Map<number, { idx: number; at: number; active: Map<string, ActivePosition>; shares: bigint }>()
  private recordsOf(asset: number): Array<{ block: number; pos: string }> {
    let r = this.records.get(asset)
    if (!r) {
      r = []
      for (const p of this.positionsByAsset.get(asset) ?? []) {
        for (const e of this.posEvents.get(p)!) r.push({ block: e.block, pos: p })
        for (const iv of this.owners.get(p) ?? []) { r.push({ block: iv.fromBlock, pos: p }); if (iv.toBlock !== Number.MAX_SAFE_INTEGER) r.push({ block: iv.toBlock, pos: p }) }
      }
      r.sort((a, b) => a.block - b.block || (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
      this.records.set(asset, r)
    }
    return r
  }
  private activeAt(asset: number, at: number): { active: Map<string, ActivePosition>; shares: bigint } {
    const recs = this.recordsOf(asset)
    let c = this.cursors.get(asset)
    if (!c || at < c.at) { c = { idx: 0, at: -1, active: new Map(), shares: 0n }; this.cursors.set(asset, c) }
    let target = c.idx
    while (target < recs.length && recs[target].block <= at) target++
    if (target > c.idx) {
      const touched = new Set<string>()
      for (let i = c.idx; i < target; i++) touched.add(recs[i].pos)
      for (const p of touched) {
        const prev = c.active.get(p)
        if (prev) { c.shares -= prev.st.shares; c.active.delete(p) }
        const st = this.stateAt(p, at)
        if (st) { c.active.set(p, { owner: this.ownerAt(p, at) ?? '', st, capKey: '', cap: { num: 0n, den: 1n } }); c.shares += st.shares }
      }
    }
    c.idx = target
    c.at = at
    return c
  }

  distribute(asset: number, kind: OmnipoolInflowKind, block: number, D: bigint, positionsAt = block - 1): { owners: Map<string, bigint>; protocol: bigint; remainder: bigint } {
    const owners = new Map<string, bigint>()
    const g = this.gridAt(asset, block - 1)
    if (!g || D === 0n) { if (D !== 0n) this.unstated++; return { owners, protocol: 0n, remainder: D } }
    const { reserve, hub, protocolShares } = g.row
    const { active, shares } = this.activeAt(asset, positionsAt)
    const total = protocolShares + shares
    const capKey = `${g.idx}|${kind}`
    let given = 0n
    for (const a of active.values()) {
      if (a.capKey !== capKey) { a.cap = omnipoolCapture(kind, reserve, hub, a.st.price); a.capKey = capKey }
      const part = omnipoolPositionIncome(D, a.cap, a.st.shares, total)
      if (part === 0n) continue
      owners.set(a.owner, (owners.get(a.owner) ?? 0n) + part)
      given += part
    }
    // Protocol-owned shares are a position at spot: the same rule at x = 1 (½ for a units inflow).
    const atSpot = kind === 'price' ? omnipoolCapture('price', reserve, hub, (hub * OMNI_FIXED) / reserve) : OMNIPOOL_AT_SPOT_CAPTURE
    const protocol = omnipoolPositionIncome(D, atSpot, protocolShares, total)
    return { owners, protocol, remainder: D - given - protocol }
  }
}

interface ActivePosition { owner: string; st: PosEvent; capKey: string; cap: { num: bigint; den: bigint } }

/** Legacy era: the routed parts of the asset fee (to the staking and referral pots) per (block, asset), subtracted from the whole-fee legs. */
async function legacyRoutedFees(client: ClickHouseClient, w: FoldWindow): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const hi = Math.min(w.lastBlock, LEGACY_FEE_LEG_END_BLOCK)
  if (hi <= w.openBlock) return out
  // The account-first transfer projection (account_transfer_activity), keyed on the receiving pot;
  // Currencies.Transferred mirrors the pallet transfer and is not counted twice.
  const got = await rows<{ b: string; a: string; amt: string }>(client, `
    SELECT block_height AS b, asset AS a, toString(sum(toUInt256OrZero(amt))) AS amt FROM (
      SELECT block_height, event_index, any(asset_id) AS asset, any(amount) AS amt FROM price_data.account_transfer_activity
      WHERE account IN ({ref:String}, {stk:String}) AND from_account = {omni:String} AND event_name IN ('Tokens.Transfer', 'Balances.Transfer')
        AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
      GROUP BY account, block_height, event_index)
    GROUP BY b, a`, { lo: w.openBlock, hi, omni: OMNIPOOL_ACCOUNT, ref: REFERRAL_POT, stk: STAKING_POT }, 'ur:omni-legacy-routed')
  for (const r of got) out.set(`${r.b}|${r.a}`, BigInt(r.amt))
  return out
}

/** Omnipool exit fees: the withdrawal-fee rate (FixedU128) of every LiquidityRemoved. */
async function omnipoolRemovals(client: ClickHouseClient, w: FoldWindow): Promise<Array<{ block: number; who: string; position: string; asset: number; shares: bigint; feeRate: bigint }>> {
  const got = await rows<{ b: string; args: string }>(client, `
    SELECT block_height AS b, argMax(args_json, ingested_at) AS args FROM price_data.raw_events
    WHERE block_height > {lo:UInt32} AND block_height <= {hi:UInt32} AND event_name = 'Omnipool.LiquidityRemoved'
    GROUP BY block_height, event_index`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:omni-removals')
  return got.map(r => {
    const a = JSON.parse(r.args) as { who: string; positionId: string; assetId: number; sharesRemoved: string; fee?: string }
    return { block: Number(r.b), who: a.who.toLowerCase(), position: String(a.positionId), asset: Number(a.assetId), shares: BigInt(a.sharesRemoved ?? '0'), feeRate: BigInt(a.fee ?? '0') }
  }).filter(r => r.feeRate > 0n && r.shares > 0n)
}

/**
 * A1: the Omnipool's retained fee legs (the asset fee's LP part as δr; since
 * HUB_FEE_TO_HDX_SUBPOOL_BLOCK the hub fee as δq into the HDX sub-pool; before
 * LEGACY_FEE_LEG_END_BLOCK the whole asset-fee leg less the parts routed to the
 * staking and referral pots in its block) and its exit fees, each captured by
 * the positions by the payoff-response rule. Fee legs are read by recipient
 * (the Omnipool account), never through the protocol-revenue predicate: who
 * PAID a fee is irrelevant to LP income.
 */
export async function buildOmnipool(client: ClickHouseClient, w: FoldWindow, book: OmnipoolBook, sink: FactSink): Promise<Ledger[]> {
  const out = new LedgerMap(w.hours)
  const [legs, routed, removals] = await Promise.all([feeLegs(client, w, 'omnipool'), legacyRoutedFees(client, w), omnipoolRemovals(client, w)])
  // `at`: the block whose END holds the positions that capture it (block − 1; an exit fee's own block, post-burn).
  interface Inflow { block: number; at: number; asset: number; kind: OmnipoolInflowKind; amount: bigint; valueAsset: number }
  const inflows: Inflow[] = []
  const legacyGross = new Map<string, bigint>()
  for (const l of legs) {
    if (l.asset === 1) {
      if (l.recipient === OMNIPOOL_ACCOUNT && l.block >= HUB_FEE_TO_HDX_SUBPOOL_BLOCK) inflows.push({ block: l.block, at: l.block - 1, asset: 0, kind: 'hub', amount: l.amount, valueAsset: 1 })
      continue
    }
    if (l.recipient === OMNIPOOL_ACCOUNT) inflows.push({ block: l.block, at: l.block - 1, asset: l.asset, kind: 'asset', amount: l.amount, valueAsset: l.asset })
    else if (l.recipient === '' && l.block < LEGACY_FEE_LEG_END_BLOCK) {
      const k = `${l.block}|${l.asset}`
      legacyGross.set(k, (legacyGross.get(k) ?? 0n) + l.amount)
    }
  }
  for (const [k, gross] of legacyGross) {
    const [b, a] = k.split('|').map(Number)
    const retained = gross - (routed.get(k) ?? 0n)
    if (retained > 0n) inflows.push({ block: b, at: b - 1, asset: a, kind: 'asset', amount: retained, valueAsset: a })
  }
  // Exit fees: the remover's exact payoff for the removed shares (lpMath.omnipoolRemoveLiquidity at the
  // position's own price and the state before the block) is paid net of the withdrawal fee, (1 − rate) of
  // each leg as the node computes it; the withheld asset stays in the sub-pool's reserve (δr) and the
  // withheld H2O in its hub reserve (δq) — both inflows the REMAINING positions capture: they are distributed over
  // the positions after the burn (the end of the removal's block), so a full remover is credited nothing of its own fee
  // and a partial remover only through the shares it kept.
  for (const r of removals) {
    const g = book.gridAt(r.asset, r.block - 1)
    if (!g || g.row.shares <= 0n) continue
    const st = book.stateAt(r.position, r.block - 1)
    const payoff = st && st.price > 0n
      ? omnipoolRemoveLiquidity({ reserve: g.row.reserve, hub: g.row.hub, shares: g.row.shares },
          { assetId: r.asset, amount: 0n, shares: r.shares, priceNum: st.price, priceDen: OMNI_FIXED })
      : { liquidity: (r.shares * g.row.reserve) / g.row.shares, hub: 0n }
    const keep = 10n ** 18n - r.feeRate
    const h = hourIndexOfBlock(w, r.block)
    const feeAsset = payoff.liquidity - (payoff.liquidity * keep) / 10n ** 18n
    const feeHub = payoff.hub - (payoff.hub * keep) / 10n ** 18n
    if (feeAsset > 0n) {
      inflows.push({ block: r.block, at: r.block, asset: r.asset, kind: 'asset', amount: feeAsset, valueAsset: r.asset })
      out.add(r.who, 'lp_exit_fee', `omnipool:${r.asset}`, '', r.asset, null, 'event', h, -feeAsset)
    }
    if (feeHub > 0n) {
      inflows.push({ block: r.block, at: r.block, asset: r.asset, kind: 'hub', amount: feeHub, valueAsset: 1 })
      out.add(r.who, 'lp_exit_fee', `omnipool:${r.asset}`, '', 1, null, 'event', h, -feeHub)
    }
  }
  // In position-state order, so the book's incremental cursor only ever advances.
  inflows.sort((a, b) => a.at - b.at || a.block - b.block)
  // Segments: per (asset, kind, hour, grid row, position/owner epoch) one distribution.
  const segs = new Map<string, { asset: number; kind: OmnipoolInflowKind; valueAsset: number; block: number; at: number; h: number; amount: bigint }>()
  const epochCache = new Map<string, number>()
  for (const f of inflows) {
    const h = hourIndexOfBlock(w, f.block)
    if (h < 0 || h >= w.hours) continue
    const g = book.gridAt(f.asset, f.block - 1)
    const ek = `${f.asset}|${f.at}`
    let epoch = epochCache.get(ek)
    if (epoch == null) { epoch = book.changeEpoch(f.asset, f.at); epochCache.set(ek, epoch) }
    const k = `${f.asset}|${f.kind}|${f.valueAsset}|${h}|${g?.idx ?? -1}|${epoch}`
    const s = segs.get(k)
    if (s) s.amount += f.amount
    else segs.set(k, { asset: f.asset, kind: f.kind, valueAsset: f.valueAsset, block: f.block, at: f.at, h, amount: f.amount })
  }
  for (const s of segs.values()) {
    const pot = `omnipool:${s.asset}`
    const { owners, protocol, remainder } = book.distribute(s.asset, s.kind, s.block, s.amount, s.at)
    for (const [owner, part] of owners) out.add(owner, 'lp_fee_omnipool', pot, '', s.valueAsset, null, 'event', s.h, part)
    if (protocol !== 0n) sink.emit(OMNIPOOL_ACCOUNT, 'protocol', s.h, 'lp_fee_omnipool', pot, 'omnipool-protocol-shares', s.valueAsset, protocol, 'event')
    if (remainder !== 0n) sink.emit('', 'unattributed', s.h, 'lp_fee_omnipool', pot, UNATTRIBUTED_VIA.omnipoolHubChannel, s.valueAsset, remainder, 'event')
  }
  return out.ledgers()
}

/**
 * How an income on a holding of the Omnipool account enters its sub-pool. Only a
 * unit that ITSELF rebases adds units: the interest of an aToken the pool holds
 * directly (mm_supply_interest with no custody path) — an asset inflow. Everything
 * else leaves the held units unchanged and raises their value: a stableswap or
 * XYK share's fee legs (the share's NAV rises, its units do not), anything that
 * reached the pool through a claim (a wrapper's NAV) and a token's rate — a price
 * inflow. A negative accrual is captured by the same rule, signed.
 */
export function omnipoolInflowKindOf(ledger: Pick<Ledger, 'stream' | 'via'>): OmnipoolInflowKind {
  return ledger.stream === 'mm_supply_interest' && ledger.via === '' ? 'asset' : 'price'
}

/**
 * The Omnipool account as a custody: an hourly income on a holding of sub-pool
 * asset `held` (an aToken's interest on the reserve, a token's accrual) is an
 * inflow into that sub-pool at the hour's last block, captured by the A1 rule.
 */
export function omnipoolCustody(w: FoldWindow, book: OmnipoolBook, sink: FactSink): CustodyResolver {
  return {
    kind: 'omnipool',
    async resolve(ledger: Ledger): Promise<CustodyResolution> {
      const H = ledger.amounts.length
      const remainder = zeros(H)
      const parts = new LedgerMap(H)
      const asset = ledger.held
      for (let h = 0; h < H; h++) {
        const D = ledger.amounts[h]
        if (D === 0n) continue
        if (asset == null || !book.gridAt(asset, w.hourBlocks[h].last - 1)) { remainder[h] += D; continue }
        const kind = omnipoolInflowKindOf(ledger)
        const { owners, protocol, remainder: rem } = book.distribute(asset, kind, w.hourBlocks[h].last, D)
        for (const [owner, part] of owners) parts.add(owner, ledger.stream, ledger.pot, joinVia(ledger.via, 'omnipool'), ledger.asset, null, ledger.price, h, part)
        if (protocol !== 0n) sink.emit(OMNIPOOL_ACCOUNT, 'protocol', h, ledger.stream, ledger.pot, joinVia(ledger.via, 'omnipool-protocol-shares'), ledger.asset, protocol, ledger.price)
        if (rem !== 0n) sink.emit('', 'unattributed', h, ledger.stream, ledger.pot, joinVia(ledger.via, UNATTRIBUTED_VIA.omnipoolHubChannel), ledger.asset, rem, ledger.price)
      }
      return { parts: parts.ledgers(), remainder, remainderVia: 'custody:omnipool' }
    },
  }
}

/** A pool account (stableswap or XYK) as a custody: its holdings' hourly income, pro rata over its share holders at the hour's start. */
export function poolCustody(w: FoldWindow, kind: string, balances: BalanceBook, shareAsset: number): CustodyResolver {
  let snapshots: Array<Array<[string, bigint]>> | null = null
  const at = (h: number): Array<[string, bigint]> => {
    if (!snapshots) {
      snapshots = []
      const c = balances.cursor(shareAsset)
      for (let i = 0; i < w.hours; i++) {
        c.advanceTo(i === 0 ? w.openBlock : w.hourBlocks[i - 1].last)
        snapshots.push(c.holders())
      }
    }
    return snapshots[h]
  }
  return {
    kind,
    async resolve(ledger: Ledger): Promise<CustodyResolution> {
      return proRataResolution(ledger, kind, () => shareAsset, at)
    },
  }
}

/** The XYK liquidity-mining pallet account (modlXYK///LM): holds every farmed XYK share. */
export const XYK_LM_ACCOUNT = '0x6d6f646c58594b2f2f2f4c4d0000000000000000000000000000000000000000'

/**
 * The XYK LM account as a custody: the income of the shares it holds for a farm
 * goes to their depositors, pro rata by the principal each deposit locked
 * (xyk_farm_principal_intervals) at the hour's start.
 */
export async function xykFarmCustody(client: ClickHouseClient, w: FoldWindow): Promise<CustodyResolver> {
  const got = await rows<{ acct: string; lp: string; sh: string; fb: string; tb: string }>(client, `
    SELECT account_id AS acct, lp_asset_id AS lp, principal_shares_raw AS sh, valid_from_block AS fb, valid_to_block AS tb
    FROM price_data.xyk_farm_principal_intervals FINAL
    WHERE valid_from_block <= {hi:UInt32} AND (valid_to_block = 0 OR valid_to_block > {lo:UInt32})`, { lo: w.openBlock, hi: w.lastBlock }, 'ur:xyk-farm-principal')
  const intervals = got.map(r => ({ acct: r.acct.toLowerCase(), lp: Number(r.lp), shares: BigInt(r.sh || '0'), from: Number(r.fb), to: Number(r.tb) || Number.MAX_SAFE_INTEGER }))
  return {
    kind: 'xyk-farm',
    async resolve(ledger: Ledger): Promise<CustodyResolution> {
      return proRataResolution(ledger, 'xyk-farm', () => null, h => {
        const at = h === 0 ? w.openBlock : w.hourBlocks[h - 1].last
        const m = new Map<string, bigint>()
        for (const iv of intervals) if (iv.lp === ledger.held && iv.from <= at && at < iv.to) m.set(iv.acct, (m.get(iv.acct) ?? 0n) + iv.shares)
        return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      })
    },
  }
}

export { bookLedger }
