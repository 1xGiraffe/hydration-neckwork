import type {
  AssetRef, ExplorerYields, FarmRewardEntry, FarmRewardsSummary, LiquidityHistoryPosition, LiquidityRewardsClaimed,
  LpPosition, LpShareWrapper, LpUnclaimedReward, PoolYield,
} from '../../types'
import { paths } from '../../router'
import { sumPct, yieldComponentRow, type YieldRow } from './yieldFormat'

// The Liquidity tab's arithmetic, pure and unit-tested: which pool a position
// belongs to, the holder's rate on it, and the tab's sums. USD figures arrive
// as JS numbers the API rendered once from integer math; raw amounts stay
// bigint until display.

export type PoolFamily = 'omnipool' | 'stableswap' | 'xyk' | 'uniswapV3'
export interface PoolIdentity { family: PoolFamily; key: string }

// The Omnipool hub asset (registry id 1), for the H2O leg of an Omnipool position.
export const H2O: AssetRef = { assetId: 1, symbol: 'H2O', name: 'Hydration hub asset', decimals: 12, parachainId: null }

const XYK_POSITION = /^xyk:(\d+):(?:direct|farm)$/

/**
 * The pool a position sits in, keyed the way GET /explorer/yields keys its maps:
 * an Omnipool position (bare or farmed) by its Omnipool asset, wallet-held
 * stableswap shares by the pool (= share asset), an XYK row by its LP token
 * (`xyk:<lpAssetId>:direct|farm`), a concentrated-liquidity NFT or vault share
 * by its pool contract. Null for a venue this tab does not know.
 */
export function poolIdentity(p: LpPosition): PoolIdentity | null {
  switch (p.venue) {
    case 'Omnipool':
    case 'Omnipool Farm':
      return { family: 'omnipool', key: String(p.asset.assetId) }
    case 'Stablepool':
      return { family: 'stableswap', key: String(p.asset.assetId) }
    case 'XYK':
    case 'XYK Farm': {
      const m = XYK_POSITION.exec(p.positionId)
      return m ? { family: 'xyk', key: m[1] } : null
    }
    case 'Uniswap v3':
    case 'Gamma vault':
      return p.poolAddress ? { family: 'uniswapV3', key: p.poolAddress.toLowerCase() } : null
    default:
      return null
  }
}

export function poolYieldOf(yields: ExplorerYields | null | undefined, id: PoolIdentity | null): PoolYield | null {
  if (!yields || !id) return null
  return yields[id.family]?.[id.key] ?? null
}

/**
 * What a wrapped share's aToken earns — the headline the Hydration app states for a
 * "Hydrated" pool (HUSDT over 2-Pool-HUSDT): the pool's fee and legs plus the
 * reserve's supply APY and its incentive programmes, read from the money-market
 * yields under the aToken's own id.
 */
export function wrapperYieldOf(yields: ExplorerYields | null | undefined, wrapper: LpShareWrapper | undefined): PoolYield | null {
  if (!yields || !wrapper) return null
  return yields.moneyMarket?.[wrapper.marketKey]?.[String(wrapper.asset.assetId)]?.supply ?? null
}

/** The rate a wrapped pool's unwrapped shares miss, named in the position's hover. */
export function unwrappedNote(wrapper: LpShareWrapper): string {
  return `Unwrapped pool shares: the money market's supply APY and incentives on this pool are paid on ${wrapper.asset.symbol}, the share supplied there — these shares earn the pool's fee and legs.`
}

export const isFarmVenue = (venue: string): boolean => venue === 'Omnipool Farm' || venue === 'XYK Farm'

type FarmItem = NonNullable<FarmRewardsSummary['items']>[number]

/** The farm entries behind one farmed row: an Omnipool Farm row is one position
 *  NFT, an XYK Farm row the pool's whole farmed principal (every deposit). */
export function farmEntriesOf(p: LpPosition, items: FarmItem[] | undefined): FarmItem[] {
  if (!isFarmVenue(p.venue) || !items) return []
  return items.filter(i => i.positionId === p.positionId && (i.venue == null || i.venue === p.venue))
}

/** The pool-level rate (the Hydration UI's: fees plus every live farm at full loyalty). */
export function poolAprRows(y: PoolYield | null): YieldRow[] {
  return y ? y.components.map(yieldComponentRow) : []
}

export interface PositionApr { total: number | null; rows: YieldRow[]; note?: string }

/**
 * What THIS position earns: the pool's fee-side components (fees, supply APY and
 * incentives of money-market legs) plus, for a farmed position, each live yield
 * farm it is in at the entry's own loyalty (farm APR × loyalty%). A term that
 * cannot be stated makes the total unknown, never smaller: a farmed row with no
 * entries to read (rewards snapshot stale), an entry whose farm the yields do not
 * list, an entry without its loyalty, or deposits in one farm at different
 * loyalty (the split of the principal between them is not on the row). `y` is
 * the pool's OWN yield: for a wrapped share (HUSDT over 2-Pool-HUSDT) the fee and
 * legs the unwrapped shares earn, not the wrapper's headline.
 */
export function positionApr(p: LpPosition, y: PoolYield | null, entries: FarmItem[]): PositionApr {
  if (!y) return { total: null, rows: [] }
  const rows = y.components.map(yieldComponentRow).filter(r => r.group !== 'Farm rewards')
  const terms: (number | null)[] = y.components.filter(c => c.kind !== 'farm').map(c => c.aprPct)
  let note: string | undefined = p.wrapper ? unwrappedNote(p.wrapper) : undefined
  if (isFarmVenue(p.venue)) {
    const live = entries.filter(e => e.farmState == null || e.farmState === 'active')
    if (!entries.length) {
      terms.push(null)
      note = 'Farm entries unavailable (rewards snapshot missing or stale).'
    }
    const byFarm = new Map<number, FarmItem[]>()
    for (const e of live) {
      if (e.yieldFarmId == null) { terms.push(null); continue }
      byFarm.set(e.yieldFarmId, [...(byFarm.get(e.yieldFarmId) ?? []), e])
    }
    for (const [yieldFarmId, list] of byFarm) {
      const farm = y.farms.find(f => f.yieldFarmId === yieldFarmId)
      const loyalties = list.map(e => e.loyaltyPct)
      const known = loyalties.every((l): l is number => l != null && Number.isFinite(l))
      const lo = known ? Math.min(...loyalties) : NaN
      const hi = known ? Math.max(...loyalties) : NaN
      const uniform = known && hi - lo < 0.01
      const pct = farm && farm.aprPct != null && uniform ? farm.aprPct * lo / 100 : null
      terms.push(pct)
      rows.push({
        key: `farm-${yieldFarmId}`,
        label: farm?.rewardAsset.symbol ?? list[0].asset?.symbol ?? `Farm ${yieldFarmId}`,
        asset: farm?.rewardAsset ?? list[0].asset,
        pct,
        group: 'Farm rewards',
        note: !farm ? 'farm not listed' : !known ? 'loyalty unknown' : uniform ? `${fmtPct(lo)} loyalty` : `loyalty ${fmtPct(lo)}–${fmtPct(hi)}`,
      })
    }
  }
  return { total: sumPct(terms), rows, note }
}

const fmtPct = (v: number) => `${Math.round(v * 10) / 10}%`

export interface WeightedApr { pct: number | null; coveredUsd: number; totalUsd: number }

/** Value-weighted rate over the positions whose rate AND value are known; the
 *  rest are left out and the covered value is stated beside the figure. */
export function valueWeightedApr(rows: { valueUsd: number | null; apr: number | null }[]): WeightedApr {
  let weighted = 0, coveredUsd = 0, totalUsd = 0
  for (const r of rows) {
    if (r.valueUsd == null || !Number.isFinite(r.valueUsd)) continue
    totalUsd += r.valueUsd
    if (r.apr == null || !Number.isFinite(r.apr) || r.valueUsd <= 0) continue
    weighted += r.valueUsd * r.apr
    coveredUsd += r.valueUsd
  }
  return { pct: coveredUsd > 0 ? weighted / coveredUsd : null, coveredUsd, totalUsd }
}

// Unclaimed rewards as the account page counts them: priced and payable in the
// sum, the rest named aloud.
export interface RewardTally { usd: number; unpriced: number; unpayable: number; held: LpUnclaimedReward[] }
export function tallyRewards(rewards: LpUnclaimedReward[] | undefined): RewardTally {
  const held = (rewards ?? []).filter(r => r.amount !== '0')
  let usd = 0, unpriced = 0, unpayable = 0
  for (const r of held) {
    if (r.payable === false) unpayable++
    else if (r.valueUsd == null) unpriced++
    else usd += r.valueUsd
  }
  return { usd, unpriced, unpayable, held }
}

export interface Leg { asset: AssetRef; raw: bigint }
export interface PositionView { p: LpPosition; entries: FarmItem[]; apr: PositionApr; rewards: RewardTally }
export interface PoolGroup {
  id: string
  identity: PoolIdentity | null
  label: string
  icon: AssetRef
  venues: string[]
  positions: PositionView[]
  legs: Leg[]
  valueUsd: number
  unpricedPositions: number
  /** The pool's headline rate: its own yield, or for a wrapped share what the wrapper earns. */
  yield: PoolYield | null
  /** Set when the pool's share is a money-market reserve (a "Hydrated" pool), the source of the headline. */
  wrapper?: LpShareWrapper
  rewards: RewardTally
  to: string
}

export function pairIcon(a: AssetRef, b?: AssetRef): AssetRef {
  if (!b) return a
  return { ...a, symbol: `${a.symbol} / ${b.symbol}`, iconAssetIds: [a.iconAssetId ?? a.assetId, b.iconAssetId ?? b.assetId] }
}

export function poolLink(p: LpPosition, id: PoolIdentity | null): string {
  if (id?.family === 'uniswapV3') return paths.v3Pool(id.key)
  if (id?.family === 'xyk' || id?.family === 'stableswap') return paths.pool(Number(id.key))
  return `${paths.asset(p.asset.assetId)}?tab=liquidity`
}

function addLeg(legs: Leg[], asset: AssetRef, raw: string | undefined) {
  if (!raw) return
  let v: bigint
  try { v = BigInt(raw) } catch { return }
  const hit = legs.find(l => l.asset.assetId === asset.assetId)
  if (hit) hit.raw += v
  else legs.push({ asset, raw: v })
}

/** Positions grouped by pool, each pool with its summed legs (H2O included),
 *  priced value, rate and unclaimed rewards; pools by value, positions by value.
 *  A pool whose share is a money-market reserve goes by its wrapper (HUSDT for
 *  2-Pool-HUSDT, where the wrapper names it) and is rated as the wrapper earns —
 *  the Hydration app's pool row — while each position keeps its own rate. */
export function groupPools(positions: LpPosition[], yields: ExplorerYields | null | undefined, farmRewards: FarmRewardsSummary | null | undefined): PoolGroup[] {
  const groups = new Map<string, PoolGroup>()
  for (const p of positions) {
    const identity = poolIdentity(p)
    const id = identity ? `${identity.family}:${identity.key}` : `other:${p.venue}:${p.positionId}`
    const y = poolYieldOf(yields, identity)
    const entries = farmEntriesOf(p, farmRewards?.items)
    const view: PositionView = { p, entries, apr: positionApr(p, y, entries), rewards: tallyRewards(p.unclaimedRewards) }
    let g = groups.get(id)
    if (!g) {
      const face = p.wrapper?.named ? p.wrapper.asset : p.asset
      g = {
        id, identity, label: p.assetB ? `${face.symbol} / ${p.assetB.symbol}` : face.symbol,
        icon: pairIcon(face, p.assetB), venues: [], positions: [], legs: [], valueUsd: 0, unpricedPositions: 0,
        yield: p.wrapper ? wrapperYieldOf(yields, p.wrapper) : y, ...(p.wrapper ? { wrapper: p.wrapper } : {}),
        rewards: { usd: 0, unpriced: 0, unpayable: 0, held: [] }, to: poolLink(p, identity),
      }
      groups.set(id, g)
    }
    g.positions.push(view)
    if (!g.venues.includes(p.venue)) g.venues.push(p.venue)
    addLeg(g.legs, p.asset, p.amount)
    if (p.hubAmount) addLeg(g.legs, H2O, p.hubAmount)
    if (p.assetB) addLeg(g.legs, p.assetB, p.amountB)
    if (p.valueUsd == null) g.unpricedPositions++
    else g.valueUsd += p.valueUsd
    g.rewards = {
      usd: g.rewards.usd + view.rewards.usd, unpriced: g.rewards.unpriced + view.rewards.unpriced,
      unpayable: g.rewards.unpayable + view.rewards.unpayable, held: [...g.rewards.held, ...view.rewards.held],
    }
  }
  const out = [...groups.values()]
  for (const g of out) {
    g.positions.sort((a, b) => (b.p.valueUsd ?? -1) - (a.p.valueUsd ?? -1))
    // H2O trails the pool's own asset(s).
    g.legs.sort((a, b) => Number(a.asset.assetId === H2O.assetId) - Number(b.asset.assetId === H2O.assetId))
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd || a.label.localeCompare(b.label))
}

export interface LiquidityKpis {
  valueUsd: number
  unpricedPositions: number
  inFarmsUsd: number
  /** Farmed positions with no price, left out of inFarmsUsd. */
  inFarmsUnpriced: number
  unclaimed: { usd: number; unpriced: number; unpayable: number }
  claimedUsd: number | null
  claimedUnpriced: number
  apr: WeightedApr
}

export function liquidityKpis(groups: PoolGroup[], farmRewards: FarmRewardsSummary | null | undefined, claimed: LiquidityRewardsClaimed | null | undefined): LiquidityKpis {
  const views = groups.flatMap(g => g.positions)
  const farmed = views.filter(v => isFarmVenue(v.p.venue))
  const items = farmRewards?.items ?? []
  let usd = 0, unpriced = 0, unpayable = 0
  for (const i of items) {
    if (i.claimable === '0') continue
    if (i.payable === false) unpayable++
    else if (i.claimableUsd == null) unpriced++
    else usd += i.claimableUsd
  }
  return {
    valueUsd: groups.reduce((s, g) => s + g.valueUsd, 0),
    unpricedPositions: groups.reduce((s, g) => s + g.unpricedPositions, 0),
    inFarmsUsd: farmed.reduce((s, v) => s + (v.p.valueUsd ?? 0), 0),
    inFarmsUnpriced: farmed.filter(v => v.p.valueUsd == null).length,
    unclaimed: { usd, unpriced, unpayable },
    claimedUsd: claimed ? claimed.totalClaimedUsd : null,
    claimedUnpriced: claimed?.unpricedClaims ?? 0,
    apr: valueWeightedApr(views.map(v => ({ valueUsd: v.p.valueUsd, apr: v.apr.total }))),
  }
}

// ── Rewards earned ───────────────────────────────────────────────────────
export interface EarnedRow {
  key: string
  pallet: 'omnipool' | 'xyk'
  pool: AssetRef
  reward: AssetRef
  claimedRaw: bigint
  claimedUsd: number | null
  claimedUnpriced: number
  unclaimedRaw: bigint
  unclaimedUsd: number
  unclaimedUnpriced: number
  unclaimedUnpayable: number
}

/**
 * One row per (pool × reward asset): claimed over the whole history (valued at
 * each claim's event-time price) beside what is claimable now (current price,
 * payable only). An unclaimed entry's pool is its position's pool — the Omnipool
 * asset of the NFT, or the XYK LP token of `xyk:<lp>:farm`. An entry whose
 * position has no LP row (a delisted asset) still counts, so the table agrees
 * with the Unclaimed KPI: an XYK one under the LP its id names, an Omnipool one
 * (whose NFT alone does not say the pool) under "Unknown pool".
 */
export function rewardsEarned(claimed: LiquidityRewardsClaimed | null | undefined, farmRewards: FarmRewardsSummary | null | undefined, positions: LpPosition[]): EarnedRow[] {
  const rows = new Map<string, EarnedRow>()
  const row = (pallet: 'omnipool' | 'xyk', pool: AssetRef, reward: AssetRef): EarnedRow => {
    const key = `${pallet}:${pool.assetId}:${reward.assetId}`
    let r = rows.get(key)
    if (!r) {
      r = { key, pallet, pool, reward, claimedRaw: 0n, claimedUsd: null, claimedUnpriced: 0, unclaimedRaw: 0n, unclaimedUsd: 0, unclaimedUnpriced: 0, unclaimedUnpayable: 0 }
      rows.set(key, r)
    }
    return r
  }
  const unknownPool = (assetId = -1): AssetRef => ({ assetId, symbol: 'Unknown pool', name: null, decimals: 0, parachainId: null })
  // XYK pools read as their pair where a current position names it.
  const xykPair = new Map<number, AssetRef>()
  for (const p of positions) {
    const id = poolIdentity(p)
    if (id?.family === 'xyk') xykPair.set(Number(id.key), { ...pairIcon(p.asset, p.assetB), assetId: Number(id.key) })
  }
  for (const c of claimed?.rows ?? []) {
    // A farm whose creation is not indexed has no pool (null): its claims still
    // count, under the reward asset alone.
    const base = c.poolAsset ?? unknownPool()
    const pool = c.pallet === 'xyk'
      ? xykPair.get(base.assetId) ?? (c.poolPair ? { ...pairIcon(c.poolPair[0], c.poolPair[1]), assetId: base.assetId } : base)
      : base
    // A claimed pair also names a pool no current position still holds.
    if (c.pallet === 'xyk' && c.poolAsset && !xykPair.has(base.assetId)) xykPair.set(base.assetId, pool)
    const r = row(c.pallet, pool, c.rewardAsset)
    r.claimedRaw += BigInt(c.amount || '0')
    if (c.valueUsd != null) r.claimedUsd = (r.claimedUsd ?? 0) + c.valueUsd
    r.claimedUnpriced += c.unpricedClaims
  }
  const byPosition = new Map(positions.filter(p => isFarmVenue(p.venue)).map(p => [`${p.venue}|${p.positionId}`, p]))
  for (const i of (farmRewards?.items ?? []) as (FarmItem & Partial<FarmRewardEntry>)[]) {
    if (!i.asset || i.claimable === '0') continue
    const venue = i.venue ?? (i.positionId?.startsWith('xyk:') ? 'XYK Farm' : 'Omnipool Farm')
    const p = i.positionId ? byPosition.get(`${venue}|${i.positionId}`) : undefined
    const id = p ? poolIdentity(p) : null
    let pallet: 'omnipool' | 'xyk', pool: AssetRef
    if (p && id) {
      pallet = id.family === 'xyk' ? 'xyk' : 'omnipool'
      pool = pallet === 'xyk' ? xykPair.get(Number(id.key)) ?? p.asset : p.asset
    } else if (venue === 'XYK Farm') {
      pallet = 'xyk'
      const lp = Number(/^xyk:(\d+):/.exec(i.positionId ?? '')?.[1] ?? NaN)
      pool = Number.isFinite(lp) ? xykPair.get(lp) ?? unknownPool(lp) : unknownPool()
    } else {
      pallet = 'omnipool'
      pool = unknownPool()
    }
    const r = row(pallet, pool, i.asset)
    r.unclaimedRaw += BigInt(i.claimable || '0')
    if (i.payable === false) r.unclaimedUnpayable++
    else if (i.claimableUsd == null) r.unclaimedUnpriced++
    else r.unclaimedUsd += i.claimableUsd
  }
  return [...rows.values()].sort((a, b) => ((b.claimedUsd ?? 0) + b.unclaimedUsd) - ((a.claimedUsd ?? 0) + a.unclaimedUsd) || a.key.localeCompare(b.key))
}

// The Omnipool hub asset (registry id 1).
const H2O_ASSET_ID = 1

// ── Position history ─────────────────────────────────────────────────────
const HISTORY_VENUE: Record<LiquidityHistoryPosition['venue'], string> = {
  omnipool: 'Omnipool', stableswap: 'Stablepool', xyk: 'XYK', uniswapv3: 'Uniswap v3', gamma: 'Gamma vault',
}
export function historyVenueLabel(h: LiquidityHistoryPosition): string {
  const base = HISTORY_VENUE[h.venue] ?? h.venue
  return h.farmed && (h.venue === 'omnipool' || h.venue === 'xyk') ? `${base} Farm` : base
}

export interface HistoryRowView {
  key: string
  venue: string
  pool: AssetRef | null
  poolLabel: string
  positionId: string | null
  openedBlock: number | null
  openedAt: string | null
  closedBlock: number | null
  closedAt: string | null
  active: boolean
  lastValueUsd: number | null
}

export function historyRows(positions: LiquidityHistoryPosition[]): HistoryRowView[] {
  return positions.map((h, idx) => {
    const spans = [...h.spans].sort((a, b) => a.fromBlock - b.fromBlock)
    const first = spans[0], last = spans[spans.length - 1]
    const lastPoint = h.points.reduce<LiquidityHistoryPosition['points'][number] | null>((m, pt) => (!m || pt.i > m.i ? pt : m), null)
    // An Omnipool position redeems into its asset plus H2O, but its pool is the
    // asset alone — the H2O leg would make every Omnipool row read "X / H2O".
    const legs = (lastPoint?.legs.map(l => l.asset) ?? []).filter(a => h.venue !== 'omnipool' || a.assetId !== H2O_ASSET_ID)
    const pool = h.venue !== 'stableswap' && legs.length > 1 ? pairIcon(legs[0], legs[1]) : h.shareAsset ?? (legs.length ? pairIcon(legs[0], legs[1]) : null)
    return {
      key: `${h.venue}:${h.poolKey}:${h.positionId ?? ''}:${h.farmed ? 'f' : 'd'}:${idx}`,
      venue: historyVenueLabel(h),
      pool,
      // A pair reads as its legs (as in the pools table), a stablepool as its share.
      poolLabel: h.venue !== 'stableswap' && legs.length > 1 ? legs.map(a => a.symbol).join(' / ') : h.shareAsset?.symbol ?? (legs.length ? legs.map(a => a.symbol).join(' / ') : h.poolKey),
      positionId: h.positionId,
      openedBlock: first?.fromBlock ?? null,
      openedAt: first?.fromTime ?? null,
      closedBlock: last?.toBlock ?? null,
      closedAt: last?.toTime ?? null,
      active: !!last && last.toBlock == null,
      lastValueUsd: lastPoint?.valueUsd ?? null,
    }
  }).sort((a, b) => (b.openedBlock ?? 0) - (a.openedBlock ?? 0) || a.key.localeCompare(b.key))
}
