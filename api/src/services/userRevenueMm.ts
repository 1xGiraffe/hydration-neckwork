// User Revenue — money markets (C1 mm_supply_interest, C2 mm_borrow_interest)
// and the GIGAHDX yield (E2), which rides the gigahdx market's stHDX aToken.
//
// C1/C2: a holder's balanceOf is rayMul(scaled, I(t)) — I the reserve's
// normalizedIncome (aToken) or normalizedDebt (variable-debt token) at the
// block's timestamp, compounded by aaveMath from the reserve's last
// ReserveDataUpdated (an Initialization-phase update accrued to the PARENT
// block's timestamp). Over a stretch of constant scaled balance the interest is
//   rayMul(s, I(t₂)) − rayMul(s, I(t₁))
// so a holder's interest per hour is that sum over the hour's stretches, split at
// every block its scaled balance changed (atoken_scaled_deltas: principal moves,
// never interest). Summed over an unchanged holding it telescopes to the
// balanceOf difference exactly (V1). Supply interest is earned (+), borrow
// interest paid (−). Coverage starts at B0 (MM_COVERAGE_FROM_BLOCK), where the
// scaled balances are the chain's own (atoken_scaled_anchor).
//
// Each isolated market is its own pot (`<market>:<reserve asset>`); the holders
// are H160s, booked in the ETH-mapped account form (the account_revenue
// convention, folded to the owner by the readers' bind map) — except an H160
// that is the truncated form of a known custody account (a pool account holding
// aTokens), which is booked to that account so the custody passes it on.

import type { ClickHouseClient } from '../db/client.ts'
import { normalizedDebt, normalizedIncome, RAY } from './aaveMath.ts'
import { hourIndexOfBlock, userRevenueCompactRows as compactRows, userRevenueRows as rows, type FoldWindow, type Ledger } from './userRevenueFold.ts'
import { MM_COVERAGE_FROM_BLOCK, UNATTRIBUTED_VIA, ethMappedAccount } from './userRevenueStreams.ts'
import { gigahdxBookings, splitProRata } from './userRevenueMath.ts'

export interface MmContract {
  contract: string
  side: 'supply' | 'debt'
  reserve: string
  pool: string
  market: string
  /** The reserve's registry asset (what the interest is denominated in). */
  reserveAsset: number
  /** The aToken's own registry id (supply side), for a custody holding it. */
  aTokenAsset: number | null
}

const HOLLAR_RESERVE = '0x531a654d1696ed52e7275a8cede955e82620f99a'
export function reserveAssetOf(reserve: string): number {
  const r = reserve.toLowerCase()
  if (r.startsWith('0x0000000000000000000000000000000100')) return parseInt(r.slice(-8), 16)
  return r === HOLLAR_RESERVE ? 222 : 0
}

export async function loadMmContracts(client: ClickHouseClient): Promise<MmContract[]> {
  const [map, assets] = await Promise.all([
    rows<{ reserve: string; atoken: string; vdebt: string; pool: string; market: string }>(client, `
      SELECT DISTINCT lower(asset_address) AS reserve, lower(atoken) AS atoken, lower(vdebt) AS vdebt, lower(pool_proxy) AS pool, market_key AS market
      FROM price_data.atoken_reserve_map FINAL`, {}, 'ur:mm-map'),
    rows<{ id: string; evm: string }>(client, `SELECT asset_id AS id, lower(argMax(evm_address, observed_block)) AS evm FROM price_data.assets GROUP BY asset_id HAVING evm != ''`, {}, 'ur:mm-assets'),
  ])
  const byEvm = new Map(assets.map(a => [a.evm, Number(a.id)]))
  const out: MmContract[] = []
  for (const r of map) {
    const reserveAsset = reserveAssetOf(r.reserve)
    if (r.atoken) out.push({ contract: r.atoken, side: 'supply', reserve: r.reserve, pool: r.pool, market: r.market, reserveAsset, aTokenAsset: byEvm.get(r.atoken) ?? null })
    if (r.vdebt) out.push({ contract: r.vdebt, side: 'debt', reserve: r.reserve, pool: r.pool, market: r.market, reserveAsset, aTokenAsset: null })
  }
  return out.sort((a, b) => a.contract.localeCompare(b.contract))
}

// ── reserve indices ────────────────────────────────────────────────────────────

interface IndexUpdate { block: number; event: number; liq: bigint; vbi: bigint; liqRate: bigint; vbRate: bigint; tLast: bigint }

/** Per reserve (pool:reserve), its updates in (block, event) order, carry first; indices at any block of the window. */
export class ReserveIndexBook {
  private byKey = new Map<string, IndexUpdate[]>()
  /** Updates whose phase or parent timestamp could not be stated (counted, their reserve's interest then reads 0 from there). */
  unresolved = 0

  static async load(client: ClickHouseClient, contracts: readonly MmContract[], lo: number, hi: number): Promise<ReserveIndexBook> {
    const book = new ReserveIndexBook()
    const pairs = [...new Map(contracts.map(c => [`${c.pool}:${c.reserve}`, c])).values()]
    if (!pairs.length) return book
    const pools = [...new Set(pairs.map(p => p.pool))]
    const reserves = [...new Set(pairs.map(p => p.reserve))]
    const cols = `pool_address AS pool, reserve_address AS reserve, block_height AS b, event_index AS e`
    const [idx, rates, carryIdx] = await Promise.all([
      rows<{ pool: string; reserve: string; b: string; e: string; ts: string; liq: string; vbi: string }>(client, `
        SELECT ${cols}, toUnixTimestamp(any(block_timestamp)) AS ts,
               toString(argMax(liquidity_index, ingested_at)) AS liq, toString(argMax(variable_borrow_index, ingested_at)) AS vbi
        FROM price_data.money_market_reserve_indices
        WHERE pool_address IN {pools:Array(String)} AND reserve_address IN {reserves:Array(String)}
          AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
        GROUP BY pool, reserve, b, e`, { pools, reserves, lo, hi }, 'ur:mm-indices'),
      rows<{ pool: string; reserve: string; b: string; e: string; lr: string; vr: string }>(client, `
        SELECT ${cols}, toString(argMax(liquidity_rate, ingested_at)) AS lr, toString(argMax(variable_borrow_rate, ingested_at)) AS vr
        FROM price_data.money_market_reserve_rates
        WHERE pool_address IN {pools:Array(String)} AND reserve_address IN {reserves:Array(String)}
          AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
        GROUP BY pool, reserve, b, e`, { pools, reserves, lo, hi }, 'ur:mm-rates'),
      // Each reserve's last update at or before the window's open block (the carry).
      rows<{ pool: string; reserve: string; b: string; e: string; ts: string; liq: string; vbi: string; lr: string; vr: string }>(client, `
        SELECT i.pool AS pool, i.reserve AS reserve, i.b AS b, i.e AS e, i.ts AS ts, i.liq AS liq, i.vbi AS vbi, r.lr AS lr, r.vr AS vr
        FROM (
          SELECT pool_address AS pool, reserve_address AS reserve,
                 argMax(block_height, (block_height, event_index, ingested_at)) AS b,
                 argMax(event_index, (block_height, event_index, ingested_at)) AS e,
                 toUnixTimestamp(argMax(block_timestamp, (block_height, event_index, ingested_at))) AS ts,
                 toString(argMax(liquidity_index, (block_height, event_index, ingested_at))) AS liq,
                 toString(argMax(variable_borrow_index, (block_height, event_index, ingested_at))) AS vbi
          FROM price_data.money_market_reserve_indices
          WHERE pool_address IN {pools:Array(String)} AND reserve_address IN {reserves:Array(String)} AND block_height <= {lo:UInt32}
          GROUP BY pool, reserve
        ) AS i
        LEFT JOIN (
          SELECT pool_address AS pool, reserve_address AS reserve, block_height AS b, event_index AS e,
                 toString(argMax(liquidity_rate, ingested_at)) AS lr, toString(argMax(variable_borrow_rate, ingested_at)) AS vr
          FROM price_data.money_market_reserve_rates
          WHERE pool_address IN {pools:Array(String)} AND reserve_address IN {reserves:Array(String)} AND block_height <= {lo:UInt32}
            AND block_height >= {carryLo:UInt32}
          GROUP BY pool, reserve, b, e
        ) AS r ON r.pool = i.pool AND r.reserve = i.reserve AND r.b = i.b AND r.e = i.e`,
      { pools, reserves, lo, carryLo: Math.max(0, lo - 2_000_000) }, 'ur:mm-carry'),
    ])
    const rateOf = new Map(rates.map(r => [`${r.pool}:${r.reserve}@${r.b}:${r.e}`, r]))
    const all = [
      ...carryIdx.map(r => ({ ...r, lr: r.lr, vr: r.vr })),
      ...idx.map(r => { const rr = rateOf.get(`${r.pool}:${r.reserve}@${r.b}:${r.e}`); return { ...r, lr: rr?.lr ?? '', vr: rr?.vr ?? '' } }),
    ]
    // Phase: an update logged in a block's Initialization phase accrued to the parent block's timestamp.
    const keys = all.map(r => [Number(r.b), Number(r.e)] as [number, number])
    const init = new Set<string>()
    for (let i = 0; i < keys.length; i += 4_000) {
      const chunk = keys.slice(i, i + 4_000)
      const got = await rows<{ b: string; e: string }>(client, `
        SELECT block_height AS b, event_index AS e FROM price_data.raw_events
        WHERE (block_height, event_index) IN arrayZip({b:Array(UInt32)}, {e:Array(UInt32)}) AND phase = 'Initialization'`,
      { b: chunk.map(k => k[0]), e: chunk.map(k => k[1]) }, 'ur:mm-phase')
      for (const g of got) init.add(`${g.b}:${g.e}`)
    }
    const parents = [...new Set(all.filter(r => init.has(`${r.b}:${r.e}`)).map(r => Number(r.b) - 1))]
    const parentTs = new Map<number, number>()
    for (let i = 0; i < parents.length; i += 8_000) {
      const got = await rows<{ b: string; ts: string }>(client, `
        SELECT block_height AS b, toUnixTimestamp(block_timestamp) AS ts FROM price_data.blocks WHERE block_height IN {bs:Array(UInt32)}`,
      { bs: parents.slice(i, i + 8_000) }, 'ur:mm-parent-ts')
      for (const g of got) parentTs.set(Number(g.b), Number(g.ts))
    }
    for (const r of all) {
      const key = `${r.pool}:${r.reserve}`
      const b = Number(r.b)
      const isInit = init.has(`${r.b}:${r.e}`)
      const t = isInit ? parentTs.get(b - 1) : Number(r.ts)
      if (t == null || r.lr === '' || r.lr == null) { book.unresolved++; continue }
      const list = book.byKey.get(key) ?? []
      list.push({ block: b, event: Number(r.e), liq: BigInt(r.liq), vbi: BigInt(r.vbi), liqRate: BigInt(r.lr), vbRate: BigInt(r.vr), tLast: BigInt(t) })
      book.byKey.set(key, list)
    }
    for (const list of book.byKey.values()) list.sort((a, b) => a.block - b.block || a.event - b.event)
    return book
  }

  /** The normalized income (supply) or debt index at the end of `block`, at timestamp `ts`; null before the reserve's first update. */
  indexAt(pool: string, reserve: string, side: 'supply' | 'debt', block: number, ts: number): bigint | null {
    const list = this.byKey.get(`${pool}:${reserve}`)
    if (!list?.length || list[0].block > block) return null
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (list[mid].block <= block) lo = mid
      else hi = mid - 1
    }
    const u = list[lo]
    const t = BigInt(ts) > u.tLast ? BigInt(ts) : u.tLast
    return side === 'supply' ? normalizedIncome(u.liq, u.liqRate, u.tLast, t) : normalizedDebt(u.vbi, u.vbRate, u.tLast, t)
  }
}

/** Aave's rayMul for a scaled balance that can be ≤ 0 mid-reconstruction (0 then). */
const rayMulPos = (s: bigint, i: bigint): bigint => (s > 0n ? (s * i + RAY / 2n) / RAY : 0n)

// ── scaled balances ────────────────────────────────────────────────────────────

export interface ScaledDelta { holder: string; contract: string; block: number; ts: number; delta: bigint }

/**
 * Opening scaled balances at `atBlock` (end of block): the B0 anchor plus every
 * deduplicated delta after B0 up to it, or — when `anchor` holds the month's
 * exposure anchor — that plus the deltas from the month's open block on.
 */
export async function loadOpeningScaled(
  client: ClickHouseClient, contracts: readonly MmContract[], atBlock: number,
  anchor: { rows: ReadonlyArray<{ holder: string; exposure_id: string; units: bigint }>; fromBlock: number } | null,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  const list = contracts.map(c => c.contract)
  if (atBlock < MM_COVERAGE_FROM_BLOCK) return out
  const key = (holder: string, contract: string) => `${holder}|${contract}`
  let from = MM_COVERAGE_FROM_BLOCK
  if (anchor) {
    for (const r of anchor.rows) out.set(key(r.holder, r.exposure_id), r.units)
    from = anchor.fromBlock
  } else {
    const b0 = await rows<{ holder: string; contract: string; s: string }>(client, `
      SELECT lower(holder) AS holder, lower(contract_address) AS contract, toString(argMax(scaled_balance, updated_at)) AS s
      FROM price_data.atoken_scaled_anchor
      WHERE lower(contract_address) IN {list:Array(String)} AND holder != ''
      GROUP BY holder, contract`, { list }, 'ur:mm-b0')
    for (const r of b0) out.set(key(r.holder, r.contract), BigInt(r.s))
  }
  if (atBlock > from) {
    const got = await rows<{ holder: string; contract: string; s: string }>(client, `
      SELECT holder, contract_address AS contract, toString(sum(d)) AS s FROM (
        SELECT holder, contract_address, block_height, event_index, leg_index, argMax(scaled_delta, ingested_at) AS d
        FROM price_data.atoken_scaled_deltas
        WHERE contract_address IN {list:Array(String)} AND block_height > {from:UInt32} AND block_height <= {to:UInt32}
        GROUP BY holder, contract_address, block_height, event_index, leg_index)
      GROUP BY holder, contract`, { list, from, to: atBlock }, 'ur:mm-opening')
    for (const r of got) {
      const k = key(r.holder, r.contract)
      out.set(k, (out.get(k) ?? 0n) + BigInt(r.s))
    }
  }
  return out
}

/** The window's deltas, deduplicated on their identity and summed per (holder, contract, block). */
export async function loadWindowDeltas(client: ClickHouseClient, contracts: readonly MmContract[], fromBlock: number, toBlock: number): Promise<ScaledDelta[]> {
  if (toBlock <= fromBlock) return []
  const got = await compactRows(client, `
    SELECT holder, contract_address, block_height, toUnixTimestamp(any(dts)), toString(sum(dd)) FROM (
      SELECT holder, contract_address, block_height, event_index, leg_index, any(block_timestamp) AS dts, argMax(scaled_delta, ingested_at) AS dd
      FROM price_data.atoken_scaled_deltas
      WHERE contract_address IN {list:Array(String)} AND block_height > {from:UInt32} AND block_height <= {to:UInt32}
      GROUP BY holder, contract_address, block_height, event_index, leg_index)
    GROUP BY holder, contract_address, block_height HAVING sum(dd) != 0
    ORDER BY holder, contract_address, block_height`, { list: contracts.map(c => c.contract), from: fromBlock, to: toBlock }, 'ur:mm-deltas')
  return got.map(r => ({ holder: r[0], contract: r[1], block: Number(r[2]), ts: Number(r[3]), delta: BigInt(r[4]) }))
}

// ── the builder ────────────────────────────────────────────────────────────────

export interface MmBuild {
  ledgers: Ledger[]
  /** Scaled balances at the window's last block, per (holder H160, contract) — the next anchor. */
  closing: Map<string, bigint>
  /** Per contract, the scaled balances at each hour START (holder → units), for the claims rule and GIGAHDX. */
  scaledAtHourStart: (contract: string, h: number) => ReadonlyArray<readonly [string, bigint]>
  unresolvedIndexUpdates: number
  /** The reserve indices the build read (the claims rule values claims by them). */
  book: ReserveIndexBook
  /** The window's deltas per `holder|contract`, and where the walk started (B0 or the window's open). */
  deltasOf: ReadonlyMap<string, ScaledDelta[]>
  start: { block: number; ts: number }
}

/**
 * Money-market interest of every holder over the window. `accountOf` maps an
 * H160 holder to the account it is booked under (a custody's 32-byte account
 * for its truncated form, else the ETH-mapped form).
 */
export async function buildMmInterest(
  client: ClickHouseClient, w: FoldWindow, contracts: readonly MmContract[],
  opening: Map<string, bigint>, accountOf: (h160: string) => string,
): Promise<MmBuild> {
  const H = w.hours
  const start = Math.max(w.openBlock, MM_COVERAGE_FROM_BLOCK)
  const closing = new Map(opening)
  const empty: MmBuild = { ledgers: [], closing, scaledAtHourStart: () => [], unresolvedIndexUpdates: 0, book: new ReserveIndexBook(), deltasOf: new Map(), start: { block: start, ts: w.openTs } }
  if (w.lastBlock <= MM_COVERAGE_FROM_BLOCK) return empty
  const [deltas, book] = await Promise.all([
    loadWindowDeltas(client, contracts, start, w.lastBlock),
    ReserveIndexBook.load(client, contracts, start, w.lastBlock),
  ])
  const byContract = new Map(contracts.map(c => [c.contract, c]))
  // The coverage starts inside this window: the first hour accrues from B0's end.
  const startTs = start === w.openBlock ? w.openTs : await blockTs(client, start)

  // Hour-start snapshots per contract for the custody claims rule (holder → scaled).
  const hourStart = new Map<string, Map<string, bigint>[]>()
  const ledgers: Ledger[] = []
  const deltasOf = new Map<string, ScaledDelta[]>()
  for (const d of deltas) {
    const k = `${d.holder}|${d.contract}`
    const list = deltasOf.get(k)
    if (list) list.push(d)
    else deltasOf.set(k, [d])
  }
  const keys = [...new Set([...opening.keys(), ...deltasOf.keys()])].sort()
  // Hour-end index per reserve and side, computed once.
  const hourEndIndex = new Map<string, (bigint | null)[]>()
  const endIndices = (c: MmContract): (bigint | null)[] => {
    const k = `${c.pool}:${c.reserve}:${c.side}`
    let v = hourEndIndex.get(k)
    if (!v) {
      v = w.hourBlocks.map(hb => book.indexAt(c.pool, c.reserve, c.side, hb.last, hb.lastTs))
      hourEndIndex.set(k, v)
    }
    return v
  }
  for (const k of keys) {
    const [holder, contract] = k.split('|')
    const c = byContract.get(contract)
    if (!c) continue
    let s = opening.get(k) ?? 0n
    const ds = deltasOf.get(k) ?? []
    if (s === 0n && !ds.length) continue
    const amounts = new Array<bigint>(H).fill(0n)
    const ends = endIndices(c)
    let iPrev = book.indexAt(c.pool, c.reserve, c.side, start, startTs)
    let di = 0
    let any = false
    const snaps = hourStart.get(contract) ?? Array.from({ length: H }, () => new Map<string, bigint>())
    hourStart.set(contract, snaps)
    for (let h = 0; h < H; h++) {
      // Hours that end before the coverage start (B0, inside its month) hold no stated balance and accrue nothing.
      if (w.hourBlocks[h].last <= start) continue
      if (s !== 0n) snaps[h].set(holder, s)
      let acc = 0n
      while (di < ds.length && hourIndexOfBlock(w, ds[di].block) <= h) {
        const d = ds[di++]
        const iB = book.indexAt(c.pool, c.reserve, c.side, d.block, d.ts)
        if (iB != null && iPrev != null && s > 0n) acc += rayMulPos(s, iB) - rayMulPos(s, iPrev)
        s += d.delta
        iPrev = iB ?? iPrev
      }
      const iEnd = ends[h]
      if (iEnd != null && iPrev != null && s > 0n) acc += rayMulPos(s, iEnd) - rayMulPos(s, iPrev)
      if (iEnd != null) iPrev = iEnd
      if (acc !== 0n) { amounts[h] = c.side === 'supply' ? acc : -acc; any = true }
    }
    closing.set(k, s)
    if (!any) continue
    ledgers.push({
      holder: accountOf(holder), stream: c.side === 'supply' ? 'mm_supply_interest' : 'mm_borrow_interest',
      pot: `${c.market}:${c.reserveAsset}`, via: '', asset: c.reserveAsset,
      held: c.side === 'supply' ? c.aTokenAsset : null, price: 'accrual', amounts,
    })
  }
  for (const [k, v] of closing) if (v === 0n) closing.delete(k)
  return {
    ledgers, closing, unresolvedIndexUpdates: book.unresolved, book, deltasOf, start: { block: start, ts: startTs },
    scaledAtHourStart: (contract, h) => [...(hourStart.get(contract)?.[h] ?? new Map()).entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => a.localeCompare(b)),
  }
}

async function blockTs(client: ClickHouseClient, block: number): Promise<number> {
  const got = await rows<{ ts: string }>(client, `SELECT toUnixTimestamp(block_timestamp) AS ts FROM price_data.blocks WHERE block_height = {b:UInt32}`, { b: block }, 'ur:block-ts')
  return Number(got[0]?.ts ?? 0)
}

/**
 * The H160 → account rule, the explorer's (explorerService.resolveDisplayAccountId,
 * bindCteSql): a custody's truncated H160 books to the custody; an H160 a
 * substrate account bound (EVMAccounts.Bound — its own truncation) books to that
 * account, so one person keeps one key across the substrate and EVM sides;
 * every other holder to its ETH-mapped form (a genuine EVM account).
 */
export function mmAccountOf(custodyByH160: ReadonlyMap<string, string>, boundByH160: ReadonlyMap<string, string> = new Map()): (h160: string) => string {
  return h160 => {
    const k = h160.toLowerCase()
    return custodyByH160.get(k) ?? boundByH160.get(k) ?? ethMappedAccount(h160)
  }
}

/** The explicit EVM bindings (account_alias_directory 'explicit_binding'): H160 → its substrate owner, lowercase. */
export const EVM_BINDINGS_SQL = `
    SELECT lower(evm_address) AS h, min(lower(account_id)) AS owner
    FROM price_data.account_alias_directory
    WHERE relationship = 'explicit_binding' AND alias_type = 'substrate_account_id' AND account_id != '' AND evm_address != ''
    GROUP BY h`

export async function loadEvmBindings(client: ClickHouseClient): Promise<Map<string, string>> {
  const got = await rows<{ h: string; owner: string }>(client, EVM_BINDINGS_SQL, {}, 'ur:evm-bindings')
  return new Map(got.map(r => [r.h, r.owner]))
}

// ── C3: money-market incentives ────────────────────────────────────────────────

/**
 * C3 mm_incentives: what the RewardsController accrues a holder — scaled balance
 * × Δ programme index / 10^decimals (aaveMath.incentivePending, Aave's own
 * arithmetic) — per hour, split at every block the holder's scaled balance
 * changed. The index is the programme's last emitted one (mm_incentive_index_updates:
 * every Accrued and AssetConfigUpdated) carried forward by the controller's rule
 * between emitted points: + emission/s × Δt × 10^decimals / total scaled supply,
 * capped at the distribution end. The chain floors the index at every update
 * (a programme whose index moves by a few units an hour loses the fraction each
 * time), so a stretch's interpolated index can exceed the next emitted point:
 * the walk then books the difference back (a signed step), and over any span the
 * booked accrual telescopes to the emitted points. The B0 anchor's accrued
 * amount and every holder's pending amount at B0 are opening stock, not income;
 * claims realize.
 */
export async function buildMmIncentives(
  client: ClickHouseClient, w: FoldWindow, contracts: readonly MmContract[], opening: ReadonlyMap<string, bigint>,
  mm: Pick<MmBuild, 'deltasOf' | 'start'>, accountOf: (h160: string) => string, decimalsOf: (assetId: number) => number | null,
): Promise<Ledger[]> {
  if (w.lastBlock <= MM_COVERAGE_FROM_BLOCK) return []
  const start = mm.start
  const [programmes, updates] = await Promise.all([
    rows<{ a: string; r: string; b: string; ts: string; em: string; end: string }>(client, `
      SELECT lower(asset_address) AS a, lower(reward_address) AS r, block_height AS b, toUnixTimestamp(any(block_timestamp)) AS ts,
             toString(argMax(new_emission, ingested_at)) AS em, toString(argMax(new_distribution_end, ingested_at)) AS end
      FROM price_data.mm_incentive_programmes WHERE block_height <= {hi:UInt32}
      GROUP BY a, r, b, event_index ORDER BY b, event_index`, { hi: w.lastBlock }, 'ur:inc-programmes'),
    rows<{ a: string; r: string; b: string; ts: string; idx: string }>(client, `
      SELECT lower(asset_address) AS a, lower(reward_address) AS r, block_height AS b, toUnixTimestamp(any(block_timestamp)) AS ts,
             toString(argMax(asset_index, ingested_at)) AS idx
      FROM price_data.mm_incentive_index_updates
      WHERE block_height <= {hi:UInt32} AND (block_height > {lo:UInt32} OR (asset_address, reward_address, block_height) IN (
        SELECT asset_address, reward_address, max(block_height) FROM price_data.mm_incentive_index_updates
        WHERE block_height <= {lo:UInt32} GROUP BY asset_address, reward_address))
      GROUP BY a, r, b, event_index ORDER BY b, event_index`, { lo: start.block, hi: w.lastBlock }, 'ur:inc-updates'),
  ])
  const byContract = new Map(contracts.map(c => [c.contract, c]))
  // The index interpolates over the aToken's total scaled supply at its last emitted point. A point
  // before the window's walk start needs the supply THEN: the opening total less the scaled deltas
  // between it and the start, read from raw — so a window starting anywhere books what the month does.
  const preFrom = new Map<string, number>()
  for (const u of updates) if (Number(u.b) <= start.block) preFrom.set(u.a, Math.min(preFrom.get(u.a) ?? Number.MAX_SAFE_INTEGER, Number(u.b)))
  const preDeltas = new Map<string, Array<{ block: number; delta: bigint }>>()
  if (preFrom.size) {
    const lo = Math.min(...preFrom.values())
    const got = await rows<{ c: string; b: string; d: string }>(client, `
      SELECT contract_address AS c, block_height AS b, toString(sum(dd)) AS d FROM (
        SELECT contract_address, block_height, event_index, leg_index, argMax(scaled_delta, ingested_at) AS dd
        FROM price_data.atoken_scaled_deltas
        WHERE contract_address IN {list:Array(String)} AND block_height > {lo:UInt32} AND block_height <= {hi:UInt32}
        GROUP BY contract_address, holder, block_height, event_index, leg_index)
      GROUP BY c, b HAVING sum(dd) != 0 ORDER BY c, b`, { list: [...preFrom.keys()], lo, hi: start.block }, 'ur:inc-pre-supply')
    for (const r of got) {
      if (Number(r.b) <= (preFrom.get(r.c) ?? 0)) continue
      const l = preDeltas.get(r.c) ?? []
      l.push({ block: Number(r.b), delta: BigInt(r.d) })
      preDeltas.set(r.c, l)
    }
  }
  // Per programme: config steps and index points, ascending.
  type Prog = { asset: string; reward: string; configs: Array<{ block: number; ts: number; em: bigint; end: number }>; points: Array<{ block: number; ts: number; idx: bigint }> }
  const progs = new Map<string, Prog>()
  const prog = (a: string, r: string) => {
    const k = `${a}|${r}`
    let p = progs.get(k)
    if (!p) { p = { asset: a, reward: r, configs: [], points: [] }; progs.set(k, p) }
    return p
  }
  for (const c of programmes) prog(c.a, c.r).configs.push({ block: Number(c.b), ts: Number(c.ts), em: BigInt(c.em), end: Number(c.end) })
  for (const u of updates) prog(u.a, u.r).points.push({ block: Number(u.b), ts: Number(u.ts), idx: BigInt(u.idx) })
  const out: Ledger[] = []
  for (const p of progs.values()) {
    const c = byContract.get(p.asset)
    if (!c || c.side !== 'supply') continue
    const decimals = c.aTokenAsset != null ? decimalsOf(c.aTokenAsset) : null
    const rewardAsset = reserveAssetOf(p.reward)
    if (decimals == null) continue
    const unit = 10n ** BigInt(decimals)
    // Active in the window at all? (an emission > 0 whose end lies after the window opens)
    const live = p.configs.some(cf => cf.em > 0n && cf.end > w.openTs && cf.block <= w.lastBlock)
    if (!live) continue
    // Total scaled supply of the aToken as a step function over the window.
    const totals: Array<{ block: number; total: bigint }> = []
    let total = 0n
    for (const [k, v] of opening) if (k.endsWith(`|${p.asset}`)) total += v
    // Before the start: walk the pre-window deltas back from the opening total (each entry = the total after its block).
    const pre = preDeltas.get(p.asset) ?? []
    const before: Array<{ block: number; total: bigint }> = []
    let back = total
    for (let i = pre.length - 1; i >= 0; i--) { before.push({ block: pre[i].block, total: back }); back -= pre[i].delta }
    if (preFrom.has(p.asset)) before.push({ block: preFrom.get(p.asset)!, total: back })
    totals.push(...before.reverse())
    totals.push({ block: start.block, total })
    const steps = new Map<number, bigint>()
    for (const [k, ds] of mm.deltasOf) if (k.endsWith(`|${p.asset}`)) for (const d of ds) steps.set(d.block, (steps.get(d.block) ?? 0n) + d.delta)
    for (const b of [...steps.keys()].sort((x, y) => x - y)) { total += steps.get(b)!; totals.push({ block: b, total }) }
    const totalAt = (block: number) => lastAtOrBeforeBlock(totals, block)?.total ?? 0n
    const indexAt = (block: number, ts: number): bigint | null => {
      const u = lastAtOrBeforeBlock(p.points, block)
      const cfg = lastAtOrBeforeBlock(p.configs, block)
      if (!cfg) return u?.idx ?? 0n
      const base = u ?? { block: cfg.block, ts: cfg.ts, idx: 0n }
      const from = Math.max(base.ts, cfg.ts)
      const to = Math.min(ts, cfg.end)
      const supply = totalAt(base.block)
      if (to <= from || cfg.em === 0n || supply <= 0n) return base.idx
      return base.idx + (cfg.em * BigInt(to - from) * unit) / supply
    }
    const ends = w.hourBlocks.map(hb => indexAt(hb.last, hb.lastTs))
    const keys = new Set<string>()
    for (const k of opening.keys()) if (k.endsWith(`|${p.asset}`)) keys.add(k)
    for (const k of mm.deltasOf.keys()) if (k.endsWith(`|${p.asset}`)) keys.add(k)
    for (const k of [...keys].sort()) {
      const holder = k.split('|')[0]
      let s = opening.get(k) ?? 0n
      const ds = mm.deltasOf.get(k) ?? []
      const amounts = new Array<bigint>(w.hours).fill(0n)
      let iPrev = indexAt(start.block, start.ts)
      let di = 0
      let any = false
      for (let h = 0; h < w.hours; h++) {
        if (w.hourBlocks[h].last <= start.block) continue
        let acc = 0n
        while (di < ds.length && hourIndexOfBlock(w, ds[di].block) <= h) {
          const d = ds[di++]
          const iB = indexAt(d.block, d.ts)
          if (iB != null && iPrev != null && s > 0n) acc += (s * (iB - iPrev)) / unit
          s += d.delta
          iPrev = iB ?? iPrev
        }
        const iEnd = ends[h]
        if (iEnd != null && iPrev != null && s > 0n) acc += (s * (iEnd - iPrev)) / unit
        if (iEnd != null) iPrev = iEnd
        if (acc !== 0n) { amounts[h] = acc; any = true }
      }
      // Only the holder's own key can claim a reward: one accrued to a pool, vault or aToken contract reaches none of its claimants.
      if (any) out.push({ holder: accountOf(holder), stream: 'mm_incentives', pot: `${c.market}:${c.aTokenAsset}:${rewardAsset}`, via: '', asset: rewardAsset, held: c.aTokenAsset, price: 'accrual', amounts, custodyVia: UNATTRIBUTED_VIA.incentivesUnclaimable })
    }
  }
  return out
}

function lastAtOrBeforeBlock<T extends { block: number }>(list: readonly T[], block: number): T | null {
  let lo = 0
  let hi = list.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].block <= block) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  return best >= 0 ? list[best] : null
}

// ── E2: GIGAHDX yield ──────────────────────────────────────────────────────────

/** The GIGAHDX pot (`modlgigahdx!`), the stHDX reserve's aToken in the gigahdx market. */
export const GIGAHDX_POT = '0x6d6f646c67696761686478210000000000000000000000000000000000000000'
export const GIGAHDX_ATOKEN = '0x6b9ac524ec8f08c49ec80176b138d16eb461c3d8'
export const GIGAHDX_LAUNCH_BLOCK = 12_959_351

/**
 * GIGAHDX yield: every HDX inflow into the pot is shared by the stHDX claims —
 * the gigahdx market's stHDX aToken (GIGAHDX) suppliers, by scaled balance (one
 * liquidity index for them all) — held at the end of the block before it
 * (start-of-block semantics). The pot's opening stock (what it held before the
 * first stake) and every inflow while the supply was zero book once, at the
 * first block with a positive supply, by that block's END balances
 * (userRevenueMath.gigahdxBookings). Pot outflows (unstake payouts,
 * YieldRealized) realize what was booked and create no income.
 *
 * The pot's pre-launch stock is NOT among them: the chain swept it — 326,572.9
 * HDX, the account killed and its balance transferred to the Treasury
 * (modlpy/trsry) — in the launch block itself (12,959,351, events 156–157),
 * before the pot was re-created and before the first GigaHdx.Staked
 * (12,959,441). Inflows are therefore read from the launch block on; the
 * fee-processor transfer that re-created the pot in that block (event 186) and
 * every inflow up to the first stake are the opening inflow the first stakers
 * share. An inflow at a later moment with no supply at all is booked
 * unattributed ('gigahdx-no-supply').
 */
export async function buildGigahdxYield(client: ClickHouseClient, w: FoldWindow, accountOf: (h160: string) => string): Promise<Ledger[]> {
  if (w.lastBlock < GIGAHDX_LAUNCH_BLOCK) return []
  const H = w.hours
  // The first stake and the pot's balance before it (the opening stock), from the pot's own transfers.
  const [first] = await rows<{ b: string }>(client, `
    SELECT min(block_height) AS b FROM price_data.atoken_scaled_deltas
    WHERE contract_address = {c:String} AND scaled_delta > 0`, { c: GIGAHDX_ATOKEN }, 'ur:giga-first')
  const firstSupply = Number(first?.b ?? 0) || null
  // The pot's inflows from the account-first transfer projection (account_transfer_activity,
  // MV-fed from the same raw events), deduplicated on the event identity.
  const inflowRows = await rows<{ b: string; a: string }>(client, `
    SELECT block_height AS b, toString(sum(toUInt256OrZero(amt))) AS a FROM (
      SELECT block_height, event_index, any(amount) AS amt FROM price_data.account_transfer_activity
      WHERE account = {pot:String} AND to_account = {pot:String} AND event_name = 'Balances.Transfer'
        AND block_height >= {lo:UInt32} AND block_height <= {hi:UInt32}
      GROUP BY block_height, event_index)
    GROUP BY b ORDER BY b`, { lo: firstSupply != null && w.openBlock >= firstSupply ? w.openBlock + 1 : GIGAHDX_LAUNCH_BLOCK, hi: w.lastBlock, pot: GIGAHDX_POT }, 'ur:giga-inflows')
  // Inflows before the window only matter for the opening carry (a window after the first supply books none of them).
  const all = inflowRows.map(r => ({ block: Number(r.b), amount: BigInt(r.a) }))
  const bookings = gigahdxBookings(all, 0n, firstSupply).filter(b => b.block > w.openBlock && b.block <= w.lastBlock)
  if (!bookings.length) return []
  // Holder scaled balances at each booking: opening at the window start, then deltas in block order.
  const contracts: MmContract[] = [{ contract: GIGAHDX_ATOKEN, side: 'supply', reserve: '', pool: '', market: 'gigahdx', reserveAsset: 0, aTokenAsset: 67 }]
  const opening = await loadOpeningScaled(client, contracts, w.openBlock, null)
  // In block order (the loader orders by holder for the interest walk).
  const deltas = (await loadWindowDeltas(client, contracts, w.openBlock, w.lastBlock)).sort((a, b) => a.block - b.block)
  const bal = new Map<string, bigint>()
  for (const [k, v] of opening) bal.set(k.split('|')[0], v)
  const per = new Map<string, bigint[]>()
  const book = (holder: string, h: number, amount: bigint) => {
    const l = per.get(holder) ?? new Array<bigint>(H).fill(0n)
    l[h] += amount
    per.set(holder, l)
  }
  // One split per stretch of unchanged holdings inside an hour (the inflows are per block, the holdings change rarely).
  let acc = 0n
  let segHour = -1
  const flush = () => {
    if (acc !== 0n && segHour >= 0) {
      const split = splitProRata(acc, [...bal.entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      if (!split.length) book('', segHour, acc)
      for (const [holder, part] of split) book(holder, segHour, part)
    }
    acc = 0n
  }
  let di = 0
  for (const bk of bookings) {
    const h = hourIndexOfBlock(w, bk.block)
    if (h < 0 || h >= H) continue
    // Start-of-block: the holdings at the end of b−1 (the opening inflow: at the end of block b). A segment
    // closes BEFORE the holdings move, so it is split by the holdings it accrued under.
    const moves = di < deltas.length && (deltas[di].block < bk.block || (bk.endOfBlock && deltas[di].block === bk.block))
    if (h !== segHour || moves) { flush(); segHour = h }
    while (di < deltas.length && (deltas[di].block < bk.block || (bk.endOfBlock && deltas[di].block === bk.block))) {
      const d = deltas[di++]
      bal.set(d.holder, (bal.get(d.holder) ?? 0n) + d.delta)
    }
    acc += bk.amount
  }
  flush()
  return [...per.entries()].map(([holder, amounts]) => ({
    holder: holder ? accountOf(holder) : '', stream: 'gigahdx_yield', pot: 'gigahdx', via: holder ? '' : 'gigahdx-no-supply',
    asset: 0, held: null, price: 'event' as const, amounts,
  }))
}

