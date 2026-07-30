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
 * Batch-read ERC20 balances for multiple assets in a pool.
 * Returns an array of balances in the same order as assetIds.
 */
export async function readErc20Balances(
  block: Block,
  assetIds: number[],
  poolAccountHex: string
): Promise<bigint[]> {
  // For efficiency, batch all storage reads
  const queries: Array<{ index: number; contract: string; storageKey: string; isAToken: boolean }> = []
  const results: bigint[] = new Array(assetIds.length).fill(0n)
  const evmAddr = substrateToEvmAddress(poolAccountHex)

  for (let i = 0; i < assetIds.length; i++) {
    const contract = erc20Contracts.get(assetIds[i])
    if (!contract) continue

    const isAToken = atokenIds.has(assetIds[i])
    const slot = isAToken ? AAVE_USER_STATE_SLOT : ERC20_BALANCE_SLOT
    const storageKey = mappingStorageKey(evmAddr, slot)
    queries.push({ index: i, contract, storageKey, isAToken })
  }

  if (queries.length === 0) return results
  if (!storage.evm.accountStorages.v193.is(block)) {
    throw new Error(`Unsupported EVM.AccountStorages storage at block ${block.height}`)
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

      if (query.isAToken) {
        const fullValue = BigInt('0x' + hex)
        const scaledBalance = fullValue & ((1n << 128n) - 1n)
        const cachedIndex = fullValue >> 128n
        results[query.index] = cachedIndex === 0n ? scaledBalance : (scaledBalance * cachedIndex) / RAY
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
