import { u8aConcat, stringToU8a } from '@polkadot/util'

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

let cachedStableswapBaseAccount: Uint8Array | null = null

export function deriveStableswapPoolAccount(poolId: number): Uint8Array {
  if (cachedStableswapBaseAccount === null) {
    cachedStableswapBaseAccount = derivePalletAccount('stblpool')
  }

  return deriveSubAccount(cachedStableswapBaseAccount, poolId)
}
