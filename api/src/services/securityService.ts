import type { ClickHouseClient } from '../db/client.ts'
import { xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aToHex, hexToU8a, u8aConcat } from '@polkadot/util'
import { substrateStorageBatch, substrateAllKeys, SUBSTRATE_RPC_URL } from './substrateRpc.ts'
import { cachedSwr } from './cache.ts'
import { nominalBlockMsMismatch, resolveParaBlockTime, type ResolvedBlockTime } from './blockTime.ts'
import { accountRef, ensurePrices, mmMarkets, parachainName, type AccountRef, type AssetRef, type PriceInfo } from './explorerService.ts'
import { assetDescriptor } from './explorerAssets.ts'
import { loadCurrentPools } from './poolService.ts'
import { resolveModuleError } from './runtimeErrorNames.ts'

// The Security dashboard: Hydration's circuit breakers, freezes and the origins
// that can lift them.
//
// The chain's safety machinery is four independent subsystems plus the pause
// filter, and each needs a different source:
//
//   1. Global withdraw limit (egress) — a chain-wide HDX cap over a decaying
//      6h window. Only readable from chain state, so it comes from the RPC
//      snapshot below.
//   2. Per-asset deposit fuses — every orml-tokens mint is measured against the
//      asset's registry `xcm_rate_limit` over a one-day period, which the
//      runtime expresses as a block count (14 400 blocks at today's 6s slot
//      time; see FUSE_PERIOD_BLOCKS). The limit is reconstructed from indexed
//      AssetRegistry events; the baseline and the lockdown state are chain state.
//   3. Omnipool per-block trade/liquidity limits — a fraction of the asset's
//      reserve at the block's first guarded touch. The fractions are chain state
//      (defaults when unset); the reserves come from the block snapshot.
//   4. Paused calls — TransactionPause emits an event on every state change, so
//      the ledger of pauses is exactly reconstructible from raw. Chain state is
//      still read as the authority, and the two are expected to agree.
//
// Everything historical (lockdowns, limit changes, tradability flips, breaker
// trips) is indexed and read from ClickHouse. The three intra-block accumulators
// the pallet keeps (`Allowed*PerAsset`) are cleared in `on_finalize`, so they are
// never visible at a block boundary and are deliberately not read.

let client: ClickHouseClient
export function initSecurityService(c: ClickHouseClient): void { client = c }

// ────────────────────────────────────────────────────────────────────────────
// MIGRATION-DAY ACTION — 2s block times
//
// The deposit fuse's period is `pallet_circuit_breaker::Config::Period = DAYS`
// (runtime/hydradx/src/assets.rs). `DAYS` is derived from MILLISECS_PER_BLOCK,
// so the 2s runtime upgrade silently REDEFINES it from 14 400 to 43 200 blocks
// with no storage or event change to notice.
//
// It is the ONE block-count constant this service cannot read: verified against
// the live runtime (spec 435), the CircuitBreaker pallet publishes only
// defaultMaxNetTradeVolumeLimitPerBlock, defaultMaxAddLiquidityLimitPerBlock and
// defaultMaxRemoveLiquidityLimitPerBlock — `Period` is not a metadata constant,
// unlike aura.slotDuration and gigaHdx.cooldownPeriod, which runtimeConstants.ts
// does read. So it is pinned here, and the pin is what has to move.
//
// ON THE DAY THE 2s RUNTIME GOES LIVE: set SECURITY_FUSE_PERIOD_BLOCKS=43200
// (or bump the default below and redeploy). Until the pin moves, every fuse
// whose period started more than 14 400 blocks ago is reported `expired` while
// it is still active, and its used/headroom figures read as a fresh period.
//
// checkFusePeriodPin() below turns that into a self-detecting tripwire: it runs
// on every security-state refresh (backgroundRefresh, 60s) and warns — at most
// hourly — when the runtime's slot time says this pin is wrong, or when it
// could not be verified at all.
// ────────────────────────────────────────────────────────────────────────────
const DEFAULT_FUSE_PERIOD_BLOCKS = 14_400
export function parseFusePeriodBlocks(raw: string | undefined): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_FUSE_PERIOD_BLOCKS
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.error(`[security] SECURITY_FUSE_PERIOD_BLOCKS must be a positive integer, received ${JSON.stringify(raw)}; keeping ${DEFAULT_FUSE_PERIOD_BLOCKS}`)
    return DEFAULT_FUSE_PERIOD_BLOCKS
  }
  return n
}
const FUSE_PERIOD_BLOCKS = parseFusePeriodBlocks(process.env.SECURITY_FUSE_PERIOD_BLOCKS)

// The pin's tripwire, as a pure function over a resolved block time: `Period =
// DAYS` means one day's worth of blocks at the runtime's NOMINAL slot time, so
// the pin is correct exactly when it equals 86 400 000 / MILLISECS_PER_BLOCK.
// That is an equality, not a tolerance, which is why elastic scaling cannot
// raise a false alarm — today's chain runs ~7% more blocks per day than the pin
// and still resolves to the same 6000ms slot.
//
// Three outcomes, deliberately distinct:
//   null                  the pin is verified correct;
//   "PIN UNVERIFIED"      neither metadata nor a usable measurement was
//                         available, so nothing is known — NOT the same as
//                         "matches", and the caller retries next refresh;
//   "PIN IS STALE"        the runtime's slot time says the pin is wrong.
export function fusePeriodPinWarning(pinBlocks: number, resolved: ResolvedBlockTime): string | null {
  if (resolved.source === 'held' && resolved.measuredMs == null) {
    return `[security] FUSE PERIOD PIN UNVERIFIED: runtime metadata is unavailable and the chain could not be measured, `
      + `so the pinned ${pinBlocks}-block fuse period could not be checked against the runtime. Retrying on the next refresh.`
  }
  const expected = Math.round(86_400_000 / resolved.nominalMs)
  const origin = resolved.source === 'metadata'
    ? 'runtime metadata reports a slot time of'
    : `the chain measures ${Math.round(resolved.measuredMs ?? resolved.nominalMs)}ms/block against a slot time of`
  if (expected === pinBlocks) {
    // A held resolution with an out-of-band sample still matches the pin, but
    // the sample itself is worth surfacing once: it is how a stall looks.
    const anomaly = resolved.measuredMs == null ? null : nominalBlockMsMismatch(resolved.measuredMs)
    return resolved.source === 'held' && anomaly
      ? `[security] fuse period pin ${pinBlocks} still matches the runtime, but ${anomaly}`
      : null
  }
  return `[security] FUSE PERIOD PIN IS STALE: ${origin} ${resolved.nominalMs}ms, `
    + `so pallet_circuit_breaker's Period = DAYS is now ${expected} blocks, not the pinned ${pinBlocks}. `
    + `Every deposit fuse verdict is wrong until SECURITY_FUSE_PERIOD_BLOCKS=${expected} is set.`
}

// Log at most once an hour: the condition is a standing one (it stays true
// until an operator re-pins and redeploys), and the check runs every 60s.
const FUSE_PIN_LOG_INTERVAL_MS = 3_600_000
let lastFusePinLogAt = 0
export function shouldLogFusePinWarning(nowMs: number, lastLoggedAt: number): boolean {
  return lastLoggedAt === 0 || nowMs - lastLoggedAt >= FUSE_PIN_LOG_INTERVAL_MS
}

// Runs on every security-state refresh. Best effort: it must never be able to
// fail the refresh it rides on, and a fuse verdict is still served (with the
// pin as it stands) either way.
async function checkFusePeriodPin(): Promise<void> {
  try {
    const warning = fusePeriodPinWarning(FUSE_PERIOD_BLOCKS, await resolveParaBlockTime(client))
    if (!warning) return
    const now = Date.now()
    if (!shouldLogFusePinWarning(now, lastFusePinLogAt)) return
    lastFusePinLogAt = now
    console.warn(warning)
  } catch (err) {
    console.warn('[security] fuse period pin check failed', err)
  }
}

// Hydration's reference currency for the global withdraw limit is HDX.
const HDX_DECIMALS = 12
// The Omnipool hub asset is exempt from every per-block limit and cannot have one.
const HUB_ASSET_ID = 1
// Runtime defaults: (5000, 10000) net trade volume and Some((500, 10000)) for
// both liquidity directions (runtime/hydradx/src/assets.rs).
const DEFAULT_TRADE_LIMIT: Rational = [5_000, 10_000]
const DEFAULT_LIQUIDITY_LIMIT: Rational = [500, 10_000]
const CIRCUIT_BREAKER_PALLET_INDEX = 65

export type Rational = [number, number]

const prefix = (p: string, s: string) => u8aToHex(u8aConcat(xxhashAsU8a(p, 128), xxhashAsU8a(s, 128)))
const CB = (item: string) => prefix('CircuitBreaker', item)

const u32Le = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
const twox64Concat = (b: Uint8Array) => u8aConcat(xxhashAsU8a(b, 64), b)

function u32At(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
}
function uintAt(b: Uint8Array, off: number, bytes: number): bigint {
  let n = 0n
  for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i])
  return n
}
const u64At = (b: Uint8Array, off: number) => uintAt(b, off, 8)
const u128At = (b: Uint8Array, off: number) => uintAt(b, off, 16)

// pure decoders (unit-tested)

// `GlobalWithdrawLimitParameters { limit: Balance, window: Moment }` — u128 then
// u64 milliseconds.
export function decodeWithdrawConfig(hex: string): { limitRaw: bigint; windowMs: number } | null {
  const b = hexToU8a(hex)
  if (b.length < 24) return null
  return { limitRaw: u128At(b, 0), windowMs: Number(u64At(b, 16)) }
}

// `WithdrawLimitAccumulator = (Balance, Moment)`.
export function decodeWithdrawAccumulator(hex: string): { valueRaw: bigint; lastUpdateMs: number } | null {
  const b = hexToU8a(hex)
  if (b.length < 24) return null
  return { valueRaw: u128At(b, 0), lastUpdateMs: Number(u64At(b, 16)) }
}

// The pallet's linear decay, replayed at `nowMs`: the accumulator drains to zero
// over one window, and the drain is skipped entirely while a lockdown is armed
// (`try_to_decay_withdraw_limit_accumulator`). Idempotent at a fixed `nowMs`.
export function decayedAccumulator(valueRaw: bigint, lastUpdateMs: number, nowMs: number, windowMs: number, lockedDown: boolean): bigint {
  if (lockedDown || windowMs <= 0) return valueRaw
  const dt = Math.max(0, nowMs - lastUpdateMs)
  const capped = BigInt(Math.min(dt, windowMs))
  const decay = (valueRaw * capped) / BigInt(windowMs)
  return valueRaw > decay ? valueRaw - decay : 0n
}

export type LockdownState =
  | { kind: 'locked'; untilBlock: number }
  | { kind: 'unlocked'; periodStartBlock: number; baselineRaw: bigint }

// `LockdownStatus<BlockNumber, Balance>`: variant 0 `Locked(BlockNumber)`,
// variant 1 `Unlocked((BlockNumber, Balance))`.
export function decodeLockdownState(hex: string): LockdownState | null {
  const b = hexToU8a(hex)
  if (b.length < 5) return null
  if (b[0] === 0) return { kind: 'locked', untilBlock: u32At(b, 1) }
  if (b[0] === 1 && b.length >= 21) return { kind: 'unlocked', periodStartBlock: u32At(b, 1), baselineRaw: u128At(b, 5) }
  return null
}

// `(u32, u32)` — the limit rational. Both parts are capped at MAX_LIMIT_VALUE
// (10 000) and must be non-zero, so a zero denominator means a bad read.
export function decodeRational(hex: string): Rational | null {
  const b = hexToU8a(hex)
  if (b.length < 8) return null
  const den = u32At(b, 4)
  return den > 0 ? [u32At(b, 0), den] : null
}

// `Option<(u32, u32)>` under ValueQuery: a stored `None` means the limit is
// DISABLED for that asset, which is different from no entry at all (the default
// applies). Returns `undefined` for a malformed read so the caller can fall back.
export function decodeOptionalRational(hex: string): Rational | null | undefined {
  const b = hexToU8a(hex)
  if (!b.length) return undefined
  if (b[0] === 0) return null
  return b.length >= 9 ? decodeRational(u8aToHex(b.slice(1))) ?? undefined : undefined
}

// `PausedTransactions` key: twox64(SCALE (BoundedVec<u8>, BoundedVec<u8>)) ++ the
// same SCALE bytes. Both names are compact-prefixed ASCII.
export function decodePausedKey(storageKey: string): { pallet: string; call: string } | null {
  const b = hexToU8a(storageKey)
  // 32B pallet+item twox128 prefix, then 8B twox64 of the concatenated key.
  if (b.length < 42) return null
  let off = 40
  const readName = (): string | null => {
    if (off >= b.length) return null
    const len = b[off] >> 2 // names are far below 64 bytes, so the 1-byte compact form always applies
    off += 1
    if (off + len > b.length) return null
    const s = Buffer.from(b.slice(off, off + len)).toString('utf8')
    off += len
    return s
  }
  const pallet = readName()
  const call = readName()
  return pallet && call ? { pallet, call } : null
}

// Blake2_128Concat single-map key tail → the u32 it hashed.
export function assetIdFromBlakeKey(storageKey: string): number | null {
  const b = hexToU8a(storageKey)
  return b.length >= 52 ? u32At(b, 48) : null
}

// One asset's fuse verdict, exactly as the pallet's `classify_state` would read
// it at `headBlock`. `usedRaw` is the issuance minted since the period baseline;
// the pallet saturates a net burn to zero, so headroom is never more than the
// limit (a bug the reference dashboard has).
export interface FuseVerdict {
  status: 'locked' | 'expired' | 'active' | 'unarmed'
  usedRaw: bigint
  headroomRaw: bigint
  usagePct: number
  untilBlock: number | null
  periodEndBlock: number | null
}
export function classifyFuse(limitRaw: bigint, state: LockdownState | undefined, issuanceRaw: bigint | undefined, headBlock: number): FuseVerdict {
  if (state?.kind === 'locked' && state.untilBlock > headBlock) {
    return { status: 'locked', usedRaw: limitRaw, headroomRaw: 0n, usagePct: 100, untilBlock: state.untilBlock, periodEndBlock: null }
  }
  // A `Locked` row whose block has passed, or no row at all: the first
  // under-limit mint re-baselines the period, so the full limit is available.
  if (!state || state.kind === 'locked') {
    return { status: state ? 'expired' : 'unarmed', usedRaw: 0n, headroomRaw: limitRaw, usagePct: 0, untilBlock: null, periodEndBlock: null }
  }
  const periodEndBlock = state.periodStartBlock + FUSE_PERIOD_BLOCKS
  if (periodEndBlock <= headBlock) {
    return { status: 'expired', usedRaw: 0n, headroomRaw: limitRaw, usagePct: 0, untilBlock: null, periodEndBlock }
  }
  if (issuanceRaw == null) {
    return { status: 'active', usedRaw: 0n, headroomRaw: limitRaw, usagePct: 0, untilBlock: null, periodEndBlock }
  }
  const used = issuanceRaw > state.baselineRaw ? issuanceRaw - state.baselineRaw : 0n
  const capped = used > limitRaw ? limitRaw : used
  return {
    status: 'active',
    usedRaw: used,
    headroomRaw: limitRaw - capped,
    usagePct: limitRaw > 0n ? Number((capped * 1_000_000_000n) / limitRaw) / 10_000_000 : 0,
    untilBlock: null,
    periodEndBlock,
  }
}

// `calculate_limit(liquidity, (num, den)) = liquidity * num / den`, floored, in
// raw units — the same integer arithmetic the pallet uses.
export function allowanceFor(reserveRaw: bigint, limit: Rational | null): bigint | null {
  if (!limit) return null
  return (reserveRaw * BigInt(limit[0])) / BigInt(limit[1])
}
export const rationalPct = (limit: Rational): number => (limit[0] / limit[1]) * 100

// chain snapshot

interface ChainSnapshot {
  headBlock: number
  nowMs: number
  // The per-asset deposit limits this snapshot was taken against, so the response
  // never re-reads them and can never pair a limit with a mismatched baseline.
  limits: Map<number, bigint>
  withdraw: { limitRaw: bigint; windowMs: number; accumulatorRaw: bigint; lastUpdateMs: number; lockdownUntilMs: number | null } | null
  lockdowns: Map<number, LockdownState>
  issuance: Map<number, bigint>
  tradeLimits: Map<number, Rational>
  addLimits: Map<number, Rational | null>
  removeLimits: Map<number, Rational | null>
  egressAccounts: string[]
  localCategoryAssets: number[]
  externalCategoryCount: number
  paused: { pallet: string; call: string }[]
  hubTradability: number
  nearNonEmode: Map<string, { count: number; debtUsd: number }>
  takenAt: number
}

let snapshot: ChainSnapshot | null = null
let refreshInFlight: Promise<void> | null = null
// Advanced by every successful refresh. Passed to the response cache as its
// generation so a new snapshot supersedes the cached payload immediately while
// the previous one keeps being served until the rebuild lands.
let snapshotGeneration = 0

// Every asset that currently declares an `xcm_rate_limit`, reconstructed from the
// registry's own events: `Registered`/`Updated` both carry the asset's full state,
// so the newest event per asset IS the current registry entry. Verified against
// live chain state for all 59 limited assets.
async function loadRegistryLimits(): Promise<Map<number, bigint>> {
  const res = await client.query({
    query: `SELECT asset_id, xcm_rate_limit
            FROM (
              SELECT JSONExtractInt(args_json, 'assetId') AS asset_id,
                     JSONExtractString(args_json, 'xcmRateLimit') AS xcm_rate_limit,
                     row_number() OVER (PARTITION BY asset_id ORDER BY block_height DESC, event_index DESC) AS rn
              FROM price_data.raw_events
              WHERE event_name IN ('AssetRegistry.Registered', 'AssetRegistry.Updated')
            )
            WHERE rn = 1 AND xcm_rate_limit != '' AND xcm_rate_limit != 'null'`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ asset_id: number; xcm_rate_limit: string }>()
  const out = new Map<number, bigint>()
  for (const r of rows) {
    try {
      const limit = BigInt(r.xcm_rate_limit)
      if (limit > 0n) out.set(Number(r.asset_id), limit)
    } catch { /* non-numeric payload — the asset simply has no readable limit */ }
  }
  return out
}

interface NearRow { pool: string; user_address: string; debt_usd: number }
async function loadNearNonEmode(): Promise<Map<string, { count: number; debtUsd: number }>> {
  const debt = `tupleElement(pos, 'total_debt_base')`
  const hf = `tupleElement(pos, 'health_factor')`
  const res = await client.query({
    query: `
      WITH p AS (
        SELECT user_address, lower(pool_address) AS pool, argMaxMerge(position_state) AS pos
        FROM price_data.money_market_latest_positions
        GROUP BY user_address, pool
      )
      SELECT pool, user_address, toFloat64(${debt}) / ${MM_BASE} AS debt_usd
      FROM p
      WHERE ${debt} > 0 AND ${hf} BETWEEN ${HF_ONE} AND ${HF_NEAR}`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<NearRow>()
  const byPool = new Map<string, NearRow[]>()
  for (const r of rows) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(r.user_address)) continue
    const list = byPool.get(r.pool) ?? []
    list.push(r)
    byPool.set(r.pool, list)
  }
  const out = new Map<string, { count: number; debtUsd: number }>()
  // Only the band itself is checked — a few dozen calls, not every borrower.
  for (const [pool, list] of byPool) {
    const users = list.map(r => r.user_address)
    const [emode, userConfig, isolationReserve] = await Promise.all([
      ethCallPerUser(pool, USER_EMODE_SELECTOR, users, word => (word === 0n ? null : true)),
      ethCallPerUser(pool, USER_CONFIG_SELECTOR, users, word => word),
      readIsolationReserves(pool),
    ])
    const directional = list.filter(r => {
      const key = r.user_address.toLowerCase()
      if (emode.has(key)) return false
      const bitmap = userConfig.get(key)
      return bitmap == null || !isolationModeCollateral(bitmap, isolationReserve)
    })
    out.set(pool, { count: directional.length, debtUsd: directional.reduce((sum, r) => sum + r.debt_usd, 0) })
  }
  // A market with nobody in the band still gets an entry, so "0" is distinguishable
  // from "not measured".
  for (const m of mmMarkets()) if (!out.has(m.poolProxy)) out.set(m.poolProxy, { count: 0, debtUsd: 0 })
  return out
}

// Enumerate a small map and decode each (key, value) pair. Every map read here is
// tens of entries (the largest, AssetLockdownState, is ~54), so a full
// enumeration per refresh is a handful of RPC calls.
// One batched eth_call per chunk, same shape as the ERC-20 balance refresher.
// `decode` turns a raw word into a value, or null to skip the entry.
async function ethCallPerUser<T>(pool: string, selector: string, users: string[], decode: (word: bigint) => T | null): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  for (let start = 0; start < users.length; start += EMODE_BATCH) {
    const chunk = users.slice(start, start + EMODE_BATCH)
    const body = chunk.map((user, id) => ({
      jsonrpc: '2.0', id, method: 'eth_call',
      params: [{ to: pool, data: `${selector}${'0'.repeat(24)}${user.slice(2).toLowerCase()}` }, 'latest'],
    }))
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`eth_call ${selector} failed: ${res.status}`)
      for (const item of await res.json() as { id?: number; result?: unknown }[]) {
        if (!Number.isInteger(item?.id) || typeof item.result !== 'string') continue
        const value = decode(BigInt(item.result))
        if (value !== null) out.set(chunk[item.id as number].toLowerCase(), value)
      }
    } finally { clearTimeout(timer) }
  }
  return out
}

// Which reserves of this pool carry a debt ceiling, by their index in the reserve
// list — the index the user configuration bitmap is keyed on.
async function readIsolationReserves(pool: string): Promise<boolean[]> {
  const call = async (data: string) => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: pool, data }, 'latest'] }) })
      const json = await res.json() as { result?: unknown }
      if (typeof json.result !== 'string') throw new Error(`eth_call ${data.slice(0, 10)} returned no result`)
      return json.result
    } finally { clearTimeout(timer) }
  }
  const listRaw = await call(RESERVES_LIST_SELECTOR)
  const count = Number(BigInt('0x' + listRaw.slice(66, 130)))
  const reserves = Array.from({ length: count }, (_, i) => '0x' + listRaw.slice(130 + i * 64 + 24, 130 + (i + 1) * 64))
  return Promise.all(reserves.map(async reserve => {
    const config = BigInt(await call(`${RESERVE_CONFIG_SELECTOR}${'0'.repeat(24)}${reserve.slice(2)}`))
    return ((config >> DEBT_CEILING_SHIFT) & ((1n << DEBT_CEILING_BITS) - 1n)) > 0n
  }))
}

// A position whose only collateral is a debt-ceilinged reserve is in isolation mode.
export function isolationModeCollateral(bitmap: bigint, isolationReserve: boolean[]): boolean {
  let only: number | null = null
  for (let i = 0; i < isolationReserve.length; i++) {
    if (((bitmap >> BigInt(i * 2 + 1)) & 1n) === 0n) continue
    if (only !== null) return false
    only = i
  }
  return only !== null && isolationReserve[only]
}

async function readAssetMap<T>(prefixHex: string, decode: (hex: string) => T | null | undefined): Promise<Map<number, T>> {
  const keys = await substrateAllKeys(prefixHex)
  const out = new Map<number, T>()
  if (!keys.length) return out
  const values = await substrateStorageBatch(keys)
  for (let i = 0; i < keys.length; i++) {
    const assetId = assetIdFromBlakeKey(keys[i])
    const raw = values[i]
    if (assetId == null || !raw) continue
    const decoded = decode(raw)
    if (decoded !== undefined) out.set(assetId, decoded as T)
  }
  return out
}

// Refreshes the in-memory chain snapshot. Runs on the coordinated background
// refresher alongside the other node-full readers; a failure leaves the previous
// snapshot in place and the response marks it with its own timestamp.
export async function refreshSecurityChainState(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const [limits, nearNonEmode] = await Promise.all([loadRegistryLimits(), loadNearNonEmode()])
    const limitedAssets = [...limits.keys()].sort((a, b) => a - b)

    const plainKeys = [
      prefix('System', 'Number'),
      prefix('Timestamp', 'Now'),
      CB('GlobalWithdrawLimitConfig'),
      CB('WithdrawLimitAccumulator'),
      CB('WithdrawLockdownUntil'),
      prefix('Omnipool', 'HubAssetTradability'),
      prefix('Balances', 'TotalIssuance'),
    ]
    // orml-tokens keys its currency maps with Twox64Concat.
    const issuancePrefix = prefix('Tokens', 'TotalIssuance')
    const issuanceKeys = limitedAssets
      .filter(id => id !== 0)
      .map(id => issuancePrefix + u8aToHex(twox64Concat(u32Le(id))).slice(2))

    const [plain, issuanceRaw, lockdowns, tradeLimits, addLimits, removeLimits, egressKeys, categories, pausedKeys] = await Promise.all([
      substrateStorageBatch(plainKeys),
      substrateStorageBatch(issuanceKeys),
      readAssetMap(CB('AssetLockdownState'), decodeLockdownState),
      readAssetMap(CB('TradeVolumeLimitPerAsset'), decodeRational),
      readAssetMap<Rational | null>(CB('LiquidityAddLimitPerAsset'), decodeOptionalRational),
      readAssetMap<Rational | null>(CB('LiquidityRemoveLimitPerAsset'), decodeOptionalRational),
      substrateAllKeys(CB('EgressAccounts')),
      readAssetMap(CB('GlobalAssetOverrides'), hex => { const b = hexToU8a(hex); return b.length ? (b[0] === 1 ? 'local' : 'external') : null }),
      substrateAllKeys(prefix('TransactionPause', 'PausedTransactions')),
    ])

    const headBlock = plain[0] ? u32At(hexToU8a(plain[0]), 0) : 0
    if (!headBlock) throw new Error('security snapshot: System.Number unreadable')
    const nowMs = plain[1] ? Number(u64At(hexToU8a(plain[1]), 0)) : Date.now()
    const config = plain[2] ? decodeWithdrawConfig(plain[2]) : null
    const accumulator = plain[3] ? decodeWithdrawAccumulator(plain[3]) : { valueRaw: 0n, lastUpdateMs: 0 }
    const lockdownUntilMs = plain[4] ? Number(u64At(hexToU8a(plain[4]), 0)) : null

    const issuance = new Map<number, bigint>()
    const nonNative = limitedAssets.filter(id => id !== 0)
    for (let i = 0; i < nonNative.length; i++) {
      const raw = issuanceRaw[i]
      if (raw) issuance.set(nonNative[i], u128At(hexToU8a(raw), 0))
    }
    if (limits.has(0) && plain[6]) issuance.set(0, u128At(hexToU8a(plain[6]), 0))

    const paused: { pallet: string; call: string }[] = []
    for (const key of pausedKeys) {
      const decoded = decodePausedKey(key)
      if (decoded) paused.push(decoded)
    }
    paused.sort((a, b) => a.pallet.localeCompare(b.pallet) || a.call.localeCompare(b.call))

    snapshot = {
      headBlock,
      nowMs,
      limits,
      withdraw: config ? { ...config, accumulatorRaw: accumulator?.valueRaw ?? 0n, lastUpdateMs: accumulator?.lastUpdateMs ?? 0, lockdownUntilMs } : null,
      lockdowns,
      issuance,
      tradeLimits,
      addLimits,
      removeLimits,
      egressAccounts: egressKeys.map(k => '0x' + k.slice(-64)),
      localCategoryAssets: [...categories.entries()].filter(([, c]) => c === 'local').map(([id]) => id).sort((a, b) => a - b),
      externalCategoryCount: [...categories.values()].filter(c => c === 'external').length,
      paused,
      hubTradability: plain[5] ? hexToU8a(plain[5])[0] : 0,
      nearNonEmode,
      takenAt: Date.now(),
    }
    // Cached responses are built from the snapshot, so a new snapshot must be
    // publishable immediately rather than after the response TTL.
    snapshotGeneration += 1
    // Re-verify the one block-count constant this service has to pin. It rides
    // this refresh rather than a task of its own: the check is a cached read
    // plus arithmetic, and the thing it guards is exactly what this snapshot
    // feeds. A boot-only check would never notice a runtime upgrade on a
    // process that has been up for weeks.
    await checkFusePeriodPin()
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

// response shape

// A sink the global withdraw limit accounts transfers into. Every one live today
// is a sibling parachain's sovereign account (`sibl` ++ the para id, little-endian),
// so the chain it belongs to is decoded from the account id itself.
export interface EgressSink { account: AccountRef; chain: string | null }
const SIBLING_PREFIX = '0x7369626c'
export function egressSinkChain(accountId: string): string | null {
  if (!accountId.startsWith(SIBLING_PREFIX)) return null
  const tail = accountId.slice(SIBLING_PREFIX.length)
  const paraId = u32At(hexToU8a('0x' + tail.slice(0, 8)), 0)
  return paraId > 0 ? parachainName(paraId) : null
}

export interface WithdrawLimitView {
  configured: boolean
  limit: number | null
  used: number | null
  usagePct: number | null
  windowMs: number | null
  lastCreditedMs: number | null
  lockdownUntilMs: number | null
  armedAt: { blockHeight: number; blockTimestamp: string } | null
  everTripped: boolean
  egressAccounts: EgressSink[]
  localAssets: AssetRef[]
  externalAssetCount: number
}

export interface FuseRow {
  asset: AssetRef
  status: FuseVerdict['status']
  limit: string
  used: string
  headroom: string
  usagePct: number
  untilBlock: number | null
  periodEndBlock: number | null
  category: 'local' | 'external' | null
  lockdownCount: number
}

export interface LockdownEvent {
  asset: AssetRef
  blockHeight: number
  blockTimestamp: string
  untilBlock: number
  liftedAtBlock: number | null
  liftedAtTimestamp: string | null
  liftedEarly: boolean | null
  extrinsicIndex: number | null
}

export interface PerBlockRow {
  asset: AssetRef
  reserve: string
  reserveUsd: number | null
  tradeLimitPct: number
  tradeAllowance: string
  tradeAllowanceUsd: number | null
  addLimitPct: number | null
  addAllowance: string | null
  removeLimitPct: number | null
  removeAllowance: string | null
  overridden: boolean
  peakBlockNet: string | null
  peakBlockHeight: number | null
  peakPressurePct: number | null
  tradable: string[]
}

export interface TripRow {
  blockHeight: number
  blockTimestamp: string
  extrinsicId: string
  callName: string
  errorName: string
  account: AccountRef | null
}

export interface PausedCall {
  pallet: string
  call: string
  pausedAtBlock: number | null
  pausedAtTimestamp: string | null
  extrinsicIndex: number | null
  orphaned: boolean
}

export interface TradabilityRow { asset: AssetRef; poolId: number | null; bits: number; flags: string[] }

export interface SafetyEvent {
  kind: string
  label: string
  detail: string
  blockHeight: number
  blockTimestamp: string
  extrinsicIndex: number | null
  asset: AssetRef | null
}

// Solvency of one lending market. The two markets are isolated, so their health
// factors and debts are never blended — each row stands alone.
export interface MarketSolvency {
  key: string
  label: string
  role: 'primary' | 'supplemental'
  borrowers: number
  debtUsd: number
  collateralUsd: number
  // Under water: the collateral no longer covers the debt at the market's
  // liquidation threshold, so anyone may close the position for a fee. Transient
  // by design — a profitable one is normally taken within blocks.
  underwaterCount: number
  underwaterDebtUsd: number
  underwaterCollateralUsd: number
  // Bad debt: the part no liquidation can recover, Σ max(0, debt − collateral).
  // A position can only reach it by being under water (health factor ≥ 1 implies
  // collateral ≥ debt, since the liquidation threshold is at most 1), so this is a
  // strict subset measured over every borrower rather than a second filter.
  badDebtCount: number
  badDebtUsd: number
  // Under water AND still fully covered: a liquidator profits, so it should clear.
  liquidatableCount: number
  liquidatableDebtUsd: number
  // Positions within 5% of their liquidation threshold, excluding those whose
  // proximity is structural: e-mode (correlated collateral and debt) and isolation
  // mode (a single capped asset backing an approved stablecoin borrow). Both are
  // run near the threshold on purpose. Needs the pool contract, so it is null when
  // chain state is unavailable rather than silently reported un-excluded.
  nearLiquidationCount: number | null
  nearLiquidationDebtUsd: number | null
}

export interface LiquidationRow {
  blockHeight: number
  blockTimestamp: string
  extrinsicIndex: number | null
  borrower: AccountRef
  collateral: AssetRef
  debt: AssetRef
}

// A single liquidity event, measured against the asset's per-block allowance —
// the number the circuit breaker would have checked it against.
export interface LiquidityMove {
  asset: AssetRef
  kind: 'add' | 'remove'
  amount: string
  blockHeight: number
  blockTimestamp: string
  extrinsicIndex: number | null
  allowance: string | null
  shareOfAllowancePct: number | null
}

export interface SecurityDashboard {
  head: { blockHeight: number; blockTimestamp: string }
  chainAsOf: string | null
  chainBlock: number | null
  withdraw: WithdrawLimitView
  fuses: { periodBlocks: number; rows: FuseRow[]; lockedCount: number; lockdownTotal: number; releaseTotal: number; lockdowns: LockdownEvent[] }
  perBlock: {
    defaultTradePct: number
    defaultAddPct: number
    defaultRemovePct: number
    rows: PerBlockRow[]
    peakWindowDays: number
  }
  trips: {
    total: number
    enforcementTotal: number
    directTotal: number
    nestedTotal: number
    byError: { name: string; count: number; enforcement: boolean }[]
    byYear: { year: number; count: number }[]
    recent: TripRow[]
  }
  freezes: {
    paused: PausedCall[]
    hubTradability: string[]
    omnipool: TradabilityRow[]
    omnipoolAssetCount: number
    delisted: TradabilityRow[]
    stableswap: TradabilityRow[]
  }
  risk: {
    windowDays: number
    markets: MarketSolvency[]
    liquidations: { day: number; week: number; month: number; total: number; lastTimestamp: string | null; recent: LiquidationRow[] }
    largestMoves: LiquidityMove[]
  }
  runtime: { specVersion: number; upgrades: number; lastUpgrade: { blockHeight: number; blockTimestamp: string } | null }
  timeline: SafetyEvent[]
  guardians: {
    techCommittee: { members: AccountRef[]; size: number; majority: number; superMajority: number }
    memberSetAtBlock: number | null
    outstandingWhitelisted: { callHash: string; blockHeight: number; blockTimestamp: string }[]
  }
}

const asset = (id: number): AssetRef => assetDescriptor(id)
const toHuman = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals
const extrinsicId = (block: number, index: number | null): string | null => (index == null ? null : `${block}-${index}`)
// Safety actions arrive both as extrinsics and inside block hooks (an XCM message
// minting into a locked asset has no extrinsic), so surfaces carry the index and
// let the UI link to the extrinsic when there is one and the block otherwise.
const extrinsicIndexOf = (index: number | null | undefined): number | null => (index == null ? null : Number(index))

function usdOf(prices: Map<number, PriceInfo>, assetId: number, raw: bigint, decimals: number): number | null {
  const p = prices.get(assetId)
  if (!p) return null
  const amount = Number(raw) / 10 ** decimals
  return Number.isFinite(amount) ? amount * p.price : null
}

const PEAK_WINDOW_DAYS = 30

interface HeadRow { block_height: number; block_timestamp: string }
interface LimitEventRow { block_height: number; block_timestamp: string; event_name: string; args_json: string; extrinsic_index: number | null }
interface PauseEventRow extends LimitEventRow { pallet_hex: string; call_hex: string }
interface TripSourceRow { block_height: number; block_timestamp: string; extrinsic_index: number | null; call_name: string; signer: string | null; spec_version: number; error_index: number; source: string }
interface PeakRow { asset_id: number; peak_net: string; peak_block: number }
interface TradabilityEventRow { asset_id: number; pool_id: number | null; bits: number }
interface WhitelistRow { call_hash: string; block_height: number; block_timestamp: string }
interface MemberRow { block_height: number; args_json: string }

const hexToUtf8 = (hex: string): string => Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('utf8')

export async function getSecurityDashboard(): Promise<SecurityDashboard> {
  return cachedSwr('explorer:security', 20_000, 120_000, buildSecurityDashboard, snapshotGeneration)
}

async function buildSecurityDashboard(): Promise<SecurityDashboard> {
  const snap = snapshot
  const [head, pools, lockdownRows, releaseTotal, limitEvents, registryLimitRows, pauseEvents, tripRows, peaks, omniTradabilityHistory, stableTradability, whitelisted, memberSet, solvency, liquidations, liquidityMoves, runtime] = await Promise.all([
    queryHead(),
    loadCurrentPools(),
    queryLockdownEvents(),
    queryDepositReleases(),
    queryLimitEvents(),
    queryRegistryLimitEvents(),
    queryPauseEvents(),
    queryTrips(),
    queryPeakBlockVolume(),
    queryOmnipoolTradabilityHistory(),
    queryStableswapTradability(),
    queryOutstandingWhitelistedCalls(),
    queryTechCommittee(),
    queryMarketSolvency(),
    queryLiquidations(),
    queryLargestLiquidityMoves(),
    queryRuntime(),
  ])

  const headBlock = snap?.headBlock ?? head.block_height
  // With no snapshot there is no issuance to measure against either, so the fuse
  // section renders its assets with no usage rather than a guessed one.
  const registryLimits = snap?.limits ?? await loadRegistryLimits()
  const prices = await ensurePrices()

  return {
    head: { blockHeight: head.block_height, blockTimestamp: head.block_timestamp },
    chainAsOf: snap ? new Date(snap.takenAt).toISOString() : null,
    chainBlock: snap?.headBlock ?? null,
    withdraw: buildWithdrawView(snap, limitEvents),
    fuses: buildFuses(snap, registryLimits, lockdownRows, releaseTotal, headBlock),
    perBlock: buildPerBlock(snap, pools, prices, peaks),
    trips: buildTrips(tripRows),
    freezes: buildFreezes(snap, pools, pauseEvents, stableTradability, omniTradabilityHistory),
    risk: {
      windowDays: PEAK_WINDOW_DAYS,
      markets: buildSolvency(solvency, snap),
      liquidations: buildLiquidations(liquidations),
      largestMoves: buildLiquidityMoves(liquidityMoves, snap, pools),
    },
    runtime: {
      specVersion: runtime?.spec_version ?? 0,
      upgrades: Number(runtime?.upgrades ?? 0),
      lastUpgrade: runtime ? { blockHeight: runtime.block_height, blockTimestamp: runtime.block_timestamp } : null,
    },
    timeline: buildTimeline(limitEvents, pauseEvents, lockdownRows, omniTradabilityHistory, registryLimitRows),
    guardians: {
      techCommittee: buildTechCommittee(memberSet),
      memberSetAtBlock: memberSet?.block_height ?? null,
      outstandingWhitelisted: whitelisted.map(w => ({ callHash: w.call_hash, blockHeight: w.block_height, blockTimestamp: w.block_timestamp })),
    },
  }
}

// queries

async function queryHead(): Promise<HeadRow> {
  const res = await client.query({
    query: `SELECT max(block_height) AS block_height, max(block_timestamp) AS block_timestamp FROM price_data.raw_blocks`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<HeadRow>()
  return rows[0] ?? { block_height: 0, block_timestamp: new Date(0).toISOString() }
}

async function queryLockdownEvents(): Promise<LimitEventRow[]> {
  const res = await client.query({
    query: `SELECT block_height, block_timestamp, event_name, args_json, extrinsic_index
            FROM price_data.raw_events
            WHERE event_name IN ('CircuitBreaker.AssetLockdown', 'CircuitBreaker.AssetLockdownRemoved')
            ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<LimitEventRow>()
}

async function queryDepositReleases(): Promise<number> {
  const res = await client.query({
    query: `SELECT count() AS c FROM price_data.raw_events WHERE event_name = 'CircuitBreaker.DepositReleased'`,
    format: 'JSONEachRow',
  })
  return Number((await res.json<{ c: string }>())[0]?.c ?? 0)
}

// Every circuit-breaker configuration change ever made. `AssetCategoryUpdated`
// fired 58 times in one governance batch, so it is folded into a single entry by
// the timeline builder rather than filling the list.
async function queryLimitEvents(): Promise<LimitEventRow[]> {
  const res = await client.query({
    query: `SELECT block_height, block_timestamp, event_name, args_json, extrinsic_index
            FROM price_data.raw_events
            WHERE event_name IN (
              'CircuitBreaker.TradeVolumeLimitChanged', 'CircuitBreaker.AddLiquidityLimitChanged',
              'CircuitBreaker.RemoveLiquidityLimitChanged', 'CircuitBreaker.WithdrawLimitConfigUpdated',
              'CircuitBreaker.WithdrawLockdownTriggered', 'CircuitBreaker.WithdrawLockdownLifted',
              'CircuitBreaker.WithdrawLockdownReset', 'CircuitBreaker.EgressAccountsAdded',
              'CircuitBreaker.EgressAccountsRemoved', 'CircuitBreaker.AssetCategoryUpdated')
            ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<LimitEventRow>()
}

// Every registry event that could carry a deposit-fuse limit, grouped so the
// ledger can diff each asset's own history. `Updated` restates the whole entry,
// so the rows that leave the limit alone are dropped by registryLimitChanges
// rather than here — the diff needs to see them to know nothing moved.
async function queryRegistryLimitEvents(): Promise<RegistryLimitRow[]> {
  const res = await client.query({
    query: `SELECT block_height, block_timestamp, extrinsic_index,
                   JSONExtractInt(args_json, 'assetId') AS asset_id,
                   JSONExtractString(args_json, 'xcmRateLimit') AS xcm_rate_limit
            FROM price_data.raw_events
            WHERE event_name IN ('AssetRegistry.Registered', 'AssetRegistry.Updated')
            ORDER BY asset_id, block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<RegistryLimitRow>()
}

// TransactionPause emits only on a real state change, so pause/unpause events are
// a complete ledger and the currently-paused set is exactly derivable from them.
async function queryPauseEvents(): Promise<PauseEventRow[]> {
  const res = await client.query({
    query: `SELECT block_height, block_timestamp, event_name, args_json, extrinsic_index,
                   JSONExtractString(args_json, 'palletNameBytes') AS pallet_hex,
                   JSONExtractString(args_json, 'functionNameBytes') AS call_hex
            FROM price_data.raw_events
            WHERE event_name IN ('TransactionPause.TransactionPaused', 'TransactionPause.TransactionUnpaused')
            ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<PauseEventRow>()
}

// Circuit-breaker rejections from all four places a Module error surfaces. The
// error index is the first byte of the 4-byte LE error field; the name depends on
// the runtime that raised it, so the block's spec_version travels with the row.
async function queryTrips(): Promise<TripSourceRow[]> {
  const moduleIndex = `JSONExtractUInt(error_json, 'value', 'index')`
  const errorByte = (col: string) => `reinterpretAsUInt8(substring(unhex(substring(JSONExtractString(${col}, 'value', 'error'), 3)), 1, 1))`
  const res = await client.query({
    query: `
      SELECT block_height, block_timestamp, extrinsic_index, call_name, signer, spec_version, error_index, source FROM (
        SELECT e.block_height AS block_height, e.block_timestamp AS block_timestamp, e.extrinsic_index AS extrinsic_index,
               e.call_name AS call_name, coalesce(e.signer, e.effective_signer) AS signer, b.spec_version AS spec_version,
               ${errorByte('e.error_json')} AS error_index, 'extrinsic' AS source
        FROM price_data.raw_extrinsics e
        INNER JOIN price_data.raw_blocks b ON b.block_height = e.block_height
        WHERE e.success = 0 AND JSONExtractString(e.error_json, '__kind') = 'Module'
          AND ${moduleIndex.replace('error_json', 'e.error_json')} = ${CIRCUIT_BREAKER_PALLET_INDEX}
        UNION ALL
        SELECT ev.block_height, ev.block_timestamp, ev.extrinsic_index, ev.event_name,
               NULL, b.spec_version,
               reinterpretAsUInt8(substring(unhex(substring(JSONExtractString(ev.args_json, 'error', 'value', 'error'), 3)), 1, 1)),
               ev.event_name
        FROM price_data.raw_events ev
        INNER JOIN price_data.raw_blocks b ON b.block_height = ev.block_height
        WHERE ev.event_name IN ('Utility.BatchInterrupted', 'Utility.ItemFailed')
          AND JSONExtractUInt(ev.args_json, 'error', 'value', 'index') = ${CIRCUIT_BREAKER_PALLET_INDEX}
        UNION ALL
        SELECT ev.block_height, ev.block_timestamp, ev.extrinsic_index, ev.event_name,
               NULL, b.spec_version,
               reinterpretAsUInt8(substring(unhex(substring(JSONExtractString(ev.args_json, 'result', 'value', 'value', 'error'), 3)), 1, 1)),
               ev.event_name
        FROM price_data.raw_events ev
        INNER JOIN price_data.raw_blocks b ON b.block_height = ev.block_height
        WHERE ev.event_name = 'Multisig.MultisigExecuted'
          AND JSONExtractUInt(ev.args_json, 'result', 'value', 'value', 'index') = ${CIRCUIT_BREAKER_PALLET_INDEX}
      )
      ORDER BY block_height DESC`,
    format: 'JSONEachRow',
  })
  return res.json<TripSourceRow>()
}

// The largest single-block |net| Omnipool volume per asset over the peak window.
// Net is the pallet's own quantity (`volume_in - volume_out` for the asset), and
// both legs of every Omnipool sell/buy contribute — router aggregates are excluded
// so a routed trade is counted once, at the pool level the breaker guards.
async function queryPeakBlockVolume(): Promise<Map<number, PeakRow>> {
  const res = await client.query({
    query: `
      WITH legs AS (
        SELECT block_height, asset_in AS asset_id, toInt256(amount_in) AS delta
        FROM price_data.swap_activity
        WHERE event_name IN ('Omnipool.SellExecuted', 'Omnipool.BuyExecuted')
          AND block_timestamp > now() - INTERVAL ${PEAK_WINDOW_DAYS} DAY
        UNION ALL
        SELECT block_height, asset_out AS asset_id, -toInt256(amount_out) AS delta
        FROM price_data.swap_activity
        WHERE event_name IN ('Omnipool.SellExecuted', 'Omnipool.BuyExecuted')
          AND block_timestamp > now() - INTERVAL ${PEAK_WINDOW_DAYS} DAY
      ), per_block AS (
        SELECT asset_id, block_height, abs(sum(delta)) AS net FROM legs GROUP BY asset_id, block_height
      )
      SELECT asset_id, toString(max(net)) AS peak_net, argMax(block_height, net) AS peak_block
      FROM per_block
      WHERE asset_id != ${HUB_ASSET_ID}
      GROUP BY asset_id`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<PeakRow>()
  return new Map(rows.map(r => [Number(r.asset_id), r]))
}

// The newest tradability state each Omnipool asset was ever set to. Assets still
// in the pool read their live bits from the block snapshot; this covers the
// delisted ones, whose last event is the only record left.
async function queryOmnipoolTradabilityHistory(): Promise<LimitEventRow[]> {
  const res = await client.query({
    query: `SELECT block_height, block_timestamp, event_name, args_json, extrinsic_index
            FROM price_data.raw_events
            WHERE event_name IN ('Omnipool.TradableStateUpdated', 'Stableswap.TradableStateUpdated')
            ORDER BY block_height, event_index`,
    format: 'JSONEachRow',
  })
  return res.json<LimitEventRow>()
}

// Stableswap stores only NON-default tradability (the setter deletes the row when
// the state returns to fully-tradable), so the newest event per (pool, asset) with
// non-default bits is the current restriction set.
async function queryStableswapTradability(): Promise<TradabilityEventRow[]> {
  const res = await client.query({
    query: `SELECT pool_id, asset_id, bits FROM (
              SELECT JSONExtractInt(args_json, 'poolId') AS pool_id,
                     JSONExtractInt(args_json, 'assetId') AS asset_id,
                     JSONExtractInt(args_json, 'state', 'bits') AS bits,
                     row_number() OVER (PARTITION BY pool_id, asset_id ORDER BY block_height DESC, event_index DESC) AS rn
              FROM price_data.raw_events
              WHERE event_name = 'Stableswap.TradableStateUpdated'
            ) WHERE rn = 1 AND bits != 15`,
    format: 'JSONEachRow',
  })
  return res.json<TradabilityEventRow>()
}

// Call hashes the technical committee whitelisted that no referendum has
// dispatched yet — each remains dispatchable on the fast whitelisted-caller track.
async function queryOutstandingWhitelistedCalls(): Promise<WhitelistRow[]> {
  const res = await client.query({
    query: `SELECT w.call_hash AS call_hash, w.block_height AS block_height, w.block_timestamp AS block_timestamp
            FROM (
              SELECT JSONExtractString(args_json, 'callHash') AS call_hash, max(block_height) AS block_height, max(block_timestamp) AS block_timestamp
              FROM price_data.raw_events WHERE event_name = 'Whitelist.CallWhitelisted' GROUP BY call_hash
            ) w
            LEFT JOIN (
              SELECT DISTINCT JSONExtractString(args_json, 'callHash') AS call_hash
              FROM price_data.raw_events WHERE event_name = 'Whitelist.WhitelistedCallDispatched'
            ) d ON d.call_hash = w.call_hash
            WHERE d.call_hash = ''
            ORDER BY w.block_height DESC`,
    format: 'JSONEachRow',
  })
  return res.json<WhitelistRow>()
}

// Solvency per configured market: how much is borrowed, and how much of that sits
// on a position the market can no longer cover. `*_base` is Aave's base currency at
// 8 decimals, i.e. already USD. Health factor is 1e18-scaled.
const MM_BASE = 1e8
const HF_ONE = '1000000000000000000'
// Within 5% of the threshold. Tighter than 10% because a lending market's normal
// operating band sits well above 1 — at 10% the figure is dominated by positions
// that are managed there deliberately rather than ones approaching trouble.
const HF_NEAR = '1050000000000000000'
// `getUserEMode(address)`. A position in an e-mode category borrows correlated
// assets against each other and is configured to sit close to its threshold, so
// counting it as "approaching liquidation" says nothing. The category is only
// readable from the pool contract: matching the position's liquidation threshold
// against the categories' own thresholds misclassifies 186 of 659 borrowers,
// because e-mode category 4/5 share 8500 with ordinary reserves.
const USER_EMODE_SELECTOR = '0xeddf1b79'
// `getReservesList()`, `getConfiguration(address)`, `getUserConfiguration(address)`.
// Aave puts a reserve's debt ceiling in bits 212-251 of its configuration word, and
// a user is in isolation mode when exactly one reserve is flagged as their
// collateral and that reserve carries a ceiling — the rule in
// UserConfiguration.getIsolationModeState. An isolated position can only borrow
// approved stablecoins against a single capped asset, so it is run deliberately
// close to its threshold and says nothing about directional risk.
const RESERVES_LIST_SELECTOR = '0xd1946dbc'
const RESERVE_CONFIG_SELECTOR = '0xc44b11f7'
const USER_CONFIG_SELECTOR = '0x4417a583'
const DEBT_CEILING_SHIFT = 212n
const DEBT_CEILING_BITS = 40n
const EMODE_BATCH = 80
interface SolvencyRow {
  pool: string; borrowers: number; debt_usd: number; collateral_usd: number
  underwater: number; uw_debt_usd: number; uw_collateral_usd: number
  bad_debt_n: number; bad_debt_usd: number
  liquidatable_n: number; liquidatable_usd: number
  near_liq_all: number
}
async function queryMarketSolvency(): Promise<Map<string, SolvencyRow>> {
  const debt = `tupleElement(pos, 'total_debt_base')`
  const coll = `tupleElement(pos, 'total_collateral_base')`
  const hf = `tupleElement(pos, 'health_factor')`
  const borrowing = `${debt} > 0`
  const underwater = `${borrowing} AND ${hf} < ${HF_ONE}`
  // Float subtraction, not UInt256: `debt - coll` would wrap on a covered position
  // even though sumIf discards it, and the result is divided into a float anyway.
  const shortfall = `toFloat64(${debt}) - toFloat64(${coll})`
  const uncovered = `${borrowing} AND ${coll} < ${debt}`
  // Counted here only to prove the band is non-empty; the published figure excludes
  // e-mode positions and is computed on the refresher, which can read the pool.
  const near = `${borrowing} AND ${hf} BETWEEN ${HF_ONE} AND ${HF_NEAR}`
  const res = await client.query({
    query: `
      WITH p AS (
        SELECT lower(pool_address) AS pool, argMaxMerge(position_state) AS pos
        FROM price_data.money_market_latest_positions
        GROUP BY user_address, pool
      )
      SELECT pool,
             countIf(${borrowing}) AS borrowers,
             toFloat64(sum(${debt})) / ${MM_BASE} AS debt_usd,
             toFloat64(sumIf(${coll}, ${borrowing})) / ${MM_BASE} AS collateral_usd,
             countIf(${underwater}) AS underwater,
             toFloat64(sumIf(${debt}, ${underwater})) / ${MM_BASE} AS uw_debt_usd,
             toFloat64(sumIf(${coll}, ${underwater})) / ${MM_BASE} AS uw_collateral_usd,
             countIf(${uncovered}) AS bad_debt_n,
             sumIf(${shortfall}, ${uncovered}) / ${MM_BASE} AS bad_debt_usd,
             countIf(${underwater} AND ${coll} >= ${debt}) AS liquidatable_n,
             toFloat64(sumIf(${debt}, ${underwater} AND ${coll} >= ${debt})) / ${MM_BASE} AS liquidatable_usd,
             countIf(${near}) AS near_liq_all
      FROM p GROUP BY pool`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<SolvencyRow>()
  return new Map(rows.map(r => [r.pool, r]))
}

interface LiquidationCountRow { day: string; week: string; month: string; total: string; last: string | null }
interface LiquidationEventRow { block_height: number; block_timestamp: string; extrinsic_index: number | null; args_json: string }
async function queryLiquidations(): Promise<{ counts: LiquidationCountRow; recent: LiquidationEventRow[] }> {
  const [countRes, recentRes] = await Promise.all([
    client.query({
      query: `SELECT countIf(block_timestamp > now() - INTERVAL 1 DAY) AS day,
                     countIf(block_timestamp > now() - INTERVAL 7 DAY) AS week,
                     countIf(block_timestamp > now() - INTERVAL 30 DAY) AS month,
                     count() AS total, toString(max(block_timestamp)) AS last
              FROM price_data.raw_events WHERE event_name = 'Liquidation.Liquidated'`,
      format: 'JSONEachRow',
    }),
    client.query({
      query: `SELECT block_height, block_timestamp, extrinsic_index, args_json
              FROM price_data.raw_events WHERE event_name = 'Liquidation.Liquidated'
              ORDER BY block_height DESC, event_index DESC LIMIT 12`,
      format: 'JSONEachRow',
    }),
  ])
  const counts = (await countRes.json<LiquidationCountRow>())[0] ?? { day: '0', week: '0', month: '0', total: '0', last: null }
  return { counts, recent: await recentRes.json<LiquidationEventRow>() }
}

// The biggest single Omnipool liquidity events in the window. Ranked by raw amount
// within each asset — the cross-asset comparison the page makes is the share of the
// asset's own per-block allowance, not a USD value, so no valuation is needed.
interface LiquidityMoveRow { event_name: string; asset_id: number; amount: string; block_height: number; ts: string; extrinsic_index: number | null }
async function queryLargestLiquidityMoves(): Promise<LiquidityMoveRow[]> {
  const res = await client.query({
    query: `SELECT event_name, asset_id, amount, block_height, toString(block_timestamp) AS ts, extrinsic_index
            FROM price_data.liquidity_activity
            WHERE block_timestamp > now() - INTERVAL ${PEAK_WINDOW_DAYS} DAY
              AND event_name IN ('Omnipool.LiquidityAdded', 'Omnipool.LiquidityRemoved')
            ORDER BY asset_id, toUInt256OrZero(amount) DESC
            LIMIT 1 BY asset_id, event_name`,
    format: 'JSONEachRow',
  })
  return res.json<LiquidityMoveRow>()
}

interface RuntimeRow { spec_version: number; upgrades: string; block_height: number; block_timestamp: string }
async function queryRuntime(): Promise<RuntimeRow | null> {
  const res = await client.query({
    query: `SELECT spec_version, block_height, toString(detected_at) AS block_timestamp,
                   (SELECT toString(count()) FROM price_data.runtime_upgrades) AS upgrades
            FROM price_data.runtime_upgrades ORDER BY block_height DESC LIMIT 1`,
    format: 'JSONEachRow',
  })
  return (await res.json<RuntimeRow>())[0] ?? null
}

// pallet_collective emits no membership event, so the committee's roster is only
// recorded in the enacted referendum preimage that set it.
async function queryTechCommittee(): Promise<MemberRow | null> {
  const res = await client.query({
    query: `SELECT noted_block AS block_height, args_json
            FROM price_data.referendum_proposals FINAL
            WHERE pallet = 'TechnicalCommittee' AND call_name = 'set_members'
            ORDER BY noted_block DESC
            LIMIT 1`,
    format: 'JSONEachRow',
  })
  return (await res.json<MemberRow>())[0] ?? null
}

// builders

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch { return {} }
}

function buildWithdrawView(snap: ChainSnapshot | null, limitEvents: LimitEventRow[]): WithdrawLimitView {
  const armed = limitEvents.find(e => e.event_name === 'CircuitBreaker.WithdrawLimitConfigUpdated')
  const everTripped = limitEvents.some(e => e.event_name === 'CircuitBreaker.WithdrawLockdownTriggered')
  const w = snap?.withdraw
  if (!w) {
    return {
      configured: false, limit: null, used: null, usagePct: null, windowMs: null, lastCreditedMs: null,
      lockdownUntilMs: null,
      armedAt: armed ? { blockHeight: armed.block_height, blockTimestamp: armed.block_timestamp } : null,
      everTripped, egressAccounts: [], localAssets: [], externalAssetCount: 0,
    }
  }
  const lockedDown = w.lockdownUntilMs != null && snap!.nowMs < w.lockdownUntilMs
  const used = decayedAccumulator(w.accumulatorRaw, w.lastUpdateMs, snap!.nowMs, w.windowMs, lockedDown)
  return {
    configured: true,
    limit: toHuman(w.limitRaw, HDX_DECIMALS),
    used: toHuman(used, HDX_DECIMALS),
    usagePct: w.limitRaw > 0n ? Number((used * 1_000_000n) / w.limitRaw) / 10_000 : null,
    windowMs: w.windowMs,
    lastCreditedMs: w.lastUpdateMs || null,
    lockdownUntilMs: lockedDown ? w.lockdownUntilMs : null,
    armedAt: armed ? { blockHeight: armed.block_height, blockTimestamp: armed.block_timestamp } : null,
    everTripped,
    egressAccounts: snap!.egressAccounts.map(a => ({ account: accountRef(a), chain: egressSinkChain(a) })),
    localAssets: snap!.localCategoryAssets.map(asset),
    externalAssetCount: snap!.externalCategoryCount,
  }
}

function buildFuses(
  snap: ChainSnapshot | null,
  registryLimits: Map<number, bigint>,
  lockdownRows: LimitEventRow[],
  releaseTotal: number,
  headBlock: number,
): SecurityDashboard['fuses'] {
  const lockdowns = pairLockdowns(lockdownRows)
  const perAssetLockdowns = new Map<number, number>()
  for (const l of lockdowns) perAssetLockdowns.set(l.asset.assetId, (perAssetLockdowns.get(l.asset.assetId) ?? 0) + 1)

  const rows: FuseRow[] = []
  for (const [assetId, limitRaw] of registryLimits) {
    const descriptor = asset(assetId)
    const verdict = snap
      ? classifyFuse(limitRaw, snap.lockdowns.get(assetId), snap.issuance.get(assetId), headBlock)
      : null
    rows.push({
      asset: descriptor,
      status: verdict?.status ?? 'unarmed',
      limit: limitRaw.toString(),
      used: (verdict?.usedRaw ?? 0n).toString(),
      headroom: (verdict?.headroomRaw ?? limitRaw).toString(),
      usagePct: verdict?.usagePct ?? 0,
      untilBlock: verdict?.untilBlock ?? null,
      periodEndBlock: verdict?.periodEndBlock ?? null,
      category: snap ? (snap.localCategoryAssets.includes(assetId) ? 'local' : 'external') : null,
      lockdownCount: perAssetLockdowns.get(assetId) ?? 0,
    })
  }
  // Loaded fuses first, then the ones that have ever tripped, then by symbol —
  // so the grid reads worst-first and stays stable between polls.
  rows.sort((a, b) => b.usagePct - a.usagePct || b.lockdownCount - a.lockdownCount || a.asset.symbol.localeCompare(b.asset.symbol))

  return {
    periodBlocks: FUSE_PERIOD_BLOCKS,
    rows,
    lockedCount: rows.filter(r => r.status === 'locked').length,
    lockdownTotal: lockdowns.length,
    releaseTotal,
    lockdowns: lockdowns.slice().reverse(),
  }
}

export interface RegistryLimitRow {
  block_height: number
  block_timestamp: string
  extrinsic_index: number | null
  asset_id: number
  xcm_rate_limit: string
}

// A deposit fuse's limit IS the registry's `xcm_rate_limit`, so moving one is a
// safety action even though it arrives as an asset-registry event rather than a
// circuit-breaker one. `Registered` and `Updated` restate the asset's entire entry
// and most updates leave the limit alone, so only a row that actually moves it
// earns a ledger entry. An absent, empty or zero value means the asset carries no
// limit — the same reading loadRegistryLimits applies to the newest event per
// asset. Rows must arrive grouped by asset and ordered by block within each.
export function registryLimitChanges(rows: RegistryLimitRow[]): SafetyEvent[] {
  const out: SafetyEvent[] = []
  const previous = new Map<number, bigint | null>()
  for (const r of rows) {
    const assetId = Number(r.asset_id)
    if (!Number.isInteger(assetId) || assetId < 0) continue
    const next = parseRegistryLimit(r.xcm_rate_limit)
    const seen = previous.has(assetId)
    const prev = previous.get(assetId) ?? null
    previous.set(assetId, next)
    if (prev === next) continue
    // Registration without a fuse is not an action, so only a limit that exists
    // on one side of the change is worth a line.
    if (!seen && next === null) continue
    const descriptor = asset(assetId)
    const label = next === null ? 'Deposit fuse limit cleared' : prev === null ? 'Deposit fuse limit set' : 'Deposit fuse limit changed'
    const detail = next === null
      ? `${descriptor.symbol} → no limit`
      : prev === null
        ? `${descriptor.symbol} → ${fuseAmount(next, descriptor.decimals)}`
        : `${descriptor.symbol} → ${fuseAmount(next, descriptor.decimals)} (was ${fuseAmount(prev, descriptor.decimals)})`
    out.push({
      kind: 'limit',
      label,
      detail,
      blockHeight: r.block_height,
      blockTimestamp: r.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(r.extrinsic_index),
      asset: descriptor,
    })
  }
  return out
}

function parseRegistryLimit(raw: string | null | undefined): bigint | null {
  if (!raw || raw === 'null') return null
  try {
    const limit = BigInt(raw)
    return limit > 0n ? limit : null
  } catch { return null }
}

// Fuse limits run from half a WBTC to millions of vASTR, so the precision follows
// the magnitude rather than a fixed number of decimals.
function fuseAmount(raw: bigint, decimals: number): string {
  const value = toHuman(raw, decimals)
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6 })
}

// Pair each AssetLockdown with the AssetLockdownRemoved that cleared it. A removal
// before the lockdown's own `until` block was a governance lift; at or after it,
// the fuse cleared itself on the next under-limit mint.
export function pairLockdowns(rows: LimitEventRow[]): LockdownEvent[] {
  const open = new Map<number, LockdownEvent>()
  const out: LockdownEvent[] = []
  for (const r of rows) {
    const args = safeJson(r.args_json)
    const assetId = Number(args.assetId ?? -1)
    if (!Number.isInteger(assetId) || assetId < 0) continue
    if (r.event_name === 'CircuitBreaker.AssetLockdown') {
      const event: LockdownEvent = {
        asset: asset(assetId),
        blockHeight: r.block_height,
        blockTimestamp: r.block_timestamp,
        untilBlock: Number(args.until ?? 0),
        liftedAtBlock: null,
        liftedAtTimestamp: null,
        liftedEarly: null,
        extrinsicIndex: extrinsicIndexOf(r.extrinsic_index),
      }
      open.set(assetId, event)
      out.push(event)
    } else {
      const event = open.get(assetId)
      if (!event) continue
      event.liftedAtBlock = r.block_height
      event.liftedAtTimestamp = r.block_timestamp
      event.liftedEarly = event.untilBlock > 0 && r.block_height < event.untilBlock
      open.delete(assetId)
    }
  }
  return out
}

function buildPerBlock(
  snap: ChainSnapshot | null,
  pools: Awaited<ReturnType<typeof loadCurrentPools>>,
  prices: Map<number, PriceInfo>,
  peaks: Map<number, PeakRow>,
): SecurityDashboard['perBlock'] {
  const rows: PerBlockRow[] = []
  for (const [assetId, state] of pools.omnipool) {
    if (assetId === HUB_ASSET_ID) continue
    const descriptor = asset(assetId)
    const tradeLimit = snap?.tradeLimits.get(assetId) ?? DEFAULT_TRADE_LIMIT
    const addLimit = snap?.addLimits.has(assetId) ? snap.addLimits.get(assetId)! : DEFAULT_LIQUIDITY_LIMIT
    const removeLimit = snap?.removeLimits.has(assetId) ? snap.removeLimits.get(assetId)! : DEFAULT_LIQUIDITY_LIMIT
    const tradeAllowance = allowanceFor(state.reserve, tradeLimit) ?? 0n
    const peak = peaks.get(assetId)
    const peakNet = peak ? BigInt(peak.peak_net) : null
    rows.push({
      asset: descriptor,
      reserve: state.reserve.toString(),
      reserveUsd: usdOf(prices, assetId, state.reserve, descriptor.decimals),
      tradeLimitPct: rationalPct(tradeLimit),
      tradeAllowance: tradeAllowance.toString(),
      tradeAllowanceUsd: usdOf(prices, assetId, tradeAllowance, descriptor.decimals),
      addLimitPct: addLimit ? rationalPct(addLimit) : null,
      addAllowance: allowanceFor(state.reserve, addLimit)?.toString() ?? null,
      removeLimitPct: removeLimit ? rationalPct(removeLimit) : null,
      removeAllowance: allowanceFor(state.reserve, removeLimit)?.toString() ?? null,
      overridden: Boolean(snap?.tradeLimits.has(assetId) || snap?.addLimits.has(assetId) || snap?.removeLimits.has(assetId)),
      peakBlockNet: peakNet?.toString() ?? null,
      peakBlockHeight: peak?.peak_block ?? null,
      peakPressurePct: peakNet != null && tradeAllowance > 0n ? Number((peakNet * 10_000n) / tradeAllowance) / 100 : null,
      tradable: tradableLabels(state.tradable),
    })
  }
  rows.sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1))
  return {
    defaultTradePct: rationalPct(DEFAULT_TRADE_LIMIT),
    defaultAddPct: rationalPct(DEFAULT_LIQUIDITY_LIMIT),
    defaultRemovePct: rationalPct(DEFAULT_LIQUIDITY_LIMIT),
    rows,
    peakWindowDays: PEAK_WINDOW_DAYS,
  }
}

// Tradability bitflags, named the way the pallet names its permissions. Kept
// local to this service because the Security page labels the BLOCKED operations,
// where the pool pages label the allowed ones.
export function tradableLabels(bits: number): string[] {
  if (!bits) return ['Frozen']
  const out: string[] = []
  if (bits & 1) out.push('Sell')
  if (bits & 2) out.push('Buy')
  if (bits & 4) out.push('Add liquidity')
  if (bits & 8) out.push('Remove liquidity')
  return out
}

// A tradability state as the ledger words it. The reader's question is "what is
// switched off", so the shorter side of the mask speaks: naming the surviving
// permissions instead made six rows read "Sell · Buy · Remove liquidity" when
// the one fact that changed was Add liquidity turning off. When more is off
// than on, the allowed remainder is the shorter, clearer statement.
export function tradabilityStateName(bits: number): string {
  if (bits === 15) return 'fully tradable'
  if (bits === 0) return 'frozen — nothing allowed'
  const allowed = tradableLabels(bits)
  const blocked = tradableLabels(~bits & 15)
  return blocked.length <= allowed.length
    ? `${blocked.join(' · ')} off`
    : `only ${allowed.join(' · ')} allowed`
}

// The circuit-breaker errors that mean a limit actually stopped something. The
// pallet's other errors are administrative — a malformed limit, a release against
// an asset that is not locked — and counting them as trips would overstate how
// often the breakers bite.
const ENFORCEMENT_ERRORS = new Set([
  'MaxLiquidityLimitPerBlockReached',
  'TokenOutflowLimitReached',
  'TokenInfluxLimitReached',
  'AssetInLockdown',
  'WithdrawLockdownActive',
  'GlobalWithdrawLimitExceeded',
  'DepositLimitExceededForWhitelistedAccount',
])

function buildTrips(rows: TripSourceRow[]): SecurityDashboard['trips'] {
  const byError = new Map<string, number>()
  const byYear = new Map<number, number>()
  const recent: TripRow[] = []
  let directTotal = 0
  let nestedTotal = 0
  let enforcementTotal = 0
  for (const r of rows) {
    const resolved = resolveModuleError(r.spec_version, CIRCUIT_BREAKER_PALLET_INDEX, r.error_index)
    const name = resolved?.name ?? `Error #${r.error_index}`
    const enforcement = ENFORCEMENT_ERRORS.has(name)
    byError.set(name, (byError.get(name) ?? 0) + 1)
    if (!enforcement) {
      if (r.source === 'extrinsic') directTotal += 1
      else nestedTotal += 1
      continue
    }
    enforcementTotal += 1
    const year = new Date(r.block_timestamp + 'Z').getUTCFullYear()
    byYear.set(year, (byYear.get(year) ?? 0) + 1)
    if (r.source === 'extrinsic') {
      directTotal += 1
      if (recent.length < 25) {
        recent.push({
          blockHeight: r.block_height,
          blockTimestamp: r.block_timestamp,
          extrinsicId: extrinsicId(r.block_height, r.extrinsic_index) ?? String(r.block_height),
          callName: r.call_name,
          errorName: name,
          account: r.signer ? accountRef(r.signer) : null,
        })
      }
    } else {
      nestedTotal += 1
    }
  }
  return {
    total: rows.length,
    enforcementTotal,
    directTotal,
    nestedTotal,
    byError: [...byError.entries()].map(([name, count]) => ({ name, count, enforcement: ENFORCEMENT_ERRORS.has(name) })).sort((a, b) => b.count - a.count),
    byYear: [...byYear.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year),
    recent,
  }
}

// The currently-paused set, replayed from the pause ledger. Chain state is the
// authority when the snapshot is available and is expected to agree; the replay is
// what supplies each entry's "paused since".
export function replayPauses(rows: PauseEventRow[]): Map<string, PauseEventRow> {
  const live = new Map<string, PauseEventRow>()
  for (const r of rows) {
    const key = `${hexToUtf8(r.pallet_hex)}.${hexToUtf8(r.call_hex)}`
    if (r.event_name === 'TransactionPause.TransactionPaused') live.set(key, r)
    else live.delete(key)
  }
  return live
}

// Pallets that no longer exist in the runtime. A pause row outlives its pallet's
// removal, so the entry stands while gating nothing.
const RETIRED_PALLETS = new Set(['Elections', 'Council', 'Tips', 'Sudo'])

function buildFreezes(
  snap: ChainSnapshot | null,
  pools: Awaited<ReturnType<typeof loadCurrentPools>>,
  pauseEvents: PauseEventRow[],
  stableswap: TradabilityEventRow[],
  tradabilityHistory: LimitEventRow[],
): SecurityDashboard['freezes'] {
  const replayed = replayPauses(pauseEvents)
  // Chain state decides which entries exist; the replay supplies their history.
  const liveKeys = snap ? snap.paused.map(p => `${p.pallet}.${p.call}`) : [...replayed.keys()]
  const paused: PausedCall[] = liveKeys.map(key => {
    const [pallet, ...rest] = key.split('.')
    const call = rest.join('.')
    const event = replayed.get(key)
    return {
      pallet,
      call,
      pausedAtBlock: event?.block_height ?? null,
      pausedAtTimestamp: event?.block_timestamp ?? null,
      extrinsicIndex: event ? extrinsicIndexOf(event.extrinsic_index) : null,
      orphaned: RETIRED_PALLETS.has(pallet),
    }
  }).sort((a, b) => (b.pausedAtBlock ?? 0) - (a.pausedAtBlock ?? 0))

  // Omnipool assets still in the pool carry live bits in the block snapshot;
  // anything short of all four flags is a restriction worth naming.
  const omnipool: TradabilityRow[] = []
  for (const [assetId, state] of pools.omnipool) {
    if (state.tradable === 15) continue
    omnipool.push({ asset: asset(assetId), poolId: null, bits: state.tradable, flags: tradableLabels(state.tradable) })
  }
  // Assets whose last tradability state restricted them and that have since left
  // the pool. Freezing an asset IS how it is wound down, so these are completed
  // offboardings rather than live restrictions and are listed separately.
  const delistedBits = new Map<number, number>()
  for (const r of tradabilityHistory) {
    if (r.event_name !== 'Omnipool.TradableStateUpdated') continue
    const args = safeJson(r.args_json)
    const assetId = Number(args.assetId ?? -1)
    const bits = Number((args.state as { bits?: number } | undefined)?.bits ?? 0)
    if (Number.isInteger(assetId) && assetId >= 0 && !pools.omnipool.has(assetId)) delistedBits.set(assetId, bits)
  }
  const delisted: TradabilityRow[] = [...delistedBits.entries()]
    .filter(([, bits]) => bits !== 15)
    .map(([assetId, bits]) => ({ asset: asset(assetId), poolId: null, bits, flags: tradableLabels(bits) }))
    .sort((a, b) => a.bits - b.bits || a.asset.assetId - b.asset.assetId)

  return {
    paused,
    hubTradability: tradableLabels(snap?.hubTradability ?? 0),
    omnipool,
    omnipoolAssetCount: [...pools.omnipool.keys()].filter(id => id !== HUB_ASSET_ID).length,
    delisted,
    stableswap: stableswap.map(r => ({ asset: asset(r.asset_id), poolId: r.pool_id, bits: r.bits, flags: tradableLabels(r.bits) })),
  }
}

function buildSolvency(rows: Map<string, SolvencyRow>, snap: ChainSnapshot | null): MarketSolvency[] {
  return mmMarkets().map(m => {
    const r = rows.get(m.poolProxy)
    const near = snap?.nearNonEmode.get(m.poolProxy)
    return {
      key: m.key, label: m.label, role: m.role,
      borrowers: r?.borrowers ?? 0,
      debtUsd: r?.debt_usd ?? 0,
      collateralUsd: r?.collateral_usd ?? 0,
      underwaterCount: r?.underwater ?? 0,
      underwaterDebtUsd: r?.uw_debt_usd ?? 0,
      underwaterCollateralUsd: r?.uw_collateral_usd ?? 0,
      badDebtCount: r?.bad_debt_n ?? 0,
      badDebtUsd: r?.bad_debt_usd ?? 0,
      liquidatableCount: r?.liquidatable_n ?? 0,
      liquidatableDebtUsd: r?.liquidatable_usd ?? 0,
      nearLiquidationCount: near?.count ?? null,
      nearLiquidationDebtUsd: near?.debtUsd ?? null,
    }
  })
}

function buildLiquidations(input: { counts: LiquidationCountRow; recent: LiquidationEventRow[] }): SecurityDashboard['risk']['liquidations'] {
  const recent: LiquidationRow[] = []
  for (const r of input.recent) {
    const args = safeJson(r.args_json)
    const user = typeof args.user === 'string' ? args.user : null
    if (!user) continue
    recent.push({
      blockHeight: r.block_height,
      blockTimestamp: r.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(r.extrinsic_index),
      borrower: accountRef(user),
      collateral: asset(Number(args.collateralAsset ?? 0)),
      debt: asset(Number(args.debtAsset ?? 0)),
    })
  }
  return {
    day: Number(input.counts.day), week: Number(input.counts.week),
    month: Number(input.counts.month), total: Number(input.counts.total),
    lastTimestamp: input.counts.last || null,
    recent,
  }
}

// Each move is put next to the allowance the circuit breaker measures it against,
// so one number says how close a real liquidity event came to the per-block cap.
// Assets no longer in the pool have no current reserve, so they carry no share.
function buildLiquidityMoves(
  rows: LiquidityMoveRow[],
  snap: ChainSnapshot | null,
  pools: Awaited<ReturnType<typeof loadCurrentPools>>,
): LiquidityMove[] {
  const out: LiquidityMove[] = []
  for (const r of rows) {
    const assetId = Number(r.asset_id)
    if (assetId === HUB_ASSET_ID) continue
    let amount: bigint
    try { amount = BigInt(r.amount) } catch { continue }
    if (amount <= 0n) continue
    const kind: LiquidityMove['kind'] = r.event_name === 'Omnipool.LiquidityRemoved' ? 'remove' : 'add'
    const state = pools.omnipool.get(assetId)
    const overrides = kind === 'add' ? snap?.addLimits : snap?.removeLimits
    const limit = overrides?.has(assetId) ? overrides.get(assetId)! : DEFAULT_LIQUIDITY_LIMIT
    const allowance = state ? allowanceFor(state.reserve, limit) : null
    out.push({
      asset: asset(assetId), kind,
      amount: amount.toString(),
      blockHeight: r.block_height,
      blockTimestamp: r.ts,
      extrinsicIndex: extrinsicIndexOf(r.extrinsic_index),
      allowance: allowance?.toString() ?? null,
      shareOfAllowancePct: allowance != null && allowance > 0n ? Number((amount * 1_000_000n) / allowance) / 10_000 : null,
    })
  }
  // Closest to its own cap first — the ranking the breaker cares about.
  return out.sort((a, b) => (b.shareOfAllowancePct ?? -1) - (a.shareOfAllowancePct ?? -1)).slice(0, 12)
}

const LIMIT_EVENT_LABEL: Record<string, string> = {
  'CircuitBreaker.TradeVolumeLimitChanged': 'Trade volume limit changed',
  'CircuitBreaker.AddLiquidityLimitChanged': 'Add-liquidity limit changed',
  'CircuitBreaker.RemoveLiquidityLimitChanged': 'Remove-liquidity limit changed',
  'CircuitBreaker.WithdrawLimitConfigUpdated': 'Global withdraw limit set',
  'CircuitBreaker.WithdrawLockdownTriggered': 'Global withdraw lockdown armed',
  'CircuitBreaker.WithdrawLockdownLifted': 'Global withdraw lockdown lifted',
  'CircuitBreaker.WithdrawLockdownReset': 'Global withdraw lockdown reset',
  'CircuitBreaker.EgressAccountsAdded': 'Egress sinks added',
  'CircuitBreaker.EgressAccountsRemoved': 'Egress sinks removed',
}

// The global withdraw budget as the ledger states it: an HDX allowance per window.
export function withdrawConfigText(args: Record<string, unknown>): string {
  const limit = toHuman(BigInt(String(args.limit ?? '0')), HDX_DECIMALS)
  return `${limit.toLocaleString('en-US', { maximumFractionDigits: 0 })} HDX per ${Math.round(Number(args.window ?? 0) / 3_600_000)}h`
}

// One chronological ledger of every governance action against a safety control,
// newest first. Configuration events, pauses, lockdowns and tradability flips read
// as one story, which is how they were actually applied — several of them arrived
// in the same committee batch.
function buildTimeline(
  limitEvents: LimitEventRow[],
  pauseEvents: PauseEventRow[],
  lockdownRows: LimitEventRow[],
  tradabilityHistory: LimitEventRow[],
  registryLimitRows: RegistryLimitRow[],
): SafetyEvent[] {
  const out: SafetyEvent[] = [...registryLimitChanges(registryLimitRows)]
  const rationalText = (v: unknown): string => {
    if (Array.isArray(v) && v.length === 2) return `${(Number(v[0]) / Number(v[1]) * 100).toFixed(2)}%`
    return 'disabled'
  }
  // AssetCategoryUpdated fired 58 times in one batch; one entry per block keeps
  // the ledger readable without hiding that it happened.
  const categoryByBlock = new Map<number, { count: number; row: LimitEventRow }>()
  let previousWithdrawConfig: string | null = null

  for (const e of limitEvents) {
    const args = safeJson(e.args_json)
    if (e.event_name === 'CircuitBreaker.AssetCategoryUpdated') {
      const prev = categoryByBlock.get(e.block_height)
      categoryByBlock.set(e.block_height, { count: (prev?.count ?? 0) + 1, row: e })
      continue
    }
    let detail = ''
    if (e.event_name.endsWith('LimitChanged')) detail = `${assetDescriptor(Number(args.assetId ?? 0)).symbol} → ${rationalText(args.tradeVolumeLimit ?? args.liquidityLimit)}`
    else if (e.event_name === 'CircuitBreaker.WithdrawLimitConfigUpdated') {
      // The event restates the whole config, so carrying the previous one keeps a
      // tightening readable as the change it was rather than a bare new number.
      const config = withdrawConfigText(args)
      detail = previousWithdrawConfig && previousWithdrawConfig !== config ? `${config} (was ${previousWithdrawConfig})` : config
      previousWithdrawConfig = config
    } else if (e.event_name.startsWith('CircuitBreaker.EgressAccounts')) detail = `${args.count ?? 0} accounts`
    else if (e.event_name === 'CircuitBreaker.WithdrawLockdownTriggered') detail = `until ${new Date(Number(args.until ?? 0)).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    out.push({
      kind: 'limit',
      label: LIMIT_EVENT_LABEL[e.event_name] ?? e.event_name,
      detail,
      blockHeight: e.block_height,
      blockTimestamp: e.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(e.extrinsic_index),
      asset: args.assetId != null ? asset(Number(args.assetId)) : null,
    })
  }
  for (const [, entry] of categoryByBlock) {
    out.push({
      kind: 'limit',
      label: 'Egress asset categories set',
      detail: `${entry.count} assets`,
      blockHeight: entry.row.block_height,
      blockTimestamp: entry.row.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(entry.row.extrinsic_index),
      asset: null,
    })
  }
  for (const e of pauseEvents) {
    const paused = e.event_name === 'TransactionPause.TransactionPaused'
    out.push({
      kind: paused ? 'pause' : 'unpause',
      label: paused ? 'Call paused' : 'Call unpaused',
      detail: `${hexToUtf8(e.pallet_hex)}.${hexToUtf8(e.call_hex)}`,
      blockHeight: e.block_height,
      blockTimestamp: e.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(e.extrinsic_index),
      asset: null,
    })
  }
  for (const e of lockdownRows) {
    const args = safeJson(e.args_json)
    const locked = e.event_name === 'CircuitBreaker.AssetLockdown'
    const assetId = Number(args.assetId ?? 0)
    out.push({
      kind: locked ? 'lockdown' : 'lockdown-lifted',
      label: locked ? 'Deposit fuse tripped' : 'Deposit lockdown cleared',
      detail: locked ? `${assetDescriptor(assetId).symbol} locked until block ${Number(args.until ?? 0).toLocaleString('en-US')}` : `${assetDescriptor(assetId).symbol} minting resumed`,
      blockHeight: e.block_height,
      blockTimestamp: e.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(e.extrinsic_index),
      asset: asset(assetId),
    })
  }
  // Events arrive block-ascending, so each (family, pool, asset)'s previous
  // state is at hand: the ledger states the new rules AND what they replaced,
  // like every limit row does — an asset's first event has no on-record
  // predecessor and states only the new rules. A change that only ADDS
  // permissions reads green even when it stops short of fully tradable.
  const tradabilityPrev = new Map<string, number>()
  for (const e of tradabilityHistory) {
    const args = safeJson(e.args_json)
    const bits = Number((args.state as { bits?: number } | undefined)?.bits ?? 0)
    const assetId = Number(args.assetId ?? 0)
    const poolId = args.poolId != null ? Number(args.poolId) : null
    const where = poolId != null ? `pool ${poolId} · ` : ''
    const prevKey = `${e.event_name}:${poolId ?? ''}:${assetId}`
    const prev = tradabilityPrev.get(prevKey)
    tradabilityPrev.set(prevKey, bits)
    const relaxed = bits === 15 || (prev != null && prev !== bits && (bits & prev) === prev)
    out.push({
      kind: relaxed ? 'unfreeze' : 'freeze',
      label: e.event_name.startsWith('Stableswap') ? 'Stablepool tradability set' : 'Omnipool tradability set',
      detail: `${where}${assetDescriptor(assetId).symbol} → ${tradabilityStateName(bits)}`
        + (prev != null && prev !== bits ? ` (was ${tradabilityStateName(prev)})` : ''),
      blockHeight: e.block_height,
      blockTimestamp: e.block_timestamp,
      extrinsicIndex: extrinsicIndexOf(e.extrinsic_index),
      asset: asset(assetId),
    })
  }
  return out.sort((a, b) => b.blockHeight - a.blockHeight)
}

// `TechnicalCommittee.set_members(newMembers, prime, oldCount)` from the enacted
// preimage. Majority is `ayes * 2 >= size` and super-majority `ayes * 3 >= 2 * size`,
// matching EnsureProportionAtLeast<1,2> and <2,3>.
export function committeeThresholds(size: number): { majority: number; superMajority: number } {
  return { majority: Math.ceil(size / 2), superMajority: Math.ceil((2 * size) / 3) }
}

function buildTechCommittee(row: MemberRow | null): SecurityDashboard['guardians']['techCommittee'] {
  const args = safeJson(row?.args_json)
  const raw = args.newMembers ?? args.new_members
  const members = Array.isArray(raw) ? raw.filter((m): m is string => typeof m === 'string') : []
  return { members: members.map(m => accountRef(m)), size: members.length, ...committeeThresholds(members.length) }
}
