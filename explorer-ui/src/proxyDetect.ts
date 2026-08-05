// Browser-side proxy resolution for the contract tab: a verified proxy's own
// ABI is a constructor and a fallback, so Read/Write would show nothing — the
// functions people came for live in the implementation. Detection reads chain
// state (never the verified name), in the same render-on-fetch style as the
// tab's other RPC reads: the EIP-1967 implementation slot, then the EIP-1967
// beacon slot (asking the beacon for implementation()), then the EIP-1167
// minimal-proxy bytecode shape. One level only — an implementation that is
// itself a proxy is shown as the implementation, not chased.
import { ethCall, ethGetCode, ethGetStorageAt } from './evmRpc'

// keccak256("eip1967.proxy.implementation") - 1 / keccak256("eip1967.proxy.beacon") - 1
export const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const BEACON_IMPLEMENTATION_SELECTOR = '0x5c60da1b'   // implementation()

export interface ProxyInfo {
  kind: 'eip1967' | 'beacon' | 'eip1167'
  implementation: string
  beacon?: string
}

export function proxyKindLabel(kind: ProxyInfo['kind']): string {
  if (kind === 'beacon') return 'EIP-1967 beacon proxy'
  if (kind === 'eip1167') return 'EIP-1167 minimal proxy'
  return 'EIP-1967 proxy'
}

// A storage word (or an eth_call result) holding a plain address: 12 zero
// bytes then 20 address bytes. Anything else — zero, short reads, packed
// values — is explicitly not an address rather than a guess.
export function slotAddress(word: string | null | undefined): string | null {
  if (typeof word !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(word)) return null
  const hex = word.slice(2).toLowerCase()
  if (!hex.startsWith('0'.repeat(24))) return null
  const addr = hex.slice(24)
  if (addr === '0'.repeat(40)) return null
  return `0x${addr}`
}

// Canonical EIP-1167 runtime code, exactly 45 bytes with the target embedded:
// 363d3d373d3d3d363d73 <address> 5af43d82803e903d91602b57fd5bf3. Optimized
// variants exist in the wild but are not decoded here — a non-match simply
// stays a plain contract.
export function minimalProxyTarget(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null
  const m = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code)
  if (!m || m[1] === '0'.repeat(40)) return null
  return `0x${m[1].toLowerCase()}`
}

export async function detectProxy(address: string): Promise<ProxyInfo | null> {
  const implementation = slotAddress(await ethGetStorageAt(address, EIP1967_IMPLEMENTATION_SLOT))
  if (implementation) return implementation === address.toLowerCase() ? null : { kind: 'eip1967', implementation }
  const beacon = slotAddress(await ethGetStorageAt(address, EIP1967_BEACON_SLOT))
  if (beacon) {
    // The beacon names the implementation; a beacon that does not answer is
    // treated as no detection rather than an error surface.
    const fromBeacon = slotAddress(await ethCall(beacon, BEACON_IMPLEMENTATION_SELECTOR).catch(() => null))
    return fromBeacon ? { kind: 'beacon', implementation: fromBeacon, beacon } : null
  }
  const clone = minimalProxyTarget(await ethGetCode(address))
  if (clone) return clone === address.toLowerCase() ? null : { kind: 'eip1167', implementation: clone }
  return null
}
