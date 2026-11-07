import type { ClickHouseClient } from '../db/client.ts'
import { loadPinnedBlock } from './pinnedBlock.ts'
import { makeTolerantEthCall, type TolerantEthCall } from './mmOraclePrices.ts'
import {
  BIL_ASSET_ID, BIL_ATOKEN, BIL_HOLLAR_ASSET_ID, BIL_HOLLAR_CONTRACT, BIL_MM_POOL, BIL_VAULT, DECENTRAL_POOL, UBIL_ASSET_ID, UBIL_RESERVE,
  bilBeneficialBalances, bilControllerClaims, bilPositions, bilRequests, bilYieldRateSum, decodeBilLog, withPositionTerms,
  type BilEvent, type BilLogRow, type BilPosition, type BilPositionTerms, type BilRequest,
} from './bil.ts'
import { abiArg as arg, createStrategyRefresher, loadErc20Wallet, loadReserveBorrowRate, reserveConfig, selectRows as select, strategyChangeMark, word } from './strategyRefresher.ts'

// The BIL strategy's CURRENT state at ONE pinned block (pinnedBlock.ts), held in memory
// and read by the coordinated background refresher (backgroundRefresh.ts, the shared
// cycle in strategyRefresher.ts) — never on a request path. Everything the index states
// is read from it at that block:
//  - the redemption requests' lifecycle, the Decentral positions (the maturity ladder)
//    and every setting with an event from bil_logs;
//  - uBIL's wallet balances from its Transfer deltas (the vault's escrow, the BIL
//    aToken's backing), and BIL's — the money market's aToken over uBIL — from its
//    scaled deltas (atoken_scaled_deltas; BIL launched after the anchor block, so they
//    start from zero) at the reserve's normalized income;
//  - the BIL market's HOLLAR borrow rate from money_market_reserve_rates.
// Only what no event states is an eth_call at the pinned block's hash: the vault's
// exchange rate and the totals behind it (assets, supply, idle, pending interest,
// reserved HOLLAR, invested principal, the uncapped yield rate), its APY, cap and stops;
// the Decentral pool's investment period, fixed APY and withdrawal delay; the uBIL
// reserve's configuration (LTV, liquidation threshold, supply cap); each position's
// stored terms (deposit time, maturity, rate), read once per position — they never
// change; and, for the requests the logs leave open, what each still holds in escrow and
// is owed (getRedemptionRequest: claims are per controller, so no log names the request
// a claim drew down).
//
// Checks before anything is stated: the open positions' principal must equal the
// vault's totalInvestedPrincipal and their uncapped rate × principal its yieldRateSum
// (else the ladder is withheld — null, never a guess), and the open requests' escrow and
// settled shares must equal totalQueuedBil and totalSettledBil (else the requests and the
// beneficial balances are withheld). The rate and totals are published either way.

const SEL = {
  exchangeRate: '0x3ba0b9a9', totalAssets: '0x01e1d114', totalSupply: '0x18160ddd', tvlCap: '0x3f23fa1a',
  getIdleHollar: '0x9473c56d', getAPYWad: '0x1867c860', paused: '0x5c975abb', depositsPaused: '0x60da3e83',
  totalInvestedPrincipal: '0x0817f9dc', yieldRateSum: '0xc3615c19', totalPendingYield: '0x581537e6',
  totalReservedHollar: '0xda79f454', totalSettledBil: '0x19fdcd8f', totalQueuedBil: '0xdec65c5a', minRedeemAmount: '0x0912ae6d',
  minimumInvestmentPeriodSeconds: '0x3e4b43b3', fixedAPYWad: '0xace20088', principalWithdrawalDelaySeconds: '0xc5126d1c',
  isShutdown: '0xbf86d690', getRedemptionRequest: '0x3aa6f0ee', getPosition: '0xeb02c301', getConfiguration: '0xc44b11f7',
  getReserveNormalizedIncome: '0xd15e0053',
}
const RAY = 10n ** 27n

export interface BilChainRequest {
  requestId: number
  controller: string
  /** uBIL the request still holds in escrow (unsettled plus settled-unclaimed). */
  escrowShares: string
  /** Of it, settled and waiting to be claimed. */
  settledShares: string
  /** HOLLAR fixed for the settled part, not yet claimed. */
  hollarOwed: string
}
export interface BilVaultState {
  exchangeRateWad: string
  totalAssets: string
  totalSupply: string
  tvlCap: string
  idleHollar: string
  apyWad: string
  paused: boolean
  depositsPaused: boolean
  totalInvestedPrincipal: string
  totalPendingYield: string
  totalReservedHollar: string
  totalSettledBil: string
  totalQueuedBil: string
  minRedeem: string
  /** The Decentral pool's terms for new positions. */
  periodSec: number
  fixedApyWad: string
  withdrawalDelaySec: number
  decentralShutdown: boolean
  /** The uBIL reserve: its supply cap in whole uBIL (0 = uncapped) and the uBIL supplied to it now. */
  supplyCapUbil: string
  suppliedUbil: string
  /** What BIL can borrow against in its market: the uBIL reserve's LTV and liquidation threshold (bps), and HOLLAR's variable borrow rate there (ray). */
  maxLtvBps: number
  liquidationThresholdBps: number
  hollarBorrowRateRay: string | null
}
export interface BilSnapshot {
  block: number
  readAt: number
  vault: BilVaultState
  /** Every Decentral position the vault opened, with its stored terms; null when they disagree with the chain. */
  positions: BilPosition[] | null
  /** Every redemption request from the logs. */
  requests: BilRequest[]
  /** The open requests' escrow at the pin; null when the logs and the chain disagree. */
  chainRequests: BilChainRequest[] | null
  /** Per controller: uBIL claimed and the HOLLAR paid for it. */
  claims: Map<string, { shares: bigint; hollar: bigint }>
  /** BIL (the aToken) per holder H160: its scaled balance at the reserve's normalized income. */
  bil: Map<string, bigint>
  /** uBIL wallet balances (Transfer deltas) and the beneficial balances (escrow attributed). */
  wallet: Map<string, bigint>
  beneficial: Map<string, bigint> | null
  /** The decoded logs the snapshot was read with (every BIL act up to `block`). */
  events: BilEvent[]
}

/** Every BIL log up to `block`, decoded. */
export async function loadBilEvents(ch: ClickHouseClient, block: number): Promise<BilEvent[]> {
  const rows = await select<BilLogRow>(ch, `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, contract_address, topic0, topics, data
    FROM price_data.bil_logs FINAL WHERE block_height <= {b:UInt32} ORDER BY block_height, event_index`, { b: block })
  return rows.map(decodeBilLog).filter((e): e is BilEvent => e != null)
}

async function loadBilScaled(ch: ClickHouseClient, block: number): Promise<Map<string, bigint>> {
  const rows = await select<{ holder: string; scaled: string }>(ch, `SELECT holder, toString(sum(scaled_delta)) AS scaled
    FROM price_data.atoken_scaled_deltas FINAL
    WHERE contract_address = {c:String} AND block_height <= {b:UInt32}
    GROUP BY holder HAVING sum(scaled_delta) != 0`, { c: BIL_ATOKEN, b: block })
  return new Map(rows.map(r => [r.holder.toLowerCase(), BigInt(r.scaled)] as [string, bigint]))
}

/** The requests the logs leave open: still pending, or settled under a controller with unclaimed settlements. */
export function openRequestIds(requests: readonly BilRequest[], claims: ReadonlyMap<string, { shares: bigint }>): number[] {
  const settledBy = new Map<string, bigint>()
  for (const r of requests) settledBy.set(r.controller, (settledBy.get(r.controller) ?? 0n) + BigInt(r.settledShares))
  return requests.filter(r => BigInt(r.pendingShares) > 0n
    || (BigInt(r.settledShares) > 0n && (settledBy.get(r.controller) ?? 0n) > (claims.get(r.controller)?.shares ?? 0n)))
    .map(r => r.requestId)
}

/**
 * The open requests' chain state, checked: their escrow and settled shares must sum to
 * the vault's totalQueuedBil and totalSettledBil, and each must still name the controller
 * its log did. Null otherwise — the requests are then withheld, never guessed.
 */
export function checkChainRequests(
  requests: readonly BilRequest[], ids: readonly number[],
  reads: ReadonlyArray<{ user: bigint; amount: bigint; settled: bigint; owed: bigint; active: bigint } | null>,
  totals: { queued: bigint; settled: bigint },
): BilChainRequest[] | null {
  const out: BilChainRequest[] = []
  let escrow = 0n, settled = 0n
  for (let i = 0; i < ids.length; i++) {
    const r = reads[i]
    if (!r) return null
    if (r.active === 0n) continue
    const controller = '0x' + r.user.toString(16).padStart(40, '0')
    if (controller !== requests.find(x => x.requestId === ids[i])?.controller) return null
    escrow += r.amount; settled += r.settled
    out.push({ requestId: ids[i], controller, escrowShares: r.amount.toString(), settledShares: r.settled.toString(), hollarOwed: r.owed.toString() })
  }
  if (escrow !== totals.queued || settled !== totals.settled) {
    console.warn(`[bil] open requests hold ${escrow} escrow / ${settled} settled, the vault states ${totals.queued} / ${totals.settled}; requests withheld`)
    return null
  }
  return out
}

async function readChainRequests(call: TolerantEthCall, requests: readonly BilRequest[], ids: number[], vault: BilVaultState): Promise<BilChainRequest[] | null> {
  const reads = ids.length ? await call(ids.map(id => ({ to: BIL_VAULT, data: SEL.getRedemptionRequest + arg(id) }))) : []
  return checkChainRequests(requests, ids, reads.map(h => {
    const user = word(h, 0), amount = word(h, 1), settled = word(h, 2), owed = word(h, 3), active = word(h, 4)
    return user == null || amount == null || settled == null || owed == null || active == null ? null : { user, amount, settled, owed, active }
  }), { queued: BigInt(vault.totalQueuedBil), settled: BigInt(vault.totalSettledBil) })
}

// Each position's stored terms, read once: a position's deposit time, maturity and rate
// never change after it is opened (its state does, and the logs state that).
const termsByIndex = new Map<number, BilPositionTerms>()
async function readPositionTerms(call: TolerantEthCall, positions: readonly BilPosition[]): Promise<boolean> {
  const missing = positions.filter(p => p.state !== 'redeemed' && !termsByIndex.has(p.index))
  if (!missing.length) return true
  const reads = await call(missing.map(p => ({ to: BIL_VAULT, data: SEL.getPosition + arg(p.index) })))
  for (let i = 0; i < missing.length; i++) {
    const h = reads[i]
    const tokenId = word(h, 0), principal = word(h, 1), apy = word(h, 2), dep = word(h, 3), mat = word(h, 4)
    if (tokenId == null || principal == null || apy == null || dep == null || mat == null) return false
    termsByIndex.set(missing[i].index, { tokenId: tokenId.toString(), principal: principal.toString(), apyWad: apy.toString(), depositTime: Number(dep), maturityTime: Number(mat) })
  }
  return true
}

/** One cycle: everything at one pinned block, or nothing (the previous snapshot stays). */
export async function readBilSnapshot(ch: ClickHouseClient): Promise<BilSnapshot | null> {
  const pin = await loadPinnedBlock(ch, undefined, 'bil:pin')
  const call = makeTolerantEthCall({ blockHash: pin.ethBlockHash })
  const v = BIL_VAULT, p = DECENTRAL_POOL
  const [events, wallet, scaled, borrowRate, core] = await Promise.all([
    loadBilEvents(ch, pin.block),
    loadErc20Wallet(ch, BIL_VAULT, pin.block),
    loadBilScaled(ch, pin.block),
    loadReserveBorrowRate(ch, BIL_MM_POOL, BIL_HOLLAR_CONTRACT, pin.block),
    call([
      { to: v, data: SEL.exchangeRate }, { to: v, data: SEL.totalAssets }, { to: v, data: SEL.totalSupply }, { to: v, data: SEL.tvlCap },
      { to: v, data: SEL.getIdleHollar }, { to: v, data: SEL.getAPYWad }, { to: v, data: SEL.paused }, { to: v, data: SEL.depositsPaused },
      { to: v, data: SEL.totalInvestedPrincipal }, { to: v, data: SEL.totalPendingYield }, { to: v, data: SEL.totalReservedHollar },
      { to: v, data: SEL.totalSettledBil }, { to: v, data: SEL.totalQueuedBil }, { to: v, data: SEL.minRedeemAmount },
      { to: p, data: SEL.minimumInvestmentPeriodSeconds }, { to: p, data: SEL.fixedAPYWad }, { to: p, data: SEL.principalWithdrawalDelaySeconds },
      { to: p, data: SEL.isShutdown }, { to: BIL_MM_POOL, data: SEL.getConfiguration + arg(UBIL_RESERVE) },
      { to: BIL_MM_POOL, data: SEL.getReserveNormalizedIncome + arg(UBIL_RESERVE) }, { to: v, data: SEL.yieldRateSum },
    ]),
  ])
  const w = core.map(h => word(h, 0))
  if (w.some(x => x == null)) return null
  const [rate, assets, supply, cap, idle, apy, paused, depPaused, invested, pendingYield, reserved, settledBil, queuedBil, minRedeem, period, fixedApy, delay, shutdown, config, income, yieldRateSum] = w as bigint[]
  // rayMul, half up: what the aToken's balanceOf states.
  const bil = new Map([...scaled].filter(([, x]) => x > 0n).map(([h, x]) => [h, (x * income + RAY / 2n) / RAY] as [string, bigint]))
  const cfg = reserveConfig(config)
  const vault: BilVaultState = {
    exchangeRateWad: rate.toString(), totalAssets: assets.toString(), totalSupply: supply.toString(), tvlCap: cap.toString(),
    idleHollar: idle.toString(), apyWad: apy.toString(), paused: paused !== 0n, depositsPaused: depPaused !== 0n,
    totalInvestedPrincipal: invested.toString(), totalPendingYield: pendingYield.toString(), totalReservedHollar: reserved.toString(),
    totalSettledBil: settledBil.toString(), totalQueuedBil: queuedBil.toString(), minRedeem: minRedeem.toString(),
    periodSec: Number(period), fixedApyWad: fixedApy.toString(), withdrawalDelaySec: Number(delay), decentralShutdown: shutdown !== 0n,
    supplyCapUbil: cfg.supplyCap.toString(), suppliedUbil: (wallet.get(BIL_ATOKEN) ?? 0n).toString(),
    maxLtvBps: cfg.ltvBps, liquidationThresholdBps: cfg.liquidationThresholdBps, hollarBorrowRateRay: borrowRate,
  }

  // The ladder: the logs' positions with each one's stored terms, checked twice over.
  const fromLogs = bilPositions(events, vault.periodSec)
  const termsRead = await readPositionTerms(call, fromLogs)
  let positions = termsRead ? withPositionTerms(fromLogs, termsByIndex) : null
  if (!termsRead) console.warn('[bil] a position\'s stored terms could not be read; ladder withheld')
  else if (!positions) console.warn('[bil] a stored position names another NFT or principal than its log; ladder withheld')
  if (positions) {
    const openPrincipal = positions.filter(x => x.state !== 'redeemed').reduce((s, x) => s + BigInt(x.principal), 0n)
    const rateSum = bilYieldRateSum(positions)
    if (openPrincipal !== invested || rateSum !== yieldRateSum) {
      console.warn(`[bil] open positions hold ${openPrincipal} principal at rate ${rateSum}, the vault states ${invested} at ${yieldRateSum}; ladder withheld`)
      positions = null
    }
  }

  const requests = bilRequests(events)
  const claims = bilControllerClaims(events)
  const chainRequests = await readChainRequests(call, requests, openRequestIds(requests, claims), vault)
  const beneficial = chainRequests ? bilBeneficialBalances({
    wallet,
    chain: chainRequests.map(r => ({ controller: r.controller, escrowShares: BigInt(r.escrowShares), settledShares: BigInt(r.settledShares), hollarOwed: BigInt(r.hollarOwed) })),
    exchangeRateWad: rate,
  }) : null
  if (chainRequests && !beneficial) console.warn(`[bil] attributed escrow exceeds the vault's uBIL at block ${pin.block}; beneficial balances withheld`)
  return { block: pin.block, readAt: Date.now(), vault, positions, requests, chainRequests, claims, bil, wallet, beneficial, events }
}

/** The rate the other processes price uBIL and BIL by (bil_vault_state, 019_bil.sql). */
async function publishVaultState(ch: ClickHouseClient, s: BilSnapshot): Promise<void> {
  await ch.insert({
    table: 'price_data.bil_vault_state', format: 'JSONEachRow',
    values: [{ vault: BIL_VAULT, share_asset_id: UBIL_ASSET_ID, collateral_asset_id: BIL_HOLLAR_ASSET_ID, wrapper_asset_ids: [BIL_ASSET_ID],
      block_height: s.block, exchange_rate_wad: s.vault.exchangeRateWad, total_assets: s.vault.totalAssets, total_supply: s.vault.totalSupply }],
  })
}

/** A snapshot older than this states no current figure (the refresher has stopped renewing it). */
export const BIL_SNAPSHOT_MAX_AGE_MS = 15 * 60_000
const refresher = createStrategyRefresher<BilSnapshot>({
  name: 'bil',
  // BIL's own logs, uBIL's deltas and BIL's scaled deltas.
  loadMark: ch => strategyChangeMark(ch, 'price_data.bil_logs', [BIL_VAULT],
    `(SELECT concat(toString(count()), ':', toString(max(ingested_at))) FROM price_data.atoken_scaled_deltas WHERE contract_address = '${BIL_ATOKEN}')`),
  read: readBilSnapshot,
  publish: publishVaultState,
  maxAgeMs: BIL_SNAPSHOT_MAX_AGE_MS,
})
export function initBilState(c: ClickHouseClient): void { refresher.init(c) }
export const refreshBilState = (): Promise<void> => refresher.refresh()
export const currentBilSnapshot = (nowMs = Date.now()): BilSnapshot | null => refresher.current(nowMs)
/** The beneficial uBIL balances to publish, and the block they are at. */
export function bilBeneficialFor(contract: string): { block: number; balances: Map<string, bigint> } | null {
  if (contract.toLowerCase() !== BIL_VAULT) return null
  const s = currentBilSnapshot()
  return s?.beneficial ? { block: s.block, balances: s.beneficial } : null
}
/** Test seam. */
export function setBilSnapshotForTest(s: BilSnapshot | null): void { refresher.setForTest(s) }
