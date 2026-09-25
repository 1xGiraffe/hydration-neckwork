import type { ClickHouseClient } from '../db/client.ts'
import { incentivePending } from './aaveMath.ts'
import { canonicalPlan, type Bucketing } from './bucketLadder.ts'
import { cached } from './cache.ts'
import { assetDecimalsOrNull, assetIdFromMmAddress } from './explorerAssets.ts'
import { loadMmIncentives, mmPrimaryMarket } from './mmIncentiveSnapshot.ts'
import { tagged } from './queryTag.ts'

// Unclaimed money-market (lending) incentives per bucket end: for every holder and
// reward asset, what claimAllRewards would have paid at the bucket's end block —
// SETTLED, the RewardsController's state as the chain held it there:
//
//   accrued(h) = anchor@B0 + Σ Accrued.rewardsAccrued − Σ RewardsClaimed.amount   (B0 < block ≤ h)
//   pending(h) = Σ_asset scaled(h) × (programme index(h) − user index(h)) / 10^decimals
//
// where the programme index is its last stored value at or before h (every Accrued
// and every AssetConfigUpdated writes it), the user index the holder's last Accrued
// at or before h (else its B0 anchor, else 0 — the index of a holder the programme
// has never touched), and scaled(h) the aToken's scaled balance (atoken_scaled_anchor
// at B0 plus every indexed delta). An active programme's emission since its last
// update is therefore not in it — never an estimate of it; the current figure
// (mmIncentiveSnapshot) is the chain's own claimable at its block instead.
//
// One definition for the money-market history surfaces (the explorer's
// /explorer/address/:a/money-market-history and the Data API's
// /v1/accounts/{address}/money-market/history, through moneyMarketHistory.ts which
// re-exports it) and the value chart's incentive series, so a leaf.
//
// Stated from B0 on (the incentive anchor block, which is the scaled anchor's):
// a bucket ending before it has no incentive figures. A (holder, reward) whose
// arithmetic does not reconcile with the chain in the NEWEST snapshot generation
// (a log or balance gap the arithmetic cannot see) is counted incomplete in every
// bucket, never valued — whatever that generation's age: a pointer too old for the
// current figure still says which pairs the arithmetic got wrong, and a stale
// refresher must not turn them back into stated history. So is one the arithmetic
// cannot state at a bucket (a negative accrual, an index that went backwards). A
// programme with no stored index yet at a bucket has index 0 — the controller's own
// value for an asset it never updated (a Solidity mapping's default) — not an
// unknown one.
//
// Cost: everything is holder-first except the programme index, which is the same
// for every holder. It is read only for the programmes whose aToken one of the
// holders has a positive scaled balance on (pending needs it; the stored accrual
// does not), and on a canonical grid (bucketLadder canonicalPlan) it is folded
// once per grid for every programme and shared by every account on it. The
// money-market routes pass their per-holder scaled series in (`opts.scaled`), so
// the scaled deltas are read once per request.

export interface MmIncentiveProgrammeRef {
  /** The incentivized asset (an aToken contract). */
  asset: string
  reward: string
  /** 10^decimals of the incentivized asset; null when the registry cannot state it (its pending part is then unstated). */
  unit: bigint | null
  marketKey: string
}

export interface MmIncentiveHistoryItem {
  holder: string
  marketKey: string
  rewardAssetId: number
  /** Raw units of rewardAssetId claimable at the bucket end, settled. */
  amount: bigint
  /** The newest programme index update behind the pending part (null: nothing pending, the accrual is stored). */
  settledAtBlock: number | null
}

export interface MmIncentiveHistory {
  /** B0; 0 without a published anchor (every bucket is then unstated). */
  anchorBlock: number
  /** Per bucket 0..N: every (holder, reward) with a stated, non-zero claimable. */
  itemsByBucket: MmIncentiveHistoryItem[][]
  /** Per bucket: (holder, reward) pairs owed something whose amount is not stated (see header). */
  incompleteByBucket: number[]
  rewardAssetIds: number[]
}

export interface MmIncentiveParts {
  anchorBlock: number
  programmes: MmIncentiveProgrammeRef[]
  /** `${holder}|${asset}` → scaled per bucket (undefined before B0). */
  scaled: Map<string, (bigint | undefined)[]>
  /** `${holder}|${asset}|${reward}` → bucket (-1 = carry) → accrual sum and the last user index in it. */
  accruals: Map<string, Map<number, { acc: bigint; idx: bigint }>>
  /** `${holder}|${reward}` → bucket (-1 = carry) → claimed sum. */
  claims: Map<string, Map<number, bigint>>
  anchorAccrued: Map<string, bigint>
  anchorUserIndex: Map<string, bigint>
  anchorProgrammeIndex: Map<string, bigint>
  /** `${asset}|${reward}` → bucket (-1 = carry) → the last index stored in it and its block. */
  programmeIndex: Map<string, Map<number, { idx: bigint; block: number }>>
  /** `${holder}|${reward}` pairs the current snapshot did not reconcile. */
  unreconciled: ReadonlySet<string>
}

function forward<T>(n: number, perBucket: Map<number, T> | undefined, initial: T | undefined): (T | undefined)[] {
  const out: (T | undefined)[] = new Array(n + 1)
  let last = perBucket?.get(-1) ?? initial
  for (let b = 0; b <= n; b++) { const v = perBucket?.get(b); if (v !== undefined) last = v; out[b] = last }
  return out
}

/** The per-bucket claimable of every (holder, reward), pure and integer. */
export function mmIncentiveSeries(parts: MmIncentiveParts, bk: Pick<Bucketing, 'N' | 'endHeight'>): MmIncentiveHistory {
  const N = bk.N
  const itemsByBucket: MmIncentiveHistoryItem[][] = Array.from({ length: N + 1 }, () => [])
  const incompleteByBucket = new Array<number>(N + 1).fill(0)
  const rewardIds = new Set<number>()
  const b0 = parts.anchorBlock
  if (!b0) return { anchorBlock: 0, itemsByBucket, incompleteByBucket, rewardAssetIds: [] }
  const stated = (b: number) => bk.endHeight(b) >= b0

  // Every (holder, reward) with anything to say: an anchor accrual, an event, or a balance on one of its programmes.
  const pairs = new Set<string>()
  for (const k of parts.anchorAccrued.keys()) pairs.add(k)
  for (const k of parts.claims.keys()) pairs.add(k)
  for (const k of parts.accruals.keys()) { const [h, , r] = k.split('|'); pairs.add(`${h}|${r}`) }
  for (const k of parts.scaled.keys()) {
    const [h, a] = k.split('|')
    for (const p of parts.programmes) if (p.asset === a) pairs.add(`${h}|${p.reward}`)
  }
  const progSeries = new Map<string, ({ idx: bigint; block: number } | undefined)[]>()
  for (const p of parts.programmes) {
    const key = `${p.asset}|${p.reward}`
    const anchor = parts.anchorProgrammeIndex.get(key)
    progSeries.set(key, forward(N, parts.programmeIndex.get(key), anchor != null ? { idx: anchor, block: b0 } : undefined))
  }

  for (const pair of [...pairs].sort()) {
    const [holder, reward] = pair.split('|')
    const rewardAssetId = assetIdFromMmAddress(reward)
    if (rewardAssetId == null) continue
    const legs = parts.programmes.filter(p => p.reward === reward)
    // Running accrual per bucket: anchor, the pre-range events (carry), then each bucket's.
    const accrued = new Array<bigint>(N + 1)
    let running = (parts.anchorAccrued.get(pair) ?? 0n) - (parts.claims.get(pair)?.get(-1) ?? 0n)
    const accMaps = legs.map(p => parts.accruals.get(`${holder}|${p.asset}|${reward}`))
    for (const m of accMaps) running += m?.get(-1)?.acc ?? 0n
    for (let b = 0; b <= N; b++) {
      running -= parts.claims.get(pair)?.get(b) ?? 0n
      for (const m of accMaps) running += m?.get(b)?.acc ?? 0n
      accrued[b] = running
    }
    const legSeries = legs.map((p, i) => {
      const idxMap = accMaps[i] ? new Map([...accMaps[i]!].map(([b, v]) => [b, v.idx])) : undefined
      return {
        p,
        scaled: parts.scaled.get(`${holder}|${p.asset}`),
        userIdx: forward(N, idxMap, parts.anchorUserIndex.get(`${holder}|${p.asset}|${reward}`) ?? 0n),
        prog: progSeries.get(`${p.asset}|${reward}`)!,
      }
    })
    // Each pending part is filed under its aToken's market. The stored accrual is
    // one figure per (holder, reward) — RewardsClaimed names no aToken, so the logs
    // cannot split it — and is filed under the pair's primary market: the core
    // market when the reward incentivizes it, else the first of its markets. A pair
    // within one market (every programme today) is therefore exact per market, and
    // the account line, which sums markets, is exact either way.
    const primary = mmPrimaryMarket([...new Set(legs.map(p => p.marketKey))])
    for (let b = 0; b <= N; b++) {
      if (!stated(b)) continue
      let ok = accrued[b] >= 0n
      const amounts = new Map<string, { amount: bigint; settledAt: number | null }>([[primary, { amount: ok ? accrued[b] : 0n, settledAt: null }]])
      for (const leg of legSeries) {
        const scaled = leg.scaled?.[b] ?? 0n
        if (scaled <= 0n) continue
        const prog = leg.prog[b]
        const user = leg.userIdx[b] ?? 0n
        // No stored index at or before the end is index 0 (see the header), never unknown.
        const idx = prog?.idx ?? 0n
        if (idx < user || leg.p.unit == null) { ok = false; continue }
        const m = amounts.get(leg.p.marketKey) ?? amounts.set(leg.p.marketKey, { amount: 0n, settledAt: null }).get(leg.p.marketKey)!
        m.amount += incentivePending(scaled, idx, user, leg.p.unit)
        if (prog && (m.settledAt == null || prog.block > m.settledAt)) m.settledAt = prog.block
      }
      const total = [...amounts.values()].reduce((sum, m) => sum + m.amount, 0n)
      if (parts.unreconciled.has(pair)) { if (!ok || total > 0n || accrued[b] !== 0n) incompleteByBucket[b]++; continue }
      if (!ok) { incompleteByBucket[b]++; continue }
      for (const [marketKey, m] of [...amounts].sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))) {
        if (m.amount <= 0n) continue
        rewardIds.add(rewardAssetId)
        itemsByBucket[b].push({ holder, marketKey, rewardAssetId, amount: m.amount, settledAtBlock: m.settledAt })
      }
    }
  }
  return { anchorBlock: b0, itemsByBucket, incompleteByBucket, rewardAssetIds: [...rewardIds].sort((a, b) => a - b) }
}

// ───────────────────────── loader ─────────────────────────

const big = (v: unknown): bigint => (/^-?\d+$/.test(String(v ?? '')) ? BigInt(String(v)) : 0n)

async function select<T>(client: ClickHouseClient, query: string, params: Record<string, unknown>): Promise<T[]> {
  const res = await client.query(tagged({ query, query_params: params, format: 'JSONEachRow' as const }))
  return res.json<T>()
}

const normH160s = (h160s: readonly string[]): string[] =>
  [...new Set(h160s.map(h => h.toLowerCase()))].filter(h => /^0x[0-9a-f]{40}$/.test(h))

/** How far below a window's floor the programme-index carry is looked for first (the reserve-index fold's lookback). */
const CARRY_LOOKBACK_BLOCKS = 100_000

function bucketFingerprint(bk: Bucketing): string {
  let h = 2166136261
  const feed = (n: number) => { h ^= n >>> 0; h = Math.imul(h, 16777619) >>> 0 }
  feed(bk.t0); feed(bk.step); feed(bk.N); feed(bk.floorHeight)
  for (let b = 0; b <= bk.N; b++) feed(bk.endHeight(b))
  return h.toString(16)
}

type ProgrammeIndexMap = Map<string, Map<number, { idx: bigint; block: number }>>

/** The programmes' last stored index per bucket of `bk` (and the -1 carry into it), folded on that grid. */
async function programmeIndexOnGrid(client: ClickHouseClient, programmes: MmIncentiveProgrammeRef[], anchorBlock: number, bk: Bucketing): Promise<ProgrammeIndexMap> {
  const assets = [...new Set(programmes.map(p => p.asset))].sort()
  const out: ProgrammeIndexMap = new Map()
  if (!assets.length) return out
  const maxb = bk.endHeight(bk.N)
  const lo = Math.max(anchorBlock + 1, bk.floorHeight - CARRY_LOOKBACK_BLOCKS)
  type Row = { asset: string; reward: string; b: number; idx: string; blk: number }
  const fold = (tag: string, bucketSql: string, from: number, to: number, assetList: string[]) => select<Row>(client, `-- ${tag}
    SELECT asset_address AS asset, reward_address AS reward, ${bucketSql} AS b,
      toString(argMax(asset_index, (block_height, event_index))) AS idx, max(block_height) AS blk
    FROM price_data.mm_incentive_index_updates
    WHERE asset_address IN {assets:Array(String)} AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
    GROUP BY asset, reward, b`, { assets: assetList, from, to })
  let rows = maxb >= lo ? await fold('mm:incentive-index', bk.ofHeightCarry('block_height'), lo, maxb, assets) : []
  if (lo > anchorBlock + 1) {
    const carried = new Set(rows.filter(r => Number(r.b) === -1).map(r => `${r.asset}|${r.reward}`))
    const quiet = programmes.filter(p => !carried.has(`${p.asset}|${p.reward}`))
    if (quiet.length) rows = [...await fold('mm:incentive-index-carry', 'toInt32(-1)', anchorBlock + 1, Math.min(lo - 1, maxb), [...new Set(quiet.map(p => p.asset))]), ...rows]
  }
  for (const r of rows) {
    const k = `${r.asset}|${r.reward}`
    const m = out.get(k) ?? out.set(k, new Map()).get(k)!
    const b = Number(r.b)
    const prev = m.get(b)
    // The carry may come from both reads; the newer block wins.
    if (!prev || Number(r.blk) > prev.block) m.set(b, { idx: big(r.idx), block: Number(r.blk) })
  }
  return out
}

/** Each programme's last stored index in [from, to] (absent: none there). */
async function programmeIndexBetween(client: ClickHouseClient, programmes: MmIncentiveProgrammeRef[], from: number, to: number): Promise<Map<string, { idx: bigint; block: number }>> {
  const out = new Map<string, { idx: bigint; block: number }>()
  const assets = [...new Set(programmes.map(p => p.asset))].sort()
  if (!assets.length || to < from) return out
  const rows = await select<{ asset: string; reward: string; idx: string; blk: number }>(client, `-- mm:incentive-index-tail
    SELECT asset_address AS asset, reward_address AS reward,
      toString(argMax(asset_index, (block_height, event_index))) AS idx, max(block_height) AS blk
    FROM price_data.mm_incentive_index_updates
    WHERE asset_address IN {assets:Array(String)} AND block_height >= {from:UInt32} AND block_height <= {to:UInt32}
    GROUP BY asset, reward`, { assets, from, to })
  for (const r of rows) out.set(`${r.asset}|${r.reward}`, { idx: big(r.idx), block: Number(r.blk) })
  return out
}

/** How long a canonical programme-index fold whose last boundary is past the finality hour is kept. */
const PROGRAMME_INDEX_CANON_TTL_MS = 10 * 60_000

/**
 * The programmes' last stored index per bucket (and the carry into the window) —
 * programme-first and the same for every account on one grid. On a canonical grid
 * (canonicalPlan) it is folded once for EVERY programme and cached on the grid, and
 * the account's buckets are looked up by boundary (its last bucket, ending at the
 * head, adds the updates since the lattice boundary below it); any other grid folds
 * only `programmes` on its own, cached briefly on its fingerprint.
 */
async function loadProgrammeIndex(
  client: ClickHouseClient, programmes: MmIncentiveProgrammeRef[], allProgrammes: MmIncentiveProgrammeRef[], anchorBlock: number, bk: Bucketing,
): Promise<ProgrammeIndexMap> {
  if (!programmes.length) return new Map()
  const plan = canonicalPlan(bk)
  if (!plan) {
    const assets = [...new Set(programmes.map(p => p.asset))].sort()
    return cached(`mm:incentive-index:${bucketFingerprint(bk)}:${anchorBlock}:${assets.join(',')}`, 60_000, () => programmeIndexOnGrid(client, programmes, anchorBlock, bk))
  }
  const cb = plan.grid.bk
  const allAssets = [...new Set(allProgrammes.map(p => p.asset))].sort()
  const recent = Date.now() / 1000 - cb.endSec(cb.N) < 3_600
  const canon = await cached(`mm:incentive-index:canon:${plan.grid.key}:${anchorBlock}:${allAssets.join(',')}`, recent ? 60_000 : PROGRAMME_INDEX_CANON_TTL_MS, async () => {
    const folded = await programmeIndexOnGrid(client, allProgrammes, anchorBlock, cb)
    return new Map([...folded].map(([k, perBucket]) => [k, forward(cb.N, perBucket, undefined)]))
  })
  const tail = plan.tail ? await programmeIndexBetween(client, programmes, Math.max(anchorBlock + 1, plan.tail.fromHeight), plan.tail.toHeight) : null
  const out: ProgrammeIndexMap = new Map()
  for (const p of programmes) {
    const key = `${p.asset}|${p.reward}`
    const series = canon.get(key)
    const m = new Map<number, { idx: bigint; block: number }>()
    for (let b = 0; b <= bk.N; b++) {
      const i = plan.grid.map[b]
      const v = i == null ? undefined : series?.[i]
      if (v) m.set(b, v)
    }
    if (plan.tail) {
      const v = tail!.get(key) ?? series?.[plan.tail.prev]
      if (v) m.set(plan.tail.b, v)
    }
    out.set(key, m)
  }
  return out
}

/**
 * Both anchor blocks (the incentive anchor's and the scaled-balance anchor's), for
 * one minute: the anchors loop rewrites them rarely (a re-anchor), and the check is
 * on every history read, so an uncached pair of max() reads is pure overhead.
 */
function loadIncentiveAnchorBlocks(client: ClickHouseClient): Promise<{ b0: number; s0: number }> {
  return cached('mm:incentive-anchor-blocks', 60_000, async () => {
    const [row] = await select<{ b0: number; s0: number }>(client, `-- mm:incentive-anchor-blocks
      SELECT (SELECT max(anchor_block) FROM price_data.mm_incentive_anchor) AS b0, (SELECT max(anchor_block) FROM price_data.atoken_scaled_anchor) AS s0`, {})
    return { b0: Number(row?.b0 ?? 0), s0: Number(row?.s0 ?? 0) }
  })
}

/** Every incentive programme (aToken, reward) ever configured, cached 10 minutes (programmes are added rarely). */
export function loadMmIncentiveProgrammeRows(client: ClickHouseClient): Promise<Array<{ asset: string; reward: string }>> {
  return cached('mm:incentive-programmes', 10 * 60_000, () => select<{ asset: string; reward: string }>(client, `-- mm:incentive-programmes
    SELECT DISTINCT asset_address AS asset, reward_address AS reward FROM price_data.mm_incentive_programmes ORDER BY asset, reward`, {}))
}

/**
 * One holder's scaled series on `bk` from its B0 anchor and its per-bucket deltas
 * (bucket -1 = the carry into the window): anchor + deltas, floored at zero,
 * undefined for a bucket ending before B0 — loadScaledHistoryByHolder's rule. Pure.
 */
export function scaledSeriesFromBuckets(anchor: bigint, deltas: ReadonlyMap<number, bigint>, bk: Pick<Bucketing, 'N' | 'endHeight'>, anchorBlock: number): (bigint | undefined)[] {
  const series: (bigint | undefined)[] = new Array(bk.N + 1).fill(undefined)
  let run = anchor + (deltas.get(-1) ?? 0n)
  for (let b = 0; b <= bk.N; b++) {
    run += deltas.get(b) ?? 0n
    if (bk.endHeight(b) >= anchorBlock) series[b] = run > 0n ? run : 0n
  }
  return series
}

/** Options of loadMmIncentiveHistory. */
export interface MmIncentiveHistoryOptions {
  /**
   * The holders' scaled series per `${holder}|${contract}` on this bucketing
   * (moneyMarketHistory's loadScaledHistoryByHolder, or the value chart's own
   * read — scaledSeriesFromBuckets over height-keyed buckets), when the caller has
   * already read them; used only when `scaledAnchorBlock` is the incentive anchor
   * block. Every programme aToken of the holders must be in it.
   */
  scaled?: ReadonlyMap<string, (bigint | undefined)[]>
  scaledAnchorBlock?: number
}

/**
 * The incentive history of the holders (H160s) over the bucketing: programmes and
 * the reserve map's market per incentivized aToken from the caller, everything
 * else holder-first (accruals, claims, the anchor, scaled deltas of the programme
 * aTokens), then the programme-first index fold for the programmes the holders
 * have a balance on.
 */
export async function loadMmIncentiveHistory(
  client: ClickHouseClient,
  h160s: readonly string[],
  bk: Bucketing,
  reserves: readonly MmIncentiveReserveRef[],
  opts: MmIncentiveHistoryOptions = {},
): Promise<MmIncentiveHistory> {
  const hs = normH160s(h160s)
  const empty: MmIncentiveHistory = { anchorBlock: 0, itemsByBucket: Array.from({ length: bk.N + 1 }, () => []), incompleteByBucket: new Array(bk.N + 1).fill(0), rewardAssetIds: [] }
  if (!hs.length) return empty
  const maxb = bk.endHeight(bk.N)
  const anchorRow = await loadIncentiveAnchorBlocks(client)
  const anchorBlock = anchorRow.b0
  // The arithmetic needs both anchors at one block; without them nothing is stated.
  if (!anchorBlock || anchorBlock !== anchorRow.s0 || maxb < anchorBlock) return { ...empty, anchorBlock: maxb < anchorBlock ? anchorBlock : 0 }
  const programmeRows = await loadMmIncentiveProgrammeRows(client)
  const byAtoken = new Map(reserves.map(r => [r.atoken.toLowerCase(), r]))
  const programmes: MmIncentiveProgrammeRef[] = programmeRows.map(r => {
    const reserve = byAtoken.get(r.asset)
    return { asset: r.asset, reward: r.reward, marketKey: reserve?.marketKey ?? 'core', unit: atokenUnit(reserve) }
  })
  if (!programmes.length) return { ...empty, anchorBlock }
  const assets = [...new Set(programmes.map(p => p.asset))]
  const assetSet = new Set(assets)
  const given = opts.scaled && opts.scaledAnchorBlock === anchorBlock ? opts.scaled : null
  type AccRow = { u: string; asset: string; reward: string; b: number; acc: string; idx: string }
  const [accRows, claimRows, anchorRows, ownScaled, reconciliation] = await Promise.all([
    select<AccRow>(client, `-- mm:incentive-accruals
      SELECT user_address AS u, asset_address AS asset, reward_address AS reward, ${bk.ofHeightCarry('block_height')} AS b,
        toString(sum(rewards_accrued)) AS acc, toString(argMax(user_index, (block_height, event_index))) AS idx
      FROM price_data.mm_incentive_accruals FINAL
      WHERE user_address IN {hs:Array(String)} AND block_height > {b0:UInt32} AND block_height <= {maxb:UInt32}
      GROUP BY u, asset, reward, b`, { hs, b0: anchorBlock, maxb }),
    select<{ u: string; reward: string; b: number; amount: string }>(client, `-- mm:incentive-claims
      SELECT user_address AS u, reward_address AS reward, ${bk.ofHeightCarry('block_height')} AS b, toString(sum(amount)) AS amount
      FROM price_data.mm_incentive_claims FINAL
      WHERE user_address IN {hs:Array(String)} AND block_height > {b0:UInt32} AND block_height <= {maxb:UInt32}
      GROUP BY u, reward, b`, { hs, b0: anchorBlock, maxb }),
    select<{ u: string; asset: string; reward: string; value: string }>(client, `-- mm:incentive-anchor
      SELECT user_address AS u, asset_address AS asset, reward_address AS reward, toString(value) AS value
      FROM price_data.mm_incentive_anchor FINAL
      WHERE user_address IN {users:Array(String)} AND anchor_block = {b0:UInt32}`, { users: [...hs, ''], b0: anchorBlock }),
    given ? Promise.resolve(null) : loadProgrammeScaled(client, hs, assets, anchorBlock, bk),
    // The pairs the arithmetic does not reconcile, from the NEWEST generation
    // whatever its age (see the header); briefly cached per holder set.
    cached(`mm:incentive-reconciliation:${hs.join(',')}`, 60_000, () => loadMmIncentives(client, hs, { maxAgeSeconds: Number.POSITIVE_INFINITY }))
      .catch(() => ({ asOfBlock: null, rewards: [] })),
  ])
  const scaled = new Map<string, (bigint | undefined)[]>()
  if (given) {
    for (const [k, series] of given) {
      const contract = k.slice(k.indexOf('|') + 1)
      if (assetSet.has(contract)) scaled.set(k, series)
    }
  } else for (const [k, series] of ownScaled!) scaled.set(k, series)
  // The programme index is needed only where something is pending: a positive
  // scaled balance on the programme's aToken at some bucket.
  const heldAssets = new Set<string>()
  for (const [k, series] of scaled) if (series.some(v => v != null && v > 0n)) heldAssets.add(k.slice(k.indexOf('|') + 1))
  const progIndex = heldAssets.size
    ? await loadProgrammeIndex(client, programmes.filter(p => heldAssets.has(p.asset)), programmes, anchorBlock, bk)
    : new Map<string, Map<number, { idx: bigint; block: number }>>()
  const accruals = new Map<string, Map<number, { acc: bigint; idx: bigint }>>()
  for (const r of accRows) {
    const k = `${r.u}|${r.asset}|${r.reward}`
    const m = accruals.get(k) ?? accruals.set(k, new Map()).get(k)!
    m.set(Number(r.b), { acc: big(r.acc), idx: big(r.idx) })
  }
  const claims = new Map<string, Map<number, bigint>>()
  for (const r of claimRows) {
    const k = `${r.u}|${r.reward}`
    const m = claims.get(k) ?? claims.set(k, new Map()).get(k)!
    m.set(Number(r.b), big(r.amount))
  }
  const anchorAccrued = new Map<string, bigint>()
  const anchorUserIndex = new Map<string, bigint>()
  const anchorProgrammeIndex = new Map<string, bigint>()
  for (const r of anchorRows) {
    if (r.u === '') anchorProgrammeIndex.set(`${r.asset}|${r.reward}`, big(r.value))
    else if (r.asset === '') anchorAccrued.set(`${r.u}|${r.reward}`, big(r.value))
    else anchorUserIndex.set(`${r.u}|${r.asset}|${r.reward}`, big(r.value))
  }
  const unreconciled = new Set(reconciliation.rewards.filter(r => !r.reconciled).map(r => `${r.holder}|${r.rewardAddress}`))
  return mmIncentiveSeries({ anchorBlock, programmes, scaled, accruals, claims, anchorAccrued, anchorUserIndex, anchorProgrammeIndex, programmeIndex: progIndex, unreconciled }, bk)
}

/** Per holder and programme aToken: the scaled series (anchor + deltas, floored at zero; undefined before B0). */
async function loadProgrammeScaled(client: ClickHouseClient, hs: string[], assets: string[], anchorBlock: number, bk: Bucketing): Promise<Map<string, (bigint | undefined)[]>> {
  const maxb = bk.endHeight(bk.N)
  const [scaledAnchor, scaledDeltas] = await Promise.all([
    select<{ holder: string; contract: string; scaled: string }>(client, `-- mm:incentive-scaled-anchor
      SELECT holder, lower(contract_address) AS contract, toString(scaled_balance) AS scaled
      FROM price_data.atoken_scaled_anchor FINAL
      WHERE holder IN {hs:Array(String)} AND anchor_block = {b0:UInt32} AND lower(contract_address) IN {assets:Array(String)}`, { hs, b0: anchorBlock, assets }),
    select<{ holder: string; contract: string; b: number; delta: string }>(client, `-- mm:incentive-scaled-deltas
      SELECT holder, contract_address AS contract, ${bk.ofHeightCarry('block_height')} AS b, toString(sum(scaled_delta)) AS delta
      FROM price_data.atoken_scaled_deltas FINAL
      WHERE holder IN {hs:Array(String)} AND contract_address IN {assets:Array(String)} AND block_height > {b0:UInt32} AND block_height <= {maxb:UInt32}
      GROUP BY holder, contract, b`, { hs, assets, b0: anchorBlock, maxb }),
  ])
  // Per holder and aToken: anchor + deltas, floored at zero (loadScaledHistoryByHolder's rule).
  const perHolder = new Map<string, { anchor: bigint; deltas: Map<number, bigint> }>()
  const entry = (h: string, c: string) => {
    const k = `${h.toLowerCase()}|${c.toLowerCase()}`
    return perHolder.get(k) ?? perHolder.set(k, { anchor: 0n, deltas: new Map() }).get(k)!
  }
  for (const r of scaledAnchor) entry(r.holder, r.contract).anchor += big(r.scaled)
  for (const r of scaledDeltas) { const d = entry(r.holder, r.contract).deltas; d.set(Number(r.b), (d.get(Number(r.b)) ?? 0n) + big(r.delta)) }
  const scaled = new Map<string, (bigint | undefined)[]>()
  for (const [k, e] of perHolder) scaled.set(k, scaledSeriesFromBuckets(e.anchor, e.deltas, bk, anchorBlock))
  return scaled
}

/** The reserve map entries the loader needs: an aToken, its reserve's underlying asset address and its market. */
export interface MmIncentiveReserveRef { atoken: string; assetAddress: string; marketKey: string }

// An aToken carries its underlying's decimals (Aave initializes it so, and the
// controller's getAssetDecimals is that value), and the registry states the
// underlying's. null when the registry cannot name it: that programme's pending
// part is then unstated (counted incomplete), never computed on a guessed unit.
export function atokenUnit(reserve: MmIncentiveReserveRef | undefined): bigint | null {
  const underlying = reserve ? assetIdFromMmAddress(reserve.assetAddress) : null
  const decimals = underlying != null ? assetDecimalsOrNull(underlying) : null
  return decimals == null ? null : 10n ** BigInt(decimals)
}
