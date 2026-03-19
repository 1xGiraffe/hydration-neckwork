import { u8aToHex, hexToU8a } from '@polkadot/util'
import { keccakAsU8a } from '@polkadot/util-crypto'
import type { Block } from '../types/support.ts'
import * as storage from '../types/storage.ts'

// Standard ERC20 _balances mapping slot (OpenZeppelin ERC20)
const ERC20_BALANCE_SLOT = 3n
// Aave V3 aToken _userState mapping slot
const AAVE_USER_STATE_SLOT = 52n
// RAY = 1e27 (Aave's fixed-point precision for the liquidity index)
const RAY = 10n ** 27n

// Runtime state: populated from AssetRegistryTracker
let erc20Contracts = new Map<number, string>()
let atokenIds = new Set<number>()

/**
 * Update the ERC20 contract mappings from the asset registry.
 * Called by the indexer after each registry scan.
 */
export function updateErc20Registry(
  contracts: Map<number, string>,
  aTokenIdSet: Set<number>
): void {
  erc20Contracts = contracts
  atokenIds = aTokenIdSet
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

/**
 * Convert a Substrate AccountId32 to an EVM H160 address.
 * Hydration uses truncation: first 20 bytes of the 32-byte account.
 */
function substrateToEvmAddress(accountHex: string): string {
  // accountHex is 0x-prefixed, 66 chars (32 bytes)
  return accountHex.slice(0, 42) // 0x + 40 hex chars = 20 bytes
}

/**
 * Read ERC20 token balance from EVM.AccountStorages via SQD.
 *
 * For standard ERC20: reads _balances[account] at slot 3.
 * For Aave aTokens: reads _userState[account] at slot 52,
 * extracts scaledBalance (lower 128 bits) and cached liquidity index
 * (upper 128 bits), then computes: scaledBalance * index / 1e27.
 *
 * Returns the balance in native token units, or 0n if not readable.
 */
export async function readErc20Balance(
  block: Block,
  assetId: number,
  poolAccountHex: string
): Promise<bigint> {
  const contractAddr = erc20Contracts.get(assetId)
  if (!contractAddr) return 0n

  if (!storage.evm.accountStorages.v193.is(block)) return 0n

  const evmAddr = substrateToEvmAddress(poolAccountHex)
  const isAToken = atokenIds.has(assetId)
  const slot = isAToken ? AAVE_USER_STATE_SLOT : ERC20_BALANCE_SLOT

  const storageKey = mappingStorageKey(evmAddr, slot)

  try {
    const raw = await storage.evm.accountStorages.v193.get(block, contractAddr, storageKey)
    if (!raw) return 0n

    const hex = typeof raw === 'string' ? raw.replace('0x', '') : ''
    if (!hex || hex === '0'.repeat(64)) return 0n

    if (isAToken) {
      // Aave V3 UserState packing: lower 128 bits = scaledBalance, upper 128 bits = cached data
      // The upper 128 bits contain the liquidity index at time of last interaction
      const fullValue = BigInt('0x' + hex)
      const scaledBalance = fullValue & ((1n << 128n) - 1n)
      const cachedIndex = fullValue >> 128n

      if (cachedIndex === 0n) return scaledBalance
      return (scaledBalance * cachedIndex) / RAY
    } else {
      // Standard ERC20: direct balance value
      return BigInt('0x' + hex)
    }
  } catch {
    return 0n
  }
}

/**
 * Batch-read ERC20 balances for multiple assets in a pool.
 * Returns an array of balances in the same order as assetIds.
 */
export async function readErc20Balances(
  block: Block,
  assetIds: number[],
  poolAccountHex: string
): Promise<bigint[]> {
  // For efficiency, batch all storage reads
  const queries: Array<{ assetId: number; contract: string; storageKey: string; isAToken: boolean }> = []
  const results: bigint[] = new Array(assetIds.length).fill(0n)

  for (let i = 0; i < assetIds.length; i++) {
    const contract = erc20Contracts.get(assetIds[i])
    if (!contract) continue

    const isAToken = atokenIds.has(assetIds[i])
    const slot = isAToken ? AAVE_USER_STATE_SLOT : ERC20_BALANCE_SLOT
    const evmAddr = substrateToEvmAddress(poolAccountHex)
    const storageKey = mappingStorageKey(evmAddr, slot)
    queries.push({ assetId: assetIds[i], contract, storageKey, isAToken })
  }

  if (queries.length === 0 || !storage.evm.accountStorages.v193.is(block)) {
    return results
  }

  try {
    const keys: [string, string][] = queries.map(q => [q.contract, q.storageKey])
    const rawValues = await storage.evm.accountStorages.v193.getMany(block, keys)

    for (let qi = 0; qi < queries.length; qi++) {
      const raw = rawValues[qi]
      if (!raw) continue

      const hex = typeof raw === 'string' ? raw.replace('0x', '') : ''
      if (!hex || hex === '0'.repeat(64)) continue

      const query = queries[qi]
      const idx = assetIds.indexOf(query.assetId)
      if (idx < 0) continue

      if (query.isAToken) {
        const fullValue = BigInt('0x' + hex)
        const scaledBalance = fullValue & ((1n << 128n) - 1n)
        const cachedIndex = fullValue >> 128n
        results[idx] = cachedIndex === 0n ? scaledBalance : (scaledBalance * cachedIndex) / RAY
      } else {
        results[idx] = BigInt('0x' + hex)
      }
    }
  } catch (error) {
    console.error(`[EVM] Failed to read ERC20 balances at block ${block.height}:`, error)
  }

  return results
}

/**
 * Check if an asset is a known ERC20 (has a registered contract address).
 */
export function isKnownErc20(assetId: number): boolean {
  return erc20Contracts.has(assetId)
}
