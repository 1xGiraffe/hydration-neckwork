import { describe, it, expect } from 'vitest'
import {
  derivePalletAccount,
  deriveSubAccount,
  deriveOmnipoolAccount,
  deriveStableswapPoolAccount,
} from '../../src/util/account.ts'
import { u8aToHex } from '@polkadot/util'

describe('derivePalletAccount', () => {
  it('returns 32-byte Uint8Array for "omnipool"', () => {
    const account = derivePalletAccount('omnipool')
    expect(account).toBeInstanceOf(Uint8Array)
    expect(account.length).toBe(32)
  })

  it('returns 32-byte Uint8Array for "stblpool"', () => {
    const account = derivePalletAccount('stblpool')
    expect(account).toBeInstanceOf(Uint8Array)
    expect(account.length).toBe(32)
  })

  it('produces different accounts for different pallet IDs', () => {
    const omnipoolAccount = derivePalletAccount('omnipool')
    const stableswapAccount = derivePalletAccount('stblpool')

    // Convert to hex for comparison
    const omnipoolHex = u8aToHex(omnipoolAccount)
    const stableswapHex = u8aToHex(stableswapAccount)

    expect(omnipoolHex).not.toBe(stableswapHex)
  })

  it('is deterministic - same input produces same output', () => {
    const account1 = derivePalletAccount('omnipool')
    const account2 = derivePalletAccount('omnipool')

    expect(u8aToHex(account1)).toBe(u8aToHex(account2))
  })

  it('throws error if pallet ID is not exactly 8 bytes', () => {
    expect(() => derivePalletAccount('short')).toThrow('must be exactly 8 bytes')
    expect(() => derivePalletAccount('toolongpalletid')).toThrow('must be exactly 8 bytes')
  })

  it('produces non-zero result (actual derivation, not empty bytes)', () => {
    const account = derivePalletAccount('omnipool')
    const isAllZeros = account.every(byte => byte === 0)
    expect(isAllZeros).toBe(false)
  })

  it('produces correct raw preimage structure (no hashing)', () => {
    const account = derivePalletAccount('omnipool')
    const hex = u8aToHex(account)
    // "modl" (4 bytes) + "omnipool" (8 bytes) + 20 zero bytes = raw preimage
    expect(hex).toBe('0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000')
  })
})

describe('deriveSubAccount', () => {
  it('returns 32-byte Uint8Array', () => {
    const baseAccount = new Uint8Array(32)
    const subAccount = deriveSubAccount(baseAccount, 100)

    expect(subAccount).toBeInstanceOf(Uint8Array)
    expect(subAccount.length).toBe(32)
  })

  it('produces different accounts for different pool IDs', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const pool0 = deriveSubAccount(baseAccount, 0)
    const pool100 = deriveSubAccount(baseAccount, 100)

    expect(u8aToHex(pool0)).not.toBe(u8aToHex(pool100))
  })

  it('pool ID 0 and pool ID 100 produce distinct accounts', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const pool0 = deriveSubAccount(baseAccount, 0)
    const pool100 = deriveSubAccount(baseAccount, 100)
    const pool101 = deriveSubAccount(baseAccount, 101)

    const hex0 = u8aToHex(pool0)
    const hex100 = u8aToHex(pool100)
    const hex101 = u8aToHex(pool101)

    expect(hex0).not.toBe(hex100)
    expect(hex100).not.toBe(hex101)
    expect(hex0).not.toBe(hex101)
  })

  it('is deterministic - same inputs produce same output', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const sub1 = deriveSubAccount(baseAccount, 100)
    const sub2 = deriveSubAccount(baseAccount, 100)

    expect(u8aToHex(sub1)).toBe(u8aToHex(sub2))
  })

  it('throws error if base account is not 32 bytes', () => {
    const shortAccount = new Uint8Array(16)
    expect(() => deriveSubAccount(shortAccount, 100)).toThrow('must be 32 bytes')
  })

  it('produces non-zero result (actual derivation, not empty bytes)', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const subAccount = deriveSubAccount(baseAccount, 100)
    const isAllZeros = subAccount.every(byte => byte === 0)
    expect(isAllZeros).toBe(false)
  })

  it('produces correct raw preimage structure (no hashing)', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const subAccount = deriveSubAccount(baseAccount, 100)
    const hex = u8aToHex(subAccount)
    // "modl" (4) + "stblpool" (8) + 100 as u32 LE (64000000) + 16 zero bytes
    expect(hex).toBe('0x6d6f646c7374626c706f6f6c6400000000000000000000000000000000000000')
  })
})

describe('deriveOmnipoolAccount', () => {
  it('returns 32-byte Uint8Array', () => {
    const account = deriveOmnipoolAccount()
    expect(account).toBeInstanceOf(Uint8Array)
    expect(account.length).toBe(32)
  })

  it('returns same result on repeated calls (caching works)', () => {
    const account1 = deriveOmnipoolAccount()
    const account2 = deriveOmnipoolAccount()
    const account3 = deriveOmnipoolAccount()

    // Same instance (cache hit)
    expect(account1).toBe(account2)
    expect(account2).toBe(account3)
  })

  it('result is NOT all zeros (actual derivation produced)', () => {
    const account = deriveOmnipoolAccount()
    const isAllZeros = account.every(byte => byte === 0)
    expect(isAllZeros).toBe(false)
  })

  it('matches known Omnipool sovereign account (cross-validation)', () => {
    const account = deriveOmnipoolAccount()
    const accountHex = u8aToHex(account)

    // Known Omnipool sovereign account from Substrate's AccountIdConversion
    // Derived from PalletId(*b"omnipool")
    // Correct value is the raw preimage (no blake2 hash)
    const knownOmnipoolAccount = '0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000'

    expect(accountHex).toBe(knownOmnipoolAccount)
  })
})

describe('deriveStableswapPoolAccount', () => {
  it('returns 32-byte Uint8Array for pool ID 100', () => {
    const account = deriveStableswapPoolAccount(100)
    expect(account).toBeInstanceOf(Uint8Array)
    expect(account.length).toBe(32)
  })

  it('different pool IDs produce different accounts', () => {
    const pool100 = deriveStableswapPoolAccount(100)
    const pool101 = deriveStableswapPoolAccount(101)
    const pool0 = deriveStableswapPoolAccount(0)

    const hex100 = u8aToHex(pool100)
    const hex101 = u8aToHex(pool101)
    const hex0 = u8aToHex(pool0)

    expect(hex100).not.toBe(hex101)
    expect(hex100).not.toBe(hex0)
    expect(hex101).not.toBe(hex0)
  })

  it('result differs from base stableswap pallet account', () => {
    const baseAccount = derivePalletAccount('stblpool')
    const poolAccount = deriveStableswapPoolAccount(100)

    expect(u8aToHex(baseAccount)).not.toBe(u8aToHex(poolAccount))
  })

  it('is deterministic - same pool ID produces same account', () => {
    const account1 = deriveStableswapPoolAccount(100)
    const account2 = deriveStableswapPoolAccount(100)

    expect(u8aToHex(account1)).toBe(u8aToHex(account2))
  })

  it('result is NOT all zeros (actual derivation produced)', () => {
    const account = deriveStableswapPoolAccount(100)
    const isAllZeros = account.every(byte => byte === 0)
    expect(isAllZeros).toBe(false)
  })
})

describe('Cross-validation suite', () => {
  it('Omnipool account derivation matches Substrate reference implementation', () => {
    // This test validates that our derivation matches Substrate's AccountIdConversion trait
    //
    // Substrate implementation (into_account_truncating):
    // 1. "modl" prefix (4 bytes: 0x6d6f646c)
    // 2. PalletId bytes (8 bytes: "omnipool")
    // 3. Zero padding (20 bytes)
    // 4. Returns concatenation directly (NO blake2 hash)
    //
    // Expected: 0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000

    const omnipoolAccount = deriveOmnipoolAccount()
    const hex = u8aToHex(omnipoolAccount)

    expect(hex).toBe('0x6d6f646c6f6d6e69706f6f6c0000000000000000000000000000000000000000')
  })

  it('derivePalletAccount and deriveOmnipoolAccount are consistent', () => {
    const directDerivation = derivePalletAccount('omnipool')
    const cachedDerivation = deriveOmnipoolAccount()

    expect(u8aToHex(directDerivation)).toBe(u8aToHex(cachedDerivation))
  })

  it('all derivation functions produce valid 32-byte AccountId32', () => {
    const omnipool = deriveOmnipoolAccount()
    const stableswapBase = derivePalletAccount('stblpool')
    const stableswapPool = deriveStableswapPoolAccount(0)

    expect(omnipool.length).toBe(32)
    expect(stableswapBase.length).toBe(32)
    expect(stableswapPool.length).toBe(32)

    // All should be Uint8Array instances
    expect(omnipool).toBeInstanceOf(Uint8Array)
    expect(stableswapBase).toBeInstanceOf(Uint8Array)
    expect(stableswapPool).toBeInstanceOf(Uint8Array)
  })
})
