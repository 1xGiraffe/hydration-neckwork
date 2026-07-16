import type { ClickHouseClient } from '../db/client.ts'

// On-chain identities (Identity.IdentityOf) snapshotted from the Hydration chain
// into price_data.account_identities. The set is small (~hundreds) and changes
// slowly, so it lives in memory keyed by canonical account_id (0x + 64 hex) for
// O(1) display resolution on every accountRef. Refreshed on an interval so a
// future indexer backfill / re-snapshot is picked up without a restart.
export interface AccountIdentity { display: string; verified: boolean; email: string; web: string; twitter: string }

let client: ClickHouseClient
const byAccount = new Map<string, AccountIdentity>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

export function initIdentityService(c: ClickHouseClient): void { client = c }

async function loadIdentitiesUncached(): Promise<void> {
  const res = await client.query({
    query: `
      SELECT account_id, display, verified, email, web, twitter
      FROM price_data.account_identities FINAL
      WHERE display != ''`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<{ account_id: string; display: string; verified: number; email: string; web: string; twitter: string }>()
  byAccount.clear()
  for (const r of rows) {
    if (!r.account_id) continue
    byAccount.set(r.account_id.toLowerCase(), { display: r.display, verified: r.verified === 1, email: r.email ?? '', web: r.web ?? '', twitter: r.twitter ?? '' })
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
// The set is small (~hundreds) so a linear scan is cheaper than a ClickHouse query.
export function searchIdentitiesByDisplay(q: string, limit = 5): { accountId: string; identity: AccountIdentity }[] {
  const ql = q.trim().toLowerCase()
  if (!ql) return []
  const out: { accountId: string; identity: AccountIdentity }[] = []
  for (const [accountId, identity] of byAccount) {
    if (identity.display.toLowerCase().includes(ql)) {
      out.push({ accountId, identity })
      if (out.length >= limit) break
    }
  }
  return out
}
