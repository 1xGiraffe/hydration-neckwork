import { useEffect, useRef } from 'react'
import { mergeFlowCatchup } from '../utils/userRevenueMerge'
import { api } from '../api/explorer'
import { subscribeHead, LIVE_MS } from '../live'
import type { UserRevenueFlowResponse } from '../types'

// The user river's engine. User Revenue accrues continuously — interest every
// block, LP fees with every trade — but is BOOKED per closed hour, so there is no
// per-event feed to stream. The river therefore streams the newest folded hour's
// measured net rate per (stream, asset), one chain block at a time: the same
// "measured, not modelled" rule the protocol river's borrow drip follows. The
// response names the hour it streams, and the page says so.
//
// createRateScheduler is PURE and deterministic (tests/userRevenueFlow.test.ts):
// each drip accrues `usdPerBlock × blocks` into its own accumulator and emits a
// particle once the accumulated amount is worth one (|acc| ≥ emitUsd), carrying
// the WHOLE accumulated amount and its SIGN — an income flows in, a cost
// (borrow interest, exit fees, forfeits) flows out. Value is never dropped:
// when the river already has `maxActive` particles in flight, the amount is
// credited straight to the counter instead (`credit` from drain), exactly as
// the protocol river sheds a particle.

export interface RateDrip { key: string; stream: string; label: string; assetId?: number; usdPerBlock: number }

export interface RateEmission {
  id: string
  kind: 'pill' | 'mote'
  stream: string
  label: string
  /** The drip's asset, when it names one: a HOLLAR borrow cost wears HOLLAR's colour (revenueColors.ts). */
  assetId?: number
  /** Signed: < 0 flows out of the counter. */
  usd: number
  /** Scheduled spawn time (ms, same clock as opts.now). */
  at: number
}

export interface RateSchedulerOptions {
  /** An accumulator emits once its magnitude reaches this. */
  emitUsd: number
  /** At or above this magnitude an emission is a readable pill. */
  pillUsd: number
  maxActive: number
  now: () => number
}

export interface RateScheduler {
  tick(drips: RateDrip[], blocks: number, spreadMs: number): void
  /** Due emissions plus the value that could not fly (credit it to the counter). */
  drain(now: number): { due: RateEmission[]; credit: number }
  /** Net of everything accrued into the scheduler so far (emitted or credited or still accumulating). */
  sessionNetUsd(): number
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
        if (!Number.isFinite(d.usdPerBlock) || d.usdPerBlock === 0) continue
        const add = d.usdPerBlock * blocks
        session += add
        const v = (acc.get(d.key) ?? 0) + add
        if (Math.abs(v) < opts.emitUsd) {
          acc.set(d.key, v)
          continue
        }
        acc.set(d.key, 0)
        if (pending.length + inFlight >= maxActive) {
          credit += v
          continue
        }
        seq += 1
        const id = `ur-${d.key}-${seq}`
        pending.push({
          id,
          kind: Math.abs(v) >= opts.pillUsd ? 'pill' : 'mote',
          stream: d.stream,
          label: d.label,
          assetId: d.assetId,
          usd: v,
          at: base + jitter(id) * Math.max(0, spreadMs),
        })
      }
    },
    drain(now) {
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
    sessionNetUsd: () => session,
    setMaxActive(n) {
      if (Number.isFinite(n) && n >= 1) maxActive = Math.floor(n)
    },
    setInFlight(n) {
      inFlight = Math.max(0, Math.floor(n))
    },
  }
}

/** Refresh the rates this often: the fold publishes about hourly. */
const RATE_REFRESH_MS = 60_000
/** A returning background tab accrues at most this many blocks at once. */
const MAX_BLOCKS_PER_TICK = 12

/**
 * Feeds a rate scheduler: reads the drips (refreshed every minute), and ticks
 * the scheduler by the blocks the head advanced on every head push (a timed
 * tick at the measured block time while the push channel is down). Returns the
 * newest response through `onRates`, for the hour label.
 */
export function useUserRevenueFlowStream(scheduler: RateScheduler, onRates: (r: UserRevenueFlowResponse) => void): void {
  const ratesRef = useRef<UserRevenueFlowResponse | null>(null)
  const onRatesRef = useRef(onRates)
  useEffect(() => { onRatesRef.current = onRates }, [onRates])

  useEffect(() => {
    let disposed = false
    let lastHead = 0
    let lastTickAt = 0
    let controller: AbortController | null = null

    const refresh = async (): Promise<void> => {
      if (document.hidden) return
      controller?.abort()
      const own = new AbortController()
      controller = own
      try {
        const res = mergeFlowCatchup(await api.userRevenueFlow(own.signal))
        if (disposed) return
        ratesRef.current = res
        onRatesRef.current(res)
        if (lastHead === 0) {
          lastHead = res.head
          lastTickAt = Date.now()
          // Open mid-flow rather than empty.
          scheduler.tick(drips(res), 3, 6_000)
        }
      } catch {
        // Transient: the next refresh retries.
      } finally {
        if (controller === own) controller = null
      }
    }

    const drips = (r: UserRevenueFlowResponse): RateDrip[] => r.drips.map(d => ({ key: d.key, stream: d.stream, label: d.label, assetId: d.assetId, usdPerBlock: d.usdPerBlock }))

    const tickTo = (head: number): void => {
      const rates = ratesRef.current
      if (!rates || document.hidden) return
      const now = Date.now()
      if (lastHead > 0 && head > lastHead) {
        const blocks = Math.min(MAX_BLOCKS_PER_TICK, head - lastHead)
        const spread = Math.min(30_000, Math.max(rates.blockSeconds * 1_000, now - lastTickAt))
        scheduler.tick(drips(rates), blocks, spread)
        lastTickAt = now
      }
      if (head > lastHead) lastHead = head
    }

    void refresh()
    const rateTimer = window.setInterval(() => { void refresh() }, RATE_REFRESH_MS)
    const unsubscribe = subscribeHead(push => tickTo(push.head))
    // While pushes stop (stream down), advance by the measured block time.
    const fallback = window.setInterval(() => {
      const rates = ratesRef.current
      if (!rates || lastHead === 0 || Date.now() - lastTickAt < LIVE_MS * 1.5) return
      const blocks = Math.floor((Date.now() - lastTickAt) / (rates.blockSeconds * 1_000))
      if (blocks > 0) tickTo(lastHead + blocks)
    }, LIVE_MS)
    const onVisibility = (): void => {
      // Back from the background: restart the block count instead of bursting.
      if (!document.hidden) { lastTickAt = Date.now() }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      controller?.abort()
      window.clearInterval(rateTimer)
      window.clearInterval(fallback)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [scheduler])
}
