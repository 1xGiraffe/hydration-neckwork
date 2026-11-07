import type { ClickHouseClient } from '../db/client.ts'
import { calculate_out_given_in, calculate_spot_price_with_fee } from '@galacticcouncil/math-stableswap'
import { cached } from './cache.ts'
import { assetIdFromMmAddress, displayDescriptor, type ExplorerAsset } from './explorerAssets.ts'
import {
  accountRef, bilPartyAccounts, bilRowsValued, ensurePrices, moneyMarketIdentities, resolveRelatedAccounts,
  type AccountRef, type ActivityRow, type PriceInfo,
} from './explorerService.ts'
import { moneyMarketCapStates } from './moneyMarketCaps.ts'
import { parseStableswapPools, pegPrice, type StableswapPoolSnapshot } from './stableswapSnapshot.ts'
import { h160Account, rawUsd, strategyDashboardCache } from './strategyDashboard.ts'
import { stableswapPoolAccount } from './tagService.ts'
import {
  BIL_ASSET_ID, BIL_ATOKEN, BIL_HOLLAR_ASSET_ID, BIL_HOLLAR_CONTRACT, BIL_MM_POOL, BIL_ORACLE, BIL_POOL_ID, BIL_VAULT, BIL_ZAP,
  DECENTRAL_POOL, DECENTRAL_POOL_TOKEN, UBIL_ASSET_ID,
  bilAccruingShares, bilExpectedWindow, bilHoldingHollar, bilHoldings, bilPositionPayout, bilProcessingDelays, bilProcessingStats,
  bilQueueCoverage, bilRateObservations, bilRealizedApyPct, bilRequestStatus,
  type BilAction, type BilHolding, type BilPosition, type BilProcessing, type BilRequestStatus,
} from './bil.ts'
import { currentBilSnapshot, type BilSnapshot } from './bilState.ts'

// The Brazilian Invoice Loans page (/explorer/bil) and an account's BIL position
// (/explorer/address/:a/bil). Three sources, each for what it can state:
//  - the CURRENT state — NAV and the totals behind it, the cap, every holder's BIL,
//    uBIL and queued uBIL and settled HOLLAR, the maturity ladder, the redemption queue
//    and what BIL can borrow against in its market — from the bil-state refresher's
//    pinned snapshot (bilState.ts) and the indexed money-market caps, valued at current
//    prices; absent (null) when the snapshot is stale, never a zero;
//  - the HISTORY — deposits, requests, settlements, claims and the Decentral cash flows
//    per day, the NAV each deposit and settlement executed at, the processing delay each
//    repaid position took, the depositors — from the indexed BIL rows (the activity
//    feed's own builder, explorerService.bilRowsValued), valued at event time;
//  - the BIL/HOLLAR pool (10055): its current state from the newest block snapshot and
//    its daily history from the 600-block state grid, priced by the runtime's own
//    stableswap math.
// Built off the request path and served stale-while-revalidate (strategyDashboardCache).

let client: ClickHouseClient
const dashboard = strategyDashboardCache({
  name: 'bil', key: 'explorer:bil-dashboard', snapshot: () => currentBilSnapshot(), build: snap => buildBilDashboard(snap),
})
export function initBilService(c: ClickHouseClient): void { client = c; dashboard.init() }
export const prewarmBilDashboard = (): Promise<void> => dashboard.prewarm()
export const getBilDashboard = (): Promise<BilDashboard> => dashboard.get()

const WAD = 10n ** 18n
const DAY = 86_400
/** The redemption the queue section quotes a wait for: 1,000 HOLLAR. */
const QUOTE_HOLLAR = 1_000n * WAD
/** The pool sale the instant-exit quote prices: 1,000 BIL. */
const QUOTE_BIL = 1_000n * WAD

/** When a queued redemption is paid: the maturity that covers it and the window its HOLLAR arrives in (maturity + measured processing); `matured` once that maturity has passed. */
export interface BilWait { maturesAt: string; from: string; to: string; matured: boolean }
export interface BilRequestView {
  requestId: number
  owner: AccountRef
  controller: AccountRef
  /** uBIL requested. */
  shares: string
  status: BilRequestStatus
  requestedAt: string
  /** uBIL settled and the HOLLAR fixed for it (every settlement, claimed or not). */
  settledShares: string
  hollarOwed: string
  cancelledShares: string
  /** Still waiting in the queue (accruing at NAV). */
  pendingShares: string
  /** Settled and not yet claimed: a fixed HOLLAR amount (chain state, open requests only). */
  claimableHollar: string | null
  /** What it is worth now: the claimable HOLLAR plus the pending uBIL at NAV. */
  worthHollar: string | null
  worthUsd: number | null
  /** When the queue reaches the pending part; null when none pends, the ladder is unknown, or idle HOLLAR covers it (`paidFromIdle`). */
  wait: BilWait | null
  paidFromIdle: boolean
  lastSettledAt: string | null
}
export interface BilPositionView {
  account: AccountRef
  /** BIL (the money market's aToken) held, uBIL held directly, and uBIL still queued — all accruing at NAV. */
  bil: string
  ubil: string
  queuedShares: string
  /** Settled redemptions awaiting a claim: fixed HOLLAR, not at NAV. */
  claimableHollar: string
  /** Everything the position is worth: the accruing uBIL at NAV plus the claimable HOLLAR. */
  totalHollar: string | null
  totalUsd: number | null
  /** Share of the uBIL accruing (custody excluded); null when nothing accrues. */
  share: number | null
}
export interface BilLadderBucket { day: string; positions: number; principal: string; payout: string; cumulative: string }
export interface BilDayView {
  day: string
  deposits: number
  depositsUsd: number
  depositsHollar: string
  redeems: number
  settledHollar: string
  claimedHollar: string
  interestHollar: string
  principalHollar: string
  drawsHollar: string
  repaysHollar: string
}
export interface BilRatePoint { day: string; rate: number; source: 'deposit' | 'settlement' | 'live' }
/** The pool's day: its mid price and peg, and NAV (interpolated between the exact observations) with the mid's premium or discount to each. */
export interface BilPoolDay { day: string; mid: number | null; peg: number | null; premiumVsPegPct: number | null; nav: number | null; premiumVsNavPct: number | null }
export interface BilDashboard {
  generatedAt: string
  /** The block the current state was read at; null when no fresh snapshot exists. */
  asOfBlock: number | null
  launchBlock: number | null
  vault: AccountRef
  bilAsset: ExplorerAsset
  ubilAsset: ExplorerAsset
  hollarAsset: ExplorerAsset
  status: 'open' | 'full' | 'paused' | 'unavailable'
  exchangeRate: string | null
  navUsd: number | null
  tvl: string | null
  tvlUsd: number | null
  cap: string | null
  /** Room a deposit still has (the lower of the vault cap's and the BIL reserve's supply cap's), HOLLAR; which binds. */
  remaining: string | null
  remainingBinding: 'vault' | 'pool' | null
  sharesOutstanding: string | null
  bilSupply: string | null
  idleHollar: string | null
  investedPrincipal: string | null
  pendingInterest: string | null
  reservedHollar: string | null
  minRedeem: string | null
  /** The vault's stated APY (getAPYWad) and the Decentral pool's terms for new positions. */
  apyPct: number | null
  termDays: number | null
  withdrawalDelaySec: number | null
  /** Annualised simple growth of the exact rate observations to the live rate, each with its real span in days. */
  realized: { sinceLaunchPct: number | null; launchDays: number | null; d30Pct: number | null; d30Days: number | null; d7Pct: number | null; d7Days: number | null }
  rateHistory: BilRatePoint[]
  ladder: { positions: number; principal: string; payout: string; next: { at: string; payout: string } | null; buckets: BilLadderBucket[] } | null
  queue: {
    requests: BilRequestView[]
    pendingShares: string
    claimableHollar: string | null
    /** A new request of QUOTE_HOLLAR today: when the queue reaches it; `quoteCovered` false when the ladder cannot. */
    quoteHollar: string
    quoteWait: BilWait | null
    quoteFromIdle: boolean
    quoteCovered: boolean
    /** A fresh deposit's whole lockup: its own term plus the processing (the measured 90th percentile, else the pool's delay). */
    maxWaitSec: number | null
    /** Measured: how long after maturity repaid positions' principal came back (hours). */
    processing: { samples: number; medianHours: number; p90Hours: number; maxHours: number } | null
  } | null
  /** Borrowing HOLLAR against BIL in the isolated BIL market (looping), as the official app states it. */
  borrowing: {
    /** HOLLAR borrowed in the BIL market (its debt), the borrow cap and the borrowed share of it; `bucketUsed` the facilitator bucket's level. */
    borrowedHollar: string | null
    bucketUsed: string | null
    bucketCap: string | null
    utilization: number | null
    maxLtvPct: number | null
    liquidationThresholdPct: number | null
    borrowApyPct: number | null
    /** At max LTV: leverage 1 / (1 − LTV) and the official Max Net APY, leverage × vault APY − (leverage − 1) × borrow APY. */
    maxLeverage: number | null
    maxNetApyPct: number | null
  } | null
  /**
   * Where the HOLLAR paid back to the vault came from, since the vault's first investment:
   * what the borrower drew from the Decentral pool and repaid into it, what the pool paid
   * the vault (principal and interest of matured positions) and what the vault invested in
   * it (every position's principal: new deposits and reinvestments). Indexed facts only.
   */
  rollover: { drawnHollar: string; repaidHollar: string; paidToVaultHollar: string; investedByVaultHollar: string | null }
  holders: number | null
  depositors: number
  positions: BilPositionView[]
  /** False when the open redemption requests could not be stated: queued and claimable parts are missing from `positions`. */
  positionsComplete: boolean
  pool: {
    poolId: number
    account: AccountRef
    bilReserve: string
    hollarReserve: string
    feePct: number
    amplification: number
    /** HOLLAR per BIL: the pool's marginal price before its fee, and its peg (the oracle's relay of the vault rate). */
    mid: number | null
    peg: number | null
    premiumVsNavPct: number | null
    /** Selling QUOTE_BIL BIL into the pool now: HOLLAR received and its difference to NAV. */
    sellQuote: { bil: string; hollar: string; price: number; vsNavPct: number | null } | null
    history: BilPoolDay[]
  } | null
  totals: {
    deposits: number; depositsUsd: number; depositsHollar: string
    redeems: number; cancels: number; settlements: number; settledHollar: string
    claims: number; claimedHollar: string
    reinvests: number; reinvestedHollar: string; interestHollar: string; principalHollar: string
    drawsHollar: string; repaysHollar: string
    unpricedRows: number
  }
  perDay: BilDayView[]
  contracts: Array<{ role: string; account: AccountRef }>
}

const asset = (id: number): ExplorerAsset => displayDescriptor(id)
const wadNum = (v: bigint | string): number => Number(BigInt(v) * 1_000_000_000n / WAD) / 1e9
const isoSec = (s: number) => new Date(s * 1000).toISOString()
const dayOf = (iso: string) => iso.slice(0, 10)

function waitOf(maturityTime: number | null, processing: BilProcessing | null, poolDelaySec: number, nowSec: number): BilWait | null {
  if (maturityTime == null) return null
  const w = bilExpectedWindow(maturityTime, processing, poolDelaySec, nowSec)
  return { maturesAt: isoSec(w.maturesAt), from: isoSec(w.from), to: isoSec(w.to), matured: w.matured }
}

function ladderOf(positions: readonly BilPosition[], apyWad: bigint, idle: bigint, nowSec: number): NonNullable<BilDashboard['ladder']> {
  const open = positions.filter(p => p.state !== 'redeemed')
  const byDay = new Map<string, { positions: number; principal: bigint; payout: bigint }>()
  let principal = 0n, payout = 0n
  for (const p of open) {
    const pay = bilPositionPayout(p, apyWad)
    principal += BigInt(p.principal); payout += pay
    const day = isoSec(p.maturityTime).slice(0, 10)
    const b = byDay.get(day) ?? byDay.set(day, { positions: 0, principal: 0n, payout: 0n }).get(day)!
    b.positions++; b.principal += BigInt(p.principal); b.payout += pay
  }
  let cum = idle
  const buckets = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => {
    cum += b.payout
    return { day, positions: b.positions, principal: b.principal.toString(), payout: b.payout.toString(), cumulative: cum.toString() }
  })
  const upcoming = open.filter(p => p.maturityTime >= nowSec).sort((a, b) => a.maturityTime - b.maturityTime)[0]
  const nextDay = upcoming ? isoSec(upcoming.maturityTime).slice(0, 10) : null
  return {
    positions: open.length, principal: principal.toString(), payout: payout.toString(),
    next: upcoming && nextDay ? { at: isoSec(upcoming.maturityTime), payout: byDay.get(nextDay)!.payout.toString() } : null,
    buckets,
  }
}

/** The newest stableswap state of pool 10055 (the block snapshot every pool page reads). */
async function currentPoolState(): Promise<StableswapPoolSnapshot | null> {
  return cached('explorer:bil-pool-state', 15_000, async () => {
    const res = await client.query({
      query: `SELECT JSONExtractRaw(payload_json, 'stableswap') AS ss
              FROM price_data.raw_block_snapshots
              WHERE block_height = (SELECT max(block_height) FROM price_data.raw_block_snapshots)
              ORDER BY ingested_at DESC LIMIT 1`,
      format: 'JSONEachRow',
    })
    const [row] = await res.json<{ ss: string }>()
    if (!row) return null
    try { return parseStableswapPools(JSON.parse(row.ss)).find(p => p.poolId === BIL_POOL_ID) ?? null } catch { return null }
  })
}

const ssReserves = (p: StableswapPoolSnapshot) => JSON.stringify(p.assetIds.map((id, i) => ({ asset_id: id, amount: p.reserves[i]!.toString(), decimals: asset(id).decimals ?? 18 })))
const ssPegs = (p: StableswapPoolSnapshot) => JSON.stringify((p.pegs ?? p.assetIds.map(() => ({ num: 1n, den: 1n }))).map(q => [q.num.toString(), q.den.toString()]))
/** HOLLAR per BIL before the fee — the runtime-compatible stableswap spot. */
function poolMid(p: StableswapPoolSnapshot): number | null {
  try {
    const raw = BigInt(calculate_spot_price_with_fee(String(p.poolId), ssReserves(p), String(p.amplification), String(BIL_ASSET_ID), String(BIL_HOLLAR_ASSET_ID), p.totalIssuance.toString(), '0', ssPegs(p)))
    return raw > 0n ? wadNum(raw) : null
  } catch { return null }
}
/** The BIL leg's peg relative to HOLLAR's (HOLLAR per BIL the pool is pegged at). */
function poolPeg(p: StableswapPoolSnapshot): number | null {
  if (!p.pegs) return null
  const i = p.assetIds.indexOf(BIL_ASSET_ID), j = p.assetIds.indexOf(BIL_HOLLAR_ASSET_ID)
  if (i < 0 || j < 0) return null
  const a = pegPrice(p.pegs[i].num, p.pegs[i].den), b = pegPrice(p.pegs[j].num, p.pegs[j].den)
  return b > 0 ? a / b : null
}

/** The pool's daily state: the last 600-block sample of each day, priced by the same math. */
async function poolHistory(): Promise<Array<{ day: string; mid: number | null; peg: number | null }>> {
  return cached('explorer:bil-pool-history', 30 * 60_000, async () => {
    const res = await client.query({
      query: `SELECT toString(toDate(block_timestamp)) AS day, argMax(asset_ids, block_height) AS a, argMax(reserves_raw, block_height) AS r,
                     argMax(amplification, block_height) AS amp, argMax(fee_permill, block_height) AS fee, argMax(total_issuance_raw, block_height) AS ti,
                     argMax(peg_num, block_height) AS pn, argMax(peg_den, block_height) AS pd
              FROM price_data.stableswap_pool_state_history
              WHERE pool_id = {pool:UInt32}
              GROUP BY day ORDER BY day`,
      query_params: { pool: BIL_POOL_ID }, format: 'JSONEachRow',
    })
    const rows = await res.json<{ day: string; a: number[]; r: string[]; amp: number; fee: number; ti: string; pn: string[]; pd: string[] }>()
    return rows.map(x => {
      const p: StableswapPoolSnapshot = {
        poolId: BIL_POOL_ID, assetIds: x.a.map(Number), reserves: x.r.map(v => BigInt(v)), amplification: Number(x.amp),
        initialAmplification: Number(x.amp), finalAmplification: Number(x.amp), initialBlock: 0, finalBlock: 0,
        feePermill: Number(x.fee), totalIssuance: BigInt(x.ti || '0'),
        pegs: x.pn.length === x.a.length && x.pd.length === x.a.length ? x.pn.map((n, i) => ({ num: BigInt(n), den: BigInt(x.pd[i]) })) : null,
      }
      return { day: x.day, mid: poolMid(p), peg: poolPeg(p) }
    })
  })
}

const DAY_ACTIONS: ReadonlySet<BilAction> = new Set(['Deposit', 'Redeem', 'Settle', 'Claim', 'Interest', 'Principal', 'Draw', 'Repay'])
export function bilDays(rows: ActivityRow[], fromDay: string | null, toDay: string): BilDayView[] {
  const byDay = new Map<string, BilDayView>()
  const blank = (day: string): BilDayView => ({ day, deposits: 0, depositsUsd: 0, depositsHollar: '0', redeems: 0, settledHollar: '0', claimedHollar: '0', interestHollar: '0', principalHollar: '0', drawsHollar: '0', repaysHollar: '0' })
  const add = (a: string, b: string | null | undefined) => (BigInt(a) + BigInt(b ?? '0')).toString()
  for (const r of rows) {
    if (!r.bilAction || !DAY_ACTIONS.has(r.bilAction)) continue
    const day = dayOf(r.timestamp)
    const d = byDay.get(day) ?? byDay.set(day, blank(day)).get(day)!
    if (r.bilAction === 'Deposit') { d.deposits++; d.depositsUsd += r.valueUsd ?? 0; d.depositsHollar = add(d.depositsHollar, r.amount) }
    else if (r.bilAction === 'Redeem') d.redeems++
    else if (r.bilAction === 'Settle') d.settledHollar = add(d.settledHollar, r.amount)
    else if (r.bilAction === 'Claim') d.claimedHollar = add(d.claimedHollar, r.amount)
    else if (r.bilAction === 'Interest') d.interestHollar = add(d.interestHollar, r.amount)
    else if (r.bilAction === 'Principal') d.principalHollar = add(d.principalHollar, r.amount)
    else if (r.bilAction === 'Draw') d.drawsHollar = add(d.drawsHollar, r.amount)
    else if (r.bilAction === 'Repay') d.repaysHollar = add(d.repaysHollar, r.amount)
  }
  const first = fromDay ?? [...byDay.keys()].sort()[0]
  if (!first) return []
  const out: BilDayView[] = []
  for (let t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(toDay + 'T00:00:00Z'); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10)
    out.push(byDay.get(day) ?? blank(day))
  }
  return out
}

/** The exact rate observations of the Deposit and Settle rows. */
export function rateObservationsOf(rows: readonly ActivityRow[]) {
  return bilRateObservations(rows.filter(r => r.bilAction === 'Deposit' || r.bilAction === 'Settle').map(r => ({
    blockHeight: r.blockHeight, timestamp: r.timestamp, hollar: r.amount ?? null, shares: r.bilShares ?? null,
    source: r.bilAction === 'Deposit' ? 'deposit' as const : 'settlement' as const,
  })))
}

/** The exact rate observations, the day's last one per day, plus the live rate. */
export function bilRateHistory(snap: Pick<BilSnapshot, 'vault' | 'readAt'> | null, rows: readonly ActivityRow[]): BilRatePoint[] {
  const byDay = new Map<string, BilRatePoint>()
  for (const o of rateObservationsOf(rows)) byDay.set(dayOf(o.timestamp), { day: dayOf(o.timestamp), rate: wadNum(o.rateWad), source: o.source })
  if (snap) {
    const day = new Date(snap.readAt).toISOString().slice(0, 10)
    byDay.set(day, { day, rate: wadNum(snap.vault.exchangeRateWad), source: 'live' })
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/**
 * NAV on any day between the first and the last observation: the exact observations
 * interpolated linearly (the rate accrues continuously between them); null outside.
 */
export function navInterpolator(points: readonly BilRatePoint[]): (day: string) => number | null {
  const pts = points.map(p => ({ t: Date.parse(p.day + 'T00:00:00Z'), rate: p.rate }))
  return day => {
    const t = Date.parse(day + 'T00:00:00Z')
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].t === t) return pts[i].rate
      if (pts[i].t > t) {
        if (i === 0) return null
        const a = pts[i - 1], b = pts[i]
        return a.rate + (b.rate - a.rate) * (t - a.t) / (b.t - a.t)
      }
    }
    return null
  }
}

/** Realized APY: the live rate against the exact observation nearest at or before each look-back, with its real span. */
function realizedOf(snap: BilSnapshot | null, rows: readonly ActivityRow[]): BilDashboard['realized'] {
  const none = { sinceLaunchPct: null, launchDays: null, d30Pct: null, d30Days: null, d7Pct: null, d7Days: null }
  if (!snap) return none
  const obs = rateObservationsOf(rows)
  if (!obs.length) return none
  const nowSec = Math.floor(snap.readAt / 1000), live = BigInt(snap.vault.exchangeRateWad)
  const back = (sec: number) => [...obs].reverse().find(o => Date.parse(o.timestamp) / 1000 <= nowSec - sec) ?? null
  const span = (o: { timestamp: string } | null) => o ? nowSec - Math.floor(Date.parse(o.timestamp) / 1000) : null
  const at = (o: (typeof obs)[number] | null) => o ? bilRealizedApyPct(o.rateWad, live, span(o)!) : null
  const days = (o: { timestamp: string } | null) => { const s = span(o); return s == null ? null : Math.round(s / DAY * 10) / 10 }
  const first = obs[0], d30 = back(30 * DAY), d7 = back(7 * DAY)
  return { sinceLaunchPct: at(first), launchDays: days(first), d30Pct: at(d30), d30Days: days(d30), d7Pct: at(d7), d7Days: days(d7) }
}

interface Ctx { prices: Map<number, PriceInfo>; parties: ReadonlyMap<string, string>; nowSec: number }
async function ctxOf(): Promise<Ctx> {
  const [prices, parties] = await Promise.all([ensurePrices(), bilPartyAccounts()])
  return { prices, parties, nowSec: Math.floor(Date.now() / 1000) }
}
const ref = (ctx: Ctx, h: string): AccountRef => ctx.parties.get(h) ? accountRef(ctx.parties.get(h)!) : h160Account(h)
const processingOf = (snap: BilSnapshot): BilProcessing | null => snap.positions ? bilProcessingStats(bilProcessingDelays(snap.positions, snap.events)) : null

/** Every request with its state; the open ones also with what they are worth and when the queue reaches them. */
function requestViews(snap: BilSnapshot, ctx: Ctx): BilRequestView[] {
  const rate = BigInt(snap.vault.exchangeRateWad)
  const processing = processingOf(snap)
  const settledBy = new Map<string, bigint>()
  for (const r of snap.requests) settledBy.set(r.controller, (settledBy.get(r.controller) ?? 0n) + BigInt(r.settledShares))
  const chain = new Map((snap.chainRequests ?? []).map(c => [c.requestId, c]))
  // The FIFO wait of each pending part: everything queued ahead of it is paid first.
  const open = snap.positions?.filter(p => p.state !== 'redeemed') ?? null
  let ahead = 0n
  const waits = new Map<number, { wait: BilWait | null; fromIdle: boolean }>()
  for (const r of [...snap.requests].sort((a, b) => a.requestId - b.requestId)) {
    const pending = BigInt(r.pendingShares)
    if (pending <= 0n || !open) continue
    const need = pending * rate / WAD
    const c = bilQueueCoverage({ positions: open, apyWad: BigInt(snap.vault.fixedApyWad), idleHollar: BigInt(snap.vault.idleHollar), queuedAheadHollar: ahead, hollarNeeded: need })
    waits.set(r.requestId, { wait: waitOf(c.maturityTime, processing, snap.vault.withdrawalDelaySec, ctx.nowSec), fromIdle: c.coveredByIdle })
    ahead += need
  }
  return snap.requests.map(r => {
    const unclaimed = (settledBy.get(r.controller) ?? 0n) - (snap.claims.get(r.controller)?.shares ?? 0n)
    const status = bilRequestStatus(r, unclaimed)
    const c = chain.get(r.requestId)
    const claimable = c ? BigInt(c.hollarOwed) : status === 'claimed' || status === 'cancelled' ? 0n : null
    const worth = c ? BigInt(c.hollarOwed) + (BigInt(c.escrowShares) - BigInt(c.settledShares)) * rate / WAD : claimable
    const w = waits.get(r.requestId)
    return {
      requestId: r.requestId, owner: ref(ctx, r.owner), controller: ref(ctx, r.controller), shares: r.shares, status,
      requestedAt: r.requestedAt.timestamp, settledShares: r.settledShares, hollarOwed: r.hollarOwed, cancelledShares: r.cancelledShares,
      pendingShares: r.pendingShares, claimableHollar: claimable?.toString() ?? null,
      worthHollar: worth?.toString() ?? null, worthUsd: worth != null ? rawUsd(ctx.prices, BIL_HOLLAR_ASSET_ID, worth) : null,
      wait: w?.wait ?? null, paidFromIdle: w?.fromIdle ?? false, lastSettledAt: r.lastSettledAt,
    }
  }).sort((a, b) => b.requestId - a.requestId)
}

function positionView(h: BilHolding, account: AccountRef, rate: bigint, accruingTotal: bigint, ctx: Ctx): BilPositionView {
  const hollar = bilHoldingHollar(h, rate)
  const accruing = bilAccruingShares(h)
  return {
    account, bil: h.bil.toString(), ubil: h.ubil.toString(), queuedShares: h.queuedShares.toString(), claimableHollar: h.claimableHollar.toString(),
    totalHollar: hollar.toString(), totalUsd: rawUsd(ctx.prices, BIL_HOLLAR_ASSET_ID, hollar),
    share: accruing > 0n && accruingTotal > 0n ? Number(accruing * 1_000_000n / accruingTotal) / 1_000_000 : null,
  }
}

async function buildBilDashboard(snap: BilSnapshot | null): Promise<BilDashboard> {
  const [ctx, rowsValued, poolNow, poolDays, caps] = await Promise.all([
    ctxOf(), bilRowsValued(), currentPoolState(), poolHistory(),
    moneyMarketCapStates(client, assetIdFromMmAddress).catch(() => null),
  ])
  const rows = rowsValued.map(x => x.row)
  const v = snap?.vault ?? null
  const rate = v ? BigInt(v.exchangeRateWad) : null
  const nav = rate != null ? wadNum(rate) : null
  // Room a deposit has: the vault's cap less its assets, and the BIL reserve's supply cap less what is supplied, in HOLLAR at the rate.
  let remaining: bigint | null = null, binding: BilDashboard['remainingBinding'] = null
  if (v && rate != null) {
    const vaultRoom = BigInt(v.tvlCap) > BigInt(v.totalAssets) ? BigInt(v.tvlCap) - BigInt(v.totalAssets) : 0n
    const capUbil = BigInt(v.supplyCapUbil) * WAD
    const poolRoom = capUbil > 0n ? (capUbil > BigInt(v.suppliedUbil) ? (capUbil - BigInt(v.suppliedUbil)) * rate / WAD : 0n) : null
    if (poolRoom != null && poolRoom < vaultRoom) { remaining = poolRoom; binding = 'pool' } else { remaining = vaultRoom; binding = 'vault' }
  }
  // The app reads the room left under its minimum deposit as full; the vault's own minimum is 10 HOLLAR (minReinvest).
  const status: BilDashboard['status'] = !v ? 'unavailable' : v.paused || v.depositsPaused || v.decentralShutdown ? 'paused' : remaining != null && remaining < 10n * WAD ? 'full' : 'open'
  const poolAccount = stableswapPoolAccount(BIL_POOL_ID)
  const poolH160 = poolAccount.slice(0, 42).toLowerCase()
  // The pool's balance is filed under its account's first 20 bytes: it is the pool.
  const holderRef = (h: string): AccountRef => h === poolH160 ? accountRef(poolAccount) : ref(ctx, h)
  const holdings = snap ? bilHoldings({
    bil: snap.bil, wallet: snap.wallet,
    chain: snap.chainRequests?.map(r => ({ controller: r.controller, escrowShares: BigInt(r.escrowShares), settledShares: BigInt(r.settledShares), hollarOwed: BigInt(r.hollarOwed) })) ?? null,
  }) : { holdings: [], complete: true }
  const accruingTotal = holdings.holdings.reduce((s, h) => s + bilAccruingShares(h), 0n)
  const positions = rate == null ? [] : holdings.holdings
    .map(h => positionView(h, holderRef(h.h160), rate, accruingTotal, ctx))
    .sort((a, b) => (BigInt(b.totalHollar ?? '0') > BigInt(a.totalHollar ?? '0') ? 1 : BigInt(b.totalHollar ?? '0') < BigInt(a.totalHollar ?? '0') ? -1 : 0))
  const requests = snap ? requestViews(snap, ctx) : []
  const open = snap?.positions?.filter(p => p.state !== 'redeemed') ?? null
  const pending = snap ? snap.requests.reduce((s, r) => s + BigInt(r.pendingShares), 0n) : 0n
  const processing = snap ? processingOf(snap) : null
  const quote = snap && open && rate != null ? bilQueueCoverage({
    positions: open, apyWad: BigInt(snap.vault.fixedApyWad), idleHollar: BigInt(snap.vault.idleHollar),
    queuedAheadHollar: pending * rate / WAD, hollarNeeded: QUOTE_HOLLAR,
  }) : null

  // The pool now: its marginal price, peg and a 1,000 BIL sale, against the live NAV.
  let pool: BilDashboard['pool'] = null
  if (poolNow) {
    const bi = poolNow.assetIds.indexOf(BIL_ASSET_ID), hi = poolNow.assetIds.indexOf(BIL_HOLLAR_ASSET_ID)
    const mid = poolMid(poolNow), peg = poolPeg(poolNow)
    let sellQuote: NonNullable<BilDashboard['pool']>['sellQuote'] = null
    try {
      const out = BigInt(calculate_out_given_in(ssReserves(poolNow), BIL_ASSET_ID, BIL_HOLLAR_ASSET_ID, QUOTE_BIL.toString(), String(poolNow.amplification), String(poolNow.feePermill / 1e6), ssPegs(poolNow)))
      if (out > 0n) { const price = wadNum(out * WAD / QUOTE_BIL); sellQuote = { bil: QUOTE_BIL.toString(), hollar: out.toString(), price, vsNavPct: nav ? (price / nav - 1) * 100 : null } }
    } catch { /* no quote */ }
    const navOf = navInterpolator(bilRateHistory(snap, rows))
    pool = {
      poolId: BIL_POOL_ID, account: accountRef(poolAccount),
      bilReserve: bi >= 0 ? poolNow.reserves[bi].toString() : '0', hollarReserve: hi >= 0 ? poolNow.reserves[hi].toString() : '0',
      feePct: poolNow.feePermill / 1e4, amplification: poolNow.amplification,
      mid, peg, premiumVsNavPct: mid != null && nav ? (mid / nav - 1) * 100 : null, sellQuote,
      history: poolDays.map(d => {
        const n = navOf(d.day)
        return { day: d.day, mid: d.mid, peg: d.peg, premiumVsPegPct: d.mid != null && d.peg ? (d.mid / d.peg - 1) * 100 : null, nav: n, premiumVsNavPct: d.mid != null && n ? (d.mid / n - 1) * 100 : null }
      }),
    }
  }

  // Borrowing against BIL: the HOLLAR reserve of the BIL market (its facilitator bucket),
  // the uBIL reserve's LTV and threshold, and the official Max Net APY at max LTV.
  let borrowing: BilDashboard['borrowing'] = null
  if (v) {
    const hollar = caps?.find(c => c.poolAddress.toLowerCase() === BIL_MM_POOL && c.reserveAddress.toLowerCase() === BIL_HOLLAR_CONTRACT) ?? null
    const ltv = v.maxLtvBps / 1e4
    // The reserve's variable rate is an APR compounded per second; the app states the APY.
    const borrowApr = v.hollarBorrowRateRay != null ? Number(BigInt(v.hollarBorrowRateRay) * 1_000_000_000n / 10n ** 27n) / 1e9 : null
    const borrowApyPct = borrowApr != null ? (Math.exp(borrowApr) - 1) * 100 : null
    const vaultApyPct = wadNum(v.apyWad) * 100
    const leverage = ltv > 0 && ltv < 1 ? 1 / (1 - ltv) : null
    borrowing = {
      borrowedHollar: hollar?.debt.toString() ?? null,
      bucketUsed: hollar?.borrowUsed?.toString() ?? null,
      bucketCap: hollar?.borrowCap?.toString() ?? null,
      // As the app states it: HOLLAR borrowed in the market against its borrow cap.
      utilization: hollar && hollar.borrowCap != null && hollar.borrowCap > 0n ? Number(hollar.debt * 1_000_000n / hollar.borrowCap) / 1_000_000 : null,
      maxLtvPct: v.maxLtvBps / 100, liquidationThresholdPct: v.liquidationThresholdBps / 100, borrowApyPct,
      maxLeverage: leverage,
      maxNetApyPct: leverage != null && borrowApyPct != null ? leverage * vaultApyPct - (leverage - 1) * borrowApyPct : null,
    }
  }

  const sum = (action: BilAction) => rows.filter(r => r.bilAction === action).reduce((s, r) => s + BigInt(r.amount ?? '0'), 0n).toString()
  const count = (action: BilAction) => rows.filter(r => r.bilAction === action).length
  const deposits = rows.filter(r => r.bilAction === 'Deposit')
  const totals: BilDashboard['totals'] = {
    deposits: deposits.length, depositsUsd: deposits.reduce((s, r) => s + (r.valueUsd ?? 0), 0), depositsHollar: sum('Deposit'),
    redeems: count('Redeem'), cancels: count('Cancel'), settlements: count('Settle'), settledHollar: sum('Settle'),
    claims: count('Claim'), claimedHollar: sum('Claim'),
    reinvests: count('Reinvest'), reinvestedHollar: sum('Reinvest'), interestHollar: sum('Interest'), principalHollar: sum('Principal'),
    drawsHollar: sum('Draw'), repaysHollar: sum('Repay'),
    unpricedRows: deposits.filter(r => r.valueUsd == null).length,
  }
  // The vault's first deposit: the Decentral pool's own history predates BIL.
  const launch = deposits.length ? Math.min(...deposits.map(r => r.blockHeight)) : null
  const firstDay = deposits.length ? deposits.map(r => dayOf(r.timestamp)).sort()[0] : null
  const perDay = bilDays(rows.filter(r => firstDay == null || dayOf(r.timestamp) >= firstDay), firstDay, new Date().toISOString().slice(0, 10))

  return {
    generatedAt: new Date().toISOString(),
    asOfBlock: snap?.block ?? null,
    launchBlock: launch,
    vault: h160Account(BIL_VAULT),
    bilAsset: asset(BIL_ASSET_ID), ubilAsset: asset(UBIL_ASSET_ID), hollarAsset: asset(BIL_HOLLAR_ASSET_ID),
    status,
    exchangeRate: v?.exchangeRateWad ?? null,
    navUsd: rate != null ? rawUsd(ctx.prices, BIL_HOLLAR_ASSET_ID, rate) : null,
    tvl: v?.totalAssets ?? null, tvlUsd: v ? rawUsd(ctx.prices, BIL_HOLLAR_ASSET_ID, v.totalAssets) : null,
    cap: v?.tvlCap ?? null, remaining: remaining?.toString() ?? null, remainingBinding: binding,
    sharesOutstanding: v?.totalSupply ?? null, bilSupply: v?.suppliedUbil ?? null,
    idleHollar: v?.idleHollar ?? null, investedPrincipal: v?.totalInvestedPrincipal ?? null,
    pendingInterest: v?.totalPendingYield ?? null, reservedHollar: v?.totalReservedHollar ?? null, minRedeem: v?.minRedeem ?? null,
    apyPct: v ? wadNum(v.apyWad) * 100 : null,
    termDays: v ? v.periodSec / DAY : null,
    withdrawalDelaySec: v?.withdrawalDelaySec ?? null,
    realized: realizedOf(snap, rows),
    rateHistory: bilRateHistory(snap, rows),
    ladder: snap && snap.positions && v ? ladderOf(snap.positions, BigInt(v.fixedApyWad), BigInt(v.idleHollar), ctx.nowSec) : null,
    queue: snap && v ? {
      requests,
      pendingShares: pending.toString(),
      claimableHollar: snap.chainRequests ? snap.chainRequests.reduce((s, c) => s + BigInt(c.hollarOwed), 0n).toString() : null,
      quoteHollar: QUOTE_HOLLAR.toString(),
      quoteWait: quote ? waitOf(quote.maturityTime, processing, v.withdrawalDelaySec, ctx.nowSec) : null,
      quoteFromIdle: quote?.coveredByIdle ?? false,
      quoteCovered: quote?.covered ?? false,
      maxWaitSec: v.periodSec + Math.max(processing?.p90Sec ?? 0, v.withdrawalDelaySec),
      processing: processing ? { samples: processing.samples, medianHours: Math.round(processing.medianSec / 360) / 10, p90Hours: Math.round(processing.p90Sec / 360) / 10, maxHours: Math.round(processing.maxSec / 360) / 10 } : null,
    } : null,
    borrowing,
    rollover: {
      drawnHollar: totals.drawsHollar, repaidHollar: totals.repaysHollar,
      paidToVaultHollar: (BigInt(totals.interestHollar) + BigInt(totals.principalHollar)).toString(),
      investedByVaultHollar: snap?.positions ? snap.positions.reduce((s, p) => s + BigInt(p.principal), 0n).toString() : null,
    },
    holders: snap ? positions.filter(p => p.account.accountId !== poolAccount && p.share != null).length : null,
    depositors: new Set(rowsValued.filter(x => x.row.bilAction === 'Deposit' && x.party).map(x => x.party)).size,
    positions,
    positionsComplete: holdings.complete,
    pool,
    totals,
    perDay,
    contracts: [
      { role: 'BIL vault (BILVault — the uBIL token, ERC-4626 + ERC-7540)', account: h160Account(BIL_VAULT) },
      { role: 'Deposit zap (BILDepositZap)', account: h160Account(BIL_ZAP) },
      { role: 'BIL money market pool (Aave v3, isolated)', account: h160Account(BIL_MM_POOL) },
      { role: 'BIL token (the BIL market’s aToken over uBIL)', account: h160Account(BIL_ATOKEN) },
      { role: 'BIL / USD oracle (the vault rate, the pool’s peg source)', account: h160Account(BIL_ORACLE) },
      { role: 'Decentral lending pool', account: h160Account(DECENTRAL_POOL) },
      { role: 'Decentral position NFT (PoolToken)', account: h160Account(DECENTRAL_POOL_TOKEN) },
      { role: `BIL/HOLLAR stableswap pool (${BIL_POOL_ID})`, account: accountRef(poolAccount) },
    ],
  }
}

export interface AccountBilPosition {
  asOfBlock: number | null
  /** False when the vault's open requests could not be stated: a queued or claimable part may be missing. */
  complete: boolean
  position: (Omit<BilPositionView, 'account'> & {
    bilAsset: ExplorerAsset
    ubilAsset: ExplorerAsset
    hollarAsset: ExplorerAsset
    exchangeRate: string
    /** The stated APY — null when nothing of the position accrues (only settled HOLLAR awaits a claim). */
    apyPct: number | null
    termDays: number
    requests: BilRequestView[]
  }) | null
}

/**
 * An account's BIL position and its open redemption requests, from the current snapshot
 * alone — the account's own rows, never the whole dashboard. position null when it holds
 * none; asOfBlock null when the snapshot is stale.
 */
export async function getAccountBilPositions(address: string): Promise<AccountBilPosition | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const snap = currentBilSnapshot()
  if (!snap) return { asOfBlock: null, complete: false, position: null }
  const h160s = new Set(moneyMarketIdentities(resolved.related, resolved.norm).h160s.map(h => h.toLowerCase()))
  return cached(`explorer:bil-account:${snap.block}:${snap.readAt}:${[...h160s].sort().join(',')}`, 30_000, async () => {
    const ctx = await ctxOf()
    const rate = BigInt(snap.vault.exchangeRateWad)
    const { holdings, complete } = bilHoldings({
      bil: snap.bil, wallet: snap.wallet,
      chain: snap.chainRequests?.map(r => ({ controller: r.controller, escrowShares: BigInt(r.escrowShares), settledShares: BigInt(r.settledShares), hollarOwed: BigInt(r.hollarOwed) })) ?? null,
    })
    const accruingTotal = holdings.reduce((s, h) => s + bilAccruingShares(h), 0n)
    const mine = holdings.filter(h => h160s.has(h.h160))
    const requests = requestViews({ ...snap, requests: snap.requests.filter(r => h160s.has(r.controller) || h160s.has(r.owner)) }, ctx)
      .filter(r => r.status !== 'claimed' && r.status !== 'cancelled')
    if (!mine.length && !requests.length) return { asOfBlock: snap.block, complete, position: null }
    const sum: BilHolding = mine.reduce((a, h) => ({ h160: a.h160, bil: a.bil + h.bil, ubil: a.ubil + h.ubil, queuedShares: a.queuedShares + h.queuedShares, claimableHollar: a.claimableHollar + h.claimableHollar }),
      { h160: '', bil: 0n, ubil: 0n, queuedShares: 0n, claimableHollar: 0n })
    const view = positionView(sum, h160Account(BIL_VAULT), rate, accruingTotal, ctx)
    const { account: _account, ...rest } = view
    return {
      asOfBlock: snap.block, complete,
      position: {
        ...rest,
        bilAsset: asset(BIL_ASSET_ID), ubilAsset: asset(UBIL_ASSET_ID), hollarAsset: asset(BIL_HOLLAR_ASSET_ID),
        exchangeRate: snap.vault.exchangeRateWad,
        apyPct: bilAccruingShares(sum) > 0n ? wadNum(snap.vault.apyWad) * 100 : null,
        termDays: snap.vault.periodSec / DAY,
        requests,
      },
    }
  })
}
