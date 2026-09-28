import { calculate_amplification } from '@galacticcouncil/math-stableswap'
import { u8aToHex } from '@polkadot/util'
import { xxhashAsHex } from '@polkadot/util-crypto'
import { deriveOmnipoolAccount, deriveStableswapPoolAccount } from '../util/account.js'
import type { AssetMetadata } from '../registry/types.ts'
import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import { isKnownErc20, readErc20Balances, readErc20BalancesForHolders } from '../evm/balances.js'
import { toClickHouseDateTime } from './json.js'
import type {
  SnapshotOmnipoolAsset,
  SnapshotPayload,
  SnapshotState,
  SnapshotStableswapPoolState,
  SnapshotXykPoolState,
} from './types.js'
import { forEachConcurrent } from '../util/collections.js'

const POOL_STORAGE_PREFIXES = [
  'Omnipool', 'Tokens', 'XYK', 'Stableswap',
].map(name => xxhashAsHex(name, 128).slice(2))

const omnipoolAccount = u8aToHex(deriveOmnipoolAccount())
const stableswapAccountCache = new Map<number, string>()

function snapshotReadBatchSize(): number {
  const configured = Number.parseInt(process.env.RAW_SNAPSHOT_READ_BATCH_SIZE ?? '100', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 500) : 100
}

function snapshotReadBatchConcurrency(): number {
  const configured = Number.parseInt(process.env.RAW_SNAPSHOT_READ_BATCH_CONCURRENCY ?? '2', 10)
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 8) : 2
}

function chunkIndexed<T>(items: T[], size: number): Array<Array<{ item: T; index: number }>> {
  const chunks: Array<Array<{ item: T; index: number }>> = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size).map((item, offset) => ({ item, index: index + offset })))
  }
  return chunks
}

async function getManyChunked<K, V>(
  keys: K[],
  read: (keys: K[]) => Promise<V[]>,
): Promise<V[]> {
  if (keys.length === 0) return []
  const results = new Array<V>(keys.length)
  const chunks = chunkIndexed(keys, snapshotReadBatchSize())
  await forEachConcurrent(chunks, snapshotReadBatchConcurrency(), async (chunk) => {
    const values = await read(chunk.map(({ item }) => item))
    for (let index = 0; index < chunk.length; index++) {
      results[chunk[index].index] = values[index]
    }
  })
  return results
}

export function getOmnipoolAccount(): string {
  return omnipoolAccount
}

export function getStableswapPoolAccount(poolId: number): string {
  let account = stableswapAccountCache.get(poolId)
  if (account == null) {
    account = u8aToHex(deriveStableswapPoolAccount(poolId))
    stableswapAccountCache.set(poolId, account)
  }
  return account
}

export function detectPoolAffectingSetStorage(calls: Array<{ name?: string; args?: unknown }>): boolean {
  for (const call of calls) {
    if (call.name !== 'System.set_storage') continue

    const items = (call.args as { items?: Array<[string, string]> } | undefined)?.items
    if (items == null) continue

    for (const [key] of items) {
      const prefix = key.startsWith('0x') ? key.slice(2, 34) : key.slice(0, 32)
      if (POOL_STORAGE_PREFIXES.some(value => value === prefix)) {
        return true
      }
    }
  }

  return false
}

export async function readOmnipoolState(block: Block, assetIds: number[]): Promise<SnapshotOmnipoolAsset[]> {
  if (!storage.omnipool.assets.v115.is(block)) {
    throw new Error(`Unsupported Omnipool.Assets storage at block ${block.height}`)
  }

  type AccountBalances = Awaited<ReturnType<typeof storage.tokens.accounts.v108.getMany>>

  // Asset states and pool balances are independent batched reads — fetch concurrently
  // so their RPC round-trips overlap instead of running back-to-back.
  const balancesSupported = storage.tokens.accounts.v108.is(block)
  if (!balancesSupported) {
    throw new Error(`Unsupported Tokens.Accounts storage at block ${block.height}`)
  }
  const [assetStates, balances] = await Promise.all([
    storage.omnipool.assets.v115.getMany(block, assetIds),
    getManyChunked(
      assetIds.map(assetId => [omnipoolAccount, assetId] as [string, number]),
      page => storage.tokens.accounts.v108.getMany(block, page),
    ).then(value => value as AccountBalances),
  ])

  const erc20Gaps: Array<{ index: number; assetId: number }> = []
  const assets: SnapshotOmnipoolAsset[] = []

  for (let i = 0; i < assetIds.length; i++) {
    const assetId = assetIds[i]
    const assetState = assetStates[i]
    if (assetState == null) continue

    let reserve = assetState.shares
    if (isKnownErc20(assetId)) {
      erc20Gaps.push({ index: assets.length, assetId })
    } else if (balances?.[i]?.free != null && balances[i]!.free > 0n) {
      reserve = balances[i]!.free
    }

    assets.push({
      asset_id: assetId,
      hub_reserve: assetState.hubReserve.toString(),
      reserve: reserve.toString(),
      shares: assetState.shares.toString(),
      protocol_shares: assetState.protocolShares.toString(),
      cap: assetState.cap.toString(),
      tradable: assetState.tradable.bits,
    })
  }

  const hdxState = assets.find(asset => asset.asset_id === 0)
  if (hdxState != null) {
    try {
      let hdxFree: bigint | undefined
      if (storage.system.account.v205.is(block)) {
        const account = await storage.system.account.v205.get(block, omnipoolAccount)
        hdxFree = account?.data.free
      } else if (storage.system.account.v100.is(block)) {
        const account = await storage.system.account.v100.get(block, omnipoolAccount)
        hdxFree = account?.data.free
      } else {
        throw new Error(`Unsupported System.Account storage at block ${block.height}`)
      }
      if (hdxFree != null && hdxFree > 0n) {
        hdxState.reserve = hdxFree.toString()
      }
    } catch (error) {
      throw new Error(`System.Account HDX reserve read failed at block ${block.height}`, { cause: error })
    }
  }

  if (erc20Gaps.length > 0) {
    const erc20AssetIds = erc20Gaps.map(gap => gap.assetId)
    const evmBalances = await readErc20Balances(block, erc20AssetIds, omnipoolAccount)
    for (let i = 0; i < erc20Gaps.length; i++) {
      if (evmBalances[i] > 0n) {
        assets[erc20Gaps[i].index].reserve = evmBalances[i].toString()
      }
    }
  }

  return assets.sort((a, b) => a.asset_id - b.asset_id)
}

/** Registry id of native HDX, which the Balances pallet holds in `System.Account`. */
export const NATIVE_ASSET_ID = 0

/**
 * Free native (HDX) balance of each account at `block`, from `System.Account`.
 * An account with no entry holds 0.
 */
export async function readNativeFreeBalances(block: Block, accounts: string[]): Promise<bigint[]> {
  if (accounts.length === 0) return []
  if (storage.system.account.v205.is(block)) {
    const infos = await getManyChunked(accounts, page => storage.system.account.v205.getMany(block, page))
    return infos.map(info => info?.data.free ?? 0n)
  }
  if (storage.system.account.v100.is(block)) {
    const infos = await getManyChunked(accounts, page => storage.system.account.v100.getMany(block, page))
    return infos.map(info => info?.data.free ?? 0n)
  }
  throw new Error(`Unsupported System.Account storage at block ${block.height}`)
}

/**
 * An XYK pool's reserves are the pool account's FREE balance of each asset — the
 * pallet's own `free_balance(asset, pool_account)` — and each asset keeps it in a
 * different place: native HDX in `System.Account` (the Balances pallet; there is
 * no `Tokens.Accounts` entry for asset 0 at all), an Erc20 registry asset (HOLLAR,
 * GDOT, the Hydrated stablecoins) in its contract's EVM storage, every other asset
 * in `Tokens.Accounts`. Reading `Tokens.Accounts` for all of them publishes 0 for
 * the HDX side of every HDX pool and the Erc20 side of every Erc20 pool, which the
 * price graph then drops and every LP valuation reads as an empty side.
 */
export async function readXYKState(
  block: Block,
  pools: Array<{ poolAccount: string; assetA: number; assetB: number }>
): Promise<SnapshotXykPoolState[]> {
  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for XYK pools at block ${block.height}`)
  }

  // reserves[i] = [reserveA, reserveB] of pools[i]
  const reserves = pools.map(() => [0n, 0n] as [bigint, bigint])
  const tokenKeys: [string, number][] = []
  const tokenSlots: Array<[number, 0 | 1]> = []
  const nativeAccounts: string[] = []
  const nativeSlots: Array<[number, 0 | 1]> = []
  pools.forEach((pool, index) => {
    ;([pool.assetA, pool.assetB] as const).forEach((assetId, side) => {
      const slot: [number, 0 | 1] = [index, side as 0 | 1]
      if (assetId === NATIVE_ASSET_ID) {
        nativeAccounts.push(pool.poolAccount)
        nativeSlots.push(slot)
      } else {
        tokenKeys.push([pool.poolAccount, assetId])
        tokenSlots.push(slot)
      }
    })
  })

  const [tokenBalances, nativeBalances] = await Promise.all([
    getManyChunked(tokenKeys, page => storage.tokens.accounts.v108.getMany(block, page)),
    readNativeFreeBalances(block, nativeAccounts).catch((error: unknown) => {
      throw new Error(`System.Account HDX reserve read failed for XYK pools at block ${block.height}`, { cause: error })
    }),
  ])
  tokenSlots.forEach(([index, side], i) => { reserves[index][side] = tokenBalances[i]?.free ?? 0n })
  nativeSlots.forEach(([index, side], i) => { reserves[index][side] = nativeBalances[i] })

  // An Erc20 asset has no Tokens balance: read the pool's EVM balance for any side
  // that came back 0 (the Omnipool/Stableswap readers' rule). A 0 from the EVM read
  // means "nothing read", so it never overwrites.
  const erc20Pools = pools
    .map((pool, index) => ({ pool, index }))
    .filter(({ pool, index }) =>
      (reserves[index][0] === 0n && isKnownErc20(pool.assetA)) || (reserves[index][1] === 0n && isKnownErc20(pool.assetB)))
  await forEachConcurrent(erc20Pools, snapshotReadBatchConcurrency(), async ({ pool, index }) => {
    const evmBalances = await readErc20Balances(block, [pool.assetA, pool.assetB], pool.poolAccount)
    for (const side of [0, 1] as const) {
      if (reserves[index][side] === 0n && evmBalances[side] > 0n) reserves[index][side] = evmBalances[side]
    }
  })

  return pools.map((pool, index) => ({
    pool_account: pool.poolAccount,
    asset_a: pool.assetA,
    asset_b: pool.assetB,
    reserve_a: reserves[index][0].toString(),
    reserve_b: reserves[index][1].toString(),
  }))
}

/**
 * Every account an event names, anywhere in its arguments (AccountId32 hex).
 *
 * A pool account's free balance only moves with an event naming it — Tokens,
 * Balances and Currencies report every mutation with the account as `who`/`from`/
 * `to` — but not only with a transfer: `Tokens.Deposited`/`Withdrawn`,
 * `Balances.Deposit`/`Withdraw`/`Endowed`/`DustLost`, `Currencies.Deposited` and
 * the rest move reserves too. The snapshot refreshes the family of every pool
 * account named here, whatever the event.
 */
export function eventAccounts(event: { args?: unknown }): Set<string> {
  const accounts = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      if (value.length === 66 && value.startsWith('0x')) accounts.add(value)
      return
    }
    if (value == null || typeof value !== 'object' || depth > 6) return
    for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item, depth + 1)
  }
  visit(event.args, 0)
  return accounts
}

/**
 * The currency a Tokens / Currencies event moves, when it names one. A stableswap
 * pool's share issuance (`Tokens.TotalIssuance` of the pool id, published as
 * `total_issuance`) changes with a `Deposited`/`Withdrawn` of the share to or from
 * a holder — an event that need not name the pool account.
 */
export function eventCurrencyId(event: { name?: string; args?: unknown }): number | null {
  if (event.name == null || !(event.name.startsWith('Tokens.') || event.name.startsWith('Currencies.'))) return null
  const currencyId = (event.args as { currencyId?: unknown } | undefined)?.currencyId
  return typeof currencyId === 'number' && Number.isSafeInteger(currencyId) ? currencyId : null
}

/**
 * The pool family whose state an event of its own pallet reports a change to.
 * Several of them move snapshot fields with no transfer and no swap beside them —
 * `Omnipool.AssetWeightCapUpdated` (cap), `Omnipool.TradableStateUpdated`
 * (tradable), `Omnipool.PositionDestroyed` from `sacrifice_position`
 * (protocol_shares) — so the swap and transfer triggers alone leave the reused
 * state stale until the family's next trade (measured: every cap of block
 * 6,012,000, the tradable bits of 4,089,600). Every event of the pallet refreshes
 * its family; the pallets emit little besides trades, which refresh it already.
 */
const POOL_PALLET_FAMILIES = new Map<string, 'omnipool' | 'xyk' | 'stableswap'>([
  ['Omnipool', 'omnipool'],
  ['XYK', 'xyk'],
  ['Stableswap', 'stableswap'],
])

export function poolPalletEventFamily(event: { name?: string }): 'omnipool' | 'xyk' | 'stableswap' | null {
  const dot = event.name?.indexOf('.') ?? -1
  if (dot <= 0) return null
  return POOL_PALLET_FAMILIES.get(event.name!.slice(0, dot)) ?? null
}

/**
 * A stableswap pool's amplification at `height`: the pallet's linear ramp from
 * `initialAmplification` at `initialBlock` to `finalAmplification` at `finalBlock`.
 * It moves every block of a ramp with no event, so a reused snapshot state must
 * restate it per block (`refreshAccruingPoolFields`), not carry the refresh block's.
 */
export function stableswapAmplificationAt(
  pool: { initialAmplification: number; finalAmplification: number; initialBlock: number; finalBlock: number },
  height: number,
): bigint {
  try {
    return BigInt(calculate_amplification(
      pool.initialAmplification.toString(),
      pool.finalAmplification.toString(),
      pool.initialBlock.toString(),
      pool.finalBlock.toString(),
      height.toString(),
    ))
  } catch {
    if (height >= pool.finalBlock) return BigInt(pool.finalAmplification)
    if (height <= pool.initialBlock) return BigInt(pool.initialAmplification)
    const totalBlocks = pool.finalBlock - pool.initialBlock
    const elapsedBlocks = height - pool.initialBlock
    return BigInt(pool.initialAmplification) +
      ((BigInt(pool.finalAmplification - pool.initialAmplification) * BigInt(elapsedBlocks)) / BigInt(totalBlocks))
  }
}

let stableswapPegStorageSeen = false

/**
 * Each pool's parameters as `Stableswap.Pools` stores them at `block`, over the
 * caller's (event-maintained) copy: the composition cache's copy has published a
 * new pool's `initial_block`/`final_block` as 0 (PoolCreated carries no block), a
 * fee its storage never held and a ramp it never applied (measured at grid heights
 * 3,640,200, 6,990,000, 8,625,600, 12,561,600). A pool with no storage entry keeps
 * the caller's parameters.
 */
async function withStoredStableswapParams<T extends {
  poolId: number
  initialAmplification: number
  finalAmplification: number
  initialBlock: number
  finalBlock: number
  fee: number
}>(block: Block, pools: T[]): Promise<T[]> {
  if (pools.length === 0 || !storage.stableswap.pools.v183.is(block)) return pools
  const infos = await getManyChunked(pools.map(pool => pool.poolId), page => storage.stableswap.pools.v183.getMany(block, page))
  return pools.map((pool, index) => {
    const info = infos[index]
    if (info == null) return pool
    return {
      ...pool,
      initialAmplification: info.initialAmplification,
      finalAmplification: info.finalAmplification,
      initialBlock: info.initialBlock,
      finalBlock: info.finalBlock,
      fee: info.fee,
    }
  })
}

export async function readStableswapState(
  block: Block,
  cachedPools: Array<{
    poolId: number
    assets: number[]
    initialAmplification: number
    finalAmplification: number
    initialBlock: number
    finalBlock: number
    fee: number
  }>
): Promise<SnapshotStableswapPoolState[]> {
  if (!storage.tokens.accounts.v108.is(block)) {
    throw new Error(`Unsupported Tokens.Accounts storage for Stableswap pools at block ${block.height}`)
  }
  const pools = await withStoredStableswapParams(block, cachedPools)

  const keys: [string, number][] = []
  const poolOffsets: number[] = []

  for (const pool of pools) {
    poolOffsets.push(keys.length)
    const account = getStableswapPoolAccount(pool.poolId)
    for (const assetId of pool.assets) {
      keys.push([account, assetId])
    }
  }

  const balances = await getManyChunked(keys, page => storage.tokens.accounts.v108.getMany(block, page))

  const totalIssuances = new Map<number, bigint>()
  if (!storage.tokens.totalIssuance.v108.is(block)) {
    throw new Error(`Unsupported Tokens.TotalIssuance storage at block ${block.height}`)
  }
  const lpAssetIds = pools.map(pool => pool.poolId)
  const issuances = await getManyChunked(lpAssetIds, page => storage.tokens.totalIssuance.v108.getMany(block, page))
  for (let i = 0; i < lpAssetIds.length; i++) {
    if (issuances[i] != null) {
      totalIssuances.set(lpAssetIds[i], issuances[i]!)
    }
  }

  // Per-pool reads (erc20 reserve gaps + pegs) are independent across pools. Running them
  // sequentially serializes ~one RPC round-trip per pool, which dominates near-head
  // ingestion (no archive gateway to batch from). Fan out with bounded concurrency.
  const result = new Array<SnapshotStableswapPoolState>(pools.length)
  await forEachConcurrent(Array.from(pools.keys()), snapshotReadBatchConcurrency(), async (i) => {
    const pool = pools[i]
    const start = poolOffsets[i]
    const reserves = pool.assets.map((_, reserveIndex) => {
      const balance = balances[start + reserveIndex]
      if (balance?.free != null && balance.free > 0n) {
        return balance.free
      }
      return 0n
    })

    if (pool.assets.some((assetId, index) => reserves[index] === 0n && isKnownErc20(assetId))) {
      const evmBalances = await readErc20Balances(block, pool.assets, getStableswapPoolAccount(pool.poolId))
      for (let reserveIndex = 0; reserveIndex < reserves.length; reserveIndex++) {
        if (reserves[reserveIndex] === 0n && evmBalances[reserveIndex] > 0n) {
          reserves[reserveIndex] = evmBalances[reserveIndex]
        }
      }
    }

    const amplification = stableswapAmplificationAt(pool, block.height)

    let pegMultipliers: [string, string][] | undefined
    try {
      let peg: { current?: Array<[bigint, bigint]> } | undefined
      let pegStorageSupported = false
      if (storage.stableswap.poolPegs.v378.is(block)) {
        pegStorageSupported = true
        peg = await storage.stableswap.poolPegs.v378.get(block, pool.poolId)
      } else if (storage.stableswap.poolPegs.v323.is(block)) {
        pegStorageSupported = true
        peg = await storage.stableswap.poolPegs.v323.get(block, pool.poolId)
      } else if (storage.stableswap.poolPegs.v305.is(block)) {
        pegStorageSupported = true
        peg = await storage.stableswap.poolPegs.v305.get(block, pool.poolId)
      }
      if (!pegStorageSupported && stableswapPegStorageSeen) {
        throw new Error(`Unsupported Stableswap.PoolPegs storage at block ${block.height}`)
      }
      stableswapPegStorageSeen ||= pegStorageSupported
      const currentPeg = peg?.current
      if (currentPeg != null && currentPeg.length > 0) {
        pegMultipliers = currentPeg.map(([numerator, denominator]) => [
          numerator.toString(),
          denominator.toString(),
        ])
      }
    } catch (error) {
      throw new Error(`Stableswap peg read failed at block ${block.height} for pool ${pool.poolId}`, { cause: error })
    }

    result[i] = {
      pool_id: pool.poolId,
      assets: [...pool.assets],
      reserves: reserves.map(reserve => reserve.toString()),
      amplification: amplification.toString(),
      fee: pool.fee,
      total_issuance: totalIssuances.get(pool.poolId)?.toString(),
      peg_multipliers: pegMultipliers,
      initial_amplification: pool.initialAmplification,
      final_amplification: pool.finalAmplification,
      initial_block: pool.initialBlock,
      final_block: pool.finalBlock,
    }
  })

  return result.sort((a, b) => a.pool_id - b.pool_id)
}

/**
 * Restate the fields of a REUSED family that move every block with no event.
 *
 * The raw indexer carries a family's last-read state forward while no trigger
 * fires, which is exact for every storage-backed field but two kinds:
 * - an Erc20 leg: an aToken's balance is its scaled balance times the reserve's
 *   normalized income at the block's timestamp, so it accrues interest every block
 *   (and a plain ERC-20 balance can move by an EVM transfer no Substrate event names);
 * - a stableswap pool's amplification during a ramp (`stableswapAmplificationAt`).
 * Every Erc20 leg of the reused families is re-read in ONE batched EVM storage read
 * (the readers' own rule: a value read replaces the leg, a zero keeps it), and each
 * reused stableswap pool's amplification is recomputed for `block.height`.
 */
export async function refreshAccruingPoolFields(
  block: Block,
  state: Pick<SnapshotState, 'omnipool_account' | 'omnipool_assets' | 'xyk_pools' | 'stableswap_pools'>,
  reused: { omnipool: boolean; xyk: boolean; stableswap: boolean },
): Promise<Pick<SnapshotState, 'omnipool_assets' | 'xyk_pools' | 'stableswap_pools'>> {
  const requests: Array<{ assetIds: number[]; poolAccountHex: string }> = []
  const omnipoolErc20 = reused.omnipool
    ? state.omnipool_assets.map((asset, index) => ({ asset, index })).filter(({ asset }) => isKnownErc20(asset.asset_id))
    : []
  const omnipoolRequest = omnipoolErc20.length > 0
    ? requests.push({ assetIds: omnipoolErc20.map(({ asset }) => asset.asset_id), poolAccountHex: state.omnipool_account }) - 1
    : -1
  const xykRequests = new Map<number, number>()
  if (reused.xyk) {
    state.xyk_pools.forEach((pool, index) => {
      if (!isKnownErc20(pool.asset_a) && !isKnownErc20(pool.asset_b)) return
      xykRequests.set(index, requests.push({ assetIds: [pool.asset_a, pool.asset_b], poolAccountHex: pool.pool_account }) - 1)
    })
  }
  const stableswapRequests = new Map<number, number>()
  if (reused.stableswap) {
    state.stableswap_pools.forEach((pool, index) => {
      if (!pool.assets.some(isKnownErc20)) return
      stableswapRequests.set(index, requests.push({ assetIds: [...pool.assets], poolAccountHex: getStableswapPoolAccount(pool.pool_id) }) - 1)
    })
  }

  const balances = requests.length > 0 ? await readErc20BalancesForHolders(block, requests) : []
  const read = (request: number, index: number): string | null => {
    const value = balances[request][index]
    return value > 0n ? value.toString() : null
  }

  let omnipoolAssets = state.omnipool_assets
  if (omnipoolRequest >= 0) {
    const next = [...state.omnipool_assets]
    let changed = false
    omnipoolErc20.forEach(({ asset, index }, i) => {
      const reserve = read(omnipoolRequest, i)
      if (reserve != null && reserve !== asset.reserve) {
        next[index] = { ...asset, reserve }
        changed = true
      }
    })
    if (changed) omnipoolAssets = next
  }

  let xykPools = state.xyk_pools
  if (xykRequests.size > 0) {
    const next = state.xyk_pools.map((pool, index) => {
      const request = xykRequests.get(index)
      if (request == null) return pool
      const reserveA = isKnownErc20(pool.asset_a) ? read(request, 0) ?? pool.reserve_a : pool.reserve_a
      const reserveB = isKnownErc20(pool.asset_b) ? read(request, 1) ?? pool.reserve_b : pool.reserve_b
      return reserveA === pool.reserve_a && reserveB === pool.reserve_b ? pool : { ...pool, reserve_a: reserveA, reserve_b: reserveB }
    })
    if (next.some((pool, index) => pool !== state.xyk_pools[index])) xykPools = next
  }

  let stableswapPools = state.stableswap_pools
  if (reused.stableswap) {
    const next = state.stableswap_pools.map((pool, index) => {
      const request = stableswapRequests.get(index)
      const reserves = request == null
        ? pool.reserves
        : pool.reserves.map((reserve, i) => (isKnownErc20(pool.assets[i]) ? read(request, i) ?? reserve : reserve))
      const amplification = stableswapAmplificationAt({
        initialAmplification: pool.initial_amplification,
        finalAmplification: pool.final_amplification,
        initialBlock: pool.initial_block,
        finalBlock: pool.final_block,
      }, block.height).toString()
      const same = amplification === pool.amplification && reserves.every((reserve, i) => reserve === pool.reserves[i])
      return same ? pool : { ...pool, reserves, amplification }
    })
    if (next.some((pool, index) => pool !== state.stableswap_pools[index])) stableswapPools = next
  }

  return { omnipool_assets: omnipoolAssets, xyk_pools: xykPools, stableswap_pools: stableswapPools }
}

export function buildSnapshotState(input: {
  assets: AssetMetadata[]
  atokenEquivalences: [number, number][]
  lpEquivalences: [number, number][]
  omnipoolAssets: SnapshotOmnipoolAsset[]
  xykPools: SnapshotXykPoolState[]
  stableswapPools: SnapshotStableswapPoolState[]
}): SnapshotState {
  return {
    assets: [...input.assets].sort((a, b) => a.assetId - b.assetId),
    atoken_equivalences: [...input.atokenEquivalences].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    lp_equivalences: [...input.lpEquivalences].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    omnipool_account: omnipoolAccount,
    omnipool_assets: [...input.omnipoolAssets].sort((a, b) => a.asset_id - b.asset_id),
    xyk_pools: [...input.xykPools].sort((a, b) => a.pool_account.localeCompare(b.pool_account)),
    stableswap_pools: [...input.stableswapPools].sort((a, b) => a.pool_id - b.pool_id),
  }
}

export function buildSnapshotPayload(
  block: { height: number; hash: string; timestamp?: number; specVersion: number },
  state: SnapshotState
): SnapshotPayload {
  return {
    schema_version: 1,
    block: {
      height: block.height,
      hash: block.hash,
      timestamp: toClickHouseDateTime(block.timestamp, block.height),
      spec_version: block.specVersion,
    },
    assets: {
      items: state.assets.map(asset => ({ ...asset })),
      atoken_equivalences: [...state.atoken_equivalences],
      lp_equivalences: [...state.lp_equivalences],
    },
    omnipool: {
      account: state.omnipool_account,
      assets: state.omnipool_assets.map(asset => ({ ...asset })),
    },
    xyk: {
      pools: state.xyk_pools.map(pool => ({ ...pool })),
    },
    stableswap: {
      pools: state.stableswap_pools.map(pool => ({ ...pool })),
    },
  }
}
