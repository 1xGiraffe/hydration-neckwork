import type { ClickHouseClient } from '../db/client.ts'
import { loadPinnedBlock } from './pinnedBlock.ts'
import { makeTolerantEthCall, type TolerantEthCall } from './mmOraclePrices.ts'
import {
  DEAD_ADDRESS, HOLLAR_CONTRACT, JUICER_POOL, JUICER_SUBLOOP, JUICER_VAULTS, JUICER_YIELD_ACCOUNTING, PRIME_RESERVE,
  decodeJuicerLog, juicerBeneficialBalances, juicerRequests,
  type JuicerEvent, type JuicerLogRow, type JuicerRequest, type JuicerVaultDef,
} from './juicer.ts'

// The Juicer's CURRENT state at ONE pinned block (pinnedBlock.ts), held in memory and
// read by the coordinated background refresher (backgroundRefresh.ts) — never on a
// request path. Everything the index states is read from it at that block:
//  - the withdrawal requests' whole lifecycle and every setting with an event (the
//    delay, fee, discounts, band, headroom, pauses) from juicer_logs;
//  - the share token's wallet balances from its Transfer deltas;
//  - Main's and the loop's account data (getUserAccountData as the raw indexer
//    observed it) from money_market_latest_positions, HOLLAR's borrow rate from
//    money_market_reserve_rates.
// Only what no event states is an eth_call at the pinned block's hash: totalAssets,
// totalSupply and exchangeRate, the cap and the keepers' stops (depositsPaused,
// deficitStop, deleverTarget, the Main ledger's deploying round), the synthetic
// supplied and its oracle price, the collateral's and PRIME's reserve configuration,
// the loop's target health factor, and each current holder's funded earnings
// (balanceOf − walletOf).
//
// A cycle runs when juicer_logs or the share token's deltas moved, and on every 5th
// tick regardless (rates and prices move with no log). It is complete or it is not
// published: any read that fails keeps the previous snapshot whole.

const SEL = {
  totalAssets: '0x01e1d114', totalSupply: '0x18160ddd', exchangeRate: '0x3ba0b9a9', tvlCap: '0x3f23fa1a',
  depositsPaused: '0x60da3e83', deficitStop: '0x70f3af26', deleverTarget: '0x7b584abf', syntheticSupplied: '0x42a9b1a2',
  balanceOf: '0x70a08231', walletOf: '0x1982640c', decimals: '0x313ce567',
  activeSourceRemaining: '0x5033c9ef', pendingSourceAccounting: '0xd0e96d76',
  targetHf: '0x1c823eff', getConfiguration: '0xc44b11f7',
  addressesProvider: '0x0542975c', getPriceOracle: '0xfca513a8', getAssetPrice: '0xb3596f07',
}
const arg = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')
export function word(hex: string | null | undefined, i: number): bigint | null {
  if (!hex || hex.length < 2 + 64 * (i + 1)) return null
  return BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)))
}
const addr = (hex: string | null | undefined): string | null => {
  const w = word(hex, 0)
  return w == null ? null : '0x' + w.toString(16).padStart(40, '0')
}

export interface JuicerAccountData {
  /** Base currency (USD, 8 decimals) — Main's collateral includes the synthetic. */
  collateralBase: string
  debtBase: string
  /** WAD. */
  healthFactor: string
  blockHeight: number
}
export interface JuicerVaultState {
  vault: string
  totalAssets: string
  totalSupply: string
  exchangeRateWad: string
  tvlCap: string
  paused: boolean
  depositsPaused: boolean
  deficitStop: boolean
  deleverPending: boolean
  /** A Main borrowing round still deploying: deposit() reverts OutstandingDebt. */
  deploying: boolean
  withdrawalDelaySec: number | null
  /** Synthetic collateral supplied to Main and its value in base (USD, 8 decimals). */
  syntheticSupplied: string
  syntheticBase: string
  main: JuicerAccountData | null
  maxLtvBps: number
  liquidationThresholdBps: number
  band: { targetGapBps: number; releverGapBps: number; deleverGapBps: number } | null
  exitHeadroom: { enabled: boolean; gapBps: number } | null
  protocolFeeBps: number | null
  mainDiscountBps: number | null
  /** Wallet shares (Transfer deltas), funded earnings, and the beneficial balances (custody attributed). */
  wallet: Map<string, bigint>
  funded: Map<string, bigint>
  beneficial: Map<string, bigint>
  requests: JuicerRequest[]
}
export interface JuicerLoopState {
  subLoop: string
  /** WAD. */
  targetHf: string
  account: JuicerAccountData | null
  emergencyPaused: boolean
  /** HOLLAR's current variable borrow rate, ray (1e27). */
  hollarBorrowRateRay: string | null
  loopDiscountBps: number | null
  primeLiquidationThresholdBps: number
}
export interface JuicerSnapshot {
  block: number
  readAt: number
  vaults: JuicerVaultState[]
  loop: JuicerLoopState
  /** The decoded logs the snapshot was read with (every Juicer act up to `block`). */
  events: JuicerEvent[]
}

/** The latest setting each event states, in log order (the launch set them all). */
export function juicerSettings(events: readonly JuicerEvent[], vault: string) {
  let paused = false, emergencyPaused = false, withdrawalDelaySec: number | null = null, protocolFeeBps: number | null = null
  let mainDiscountBps: number | null = null, loopDiscountBps: number | null = null
  let band: JuicerVaultState['band'] = null, exitHeadroom: JuicerVaultState['exitHeadroom'] = null
  for (const e of [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex)) {
    if (e.contract === vault && (e.name === 'Paused' || e.name === 'Unpaused')) paused = e.paused === true
    else if (e.contract === vault && e.name === 'WithdrawalDelayUpdated' && e.delay != null) withdrawalDelaySec = e.delay
    else if (e.name === 'EmergencyPauseUpdated') emergencyPaused = e.paused === true
    else if (e.name === 'ProtocolFeeUpdated' && e.vault === vault && e.bps != null) protocolFeeBps = e.bps
    else if (e.name === 'DiscountBpsUpdated' && e.bps != null) mainDiscountBps = e.bps
    else if (e.name === 'LoopDiscountBpsUpdated' && e.bps != null) loopDiscountBps = e.bps
    else if (e.name === 'RebalanceBandSet' && e.vault === vault && e.band) band = { targetGapBps: e.band.target, releverGapBps: e.band.relever, deleverGapBps: e.band.delever }
    else if (e.name === 'ExitHeadroomSet' && e.vault === vault && e.headroom) exitHeadroom = e.headroom
  }
  return { paused, emergencyPaused, withdrawalDelaySec, protocolFeeBps, mainDiscountBps, loopDiscountBps, band, exitHeadroom }
}

let client: ClickHouseClient | null = null
let snapshot: JuicerSnapshot | null = null
let lastMark = ''
let ticks = 0
export function initJuicerState(c: ClickHouseClient): void { client = c }

async function select<T>(ch: ClickHouseClient, query: string, query_params: Record<string, unknown> = {}): Promise<T[]> {
  return (await ch.query({ query, query_params, format: 'JSONEachRow' })).json<T>()
}

/** Every Juicer log up to `block`, decoded. */
export async function loadJuicerEvents(ch: ClickHouseClient, block: number): Promise<JuicerEvent[]> {
  const rows = await select<JuicerLogRow>(ch, `SELECT block_height, event_index, extrinsic_index, toString(block_timestamp) AS ts, contract_address, topic0, topics, data
    FROM price_data.juicer_logs FINAL WHERE block_height <= {b:UInt32} ORDER BY block_height, event_index`, { b: block })
  return rows.map(decodeJuicerLog).filter((e): e is JuicerEvent => e != null)
}

async function loadWallet(ch: ClickHouseClient, contract: string, block: number): Promise<Map<string, bigint>> {
  const rows = await select<{ holder: string; balance: string }>(ch, `SELECT holder, toString(sum(balance_delta)) AS balance
    FROM price_data.erc20_transfer_deltas FINAL
    WHERE contract_address = {c:String} AND block_height <= {b:UInt32} AND holder != '0x0000000000000000000000000000000000000000'
    GROUP BY holder`, { c: contract, b: block })
  return new Map(rows.map(r => [r.holder.toLowerCase(), BigInt(r.balance)] as [string, bigint]).filter(([, v]) => v !== 0n))
}

async function loadAccountData(ch: ClickHouseClient, holders: string[], block: number): Promise<Map<string, JuicerAccountData>> {
  const rows = await select<{ holder: string; c: string; d: string; hf: string; b: number }>(ch, `SELECT user_address AS holder,
      toString(tupleElement(p, 'total_collateral_base')) AS c, toString(tupleElement(p, 'total_debt_base')) AS d,
      toString(tupleElement(p, 'health_factor')) AS hf, tupleElement(p, 'block_height') AS b
    FROM (SELECT user_address, argMaxMerge(position_state) AS p FROM price_data.money_market_latest_positions
          WHERE user_address IN {h:Array(String)} AND pool_address = {pool:String} GROUP BY user_address)`,
  { h: holders, pool: JUICER_POOL })
  // The latest observation, at or below the pin (an observation above it is newer than the rest of the snapshot).
  return new Map(rows.filter(r => Number(r.b) <= block).map(r => [r.holder.toLowerCase(), { collateralBase: r.c, debtBase: r.d, healthFactor: r.hf, blockHeight: Number(r.b) }]))
}

async function loadHollarRate(ch: ClickHouseClient, block: number): Promise<string | null> {
  const [r] = await select<{ rate: string }>(ch, `SELECT toString(variable_borrow_rate) AS rate FROM price_data.money_market_reserve_rates FINAL
    WHERE pool_address = {pool:String} AND reserve_address = {res:String} AND block_height <= {b:UInt32}
    ORDER BY block_height DESC, event_index DESC LIMIT 1`, { pool: JUICER_POOL, res: HOLLAR_CONTRACT, b: block })
  return r?.rate ?? null
}

/** The change mark a cycle compares: juicer_logs and the share tokens' deltas, rows and newest ingest. */
async function loadMark(ch: ClickHouseClient): Promise<string> {
  const [r] = await select<{ m: string }>(ch, `SELECT concat(
      (SELECT concat(toString(count()), ':', toString(max(ingested_at))) FROM price_data.juicer_logs), '|',
      (SELECT concat(toString(count()), ':', toString(max(ingested_at))) FROM price_data.erc20_transfer_deltas WHERE contract_address IN {cs:Array(String)})) AS m`,
  { cs: JUICER_VAULTS.map(v => v.vault) })
  return r?.m ?? ''
}

/** One vault at the pin, or null when any read it needs failed. */
async function readVault(ch: ClickHouseClient, call: TolerantEthCall, v: JuicerVaultDef, block: number, events: JuicerEvent[], accounts: Map<string, JuicerAccountData>): Promise<JuicerVaultState | null> {
  const to = v.vault
  const collateralReserve = '0x' + '0'.repeat(30) + '01' + v.collateralAssetId.toString(16).padStart(8, '0')
  const core = await call([
    { to, data: SEL.totalAssets }, { to, data: SEL.totalSupply }, { to, data: SEL.exchangeRate }, { to, data: SEL.tvlCap },
    { to, data: SEL.depositsPaused }, { to, data: SEL.deficitStop }, { to, data: SEL.deleverTarget }, { to, data: SEL.syntheticSupplied },
    { to: v.mainDebt, data: SEL.activeSourceRemaining }, { to: v.mainDebt, data: SEL.pendingSourceAccounting },
    { to: JUICER_POOL, data: SEL.getConfiguration + arg(collateralReserve) },
    { to: v.synthetic, data: SEL.decimals }, { to: JUICER_POOL, data: SEL.addressesProvider },
  ])
  const w = core.map(h => word(h, 0))
  if (w.some(x => x == null)) return null
  const [totalAssets, totalSupply, rate, cap, depPaused, deficit, delever, synth, remaining, pending, config, synthDec] = w as bigint[]
  const provider = addr(core[12])
  const [oracleHex] = provider ? await call([{ to: provider, data: SEL.getPriceOracle }]) : [null]
  const oracle = addr(oracleHex)
  const [priceHex] = oracle ? await call([{ to: oracle, data: SEL.getAssetPrice + arg(v.synthetic) }]) : [null]
  const synthPrice = word(priceHex, 0)
  if (synthPrice == null) return null

  const wallet = await loadWallet(ch, to, block)
  // Funded earnings, for the accounts that hold shares now (the custody accounts and
  // the locked bootstrap at the burn address hold none of their own).
  const holders = [...wallet.keys()].filter(h => (wallet.get(h) ?? 0n) > 0n && h !== to && h !== JUICER_YIELD_ACCOUNTING && h !== DEAD_ADDRESS)
  const reads = holders.length ? await call(holders.flatMap(h => [{ to, data: SEL.balanceOf + arg(h) }, { to, data: SEL.walletOf + arg(h) }])) : []
  const funded = new Map<string, bigint>()
  for (let i = 0; i < holders.length; i++) {
    const bal = word(reads[2 * i], 0), wal = word(reads[2 * i + 1], 0)
    if (bal == null || wal == null) return null
    if (bal > wal) funded.set(holders[i], bal - wal)
  }
  const requests = juicerRequests(events).filter(r => r.vault === to)
  const beneficial = juicerBeneficialBalances({ vault: to, wallet, funded, requests, exchangeRateWad: rate })
  if (!beneficial) {
    console.warn(`[juicer] vault ${to}: attributed custody exceeds the custody held at block ${block}; keeping the previous snapshot`)
    return null
  }
  const s = juicerSettings(events, to)
  return {
    vault: to, totalAssets: totalAssets.toString(), totalSupply: totalSupply.toString(), exchangeRateWad: rate.toString(), tvlCap: cap.toString(),
    paused: s.paused, depositsPaused: depPaused !== 0n, deficitStop: deficit !== 0n, deleverPending: delever > 0n,
    deploying: remaining !== 0n || pending !== 0n,
    withdrawalDelaySec: s.withdrawalDelaySec,
    syntheticSupplied: synth.toString(), syntheticBase: (synth * synthPrice / 10n ** synthDec).toString(),
    main: accounts.get(to) ?? null,
    maxLtvBps: Number(config & 0xffffn), liquidationThresholdBps: Number((config >> 16n) & 0xffffn),
    band: s.band, exitHeadroom: s.exitHeadroom, protocolFeeBps: s.protocolFeeBps, mainDiscountBps: s.mainDiscountBps,
    wallet, funded, beneficial, requests,
  }
}

/** One cycle: everything at one pinned block, or nothing (the previous snapshot stays). */
export async function readJuicerSnapshot(ch: ClickHouseClient): Promise<JuicerSnapshot | null> {
  const pin = await loadPinnedBlock(ch, undefined, 'juicer:pin')
  const call = makeTolerantEthCall({ blockHash: pin.ethBlockHash })
  const events = await loadJuicerEvents(ch, pin.block)
  const [accounts, rate, loopReads] = await Promise.all([
    loadAccountData(ch, [...JUICER_VAULTS.map(v => v.vault), JUICER_SUBLOOP], pin.block),
    loadHollarRate(ch, pin.block),
    call([{ to: JUICER_SUBLOOP, data: SEL.targetHf }, { to: JUICER_POOL, data: SEL.getConfiguration + arg(PRIME_RESERVE) }]),
  ])
  const targetHf = word(loopReads[0], 0), primeConfig = word(loopReads[1], 0)
  if (targetHf == null || primeConfig == null) return null
  const vaults: JuicerVaultState[] = []
  for (const v of JUICER_VAULTS) {
    const state = await readVault(ch, call, v, pin.block, events, accounts)
    if (!state) return null
    vaults.push(state)
  }
  const settings = juicerSettings(events, JUICER_VAULTS[0].vault)
  return {
    block: pin.block, readAt: Date.now(), vaults, events,
    loop: {
      subLoop: JUICER_SUBLOOP, targetHf: targetHf.toString(), account: accounts.get(JUICER_SUBLOOP) ?? null,
      emergencyPaused: settings.emergencyPaused, hollarBorrowRateRay: rate, loopDiscountBps: settings.loopDiscountBps,
      primeLiquidationThresholdBps: Number((primeConfig >> 16n) & 0xffffn),
    },
  }
}

/** The exchange rates the other processes price the share token by (juicer_vault_state, 018_juicer.sql). */
async function publishVaultState(ch: ClickHouseClient, s: JuicerSnapshot): Promise<void> {
  await ch.insert({
    table: 'price_data.juicer_vault_state', format: 'JSONEachRow',
    values: s.vaults.map(v => {
      const def = JUICER_VAULTS.find(d => d.vault === v.vault)!
      return { vault: v.vault, share_asset_id: def.shareAssetId, collateral_asset_id: def.collateralAssetId, block_height: s.block,
        exchange_rate_wad: v.exchangeRateWad, total_assets: v.totalAssets, total_supply: v.totalSupply }
    }),
  })
}

export async function refreshJuicerState(): Promise<void> {
  if (!client) return
  ticks++
  const mark = await loadMark(client)
  if (snapshot && mark === lastMark && ticks % 5 !== 0) return
  const next = await readJuicerSnapshot(client)
  if (!next) {
    console.warn('[juicer] a state read failed; keeping the previous snapshot')
    return
  }
  snapshot = next
  lastMark = mark
  await publishVaultState(client, next).catch(err => console.error('[juicer] vault state publish failed', err))
}

/** A snapshot older than this states no current figure (the refresher has stopped renewing it). */
export const JUICER_SNAPSHOT_MAX_AGE_MS = 15 * 60_000
export function currentJuicerSnapshot(nowMs = Date.now()): JuicerSnapshot | null {
  return snapshot && nowMs - snapshot.readAt <= JUICER_SNAPSHOT_MAX_AGE_MS ? snapshot : null
}
/** The beneficial share balances to publish for a vault's share token, and the block they are at. */
export function juicerBeneficialFor(contract: string): { block: number; balances: Map<string, bigint> } | null {
  const s = currentJuicerSnapshot()
  const v = s?.vaults.find(x => x.vault === contract.toLowerCase())
  return s && v ? { block: s.block, balances: v.beneficial } : null
}
/** Test seam. */
export function setJuicerSnapshotForTest(s: JuicerSnapshot | null): void { snapshot = s }
