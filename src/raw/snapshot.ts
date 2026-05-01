import { calculate_amplification } from '@galacticcouncil/math-stableswap'
import { u8aToHex } from '@polkadot/util'
import { xxhashAsHex } from '@polkadot/util-crypto'
import { deriveOmnipoolAccount, deriveStableswapPoolAccount } from '../util/account.js'
import type { AssetMetadata } from '../registry/types.ts'
import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'
import { isKnownErc20, readErc20Balances } from '../evm/balances.js'
import { toClickHouseDateTime } from './json.js'
import type {
  SnapshotOmnipoolAsset,
  SnapshotPayload,
  SnapshotState,
  SnapshotStableswapPoolState,
  SnapshotXykPoolState,
} from './types.js'

const POOL_STORAGE_PREFIXES = [
  'Omnipool', 'Tokens', 'XYK', 'Stableswap',
].map(name => xxhashAsHex(name, 128).slice(2))

const omnipoolAccount = u8aToHex(deriveOmnipoolAccount())
const stableswapAccountCache = new Map<number, string>()

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
  if (!storage.omnipool.assets.v115.is(block)) return []

  const assetStates = await storage.omnipool.assets.v115.getMany(block, assetIds)

  let balances:
    | (typeof storage.tokens.accounts.v108 extends { getMany: (...args: any[]) => Promise<infer R> } ? R : never)
    | undefined

  if (storage.tokens.accounts.v108.is(block)) {
    try {
      const keys = assetIds.map(assetId => [omnipoolAccount, assetId] as [string, number])
      balances = await storage.tokens.accounts.v108.getMany(block, keys)
    } catch {
      balances = undefined
    }
  }

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
      }
      if (hdxFree != null && hdxFree > 0n) {
        hdxState.reserve = hdxFree.toString()
      }
    } catch {
      // Keep fallback reserve if System.Account read fails.
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

export async function readXYKState(
  block: Block,
  pools: Array<{ poolAccount: string; assetA: number; assetB: number }>
): Promise<SnapshotXykPoolState[]> {
  if (!storage.tokens.accounts.v108.is(block)) return []

  const keys: [string, number][] = []
  for (const pool of pools) {
    keys.push([pool.poolAccount, pool.assetA])
    keys.push([pool.poolAccount, pool.assetB])
  }

  const balances = await storage.tokens.accounts.v108.getMany(block, keys)
  return pools.map((pool, index) => {
    const balanceA = balances[index * 2]
    const balanceB = balances[index * 2 + 1]
    return {
      pool_account: pool.poolAccount,
      asset_a: pool.assetA,
      asset_b: pool.assetB,
      reserve_a: (balanceA?.free ?? 0n).toString(),
      reserve_b: (balanceB?.free ?? 0n).toString(),
    }
  })
}

export async function readStableswapState(
  block: Block,
  pools: Array<{
    poolId: number
    assets: number[]
    initialAmplification: number
    finalAmplification: number
    initialBlock: number
    finalBlock: number
    fee: number
  }>
): Promise<SnapshotStableswapPoolState[]> {
  if (!storage.tokens.accounts.v108.is(block)) return []

  const keys: [string, number][] = []
  const poolOffsets: number[] = []

  for (const pool of pools) {
    poolOffsets.push(keys.length)
    const account = getStableswapPoolAccount(pool.poolId)
    for (const assetId of pool.assets) {
      keys.push([account, assetId])
    }
  }

  const balances = await storage.tokens.accounts.v108.getMany(block, keys)

  const totalIssuances = new Map<number, bigint>()
  if (storage.tokens.totalIssuance.v108.is(block)) {
    const lpAssetIds = pools.map(pool => pool.poolId)
    const issuances = await storage.tokens.totalIssuance.v108.getMany(block, lpAssetIds)
    for (let i = 0; i < lpAssetIds.length; i++) {
      if (issuances[i] != null) {
        totalIssuances.set(lpAssetIds[i], issuances[i]!)
      }
    }
  }

  const result: SnapshotStableswapPoolState[] = []
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i]
    const start = poolOffsets[i]
    const reserves = pool.assets.map((assetId, reserveIndex) => {
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

    let amplification: bigint
    try {
      amplification = BigInt(calculate_amplification(
        pool.initialAmplification.toString(),
        pool.finalAmplification.toString(),
        pool.initialBlock.toString(),
        pool.finalBlock.toString(),
        block.height.toString(),
      ))
    } catch {
      if (block.height >= pool.finalBlock) {
        amplification = BigInt(pool.finalAmplification)
      } else if (block.height <= pool.initialBlock) {
        amplification = BigInt(pool.initialAmplification)
      } else {
        const totalBlocks = pool.finalBlock - pool.initialBlock
        const elapsedBlocks = block.height - pool.initialBlock
        amplification = BigInt(pool.initialAmplification) +
          ((BigInt(pool.finalAmplification - pool.initialAmplification) * BigInt(elapsedBlocks)) / BigInt(totalBlocks))
      }
    }

    let pegMultipliers: [string, string][] | undefined
    try {
      let peg: any
      if (storage.stableswap.poolPegs.v378.is(block)) {
        peg = await storage.stableswap.poolPegs.v378.get(block, pool.poolId)
      } else if (storage.stableswap.poolPegs.v323.is(block)) {
        peg = await storage.stableswap.poolPegs.v323.get(block, pool.poolId)
      } else if (storage.stableswap.poolPegs.v305.is(block)) {
        peg = await storage.stableswap.poolPegs.v305.get(block, pool.poolId)
      }
      if (peg?.current?.length > 0) {
        pegMultipliers = peg.current.map(([numerator, denominator]: [bigint, bigint]) => [
          numerator.toString(),
          denominator.toString(),
        ])
      }
    } catch {
      pegMultipliers = undefined
    }

    result.push({
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
    })
  }

  return result.sort((a, b) => a.pool_id - b.pool_id)
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
      timestamp: toClickHouseDateTime(block.timestamp),
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
