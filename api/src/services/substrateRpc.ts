// Minimal substrate JSON-RPC helpers shared by services that read chain state
// live (money market, LP positions, proxy/multisig). One full Hydration node
// serves both eth_* and state_* calls.
export const SUBSTRATE_RPC_URL = process.env.RAW_EVM_RPC_URL?.trim() || 'https://hydration-rpc.n.dwellir.com'

// Nodes cap JSON-RPC batch size (node-full rejects >100 with -32010), so large
// reads are split into conservative chunks.
const MAX_BATCH = 80

// Batched state_getStorage — chunked JSON-RPC batches, position-mapped results
// (null for missing storage or transport errors).
export async function substrateStorageBatch(keys: string[]): Promise<(string | null)[]> {
  if (!keys.length) return []
  const out: (string | null)[] = keys.map(() => null)
  for (let start = 0; start < keys.length; start += MAX_BATCH) {
    const chunk = keys.slice(start, start + MAX_BATCH)
    const body = chunk.map((k, i) => ({ jsonrpc: '2.0', id: i, method: 'state_getStorage', params: [k] }))
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 6000)
    try {
      const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify(body) })
      if (!res.ok) continue
      const json = await res.json() as unknown
      for (const item of Array.isArray(json) ? json : []) {
        if (!item || typeof item !== 'object') continue
        const { id, result } = item as { id?: unknown; result?: unknown }
        if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= chunk.length) continue
        out[start + (id as number)] = typeof result === 'string' ? result : null
      }
    } catch { /* chunk stays null */ } finally { clearTimeout(timer) }
  }
  return out
}

// One page of storage keys under `prefix` (state_getKeysPaged). null distinguishes
// a failed read from a genuinely empty page, which the paged enumeration below needs
// in order to tell "no more keys" from "the node stopped answering".
export async function substrateKeysPaged(prefix: string, count: number, startKey: string | null): Promise<string[] | null> {
  if (!Number.isSafeInteger(count) || count <= 0) return []
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const params = startKey ? [prefix, count, startKey] : [prefix, count]
    const res = await fetch(SUBSTRATE_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_getKeysPaged', params }) })
    if (!res.ok) return null
    const json = await res.json() as { result?: unknown }
    return Array.isArray(json.result) ? json.result.filter((key): key is string => typeof key === 'string') : null
  } catch { return null } finally { clearTimeout(timer) }
}

// Every key under `prefix` (paged enumeration, bounded). Throws rather than
// returning a short list when the enumeration did not provably reach the end: a
// truncated key set is indistinguishable from a smaller map, and callers publish it
// as current state — a half-read Balances.Locks would report accounts as unlocked.
// Every caller already keeps its previous snapshot when a refresh throws. The page
// bound leaves headroom above the largest live map (Balances.Locks, ~18k keys) so
// growth raises the error rather than quietly cutting the tail off.
export async function substrateAllKeys(prefix: string, maxPages = 200, pageSize = 1000): Promise<string[]> {
  const all: string[] = []
  const seen = new Set<string>()
  let startKey: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const keys = await substrateKeysPaged(prefix, pageSize, startKey)
    if (keys == null) throw new Error(`state_getKeysPaged failed for ${prefix} at page ${page}`)
    if (!keys.length) return all
    for (const key of keys) {
      if (!seen.has(key)) {
        seen.add(key)
        all.push(key)
      }
    }
    if (keys.length < pageSize) return all
    const nextStartKey = keys[keys.length - 1]
    if (nextStartKey === startKey) return all
    startKey = nextStartKey
  }
  // Ran out of pages on a full page: there are more keys than this bound can read.
  throw new Error(`state_getKeysPaged exceeded ${maxPages} pages for ${prefix}; raise the page bound`)
}
