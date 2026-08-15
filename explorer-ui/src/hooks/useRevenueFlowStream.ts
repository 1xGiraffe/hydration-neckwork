import { useEffect, useRef, useState } from 'react'
import { api } from '../api/explorer'
import { subscribeHead, LIVE_MS } from '../live'
import type { RevenueFlowItem, RevenueFlowResponse, RevenueStream } from '../types'

// The river's engine, split in two:
//
//  * createFlowScheduler — a PURE, deterministic pacing queue (tested in
//    tests/revenueFlow.test.tsx). Fetched items arrive per block; emitting
//    them the moment they arrive would make the river pulse at the block
//    cadence, which is exactly what the page promises not to do. Instead each
//    item is scheduled over ~1.5 block intervals with jitter derived from its
//    own identity — never Math.random, so a re-render or a replayed fetch
//    cannot reshuffle the water.
//  * useRevenueFlowStream — the fetch loop: rides the head SSE (poll fallback
//    when the stream is down), keeps the cursor, feeds the scheduler, and
//    ticks the borrow drip once per new block.
//
// Presentation tiers: an income below `pillThresholdUsd` is a text-free mote;
// above it, a readable pill. A burst past `maxActive` coalesces its mote-tier
// remainder into ONE merged mote per stream (largest incomes stay pills), so
// a liquidation cascade reads as a surge, not soup — and never as silence:
// the session total counts every cent that entered, whatever the tier.

export interface FlowEmission {
  id: string
  kind: 'pill' | 'mote' | 'merged'
  stream: RevenueStream
  usd: number
  /** Scheduled spawn time (ms, same clock as opts.now). */
  at: number
  /** The chain item behind a pill (motes carry none). */
  item: RevenueFlowItem | null
  /** Drip motes carry their market label for the tooltip. */
  label?: string
}

export interface FlowSchedulerOptions {
  blockMs: number
  maxActive: number
  pillThresholdUsd: number
  now: () => number
}

export interface FlowScheduler {
  ingest(items: RevenueFlowItem[], spreadMs?: number): void
  tickBlock(drips: RevenueFlowResponse['drips'], blocks?: number, spreadMs?: number): void
  drain(now: number): FlowEmission[]
  sessionTotalUsd(): number
  setBlockMs(ms: number): void
  /** Live density cap (mobile lowers it, fullscreen raises it). */
  setMaxActive(n: number): void
}

/** Deterministic 0..1 fraction from an item's chain identity. */
function jitterFraction(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 8) / 0x00ffffff
}

export function createFlowScheduler(opts: FlowSchedulerOptions): FlowScheduler {
  let blockMs = opts.blockMs
  let maxActive = opts.maxActive
  const pending: FlowEmission[] = []
  let sessionUsd = 0
  let dripSeq = 0

  function schedule(emission: FlowEmission): void {
    pending.push(emission)
  }

  return {
    ingest(items: RevenueFlowItem[], spreadMs?: number): void {
      if (!items.length) return
      const base = opts.now()
      const window = spreadMs != null && spreadMs > 0 ? spreadMs : 1.5 * blockMs
      for (const item of items) sessionUsd += item.usd

      // Tier by size first; the cap decides how much can fly individually.
      // Pills are ranked by value so a cascade keeps its headline incomes
      // readable, and the merged motes must FIT INSIDE the cap too — the whole
      // point of coalescing is that a burst never exceeds it.
      const pills = items.filter(i => i.usd >= opts.pillThresholdUsd).sort((a, b) => b.usd - a.usd)
      const motes = items.filter(i => i.usd < opts.pillThresholdUsd)
      const ranked = [...pills, ...motes]
      const room = Math.max(1, maxActive - Math.min(pending.length, maxActive))
      let flyCount = Math.min(room, ranked.length)
      let mergedStreams = new Set(ranked.slice(flyCount).map(i => i.stream)).size
      while (flyCount + mergedStreams > room && flyCount > 1) {
        flyCount -= 1
        mergedStreams = new Set(ranked.slice(flyCount).map(i => i.stream)).size
      }
      const flying = ranked.slice(0, flyCount)
      const overflowToMerge = ranked.slice(flyCount)

      for (const item of flying) {
        const id = `${item.block}-${item.eventIndex}-${item.legIndex}`
        schedule({
          id,
          kind: item.usd >= opts.pillThresholdUsd ? 'pill' : 'mote',
          stream: item.stream,
          usd: item.usd,
          at: base + jitterFraction(id) * window,
          item,
        })
      }
      if (overflowToMerge.length) {
        const byStream = new Map<RevenueStream, number>()
        for (const item of overflowToMerge) byStream.set(item.stream, (byStream.get(item.stream) ?? 0) + item.usd)
        for (const [stream, usd] of byStream) {
          const id = `merged-${stream}-${base}`
          schedule({ id, kind: 'merged', stream, usd, at: base + jitterFraction(id) * window, item: null })
        }
      }
    },

    tickBlock(drips: RevenueFlowResponse['drips'], blocks = 1, spreadMs?: number): void {
      const base = opts.now()
      const window = spreadMs != null && spreadMs > 0 ? spreadMs : blockMs
      for (const drip of drips) {
        if (drip.usdPerBlock <= 0) continue
        for (let block = 0; block < blocks; block += 1) {
          sessionUsd += drip.usdPerBlock
          dripSeq += 1
          const id = `drip-${drip.key}-${dripSeq}`
          // One mote per accrued block, spaced evenly across the window the
          // blocks actually cover, with per-mote jitter inside its slot.
          schedule({
            id,
            kind: 'mote',
            stream: drip.stream,
            usd: drip.usdPerBlock,
            at: base + ((block + jitterFraction(id)) / blocks) * window,
            item: null,
            label: drip.label,
          })
        }
      }
    },

    drain(now: number): FlowEmission[] {
      const due: FlowEmission[] = []
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].at <= now) {
          due.push(pending[i])
          pending.splice(i, 1)
        }
      }
      return due.sort((a, b) => a.at - b.at)
    },

    sessionTotalUsd(): number {
      return sessionUsd
    },

    setBlockMs(ms: number): void {
      if (Number.isFinite(ms) && ms > 0) blockMs = ms
    },

    setMaxActive(n: number): void {
      if (Number.isFinite(n) && n >= 1) maxActive = Math.floor(n)
    },
  }
}

// ---------------------------------------------------------------------------
// The fetch loop
// ---------------------------------------------------------------------------

export interface RevenueFlowStream {
  scheduler: FlowScheduler
  /** Last fetched drip rates (for the legend's live rates). */
  drips: RevenueFlowResponse['drips']
  blockSeconds: number
  connected: boolean
  /** Newest indexed block the feed served. */
  head: number
}

/**
 * Feeds a scheduler from /explorer/revenue/flow: fetches on every head push
 * (interval fallback while the SSE is down), ticks the borrow drip once per
 * block the head advanced (capped, so a background tab doesn't burst on
 * return), and pauses entirely while the document is hidden — the river only
 * flows when someone is watching it.
 */
export function useRevenueFlowStream(scheduler: FlowScheduler, paused = false): RevenueFlowStream {
  const [drips, setDrips] = useState<RevenueFlowResponse['drips']>([])
  const [blockSeconds, setBlockSeconds] = useState(6)
  const [connected, setConnected] = useState(false)
  const [head, setHead] = useState(0)
  const cursorRef = useRef<string | null>(null)
  const lastHeadRef = useRef(0)
  const lastBatchAtRef = useRef(0)
  const dripsRef = useRef<RevenueFlowResponse['drips']>([])
  const inflightRef = useRef(false)

  useEffect(() => {
    if (paused) return
    let disposed = false

    async function pull(): Promise<void> {
      if (inflightRef.current || document.hidden) return
      inflightRef.current = true
      try {
        const res = await api.revenueFlow(cursorRef.current)
        if (disposed) return
        cursorRef.current = res.cursor
        scheduler.setBlockMs(res.blockSeconds * 1000)
        // Raw ingestion lands in multi-block batches (the head often jumps ~10
        // blocks per push), so pacing to a block-and-a-half produced a clump
        // then a gap. Stretch each batch across the OBSERVED batch interval
        // instead, so the river flows evenly between arrivals.
        const now = Date.now()
        const headDelta = lastHeadRef.current > 0 ? Math.max(0, res.head - lastHeadRef.current) : 0
        const gapMs = lastBatchAtRef.current > 0
          ? Math.min(90_000, Math.max(res.blockSeconds * 1_500, now - lastBatchAtRef.current))
          : 15_000
        if (res.items.length || headDelta > 0) lastBatchAtRef.current = now
        scheduler.ingest(res.items, gapMs)
        dripsRef.current = res.drips
        setDrips(res.drips)
        setBlockSeconds(res.blockSeconds)
        setConnected(true)
        if (headDelta > 0) {
          // One drip mote per accrued block (capped so a returning background
          // tab surges a dozen blocks' worth, not an hour's), spread over the
          // same batch window.
          scheduler.tickBlock(res.drips, Math.min(12, headDelta), gapMs)
        } else if (lastHeadRef.current === 0) {
          // First pull: one tick so the river opens mid-flow rather than empty.
          scheduler.tickBlock(res.drips, 3, 10_000)
        }
        lastHeadRef.current = res.head
        setHead(res.head)
      } catch {
        if (!disposed) setConnected(false)
      } finally {
        inflightRef.current = false
      }
    }

    let lastPull = 0
    const timedPull = (): void => {
      lastPull = Date.now()
      void pull()
    }
    // Head frames can arrive far faster than blocks (mempool-only frames every
    // ~150ms on deployments with the mempool layer); the river only needs one
    // pull per block, so pushes inside the spacing window are ignored.
    const throttledPull = (): void => {
      if (Date.now() - lastPull >= 1_200) timedPull()
    }
    timedPull()
    const unsubscribe = subscribeHead(throttledPull)
    // Belt for the SSE's braces: while pushes stop arriving (stream down, or a
    // quiet reconnect), fall back to polling on the block cadence.
    const fallback = window.setInterval(() => {
      if (Date.now() - lastPull > LIVE_MS * 1.5) timedPull()
    }, LIVE_MS)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(fallback)
    }
  }, [scheduler, paused])

  return { scheduler, drips, blockSeconds, connected, head }
}
