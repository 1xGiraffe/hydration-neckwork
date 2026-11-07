import { cacheRefresh, cachedSwr } from './cache.ts'
import { currentPriceOf, displayDescriptor } from './explorerAssets.ts'
import { accountRef, type AccountRef, type PriceInfo } from './explorerService.ts'

// What every strategy dashboard (Juicer's /explorer/juicer, BIL's /explorer/bil) shares:
// it is never built on a reader's request. The first build starts at process init
// (server.ts, once the asset registry and account refs are loaded, before listen;
// history only, until the strategy refresher's first snapshot), and a timer rebuilds it
// in the background whenever that refresher publishes a new snapshot — and only then.
// Readers get the cached build, stale-while-revalidate across a snapshot change, so a
// reader is answered from the previous build while the next one computes; a reader
// arriving during the boot build joins its single flight.

export interface StrategyDashboardCache<D> {
  init(): void
  /** Builds at boot, then rebuilds when the snapshot it reads has changed (and only then). */
  prewarm(): Promise<void>
  get(): Promise<D>
}
export function strategyDashboardCache<S extends { readAt: number }, D>(opts: {
  name: string
  key: string
  snapshot: () => S | null
  build: (snap: S | null) => Promise<D>
  freshMs?: number
  staleMs?: number
  everyMs?: number
}): StrategyDashboardCache<D> {
  const fresh = opts.freshMs ?? 5 * 60_000, stale = opts.staleMs ?? 30 * 60_000
  let timer: ReturnType<typeof setInterval> | null = null
  let prewarmed = -1
  let running = false
  const prewarm = async (): Promise<void> => {
    const snap = opts.snapshot()
    const generation = snap?.readAt ?? 0
    if (running || generation === prewarmed) return
    running = true
    try {
      await cacheRefresh(opts.key, fresh, stale, () => opts.build(snap), generation)
      prewarmed = generation
    } catch (err) {
      console.warn(`[${opts.name}] dashboard prewarm failed; readers keep the previous build`, err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }
  return {
    init() {
      if (timer) return
      timer = setInterval(() => { void prewarm() }, opts.everyMs ?? 15_000)
      timer.unref?.()
      setTimeout(() => { void prewarm() }, 0).unref?.()
    },
    prewarm,
    get() {
      const snap = opts.snapshot()
      return cachedSwr(opts.key, fresh, stale, () => opts.build(snap), snap?.readAt ?? 0)
    },
  }
}

/** An H160's own (ETH-form) account. */
export const h160Account = (h: string): AccountRef => accountRef('0x45544800' + h.slice(2).toLowerCase() + '0'.repeat(16))

/** A raw amount of a registry asset at its CURRENT price (the map's own rule), or null when either is unknown. */
export function rawUsd(prices: Map<number, PriceInfo>, assetId: number, raw: string | bigint | null): number | null {
  const p = currentPriceOf(prices, assetId)?.price
  const d = displayDescriptor(assetId).decimals
  if (raw == null || p == null || d == null) return null
  const v = Number(raw) / 10 ** d * p
  return Number.isFinite(v) ? v : null
}
