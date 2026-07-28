import { signatureVerify, keccakAsU8a, secp256k1Recover, ethereumEncode } from '@polkadot/util-crypto'
import { hexToU8a, u8aConcat, stringToU8a } from '@polkadot/util'

// Wallet login: the user proves control of an address by signing a plain-text
// statement (no transaction, no fee). Substrate extensions sign via signRaw
// (wrapping the payload in <Bytes>…</Bytes> — signatureVerify tries both forms);
// EVM wallets sign via personal_sign (EIP-191 prefix + keccak + secp256k1).

export interface LoginChallenge { nonce: string; message: string }

export function buildLoginMessage(host: string, address: string, ss58Polkadot: string, nonce: string, issuedAt: string): string {
  return [
    `${host} wants you to sign in`,
    '',
    'This signature only proves account ownership — no transaction is sent and no fee is paid.',
    '',
    `Address: ${address}`,
    `Account: ${ss58Polkadot}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

// personal_sign recovery: hash the EIP-191 envelope, recover the secp256k1
// pubkey from the 65-byte r||s||v signature, derive the H160. Wallets emit
// v = 27/28; raw libraries emit 0/1 — accept both.
//
// secp256k1Recover's `hashType` only picks the OUTPUT pubkey encoding
// (compressed 33 bytes vs. an "expanded" 64-byte X||Y with no 0x04 prefix,
// which ethereumEncode rejects); it never re-hashes `msgHash`. We already
// pass the correct final digest, so omit hashType and get the compressed
// form that ethereumEncode accepts directly.
export function evmRecoverAddress(message: string, signature: string): string | null {
  let sig: Uint8Array
  try { sig = hexToU8a(signature) } catch { return null }
  if (sig.length !== 65) return null
  const v = sig[64]
  const recovery = v >= 27 ? v - 27 : v
  if (recovery !== 0 && recovery !== 1) return null
  const msgBytes = stringToU8a(message)
  const hash = keccakAsU8a(u8aConcat(stringToU8a(`\x19Ethereum Signed Message:\n${msgBytes.length}`), msgBytes))
  try {
    const pubkey = secp256k1Recover(hash, sig.subarray(0, 64), recovery)
    return ethereumEncode(pubkey).toLowerCase()
  } catch { return null }
}

// One verifier for both worlds, keyed on the address SHAPE the wallet reported.
export function verifySignedLogin(message: string, address: string, signature: string): boolean {
  if (EVM_ADDR_RE.test(address)) {
    return evmRecoverAddress(message, signature) === address.toLowerCase()
  }
  try {
    return signatureVerify(message, signature, address).isValid
  } catch { return false }
}
