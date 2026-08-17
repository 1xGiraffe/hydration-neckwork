import { describe, expect, it } from 'vitest'
import { createFlowScheduler } from '../src/hooks/useRevenueFlowStream'
import { advanceStage } from '../src/components/RevenueFlow'
import type { RevenueFlowItem } from '../src/types'

// The river's scheduler is pure and deterministic: fetched items are paced
// over ~1.5 block intervals with jitter derived from each item's identity
// (never Math.random — a re-render must not reshuffle the river), sub-threshold
// incomes become text-free motes, bursts past the cap coalesce into merged
// motes instead of flooding or silently dropping, and the session total counts
// every cent that entered regardless of presentation tier. The stage keeps the
// same guarantee downstream: a particle shed by the occupancy cap or the stray
// prune surrenders its USD for immediate credit instead of losing it.

function item(over: Partial<RevenueFlowItem>): RevenueFlowItem {
  return {
    stream: 'network_fee', block: 100, t: 1_755_000_000, eventIndex: 1, legIndex: 0,
    account: null, assetId: 0, usd: 0.01,
    ...over,
  }
}

const OPTS = { blockMs: 6_000, maxActive: 10, pillThresholdUsd: 0.05, now: () => 1_000_000 }

describe('createFlowScheduler', () => {
  it('paces ingested items over ~1.5 block intervals, deterministically', () => {
    const a = createFlowScheduler(OPTS)
    const b = createFlowScheduler(OPTS)
    const items = [1, 2, 3, 4].map(i => item({ eventIndex: i }))
    a.ingest(items)
    b.ingest(items)
    const till = 1_000_000 + 1.5 * 6_000 + 1
    const ea = a.drain(till)
    const eb = b.drain(till)
    expect(ea.length).toBe(4)
    // Same input → same schedule: identity-derived jitter, no randomness.
    expect(ea.map(e => e.at)).toEqual(eb.map(e => e.at))
    for (const e of ea) {
      expect(e.at).toBeGreaterThanOrEqual(1_000_000)
      expect(e.at).toBeLessThanOrEqual(till)
    }
    // Not all at the same instant — the pacing is what hides block steps.
    expect(new Set(ea.map(e => e.at)).size).toBeGreaterThan(1)
  })

  it('drains only what is due and keeps the rest pending', () => {
    const s = createFlowScheduler(OPTS)
    s.ingest([1, 2, 3, 4, 5, 6].map(i => item({ eventIndex: i })))
    const early = s.drain(1_000_000 + 1)
    const late = s.drain(1_000_000 + 10_000)
    expect(early.length + late.length).toBe(6)
    expect(late.every(e => e.at > 1_000_001)).toBe(true)
  })

  it('splits presentation tiers at the pill threshold', () => {
    const s = createFlowScheduler(OPTS)
    s.ingest([
      item({ eventIndex: 1, usd: 0.004 }),
      item({ eventIndex: 2, usd: 3.2, account: null }),
    ])
    const emissions = s.drain(1_000_000 + 10_000)
    expect(emissions.find(e => e.usd === 0.004)?.kind).toBe('mote')
    expect(emissions.find(e => e.usd === 3.2)?.kind).toBe('pill')
  })

  it('coalesces a burst past the cap into merged motes and conserves the total', () => {
    const s = createFlowScheduler(OPTS)
    const burst = Array.from({ length: 40 }, (_, i) => item({ eventIndex: i, usd: 0.01 * (i + 1) }))
    s.ingest(burst)
    const emissions = s.drain(1_000_000 + 10_000)
    expect(emissions.length).toBeLessThanOrEqual(OPTS.maxActive)
    expect(emissions.some(e => e.kind === 'merged')).toBe(true)
    const emitted = emissions.reduce((sum, e) => sum + e.usd, 0)
    const ingested = burst.reduce((sum, i) => sum + i.usd, 0)
    expect(emitted).toBeCloseTo(ingested, 9)
    expect(s.sessionTotalUsd()).toBeCloseTo(ingested, 9)
  })

  it('keeps the largest incomes as pills when coalescing', () => {
    const s = createFlowScheduler(OPTS)
    const burst = Array.from({ length: 30 }, (_, i) => item({ eventIndex: i, usd: i === 7 ? 250 : 0.01 }))
    s.ingest(burst)
    const emissions = s.drain(1_000_000 + 10_000)
    expect(emissions.find(e => e.usd === 250)?.kind).toBe('pill')
  })

  it('emits one mote per market per block tick and counts it', () => {
    const s = createFlowScheduler(OPTS)
    s.tickBlock([
      { key: '0xa', label: 'HOLLAR interest · core', stream: 'hollar_borrow', usdPerBlock: 0.006 },
      { key: '0xb', label: 'HOLLAR interest · gigahdx', stream: 'hollar_borrow', usdPerBlock: 0.0004 },
    ])
    const emissions = s.drain(1_000_000 + 10_000)
    expect(emissions).toHaveLength(2)
    expect(emissions.every(e => e.kind === 'mote' && e.stream === 'hollar_borrow')).toBe(true)
    expect(s.sessionTotalUsd()).toBeCloseTo(0.0064, 9)
  })
})

describe('advanceStage', () => {
  const p = (usd: number, at: number) => ({ usd, at })
  const NOW = 1_000_000

  it('credits value shed by the occupancy cap instead of losing it', () => {
    const prev = Array.from({ length: 195 }, () => p(0.01, NOW - 1_000))
    const due = Array.from({ length: 10 }, () => p(1, NOW))
    const { next, droppedUsd } = advanceStage(prev, due, NOW)
    expect(next.length).toBe(200)
    // Five oldest particles fell off the cap; their USD arrives immediately.
    expect(droppedUsd).toBeCloseTo(0.05, 9)
    // Conservation: what entered = what is still flying + what was credited.
    const entered = [...prev, ...due].reduce((s, x) => s + x.usd, 0)
    expect(next.reduce((s, x) => s + x.usd, 0) + droppedUsd).toBeCloseTo(entered, 9)
  })

  it('credits strays whose animation clock a freeze swallowed', () => {
    const prev = [p(2.5, NOW - 91_000), p(0.4, NOW - 1_000)]
    const { next, droppedUsd } = advanceStage(prev, [], NOW)
    expect(next).toEqual([p(0.4, NOW - 1_000)])
    expect(droppedUsd).toBeCloseTo(2.5, 9)
  })
})
