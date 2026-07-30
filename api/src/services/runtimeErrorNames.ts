import type { ClickHouseClient } from '../db/client.ts'

// In-memory registry of Module-error names (pallet_index, error_index) keyed
// by spec_version, mirroring explorerAssets.ts. The table is small (~34k
// rows spanning every runtime upgrade) so the whole thing loads into a Map
// rather than being queried per request.
interface Row { spec_version: number; pallet_index: number; error_index: number; pallet_name: string; error_name: string; docs: string }
type Entry = { pallet: string; name: string; docs: string }

const cache = new Map<string, Entry>()
let refreshTimer: ReturnType<typeof setInterval> | null = null
let loadInflight: Promise<void> | null = null

const key = (spec: number, pallet: number, error: number) => `${spec}:${pallet}:${error}`

async function loadRuntimeErrorNamesUncached(client: ClickHouseClient): Promise<void> {
  const res = await client.query({
    query: `SELECT spec_version, pallet_index, error_index, pallet_name, error_name, docs
            FROM price_data.runtime_error_names FINAL`,
    format: 'JSONEachRow',
  })
  const rows = await res.json<Row>()
  cache.clear()
  for (const r of rows) cache.set(key(r.spec_version, r.pallet_index, r.error_index), { pallet: r.pallet_name, name: r.error_name, docs: r.docs })
  if (!refreshTimer) {
    // Error names change only on runtime upgrades (rare) — a slow refresh is
    // enough to pick up a new spec version after the indexer records it.
    refreshTimer = setInterval(() => {
      loadRuntimeErrorNames(client).catch(err => console.error('[RuntimeErrorNames] refresh failed:', err))
    }, 600_000)
    refreshTimer.unref()
  }
}

export function loadRuntimeErrorNames(client: ClickHouseClient): Promise<void> {
  if (loadInflight) return loadInflight
  const request = loadRuntimeErrorNamesUncached(client).finally(() => {
    if (loadInflight === request) loadInflight = null
  })
  loadInflight = request
  return request
}

export function stopRuntimeErrorNamesRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}

// Resolve a Module DispatchError's (palletIndex, errorIndex) to its name/docs
// for the runtime that was active when it was raised. Pure in-memory lookup;
// a miss (unloaded/unknown spec version) returns null rather than querying.
export function resolveModuleError(specVersion: number, palletIndex: number, errorIndex: number): Entry | null {
  return cache.get(key(specVersion, palletIndex, errorIndex)) ?? null
}
