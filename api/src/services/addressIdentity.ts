import { hydrationAddress, polkadotAddress, accountIdHex } from './omniwatchIdentity.ts'

// Hydration's EVM accounts are represented inside Substrate storage as a
// "truncated" AccountId32: the marker bytes "ETH\0" (0x45544800), the 20-byte
// H160, then 8 zero bytes. Detecting/constructing this lets us bridge an EVM
// address to the account_id used in raw_balance_observations / money market.
const EVM_MARKER = '45544800'
const ZERO16 = '0000000000000000'

export type AddressKind = 'substrate' | 'evm' | 'unknown'

export interface NormalizedAddress {
  input: string
  kind: AddressKind
  accountId: string           // canonical 0x + 64 hex AccountId32 (join key)
  evmAddress: string | null   // 0x + 40 hex H160, when EVM-related
  ss58: string | null         // Hydration SS58 (prefix 63)
  ss58Polkadot: string | null // Polkadot SS58 (prefix 0)
  isEvmTruncated: boolean      // accountId is the ETH-marker truncated form
}

function evmTruncatedAccountId(h160NoPrefix: string): string {
  return '0x' + EVM_MARKER + h160NoPrefix.toLowerCase() + ZERO16
}

// Reserved substrate account prefixes: pallet ('modl'), sibling parachain
// ('sibl') and parachain ('para') accounts are 20 meaningful bytes + 12 zero
// bytes. An H160 carrying one of these is the runtime's TRUNCATION of that
// module/sovereign account — not a real EVM account — and the full AccountId32
// is recovered exactly by padding the H160 with 12 zero bytes.
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261']
export function reservedH160AccountId(h160NoPrefix: string): string | null {
  const h = h160NoPrefix.toLowerCase()
  return RESERVED_H160_PREFIXES.some(p => h.startsWith(p)) ? '0x' + h + '000000000000000000000000' : null
}

function fromAccountId(input: string, acc: string): NormalizedAddress {
  const isTrunc = acc.slice(2, 10) === EVM_MARKER && acc.slice(50) === ZERO16
  // ETH-prefixed form of a module/sovereign account → resolve to the real one.
  if (isTrunc) {
    const reserved = reservedH160AccountId(acc.slice(10, 50))
    if (reserved) return fromAccountId(input, reserved)
  }
  const evm = isTrunc ? '0x' + acc.slice(10, 50) : null
  return {
    input,
    kind: isTrunc ? 'evm' : 'substrate',
    accountId: acc,
    evmAddress: evm,
    ss58: hydrationAddress(acc),
    ss58Polkadot: polkadotAddress(acc),
    isEvmTruncated: isTrunc,
  }
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  const input = raw.trim()
  if (!input) return null

  // Bare EVM H160 -> truncated AccountId32 form (module/sovereign truncations
  // resolve to their real substrate account instead).
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const evm = input.toLowerCase()
    const reserved = reservedH160AccountId(evm.slice(2))
    if (reserved) return fromAccountId(input, reserved)
    const accountId = evmTruncatedAccountId(evm.slice(2))
    return {
      input,
      kind: 'evm',
      accountId,
      evmAddress: evm,
      ss58: hydrationAddress(accountId),
      ss58Polkadot: polkadotAddress(accountId),
      isEvmTruncated: true,
    }
  }

  // Raw 0x AccountId32.
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
    return fromAccountId(input, input.toLowerCase())
  }

  // SS58 (any prefix) -> public key hex.
  const hex = accountIdHex(input)
  if (hex && /^0x[0-9a-fA-F]{64}$/.test(hex)) {
    return fromAccountId(input, hex.toLowerCase())
  }

  return null
}

export { hydrationAddress, polkadotAddress }
