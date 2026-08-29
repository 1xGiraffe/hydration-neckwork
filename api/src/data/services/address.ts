import { cryptoWaitReady, decodeAddress, encodeAddress } from '@polkadot/util-crypto'
import { u8aToHex } from '@polkadot/util'

// Address parsing/rendering for the Data API, self-contained on purpose: the
// data tree may not import the explorer's addressIdentity service (isolation
// rule), so the same canonicalization is implemented here from the npm
// primitives. The SEMANTICS mirror api/src/services/addressIdentity.ts exactly
// — an input the explorer resolves must resolve to the same accountId here.
//
// Hydration's EVM accounts live in Substrate storage as a truncated
// AccountId32: "ETH\0" (0x45544800), the 20-byte H160, then 8 zero bytes.
// Module/sovereign accounts ('modl'/'sibl'/'para' + 16 zero-ish bytes) appear
// as H160 truncations too and are resolved back to their full AccountId32.

// ss58 encode/decode hash through wasm-backed blake2; waiting here (top-level)
// means no caller can race an uninitialized wasm module.
await cryptoWaitReady()

// Canonical OUTPUT prefix. Polkadot (0) by owner decision (2026-08-29): the
// audience is external developers whose tooling speaks Polkadot-format
// addresses; the Hydration-prefixed form of the same key is accepted on INPUT
// like any other prefix. The explorer UI keeps its own prefix-63 display.

const EVM_MARKER = '45544800'
const ZERO16 = '0000000000000000'
const RESERVED_H160_PREFIXES = ['6d6f646c', '7369626c', '70617261']
const OUTPUT_SS58_PREFIX = 0

export interface ParsedAddress {
  accountId: string          // canonical 0x + 64 hex AccountId32 (the join key)
  evmAddress: string | null  // 0x + 40 hex H160 when the account is EVM-mapped
  address: string            // canonical display: Polkadot SS58 (prefix 0), or the H160
}

function reservedH160AccountId(h160NoPrefix: string): string | null {
  const h = h160NoPrefix.toLowerCase()
  return RESERVED_H160_PREFIXES.some(prefix => h.startsWith(prefix)) ? `0x${h}000000000000000000000000` : null
}

export function ss58For(accountIdHex: string): string {
  return encodeAddress(accountIdHex, OUTPUT_SS58_PREFIX)
}

// The canonical output form for an accountId the database handed back.
export function renderAccount(accountIdHex: string): ParsedAddress {
  const acc = accountIdHex.toLowerCase()
  const isTruncatedEvm = acc.slice(2, 10) === EVM_MARKER && acc.slice(50) === ZERO16
  const evmAddress = isTruncatedEvm ? `0x${acc.slice(10, 50)}` : null
  return {
    accountId: acc,
    evmAddress,
    // An EVM account's home form is its H160 — the SS58 of a truncated id is
    // an implementation detail nobody types.
    address: evmAddress ?? ss58For(acc),
  }
}

// The zAccountRef wire shape (schemas/common.ts) for an accountId hex.
export interface AccountRef { address: string; accountIdHex: string; evmAddress: string | null }

export function accountRefFor(accountIdHex: string): AccountRef {
  const parsed = renderAccount(accountIdHex)
  return { address: parsed.address, accountIdHex: parsed.accountId, evmAddress: parsed.evmAddress }
}

const ACCOUNT_ID_RE = /^0x[0-9a-f]{64}$/

// The wire ref for a column that MAY hold an account: '' / NULL / a placeholder
// that is not a 32-byte id renders as null rather than as an invented address.
export function accountRefOrNull(value: string | null | undefined): AccountRef | null {
  const account = (value ?? '').toLowerCase()
  return ACCOUNT_ID_RE.test(account) ? accountRefFor(account) : null
}

// The EVM-side identity of an account: its own H160 for an EVM account, else
// the first 20 bytes of the public key (the runtime's address mapping) — the
// form the money-market and token-contract tables key on.
export function h160For(parsed: ParsedAddress): string {
  return parsed.evmAddress ?? `0x${parsed.accountId.slice(2, 42)}`
}

// The ETH-truncated AccountId32 form of a substrate account (how its EVM-side
// activity is indexed on the substrate side). An already-truncated id folds to
// itself.
export function evmAccountForm(parsed: ParsedAddress): string {
  return `0x${EVM_MARKER}${parsed.accountId.slice(2, 42)}${ZERO16}`
}

// SS58 (any prefix), H160, or 0x-64-hex → the canonical identity, or null when
// the input is not an address at all (the route answers 400, naming the
// accepted formats).
export function parseAddress(raw: string): ParsedAddress | null {
  const input = raw.trim()
  if (!input) return null

  if (/^0x[0-9a-fA-F]{40}$/.test(input)) {
    const evm = input.toLowerCase()
    const reserved = reservedH160AccountId(evm.slice(2))
    if (reserved) return renderAccount(reserved)
    return renderAccount(`0x${EVM_MARKER}${evm.slice(2)}${ZERO16}`)
  }

  if (/^0x[0-9a-fA-F]{64}$/.test(input)) {
    const acc = input.toLowerCase()
    const isTruncatedEvm = acc.slice(2, 10) === EVM_MARKER && acc.slice(50) === ZERO16
    if (isTruncatedEvm) {
      const reserved = reservedH160AccountId(acc.slice(10, 50))
      if (reserved) return renderAccount(reserved)
    }
    return renderAccount(acc)
  }

  try {
    return renderAccount(u8aToHex(decodeAddress(input)))
  } catch {
    return null
  }
}

export const ADDRESS_FORMATS_HINT = 'accepted formats: SS58 (any prefix), a 0x-prefixed H160, or a 0x-prefixed 32-byte public key'
