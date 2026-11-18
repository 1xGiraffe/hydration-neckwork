import { decodeAddress, encodeAddress } from 'dedot/utils'

// An account's SS58 in the Polkadot format (prefix 0), the one form the explorer
// shows and links every substrate account in. Wallet extensions hand accounts over
// in the generic format (prefix 42, "5…") or their own; this re-spells them. Loaded
// on its own (a dynamic import) by the wallet and follow lists, so a page that never
// sees a wallet account carries none of it.

/** The Polkadot-format SS58 of an SS58 address of any prefix or a 32-byte hex account id; null for anything else (an H160 included). */
export function toPolkadotAddress(address: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  try {
    return encodeAddress(decodeAddress(address), 0)
  } catch {
    return null
  }
}
