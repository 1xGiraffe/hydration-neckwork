// Identity sources, ordered by display priority.
//
// The Identity pallet is identical everywhere it is deployed and keyed by the
// 32-byte AccountId, so one public key can carry a registration on several
// chains at once. Which one the explorer shows is a configuration decision, not
// a chain fact: the list is ordered, Hydration always leads, and every later
// chain only fills gaps the earlier ones left.
//
// Hydration leads because an account that registered on Hydration told us what
// it wants to be called *here*; a People-chain name is the same person's
// ecosystem-wide name, and a testnet name is free to mint and therefore trusted
// least.

export const HYDRATION_CHAIN_KEY = 'hydration'

export interface IdentityChain {
  key: string           // stored in account_identities.chain
  url: string           // RPC endpoint serving Identity.* storage
  block: number | null  // pinned anchor, or null for the finalized head
  priority: number      // 0 = highest; index in this list
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/

// `key=url[@block]` entries, comma separated, highest priority first.
//
// A pinned `@block` reads state at a fixed anchor instead of the head. That is
// the whole answer to a chain whose Identity pallet has since been removed — the
// data is still in archived state, so one pinned pass recovers it without
// indexing a single block. Both relay chains are readable this way (their
// identities migrated to the People chains in 2024).
//
// A malformed, duplicate, or non-HTTP entry is skipped rather than throwing: one
// bad entry must not cost every other chain its identities.
export function parseIdentityChains(raw: string | undefined, hydrationUrl: string): IdentityChain[] {
  const chains: IdentityChain[] = [{ key: HYDRATION_CHAIN_KEY, url: hydrationUrl, block: null, priority: 0 }]
  const seen = new Set([HYDRATION_CHAIN_KEY])

  for (const entry of (raw ?? '').split(',')) {
    const text = entry.trim()
    if (!text) continue

    const separator = text.indexOf('=')
    if (separator <= 0) continue
    const key = text.slice(0, separator).trim().toLowerCase()
    if (!KEY_RE.test(key) || seen.has(key)) continue

    let url = text.slice(separator + 1).trim()
    let block: number | null = null
    // Only a trailing all-digit @suffix is an anchor; an '@' inside the
    // authority (credentials) stays part of the URL.
    const at = url.lastIndexOf('@')
    if (at > 0 && /^\d+$/.test(url.slice(at + 1))) {
      block = Number(url.slice(at + 1))
      url = url.slice(0, at)
      if (!Number.isSafeInteger(block)) continue
    }
    if (!/^https?:\/\/\S+$/.test(url)) continue

    seen.add(key)
    chains.push({ key, url, block, priority: chains.length })
  }

  return chains
}
