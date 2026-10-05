// User Revenue — Uniswap v3 LP fees (A4 lp_fee_uniswap_v3) and the Gamma vaults
// as custodies.
//
// EXACT per position: every pool is replayed from its Initialize with the pool's
// own arithmetic (uniswapV3Math: computeSwapStep, the tick bitmap walk,
// FullMath) — each Swap event re-run to its logged sqrtPrice step by step, its
// LP fee (less the protocol's 1/feeProtocol, per step) added to
// feeGrowthGlobal over the in-range liquidity, ticks crossed flipping their
// feeGrowthOutside; each Mint/Burn updating the ticks and the position
// (Position.update: tokensOwed += liquidity × Δ feeGrowthInside / 2^128). A
// position's fee accrual is booked at every swap as the change of
// floor(liquidity × (feeGrowthInside − feeGrowthInsideLast) / 2^128) — a
// cumulative floor that telescopes to exactly what the chain credits it at its
// next update — so booked == collected + uncollected to the unit. Every Collect
// is checked against the replay (fees realized + principal burned − collected
// before); every Swap's closing tick and liquidity against its log.
//
// An exact-input swap's last step leaves its rounding dust in the fee
// (computeSwapStep: fee = remaining − amountIn); replaying to the logged price
// recovers it as the logged input less what the steps paid.
//
// Every position on these pools belongs to a Gamma vault (a Hypervisor). A vault
// collects its positions' fees at each ZeroBurn and sends owed/fee of them (the
// vault fee, SetFee: 255) to the Treasury: booked here per position as the
// cumulative floor of its fees since its last Collect ÷ the fee in force, so the
// cut telescopes to the chain's floor(owed / fee) at each collection; the rest
// is the vault's, which passes it to its share holders (loadVaultCustodies).

import type { ClickHouseClient } from '../db/client.ts'
import { chTimestamp } from './clickhouseTime.ts'
import {
  hourIndexOfBlock,
  joinVia,
  userRevenueRows as rows,
  type CustodyResolution,
  type CustodyResolver,
  type FactSink,
  type FoldWindow,
  type Ledger,
} from './userRevenueFold.ts'
import { LedgerMap } from './userRevenueLp.ts'
import { splitProRata } from './userRevenueMath.ts'
import { ethMappedAccount } from './userRevenueStreams.ts'
import { computeSwapStep, getSqrtRatioAtTick, getTickAtSqrtRatio, mulDiv, nextInitializedTickWithinOneWord, MAX_TICK, MIN_TICK, type V3TickNet } from './uniswapV3Math.ts'

const TREASURY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
const Q128 = 1n << 128n
const MOD = 1n << 256n
const HUGE = (1n << 200n)
const sub = (a: bigint, b: bigint): bigint => ((a - b) % MOD + MOD) % MOD

export interface V3PoolEvent {
  block: number; event: number
  kind: 'init' | 'mint' | 'burn' | 'swap' | 'collect' | 'fp' | 'vaultfee'
  owner: string; lower: number; upper: number; liquidity: bigint; tick: number
  amount0: bigint; amount1: bigint; sqrtPrice: bigint; aux0: bigint; aux1: bigint
}

/** One accrual the replay books: position owner, token side, amount; the Treasury's vault cut beside it. */
export interface V3Accrual { block: number; owner: string; side: 0 | 1; amount: bigint; vaultCut: bigint }

export interface V3ReplayStats {
  /** The pool's replay state after its last event (the next anchor's checkpoint). */
  state?: V3PoolState
  swaps: number; swapStateMismatch: number; dustNegative: number
  collects: number; collectsExact: number; collectMismatch: bigint
  noLiquidityFee: [bigint, bigint]
  /** Per position (owner|lower|upper): fees booked, fees collected (Collect − principal), and fees still owed or accruing at the end. */
  positions: Map<string, { booked: [bigint, bigint]; collectedFees: [bigint, bigint]; uncollected: [bigint, bigint] }>
}

interface Tick { gross: bigint; net: bigint; out0: bigint; out1: bigint }

/**
 * A pool's whole replay state after a block — what the month anchor carries
 * (V3_ANCHOR_POT) so a window replays only the events after the anchor block,
 * not the pool's history from its Initialize. Exact: the replay from it equals
 * the replay from the start (the state is everything the replay keeps).
 */
export interface V3PoolState {
  sqrtP: bigint; tick: number; L: bigint; g0: bigint; g1: bigint; fp0: bigint; fp1: bigint
  ticks: Array<[number, Tick]>
  positions: Pos[]
}
export const V3_ANCHOR_POT = 'v3state'

const BIG_KEYS = new Set(['sqrtP', 'L', 'g0', 'g1', 'fp0', 'fp1', 'gross', 'net', 'out0', 'out1', 'gi0', 'gi1', 'acc0', 'acc1', 'owedFee0', 'owedFee1', 'owedPrincipal0', 'owedPrincipal1', 'period0', 'period1', 'cut0', 'cut1'])
export function serializeV3State(st: V3PoolState): string {
  return JSON.stringify(st, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}
export function parseV3State(text: string): V3PoolState {
  return JSON.parse(text, (k, v) => (BIG_KEYS.has(k) && typeof v === 'string' ? BigInt(v) : v)) as V3PoolState
}

interface Pos { owner: string; lower: number; upper: number; L: bigint; gi0: bigint; gi1: bigint; acc0: bigint; acc1: bigint; owedFee0: bigint; owedFee1: bigint; owedPrincipal0: bigint; owedPrincipal1: bigint; period0: bigint; period1: bigint; cut0: bigint; cut1: bigint }

/**
 * Replays one pool's events (ascending) and reports every fee accrual from
 * `fromBlock` on (exclusive) through `onAccrual`; `vaultFeeOf(owner, block)` is
 * the Gamma vault fee divisor in force (0: none / not a vault).
 */
export function replayV3Pool(
  events: readonly V3PoolEvent[], fee: number, tickSpacing: number, fromBlock: number,
  vaultFeeOf: (owner: string, block: number) => bigint,
  onAccrual: (a: V3Accrual) => void,
  onNoLiquidity: (block: number, side: 0 | 1, amount: bigint) => void,
  initial: V3PoolState | null = null,
): V3ReplayStats {
  const stats: V3ReplayStats = { swaps: 0, swapStateMismatch: 0, dustNegative: 0, collects: 0, collectsExact: 0, collectMismatch: 0n, noLiquidityFee: [0n, 0n], positions: new Map() }
  let sqrtP = 0n, tick = 0, L = 0n, g0 = 0n, g1 = 0n, fp0 = 0n, fp1 = 0n
  const ticks = new Map<number, Tick>()
  let table: V3TickNet[] = []
  const rebuild = () => { table = [...ticks.entries()].filter(([, t]) => t.gross > 0n).map(([k, t]) => ({ tick: k, liquidityNet: t.net })).sort((a, b) => a.tick - b.tick) }
  const positions = new Map<string, Pos>()
  if (initial) {
    ({ sqrtP, tick, L, g0, g1, fp0, fp1 } = initial)
    for (const [t, x] of initial.ticks) ticks.set(t, { ...x })
    for (const p of initial.positions) {
      const key = `${p.owner}|${p.lower}|${p.upper}`
      positions.set(key, { ...p })
      stats.positions.set(key, { booked: [0n, 0n], collectedFees: [0n, 0n], uncollected: [0n, 0n] })
    }
    rebuild()
  }
  const inside = (p: Pos): [bigint, bigint] => {
    const lo = ticks.get(p.lower)!, up = ticks.get(p.upper)!
    const b0 = tick >= p.lower ? lo.out0 : sub(g0, lo.out0), b1 = tick >= p.lower ? lo.out1 : sub(g1, lo.out1)
    const a0 = tick < p.upper ? up.out0 : sub(g0, up.out0), a1 = tick < p.upper ? up.out1 : sub(g1, up.out1)
    return [sub(sub(g0, b0), a0), sub(sub(g1, b1), a1)]
  }
  const accrue = (p: Pos, block: number) => {
    if (p.L === 0n) return
    const [i0, i1] = inside(p)
    const n0 = mulDiv(sub(i0, p.gi0), p.L, Q128) & ((1n << 128n) - 1n)
    const n1 = mulDiv(sub(i1, p.gi1), p.L, Q128) & ((1n << 128n) - 1n)
    const d0 = n0 - p.acc0, d1 = n1 - p.acc1
    p.acc0 = n0; p.acc1 = n1
    for (const [side, d] of [[0, d0], [1, d1]] as const) {
      if (d === 0n) continue
      const divisor = vaultFeeOf(p.owner, block)
      let cut = 0n
      if (side === 0) { p.period0 += d; if (divisor > 0n) { const c = p.period0 / divisor; cut = c - p.cut0; p.cut0 = c } }
      else { p.period1 += d; if (divisor > 0n) { const c = p.period1 / divisor; cut = c - p.cut1; p.cut1 = c } }
      if (block > fromBlock) onAccrual({ block, owner: p.owner, side, amount: d, vaultCut: cut })
      const st = stats.positions.get(`${p.owner}|${p.lower}|${p.upper}`)!
      st.booked[side] += d
    }
  }
  const updateTick = (t: number, delta: bigint, upper: boolean) => {
    let x = ticks.get(t)
    if (!x) { x = { gross: 0n, net: 0n, out0: 0n, out1: 0n }; ticks.set(t, x) }
    if (x.gross === 0n && delta > 0n && t <= tick) { x.out0 = g0; x.out1 = g1 }
    x.gross += delta
    x.net += upper ? -delta : delta
  }
  for (const ev of events) {
    if (ev.kind === 'init') { sqrtP = ev.sqrtPrice; tick = ev.tick; continue }
    if (ev.kind === 'fp') { fp0 = ev.aux0; fp1 = ev.aux1; continue }
    if (ev.kind === 'vaultfee') continue
    if (ev.kind === 'mint' || ev.kind === 'burn') {
      const key = `${ev.owner}|${ev.lower}|${ev.upper}`
      let p = positions.get(key)
      if (!p) {
        p = { owner: ev.owner, lower: ev.lower, upper: ev.upper, L: 0n, gi0: 0n, gi1: 0n, acc0: 0n, acc1: 0n, owedFee0: 0n, owedFee1: 0n, owedPrincipal0: 0n, owedPrincipal1: 0n, period0: 0n, period1: 0n, cut0: 0n, cut1: 0n }
        positions.set(key, p)
        stats.positions.set(key, { booked: [0n, 0n], collectedFees: [0n, 0n], uncollected: [0n, 0n] })
      }
      const delta = ev.kind === 'mint' ? ev.liquidity : -ev.liquidity
      if (delta !== 0n) {
        updateTick(ev.lower, delta, false)
        updateTick(ev.upper, delta, true)
      }
      // Position.update: credit the fees since the last update, then move the liquidity.
      if (p.L > 0n) accrue(p, ev.block)
      p.owedFee0 += p.acc0; p.owedFee1 += p.acc1
      p.acc0 = 0n; p.acc1 = 0n
      const [i0, i1] = ticks.has(ev.lower) && ticks.has(ev.upper) ? inside(p) : [0n, 0n]
      p.gi0 = i0; p.gi1 = i1
      p.L += delta
      if (ev.kind === 'burn') { p.owedPrincipal0 += ev.amount0; p.owedPrincipal1 += ev.amount1 }
      if (tick >= ev.lower && tick < ev.upper) L += delta
      if (delta < 0n) for (const t of [ev.lower, ev.upper]) if (ticks.get(t)!.gross === 0n) ticks.delete(t)
      if (delta !== 0n) rebuild()
      continue
    }
    if (ev.kind === 'collect') {
      const p = positions.get(`${ev.owner}|${ev.lower}|${ev.upper}`)
      if (!p) continue
      stats.collects++
      // Fees first, then principal (the chain collects tokensOwed whole; the split is the replay's).
      const owed0 = p.owedFee0 + p.owedPrincipal0, owed1 = p.owedFee1 + p.owedPrincipal1
      if (ev.amount0 === owed0 && ev.amount1 === owed1) stats.collectsExact++
      else stats.collectMismatch += (ev.amount0 - owed0 < 0n ? owed0 - ev.amount0 : ev.amount0 - owed0) + (ev.amount1 - owed1 < 0n ? owed1 - ev.amount1 : ev.amount1 - owed1)
      const st = stats.positions.get(`${p.owner}|${p.lower}|${p.upper}`)!
      const f0 = ev.amount0 < p.owedFee0 ? ev.amount0 : p.owedFee0
      const f1 = ev.amount1 < p.owedFee1 ? ev.amount1 : p.owedFee1
      st.collectedFees[0] += f0; st.collectedFees[1] += f1
      p.owedFee0 -= f0; p.owedFee1 -= f1
      p.owedPrincipal0 -= ev.amount0 - f0; p.owedPrincipal1 -= ev.amount1 - f1
      // The vault fee period ends with the collection (ZeroBurn takes owed / fee of it).
      p.period0 = 0n; p.period1 = 0n; p.cut0 = 0n; p.cut1 = 0n
      continue
    }
    // A swap, re-run to its logged price.
    stats.swaps++
    const zeroForOne = ev.amount0 > 0n
    const input = zeroForOne ? ev.amount0 : ev.amount1
    const limit = ev.sqrtPrice
    const fpDiv = zeroForOne ? fp0 : fp1
    const applyFee = (feeAmount: bigint, liquidity: bigint) => {
      let lp = feeAmount
      if (fpDiv > 0n) lp -= lp / fpDiv
      if (liquidity > 0n) {
        const gInc = mulDiv(lp, Q128, liquidity)
        if (zeroForOne) g0 = (g0 + gInc) % MOD
        else g1 = (g1 + gInc) % MOD
      } else if (lp > 0n) {
        stats.noLiquidityFee[zeroForOne ? 0 : 1] += lp
        onNoLiquidity(ev.block, zeroForOne ? 0 : 1, lp)
      }
    }
    if (limit === sqrtP) {
      // No price move: the whole input is the fee (computeSwapStep's exact-input remainder).
      applyFee(input, L)
    } else {
      let paid = 0n
      let guard = 0
      while (sqrtP !== limit && guard++ < 100_000) {
        let [tickNext, initialized] = nextInitializedTickWithinOneWord(table, tick, tickSpacing, zeroForOne)
        if (tickNext < MIN_TICK) tickNext = MIN_TICK
        else if (tickNext > MAX_TICK) tickNext = MAX_TICK
        const sqrtNext = getSqrtRatioAtTick(tickNext)
        const target = (zeroForOne ? sqrtNext < limit : sqrtNext > limit) ? limit : sqrtNext
        const step = computeSwapStep(sqrtP, target, L, HUGE, fee)
        const start = sqrtP
        sqrtP = step.sqrtRatioNextX96
        let stepFee = step.feeAmount
        // The last step: an exact-input swap leaves its rounding remainder in the fee.
        if (sqrtP === limit) {
          const dust = input - (paid + step.amountIn + step.feeAmount)
          if (dust < 0n) stats.dustNegative++
          else stepFee += dust
        }
        paid += step.amountIn + stepFee
        applyFee(stepFee, L)
        if (sqrtP === sqrtNext) {
          if (initialized) {
            const t = ticks.get(tickNext)
            if (t) { t.out0 = sub(g0, t.out0); t.out1 = sub(g1, t.out1); L += zeroForOne ? -t.net : t.net }
          }
          tick = zeroForOne ? tickNext - 1 : tickNext
        } else if (sqrtP !== start) {
          tick = getTickAtSqrtRatio(sqrtP)
        }
      }
    }
    if (tick !== ev.tick || L !== ev.liquidity) stats.swapStateMismatch++
    for (const p of positions.values()) accrue(p, ev.block)
  }
  for (const [k, p] of positions) {
    const st = stats.positions.get(k)!
    st.uncollected = [p.owedFee0 + p.acc0, p.owedFee1 + p.acc1]
  }
  stats.state = { sqrtP, tick, L, g0, g1, fp0, fp1, ticks: [...ticks.entries()].map(([t, x]) => [t, { ...x }]), positions: [...positions.values()].map(p => ({ ...p })) }
  return stats
}


/** A4: the window's v3 LP fees, exact per position; the vault cut to the Treasury; the position owners' part to the vault custody. */
export async function buildV3LpFees(
  client: ClickHouseClient, w: FoldWindow, anchor: { rows: ReadonlyArray<{ pot: string; holder: string; aux: string }>; block: number } | null = null,
): Promise<{ ledgers: Ledger[]; stats: Map<string, V3ReplayStats>; closing: Array<{ pot: string; holder: string; exposure_id: string; units: bigint; aux: string }> }> {
  const out = new LedgerMap(w.hours)
  const statsOut = new Map<string, V3ReplayStats>()
  // From a checkpoint: each pool's state at the anchor block, and only the events after it (a pool with no state
  // row was not initialized by then and replays from its Initialize, which lies after the anchor).
  const initial = new Map<string, V3PoolState>()
  for (const r of anchor?.rows ?? []) if (r.pot === V3_ANCHOR_POT) initial.set(r.holder, parseV3State(r.aux))
  const from = anchor?.block ?? 0
  const pools = await rows<{ pool: string; t0: string; t1: string; fee: string; ts: string }>(client, `
    SELECT lower(pool_address) AS pool, lower(any(token0)) AS t0, lower(any(token1)) AS t1, any(fee) AS fee, any(tick_spacing) AS ts
    FROM price_data.uniswap_v3_pools GROUP BY pool`, {}, 'ur:v3-pool-tokens')
  if (!pools.length) return { ledgers: [], stats: statsOut, closing: [] }
  const assets = await rows<{ id: string; evm: string }>(client, `SELECT asset_id AS id, lower(argMax(evm_address, observed_block)) AS evm FROM price_data.assets GROUP BY asset_id HAVING evm != ''`, {}, 'ur:v3-assets')
  const byEvm = new Map(assets.map(a => [a.evm, Number(a.id)]))
  const events = await rows<{ pool: string; b: string; e: string; n: string; owner: string; tl: string; tu: string; liq: string; tick: string; a0: string; a1: string; sp: string; x0: string; x1: string }>(client, `
    SELECT lower(contract_address) AS pool, block_height AS b, event_index AS e, any(event_name) AS n, lower(argMax(owner, ingested_at)) AS owner,
           argMax(tick_lower, ingested_at) AS tl, argMax(tick_upper, ingested_at) AS tu, toString(argMax(liquidity, ingested_at)) AS liq,
           argMax(tick, ingested_at) AS tick, toString(argMax(amount0, ingested_at)) AS a0, toString(argMax(amount1, ingested_at)) AS a1,
           toString(argMax(sqrt_price_x96, ingested_at)) AS sp, toString(argMax(aux0, ingested_at)) AS x0, toString(argMax(aux1, ingested_at)) AS x1
    FROM price_data.uniswap_v3_events
    WHERE ((kind = 'pool' AND event_name IN ('Mint', 'Burn', 'Swap', 'Initialize', 'SetFeeProtocol', 'Collect'))
        OR (kind = 'vault' AND event_name = 'SetFee')) AND block_height <= {hi:UInt32}
      AND (block_height > {from:UInt32} OR (kind = 'vault' AND event_name = 'SetFee'))
    GROUP BY pool, b, e ORDER BY b, e`, { hi: w.lastBlock, from }, 'ur:v3-events')
  const KIND: Record<string, V3PoolEvent['kind']> = { Mint: 'mint', Burn: 'burn', Swap: 'swap', Initialize: 'init', SetFeeProtocol: 'fp', Collect: 'collect', SetFee: 'vaultfee' }
  const byPool = new Map<string, V3PoolEvent[]>()
  const vaultFees = new Map<string, Array<{ block: number; fee: bigint }>>()
  for (const r of events) {
    const kind = KIND[r.n]
    if (kind === 'vaultfee') { const l = vaultFees.get(r.pool) ?? []; l.push({ block: Number(r.b), fee: BigInt(r.x0 || '0') }); vaultFees.set(r.pool, l); continue }
    const list = byPool.get(r.pool) ?? []
    list.push({
      block: Number(r.b), event: Number(r.e), kind, owner: r.owner, lower: Number(r.tl), upper: Number(r.tu), liquidity: BigInt(r.liq || '0'),
      tick: Number(r.tick), amount0: BigInt(r.a0 || '0'), amount1: BigInt(r.a1 || '0'), sqrtPrice: BigInt(r.sp || '0'), aux0: BigInt(r.x0 || '0'), aux1: BigInt(r.x1 || '0'),
    })
    byPool.set(r.pool, list)
  }
  const vaultFeeOf = (owner: string, block: number): bigint => {
    let f = 0n
    for (const x of vaultFees.get(owner) ?? []) if (x.block <= block) f = x.fee
    return f
  }
  for (const p of pools) {
    const assetOf = [byEvm.get(p.t0), byEvm.get(p.t1)] as const
    const pot = `v3:${p.pool}`
    const stats = replayV3Pool(byPool.get(p.pool) ?? [], Number(p.fee), Number(p.ts), w.openBlock, vaultFeeOf,
      a => {
        const asset = assetOf[a.side]
        if (asset == null || a.block > w.lastBlock) return
        const h = hourIndexOfBlock(w, a.block)
        if (a.vaultCut !== 0n) out.add(TREASURY, 'lp_fee_uniswap_v3', pot, `gamma-vault:${a.owner}>gamma-vault-fee`, asset, null, 'event', h, a.vaultCut)
        out.add(ethMappedAccount(a.owner), 'lp_fee_uniswap_v3', pot, '', asset, null, 'event', h, a.amount - a.vaultCut)
      },
      (block, side, amount) => {
        const asset = assetOf[side]
        if (asset == null || block <= w.openBlock || block > w.lastBlock) return
        out.add('', 'lp_fee_uniswap_v3', pot, 'v3-no-liquidity', asset, null, 'event', hourIndexOfBlock(w, block), amount)
      },
      initial.get(p.pool) ?? null)
    statsOut.set(p.pool, stats)
  }
  const closing = [...statsOut].filter(([, st]) => st.state && st.state.sqrtP > 0n)
    .map(([pool, st]) => ({ pot: V3_ANCHOR_POT, holder: pool, exposure_id: '', units: 0n, aux: serializeV3State(st.state!) }))
  return { ledgers: out.ledgers(), stats: statsOut, closing }
}

/** The Gamma vaults as custodies: their share holders at each hour's start (the vault fee is already the Treasury's: buildV3LpFees). */
/** The vault-share checkpoint in a month's anchor: one row per (vault, holder) with a positive share balance at the anchor block. */
export const VAULT_ANCHOR_POT_PREFIX = 'vault:'

export async function loadVaultCustodies(
  client: ClickHouseClient, w: FoldWindow, _sink: FactSink, accountOf: (h160: string) => string,
  anchor: { rows: ReadonlyArray<{ pot: string; holder: string; units: bigint }>; block: number } | null = null,
): Promise<{ resolvers: Map<string, CustodyResolver>; closing: Array<{ pot: string; holder: string; exposure_id: string; units: bigint; aux: string }> }> {
  const vaults = await rows<{ v: string }>(client, 'SELECT DISTINCT lower(vault_address) AS v FROM price_data.uniswap_v3_vaults', {}, 'ur:v3-vault-list')
  // The anchor holds at the last block before the month: every row after it is dated in the month or later, so the
  // month partition prunes the read (the table is partitioned by month, keyed holder-first).
  const out = new Map<string, CustodyResolver>()
  const closing: Array<{ pot: string; holder: string; exposure_id: string; units: bigint; aux: string }> = []
  if (!vaults.length) return { resolvers: out, closing }
  const from = anchor?.block ?? 0
  const list = vaults.map(v => v.v)
  const [deltas] = await Promise.all([
    rows<{ c: string; h: string; b: string; d: string }>(client, `
      SELECT contract_address AS c, holder AS h, block_height AS b, toString(sum(dd)) AS d FROM (
        SELECT contract_address, holder, block_height, event_index, leg_index, argMax(balance_delta, ingested_at) AS dd
        FROM price_data.erc20_transfer_deltas WHERE contract_address IN {list:Array(String)} AND block_height > {from:UInt32} AND block_height <= {hi:UInt32}
          ${anchor ? 'AND block_timestamp >= {fromTs:DateTime}' : ''}
        GROUP BY contract_address, holder, block_height, event_index, leg_index)
      GROUP BY c, h, b ORDER BY b`, { list, hi: w.lastBlock, from, fromTs: chTimestamp(w.monthStart) }, 'ur:v3-vault-shares'),
  ])
  for (const vault of list) {
    const ds = deltas.filter(d => d.c === vault).map(d => ({ block: Number(d.b), holder: d.h, delta: BigInt(d.d) }))
    // Hour-start share balances, from the checkpoint's balances at the anchor block.
    const snaps: Array<Array<[string, bigint]>> = []
    const bal = new Map<string, bigint>()
    for (const r of anchor?.rows ?? []) if (r.pot === `${VAULT_ANCHOR_POT_PREFIX}${vault}`) bal.set(r.holder, r.units)
    let di = 0
    for (let h = 0; h < w.hours; h++) {
      const at = h === 0 ? w.openBlock : w.hourBlocks[h - 1].last
      while (di < ds.length && ds[di].block <= at) { bal.set(ds[di].holder, (bal.get(ds[di].holder) ?? 0n) + ds[di].delta); di++ }
      snaps.push([...bal.entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    while (di < ds.length) { bal.set(ds[di].holder, (bal.get(ds[di].holder) ?? 0n) + ds[di].delta); di++ }
    for (const [holder, units] of bal) if (units > 0n) closing.push({ pot: `${VAULT_ANCHOR_POT_PREFIX}${vault}`, holder, exposure_id: '', units, aux: '' })
    const kind = `gamma-vault:${vault}`
    out.set(ethMappedAccount(vault), {
      kind,
      async resolve(ledger: Ledger): Promise<CustodyResolution> {
        const H = ledger.amounts.length
        const parts = new LedgerMap(H)
        const remainder = new Array<bigint>(H).fill(0n)
        for (let h = 0; h < H; h++) {
          const rest = ledger.amounts[h]
          if (rest === 0n) continue
          // The vault fee is already the Treasury's (buildV3LpFees, per accrual at the fee in force): the rest passes whole.
          const split = splitProRata(rest, snaps[h])
          let given = 0n
          for (const [holder, part] of split) {
            parts.add(accountOf(holder), ledger.stream, ledger.pot, joinVia(ledger.via, kind), ledger.asset, null, ledger.price, h, part)
            given += part
          }
          remainder[h] += rest - given
        }
        return { parts: parts.ledgers(), remainder, remainderVia: 'custody:gamma-vault' }
      },
    })
  }
  return { resolvers: out, closing }
}
