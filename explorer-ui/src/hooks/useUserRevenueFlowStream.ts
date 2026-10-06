import { useEffect, useRef } from 'react'
import { mergeFlowCatchup } from '../utils/userRevenueMerge'
import { api } from '../api/explorer'
import { subscribeHead, LIVE_MS } from '../live'
import { FLOW_RESUME_RESET_MS } from './useRevenueFlowStream'
import type { AccountRef, UserRevenueFlowItem, UserRevenueFlowResponse } from '../types'

// The user river's engine. It flows in two modes (api services/userRevenueLive.ts):
//
//  * LIVE — every earning stream with a per-block source. LP fees, the GIGAHDX
//    pot's inflows and referrer commissions arrive as ITEMS (each the users'
//    share of its pot, a referral claim its earner's when a user), paged by an
//    opaque cursor; lending interest and incentives accrue every block as DRIPS
//    at the newest folded hour's rate.
//  * MEAN — the revisable streams (token accrual, farms, GIGAHDX voting), whose
//    newest hours are not decided yet, and legacy staking, whose pot inflows
//    under-report its accrual, drip at their trailing-24h mean.
//
// createRateScheduler is PURE and deterministic (tests/userRevenue.test.tsx):
// a drip accrues `usdPerBlock × blocks` into its own accumulator and emits a
// particle once the accumulated amount is worth one (acc ≥ emitUsd), carrying
// the WHOLE accumulated amount; an item worth a particle flies on its own,
// jittered by its chain identity, and a smaller one accrues into its stream's
// accumulator like a drip. Only earnings flow: a drip or item that is not
// positive is skipped. Value is never dropped: when the river already has
// `maxActive` particles in flight, the amount is credited straight to the
// counter instead (`credit` from drain), exactly as the protocol river sheds a
// particle; and an accumulator still under a particle's worth `flushMs` after
// it started filling is credited too, so a sub-cent stream reaches the counter
// and the counter catches up with sessionUsd() whenever the river goes quiet.

export interface RateDrip { key: string; stream: string; label: string; assetId?: number; usdPerBlock: number }

export interface RateEmission {
  id: string
  /** The earner a live item names (a referral claim's referrer). */
  account?: AccountRef | null
  kind: 'pill' | 'mote'
  stream: string
  label: string
  /** The drip's asset, when it names one. */
  assetId?: number
  /** Earned, always > 0. */
  usd: number
  /** Scheduled spawn time (ms, same clock as opts.now). */
  at: number
}

export interface RateSchedulerOptions {
  /** An accumulator emits once it reaches this. */
  emitUsd: number
  /** At or above this an emission is a readable pill. */
  pillUsd: number
  maxActive: number
  now: () => number
  /** An accumulator still under `emitUsd` this long after it started filling is credited to the counter (default 20 s). */
  flushMs?: number
}

export const RESIDUAL_FLUSH_MS = 20_000

export interface RateScheduler {
  tick(drips: RateDrip[], blocks: number, spreadMs: number): void
  /** Live items, spread over `spreadMs` (the observed batch interval). */
  ingest(items: UserRevenueFlowItem[], spreadMs: number): void
  /** Due emissions plus the value that could not fly or sat under a particle's worth for `flushMs` (credit it to the counter). */
  drain(now: number): { due: RateEmission[]; credit: number }
  /** Credits every accumulator's residual at once (the next drain carries it). */
  flush(): void
  /** Everything earned into the scheduler so far (emitted or credited or still accumulating). */
  sessionUsd(): number
  setMaxActive(n: number): void
  /** Particles currently scheduled or in flight, as the caller reports them. */
  setInFlight(n: number): void
}

function jitter(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 8) / 0x00ffffff
}

export function createRateScheduler(opts: RateSchedulerOptions): RateScheduler {
  const acc = new Map<string, number>()
  /** When each accumulator started filling (opts.now clock). */
  const since = new Map<string, number>()
  const flushMs = opts.flushMs ?? RESIDUAL_FLUSH_MS
  const hold = (key: string, v: number): void => {
    if (!since.has(key)) since.set(key, opts.now())
    acc.set(key, v)
  }
  const take = (key: string): void => {
    acc.set(key, 0)
    since.delete(key)
  }
  const pending: RateEmission[] = []
  let credit = 0
  let session = 0
  let seq = 0
  let maxActive = opts.maxActive
  let inFlight = 0
  return {
    tick(drips, blocks, spreadMs) {
      if (!(blocks > 0)) return
      const base = opts.now()
      for (const d of drips) {
        if (!Number.isFinite(d.usdPerBlock) || d.usdPerBlock <= 0) continue
        const add = d.usdPerBlock * blocks
        session += add
        const v = (acc.get(d.key) ?? 0) + add
        if (v < opts.emitUsd) {
          hold(d.key, v)
          continue
        }
        take(d.key)
        if (pending.length + inFlight >= maxActive) {
          credit += v
          continue
        }
        seq += 1
        const id = `ur-${d.key}-${seq}`
        pending.push({
          id,
          kind: v >= opts.pillUsd ? 'pill' : 'mote',
          stream: d.stream,
          label: d.label,
          assetId: d.assetId,
          usd: v,
          at: base + jitter(id) * Math.max(0, spreadMs),
        })
      }
    },
    ingest(items, spreadMs) {
      const base = opts.now()
      for (const item of items) {
        if (!Number.isFinite(item.usd) || item.usd <= 0) continue
        session += item.usd
        const id = `ur-item-${item.stream}-${item.block}-${item.eventIndex}-${item.legIndex}`
        let usd = item.usd
        if (usd < opts.emitUsd) {
          // Below a particle's worth: accrues with its stream and asset, as a drip does.
          const key = `item:${item.stream}:${item.assetId}`
          const v = (acc.get(key) ?? 0) + usd
          if (v < opts.emitUsd) {
            hold(key, v)
            continue
          }
          take(key)
          usd = v
        }
        if (pending.length + inFlight >= maxActive) {
          credit += usd
          continue
        }
        pending.push({
          id,
          kind: usd >= opts.pillUsd ? 'pill' : 'mote',
          stream: item.stream,
          label: item.label,
          assetId: item.assetId,
          account: usd === item.usd ? item.account : null,
          usd,
          at: base + jitter(id) * Math.max(0, spreadMs),
        })
      }
    },
    drain(now) {
      for (const [key, started] of since) {
        if (now - started < flushMs) continue
        credit += acc.get(key) ?? 0
        take(key)
      }
      const due: RateEmission[] = []
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].at <= now) {
          due.push(pending[i])
          pending.splice(i, 1)
        }
      }
      const out = { due: due.sort((a, b) => a.at - b.at), credit }
      credit = 0
      return out
    },
    flush() {
      for (const key of [...since.keys()]) {
        credit += acc.get(key) ?? 0
        take(key)
      }
    },
    sessionUsd: () => session,
    setMaxActive(n) {
      if (Number.isFinite(n) && n >= 1) maxActive = Math.floor(n)
    },
    setInFlight(n) {
      inFlight = Math.max(0, Math.floor(n))
    },
  }
}

/** The river's mode line: live per block, the revisable streams at their mean. */
export function userRiverModeLabel(rates: Pick<UserRevenueFlowResponse, 'revisableMeanHours'> | null): string {
  if (!rates) return 'waiting for the live feed'
  const mean = rates.revisableMeanHours ?? 24
  return `live per block; token, farm, voting and legacy staking streams at their ${mean}h mean`
}

/**
 * The first pull after a hidden tab returns accrues at most this many blocks
 * (the river does not replay the absence). A visible tab accrues every block the
 * head advanced, however slow its pull was.
 */
export const MAX_BLOCKS_AFTER_RESUME = 12

/** What the fetch loop carries from one pull to the next. */
export interface UserFlowFeedState {
  cursor: string | null
  lastHead: number
  lastBatchAt: number
  /** A resumed tab's catch-up spread (ms), consumed by the next pull. */
  resumeSpread: number
  /** The tab was hidden since the last pull: the next pull's drip blocks are capped. */
  resumed: boolean
}

export const initialUserFlowFeed = (): UserFlowFeedState => ({ cursor: null, lastHead: 0, lastBatchAt: 0, resumeSpread: 0, resumed: false })

const dripsOf = (r: UserRevenueFlowResponse): RateDrip[] => r.drips.map(d => ({ key: d.key, stream: d.stream, label: d.label, assetId: d.assetId, usdPerBlock: d.usdPerBlock }))

/**
 * One pull's effect, PURE apart from the scheduler it feeds: the items are spread
 * over the observed batch interval (a calm first window on the first pull), the
 * drips ticked once per block the head advanced (capped only on the first pull
 * after a hidden tab returns) — or three blocks on the first pull, so the river
 * opens mid-flow — and the cursor kept.
 */
export function feedUserFlow(scheduler: RateScheduler, state: UserFlowFeedState, res: UserRevenueFlowResponse, now: number): UserFlowFeedState {
  const headDelta = state.lastHead > 0 ? Math.max(0, res.head - state.lastHead) : 0
  let gapMs = state.lastBatchAt > 0 ? Math.min(90_000, Math.max(res.blockSeconds * 1_500, now - state.lastBatchAt)) : 15_000
  if (state.resumeSpread > 0) gapMs = Math.max(gapMs, state.resumeSpread)
  const items = res.items ?? []
  scheduler.ingest(items, gapMs)
  if (headDelta > 0) scheduler.tick(dripsOf(res), state.resumed ? Math.min(MAX_BLOCKS_AFTER_RESUME, headDelta) : headDelta, gapMs)
  else if (state.lastHead === 0) scheduler.tick(dripsOf(res), 3, 6_000)
  return {
    cursor: res.cursor ?? state.cursor,
    lastHead: Math.max(state.lastHead, res.head),
    lastBatchAt: items.length || headDelta > 0 ? now : state.lastBatchAt,
    resumeSpread: 0,
    resumed: false,
  }
}

/**
 * Feeds a rate scheduler from /explorer/revenue/user-flow the way the protocol
 * river is fed (useRevenueFlowStream.ts): one pull per head push (an interval
 * fallback while the SSE is down), keeping the cursor; each pull's items are
 * spread over the observed batch interval and the drips ticked once per block
 * the head advanced (capped only on the first pull after a hidden tab returns, so
 * it does not burst on return).
 * Paused while the document is hidden; a long absence restarts with a fresh
 * seed. Returns each response through `onRates`, for the label and ledger.
 */
export function useUserRevenueFlowStream(scheduler: RateScheduler, onRates: (r: UserRevenueFlowResponse) => void): void {
  const onRatesRef = useRef(onRates)
  useEffect(() => { onRatesRef.current = onRates }, [onRates])

  useEffect(() => {
    let disposed = false
    let feed = initialUserFlowFeed()
    let lastPull = 0
    let hiddenAt = 0
    // A timestamp, not a boolean (a frozen page may never settle a fetch), and an epoch so a superseded pull is discarded whole.
    let inflightAt = 0
    let epoch = 0
    let controller: AbortController | null = null

    const pull = async (): Promise<void> => {
      if (Date.now() - inflightAt < 15_000 || document.hidden) return
      const own = ++epoch
      controller?.abort()
      const ctl = new AbortController()
      controller = ctl
      inflightAt = Date.now()
      try {
        const res = mergeFlowCatchup(await api.userRevenueFlow(feed.cursor, ctl.signal))
        if (disposed || own !== epoch) return
        onRatesRef.current(res)
        feed = feedUserFlow(scheduler, feed, res, Date.now())
      } catch {
        // Transient: the head SSE and the fallback interval retry.
      } finally {
        if (own === epoch) inflightAt = 0
        if (controller === ctl) controller = null
      }
    }

    const timedPull = (): void => {
      lastPull = Date.now()
      void pull()
    }
    // Head frames can arrive far faster than blocks; one pull per block is enough.
    const throttledPull = (): void => {
      if (Date.now() - lastPull >= 1_200) timedPull()
    }
    const onVisibility = (): void => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      const awayMs = hiddenAt > 0 ? Date.now() - hiddenAt : 0
      if (awayMs > FLOW_RESUME_RESET_MS) {
        feed = initialUserFlowFeed()
        inflightAt = 0
      } else if (awayMs > 0) {
        feed = { ...feed, resumed: true, resumeSpread: awayMs > 10_000 ? Math.min(60_000, awayMs / 2) : feed.resumeSpread }
      }
      hiddenAt = 0
      throttledPull()
    }
    timedPull()
    const unsubscribe = subscribeHead(throttledPull)
    // While pushes stop arriving (stream down), poll on the block cadence.
    const fallback = window.setInterval(() => {
      if (Date.now() - lastPull > LIVE_MS * 1.5) timedPull()
    }, LIVE_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    return () => {
      disposed = true
      controller?.abort()
      window.clearInterval(fallback)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onVisibility)
    }
  }, [scheduler])
}
