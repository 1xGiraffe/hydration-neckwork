import type { ClickHouseClient } from '../db/client.ts'
import { normalizedDebt, normalizedIncome, rayMul } from './aaveMath.ts'
import { canonicalPlan, type Bucketing } from './bucketLadder.ts'
import { cached } from './cache.ts'
import { MM_MARKETS, UNDERLYING_TO_ATOKEN_ID, assetIdFromMmAddress } from './explorerAssets.ts'
import { bucketClosePrices, type BucketPricer, type PriceGrain } from './lpHistory.ts'
import { loadMmIncentiveHistory, type MmIncentiveHistory } from './mmIncentiveHistory.ts'
import { tagged } from './queryTag.ts'

// The unclaimed lending incentives per bucket (mmIncentiveHistory.ts) ride beside the
// reserve legs — never inside suppliedUsd/borrowedUsd — the way lmRewardHistory rides
// on the LP history; re-exported so both surfaces reach them through this module.
export { loadMmIncentiveHistory, mmIncentiveSeries, type MmIncentiveHistory, type MmIncentiveHistoryItem } from './mmIncentiveHistory.ts'

// Per-account money-market history on a wall-clock bucket grid: for every reserve
// the account supplied or owed at a bucket's END, the amount the aToken's and the
// variable-debt token's balanceOf returned at that block, valued at the candle that
// had fully closed by then; beside it, per isolated market, the chain's own
// getUserAccountData observation (health factor and base-currency aggregates) as of
// its own block at or before the end. One definition shared by the explorer
// (/explorer/address/:a/money-market-history) and the Data API
// (/v1/accounts/{address}/money-market/history), so this module is an import leaf:
// it takes the ClickHouse client as an argument and imports only other leaves.
//
// Amounts are exact at the block, not at the reserve's last update: the scaled
// principal (atoken_scaled_anchor at B0 plus every indexed Mint/Burn/BalanceTransfer
// delta, holder-first) times the reserve's last emitted index compounded to the
// block's timestamp with Aave's own MathUtils (aaveMath.ts) — rayMul(scaled,
// normalizedIncome|normalizedDebt). The index's own timestamp is the one its
// ReserveDataUpdated EXECUTED under: an update in a block's Initialization phase
// (a DCA or scheduled call in on_initialize, whose EVM log carries no extrinsic
// index) runs before that block's Timestamp.set and accrued to the PARENT block's
// timestamp. money_market_reserve_indices does not carry the phase (its source,
// raw_money_market_reserves, has no extrinsic column), so it is read per selected
// update from raw_events by its full primary key — `(block_height, event_index) IN
// arrayZip(blocks, event indexes)`, one primary-key granule per selected update —
// cheaper than re-sourcing the MV and rebuilding it. An update whose event is not indexed leaves its reserve unstated at
// that bucket rather than guessed. (Every ReserveDataUpdated indexed on 2026-09-25
// has its EVM.Log event: 1,026,419 of 1,956,542 ran in the Initialization phase,
// none in Finalization.)
//
// Coverage floor: the scaled anchor block B0 (reserveHistoryFrom). A bucket ending
// before it has no reserve amounts — null, never zero — while the observations run
// from their own first row (2024-11). Health factors are the chain's number at the
// observation's block, never recomputed for the bucket end: the Aave oracle is a
// different price source from our candles, and a recomputed figure would disagree
// with the one liquidations use.
//
// Integer end to end (bigint amounts, the valuation module's 1e-12 USD); rendering
// is the callers'.
//
// Bucket ends must be dated by the EXACT at-or-before height (heightAtOrBeforeExact,
// as both callers do): then a row belongs to bucket b by its block timestamp exactly
// when it does by its height, since block timestamps strictly increase and
// endHeight(b) is the last block stamped at or before endSec(b). The large
// timestamped sources (reserve indices and rates, scaled deltas) are bucketed by
// timestamp for that reason — the height form's per-row search over the boundary
// array cost ~40% more on the 1.96M-row index fold — and the observation and
// collateral-flag sources, which carry no block timestamp, by height.

/** The markets a staking pallet backs: their supplied side is not the account's money twice (MmMarket.stakingBacked). */
const STAKING_BACKED = new Set(MM_MARKETS.filter(m => m.stakingBacked).map(m => m.key))
const MARKET_ORDER = new Map(MM_MARKETS.map((m, i) => [m.key, i]))

/**
 * The one order every money-market surface lists markets in: MM_MARKETS'
 * declaration order (the primary market first), then any key the declaration does
 * not name, by name.
 */
export function mmMarketCompare(a: string, b: string): number {
  const x = MARKET_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER
  const y = MARKET_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER
  return x !== y ? x - y : a < b ? -1 : a > b ? 1 : 0
}

/**
 * A reserve's gross USD exposure at one point: supplied plus borrowed USD, both
 * sides counted positively (a large debt is as prominent as a large supply), or
 * null when a side that is held has no price.
 */
export function reserveExposureUsd(p: { supplied: bigint; borrowed: bigint; suppliedUsd: bigint | null; borrowedUsd: bigint | null } | undefined): bigint | null {
  if (!p || (p.suppliedUsd == null && p.supplied > 0n) || (p.borrowedUsd == null && p.borrowed > 0n)) return null
  return (p.suppliedUsd ?? 0n) + (p.borrowedUsd ?? 0n)
}

/** The reserve listing order: the largest exposure first, every unpriced one after the priced, then by asset id. */
export function compareReserveExposure(a: { exposureUsd: bigint | null; assetId: number }, b: { exposureUsd: bigint | null; assetId: number }): number {
  const x = a.exposureUsd, y = b.exposureUsd
  if (x != null && y != null && x !== y) return y > x ? 1 : -1
  if ((x == null) !== (y == null)) return x == null ? 1 : -1
  return a.assetId - b.assetId
}

export function mmMarketStakingBacked(marketKey: string): boolean { return STAKING_BACKED.has(marketKey) }
export function mmMarketRole(marketKey: string): 'primary' | 'supplemental' {
  return MM_MARKETS.find(m => m.key === marketKey)?.role ?? 'supplemental'
}

/**
 * The ordering that picks one getUserAccountData observation per key: newest block,
 * then within a block the periodic snapshot (read after the block's events) over the
 * event-driven ones, which order by their event index, then the id and the version.
 */
export function mmObservationOrderSql(prefix = ''): string {
  const observation = `${prefix}observation_id`
  return `tuple(${prefix}block_height,
    if(startsWith(${observation}, 'money-market-periodic:'), toUInt32(4294967295),
      toUInt32OrZero(arrayElement(splitByChar(':', ${observation}), 3))),
    ${observation}, ${prefix}ingested_at)`
}

/** An H160's ETH-truncated AccountId32 — the form the observation tables key on. */
export const mmEthAccountForm = (h160: string): string => `0x45544800${h160.toLowerCase().slice(2)}0000000000000000`

const normH160s = (h160s: readonly string[]): string[] =>
  [...new Set(h160s.map(h => h.toLowerCase()))].filter(h => /^0x[0-9a-f]{40}$/.test(h))

const big = (value: unknown): bigint => {
  const text = String(value ?? '0')
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n
}

function forwardFill<T>(n: number, perBucket: Map<number, T>): (T | undefined)[] {
  const series: (T | undefined)[] = new Array(n + 1).fill(undefined)
  let last = perBucket.get(-1)
  for (let b = 0; b <= n; b++) { if (perBucket.has(b)) last = perBucket.get(b); series[b] = last }
  return series
}

// ---------------------------------------------------------------------------
// Reserve map
// ---------------------------------------------------------------------------

export interface MmReserveRef { assetAddress: string; atoken: string; vdebt: string; poolProxy: string; marketKey: string }
export interface MmReserveMap {
  /** The scaled anchor block B0; 0 when no anchor is published (every reserve amount is then unstated). */
  anchorBlock: number
  reserves: MmReserveRef[]
}

// Ten minutes, the LP id lists' reasoning (lpHistory.ts LP_ID_LIST_TTL_MS): a
// reserve listed after a window closed held nothing inside it. Every reserve ever
// mapped is kept — a delisted one keeps its map row — so history never loses one.
const RESERVE_MAP_TTL_MS = 10 * 60_000

export function loadMmReserveMap(client: ClickHouseClient): Promise<MmReserveMap> {
  return cached('mm:reserve-map', RESERVE_MAP_TTL_MS, async () => {
    const [mapRes, anchorRes] = await Promise.all([
      client.query(tagged({
        query: `-- mm:reserve-map
                SELECT lower(asset_address) AS asset_address, lower(atoken) AS atoken, lower(vdebt) AS vdebt,
                       lower(pool_proxy) AS pool_proxy, market_key
                FROM price_data.atoken_reserve_map FINAL`,
        format: 'JSONEachRow',
      })),
      client.query(tagged({ query: '-- mm:anchor-block\nSELECT max(anchor_block) AS b0 FROM price_data.atoken_scaled_anchor', format: 'JSONEachRow' })),
    ])
    const reserves = (await mapRes.json<{ asset_address: string; atoken: string; vdebt: string; pool_proxy: string; market_key: string }>())
      .map(r => ({ assetAddress: r.asset_address, atoken: r.atoken, vdebt: r.vdebt, poolProxy: r.pool_proxy, marketKey: r.market_key }))
    const [anchor] = await anchorRes.json<{ b0: number | null }>()
    return { anchorBlock: Number(anchor?.b0 ?? 0) || 0, reserves }
  })
}

// ---------------------------------------------------------------------------
// Scaled principal
// ---------------------------------------------------------------------------

/** The per-holder scaled-series key: `${holder}|${contract}`, both lower-case. */
export const scaledHolderKey = (holder: string, contract: string): string => `${holder.toLowerCase()}|${contract.toLowerCase()}`

/**
 * Scaled balance per HOLDER and token contract (aToken and variable-debt token
 * alike) per bucket end, keyed by scaledHolderKey: the B0 anchor plus every delta
 * after B0 up to the bucket's end block, floored at zero. `undefined` for a bucket
 * ending before B0 (and for every bucket without an anchor): not zero — unknown.
 * Holder-first key-prefix reads. The incentive history takes this same map
 * (loadMmIncentiveHistory's `scaled`), so the money-market routes read the deltas
 * once.
 */
export async function loadScaledHistoryByHolder(client: ClickHouseClient, h160s: readonly string[], anchorBlock: number, bk: Bucketing): Promise<Map<string, (bigint | undefined)[]>> {
  const out = new Map<string, (bigint | undefined)[]>()
  const hs = normH160s(h160s)
  if (!hs.length || !anchorBlock) return out
  const maxb = bk.endHeight(bk.N)
  const [anchorRes, deltaRes] = await Promise.all([
    client.query(tagged({
      query: `-- mm:scaled-anchor
              SELECT holder, lower(contract_address) AS contract, toString(scaled_balance) AS scaled
              FROM price_data.atoken_scaled_anchor FINAL
              WHERE holder IN {hs:Array(String)} AND anchor_block = {b0:UInt32}`,
      query_params: { hs, b0: anchorBlock }, format: 'JSONEachRow',
    })),
    maxb > anchorBlock
      ? client.query(tagged({
        query: `-- mm:scaled-deltas
                SELECT holder, contract_address AS contract, ${bk.ofTsCarry('block_timestamp')} AS b, toString(sum(scaled_delta)) AS delta
                FROM price_data.atoken_scaled_deltas FINAL
                WHERE holder IN {hs:Array(String)} AND block_height > {b0:UInt32} AND block_height <= {maxb:UInt32}
                GROUP BY holder, contract, b ORDER BY holder, contract, b`,
        query_params: { hs, b0: anchorBlock, maxb }, format: 'JSONEachRow',
      }))
      : null,
  ])
  const perHolder = new Map<string, { anchor: bigint; deltas: Map<number, bigint> }>()
  const entry = (holder: string, contract: string) => {
    const key = scaledHolderKey(holder, contract)
    let e = perHolder.get(key)
    if (!e) { e = { anchor: 0n, deltas: new Map() }; perHolder.set(key, e) }
    return e
  }
  for (const r of await anchorRes.json<{ holder: string; contract: string; scaled: string }>()) entry(r.holder, r.contract).anchor += big(r.scaled)
  if (deltaRes) {
    for (const r of await deltaRes.json<{ holder: string; contract: string; b: number; delta: string }>()) {
      const d = entry(r.holder, r.contract).deltas
      const b = Number(r.b)
      d.set(b, (d.get(b) ?? 0n) + big(r.delta))
    }
  }
  const stated = (b: number) => bk.endHeight(b) >= anchorBlock
  for (const [key, e] of perHolder) {
    const series = new Array<bigint | undefined>(bk.N + 1).fill(undefined)
    let running = e.anchor + (e.deltas.get(-1) ?? 0n)
    for (let b = 0; b <= bk.N; b++) {
      running += e.deltas.get(b) ?? 0n
      if (stated(b)) series[b] = running > 0n ? running : 0n
    }
    out.set(key, series)
  }
  return out
}

/** Per-holder series (loadScaledHistoryByHolder) summed per token contract; a bucket no holder states stays undefined. Pure. */
export function sumScaledByContract(byHolder: ReadonlyMap<string, (bigint | undefined)[]>): Map<string, (bigint | undefined)[]> {
  const out = new Map<string, (bigint | undefined)[]>()
  for (const [key, series] of byHolder) {
    const contract = key.slice(key.indexOf('|') + 1)
    const sum = out.get(contract) ?? new Array<bigint | undefined>(series.length).fill(undefined)
    series.forEach((v, b) => { if (v !== undefined) sum[b] = (sum[b] ?? 0n) + v })
    out.set(contract, sum)
  }
  return out
}

// ---------------------------------------------------------------------------
// Reserve indices
// ---------------------------------------------------------------------------

/** A reserve's last ReserveDataUpdated at or before a bucket end, with the timestamp it accrued to. */
export interface ReserveIndexState {
  liquidityIndex: bigint
  variableBorrowIndex: bigint
  liquidityRate: bigint
  variableBorrowRate: bigint
  /** The timestamp the update accrued to: its block's, or the parent's for an Initialization-phase update. */
  tLast: bigint
  block: number
  initPhase: boolean
}

export const reserveKey = (pool: string, reserve: string) => `${pool.toLowerCase()}:${reserve.toLowerCase()}`

interface IndexFoldRow { pool: string; reserve: string; b: number; blk: number; ev: number; ts: number }

const VERSION = 'tuple(block_height, event_index, ingested_at)'
/** How far below a window's floor its carry-in updates are looked for first (~a week of 6 s blocks). */
export const CARRY_LOOKBACK_BLOCKS = 100_000

/** Last row per (pool, reserve, bucket) of a reserve-first MV table over [lo, hi], argMax over the replacement key. */
async function foldReserveTable<T>(
  client: ClickHouseClient, tag: string, table: string, cols: string,
  pools: string[], reserves: string[], bucketSql: string, lo: number, hi: number,
): Promise<T[]> {
  const res = await client.query(tagged({
    query: `-- ${tag}
            SELECT pool_address AS pool, reserve_address AS reserve, ${bucketSql} AS b,
              ${cols},
              argMax(block_height, ${VERSION}) AS blk,
              argMax(event_index, ${VERSION}) AS ev
            FROM price_data.${table}
            WHERE pool_address IN {pools:Array(String)} AND reserve_address IN {reserves:Array(String)}
              AND block_height >= {lo:UInt32} AND block_height <= {hi:UInt32}
            GROUP BY pool, reserve, b ORDER BY pool, reserve, b`,
    query_params: { pools, reserves, lo, hi }, format: 'JSONEachRow',
  }))
  return res.json<T>()
}

/**
 * Per reserve and bucket: the reserve's last update at or before the bucket end,
 * forward-filled (`undefined` before its first update; `null` when that update's
 * accrual timestamp cannot be stated — its EVM log is not indexed, or the rates
 * row for the same event is missing). Reserve-first reads over the two MV tables
 * (argMax over the replacement key, no FINAL — reserveIndicesNow's rule), then the
 * phase of each selected update by primary key and the parent-block timestamps of
 * the Initialization-phase ones.
 *
 * The fold depends on the reserves and the grid, never on the account, so with a
 * `universe` (every reserve of the map) it runs ONCE per canonical grid
 * (bucketLadder canonicalPlan) over the whole universe, cached, and each account
 * grid looks its buckets up there — plus, for its last bucket ending at the head
 * (no lattice point), the updates between the lattice boundary below it and its
 * own end. A grid that does not map folds on its own, exactly as before.
 */
export async function loadReserveIndexHistory(
  client: ClickHouseClient,
  reserves: ReadonlyArray<{ pool: string; reserve: string }>,
  bk: Bucketing,
  universe?: ReadonlyArray<{ pool: string; reserve: string }>,
): Promise<Map<string, (ReserveIndexState | null | undefined)[]>> {
  const wanted = [...new Set(reserves.map(r => reserveKey(r.pool, r.reserve)))]
  if (!wanted.length) return new Map()
  const plan = universe ? canonicalPlan(bk) : null
  if (!plan) return reserveIndexOnGrid(client, reserves, bk)
  const all = new Map<string, { pool: string; reserve: string }>()
  for (const r of [...universe!, ...reserves]) all.set(reserveKey(r.pool, r.reserve), { pool: r.pool.toLowerCase(), reserve: r.reserve.toLowerCase() })
  const allKeys = [...all.keys()].sort()
  // Closed boundaries restate only through late MV rows, so a plain TTL; a grid whose
  // last boundary is inside the finality hour keeps it short (a block's events land
  // after the block row the clock dates it by).
  const recent = Date.now() / 1000 - plan.grid.bk.endSec(plan.grid.bk.N) < 3_600
  const canon = await cached(`mm:reserve-index:canon:${plan.grid.key}:${keyFingerprint(allKeys)}`, recent ? 60_000 : RESERVE_INDEX_CANON_TTL_MS,
    () => reserveIndexOnGrid(client, allKeys.map(k => all.get(k)!), plan.grid.bk))
  const tail = plan.tail ? await reserveIndexBetween(client, reserves, plan.tail.fromHeight, plan.tail.toHeight) : null
  const out = new Map<string, (ReserveIndexState | null | undefined)[]>()
  for (const key of wanted) {
    const c = canon.get(key)
    const series: (ReserveIndexState | null | undefined)[] = plan.grid.map.map(i => (i == null ? undefined : c?.[i]))
    if (plan.tail) {
      const t = tail!.get(key)?.[0]
      series[plan.tail.b] = t !== undefined ? t : c?.[plan.tail.prev]
    }
    out.set(key, series)
  }
  return out
}

/** How long a canonical reserve-index fold whose last boundary is past the finality hour is kept. */
const RESERVE_INDEX_CANON_TTL_MS = 10 * 60_000

/** A short stable fingerprint of a sorted key list, for cache keys. */
export function keyFingerprint(keys: readonly string[]): string {
  let h = 2166136261
  for (const k of keys) for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return `${keys.length}.${h.toString(16)}`
}

const INDEX_COLS = `toString(argMax(liquidity_index, ${VERSION})) AS liq, toString(argMax(variable_borrow_index, ${VERSION})) AS vbi,
                toUInt32(toUnixTimestamp(argMax(block_timestamp, ${VERSION}))) AS ts`
const RATE_COLS = `toString(argMax(liquidity_rate, ${VERSION})) AS liq_rate, toString(argMax(variable_borrow_rate, ${VERSION})) AS vb_rate`
type IdxRow = IndexFoldRow & { liq: string; vbi: string }
type RateRow = { pool: string; reserve: string; b: number; liq_rate: string; vb_rate: string; blk: number; ev: number }

/** The fold on the grid itself (see loadReserveIndexHistory). */
async function reserveIndexOnGrid(
  client: ClickHouseClient,
  reserves: ReadonlyArray<{ pool: string; reserve: string }>,
  bk: Bucketing,
): Promise<Map<string, (ReserveIndexState | null | undefined)[]>> {
  const wanted = new Set(reserves.map(r => reserveKey(r.pool, r.reserve)))
  if (!wanted.size) return new Map()
  // The pool × reserve cross product is a superset (the client has no tuple
  // parameters); rows outside the wanted pairs are dropped below.
  const pools = [...new Set(reserves.map(r => r.pool.toLowerCase()))]
  const reserveAddrs = [...new Set(reserves.map(r => r.reserve.toLowerCase()))]
  const maxb = bk.endHeight(bk.N)
  // The carry into the window needs only each reserve's LAST update before it, so
  // the pre-window read is bounded to CARRY_LOOKBACK_BLOCKS below the floor; a
  // reserve with no update in that stretch (a quiet one) has its carry read on its
  // own, unbounded but for that reserve alone.
  const lo = Math.max(0, bk.floorHeight - CARRY_LOOKBACK_BLOCKS)
  const [idxWindow, rateWindow] = await Promise.all([
    foldReserveTable<IdxRow>(client, 'mm:reserve-indices', 'money_market_reserve_indices', INDEX_COLS, pools, reserveAddrs, bk.ofTsCarry('block_timestamp'), lo, maxb),
    foldReserveTable<RateRow>(client, 'mm:reserve-rates', 'money_market_reserve_rates', RATE_COLS, pools, reserveAddrs, bk.ofTsCarry('block_timestamp'), lo, maxb),
  ])
  let idxAll = idxWindow.filter(r => wanted.has(reserveKey(r.pool, r.reserve)))
  let rateAll = rateWindow
  if (lo > 0) {
    const carried = new Set(idxAll.filter(r => Number(r.b) === -1).map(r => reserveKey(r.pool, r.reserve)))
    const quiet = reserves.filter(r => !carried.has(reserveKey(r.pool, r.reserve)))
    if (quiet.length) {
      const qp = [...new Set(quiet.map(r => r.pool.toLowerCase()))]
      const qr = [...new Set(quiet.map(r => r.reserve.toLowerCase()))]
      const quietKeys = new Set(quiet.map(r => reserveKey(r.pool, r.reserve)))
      const [idxCarry, rateCarry] = await Promise.all([
        foldReserveTable<IdxRow>(client, 'mm:reserve-indices-carry', 'money_market_reserve_indices', INDEX_COLS, qp, qr, 'toInt32(-1)', 0, lo - 1),
        foldReserveTable<RateRow>(client, 'mm:reserve-rates-carry', 'money_market_reserve_rates', RATE_COLS, qp, qr, 'toInt32(-1)', 0, lo - 1),
      ])
      idxAll = [...idxCarry.filter(r => quietKeys.has(reserveKey(r.pool, r.reserve))), ...idxAll]
      rateAll = [...rateCarry, ...rateAll]
    }
  }
  return indexStatesFromRows(client, idxAll, rateAll, wanted, bk.N)
}

/** Each reserve's last update in (fromHeight − 1, toHeight] as a one-bucket series (undefined: none there). */
async function reserveIndexBetween(
  client: ClickHouseClient,
  reserves: ReadonlyArray<{ pool: string; reserve: string }>,
  fromHeight: number,
  toHeight: number,
): Promise<Map<string, (ReserveIndexState | null | undefined)[]>> {
  const wanted = new Set(reserves.map(r => reserveKey(r.pool, r.reserve)))
  if (!wanted.size || toHeight < fromHeight) return new Map()
  const pools = [...new Set(reserves.map(r => r.pool.toLowerCase()))]
  const reserveAddrs = [...new Set(reserves.map(r => r.reserve.toLowerCase()))]
  const [idx, rates] = await Promise.all([
    foldReserveTable<IdxRow>(client, 'mm:reserve-indices-tail', 'money_market_reserve_indices', INDEX_COLS, pools, reserveAddrs, 'toInt32(0)', fromHeight, toHeight),
    foldReserveTable<RateRow>(client, 'mm:reserve-rates-tail', 'money_market_reserve_rates', RATE_COLS, pools, reserveAddrs, 'toInt32(0)', fromHeight, toHeight),
  ])
  return indexStatesFromRows(client, idx.filter(r => wanted.has(reserveKey(r.pool, r.reserve))), rates, wanted, 0)
}

/** Folded rows → per-reserve forward-filled states: the rates row of the same event, the phase, the parent timestamp. */
async function indexStatesFromRows(
  client: ClickHouseClient, idxAll: IdxRow[], rateAll: RateRow[], wanted: ReadonlySet<string>, N: number,
): Promise<Map<string, (ReserveIndexState | null | undefined)[]>> {
  const out = new Map<string, (ReserveIndexState | null | undefined)[]>()
  const idxRows = idxAll.map(r => ({ ...r, b: Number(r.b), blk: Number(r.blk), ev: Number(r.ev), ts: Number(r.ts) }))
  const rates = new Map<string, { liqRate: bigint; vbRate: bigint }>()
  for (const r of rateAll) {
    rates.set(`${reserveKey(r.pool, r.reserve)}@${Number(r.blk)}:${Number(r.ev)}`, { liqRate: big(r.liq_rate), vbRate: big(r.vb_rate) })
  }

  const keys = [...new Map(idxRows.map(r => [`${r.blk}:${r.ev}`, [r.blk, r.ev] as [number, number]])).values()]
  const phase = await updatePhases(client, keys)
  const parents = [...new Set(idxRows.filter(r => phase.get(`${r.blk}:${r.ev}`) === true).map(r => r.blk - 1))]
  const parentTime = await loadBlockTimes(client, parents)

  const perReserve = new Map<string, Map<number, ReserveIndexState | null>>()
  for (const r of idxRows) {
    const key = reserveKey(r.pool, r.reserve)
    const rate = rates.get(`${key}@${r.blk}:${r.ev}`)
    const init = phase.get(`${r.blk}:${r.ev}`)
    const tLast = init === undefined ? undefined : init ? parentTime.get(r.blk - 1) : r.ts
    const state: ReserveIndexState | null = rate && tLast != null
      ? { liquidityIndex: big(r.liq), variableBorrowIndex: big(r.vbi), liquidityRate: rate.liqRate, variableBorrowRate: rate.vbRate, tLast: BigInt(tLast), block: r.blk, initPhase: init === true }
      : null
    const m = perReserve.get(key) ?? new Map<number, ReserveIndexState | null>()
    m.set(r.b, state)
    perReserve.set(key, m)
  }
  for (const key of wanted) out.set(key, forwardFill(N, perReserve.get(key) ?? new Map()))
  return out
}

/**
 * Whether each (block, event index) EVM log ran in the Initialization phase — the
 * EVM.Log event's own phase in raw_events, the exact criterion (a log without an
 * extrinsic index could also be Finalization-phase, which runs after Timestamp.set).
 * Absent: not indexed.
 */
async function updatePhases(client: ClickHouseClient, keys: Array<[number, number]>): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (!keys.length) return out
  // The (block, event index) tuple against the zipped arrays prunes on the whole
  // primary key (block_height, event_index) — one granule per key; the client
  // cannot bind an Array(Tuple) parameter, so the tuples are zipped server-side.
  const res = await client.query(tagged({
    query: `-- mm:reserve-update-phase
            SELECT block_height, event_index, phase = 'Initialization' AS init
            FROM price_data.raw_events
            WHERE (block_height, event_index) IN arrayZip({b:Array(UInt32)}, {e:Array(UInt32)})`,
    query_params: { b: keys.map(k => k[0]), e: keys.map(k => k[1]) }, format: 'JSONEachRow',
  }))
  for (const r of await res.json<{ block_height: number; event_index: number; init: number }>()) out.set(`${Number(r.block_height)}:${Number(r.event_index)}`, Number(r.init) === 1)
  return out
}

/** Block timestamps (unix seconds) by height, primary-key point reads on price_data.blocks. */
export async function loadBlockTimes(client: ClickHouseClient, heights: Iterable<number>): Promise<Map<number, number>> {
  const hs = [...new Set([...heights].filter(h => Number.isInteger(h) && h > 0))]
  const out = new Map<number, number>()
  if (!hs.length) return out
  const res = await client.query(tagged({
    query: `-- mm:block-times
            SELECT block_height, toUInt32(toUnixTimestamp(block_timestamp)) AS t FROM price_data.blocks WHERE block_height IN {hs:Array(UInt32)}`,
    query_params: { hs }, format: 'JSONEachRow',
  }))
  for (const r of await res.json<{ block_height: number; t: number }>()) out.set(Number(r.block_height), Number(r.t))
  return out
}

// ---------------------------------------------------------------------------
// Observations, collateral flags, E-mode
// ---------------------------------------------------------------------------

/** One getUserAccountData observation (base-currency units as reported; HF 1e18-scaled). */
export interface MmObservation {
  block: number
  totalCollateralBase: string
  totalDebtBase: string
  availableBorrowsBase: string
  liquidationThreshold: string
  ltv: string
  healthFactor: string
  /**
   * The lowest health factor in force during the bucket: the minimum over the
   * observations inside it and the one carried into it (the previous bucket's last)
   * — the chain's own figures, never interpolated. Absent where no observation is
   * known yet; `lowestAtBlock` is the block that observed it.
   */
  lowestHealthFactor?: string
  lowestAtBlock?: number
}

/**
 * The lowest health factor per bucket (MmObservation.lowestHealthFactor) over the
 * forward-filled series and each bucket's own in-bucket minimum. Pure; returns new
 * objects (the filled series shares one object across a quiet run).
 */
export function withLowestHealthFactor(filled: (MmObservation | undefined)[], inBucketMin: ReadonlyMap<number, { hf: string; block: number }>, before?: MmObservation): (MmObservation | undefined)[] {
  const big = (v: string) => (/^\d+$/.test(v) ? BigInt(v) : null)
  return filled.map((o, b) => {
    if (!o) return o
    const carried = b > 0 ? filled[b - 1] : before
    let hf = carried ? carried.healthFactor : null
    let at = carried ? carried.block : null
    const own = inBucketMin.get(b)
    if (own) {
      const ownV = big(own.hf), curV = hf == null ? null : big(hf)
      if (ownV != null && (curV == null || ownV < curV)) { hf = own.hf; at = own.block }
    }
    if (hf == null) { hf = o.healthFactor; at = o.block }
    return { ...o, lowestHealthFactor: hf, lowestAtBlock: at ?? o.block }
  })
}

/**
 * The holder whose observations a market's series follows when an account has
 * several EVM identities (its related set): the PRIMARY H160 wherever it has an
 * observation in that market, else the identity observed last there (ties by
 * address). One holder per market for the whole series, so a health factor is
 * always one position's figure — never the newest of several positions picked
 * bucket by bucket — while the reserve legs beside it sum every identity's. Pure;
 * `rows` are per (pool, account) the newest observed block.
 */
export function chooseObservationHolders(rows: ReadonlyArray<{ pool: string; acc: string; last: number }>, primaryAcc: string | null): Map<string, string> {
  const best = new Map<string, { acc: string; last: number; primary: boolean }>()
  for (const r of rows) {
    const pool = r.pool.toLowerCase()
    const acc = r.acc.toLowerCase()
    const cand = { acc, last: Number(r.last), primary: primaryAcc != null && acc === primaryAcc }
    const cur = best.get(pool)
    const better = !cur
      || (cand.primary && !cur.primary)
      || (cand.primary === cur.primary && (cand.last > cur.last || (cand.last === cur.last && cand.acc < cur.acc)))
    if (better) best.set(pool, cand)
  }
  return new Map([...best].map(([pool, v]) => [pool, v.acc]))
}

/**
 * Per pool and bucket: the newest observation at or before the bucket end,
 * forward-filled from the account's whole observation history (pre-range rows fold
 * into the -1 carry). With several H160s the market follows ONE of them,
 * chooseObservationHolders' (`primary`, the account's primary money-market H160,
 * first). Account-first prefix reads.
 */
export async function loadObservationHistory(
  client: ClickHouseClient, h160s: readonly string[], pools: readonly string[], bk: Bucketing, primary?: string | null,
): Promise<Map<string, (MmObservation | undefined)[]>> {
  const out = new Map<string, (MmObservation | undefined)[]>()
  const allAccs = normH160s(h160s).map(mmEthAccountForm)
  let poolList = [...new Set(pools.map(p => p.toLowerCase()))]
  if (!allAccs.length || !poolList.length) return out
  const maxb = bk.endHeight(bk.N)
  // Several identities: pick each market's holder first (as of the window's end).
  let holderOf: Map<string, string> | null = null
  if (allAccs.length > 1) {
    const res = await client.query(tagged({
      query: `-- mm:observation-holders
              SELECT pool_address AS pool, account_id AS acc, max(block_height) AS last
              FROM price_data.account_money_market_position_history
              WHERE account_id IN {accs:Array(String)} AND pool_address IN {pools:Array(String)} AND block_height <= {maxb:UInt32}
              GROUP BY pool, acc`,
      query_params: { accs: allAccs, pools: poolList, maxb }, format: 'JSONEachRow',
    }))
    const primaryAcc = primary && /^0x[0-9a-fA-F]{40}$/.test(primary) ? mmEthAccountForm(primary) : null
    holderOf = chooseObservationHolders(await res.json<{ pool: string; acc: string; last: number }>(), primaryAcc)
    poolList = poolList.filter(p => holderOf!.has(p))
    if (!poolList.length) return out
  }
  const accs = holderOf ? [...new Set(holderOf.values())].sort() : allAccs
  const holderPools = holderOf ? [...holderOf.keys()] : []
  const holderAccs = holderOf ? holderPools.map(p => holderOf!.get(p)!) : []
  const holderFilter = holderOf ? `AND account_id = transform(pool_address, {hp:Array(String)}, {ha:Array(String)}, '')` : ''
  const o = mmObservationOrderSql()
  type Row = { pool: string; b: number; obs_block: number; coll: string; debt: string; avail: string; lt: string; max_ltv: string; hf: string; hf_min: string | null; hf_min_block: number }
  // The in-bucket minimum is over the NUMERIC health factor. `health_factor` is a
  // String column, and a string min is lexicographic: a liquidatable HF has 18
  // digits (0.996e18), a healthy one 19 (1.04e18) and a debt-free one 78 (the
  // contract's uint256 max), and '1' < '9' sorts every one of those wrong — the
  // dip below 1 that a LiquidationCall observed never won a bucket, and a
  // debt-free observation "undercut" a 2.2 to draw the bucket at the cap.
  const hfNum = 'toUInt256OrNull(health_factor)'
  const read = async (tag: string, bucketSql: string, poolsIn: string[], lo: number, hi: number): Promise<Row[]> => {
    const res = await client.query(tagged({
      query: `-- ${tag}
              SELECT pool_address AS pool, ${bucketSql} AS b,
                argMax(block_height, ${o}) AS obs_block,
                argMax(total_collateral_base, ${o}) AS coll,
                argMax(total_debt_base, ${o}) AS debt,
                argMax(available_borrows_base, ${o}) AS avail,
                argMax(current_liquidation_threshold, ${o}) AS lt,
                argMax(ltv, ${o}) AS max_ltv,
                argMax(health_factor, ${o}) AS hf,
                toString(min(${hfNum})) AS hf_min,
                argMin(block_height, ${hfNum}) AS hf_min_block
              FROM price_data.account_money_market_position_history
              WHERE account_id IN {accs:Array(String)} AND pool_address IN {pools:Array(String)}
                AND block_height >= {lo:UInt32} AND block_height <= {hi:UInt32} ${holderFilter}
              GROUP BY pool, b ORDER BY pool, b`,
      query_params: { accs, pools: poolsIn, lo, hi, ...(holderOf ? { hp: holderPools, ha: holderAccs } : {}) }, format: 'JSONEachRow',
    }))
    return res.json<Row>()
  }
  // Bounded carry, as for the reserve indices: a borrower is re-read every ~10k
  // blocks, so its last pre-window observation is almost always within the
  // lookback; a pool without one there is read on its own below it.
  const lo = Math.max(0, bk.floorHeight - CARRY_LOOKBACK_BLOCKS)
  let rows = await read('mm:observations', bk.ofHeightCarry('block_height'), poolList, lo, maxb)
  if (lo > 0) {
    const carried = new Set(rows.filter(r => Number(r.b) === -1).map(r => r.pool.toLowerCase()))
    const quiet = poolList.filter(p => !carried.has(p))
    if (quiet.length) rows = [...await read('mm:observations-carry', 'toInt32(-1)', quiet, 0, lo - 1), ...rows]
  }
  const byPool = new Map<string, Map<number, MmObservation>>()
  const minByPool = new Map<string, Map<number, { hf: string; block: number }>>()
  for (const r of rows) {
    const pool = r.pool.toLowerCase()
    if (Number(r.b) >= 0 && r.hf_min != null) {
      const mins = minByPool.get(pool) ?? minByPool.set(pool, new Map()).get(pool)!
      mins.set(Number(r.b), { hf: String(r.hf_min), block: Number(r.hf_min_block) })
    }
    const m = byPool.get(pool) ?? new Map<number, MmObservation>()
    m.set(Number(r.b), {
      block: Number(r.obs_block), totalCollateralBase: String(r.coll ?? '0'), totalDebtBase: String(r.debt ?? '0'),
      availableBorrowsBase: String(r.avail ?? '0'), liquidationThreshold: String(r.lt ?? '0'), ltv: String(r.max_ltv ?? '0'), healthFactor: String(r.hf ?? '0'),
    })
    byPool.set(pool, m)
  }
  for (const [pool, m] of byPool) out.set(pool, withLowestHealthFactor(forwardFill(bk.N, m), minByPool.get(pool) ?? new Map(), m.get(-1)))
  return out
}

/**
 * Where an EVM identity's money-market history starts when it has no balance
 * history to date it: the earliest of its first observation,
 * its first scaled-balance delta on any aToken or debt token, and B0 when it holds
 * an anchor row — so an aToken-only holder (a supplier the periodic observation
 * sweep never read, or one that only received aTokens) still gets a history.
 * Holder-first key reads; null when none of the three knows the identity.
 */
export async function mmHistoryStart(client: ClickHouseClient, h160s: readonly string[]): Promise<{ minb: number; mint: number } | null> {
  const hs = normH160s(h160s)
  if (!hs.length) return null
  const accs = hs.map(mmEthAccountForm)
  const res = await client.query(tagged({
    query: `-- mm:history-start
            SELECT
              (SELECT min(block_height) FROM price_data.account_money_market_position_history WHERE account_id IN {accs:Array(String)}) AS obs,
              (SELECT min(block_height) FROM price_data.atoken_scaled_deltas WHERE holder IN {hs:Array(String)}) AS delta,
              (SELECT max(anchor_block) FROM price_data.atoken_scaled_anchor FINAL WHERE holder IN {hs:Array(String)} AND scaled_balance > 0) AS anchor`,
    query_params: { accs, hs }, format: 'JSONEachRow',
  }))
  const row = (await res.json<{ obs: number | null; delta: number | null; anchor: number | null }>())[0]
  const candidates = [row?.obs, row?.delta, row?.anchor].map(v => Number(v ?? 0)).filter(v => Number.isFinite(v) && v > 0)
  if (!candidates.length) return null
  const minb = Math.min(...candidates)
  const mint = (await loadBlockTimes(client, [minb])).get(minb)
  return mint == null ? null : { minb, mint }
}

// The usage-as-collateral bit has two observers: the pool's Enabled/Disabled events
// (exact, but the chain does not emit one for every way the bit moves) and the
// swept bitmap read (money_market_collateral_anchor, complete but only as of its
// sweep block). Whichever observed it LAST wins, the sweep taking a tie because it
// reads the state after that block's events. Replayed rows repeat their values, so
// the argMax is idempotent without FINAL; an older, unmerged sweep row is a valid
// observation at its own block.
const COLLATERAL_OBSERVERS_SQL = `
        SELECT user_address, pool_address, reserve_address, block_height, enabled, tuple(block_height, toUInt8(0), event_index) AS observed
        FROM price_data.money_market_collateral_flags
        WHERE user_address IN {hs:Array(String)} AND block_height <= {maxb:UInt32}
        UNION ALL
        SELECT user_address, pool_address, reserve_address, block_height, enabled, tuple(block_height, toUInt8(1), toUInt32(0)) AS observed
        FROM price_data.money_market_collateral_anchor
        WHERE user_address IN {hs:Array(String)} AND block_height <= {maxb:UInt32}`

/**
 * The current usage-as-collateral flag per holder and reserve (keyed like
 * reserveKey). A reserve neither observer saw reads as absent — never
 * collateralised, since the sweep covers every position holder.
 */
export async function loadCurrentCollateralFlags(client: ClickHouseClient, h160s: readonly string[]): Promise<Map<string, Map<string, boolean>>> {
  const out = new Map<string, Map<string, boolean>>()
  const hs = normH160s(h160s)
  if (!hs.length) return out
  const res = await client.query(tagged({
    query: `-- mm:collateral-flags-current
            SELECT user_address, pool_address, reserve_address, argMax(enabled, observed) AS enabled_last
            FROM (${COLLATERAL_OBSERVERS_SQL})
            GROUP BY user_address, pool_address, reserve_address`,
    query_params: { hs, maxb: 0xffff_ffff }, format: 'JSONEachRow',
  }))
  for (const r of await res.json<{ user_address: string; pool_address: string; reserve_address: string; enabled_last: number }>()) {
    const h = r.user_address.toLowerCase()
    const m = out.get(h) ?? out.set(h, new Map<string, boolean>()).get(h)!
    m.set(reserveKey(r.pool_address, r.reserve_address), Number(r.enabled_last) === 1)
  }
  return out
}

/**
 * Per reserve and bucket: the flag as last observed at or before the bucket end;
 * `undefined` when nothing observed it by then (history cannot tell "never enabled"
 * from "enabled without an event" before the sweep saw it).
 */
export async function loadCollateralFlagHistory(client: ClickHouseClient, h160s: readonly string[], bk: Bucketing): Promise<Map<string, (boolean | undefined)[]>> {
  const out = new Map<string, (boolean | undefined)[]>()
  const hs = normH160s(h160s)
  if (!hs.length) return out
  const res = await client.query(tagged({
    query: `-- mm:collateral-flags
            SELECT pool_address AS pool, reserve_address AS reserve, ${bk.ofHeightCarry('block_height')} AS b, argMax(enabled, observed) AS enabled_last
            FROM (${COLLATERAL_OBSERVERS_SQL})
            GROUP BY pool, reserve, b ORDER BY pool, reserve, b`,
    query_params: { hs, maxb: bk.endHeight(bk.N) }, format: 'JSONEachRow',
  }))
  const byReserve = new Map<string, Map<number, boolean>>()
  for (const r of await res.json<{ pool: string; reserve: string; b: number; enabled_last: number }>()) {
    const key = reserveKey(r.pool, r.reserve)
    const m = byReserve.get(key) ?? new Map<number, boolean>()
    m.set(Number(r.b), Number(r.enabled_last) === 1)
    byReserve.set(key, m)
  }
  for (const [key, m] of byReserve) out.set(key, forwardFill(bk.N, m))
  return out
}

/** Per pool and bucket: the E-mode category of the last UserEModeSet at or before the end (0 = none); `undefined` before any. */
export async function loadEmodeHistory(client: ClickHouseClient, h160s: readonly string[], bk: Bucketing): Promise<Map<string, (number | undefined)[]>> {
  const out = new Map<string, (number | undefined)[]>()
  const hs = normH160s(h160s)
  if (!hs.length) return out
  const res = await client.query(tagged({
    query: `-- mm:emode
            SELECT pool_address AS pool, ${bk.ofHeightCarry('block_height')} AS b, argMax(category_id, tuple(block_height, event_index)) AS category
            FROM price_data.money_market_emode_events
            WHERE user_address IN {hs:Array(String)} AND block_height <= {maxb:UInt32}
            GROUP BY pool, b ORDER BY pool, b`,
    query_params: { hs, maxb: bk.endHeight(bk.N) }, format: 'JSONEachRow',
  }))
  const byPool = new Map<string, Map<number, number>>()
  for (const r of await res.json<{ pool: string; b: number; category: number }>()) {
    const pool = r.pool.toLowerCase()
    const m = byPool.get(pool) ?? new Map<number, number>()
    m.set(Number(r.b), Number(r.category))
    byPool.set(pool, m)
  }
  for (const [pool, m] of byPool) out.set(pool, forwardFill(bk.N, m))
  return out
}

/** The current E-mode category per pool: the last UserEModeSet (0 = none). Pools never set are absent. */
export async function loadCurrentEmode(client: ClickHouseClient, h160s: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const hs = normH160s(h160s)
  if (!hs.length) return out
  const res = await client.query(tagged({
    query: `-- mm:emode-current
            SELECT pool_address AS pool, argMax(category_id, tuple(block_height, event_index)) AS category
            FROM price_data.money_market_emode_events
            WHERE user_address IN {hs:Array(String)}
            GROUP BY pool`,
    query_params: { hs }, format: 'JSONEachRow',
  }))
  for (const r of await res.json<{ pool: string; category: number }>()) out.set(r.pool.toLowerCase(), Number(r.category))
  return out
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** What balanceOf (aToken) and the variable-debt token's balanceOf return at timestamp `t`. Pure. */
export function reserveAmountsAt(aScaled: bigint, dScaled: bigint, idx: ReserveIndexState, t: bigint): { supplied: bigint; borrowed: bigint } {
  return {
    supplied: aScaled > 0n ? rayMul(aScaled, normalizedIncome(idx.liquidityIndex, idx.liquidityRate, idx.tLast, t)) : 0n,
    borrowed: dScaled > 0n ? rayMul(dScaled, normalizedDebt(idx.variableBorrowIndex, idx.variableBorrowRate, idx.tLast, t)) : 0n,
  }
}

/** One side (supply or debt) of a reserve's cumulative interest, per bucket 0..N. */
export interface InterestSide {
  /** Raw units accrued from the first stated bucket through bucket b; 0 before it. A lower bound where `incomplete`. */
  raw: bigint[]
  /** Σ of each bucket's accrual at that bucket's closed candle; null from the first unpriced or unstatable accrual on — never zero for one. */
  usd: (bigint | null)[]
  /** From the first bucket whose accrual could not be stated (held principal, but an index or a bucket-end time unknown) on. */
  incomplete: boolean[]
}

/**
 * A reserve's interest earned (supply) or paid (debt) per bucket, cumulative — pure
 * and integer. Bucket b's accrual is what the principal held at the previous bucket's
 * end gained by this bucket's end:
 *
 *   accrual_b = rayMul(scaled_{b−1}, I(t_b)) − rayMul(scaled_{b−1}, I(t_{b−1}))
 *
 * with I the reserve's normalizedIncome (supply, over the aToken's scaled sum) or
 * normalizedDebt (debt, over the variable-debt token's), each compounded from the
 * index state in force at that bucket end to the end block's timestamp — the
 * reserve points' own balanceOf arithmetic, so it is scaled × ΔI / RAY in Aave's
 * half-up rounding and, for a principal held unchanged, the cumulative equals the
 * balance's growth exactly. APPROXIMATION: the principal of bucket b−1's end is taken
 * as held through all of bucket b; a supply, withdrawal, borrow or repay inside a
 * bucket starts (or stops) accruing only from the next bucket, so a bucket's accrual
 * is off by the delta's interest over the part of the bucket it was (not) held.
 *
 * Cumulative from the first stated bucket (the coverage floor B0 or the grid's first
 * bucket, whichever is later): the first stated bucket itself accrues nothing, since
 * its predecessor's principal is not stated. A bucket whose principal was positive
 * but whose accrual cannot be stated contributes nothing and marks the side
 * incomplete from there on (raw is then a lower bound, usd null). A positive accrual
 * `price` cannot value nulls usd from there on; a zero accrual needs no price.
 */
export function reserveInterestSide(
  scaled: readonly (bigint | undefined)[] | undefined,
  indices: readonly (ReserveIndexState | null | undefined)[] | undefined,
  endTimes: readonly (number | null)[],
  side: 'supply' | 'debt',
  stated: (b: number) => boolean,
  N: number,
  price: (amount: bigint, b: number) => bigint | null,
): InterestSide {
  const out: InterestSide = { raw: new Array(N + 1), usd: new Array(N + 1), incomplete: new Array(N + 1) }
  const indexAt = (idx: ReserveIndexState, t: number): bigint => side === 'supply'
    ? normalizedIncome(idx.liquidityIndex, idx.liquidityRate, idx.tLast, BigInt(t))
    : normalizedDebt(idx.variableBorrowIndex, idx.variableBorrowRate, idx.tLast, BigInt(t))
  let raw = 0n
  let usd: bigint | null = 0n
  let incomplete = false
  for (let b = 0; b <= N; b++) {
    const s = b > 0 && stated(b) && stated(b - 1) ? (scaled?.[b - 1] ?? 0n) : 0n
    if (s > 0n) {
      const i0 = indices?.[b - 1], i1 = indices?.[b], t0 = endTimes[b - 1], t1 = endTimes[b]
      const accrual = i0 && i1 && t0 != null && t1 != null ? rayMul(s, indexAt(i1, t1)) - rayMul(s, indexAt(i0, t0)) : null
      // An index never decreases; a negative difference is an unstatable pair of states.
      if (accrual == null || accrual < 0n) { incomplete = true; usd = null } else if (accrual > 0n) {
        raw += accrual
        if (usd != null) { const v = price(accrual, b); usd = v == null ? null : usd + v }
      }
    }
    out.raw[b] = raw
    out.usd[b] = usd
    out.incomplete[b] = incomplete
  }
  return out
}

export interface MmHistoryParts {
  reserveMap: MmReserveMap
  /** Per token contract per bucket (sumScaledByContract over loadScaledHistoryByHolder). */
  scaled: Map<string, (bigint | undefined)[]>
  indices: Map<string, (ReserveIndexState | null | undefined)[]>
  /** Timestamp (unix seconds) of each bucket's end block; null where unknown. */
  endTimes: (number | null)[]
  observations: Map<string, (MmObservation | undefined)[]>
  collateral: Map<string, (boolean | undefined)[]>
  emode: Map<string, (number | undefined)[]>
  /** Keep only these market keys. */
  markets?: ReadonlySet<string>
  /** The accounts' settled unclaimed incentives per bucket; null/absent = not asked for. */
  rewards?: MmIncentiveHistory | null
}

export interface MmHistoryReservePoint {
  b: number
  supplied: bigint
  borrowed: bigint
  suppliedUsd: bigint | null
  borrowedUsd: bigint | null
  /** Supplying is not collateralising: false while nothing is supplied; null when no observer had seen the flag by the bucket end. */
  collateral: boolean | null
  /** Cumulative raw interest on the supply / debt side through this bucket (reserveInterestSide). */
  interestEarned: bigint
  interestPaid: bigint
  /** Their USD, each bucket's accrual at that bucket's candle; null once an accrual was unpriced or unstatable. */
  interestEarnedUsd: bigint | null
  interestPaidUsd: bigint | null
  /** Some accrual on either side could not be stated by here: the raw figures are lower bounds. */
  interestIncomplete: boolean
}
export interface MmHistoryInterest {
  interestEarned: bigint
  interestPaid: bigint
  interestEarnedUsd: bigint | null
  interestPaidUsd: bigint | null
  interestIncomplete: boolean
}
export interface MmHistoryReserve extends MmHistoryInterest {
  /** The reserve's underlying registry asset. */
  assetId: number
  reserveAddress: string
  aTokenAssetId: number | null
  /** Only the buckets at whose end something was supplied or owed, ascending. */
  points: MmHistoryReservePoint[]
  // The MmHistoryInterest fields here are the cumulative at the GRID's last bucket —
  // interest a bucket accrued after the reserve's last held point (the bucket it was
  // closed in) is in them, and bucket selection never trims them.
}
export interface MmHistoryMarketPoint {
  b: number
  /** Priced legs only; null when the bucket ends before the reserve coverage floor. */
  suppliedUsd: bigint | null
  borrowedUsd: bigint | null
  /** suppliedUsd − borrowedUsd, only when every held leg is stated and priced. */
  netUsd: bigint | null
  /** Held legs (a supplied or an owed side of a reserve) left out of the sums: unpriced, or not statable. */
  unpriced: number
  observation: MmObservation | null
  eModeCategoryId: number | null
  /** Unclaimed incentives listed under this market, per reward asset, summed over the account's holders; never in the USD sums above. */
  unclaimedRewards: MmHistoryReward[]
  /** Cumulative interest earned / paid through this bucket over the reserves whose figure is priced and stated; null before the coverage floor. */
  interestEarnedUsd: bigint | null
  interestPaidUsd: bigint | null
  /** Reserve sides (earned or paid) left out of those sums: unpriced or unstatable (their USD is null). Not in `unpriced`, which counts held legs. */
  interestUnpriced: number
}
export interface MmHistoryReward {
  rewardAssetId: number
  /** Raw units claimable at the bucket end, SETTLED (see mmIncentiveHistory.ts). */
  amount: bigint
  /** At the bucket's closed candle; null when unpriced (then counted in rewardsIncomplete). */
  valueUsd: bigint | null
  /** The newest programme index update behind the pending part; null when nothing is pending. */
  settledAtBlock: number | null
}
export interface MmHistoryMarket {
  marketKey: string
  poolAddress: string
  stakingBacked: boolean
  /** Buckets where a reserve was held, the market's observation shows collateral or debt, or incentives were unclaimed. */
  points: MmHistoryMarketPoint[]
  reserves: MmHistoryReserve[]
  /** The market points' interest figures at the grid's last bucket (never trimmed by bucket selection). */
  interestEarnedUsd: bigint | null
  interestPaidUsd: bigint | null
  interestUnpriced: number
}
export interface MoneyMarketHistory {
  /** B0: reserve amounts exist only from here; null without a published anchor. */
  reserveHistoryFrom: { blockHeight: number } | null
  /** Every bucket: sums ACROSS the isolated markets (health factors are never combined). */
  points: Array<{
    b: number; suppliedUsd: bigint | null; borrowedUsd: bigint | null; unpriced: number
    /** Priced unclaimed incentives across the selected markets; null before the incentive coverage floor (or when not asked for). */
    unclaimedRewardsUsd: bigint | null
    /** (holder, reward) incentive amounts owed but left out of unclaimedRewardsUsd: not statable, not reconciled with the chain, or unpriced. */
    rewardsIncomplete: number
  }>
  markets: MmHistoryMarket[]
}

/** The listing key of a reserve series: its exposure at its newest point (reserveExposureUsd). */
const newestExposure = (r: MmHistoryReserve) => ({ exposureUsd: reserveExposureUsd(r.points[r.points.length - 1]), assetId: r.assetId })

/**
 * The per-reserve series, per-market lines and the account line, priced — pure and
 * integer. A held leg is valued only with a closed candle; otherwise it is null and
 * counted in its bucket's `unpriced`, never valued at zero. A held reserve whose
 * amount cannot be stated at a bucket (its index update is unresolved) has no point
 * there and is counted too. Before the coverage floor every reserve figure is null.
 * Interest earned/paid (reserveInterestSide) is accumulated here on the full grid, so
 * the cumulative figures survive selectMoneyMarketBuckets.
 */
export function assembleMoneyMarketHistory(parts: MmHistoryParts, pricer: BucketPricer, bk: Pick<Bucketing, 'N' | 'endHeight'>): MoneyMarketHistory {
  const N = bk.N
  const b0 = parts.reserveMap.anchorBlock
  const stated = (b: number) => b0 > 0 && bk.endHeight(b) >= b0
  const want = (key: string) => !parts.markets || parts.markets.has(key)

  interface MarketAcc {
    key: string; pool: string; supplied: (bigint | null)[]; borrowed: (bigint | null)[]; unpriced: number[]; held: boolean[]; reserves: MmHistoryReserve[]
    earnedUsd: (bigint | null)[]; paidUsd: (bigint | null)[]; interestUnpriced: number[]
  }
  const markets = new Map<string, MarketAcc>()
  const marketFor = (key: string, pool: string): MarketAcc => {
    let m = markets.get(pool)
    if (!m) {
      m = {
        key, pool, supplied: new Array(N + 1).fill(null), borrowed: new Array(N + 1).fill(null), unpriced: new Array(N + 1).fill(0), held: new Array(N + 1).fill(false), reserves: [],
        earnedUsd: new Array(N + 1).fill(null), paidUsd: new Array(N + 1).fill(null), interestUnpriced: new Array(N + 1).fill(0),
      }
      for (let b = 0; b <= N; b++) if (stated(b)) { m.supplied[b] = 0n; m.borrowed[b] = 0n; m.earnedUsd[b] = 0n; m.paidUsd[b] = 0n }
      markets.set(pool, m)
    }
    return m
  }
  for (const r of parts.reserveMap.reserves) if (want(r.marketKey)) marketFor(r.marketKey, r.poolProxy)

  for (const r of parts.reserveMap.reserves) {
    if (!want(r.marketKey)) continue
    const m = marketFor(r.marketKey, r.poolProxy)
    const aSeries = parts.scaled.get(r.atoken)
    const dSeries = r.vdebt ? parts.scaled.get(r.vdebt) : undefined
    if (!aSeries && !dSeries) continue
    const idxSeries = parts.indices.get(reserveKey(r.poolProxy, r.assetAddress))
    const flags = parts.collateral.get(reserveKey(r.poolProxy, r.assetAddress))
    const assetId = assetIdFromMmAddress(r.assetAddress)
    // Interest on the FULL grid, before any bucket selection (reserveInterestSide).
    const price = (amount: bigint, b: number) => (assetId == null ? null : pricer.usd(assetId, amount, b))
    const earned = reserveInterestSide(aSeries, idxSeries, parts.endTimes, 'supply', stated, N, price)
    const paid = reserveInterestSide(dSeries, idxSeries, parts.endTimes, 'debt', stated, N, price)
    const interestAt = (b: number): MmHistoryInterest => ({
      interestEarned: earned.raw[b], interestPaid: paid.raw[b], interestEarnedUsd: earned.usd[b], interestPaidUsd: paid.usd[b],
      interestIncomplete: earned.incomplete[b] || paid.incomplete[b],
    })
    const points: MmHistoryReservePoint[] = []
    for (let b = 0; b <= N; b++) {
      if (!stated(b)) continue
      const a = aSeries?.[b] ?? 0n
      const d = dSeries?.[b] ?? 0n
      const heldSides = (a > 0n ? 1 : 0) + (d > 0n ? 1 : 0)
      if (!heldSides) continue
      m.held[b] = true
      const idx = idxSeries?.[b]
      const t = parts.endTimes[b]
      if (!idx || t == null || assetId == null) { m.unpriced[b] += heldSides; continue }
      const { supplied, borrowed } = reserveAmountsAt(a, d, idx, BigInt(t))
      const suppliedUsd = supplied > 0n ? pricer.usd(assetId, supplied, b) : 0n
      const borrowedUsd = borrowed > 0n ? pricer.usd(assetId, borrowed, b) : 0n
      if (supplied > 0n) { if (suppliedUsd == null) m.unpriced[b]++; else m.supplied[b]! += suppliedUsd }
      if (borrowed > 0n) { if (borrowedUsd == null) m.unpriced[b]++; else m.borrowed[b]! += borrowedUsd }
      if (supplied <= 0n && borrowed <= 0n) continue
      points.push({
        b, supplied, borrowed,
        suppliedUsd: supplied > 0n ? suppliedUsd : 0n,
        borrowedUsd: borrowed > 0n ? borrowedUsd : 0n,
        collateral: supplied > 0n ? (flags?.[b] ?? null) : false,
        ...interestAt(b),
      })
    }
    if (points.length && assetId != null) {
      m.reserves.push({ assetId, reserveAddress: r.assetAddress, aTokenAssetId: UNDERLYING_TO_ATOKEN_ID[assetId] ?? null, points, ...interestAt(N) })
      for (let b = 0; b <= N; b++) {
        if (!stated(b)) continue
        if (earned.usd[b] == null) m.interestUnpriced[b]++; else m.earnedUsd[b]! += earned.usd[b]!
        if (paid.usd[b] == null) m.interestUnpriced[b]++; else m.paidUsd[b]! += paid.usd[b]!
      }
    }
  }

  // Unclaimed incentives per (market, bucket), summed over holders per reward asset.
  const rewards = parts.rewards ?? null
  const rewardsStated = (b: number) => rewards != null && rewards.anchorBlock > 0 && bk.endHeight(b) >= rewards.anchorBlock
  const rewardsByMarket = new Map<string, Map<number, MmHistoryReward[]>>()
  const rewardUnpriced = new Array<number>(N + 1).fill(0)
  if (rewards) {
    for (let b = 0; b <= N; b++) {
      const grouped = new Map<string, MmHistoryReward & { marketKey: string }>()
      for (const item of rewards.itemsByBucket[b] ?? []) {
        if (!want(item.marketKey)) continue
        const k = `${item.marketKey}|${item.rewardAssetId}`
        const g = grouped.get(k)
        if (g) {
          g.amount += item.amount
          if (item.settledAtBlock != null && (g.settledAtBlock == null || item.settledAtBlock > g.settledAtBlock)) g.settledAtBlock = item.settledAtBlock
        } else grouped.set(k, { marketKey: item.marketKey, rewardAssetId: item.rewardAssetId, amount: item.amount, valueUsd: null, settledAtBlock: item.settledAtBlock })
      }
      for (const g of grouped.values()) {
        g.valueUsd = pricer.usd(g.rewardAssetId, g.amount, b)
        if (g.valueUsd == null) rewardUnpriced[b]++
        const perBucket = rewardsByMarket.get(g.marketKey) ?? rewardsByMarket.set(g.marketKey, new Map()).get(g.marketKey)!
        const list = perBucket.get(b) ?? []
        list.push({ rewardAssetId: g.rewardAssetId, amount: g.amount, valueUsd: g.valueUsd, settledAtBlock: g.settledAtBlock })
        perBucket.set(b, list.sort((x, y) => x.rewardAssetId - y.rewardAssetId))
      }
    }
  }
  const totals = Array.from({ length: N + 1 }, (_, b) => {
    let unclaimedRewardsUsd: bigint | null = null
    if (rewardsStated(b)) {
      unclaimedRewardsUsd = 0n
      for (const perBucket of rewardsByMarket.values()) for (const r of perBucket.get(b) ?? []) if (r.valueUsd != null) unclaimedRewardsUsd += r.valueUsd
    }
    return {
      b, suppliedUsd: stated(b) ? 0n as bigint | null : null, borrowedUsd: stated(b) ? 0n as bigint | null : null, unpriced: 0,
      unclaimedRewardsUsd, rewardsIncomplete: rewardsStated(b) ? (rewards!.incompleteByBucket[b] ?? 0) + rewardUnpriced[b] : 0,
    }
  })
  const out: MmHistoryMarket[] = []
  for (const m of markets.values()) {
    const obs = parts.observations.get(m.pool)
    const emode = parts.emode.get(m.pool)
    const marketRewards = rewardsByMarket.get(m.key)
    const points: MmHistoryMarketPoint[] = []
    for (let b = 0; b <= N; b++) {
      const o = obs?.[b]
      const open = o != null && (big(o.totalCollateralBase) > 0n || big(o.totalDebtBase) > 0n)
      if (stated(b)) {
        totals[b].suppliedUsd! += m.supplied[b]!
        totals[b].borrowedUsd! += m.borrowed[b]!
        totals[b].unpriced += m.unpriced[b]
      }
      const unclaimedRewards = marketRewards?.get(b) ?? []
      if (!m.held[b] && !open && !unclaimedRewards.length) continue
      const s = m.supplied[b]
      const d = m.borrowed[b]
      points.push({
        b, suppliedUsd: s, borrowedUsd: d,
        netUsd: s != null && d != null && m.unpriced[b] === 0 ? s - d : null,
        unpriced: m.unpriced[b],
        observation: o ?? null,
        eModeCategoryId: emode?.[b] ?? null,
        unclaimedRewards,
        interestEarnedUsd: m.earnedUsd[b], interestPaidUsd: m.paidUsd[b], interestUnpriced: m.interestUnpriced[b],
      })
    }
    if (!points.length) continue
    m.reserves.sort((x, y) => compareReserveExposure(newestExposure(x), newestExposure(y)))
    out.push({
      marketKey: m.key, poolAddress: m.pool, stakingBacked: mmMarketStakingBacked(m.key), points, reserves: m.reserves,
      interestEarnedUsd: m.earnedUsd[N], interestPaidUsd: m.paidUsd[N], interestUnpriced: m.interestUnpriced[N],
    })
  }
  out.sort((x, y) => mmMarketCompare(x.marketKey, y.marketKey))
  return { reserveHistoryFrom: b0 > 0 ? { blockHeight: b0 } : null, points: totals, markets: out }
}

/** Keep only the buckets `keep` names (ascending; `b` keeps its value), and markets still with a point. Pure. */
export function selectMoneyMarketBuckets(history: MoneyMarketHistory, keep: readonly number[]): MoneyMarketHistory {
  const kept = new Set(keep)
  const markets = history.markets
    .map(m => ({
      ...m,
      points: foldLowestHealthFactor(m.points, kept),
      reserves: m.reserves.map(r => ({ ...r, points: r.points.filter(p => kept.has(p.b)) })).filter(r => r.points.length > 0),
    }))
    .filter(m => m.points.length > 0)
  return { ...history, points: history.points.filter(p => kept.has(p.b)), markets }
}

/**
 * The kept market points, each carrying the lowest health factor of every point
 * since the previous kept one (a published day folds its finer buckets), so a dip
 * inside a dropped bucket still shows on the bucket that publishes it. Pure.
 */
function foldLowestHealthFactor(points: MmHistoryMarketPoint[], kept: ReadonlySet<number>): MmHistoryMarketPoint[] {
  const out: MmHistoryMarketPoint[] = []
  let low: { hf: string; block: number } | null = null
  for (const p of points) {
    const o = p.observation
    if (o?.lowestHealthFactor != null && /^\d+$/.test(o.lowestHealthFactor) && (low == null || BigInt(o.lowestHealthFactor) < BigInt(low.hf))) {
      low = { hf: o.lowestHealthFactor, block: o.lowestAtBlock ?? o.block }
    }
    if (!kept.has(p.b)) continue
    out.push(o && low ? { ...p, observation: { ...o, lowestHealthFactor: low.hf, lowestAtBlock: low.block } } : p)
    low = null
  }
  return out
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface MoneyMarketHistoryOptions {
  grain: PriceGrain
  /** Keep only these market keys (validated by the caller against the reserve map). */
  markets?: ReadonlySet<string>
  /** Publish only these bucket indices (the explorer's un-windowed one-per-day view). */
  buckets?: readonly number[]
  /** Fold in the unclaimed incentives (default true). */
  rewards?: boolean
}

export interface MoneyMarketHistoryPage extends MoneyMarketHistory {
  /** Timestamps (unix seconds) of the published observations' blocks and of B0. */
  blockTimes: Map<number, number>
}

/**
 * The money-market history both surfaces serve for an account's EVM identities
 * (the H160s the pools know it by): reserve map, scaled principal, reserve
 * indices of the reserves it touched, observations, collateral flags and E-mode,
 * priced on `grain` closes, assembled and narrowed to `buckets`.
 *
 * Several identities (the explorer's related set): the reserve legs and the
 * incentives SUM every identity's, while each market's observation (health factor,
 * base-currency aggregates) is ONE identity's — `scope.primary` wherever it has
 * one there (chooseObservationHolders) — so a health factor is never blended.
 */
export async function loadMoneyMarketHistory(
  client: ClickHouseClient,
  scope: { h160s: readonly string[]; primary?: string | null },
  bk: Bucketing,
  opts: MoneyMarketHistoryOptions,
): Promise<MoneyMarketHistoryPage> {
  const reserveMap = await loadMmReserveMap(client)
  const [scaledByHolder, observations, collateral, emode] = await Promise.all([
    loadScaledHistoryByHolder(client, scope.h160s, reserveMap.anchorBlock, bk),
    loadObservationHistory(client, scope.h160s, [...new Set(reserveMap.reserves.map(r => r.poolProxy))], bk, scope.primary ?? null),
    loadCollateralFlagHistory(client, scope.h160s, bk),
    loadEmodeHistory(client, scope.h160s, bk),
  ])
  const scaled = sumScaledByContract(scaledByHolder)
  const want = (key: string) => !opts.markets || opts.markets.has(key)
  const touched = reserveMap.reserves.filter(r => want(r.marketKey) && (scaled.has(r.atoken) || (r.vdebt && scaled.has(r.vdebt))))
  const endHeights = Array.from({ length: bk.N + 1 }, (_, b) => bk.endHeight(b))
  const [indices, endTimeByHeight, rewards] = await Promise.all([
    loadReserveIndexHistory(client, touched.map(r => ({ pool: r.poolProxy, reserve: r.assetAddress })), bk,
      reserveMap.reserves.map(r => ({ pool: r.poolProxy, reserve: r.assetAddress }))),
    loadBlockTimes(client, [...endHeights, ...(reserveMap.anchorBlock ? [reserveMap.anchorBlock] : [])]),
    // The incentive arithmetic reads the same per-holder scaled series (its
    // programme aTokens), so the deltas are read once for both.
    opts.rewards === false ? Promise.resolve(null) : loadMmIncentiveHistory(client, scope.h160s, bk, reserveMap.reserves, { scaled: scaledByHolder, scaledAnchorBlock: reserveMap.anchorBlock }),
  ])
  const priceIds = new Set<number>()
  for (const r of touched) { const id = assetIdFromMmAddress(r.assetAddress); if (id != null) priceIds.add(id) }
  for (const id of rewards?.rewardAssetIds ?? []) priceIds.add(id)
  const pricer = await bucketClosePrices(client, priceIds, bk, opts.grain)
  const assembled = assembleMoneyMarketHistory({
    reserveMap, scaled, indices, observations, collateral, emode, markets: opts.markets, rewards,
    endTimes: endHeights.map(h => endTimeByHeight.get(h) ?? null),
  }, pricer, bk)
  const history = opts.buckets ? selectMoneyMarketBuckets(assembled, opts.buckets) : assembled
  // Observation block times for the published points only.
  const obsHeights = new Set<number>()
  for (const m of history.markets) for (const p of m.points) if (p.observation) obsHeights.add(p.observation.block)
  const missing = [...obsHeights].filter(h => !endTimeByHeight.has(h))
  const blockTimes = new Map(endTimeByHeight)
  for (const [h, t] of await loadBlockTimes(client, missing)) blockTimes.set(h, t)
  return { ...history, blockTimes }
}
