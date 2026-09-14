// Chain-shaped primitives every state reader needs: substrate storage-key
// construction, little-endian SCALE integer reads, base58, and Hydration's
// per-asset ERC-20 precompile.
//
// One copy, because these are the pieces where a silent divergence is worst: a
// storage key built from the wrong hash reads as an EMPTY value rather than as
// an error, and a base58 encoder with a different leading-zero rule produces a
// wrong SS58 address that still looks like an address.
//
// A LEAF — no service imports, so any reader can take it.

import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto'
import { u8aConcat, u8aToHex } from '@polkadot/util'

// ───────────────────────── storage keys ─────────────────────────

/** `twox128(pallet) ++ twox128(item)` — the prefix of every storage map/value. */
export const storagePrefix = (pallet: string, item: string): string =>
  u8aToHex(u8aConcat(xxhashAsU8a(pallet, 128), xxhashAsU8a(item, 128)))

/** The Twox64Concat map hasher: `twox64(key) ++ key`. */
export const twox64Concat = (key: Uint8Array): Uint8Array => u8aConcat(xxhashAsU8a(key, 64), key)

/** The Blake2_128Concat map hasher: `blake2_128(key) ++ key`. */
export const blake2128Concat = (key: Uint8Array): Uint8Array => u8aConcat(blake2AsU8a(key, 128), key)

/** SCALE u32, little-endian — the encoded form of an asset id as a map key. */
export const u32Le = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])

// ───────────────────────── SCALE integer reads ─────────────────────────

/** Little-endian u32 at `off`. */
export const u32At = (b: Uint8Array, off: number): number =>
  (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0

/** Little-endian unsigned integer of `bytes` width at `off`. Throws if truncated. */
export function uintAt(b: Uint8Array, off: number, bytes: number): bigint {
  if (off < 0 || off + bytes > b.length) throw new RangeError(`truncated u${bytes * 8}`)
  let n = 0n
  for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[off + i])
  return n
}

export const u64At = (b: Uint8Array, off: number): bigint => uintAt(b, off, 8)
export const u128At = (b: Uint8Array, off: number): bigint => uintAt(b, off, 16)

// ───────────────────────── base58 ─────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Leading zero bytes become leading '1's, as base58check requires — getting that
 * rule wrong yields a plausible-looking but wrong SS58 address rather than an
 * error. An EMPTY input encodes as '1' rather than '', so a malformed-hex source
 * renders as a visible token instead of an empty string.
 */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = BASE58_ALPHABET[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out || '1'
}

/** Null on any character outside the alphabet, never a partial decode. */
export function base58Decode(value: string): Uint8Array | null {
  let n = 0n
  for (const c of value) {
    const i = BASE58_ALPHABET.indexOf(c)
    if (i < 0) return null
    n = n * 58n + BigInt(i)
  }
  const digits: number[] = []
  while (n > 0n) { digits.unshift(Number(n % 256n)); n /= 256n }
  let leading = 0
  for (const c of value) { if (c !== '1') break; leading++ }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...digits])
}

// ───────────────────────── ERC-20 precompile ─────────────────────────

/**
 * Hydration's per-asset ERC-20 precompile: `0x…0001` followed by the 4-byte
 * big-endian registry asset id. `balanceOf` works against it for any currency
 * without knowing a backing contract.
 */
export const erc20Precompile = (assetId: number): string =>
  '0x' + '0'.repeat(31) + '1' + assetId.toString(16).padStart(8, '0')

/** The inverse of `erc20Precompile`; null for any address that is not one. */
export function assetIdFromPrecompile(token: string): number | null {
  const body = (token.startsWith('0x') || token.startsWith('0X') ? token.slice(2) : token).toLowerCase().padStart(64, '0')
  if (!/^0{55}1[0-9a-f]{8}$/.test(body)) return null
  return Number.parseInt(body.slice(-8), 16)
}
