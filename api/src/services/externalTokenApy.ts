// Current APYs of yield-bearing tokens from the sources the Hydration UI reads, so
// the explorer's token yield (and the Net APY built on it) is the figure a holder
// sees in the app: DeFiLlama's latest `apyBase` (else `apy`) per pool id, and
// Kamino's latest hourly APY for PRIME — the ids and the "latest entry" rule are
// the Hydration UI's (apps/main/src/api/external/defillama.ts, kamino.ts), and the
// same upstreams our public API proxies for it (public/services/proxyUpstreams.ts).
//
// A background refresher, never a request-path fetch: one read per source every
// REFRESH_MS into an in-memory map; an entry older than MAX_AGE_MS is dropped, and
// a token without a fresh entry falls back to its on-chain rate (positionYield's
// peg-multiplier growth), which the wire names as the source.

export type ExternalApySource = 'defillama' | 'kamino'

/** Registry asset id → DeFiLlama yield pool id (the Hydration UI's ASSET_ID_TO_DEFILLAMA_ID). */
export const DEFILLAMA_POOLS: Readonly<Record<number, string>> = {
  15: 'ff05ab26-971e-4e68-b1c6-c61a4c12c364', // vDOT
  1000809: '747c1d2a-c668-4682-b9f9-296708a3dd90', // wstETH
  1000625: '66985a81-9c51-46ca-9977-42b4fe7bc6df', // sUSDe
  1000745: 'd8c4eff5-c8a9-46fc-a888-057c4c668e72', // sUSDS
  40: '0e7d0722-9054-4907-8593-567b353c0900', // jitoSOL
  46: 'cb6139f9-4a68-4efd-8245-0312a92aee55', // apyUSD
}
/** Registry asset id → Kamino yield source (the Hydration UI's ASSET_ID_TO_KAMINO_ID). */
export const KAMINO_SOURCES: Readonly<Record<number, string>> = {
  43: '3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7', // PRIME
}

const REFRESH_MS = 10 * 60_000
const MAX_AGE_MS = 60 * 60_000
const TIMEOUT_MS = 10_000
/** Internal percentage scale, positionYield's PCT_DECIMALS. */
const PCT_DECIMALS = 6

export interface ExternalTokenApy { apyPct: bigint; source: ExternalApySource; fetchedAt: number }

let snapshot = new Map<number, ExternalTokenApy>()
let timer: ReturnType<typeof setInterval> | null = null

/** A percent figure from an upstream's JSON (number or decimal string) as an internal percentage; null when unusable. */
export function pctFromUpstream(v: unknown, scale = 1): bigint | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) return null
  const fixed = (n * scale).toFixed(PCT_DECIMALS)
  const negative = fixed.startsWith('-')
  const [whole, frac = ''] = (negative ? fixed.slice(1) : fixed).split('.')
  const out = BigInt(whole) * 10n ** BigInt(PCT_DECIMALS) + BigInt(frac.padEnd(PCT_DECIMALS, '0').slice(0, PCT_DECIMALS))
  return negative ? -out : out
}

/** DeFiLlama's chart payload → the latest entry's apyBase, else apy (the Hydration UI's rule; 0/absent falls through). */
export function latestDefillamaApy(body: unknown): bigint | null {
  const data = (body as { data?: Array<{ apyBase?: number | null; apy?: number | null }> } | null)?.data
  const last = data?.[data.length - 1]
  if (!last) return null
  return pctFromUpstream(last.apyBase || last.apy)
}

/** Kamino's history payload → the latest entry's apy (a fraction) in percent. */
export function latestKaminoApy(body: unknown): bigint | null {
  const rows = Array.isArray(body) ? body as Array<{ apy?: string | number }> : []
  const last = rows[rows.length - 1]
  return last ? pctFromUpstream(last.apy, 100) : null
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

async function refresh(): Promise<void> {
  const next = new Map(snapshot)
  const now = Date.now()
  const jobs: Promise<void>[] = []
  for (const [id, pool] of Object.entries(DEFILLAMA_POOLS)) {
    jobs.push(getJson(`https://yields.llama.fi/chart/${pool}`).then(body => {
      const apyPct = latestDefillamaApy(body)
      if (apyPct != null) next.set(Number(id), { apyPct, source: 'defillama', fetchedAt: now })
    }).catch(err => console.warn(`[token-apy] defillama ${id}: ${(err as Error).message}`)))
  }
  for (const [id, source] of Object.entries(KAMINO_SOURCES)) {
    const start = new Date(now - 2 * 3_600_000).toISOString(), end = new Date(now).toISOString()
    jobs.push(getJson(`https://api.kamino.finance/yields/${source}/history?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`).then(body => {
      const apyPct = latestKaminoApy(body)
      if (apyPct != null) next.set(Number(id), { apyPct, source: 'kamino', fetchedAt: now })
    }).catch(err => console.warn(`[token-apy] kamino ${id}: ${(err as Error).message}`)))
  }
  await Promise.all(jobs)
  snapshot = next
}

/** Starts the refresher (idempotent). The first read runs at once, unawaited. */
export function initExternalTokenApy(): void {
  if (timer) return
  void refresh()
  timer = setInterval(() => { void refresh() }, REFRESH_MS)
  timer.unref?.()
}

/** The fresh entries (younger than MAX_AGE_MS). */
export function externalTokenApys(now = Date.now()): Map<number, ExternalTokenApy> {
  return new Map([...snapshot].filter(([, v]) => now - v.fetchedAt <= MAX_AGE_MS))
}
