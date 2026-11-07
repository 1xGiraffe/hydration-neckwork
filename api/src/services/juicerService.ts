import type { ClickHouseClient } from '../db/client.ts'
import { cacheRefresh, cached, cachedSwr } from './cache.ts'
import { currentPriceOf, displayDescriptor, type ExplorerAsset } from './explorerAssets.ts'
import {
  accountRef, ensurePrices, juicerPartyAccounts, juicerRowsValued, moneyMarketIdentities, resolveRelatedAccounts,
  type AccountRef, type ActivityRow, type PriceInfo,
} from './explorerService.ts'
import { getExplorerYields } from './positionYield.ts'
import {
  DEAD_ADDRESS, JUICER_CUSTODY_CONTRACTS, JUICER_DISCOUNT, JUICER_EXECUTION_CONTROLLER, JUICER_FEE_CONTROLLER, JUICER_HARVESTER, JUICER_KEEPERS,
  JUICER_SUBLOOP, JUICER_VAULTS, JUICER_YIELD_ACCOUNTING, PRIME_ATOKEN_ASSET_ID,
  juicerEstimatedApyPct, juicerRequestStatus, juicerRunRateApyPct, rebalanceBandBps, targetLoopLeverage,
  type JuicerAction, type JuicerRequest, type JuicerRequestStatus, type JuicerVaultDef,
} from './juicer.ts'
import { currentJuicerSnapshot, type JuicerSnapshot, type JuicerVaultState } from './juicerState.ts'

// The Juicer dashboard (/explorer/juicer) and an account's Juicer positions
// (/explorer/address/:a/juicer). Two sources, each for what it can state:
//  - the CURRENT state — TVL, cap, stops, rates, every holder's beneficial shares and
//    every withdrawal request — from the juicer-state refresher's pinned snapshot
//    (juicerState.ts), valued at current prices; absent (null) when the snapshot is
//    stale, never a zero;
//  - the HISTORY — deposits, withdrawal requests, claims, harvests and rebalances per
//    day, the depositors — from the indexed Juicer rows (the activity feed's own
//    builder, explorerService.juicerRowsValued), valued at event time.
// Holders are named by the one attribution rule the activity rows use
// (explorerService.juicerPartyAccounts).

// The dashboard is never built on a reader's request: the first build starts at
// process init (server.ts calls initJuicerService once the asset registry and account
// refs are loaded, before listen; history only, until the juicer-state refresher's
// first snapshot), and a timer rebuilds it in the background
// whenever that refresher publishes a new snapshot (on a juicer_logs/jETH change, else
// every fifth minute). Readers get the cached build — stale-while-revalidate across a
// snapshot change, so a reader is answered from the previous build while the next one
// computes; a reader arriving during the boot build joins its single flight.
const DASHBOARD_KEY = 'explorer:juicer-dashboard'
const DASHBOARD_FRESH_MS = 5 * 60_000
const DASHBOARD_STALE_MS = 30 * 60_000
const PREWARM_EVERY_MS = 15_000
let prewarmTimer: ReturnType<typeof setInterval> | null = null
let prewarmedGeneration = -1
let prewarming = false

export function initJuicerService(_c: ClickHouseClient): void {
  if (prewarmTimer) return
  prewarmTimer = setInterval(() => { void prewarmJuicerDashboard() }, PREWARM_EVERY_MS)
  prewarmTimer.unref?.()
  setTimeout(() => { void prewarmJuicerDashboard() }, 0).unref?.()
}

/** Builds the cached dashboard at boot, then rebuilds it when the snapshot it reads has changed (and only then). */
export async function prewarmJuicerDashboard(): Promise<void> {
  const snap = currentJuicerSnapshot()
  const generation = snap?.readAt ?? 0
  if (prewarming || generation === prewarmedGeneration) return
  prewarming = true
  try {
    await cacheRefresh(DASHBOARD_KEY, DASHBOARD_FRESH_MS, DASHBOARD_STALE_MS, () => buildJuicerDashboard(snap), generation)
    prewarmedGeneration = generation
  } catch (err) {
    console.warn('[juicer] dashboard prewarm failed; readers keep the previous build', err instanceof Error ? err.message : err)
  } finally {
    prewarming = false
  }
}

const WAD = 10n ** 18n
const BASE = 1e8

export interface JuicerWithdrawalView {
  requestId: number
  owner: AccountRef
  /** Shares requested (the Withdraw log). */
  shares: string
  status: JuicerRequestStatus
  requestedAt: string
  eligibleAt: string | null
  collateralOwed: string | null
  collateralSettled: string
  claimed: string
  /** The collateral it is worth: what the unwind fixed less what was claimed, else the requested shares at today's rate. */
  assets: string | null
  valueUsd: number | null
}
export interface JuicerPositionView {
  account: AccountRef
  /** Everything the account's position is: held shares plus what is on its way out, in shares. */
  totalShares: string
  totalAssets: string | null
  totalUsd: number | null
  /** balanceOf: wallet shares plus funded earnings. */
  shares: string
  assets: string | null
  valueUsd: number | null
  /** Share of the shares outstanding (custody excluded). */
  share: number | null
  /** Shares of open withdrawal requests: requested and not yet unwinding, or unwinding and stated at what the unwind fixed. */
  inWithdrawal: string
  inWithdrawalAssets: string | null
  inWithdrawalUsd: number | null
}
export interface JuicerVaultView {
  vault: AccountRef
  name: string
  shareAsset: ExplorerAsset
  collateral: ExplorerAsset
  baseAsset: ExplorerAsset
  status: 'open' | 'full' | 'paused' | 'deploying' | 'unavailable'
  paused: boolean | null
  depositsPaused: boolean | null
  deficitStop: boolean | null
  deleverPending: boolean | null
  deploying: boolean | null
  tvl: string | null
  tvlUsd: number | null
  cap: string | null
  remaining: string | null
  sharesOutstanding: string | null
  exchangeRate: string | null
  /** The official estimate: the loop at its TARGET leverage and Main at its target LTV. */
  apyPct: number | null
  /** What holders accrue now: the same at the loop's live leverage and Main's live LTV. */
  runRateApyPct: number | null
  deployedFraction: number | null
  maxLtvBps: number | null
  targetLtvBps: number | null
  releverLtvBps: number | null
  deleverLtvBps: number | null
  liquidationThresholdBps: number | null
  exitHeadroom: JuicerVaultState['exitHeadroom']
  main: { collateralUsd: number | null; syntheticUsd: number | null; debtUsd: number | null; healthFactor: number | null; ltv: number | null } | null
  protocolFeeBps: number | null
  mainDiscountBps: number | null
  withdrawalDelaySec: number | null
  holders: number | null
  withdrawals: JuicerWithdrawalView[]
  positions: JuicerPositionView[]
}
export interface JuicerLoopView {
  account: AccountRef
  collateralUsd: number | null
  debtUsd: number | null
  healthFactor: number | null
  targetHf: number | null
  leverage: number | null
  targetLeverage: number | null
  borrowRatePct: number | null
  loopDiscountBps: number | null
  primeSupplyApyPct: number | null
  primeLtBps: number | null
  emergencyPaused: boolean | null
}
export interface JuicerDayView {
  day: string
  deposits: number
  depositsUsd: number
  withdrawals: number
  withdrawShares: string
  claims: number
  claimsUsd: number
  harvestsUsd: number
  rebalances: number
}
export interface JuicerDashboard {
  generatedAt: string
  /** The block the current state was read at; null when no fresh snapshot exists. */
  asOfBlock: number | null
  launchBlock: number | null
  vaults: JuicerVaultView[]
  loop: JuicerLoopView | null
  totals: {
    tvlUsd: number | null
    depositors: number
    deposits: number
    depositsUsd: number
    withdrawals: number
    claims: number
    claimsUsd: number
    harvests: number
    harvestsUsd: number
    rebalances: number
    unpricedRows: number
  }
  perDay: JuicerDayView[]
  contracts: Array<{ role: string; account: AccountRef }>
}

const asset = (id: number): ExplorerAsset => displayDescriptor(id)
const h160Account = (h: string): AccountRef => accountRef('0x45544800' + h.slice(2).toLowerCase() + '0'.repeat(16))
function rawUsd(prices: Map<number, PriceInfo>, assetId: number, raw: string | null): number | null {
  const p = currentPriceOf(prices, assetId)?.price
  const d = asset(assetId).decimals
  if (raw == null || p == null || d == null) return null
  const v = Number(raw) / 10 ** d * p
  return Number.isFinite(v) ? v : null
}
const CUSTODY = new Set([...JUICER_CUSTODY_CONTRACTS, DEAD_ADDRESS])

/**
 * Main's REAL collateral — the base collateral less the synthetic the vault supplied,
 * at its oracle price — its LTV and the share of the target borrowing deployed (the
 * official app's "Borrowing at x% of target").
 */
export function mainBreakdown(main: JuicerVaultState['main'], syntheticBase: string | null, targetLtvBps: number | null) {
  if (!main || syntheticBase == null) return null
  const coll = Number(main.collateralBase) / BASE, debt = Number(main.debtBase) / BASE, synth = Number(syntheticBase) / BASE
  const real = coll - synth
  const target = targetLtvBps != null ? targetLtvBps / 1e4 : null
  return {
    collateralUsd: real > 0 ? real : null,
    syntheticUsd: synth,
    debtUsd: debt,
    healthFactor: Number(main.healthFactor) / 1e18,
    ltv: real > 0 ? debt / real : null,
    deployedFraction: real > 0 && target != null && target > 0 ? Math.min(debt / (real * target), 1) : null,
  }
}

function requestAssets(r: JuicerRequest, rateWad: bigint | null): string | null {
  if (r.started) {
    const owed = BigInt(r.collateralOwed ?? '0'), claimed = BigInt(r.claimed)
    return (owed > claimed ? owed - claimed : 0n).toString()
  }
  return rateWad == null ? null : (BigInt(r.shares) * rateWad / WAD).toString()
}

interface VaultCtx { prices: Map<number, PriceInfo>; primeSupplyApyPct: number | null; parties: ReadonlyMap<string, string>; nowSec: number }
function holderRef(ctx: VaultCtx, h: string): AccountRef {
  const id = ctx.parties.get(h)
  return id ? accountRef(id) : h160Account(h)
}

/** Every position of a vault (beneficial shares, custody excluded), largest first. */
function vaultPositions(v: JuicerVaultDef, s: JuicerVaultState, ctx: VaultCtx): JuicerPositionView[] {
  const rate = BigInt(s.exchangeRateWad)
  const toAssets = (shares: bigint) => (shares * rate / WAD).toString()
  // What is on its way out, per owner, in shares: requested and pending, or unwinding at what it is still owed.
  const out = new Map<string, bigint>()
  for (const r of s.requests) {
    if (juicerRequestStatus(r, ctx.nowSec) === 'claimed') continue
    const shares = r.started && rate > 0n ? BigInt(requestAssets(r, rate) ?? '0') * WAD / rate : BigInt(r.shares)
    out.set(r.owner, (out.get(r.owner) ?? 0n) + shares)
  }
  let supply = 0n
  for (const [h, b] of s.beneficial) if (!CUSTODY.has(h) && b > 0n) supply += b
  const rows: JuicerPositionView[] = []
  for (const [h, total] of s.beneficial) {
    if (CUSTODY.has(h) || total <= 0n) continue
    const leaving = out.get(h) ?? 0n
    const held = total > leaving ? total - leaving : 0n
    rows.push({
      account: holderRef(ctx, h),
      totalShares: total.toString(), totalAssets: toAssets(total), totalUsd: rawUsd(ctx.prices, v.collateralAssetId, toAssets(total)),
      shares: held.toString(), assets: toAssets(held), valueUsd: rawUsd(ctx.prices, v.collateralAssetId, toAssets(held)),
      share: supply > 0n ? Number(total * 1_000_000n / supply) / 1_000_000 : null,
      inWithdrawal: leaving.toString(), inWithdrawalAssets: toAssets(leaving), inWithdrawalUsd: rawUsd(ctx.prices, v.collateralAssetId, toAssets(leaving)),
    })
  }
  return rows.sort((a, b) => (BigInt(b.totalShares) > BigInt(a.totalShares) ? 1 : BigInt(b.totalShares) < BigInt(a.totalShares) ? -1 : 0))
}

function vaultWithdrawals(v: JuicerVaultDef, s: JuicerVaultState, ctx: VaultCtx): JuicerWithdrawalView[] {
  const rate = BigInt(s.exchangeRateWad)
  return s.requests.map(r => {
    const assets = requestAssets(r, rate)
    return {
      requestId: r.requestId, owner: holderRef(ctx, r.owner), shares: r.shares, status: juicerRequestStatus(r, ctx.nowSec),
      requestedAt: r.requestedAt.timestamp,
      eligibleAt: r.eligibleAt ? new Date(r.eligibleAt * 1000).toISOString() : null,
      collateralOwed: r.collateralOwed, collateralSettled: r.settled, claimed: r.claimed,
      assets, valueUsd: rawUsd(ctx.prices, v.collateralAssetId, assets),
    }
  }).sort((a, b) => b.requestId - a.requestId)
}

function vaultView(v: JuicerVaultDef, s: JuicerVaultState | null, snap: JuicerSnapshot | null, ctx: VaultCtx): JuicerVaultView {
  const band = s?.band && s.maxLtvBps ? rebalanceBandBps(s.maxLtvBps, s.band) : null
  const targetLtvBps = band?.target ?? s?.maxLtvBps ?? null
  const main = s ? mainBreakdown(s.main, s.syntheticBase, targetLtvBps) : null
  const loop = snap?.loop
  const borrowRate = loop?.hollarBorrowRateRay != null ? Number(loop.hollarBorrowRateRay) / 1e27 : null
  const common = s && loop && borrowRate != null && s.protocolFeeBps != null && s.mainDiscountBps != null && loop.loopDiscountBps != null && ctx.primeSupplyApyPct != null
    ? { borrowRate, primeSupplyApyPct: ctx.primeSupplyApyPct, protocolFeeBps: s.protocolFeeBps, mainDiscountBps: s.mainDiscountBps, loopDiscountBps: loop.loopDiscountBps }
    : null
  const apy = common && targetLtvBps != null && loop
    ? juicerEstimatedApyPct({ ...common, targetLtv: targetLtvBps / 1e4, targetHf: Number(loop.targetHf) / 1e18, primeLtBps: loop.primeLiquidationThresholdBps })
    : null
  const loopColl = loop?.account ? Number(loop.account.collateralBase) / BASE : null
  const loopDebt = loop?.account ? Number(loop.account.debtBase) / BASE : null
  const leverage = loopColl != null && loopDebt != null && loopColl > loopDebt ? loopColl / (loopColl - loopDebt) : null
  const runRate = common && leverage != null && main?.ltv != null ? juicerRunRateApyPct({ ...common, leverage, mainLtv: main.ltv }) : null
  const remaining = s ? (BigInt(s.tvlCap) > BigInt(s.totalAssets) ? (BigInt(s.tvlCap) - BigInt(s.totalAssets)).toString() : '0') : null
  // The app reads the room left at or below 1 bp of the cap as full (FULL_SHARE_BPS).
  const full = remaining != null && s != null && BigInt(remaining) * 10_000n <= BigInt(s.tvlCap)
  const status: JuicerVaultView['status'] = !s ? 'unavailable'
    : s.paused || s.depositsPaused || s.deficitStop || s.deleverPending || loop?.emergencyPaused ? 'paused'
      : full ? 'full' : s.deploying ? 'deploying' : 'open'
  const positions = s ? vaultPositions(v, s, ctx) : []
  return {
    vault: h160Account(v.vault), name: v.name,
    shareAsset: asset(v.shareAssetId), collateral: asset(v.collateralAssetId), baseAsset: asset(v.baseAssetId),
    status, paused: s?.paused ?? null, depositsPaused: s?.depositsPaused ?? null, deficitStop: s?.deficitStop ?? null,
    deleverPending: s?.deleverPending ?? null, deploying: s?.deploying ?? null,
    tvl: s?.totalAssets ?? null, tvlUsd: rawUsd(ctx.prices, v.collateralAssetId, s?.totalAssets ?? null),
    cap: s?.tvlCap ?? null, remaining, sharesOutstanding: s?.totalSupply ?? null, exchangeRate: s?.exchangeRateWad ?? null,
    apyPct: apy, runRateApyPct: runRate, deployedFraction: main?.deployedFraction ?? null,
    maxLtvBps: s?.maxLtvBps ?? null, targetLtvBps, releverLtvBps: band?.relever ?? null, deleverLtvBps: band?.delever ?? null,
    liquidationThresholdBps: s?.liquidationThresholdBps ?? null, exitHeadroom: s?.exitHeadroom ?? null,
    main: main ? { collateralUsd: main.collateralUsd, syntheticUsd: main.syntheticUsd, debtUsd: main.debtUsd, healthFactor: main.healthFactor, ltv: main.ltv } : null,
    protocolFeeBps: s?.protocolFeeBps ?? null, mainDiscountBps: s?.mainDiscountBps ?? null, withdrawalDelaySec: s?.withdrawalDelaySec ?? null,
    holders: s ? positions.length : null,
    withdrawals: s ? vaultWithdrawals(v, s, ctx) : [], positions,
  }
}

function loopView(snap: JuicerSnapshot | null, primeSupplyApyPct: number | null): JuicerLoopView | null {
  const l = snap?.loop
  if (!l) return null
  const coll = l.account ? Number(l.account.collateralBase) / BASE : null
  const debt = l.account ? Number(l.account.debtBase) / BASE : null
  const targetHf = Number(l.targetHf) / 1e18
  return {
    account: h160Account(JUICER_SUBLOOP),
    collateralUsd: coll, debtUsd: debt,
    healthFactor: l.account ? Number(l.account.healthFactor) / 1e18 : null, targetHf,
    leverage: coll != null && debt != null && coll > debt ? coll / (coll - debt) : null,
    targetLeverage: targetLoopLeverage(targetHf, l.primeLiquidationThresholdBps),
    borrowRatePct: l.hollarBorrowRateRay != null ? Number(l.hollarBorrowRateRay) / 1e25 : null,
    loopDiscountBps: l.loopDiscountBps, primeSupplyApyPct, primeLtBps: l.primeLiquidationThresholdBps, emergencyPaused: l.emergencyPaused,
  }
}

async function primeSupplyApy(): Promise<number | null> {
  try {
    const y = await getExplorerYields()
    const core = y.moneyMarket?.core as Record<string, { supply?: { totalAprPct?: number } }> | undefined
    const v = core?.[String(PRIME_ATOKEN_ASSET_ID)]?.supply?.totalAprPct
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch { return null }
}

const DAY_ACTIONS: ReadonlySet<JuicerAction> = new Set(['Deposit', 'Withdraw', 'Claim', 'Harvest', 'Rebalance'])
export function juicerDays(rows: ActivityRow[], fromDay: string | null, toDay: string): JuicerDayView[] {
  const byDay = new Map<string, JuicerDayView>()
  const blank = (day: string): JuicerDayView => ({ day, deposits: 0, depositsUsd: 0, withdrawals: 0, withdrawShares: '0', claims: 0, claimsUsd: 0, harvestsUsd: 0, rebalances: 0 })
  for (const r of rows) {
    if (!r.juicerAction || !DAY_ACTIONS.has(r.juicerAction)) continue
    const day = r.timestamp.slice(0, 10)
    const d = byDay.get(day) ?? byDay.set(day, blank(day)).get(day)!
    if (r.juicerAction === 'Deposit') { d.deposits++; d.depositsUsd += r.valueUsd ?? 0 }
    else if (r.juicerAction === 'Withdraw') { d.withdrawals++; d.withdrawShares = (BigInt(d.withdrawShares) + BigInt(r.amount ?? '0')).toString() }
    else if (r.juicerAction === 'Claim') { d.claims++; d.claimsUsd += r.valueUsd ?? 0 }
    else if (r.juicerAction === 'Harvest') d.harvestsUsd += r.valueUsd ?? 0
    else if (r.juicerAction === 'Rebalance') d.rebalances++
  }
  const first = fromDay ?? [...byDay.keys()].sort()[0]
  if (!first) return []
  const out: JuicerDayView[] = []
  for (let t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(toDay + 'T00:00:00Z'); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10)
    out.push(byDay.get(day) ?? blank(day))
  }
  return out
}

async function vaultCtx(): Promise<VaultCtx> {
  const [prices, prime, parties] = await Promise.all([ensurePrices(), primeSupplyApy(), juicerPartyAccounts()])
  return { prices, primeSupplyApyPct: prime, parties, nowSec: Math.floor(Date.now() / 1000) }
}

export async function getJuicerDashboard(): Promise<JuicerDashboard> {
  const snap = currentJuicerSnapshot()
  return cachedSwr(DASHBOARD_KEY, DASHBOARD_FRESH_MS, DASHBOARD_STALE_MS, () => buildJuicerDashboard(snap), snap?.readAt ?? 0)
}

async function buildJuicerDashboard(snap: JuicerSnapshot | null): Promise<JuicerDashboard> {
  const [ctx, rowsValued] = await Promise.all([vaultCtx(), juicerRowsValued()])
  const vaults = JUICER_VAULTS.map(v => vaultView(v, snap?.vaults.find(x => x.vault === v.vault) ?? null, snap, ctx))
  const rows = rowsValued.map(x => x.row)
  const totals = {
    tvlUsd: vaults.every(v => v.tvlUsd != null) ? vaults.reduce((s, v) => s + (v.tvlUsd ?? 0), 0) : null,
    depositors: new Set(rowsValued.filter(x => x.row.juicerAction === 'Deposit' && x.party && x.party !== '0xaa7e0000000000000000000000000000000aa7e0').map(x => x.party)).size,
    deposits: 0, depositsUsd: 0, withdrawals: 0, claims: 0, claimsUsd: 0, harvests: 0, harvestsUsd: 0, rebalances: 0, unpricedRows: 0,
  }
  for (const r of rows) {
    const priced = r.valueUsd != null
    if (r.juicerAction === 'Deposit') { totals.deposits++; totals.depositsUsd += r.valueUsd ?? 0; if (!priced) totals.unpricedRows++ }
    else if (r.juicerAction === 'Withdraw') totals.withdrawals++
    else if (r.juicerAction === 'Claim') { totals.claims++; totals.claimsUsd += r.valueUsd ?? 0; if (!priced) totals.unpricedRows++ }
    else if (r.juicerAction === 'Harvest') { totals.harvests++; totals.harvestsUsd += r.valueUsd ?? 0; if (!priced) totals.unpricedRows++ }
    else if (r.juicerAction === 'Rebalance') totals.rebalances++
  }
  const launch = rows.length ? Math.min(...rows.map(r => r.blockHeight)) : null
  const firstDay = rows.length ? rows.map(r => r.timestamp.slice(0, 10)).sort()[0] : null
  const contracts: Array<{ role: string; account: AccountRef }> = [
    ...JUICER_VAULTS.flatMap(v => [
      { role: `${v.name} vault (CollateralVault, the ${asset(v.shareAssetId).symbol} token)`, account: h160Account(v.vault) },
      { role: `${v.name} Main debt ledger (JuicerMainDebt)`, account: h160Account(v.mainDebt) },
      { role: `${v.name} synthetic collateral (SyntheticToken)`, account: h160Account(v.synthetic) },
    ]),
    { role: 'PRIME loop (SubLoop)', account: h160Account(JUICER_SUBLOOP) },
    { role: 'Harvester', account: h160Account(JUICER_HARVESTER) },
    { role: 'Fee controller (JuicerFeeController)', account: h160Account(JUICER_FEE_CONTROLLER) },
    { role: 'HOLLAR discount (JuicerDiscount)', account: h160Account(JUICER_DISCOUNT) },
    { role: 'Yield accounting (JuicerYieldAccounting)', account: h160Account(JUICER_YIELD_ACCOUNTING) },
    { role: 'Execution controller', account: h160Account(JUICER_EXECUTION_CONTROLLER) },
    ...JUICER_KEEPERS.map((k, i) => ({ role: `Keeper ${i + 1}`, account: h160Account(k) })),
  ]
  return {
    generatedAt: new Date().toISOString(),
    asOfBlock: snap?.block ?? null,
    launchBlock: launch,
    vaults,
    loop: loopView(snap, ctx.primeSupplyApyPct),
    totals,
    perDay: juicerDays(rows, firstDay, new Date().toISOString().slice(0, 10)),
    contracts,
  }
}

export interface AccountJuicerPositions {
  asOfBlock: number | null
  positions: Array<{ vault: AccountRef; name: string; shareAsset: ExplorerAsset; collateral: ExplorerAsset; apyPct: number | null; runRateApyPct: number | null } & Omit<JuicerPositionView, 'account'> & { withdrawals: JuicerWithdrawalView[] }>
}

/**
 * An account's Juicer positions and open withdrawal requests, from the current
 * snapshot alone — the account's own rows, never the whole dashboard. Empty when it
 * holds none; asOfBlock null when the snapshot is stale.
 */
export async function getAccountJuicerPositions(address: string): Promise<AccountJuicerPositions | null> {
  const resolved = await resolveRelatedAccounts(address)
  if (!resolved) return null
  const snap = currentJuicerSnapshot()
  if (!snap) return { asOfBlock: null, positions: [] }
  const h160s = new Set(moneyMarketIdentities(resolved.related, resolved.norm).h160s.map(h => h.toLowerCase()))
  return cached(`explorer:juicer-account:${snap.block}:${snap.readAt}:${[...h160s].sort().join(',')}`, 30_000, async () => {
    const ctx = await vaultCtx()
    const positions: AccountJuicerPositions['positions'] = []
    for (const v of JUICER_VAULTS) {
      const s = snap.vaults.find(x => x.vault === v.vault)
      if (!s) continue
      const mine = (h: string) => h160s.has(h)
      const pos = vaultPositions(v, { ...s, beneficial: new Map([...s.beneficial].filter(([h]) => mine(h))) }, ctx)
      const withdrawals = vaultWithdrawals(v, { ...s, requests: s.requests.filter(r => mine(r.owner)) }, ctx).filter(w => w.status !== 'claimed')
      if (!pos.length && !withdrawals.length) continue
      const view = vaultView(v, s, snap, { ...ctx })
      // The vault-wide share is of every holder's shares, not of this account's alone.
      let supply = 0n
      for (const [h, b] of s.beneficial) if (!CUSTODY.has(h) && b > 0n) supply += b
      const p = pos[0]
      const total = BigInt(p?.totalShares ?? '0')
      positions.push({
        vault: view.vault, name: v.name, shareAsset: view.shareAsset, collateral: view.collateral, apyPct: view.apyPct, runRateApyPct: view.runRateApyPct,
        totalShares: p?.totalShares ?? '0', totalAssets: p?.totalAssets ?? '0', totalUsd: p?.totalUsd ?? null,
        shares: p?.shares ?? '0', assets: p?.assets ?? '0', valueUsd: p?.valueUsd ?? null,
        share: supply > 0n ? Number(total * 1_000_000n / supply) / 1_000_000 : null,
        inWithdrawal: p?.inWithdrawal ?? '0', inWithdrawalAssets: p?.inWithdrawalAssets ?? '0', inWithdrawalUsd: p?.inWithdrawalUsd ?? null,
        withdrawals,
      })
    }
    return { asOfBlock: snap.block, positions }
  })
}
