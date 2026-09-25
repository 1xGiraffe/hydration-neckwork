import { createHash } from 'node:crypto'
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util'
import type { ApiPromise } from '@polkadot/api'
import type { ClickHouseClient } from '../db/client.ts'
import { blake2128Concat, storagePrefix, u128At, u32At, u32Le } from './chainPrimitives.ts'
import {
  entryReward, periodOf,
  type EntryReward, type FarmEntry, type FarmState, type GlobalFarmData, type LoyaltyCurve, type YieldFarmData,
} from './lmRewardMath.ts'
import { LM_BELOW_ED_UNPAYABLE, type LmPallet } from './lmRewardSnapshot.ts'
import { pendingNodeApi } from './pendingHeadService.ts'
import { canSkipRepublish } from './snapshotRepublish.ts'
import { rpc, substrateAllKeys, substrateStorageBatch } from './substrateRpc.ts'

// Current unclaimed liquidity-mining rewards: an in-memory read of chain state
// on the coordinated background refresher, published as a generation of
// `lm_reward_snapshots` that the account page and the Data API read by account.
//
// Why chain state and not events: an entry's `valued_shares` (its stake, fixed
// at entry from the EMA oracle) is storage-only, so no indexed row can restate
// its reward.
//
// One cycle, every read pinned to ONE finalized block hash so the deposits,
// farms and relay height describe a single chain state:
//  1. enumerate `Deposit` of both warehouse instances (OmnipoolWarehouseLM for
//     Omnipool farms, XYKWarehouseLM for XYK farms — Twox64Concat u128 keys) and
//     read their values; enumerate every `YieldFarm` (key: pool, global farm,
//     yield farm — three Blake2_128Concat parts) and `GlobalFarm`
//     (Blake2_128Concat u32);
//  2. the period the runtime would see: `ParachainSystem.ValidationData`'s
//     relay_parent_number (RelayChainBlockNumberProvider) ÷ the global farm's
//     blocks_per_period;
//  3. per ACTIVE yield farm not yet synced this period, ONE
//     `DryRunApi.dry_run_call(claim_rewards(deposit, yield farm))` signed by a
//     deposit owner: the runtime syncs the global and yield farm to the head
//     (price adjustment from its EMA oracle, capped by the farm account's
//     balance — inputs no pure function has) and emits the new
//     `accumulated_rpvs`. Every entry of that farm is then priced against it by
//     lmRewardMath. The dry-run's own `RewardClaimed` is checked against our
//     number for that entry: a disagreement discards the projection rather than
//     publishing arithmetic the runtime does not share.
//  Stopped farms need no projection (their rpvs is frozen), terminated ones pay
//  nothing.
//  4. per entry whose claimable is below the reward asset's existential deposit,
//     the owner's free balance of that asset (CurrenciesApi.free_balance, at the
//     same block): below the deposit too, the pallet pays the claim to the
//     treasury, so the entry publishes unpayable (below_ed = 2) and counts 0.
//
// Failure policy: any failed read (a key page, a value, the header) aborts the
// cycle and keeps the previous generation. A failed projection does NOT abort:
// that farm's entries publish their value as of the farm's last sync with
// `claimable_projected_raw` NULL, which every surface states as unprojected.
// Owners come from the indexed deposit NFTs (nft_owner_latest); a deposit the
// indexer has not seen yet is left for the next cycle and counted.

let client: ClickHouseClient | null = null

export function initLmRewardService(c: ClickHouseClient): void {
  client = c
}

interface PalletSpec {
  pallet: LmPallet
  storage: string            // warehouse storage pallet
  section: string            // polkadot-js query/event section of the warehouse
  callPallet: string         // the user-facing pallet whose claim_rewards takes the deposit NFT owner (metadata name)
  callSection: string        // …and its polkadot-js event section
  collection: string         // the deposit NFT collection
  poolKeyBytes: number       // AmmPoolId width: u32 asset id / AccountId32 pool account
}

export const LM_PALLETS: readonly PalletSpec[] = [
  { pallet: 'omnipool', storage: 'OmnipoolWarehouseLM', section: 'omnipoolWarehouseLM', callPallet: 'OmnipoolLiquidityMining', callSection: 'omnipoolLiquidityMining', collection: '2584', poolKeyBytes: 4 },
  { pallet: 'xyk', storage: 'XYKWarehouseLM', section: 'xykWarehouseLM', callPallet: 'XYKLiquidityMining', callSection: 'xykLiquidityMining', collection: '5389', poolKeyBytes: 32 },
]

const VALIDATION_DATA_KEY = storagePrefix('ParachainSystem', 'ValidationData')
const ASSET_REGISTRY_PREFIX = storagePrefix('AssetRegistry', 'Assets')

// ───────────────────────── storage keys ─────────────────────────

// Deposit: prefix(32) ++ twox64(8) ++ u128 LE(16).
export function depositIdFromKey(key: string): string {
  const b = hexToU8a(key)
  if (b.length !== 56) throw new Error(`unexpected Deposit key length ${b.length}`)
  return u128At(b, 40).toString()
}

// GlobalFarm: prefix(32) ++ blake2_128(16) ++ u32.
export function globalFarmIdFromKey(key: string): number {
  const b = hexToU8a(key)
  if (b.length !== 52) throw new Error(`unexpected GlobalFarm key length ${b.length}`)
  return u32At(b, 48)
}

// YieldFarm: prefix(32) ++ blake2_128(16) ++ pool ++ blake2_128(16) ++ u32 gf ++ blake2_128(16) ++ u32 yf.
export function yieldFarmKeyParts(key: string, poolKeyBytes: number): { poolKey: string; globalFarmId: number; yieldFarmId: number } {
  const b = hexToU8a(key)
  if (b.length !== 32 + 16 + poolKeyBytes + 16 + 4 + 16 + 4) throw new Error(`unexpected YieldFarm key length ${b.length}`)
  let off = 48
  const pool = b.slice(off, off + poolKeyBytes)
  off += poolKeyBytes + 16
  const globalFarmId = u32At(b, off)
  off += 4 + 16
  const yieldFarmId = u32At(b, off)
  return { poolKey: poolKeyBytes === 4 ? String(u32At(pool, 0)) : u8aToHex(pool), globalFarmId, yieldFarmId }
}

// ───────────────────────── decoded values → plain records ─────────────────────────
// polkadot-js `toPrimitive()` renders an integer as a number when it fits 2^53
// and as a decimal string otherwise; BigInt(String(v)) is exact either way.

type Prim = Record<string, unknown>
const bigOf = (v: unknown): bigint => {
  const s = String(v ?? '')
  if (!/^\d+$/.test(s)) throw new Error(`not an unsigned integer: ${s}`)
  return BigInt(s)
}
const numOf = (v: unknown): number => {
  const n = Number(bigOf(v))
  if (!Number.isSafeInteger(n)) throw new Error(`not a safe integer: ${String(v)}`)
  return n
}
const stateOf = (v: unknown): FarmState => {
  const s = String(v).toLowerCase()
  if (s === 'active' || s === 'stopped' || s === 'terminated') return s
  throw new Error(`unknown farm state ${String(v)}`)
}

export function farmEntryFromPrimitive(p: Prim): FarmEntry {
  return {
    globalFarmId: numOf(p.globalFarmId), yieldFarmId: numOf(p.yieldFarmId),
    valuedShares: bigOf(p.valuedShares), accumulatedRpvs: bigOf(p.accumulatedRpvs),
    accumulatedClaimedRewards: bigOf(p.accumulatedClaimedRewards),
    enteredAt: numOf(p.enteredAt), updatedAt: numOf(p.updatedAt), stoppedAtCreation: numOf(p.stoppedAtCreation),
  }
}

export interface DepositRecord { shares: bigint; entries: FarmEntry[] }
export function depositFromPrimitive(p: Prim): DepositRecord {
  const entries = p.yieldFarmEntries
  if (!Array.isArray(entries)) throw new Error('deposit without yield farm entries')
  return { shares: bigOf(p.shares), entries: entries.map(e => farmEntryFromPrimitive(e as Prim)) }
}

export function yieldFarmFromPrimitive(p: Prim): YieldFarmData {
  const curve = p.loyaltyCurve as Prim | null | undefined
  const loyaltyCurve: LoyaltyCurve | null = curve ? { initialRewardPercentage: bigOf(curve.initialRewardPercentage), scaleCoef: numOf(curve.scaleCoef) } : null
  return {
    id: numOf(p.id), updatedAt: numOf(p.updatedAt), totalShares: bigOf(p.totalShares), totalValuedShares: bigOf(p.totalValuedShares),
    accumulatedRpvs: bigOf(p.accumulatedRpvs), accumulatedRpz: bigOf(p.accumulatedRpz), loyaltyCurve,
    multiplier: bigOf(p.multiplier), state: stateOf(p.state), entriesCount: bigOf(p.entriesCount),
    leftToDistribute: bigOf(p.leftToDistribute), totalStopped: numOf(p.totalStopped),
  }
}

export function globalFarmFromPrimitive(p: Prim): GlobalFarmData {
  return {
    id: numOf(p.id), updatedAt: numOf(p.updatedAt), totalSharesZ: bigOf(p.totalSharesZ), accumulatedRpz: bigOf(p.accumulatedRpz),
    rewardCurrency: numOf(p.rewardCurrency), pendingRewards: bigOf(p.pendingRewards), accumulatedPaidRewards: bigOf(p.accumulatedPaidRewards),
    // Perquintill renders as its parts (1e18 = 100%), which is also its FixedU128 inner.
    yieldPerPeriod: bigOf(p.yieldPerPeriod), blocksPerPeriod: numOf(p.blocksPerPeriod), incentivizedAsset: numOf(p.incentivizedAsset),
    maxRewardPerPeriod: bigOf(p.maxRewardPerPeriod), priceAdjustment: bigOf(p.priceAdjustment), state: stateOf(p.state),
  }
}

// ───────────────────────── chain read ─────────────────────────

export interface LmDeposit { pallet: LmPallet; depositId: string; shares: bigint; entries: FarmEntry[] }
export interface LmYieldFarm { pallet: LmPallet; poolKey: string; globalFarmId: number; farm: YieldFarmData }
export interface LmChainState {
  blockHeight: number
  blockHash: string
  relayParentNumber: number
  deposits: LmDeposit[]
  /** Keyed `${pallet}:${globalFarmId}:${yieldFarmId}`. */
  yieldFarms: Map<string, LmYieldFarm>
  /** Keyed `${pallet}:${globalFarmId}`. */
  globalFarms: Map<string, GlobalFarmData>
  /** The deposit's pool, which a yield farm key needs; keyed `${pallet}:${depositId}`. */
  depositPools: Map<string, string>
  /** Existential deposit of each global farm's reward currency (AssetRegistry.Assets at the same block). */
  rewardEds: Map<number, bigint>
  /**
   * Storage values that were READ but could not be understood (an undecodable
   * or self-contradictory deposit/farm), one reason each. The rest of the cycle
   * still publishes; these entries are left out and counted, never valued.
   */
  inconsistent: string[]
}

export const farmKey = (pallet: LmPallet, globalFarmId: number, yieldFarmId: number): string => `${pallet}:${globalFarmId}:${yieldFarmId}`

type Decoration = Awaited<ReturnType<ApiPromise['at']>>

// Decode a storage value with the metadata of the block it was read at: the
// value type of the storage entry itself (by its lookup id), so the two
// warehouse instances — whose DepositData differs in the AmmPoolId width — can
// never be decoded with each other's layout.
function decodeValue(at: Decoration, section: string, item: string, hex: string): Prim {
  const entry = (at.query as unknown as Record<string, Record<string, { creator: { meta: { type: { isMap: boolean; asMap: { value: unknown }; isPlain: boolean; asPlain: unknown } } } }>>)[section]?.[item]
  if (!entry) throw new Error(`no storage ${section}.${item} in the runtime at this block`)
  const t = entry.creator.meta.type
  const typeId = t.isMap ? t.asMap.value : t.asPlain
  const registry = at.registry as unknown as { createLookupType(id: unknown): string; createType(type: string, value: Uint8Array): { toPrimitive(): unknown } }
  const decoded = registry.createType(registry.createLookupType(typeId), hexToU8a(hex)).toPrimitive()
  // Option<T> storage values decode to T directly (OptionQuery stores T).
  return decoded as Prim
}

async function readAll(prefix: string, at: string): Promise<{ keys: string[]; values: string[] }> {
  const keys = await substrateAllKeys(prefix, 50, 1000, at)
  const raw = await substrateStorageBatch(keys, at)
  const missing = raw.findIndex(v => v == null)
  // A key enumerated at this very block has a value at it; a null is a failed read.
  if (missing >= 0) throw new Error(`storage read failed for ${keys[missing]}`)
  return { keys, values: raw as string[] }
}

/**
 * The existential deposits of registered assets at block `hash` (AssetRegistry.Assets,
 * decoded with that block's metadata). Every asset asked for is registered, so a
 * missing value is a failed read and throws. Shared with the money-market incentive
 * refresher, whose sub-ED rule reads the same storage.
 */
export async function readExistentialDeposits(at: Decoration, hash: string, assetIds: number[]): Promise<Map<number, bigint>> {
  const ids = [...new Set(assetIds)].sort((a, b) => a - b)
  const values = await substrateStorageBatch(ids.map(id => u8aToHex(u8aConcat(hexToU8a(ASSET_REGISTRY_PREFIX), blake2128Concat(u32Le(id))))), hash)
  const out = new Map<number, bigint>()
  ids.forEach((id, i) => {
    const hex = values[i]
    if (!hex) throw new Error(`AssetRegistry.Assets read failed for asset ${id}`)
    out.set(id, bigOf(decodeValue(at, 'assetRegistry', 'assets', hex).existentialDeposit))
  })
  return out
}

export type { Decoration as ChainDecoration }

export async function readLmChainState(api: ApiPromise): Promise<{ state: LmChainState; at: Decoration }> {
  const hash = await rpc<string>('chain_getFinalizedHead', [])
  if (!hash) throw new Error('chain_getFinalizedHead failed')
  const header = await rpc<{ number: string }>('chain_getHeader', [hash])
  if (!header?.number) throw new Error('chain_getHeader failed')
  const at = await api.at(hash)
  const [validation] = await substrateStorageBatch([VALIDATION_DATA_KEY], hash)
  if (!validation) throw new Error('ParachainSystem.ValidationData read failed')
  const relayParentNumber = numOf(decodeValue(at, 'parachainSystem', 'validationData', validation).relayParentNumber)

  const deposits: LmDeposit[] = []
  const yieldFarms = new Map<string, LmYieldFarm>()
  const globalFarms = new Map<string, GlobalFarmData>()
  const depositPools = new Map<string, string>()
  const inconsistent: string[] = []
  // A value that does not decode, or contradicts its own key, is one entry's
  // problem — skipped and counted. A value that could not be READ aborts (readAll).
  const each = (what: string, fn: () => void): void => {
    try { fn() } catch (err) { inconsistent.push(`${what}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  for (const spec of LM_PALLETS) {
    const [dep, yf, gf] = await Promise.all([
      readAll(storagePrefix(spec.storage, 'Deposit'), hash),
      readAll(storagePrefix(spec.storage, 'YieldFarm'), hash),
      readAll(storagePrefix(spec.storage, 'GlobalFarm'), hash),
    ])
    dep.keys.forEach((key, i) => each(`${spec.pallet} deposit ${key}`, () => {
      const depositId = depositIdFromKey(key)
      const prim = decodeValue(at, spec.section, 'deposit', dep.values[i])
      const record = depositFromPrimitive(prim)
      const pool = prim.ammPoolId
      depositPools.set(`${spec.pallet}:${depositId}`, spec.poolKeyBytes === 4 ? String(numOf(pool)) : u8aToHex(at.registry.createType('AccountId32', String(pool)).toU8a()))
      deposits.push({ pallet: spec.pallet, depositId, ...record })
    }))
    yf.keys.forEach((key, i) => each(`${spec.pallet} yield farm ${key}`, () => {
      const parts = yieldFarmKeyParts(key, spec.poolKeyBytes)
      const farm = yieldFarmFromPrimitive(decodeValue(at, spec.section, 'yieldFarm', yf.values[i]))
      if (farm.id !== parts.yieldFarmId) throw new Error(`yield farm key/value id mismatch ${parts.yieldFarmId}/${farm.id}`)
      yieldFarms.set(farmKey(spec.pallet, parts.globalFarmId, parts.yieldFarmId), { pallet: spec.pallet, poolKey: parts.poolKey, globalFarmId: parts.globalFarmId, farm })
    }))
    gf.keys.forEach((key, i) => each(`${spec.pallet} global farm ${key}`, () => {
      const id = globalFarmIdFromKey(key)
      const farm = globalFarmFromPrimitive(decodeValue(at, spec.section, 'globalFarm', gf.values[i]))
      if (farm.id !== id) throw new Error(`global farm key/value id mismatch ${id}/${farm.id}`)
      globalFarms.set(`${spec.pallet}:${id}`, farm)
    }))
  }
  // The reward currencies' existential deposits, at the same block: a claim
  // below it is paid to the treasury unless the owner already holds that much
  // (`claim_rewards`' should_send_reward_to_treasury). Every reward currency
  // is a registered asset, so a missing value is a failed read and aborts.
  const rewardEds = await readExistentialDeposits(at, hash, [...globalFarms.values()].map(g => g.rewardCurrency))
  return {
    state: { blockHeight: Number(BigInt(header.number)), blockHash: hash, relayParentNumber, deposits, yieldFarms, globalFarms, depositPools, rewardEds, inconsistent },
    at,
  }
}

// ───────────────────────── head projection (DryRunApi) ─────────────────────────

export interface FarmProjection {
  /** The yield farm's accumulated_rpvs after the runtime's sync to the head. */
  rpvs: bigint
  /** The deposit the dry-run claimed for, and what the runtime paid it. */
  probeDepositId: string
  probeClaimed: bigint
}

export interface ProjectionOutcome {
  projections: Map<string, FarmProjection>
  /** Active farms needing a projection that got none this cycle, with the reason. */
  failures: Map<string, string>
  dryRuns: number
}

interface DryRunEvent { section: string; method: string; data: { toString(): string }[] }
interface DryRunExecution { isOk: boolean; asErr?: { error?: { isModule?: boolean; asModule?: unknown }; toString(): string } }

// `pallet.Error` for a module error (ZeroClaimedRewards, DoubleClaimInPeriod, …),
// else the error's own rendering — so a failed probe's log says why.
function dispatchErrorText(at: Decoration, execution: DryRunExecution): string {
  const err = execution.asErr
  if (!err) return 'unknown error'
  try {
    if (err.error?.isModule) {
      const meta = (at.registry as unknown as { findMetaError(m: unknown): { section: string; name: string } }).findMetaError(err.error.asModule)
      return `${meta.section}.${meta.name}`
    }
  } catch { /* fall through to the raw rendering */ }
  return err.toString()
}

/** The current period of a farm, as `get_current_period` computes it. */
export const currentPeriodOf = (state: Pick<LmChainState, 'relayParentNumber'>, gf: GlobalFarmData): number =>
  periodOf(state.relayParentNumber, gf.blocksPerPeriod)

/** Whether a yield farm's stored state is behind the head and so needs the runtime's projection. */
export function needsProjection(yf: LmYieldFarm, gf: GlobalFarmData, currentPeriod: number): boolean {
  return yf.farm.state === 'active' && yf.farm.updatedAt !== currentPeriod && yf.farm.entriesCount > 0n && gf.state === 'active'
}

/** An entry priced against a farm synced to `currentPeriod` at `rpvs`. */
export function projectedEntryReward(entry: FarmEntry, yf: YieldFarmData, currentPeriod: number, rpvs: bigint): EntryReward {
  return entryReward(entry, { ...yf, updatedAt: currentPeriod, accumulatedRpvs: rpvs }, rpvs)
}

const PROBES_PER_FARM = 3

// `claim_rewards(deposit_id: u128, yield_farm_id: u32)` built from the metadata
// of the block the dry-run executes at — the node connection's own `api.tx` is
// decorated once at connect and would carry a stale call index across a
// runtime upgrade.
function claimRewardsCall(at: Decoration, palletName: string, depositId: string, yieldFarmId: number): unknown {
  const registry = at.registry as unknown as {
    metadata: { pallets: Array<{ name: { toString(): string }; index: { toNumber(): number }; calls: { isSome: boolean; unwrap(): { type: unknown } } }> }
    lookup: { getSiType(id: unknown): { def: { asVariant: { variants: Array<{ name: { toString(): string }; index: { toNumber(): number }; fields: unknown[] }> } } } }
    createType(type: string, value: unknown): unknown
  }
  const pallet = registry.metadata.pallets.find(p => p.name.toString() === palletName)
  if (!pallet?.calls.isSome) throw new Error(`no ${palletName} calls in the runtime at this block`)
  const variant = registry.lookup.getSiType(pallet.calls.unwrap().type).def.asVariant.variants.find(v => v.name.toString() === 'claim_rewards')
  if (!variant || variant.fields.length !== 2) throw new Error(`no ${palletName}.claim_rewards(deposit_id, yield_farm_id) at this block`)
  return registry.createType('Call', { callIndex: [pallet.index.toNumber(), variant.index.toNumber()], args: { deposit_id: depositId, yield_farm_id: yieldFarmId } })
}

export { claimRewardsCall }

export async function projectActiveFarms(
  at: Decoration, state: LmChainState, owners: Map<string, string>,
): Promise<ProjectionOutcome> {
  const projections = new Map<string, FarmProjection>()
  const failures = new Map<string, string>()
  let dryRuns = 0
  const call = (at as unknown as { call: { dryRunApi?: { dryRunCall(origin: unknown, call: unknown, v: number): Promise<unknown> } } }).call.dryRunApi?.dryRunCall
  for (const [key, yf] of state.yieldFarms) {
    const gf = state.globalFarms.get(`${yf.pallet}:${yf.globalFarmId}`)
    if (!gf) throw new Error(`yield farm ${key} without its global farm`)
    const currentPeriod = currentPeriodOf(state, gf)
    if (!needsProjection(yf, gf, currentPeriod)) continue
    if (!call) { failures.set(key, 'DryRunApi unavailable'); continue }
    const spec = LM_PALLETS.find(p => p.pallet === yf.pallet)!
    // The largest entries first: a claim must pay a non-zero amount above the
    // reward asset's ED (a smaller one fails with ZeroClaimedRewards or goes to
    // the treasury), and must not repeat a claim made this period.
    const candidates = state.deposits
      .filter(d => d.pallet === yf.pallet && owners.has(`${d.pallet}:${d.depositId}`))
      .flatMap(d => d.entries.filter(e => e.yieldFarmId === yf.farm.id && e.globalFarmId === yf.globalFarmId && e.updatedAt !== currentPeriod).map(e => ({ d, e })))
      .sort((a, b) => (b.e.valuedShares > a.e.valuedShares ? 1 : b.e.valuedShares < a.e.valuedShares ? -1 : 0))
      .slice(0, PROBES_PER_FARM)
    if (!candidates.length) { failures.set(key, 'no claimable probe entry'); continue }
    let reason = 'every probe claim failed'
    for (const { d, e } of candidates) {
      dryRuns++
      try {
        const origin = at.registry.createType('HydradxRuntimeOriginCaller', { system: { Signed: owners.get(`${d.pallet}:${d.depositId}`) } })
        const res = await call(origin, claimRewardsCall(at, spec.callPallet, d.depositId, yf.farm.id), 4) as {
          isOk: boolean; asOk: { executionResult: DryRunExecution; emittedEvents: DryRunEvent[] }
        }
        if (!res.isOk) { reason = 'dry-run refused by the runtime API'; continue }
        if (!res.asOk.executionResult.isOk) { reason = `dry-run claim failed on deposit ${d.depositId}: ${dispatchErrorText(at, res.asOk.executionResult)}`; continue }
        const events = res.asOk.emittedEvents
        const synced = events.find(ev => ev.section === spec.section && ev.method === 'YieldFarmAccRPVSUpdated'
          && Number(ev.data[0].toString()) === yf.globalFarmId && Number(ev.data[1].toString()) === yf.farm.id)
        const claimedEv = events.find(ev => ev.section === spec.callSection && ev.method === 'RewardClaimed')
        if (!synced || !claimedEv) { reason = 'dry-run emitted no sync'; continue }
        const rpvs = bigOf(synced.data[2].toString())
        const claimed = bigOf(claimedEv.data[3].toString())
        const ours = projectedEntryReward(e, yf.farm, currentPeriod, rpvs).claimable
        if (ours !== claimed) {
          // Our arithmetic disagrees with the runtime's own claim: publish no
          // projection for this farm rather than a number the chain would not pay.
          reason = `projection self-check failed on deposit ${d.depositId}: runtime ${claimed}, computed ${ours}`
          break
        }
        projections.set(key, { rpvs, probeDepositId: d.depositId, probeClaimed: claimed })
        break
      } catch (err) {
        reason = `dry-run error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (!projections.has(key)) failures.set(key, reason)
  }
  return { projections, failures, dryRuns }
}

// ───────────────────────── rows ─────────────────────────

export interface LmRewardSnapshotRow {
  accountId: string
  pallet: LmPallet
  depositId: string
  yieldFarmId: number
  globalFarmId: number
  poolKey: string
  positionId: string
  lpAssetId: number | null
  rewardAssetId: number
  farmState: FarmState
  shares: bigint
  valuedShares: bigint
  rpvsEntry: bigint
  rpvsSettled: bigint
  rpvsProjected: bigint | null
  claimedRaw: bigint
  enteredAtPeriod: number
  farmUpdatedAtPeriod: number
  currentPeriod: number
  claimableSettledRaw: bigint
  claimableProjectedRaw: bigint | null
  maxRewardRaw: bigint
  forfeitRaw: bigint
  loyalty: bigint
  periods: number
  /** 0 < published claimable < the reward asset's existential deposit (see LmRewardRow.belowExistentialDeposit). */
  belowEd: boolean
  /**
   * A claim now pays the owner: false exactly when `belowEd` and the owner's free
   * balance of the reward asset at the snapshot block is below that deposit too
   * (see LmRewardRow.payable). buildLmRewardRows states true; withOwnerBalances
   * decides the below-ED rows.
   */
  payable: boolean
  snapshotBlock: number
}

/**
 * Every farm entry of every owned deposit, priced twice: against the stored
 * farm (`settled`, what a claim pays if no sync ran) and against the farm as
 * the head would leave it (`projected`) — the same state for a farm that
 * cannot accrue (stopped/terminated) or already synced this period, the
 * runtime's dry-run rpvs for an active one, NULL when that projection failed.
 * max/forfeit/loyalty/periods describe the state the published claimable uses.
 */
export function buildLmRewardRows(
  state: LmChainState,
  owners: Map<string, string>,
  projections: Map<string, FarmProjection>,
  omnipoolPositionByDeposit: Map<string, string>,
  xykLpByPool: Map<string, number>,
): { rows: LmRewardSnapshotRow[]; unowned: number; inconsistent: string[] } {
  const rows: LmRewardSnapshotRow[] = []
  const inconsistent: string[] = []
  let unowned = 0
  for (const d of state.deposits) {
    const accountId = owners.get(`${d.pallet}:${d.depositId}`)
    if (!accountId) { unowned++; continue }
    const poolKey = state.depositPools.get(`${d.pallet}:${d.depositId}`) ?? ''
    for (const e of d.entries) {
      const key = farmKey(d.pallet, e.globalFarmId, e.yieldFarmId)
      const yf = state.yieldFarms.get(key)
      const gf = state.globalFarms.get(`${d.pallet}:${e.globalFarmId}`)
      const ed = gf ? state.rewardEds.get(gf.rewardCurrency) : undefined
      // One entry the chain state cannot price (a farm it names is missing, or
      // the pallet's own arithmetic would refuse it) is skipped and counted —
      // never valued, and never a reason to withhold every other account's.
      if (!yf || !gf || ed == null) { inconsistent.push(`entry ${d.pallet}:${d.depositId}/${e.yieldFarmId} names missing farm ${key}`); continue }
      let currentPeriod: number
      let settled: EntryReward
      let projected: EntryReward | null
      let rpvsProjected: bigint | null = yf.farm.accumulatedRpvs
      try {
        currentPeriod = currentPeriodOf(state, gf)
        settled = entryReward(e, yf.farm)
        projected = settled
        if (needsProjection(yf, gf, currentPeriod)) {
          const p = projections.get(key)
          rpvsProjected = p ? p.rpvs : null
          projected = p ? projectedEntryReward(e, yf.farm, currentPeriod, p.rpvs) : null
        }
      } catch (err) {
        inconsistent.push(`entry ${d.pallet}:${d.depositId}/${e.yieldFarmId}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const used = projected ?? settled
      const claimable = projected ? projected.claimable : settled.claimable
      rows.push({
        accountId, pallet: d.pallet, depositId: d.depositId, yieldFarmId: e.yieldFarmId, globalFarmId: e.globalFarmId,
        poolKey,
        positionId: d.pallet === 'omnipool' ? omnipoolPositionByDeposit.get(d.depositId) ?? '' : '',
        lpAssetId: d.pallet === 'xyk' ? xykLpByPool.get(poolKey) ?? null : null,
        rewardAssetId: gf.rewardCurrency, farmState: yf.farm.state,
        shares: d.shares, valuedShares: e.valuedShares, rpvsEntry: e.accumulatedRpvs,
        rpvsSettled: yf.farm.accumulatedRpvs, rpvsProjected, claimedRaw: e.accumulatedClaimedRewards,
        enteredAtPeriod: e.enteredAt, farmUpdatedAtPeriod: yf.farm.updatedAt, currentPeriod,
        claimableSettledRaw: settled.claimable, claimableProjectedRaw: projected ? projected.claimable : null,
        maxRewardRaw: used.maxReward, forfeitRaw: used.forfeitIfWithdrawnNow, loyalty: used.loyalty, periods: used.periods,
        belowEd: claimable > 0n && claimable < ed,
        payable: true,
        snapshotBlock: state.blockHeight,
      })
    }
  }
  rows.sort((a, b) => a.accountId === b.accountId
    ? (a.pallet.localeCompare(b.pallet) || (BigInt(a.depositId) < BigInt(b.depositId) ? -1 : BigInt(a.depositId) > BigInt(b.depositId) ? 1 : 0) || a.yieldFarmId - b.yieldFarmId)
    : a.accountId.localeCompare(b.accountId))
  return { rows, unowned, inconsistent }
}

const nullableString = (v: bigint | number | null): string | null => (v == null ? null : v.toString())

// ───────────────────────── sub-ED payability ─────────────────────────

/** `${owner}|${rewardAssetId}` of every below-ED row: the owner balances withOwnerBalances needs. */
export function belowEdOwnerKeys(rows: LmRewardSnapshotRow[]): string[] {
  return [...new Set(rows.filter(r => r.belowEd).map(r => `${r.accountId}|${r.rewardAssetId}`))].sort()
}

/**
 * The pallet's own sub-ED rule applied to the rows (warehouse-liquidity-mining
 * claim_rewards: `rewards < ed && free_balance(reward_currency, who) < ed` sends
 * the reward to the treasury — `claim_rewards` then fails ZeroClaimedRewards and
 * a withdraw pays it away): a below-ED row whose owner's free balance of the
 * reward asset is below the asset's existential deposit is unpayable. Every
 * below-ED row's balance must be in `balances` (keyed like belowEdOwnerKeys);
 * a missing one throws, as any unread value does. Pure.
 */
export function withOwnerBalances(rows: LmRewardSnapshotRow[], balances: ReadonlyMap<string, bigint>, eds: ReadonlyMap<number, bigint>): LmRewardSnapshotRow[] {
  return rows.map(r => {
    if (!r.belowEd) return r.payable ? r : { ...r, payable: true }
    const key = `${r.accountId}|${r.rewardAssetId}`
    const balance = balances.get(key)
    const ed = eds.get(r.rewardAssetId)
    if (balance == null || ed == null) throw new Error(`no owner balance for below-ED entry ${r.pallet}:${r.depositId}/${r.yieldFarmId} (${key})`)
    return { ...r, payable: balance >= ed }
  })
}

type CurrenciesCall = { currenciesApi?: { freeBalance(assetId: number, who: string): Promise<{ toString(): string }> } }

/**
 * Each owner's free balance of a reward asset at the decorated block, through the
 * runtime's CurrenciesApi.free_balance — `Currencies::free_balance`, the very
 * MultiCurrency read the pallet's check makes, so HDX (System.Account), Tokens
 * assets and ERC-20 registry assets (the contract's balanceOf) all read one way.
 * Keys are belowEdOwnerKeys'. A failed read throws: an unread balance is not a zero one.
 */
export async function readOwnerFreeBalances(at: Decoration, keys: string[], concurrency = 8): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  if (!keys.length) return out
  const api = (at as unknown as { call: CurrenciesCall }).call.currenciesApi
  if (!api) throw new Error('CurrenciesApi unavailable in the runtime at this block')
  let next = 0
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++]
      const [who, asset] = key.split('|')
      out.set(key, bigOf((await api.freeBalance(Number(asset), who)).toString()))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker))
  return out
}

/** The stored `below_ed` code (lmRewardSnapshot LM_BELOW_ED_UNPAYABLE): 0, 1 payable, 2 unpayable. */
export const belowEdCode = (r: Pick<LmRewardSnapshotRow, 'belowEd' | 'payable'>): number => (!r.belowEd ? 0 : r.payable ? 1 : LM_BELOW_ED_UNPAYABLE)

// Checksummed form of one stored row: every column of lm_reward_snapshots
// except the generation's own identity (`snapshot_id`, `computed_at`).
export const lmRewardChecksumFields = (r: LmRewardSnapshotRow): string =>
  `${r.accountId}|${r.pallet}|${r.depositId}|${r.yieldFarmId}|${r.globalFarmId}|${r.poolKey}|${r.positionId}|${r.lpAssetId}|${r.rewardAssetId}|${r.farmState}|${r.shares}|${r.valuedShares}|${r.rpvsEntry}|${r.rpvsSettled}|${nullableString(r.rpvsProjected)}|${r.claimedRaw}|${r.enteredAtPeriod}|${r.farmUpdatedAtPeriod}|${r.currentPeriod}|${r.claimableSettledRaw}|${nullableString(r.claimableProjectedRaw)}|${r.maxRewardRaw}|${r.forfeitRaw}|${r.loyalty}|${r.periods}|${belowEdCode(r)}|${r.snapshotBlock}\n`

export async function persistLmRewardSnapshot(
  ch: ClickHouseClient, rows: LmRewardSnapshotRow[],
  meta: { blockHeight: number; blockHash: string; relayHeight: number; projectedFarms: number; unprojectedFarms: number },
): Promise<'republished' | 'unchanged'> {
  const checksum = createHash('sha256')
  for (const r of rows) checksum.update(lmRewardChecksumFields(r))
  const digest = checksum.digest('hex')
  if (await canSkipRepublish(ch, {
    dataTable: 'lm_reward_snapshots', stateTable: 'lm_reward_snapshot_state',
    rowCountColumn: 'row_count', checksum: digest, rowCount: rows.length,
  })) return 'unchanged'
  const snapshotId = String(Date.now())
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const batchSize = 5_000
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await ch.insert({
      table: 'price_data.lm_reward_snapshots',
      values: rows.slice(offset, offset + batchSize).map(r => ({
        snapshot_id: snapshotId, account_id: r.accountId, pallet: r.pallet, deposit_id: r.depositId,
        yield_farm_id: r.yieldFarmId, global_farm_id: r.globalFarmId, pool_key: r.poolKey, position_id: r.positionId,
        lp_asset_id: r.lpAssetId, reward_asset_id: r.rewardAssetId, farm_state: r.farmState,
        shares: r.shares.toString(), valued_shares: r.valuedShares.toString(), rpvs_entry: r.rpvsEntry.toString(),
        rpvs_settled: r.rpvsSettled.toString(), rpvs_projected: nullableString(r.rpvsProjected), claimed_raw: r.claimedRaw.toString(),
        entered_at_period: r.enteredAtPeriod, farm_updated_at_period: r.farmUpdatedAtPeriod, current_period: r.currentPeriod,
        claimable_settled_raw: r.claimableSettledRaw.toString(), claimable_projected_raw: nullableString(r.claimableProjectedRaw),
        max_reward_raw: r.maxRewardRaw.toString(), forfeit_raw: r.forfeitRaw.toString(), loyalty: r.loyalty.toString(),
        periods: r.periods, below_ed: belowEdCode(r), snapshot_block: r.snapshotBlock,
        computed_at: now,
      })),
      format: 'JSONEachRow',
    })
  }
  const verify = await ch.query({
    query: `SELECT count() AS c, uniqExact((account_id, pallet, deposit_id, yield_farm_id)) AS u
      FROM price_data.lm_reward_snapshots WHERE snapshot_id = {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  const counts = (await verify.json<{ c: string; u: string }>())[0]
  if (Number(counts?.c) !== rows.length || Number(counts?.u) !== rows.length) {
    throw new Error(`incomplete lm reward snapshot ${counts?.c ?? 0}/${rows.length}`)
  }
  // The pointer is written last, so a partial generation is never request-visible.
  await ch.insert({
    table: 'price_data.lm_reward_snapshot_state',
    values: [{
      snapshot_key: 'current', snapshot_id: snapshotId, row_count: rows.length,
      block_height: meta.blockHeight, block_hash: meta.blockHash, relay_height: meta.relayHeight,
      projected_farms: meta.projectedFarms, unprojected_farms: meta.unprojectedFarms,
      source_checksum: digest, computed_at: now,
    }],
    format: 'JSONEachRow',
  })
  const parts = await ch.query({
    query: `SELECT DISTINCT partition FROM system.parts
      WHERE database = 'price_data' AND table = 'lm_reward_snapshots' AND active AND partition != {snapshotId:String}`,
    query_params: { snapshotId }, format: 'JSONEachRow',
  })
  for (const row of await parts.json<{ partition: string }>()) {
    await ch.command({
      query: `ALTER TABLE price_data.lm_reward_snapshots DROP PARTITION {partition:String}`,
      query_params: { partition: row.partition },
    })
  }
  return 'republished'
}

// ───────────────────────── indexed joins ─────────────────────────

/** Current deposit-NFT owners, keyed `${pallet}:${depositId}` → lowercase hex AccountId32. */
export async function loadDepositOwners(ch: ClickHouseClient): Promise<Map<string, string>> {
  const res = await ch.query({
    query: `SELECT collection, item, argMaxMerge(owner) AS owner
      FROM price_data.nft_owner_latest WHERE collection IN ('2584', '5389')
      GROUP BY collection, item`,
    format: 'JSONEachRow',
  })
  const out = new Map<string, string>()
  for (const r of await res.json<{ collection: string; item: string; owner: string }>()) {
    if (!r.owner) continue
    const pallet = LM_PALLETS.find(p => p.collection === r.collection)?.pallet
    if (pallet) out.set(`${pallet}:${r.item}`, r.owner.toLowerCase())
  }
  return out
}

async function loadOmnipoolDepositPositions(ch: ClickHouseClient, depositIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!depositIds.length) return out
  const res = await ch.query({
    query: `SELECT deposit_id, argMaxMerge(position_id) AS position_id
      FROM price_data.farm_deposit_latest WHERE deposit_id IN {ids:Array(String)} GROUP BY deposit_id`,
    query_params: { ids: depositIds }, format: 'JSONEachRow',
  })
  for (const r of await res.json<{ deposit_id: string; position_id: string }>()) if (r.position_id) out.set(r.deposit_id, r.position_id)
  return out
}

async function loadXykLpByPool(ch: ClickHouseClient, pools: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!pools.length) return out
  const res = await ch.query({
    query: `SELECT pool_account, lp_asset_id FROM price_data.xyk_pool_registry FINAL WHERE pool_account IN {pools:Array(String)}`,
    query_params: { pools }, format: 'JSONEachRow',
  })
  for (const r of await res.json<{ pool_account: string; lp_asset_id: number }>()) out.set(r.pool_account.toLowerCase(), Number(r.lp_asset_id))
  return out
}

// ───────────────────────── the cycle ─────────────────────────

export interface LmRewardCycle {
  state: LmChainState
  rows: LmRewardSnapshotRow[]
  unowned: number
  /** Chain-state values and farm entries skipped as inconsistent (decode or pallet-arithmetic refusals). */
  inconsistent: string[]
  outcome: ProjectionOutcome
}

/** Read + project + price, with no write — the refresher's whole computation. */
export async function computeLmRewards(api: ApiPromise, ch: ClickHouseClient): Promise<LmRewardCycle> {
  const [{ state, at }, owners] = await Promise.all([readLmChainState(api), loadDepositOwners(ch)])
  const [positions, lpByPool, outcome] = await Promise.all([
    loadOmnipoolDepositPositions(ch, state.deposits.filter(d => d.pallet === 'omnipool').map(d => d.depositId)),
    loadXykLpByPool(ch, [...new Set(state.deposits.filter(d => d.pallet === 'xyk').map(d => state.depositPools.get(`xyk:${d.depositId}`) ?? ''))].filter(Boolean)),
    projectActiveFarms(at, state, owners),
  ])
  const built = buildLmRewardRows(state, owners, outcome.projections, positions, lpByPool)
  const balances = await readOwnerFreeBalances(at, belowEdOwnerKeys(built.rows))
  const rows = withOwnerBalances(built.rows, balances, state.rewardEds)
  return { state, rows, unowned: built.unowned, inconsistent: [...state.inconsistent, ...built.inconsistent], outcome }
}

async function refresh(): Promise<void> {
  const ch = client
  const api = pendingNodeApi()
  if (!ch || !api) {
    // The node connection (pendingHeadService) is not up yet; the next cycle
    // retries and the published generation stays as it was.
    console.info('[lm-rewards] skipped: node connection not ready')
    return
  }
  const t0 = Date.now()
  const { state, rows, unowned, inconsistent, outcome } = await computeLmRewards(api, ch)
  const result = await persistLmRewardSnapshot(ch, rows, {
    blockHeight: state.blockHeight, blockHash: state.blockHash, relayHeight: state.relayParentNumber,
    projectedFarms: outcome.projections.size, unprojectedFarms: outcome.failures.size,
  })
  console.info('[lm-rewards] snapshot', {
    block: state.blockHeight, rows: rows.length, deposits: state.deposits.length, unowned,
    projected: outcome.projections.size, dryRuns: outcome.dryRuns, ms: Date.now() - t0, result,
    ...(outcome.failures.size ? { unprojected: Object.fromEntries(outcome.failures) } : {}),
    ...(inconsistent.length ? { inconsistent: inconsistent.length, inconsistentSample: inconsistent.slice(0, 5) } : {}),
  })
}

let inflight: Promise<void> | null = null

// The coordinated scheduler (backgroundRefresh.ts) owns the cadence; this only
// collapses a re-entrant call onto the in-flight run. A thrown cycle keeps the
// published generation as it was.
export function refreshLmRewards(): Promise<void> {
  if (inflight) return inflight
  const run = refresh()
    .catch(err => console.error('[lm-rewards] refresh failed, keeping the previous snapshot', err))
    .finally(() => { if (inflight === run) inflight = null })
  inflight = run
  return run
}
