import { u8aToHex, hexToU8a } from '@polkadot/util'
import { keccakAsU8a } from '@polkadot/util-crypto'
import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'

// Standard ERC20 _balances mapping slot (OpenZeppelin ERC20)
const ERC20_BALANCE_SLOT = 3n
// Aave V3 aToken _userState mapping slot
const AAVE_USER_STATE_SLOT = 52n
// Aave V3 Pool `_reserves` mapping slot (PoolStorage, after VersionedInitializable's
// 52 slots — the same offset as the aToken's `_userState`). Verified against
// getReserveNormalizedIncome/getReserveData on the core, GIGAHDX and BIL pools.
const AAVE_POOL_RESERVES_SLOT = 52n
// Word offsets inside a `DataTypes.ReserveData` struct: 1 packs liquidityIndex (low
// 128) | currentLiquidityRate (high 128); 3 packs the (deprecated stable rate or
// deficit, low 128) | lastUpdateTimestamp (uint40) | id; 4 is aTokenAddress.
const RESERVE_WORD_LIQUIDITY = 1n
const RESERVE_WORD_TIMESTAMP = 3n
const RESERVE_WORD_ATOKEN = 4n
// RAY = 1e27 (Aave's fixed-point precision for the liquidity index)
const RAY = 10n ** 27n
const HALF_RAY = RAY / 2n
const SECONDS_PER_YEAR = 31_536_000n
const UINT128_MASK = (1n << 128n) - 1n
const UINT40_MASK = (1n << 40n) - 1n
const UINT160_MASK = (1n << 160n) - 1n

/** The Aave reserve an aToken contract belongs to: its pool proxy and the underlying it was initialized with. */
export interface AtokenReserveRef {
  poolProxy: string
  assetAddress: string
}

// Runtime state: populated from AssetRegistryTracker
let erc20Contracts = new Map<number, string>()
let atokenIds = new Set<number>()
// aToken contract (lowercase) → its reserve, from `atoken_reserve_map`.
let atokenReserves = new Map<string, AtokenReserveRef>()

/**
 * Update the ERC20 contract mappings from the asset registry.
 * Called by the indexer after each registry scan.
 */
export function updateErc20Registry(
  contracts: Map<number, string>,
  aTokenIdSet: Set<number>,
  reserves: Map<string, AtokenReserveRef> = new Map(),
): void {
  erc20Contracts = contracts
  atokenIds = aTokenIdSet
  atokenReserves = new Map([...reserves].map(([atoken, ref]) => [atoken.toLowerCase(), {
    poolProxy: ref.poolProxy.toLowerCase(),
    assetAddress: ref.assetAddress.toLowerCase(),
  }]))
}

/**
 * Compute the EVM storage key for a Solidity mapping(address => ...) at a given slot.
 * storage_key = keccak256(abi.encode(address, slot))
 */
function mappingStorageKey(evmAddress: string, slot: bigint): string {
  const addrPadded = evmAddress.replace('0x', '').padStart(64, '0')
  const slotPadded = slot.toString(16).padStart(64, '0')
  return u8aToHex(keccakAsU8a(hexToU8a('0x' + addrPadded + slotPadded)))
}

/** Storage key of word `offset` of a struct stored at `mappingStorageKey(key, slot)`. */
function mappingStructWordKey(evmAddress: string, slot: bigint, offset: bigint): string {
  const base = BigInt(mappingStorageKey(evmAddress, slot))
  return '0x' + ((base + offset) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0')
}

/**
 * Convert a Substrate AccountId32 to an EVM H160 address.
 * Hydration uses truncation: first 20 bytes of the 32-byte account.
 */
function substrateToEvmAddress(accountHex: string): string {
  // accountHex is 0x-prefixed, 66 chars (32 bytes)
  return accountHex.slice(0, 42) // 0x + 40 hex chars = 20 bytes
}

/** The SCALED balance half of an Aave V3 `_userState` word (`UserState.balance`, low 128 bits). */
export function scaledBalanceFromUserState(word: bigint): bigint {
  return word & UINT128_MASK
}

/**
 * ReserveLogic.getNormalizedIncome from the reserve's two storage words at `timestampSec`
 * (the EVM's block.timestamp): liquidityIndex when the reserve was updated at that
 * second, else rayMul(calculateLinearInterest(rate, lastUpdate, t), liquidityIndex).
 * `null` when the words describe no initialized reserve (a zero index).
 */
export function normalizedIncomeFromReserveWords(
  liquidityWord: bigint,
  timestampWord: bigint,
  timestampSec: bigint,
): bigint | null {
  const liquidityIndex = liquidityWord & UINT128_MASK
  const liquidityRate = liquidityWord >> 128n
  const lastUpdate = (timestampWord >> 128n) & UINT40_MASK
  if (liquidityIndex === 0n) return null
  if (timestampSec <= lastUpdate) return liquidityIndex
  const linear = RAY + (liquidityRate * (timestampSec - lastUpdate)) / SECONDS_PER_YEAR
  return (linear * liquidityIndex + HALF_RAY) / RAY
}

/**
 * Underlying-unit balance — what the aToken's `balanceOf` returns — from the holder's
 * `_userState` word and the reserve's normalized income at the same block:
 * rayMul(scaledBalance, normalizedIncome), Aave's half-up rounding.
 *
 * The word's HIGH half (`additionalData`) is the liquidity index at the holder's
 * last mint or burn, NOT the current one — a transfer never refreshes it and interest
 * keeps accruing after it — so it is deliberately ignored: converting with it
 * understates every aToken reserve by the interest since the holder's last mint/burn.
 */
export function atokenBalanceFromUserState(word: bigint, normalizedIncome: bigint): bigint {
  const scaledBalance = scaledBalanceFromUserState(word)
  if (scaledBalance === 0n) return 0n
  return (scaledBalance * normalizedIncome + HALF_RAY) / RAY
}

function blockTimestampSeconds(block: Block): bigint | null {
  const timestamp = (block as Block & { timestamp?: number }).timestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null
  return BigInt(Math.floor(timestamp / 1000))
}

function warnAtokenUnusable(block: Block, assetId: number, contract: string, reason: string): void {
  console.warn(JSON.stringify({
    type: 'atoken_user_state_unusable',
    block: block.height,
    asset_id: assetId,
    contract,
    reason,
  }))
}

/**
 * Batch-read ERC20 balances for multiple assets in a pool.
 * Returns an array of balances in the same order as assetIds.
 *
 * An aToken's entry is its `balanceOf` at the block: the holder's scaled balance
 * times its reserve's normalized income at the block's timestamp, both read from
 * EVM storage in the same batch (the Pool's `_reserves` words for the reserve named
 * by `atoken_reserve_map`, with the reserve's aTokenAddress checked against the
 * contract). An aToken whose reserve is unknown or unreadable yields no value.
 *
 * A zero entry means "no value read" — every caller keeps its existing
 * substrate-side reserve for that asset rather than writing the zero.
 */
export async function readErc20Balances(
  block: Block,
  assetIds: number[],
  poolAccountHex: string
): Promise<bigint[]> {
  // For efficiency, batch all storage reads
  const queries: Array<{ index: number; contract: string; storageKey: string; reserve: AtokenReserveRef | null; isAToken: boolean }> = []
  const results: bigint[] = new Array(assetIds.length).fill(0n)
  const evmAddr = substrateToEvmAddress(poolAccountHex)

  for (let i = 0; i < assetIds.length; i++) {
    const contract = erc20Contracts.get(assetIds[i])
    if (!contract) continue

    const isAToken = atokenIds.has(assetIds[i])
    const slot = isAToken ? AAVE_USER_STATE_SLOT : ERC20_BALANCE_SLOT
    const storageKey = mappingStorageKey(evmAddr, slot)
    const reserve = isAToken ? atokenReserves.get(contract.toLowerCase()) ?? null : null
    queries.push({ index: i, contract, storageKey, reserve, isAToken })
  }

  if (queries.length === 0) return results
  if (!storage.evm.accountStorages.v193.is(block)) {
    throw new Error(`Unsupported EVM.AccountStorages storage at block ${block.height}`)
  }

  // One set of reserve words per distinct (pool, underlying), appended after the
  // balance keys so a single getMany serves both.
  const reserveKeyOffset = new Map<string, number>()
  const keys: [string, string][] = queries.map(q => [q.contract, q.storageKey])
  for (const query of queries) {
    if (query.reserve == null) continue
    const reserveKey = `${query.reserve.poolProxy}:${query.reserve.assetAddress}`
    if (reserveKeyOffset.has(reserveKey)) continue
    reserveKeyOffset.set(reserveKey, keys.length)
    for (const offset of [RESERVE_WORD_LIQUIDITY, RESERVE_WORD_TIMESTAMP, RESERVE_WORD_ATOKEN]) {
      keys.push([query.reserve.poolProxy, mappingStructWordKey(query.reserve.assetAddress, AAVE_POOL_RESERVES_SLOT, offset)])
    }
  }

  const timestampSec = blockTimestampSeconds(block)

  try {
    const rawValues = await storage.evm.accountStorages.v193.getMany(block, keys)
    const word = (raw: unknown): bigint => {
      const hex = typeof raw === 'string' ? raw.replace('0x', '') : ''
      return hex ? BigInt('0x' + hex) : 0n
    }

    for (let qi = 0; qi < queries.length; qi++) {
      const raw = rawValues[qi]
      if (!raw) continue

      const hex = typeof raw === 'string' ? raw.replace('0x', '') : ''
      if (!hex || hex === '0'.repeat(64)) continue

      const query = queries[qi]
      const assetId = assetIds[query.index]

      if (query.isAToken) {
        const userState = BigInt('0x' + hex)
        if (scaledBalanceFromUserState(userState) === 0n) continue
        if (query.reserve == null) {
          warnAtokenUnusable(block, assetId, query.contract, 'aToken has no reserve in atoken_reserve_map')
          continue
        }
        if (timestampSec == null) {
          warnAtokenUnusable(block, assetId, query.contract, 'block carries no timestamp to accrue the liquidity index to')
          continue
        }
        const offset = reserveKeyOffset.get(`${query.reserve.poolProxy}:${query.reserve.assetAddress}`)!
        const reserveAtoken = word(rawValues[offset + 2]) & UINT160_MASK
        if (reserveAtoken !== BigInt(query.contract)) {
          warnAtokenUnusable(block, assetId, query.contract, `pool reserve names aToken 0x${reserveAtoken.toString(16).padStart(40, '0')}`)
          continue
        }
        const income = normalizedIncomeFromReserveWords(word(rawValues[offset]), word(rawValues[offset + 1]), timestampSec)
        if (income == null) {
          warnAtokenUnusable(block, assetId, query.contract, 'reserve has no liquidity index')
          continue
        }
        results[query.index] = atokenBalanceFromUserState(userState, income)
      } else {
        results[query.index] = BigInt('0x' + hex)
      }
    }
  } catch (error) {
    throw new Error(`Failed to read ERC20 balances at block ${block.height}`, { cause: error })
  }

  return results
}

/**
 * Check if an asset is a known ERC20 (has a registered contract address).
 */
export function isKnownErc20(assetId: number): boolean {
  return erc20Contracts.has(assetId)
}
