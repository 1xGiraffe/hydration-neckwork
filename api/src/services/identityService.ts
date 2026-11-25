import type { ClickHouseClient } from '../db/client.ts'

// On-chain identities snapshotted into price_data.account_identities from the
// Identity pallet of Hydration and of every other configured chain (the Polkadot
// and Kusama People chains, where both relays' identities now live). The set is
// small (~thousands) and changes slowly, so it lives in memory keyed by canonical
// account_id (0x + 64 hex) for O(1) display resolution on every accountRef.
// Refreshed on an interval so a re-snapshot is picked up without a restart.
//
// The pallet is keyed by AccountId, so one public key can hold a registration on
// several chains. The snapshot stamps each row with its chain's display priority
// (0 = Hydration) and the lowest one wins here, collapsing the table to a single
// name per account. Nothing downstream learns which chain that name came from.
//
// A testnet's names are free to mint, so a row from a testnet chain is never shown,
// whatever the configuration once snapshotted.
export interface AccountIdentity { display: string; verified: boolean; email: string; web: string; twitter: string }

/** Identity chain keys naming a Polkadot test network (Westend, Paseo, Rococo, Wococo). */
export function isTestnetIdentityChain(chain: string): boolean {
  return /(^|-)(westend|paseo|rococo|wococo)(-|$)/.test(chain)
}

/**
 * The chains whose registrar judgements count as standing (the forum's gates):
 * Hydration's own Identity pallet and the Polkadot and Kusama People chains.
 */
export const STANDING_IDENTITY_CHAINS: ReadonlySet<string> = new Set(['hydration', 'polkadot-people', 'kusama-people'])

let client: ClickHouseClient
const byAccount = new Map<string, AccountIdentity>()
const verifiedAccounts = new Set<string>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

export function initIdentityService(c: ClickHouseClient): void { client = c }

async function loadIdentitiesUncached(): Promise<void> {
  const res = await client.query({
    query: `
      SELECT chain, account_id, display, verified, email, web, twitter, priority
      FROM price_data.account_identities FINAL
      WHERE display != ''`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ chain: string; account_id: string; display: string; verified: number; email: string; web: string; twitter: string; priority: number }>()
  // Winning (priority, chain) per account, so a second row for the same key can be
  // compared against the one already kept.
  const winner = new Map<string, { priority: number; chain: string }>()
  byAccount.clear()
  verifiedAccounts.clear()
  for (const r of rows) {
    if (!r.account_id) continue
    const accountId = r.account_id.toLowerCase()
    const priority = Number(r.priority ?? 0)
    const chain = r.chain ?? ''
    if (isTestnetIdentityChain(chain)) continue
    if (r.verified === 1 && STANDING_IDENTITY_CHAINS.has(chain) && ownRegistration(r)) verifiedAccounts.add(accountId)
    // Chain key breaks a priority tie, so the resolved name never depends on the
    // order ClickHouse returned the rows in.
    const kept = winner.get(accountId)
    if (kept && (kept.priority < priority || (kept.priority === priority && kept.chain <= chain))) continue
    winner.set(accountId, { priority, chain })
    byAccount.set(accountId, { display: r.display, verified: r.verified === 1, email: r.email ?? '', web: r.web ?? '', twitter: r.twitter ?? '' })
  }
}

// A row is the account's own registration, a sub-identity named "Parent/Sub" that
// inherits its parent's judgement, or a bare username (never verified). Only the
// account's own registration carries contact fields, and a sub's display always
// holds a '/', so a row with contacts or without a '/' is the account's own; a
// verified row with neither is treated as a sub and does not count.
function ownRegistration(r: { display: string; email: string; web: string; twitter: string }): boolean {
  return !r.display.includes('/') || !!(r.email || r.web || r.twitter)
}

export function loadIdentities(): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadIdentitiesUncached().finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

// Refresh the in-memory identity map on an interval (default 5 min). Idempotent.
export function startIdentityRefresh(intervalMs = 5 * 60 * 1000): void {
  if (refreshTimer) return
  refreshTimer = setInterval(() => { loadIdentities().catch(() => { /* keep stale on error */ }) }, intervalMs)
  refreshTimer.unref()
}

export function stopIdentityRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

export function identityForAccount(accountId: string): AccountIdentity | null {
  if (!accountId) return null
  return byAccount.get(accountId.toLowerCase()) ?? null
}

/**
 * Whether the account holds its OWN registration with a registrar's Reasonable or
 * KnownGood judgement on Hydration or a Polkadot/Kusama People chain — not a
 * sub-identity, a username or a testnet name, which cost little to obtain. Any one
 * such chain counts, whichever chain's name the explorer displays.
 */
export function hasVerifiedIdentity(accountId: string): boolean {
  return !!accountId && verifiedAccounts.has(accountId.toLowerCase())
}

// Search the in-memory identity map by display name (case-insensitive substring).
// The set is small (~thousands) so a linear scan is cheaper than a ClickHouse query.
// Ranked exact → prefix → substring and only then cut to `limit`, the same order
// emojisMatchingName uses: truncating during the scan dropped the account whose
// display IS the query whenever enough other names merely contained it — searching
// "Validator" never found the account called "Validator".
export function searchIdentitiesByDisplay(q: string, limit = 5): { accountId: string; identity: AccountIdentity }[] {
  // NFKC then lower case, as the explorer search folds every name (searchFold).
  const fold = (t: string) => t.normalize('NFKC').toLowerCase()
  const ql = fold(q.trim())
  if (!ql) return []
  type Match = { accountId: string; identity: AccountIdentity }
  const exact: Match[] = [], prefix: Match[] = [], sub: Match[] = []
  for (const [accountId, identity] of byAccount) {
    const display = fold(identity.display)
    if (display === ql) exact.push({ accountId, identity })
    else if (display.startsWith(ql)) prefix.push({ accountId, identity })
    else if (display.includes(ql)) sub.push({ accountId, identity })
  }
  // Shortest display first inside a bucket, account id as the tiebreak, so the
  // closest name wins and the result does not depend on map iteration order.
  const rank = (rows: Match[]) => rows.sort((a, b) =>
    a.identity.display.length - b.identity.display.length || a.accountId.localeCompare(b.accountId))
  return [...rank(exact), ...rank(prefix), ...rank(sub)].slice(0, limit)
}
