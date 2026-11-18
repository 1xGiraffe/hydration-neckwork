import type { ExplorerStats } from './types'

// The governance projector, as the api states it (/explorer/governance/clock): the
// head block's indexed time, advanced at the chain's measured pace. Every future
// governance moment the api dates (deadlines, the hub's coming-up dates, unlock dates) comes from
// it, and the pages place their own countdowns with the same two numbers — so a
// deadline reads the same on the hub, my governance and the referendum page.

export interface GovClock {
  headBlock: number
  headTs: string
  msPerBlock: number
  nominalMsPerBlock: number
  source: 'measured' | 'nominal'
  window: { fromBlock: number; toBlock: number } | null
}

// The api snaps the line's BASIS — the extrapolated instant of block 0 — to a
// 15-minute grid (api/src/services/lockBreakdownService.ts snapProjection /
// PROJECTION_GRID_MS), so its dates hold still between reloads and move together,
// once per grid crossing, as real block time drifts. The pages apply the same snap.
const PROJECTION_GRID_MS = 15 * 60_000

/** The line's basis: the instant block 0 would have had at this pace, snapped as the api snaps it. */
export function clockBasis(clock: GovClock): number {
  const raw = Date.parse(clock.headTs) - clock.headBlock * clock.msPerBlock
  return Math.round(raw / PROJECTION_GRID_MS) * PROJECTION_GRID_MS
}

/** A block's moment (epoch ms) on the governance line — the api's own date for it. */
export function projectBlock(clock: GovClock, block: number): number {
  return clockBasis(clock) + block * clock.msPerBlock
}

/** Time until a future block, or null when it is not ahead of the head. */
export function clockEta(clock: GovClock | undefined, block: number | null | undefined, now: number): { etaMs: number; secondsUntil: number } | null {
  if (!clock || block == null || block <= clock.headBlock) return null
  const etaMs = projectBlock(clock, block)
  return { etaMs, secondsUntil: Math.max(0, Math.ceil((etaMs - now) / 1000)) }
}

/**
 * The clock in the shape the shared progress card reads (head, head time, pace), so
 * its phase countdowns and period lengths sit on the same line as everything else.
 */
export function clockAsStats(clock: GovClock, stats?: ExplorerStats): ExplorerStats {
  const sec = clock.msPerBlock / 1000
  // The head is placed on the line itself, so the card's countdowns (head time plus
  // blocks × pace) land on exactly the api's dates.
  return { ...(stats ?? {} as ExplorerStats), headBlock: clock.headBlock, headTime: new Date(projectBlock(clock, clock.headBlock)).toISOString(), avgBlockSec: sec, nominalBlockSec: sec }
}
