import { describe, it, expect, beforeAll } from 'vitest'
import {
  cryptoWaitReady, sr25519PairFromSeed, sr25519Sign, ed25519PairFromSeed, ed25519Sign,
  secp256k1PairFromSeed, secp256k1Sign, encodeAddress, ethereumEncode, randomAsU8a,
} from '@polkadot/util-crypto'
import { u8aToHex, u8aWrapBytes, u8aConcat, stringToU8a } from '@polkadot/util'
import { buildLoginMessage, evmRecoverAddress, verifySignedLogin } from '../src/services/userAuthService.ts'

beforeAll(async () => { await cryptoWaitReady() })

const NONCE = 'a'.repeat(32)
const ISSUED = '2026-07-28T12:00:00.000Z'

describe('buildLoginMessage', () => {
  it('binds host, address, nonce, and time into a readable statement', () => {
    const msg = buildLoginMessage('explorer.example.org', '15DajY…', '15DajY…', NONCE, ISSUED)
    expect(msg).toContain('explorer.example.org wants you to sign in')
    expect(msg).toContain(`Nonce: ${NONCE}`)
    expect(msg).toContain(`Issued At: ${ISSUED}`)
    expect(msg).toContain('no transaction')
  })
})

describe('verifySignedLogin (substrate)', () => {
  it('accepts an sr25519 signature over the wrapped message (extension signRaw shape)', () => {
    const pair = sr25519PairFromSeed(randomAsU8a(32))
    const address = encodeAddress(pair.publicKey, 0)
    const msg = buildLoginMessage('h', address, address, NONCE, ISSUED)
    // Browser extensions wrap raw payloads in <Bytes>…</Bytes> before signing.
    const sig = u8aToHex(sr25519Sign(u8aWrapBytes(msg), pair))
    expect(verifySignedLogin(msg, address, sig)).toBe(true)
  })

  it('accepts ed25519 and rejects a signature from a different key', () => {
    const pair = ed25519PairFromSeed(randomAsU8a(32))
    const other = ed25519PairFromSeed(randomAsU8a(32))
    const address = encodeAddress(pair.publicKey, 0)
    const msg = buildLoginMessage('h', address, address, NONCE, ISSUED)
    expect(verifySignedLogin(msg, address, u8aToHex(ed25519Sign(u8aWrapBytes(msg), pair)))).toBe(true)
    expect(verifySignedLogin(msg, address, u8aToHex(ed25519Sign(u8aWrapBytes(msg), other)))).toBe(false)
  })

  it('rejects a valid signature over a DIFFERENT message', () => {
    const pair = sr25519PairFromSeed(randomAsU8a(32))
    const address = encodeAddress(pair.publicKey, 0)
    const sig = u8aToHex(sr25519Sign(u8aWrapBytes('something else'), pair))
    expect(verifySignedLogin(buildLoginMessage('h', address, address, NONCE, ISSUED), address, sig)).toBe(false)
  })
})

describe('evmRecoverAddress (personal_sign / EIP-191)', () => {
  // Sign exactly like an EVM wallet: keccak over "\x19Ethereum Signed Message:\n<len><msg>".
  // secp256k1Sign hashes its `message` argument itself (per `hashType`), so we
  // pass the EIP-191 preimage — not a pre-hashed digest — the same way a wallet
  // hashes-then-signs in one step; passing an already-hashed digest here would
  // double-hash and produce a signature that recovers to the wrong address.
  function personalSign(message: string, seed: Uint8Array): { address: string; signature: string } {
    const pair = secp256k1PairFromSeed(seed)
    const msgBytes = stringToU8a(message)
    const preimage = u8aConcat(stringToU8a(`\x19Ethereum Signed Message:\n${msgBytes.length}`), msgBytes)
    const sig = secp256k1Sign(preimage, pair, 'keccak')   // 65 bytes, recovery id at [64] as 0/1
    // Wallets put v = 27/28; exercise that normalization too.
    const withV27 = new Uint8Array(sig); withV27[64] = sig[64] + 27
    return { address: ethereumEncode(pair.publicKey).toLowerCase(), signature: u8aToHex(withV27) }
  }

  it('recovers the signing address from a personal_sign signature', () => {
    const msg = buildLoginMessage('h', '0xabc', '5xyz', NONCE, ISSUED)
    const { address, signature } = personalSign(msg, randomAsU8a(32))
    expect(evmRecoverAddress(msg, signature)).toBe(address)
    expect(verifySignedLogin(msg, address, signature)).toBe(true)
  })

  it('returns null for garbage and mismatched claims fail verification', () => {
    const msg = buildLoginMessage('h', '0xabc', '5xyz', NONCE, ISSUED)
    expect(evmRecoverAddress(msg, '0x1234')).toBeNull()
    const { signature } = personalSign(msg, randomAsU8a(32))
    expect(verifySignedLogin(msg, '0x' + '11'.repeat(20), signature)).toBe(false)
  })
})
