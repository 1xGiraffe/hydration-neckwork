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
export interface AccountIdentity { display: string; verified: boolean; email: string; web: string; twitter: string }

let client: ClickHouseClient
const byAccount = new Map<string, AccountIdentity>()
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
  for (const r of rows) {
    if (!r.account_id) continue
    const accountId = r.account_id.toLowerCase()
    const priority = Number(r.priority ?? 0)
    const chain = r.chain ?? ''
    // Chain key breaks a priority tie, so the resolved name never depends on the
    // order ClickHouse returned the rows in.
    const kept = winner.get(accountId)
    if (kept && (kept.priority < priority || (kept.priority === priority && kept.chain <= chain))) continue
    winner.set(accountId, { priority, chain })
    byAccount.set(accountId, { display: r.display, verified: r.verified === 1, email: r.email ?? '', web: r.web ?? '', twitter: r.twitter ?? '' })
  }
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

// Search the in-memory identity map by display name (case-insensitive substring).
// The set is small (~thousands) so a linear scan is cheaper than a ClickHouse query.
// Ranked exact → prefix → substring and only then cut to `limit`, the same order
// emojisMatchingName uses: truncating during the scan dropped the account whose
// display IS the query whenever enough other names merely contained it — searching
// "Validator" never found the account called "Validator".
export function searchIdentitiesByDisplay(q: string, limit = 5): { accountId: string; identity: AccountIdentity }[] {
  const ql = q.trim().toLowerCase()
  if (!ql) return []
  type Match = { accountId: string; identity: AccountIdentity }
  const exact: Match[] = [], prefix: Match[] = [], sub: Match[] = []
  for (const [accountId, identity] of byAccount) {
    const display = identity.display.toLowerCase()
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
