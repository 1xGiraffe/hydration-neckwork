import { u8aConcat, stringToU8a } from '@polkadot/util'
import { blake2AsU8a } from '@polkadot/util-crypto'

// Substrate PalletId to AccountId32 derivation using AccountIdConversion trait.
// Concatenates "modl" prefix (4 bytes) + palletId (8 bytes) + zero-pad to 32 bytes.
// Returns raw concatenation directly -- into_account_truncating does NOT hash.
export function derivePalletAccount(palletId: string): Uint8Array {
  const palletIdBytes = stringToU8a(palletId)
  if (palletIdBytes.length !== 8) {
    throw new Error(`PalletId must be exactly 8 bytes, got ${palletIdBytes.length}`)
  }

  const prefix = stringToU8a('modl')
  const zeroPadding = new Uint8Array(20)
  const preimage = u8aConcat(prefix, palletIdBytes, zeroPadding)

  return preimage
}

// Derives a sub-account from a base account using Substrate's into_sub_account_truncating.
// Used for pool-specific accounts: first 12 bytes of base (modl+palletId) + index LE (4 bytes) + zero padding (16 bytes).
// No hashing.
export function deriveSubAccount(baseAccount: Uint8Array, index: number): Uint8Array {
  if (baseAccount.length !== 32) {
    throw new Error(`Base account must be 32 bytes, got ${baseAccount.length}`)
  }

  const prefix = baseAccount.slice(0, 12)

  const indexBytes = new Uint8Array(4)
  const view = new DataView(indexBytes.buffer)
  view.setUint32(0, index, true)

  const zeroPadding = new Uint8Array(16)

  return u8aConcat(prefix, indexBytes, zeroPadding)
}

let cachedOmnipoolAccount: Uint8Array | null = null

export function deriveOmnipoolAccount(): Uint8Array {
  if (cachedOmnipoolAccount === null) {
    cachedOmnipoolAccount = derivePalletAccount('omnipool')
  }
  return cachedOmnipoolAccount
}

// Stableswap pool accounts use blake2_256(POOL_IDENTIFIER + poolId_u32_LE)
// where POOL_IDENTIFIER = b"sts" (from pallet_stableswap::POOL_IDENTIFIER)
export function deriveStableswapPoolAccount(poolId: number): Uint8Array {
  const identifier = stringToU8a('sts')
  const poolIdBytes = new Uint8Array(4)
  new DataView(poolIdBytes.buffer).setUint32(0, poolId, true)

  return blake2AsU8a(u8aConcat(identifier, poolIdBytes), 256)
}
