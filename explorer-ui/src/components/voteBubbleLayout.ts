import type { ReferendumVoter } from '../types'

// Layout maths for the vote bubble map, kept out of the component file so the
// component module exports only components (and so the scaling is unit-testable).
//
// AREA encodes power, not radius: a 6x-conviction whale outweighs a small voter by
// orders of magnitude, and a linear radius would render everyone else as a dot.
export const WIDTH = 720
export const HEIGHT = 720   // square: the cluster reads as one population, not a band
export const MIN_R = 3

// A bubble carries its account label only once the label fits inside it. Laid out in a
// row like a list pill, icon plus shortened address needs roughly 88 units of the
// 720-wide space, and a circle only offers about 1.8r of usable chord width — hence
// r >= 50. The icon alone needs about 28. Below that a label would spill past its own
// circle, so the bubble stays bare and the hover card does the identifying.
export const LABEL_FULL_R = 50
export const LABEL_EMOJI_R = 15

export type BubbleSide = 'aye' | 'nay' | 'split'

export interface Bubble {
  voter: ReferendumVoter
  x: number
  y: number
  r: number
  side: BubbleSide
  weight: number
  label: 'full' | 'emoji' | 'none'
}

// A Split vote backs both sides at once, so it is neither aye nor nay.
export function bubbleSide(voter: ReferendumVoter): BubbleSide {
  const aye = Number(voter.weightedAye), nay = Number(voter.weightedNay)
  if (aye > 0 && nay > 0) return 'split'
  return nay > 0 ? 'nay' : 'aye'
}

// The radius scale comes from the TOTAL power on the chart, not from the largest
// single vote: scaling the biggest bubble to the canvas made it ~115px tall in a
// 300px box, so every other voter had to overlap it (662 collisions on referendum
// 368). Solving pi*R^2*(sum w / max w) = area*fill for R makes the circles
// collectively fill the space, whatever the spread between the whale and the dust.
export function radiusScale(weights: number[], maxWeight: number, width: number): number {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0) || !(maxWeight > 0)) return MIN_R
  const usable = width * HEIGHT * 0.42
  const scale = Math.sqrt((usable * maxWeight) / (Math.PI * total))
  return Math.max(MIN_R, Math.min(scale, HEIGHT / 2.4))
}

// ONE cluster holding both sides, so the chart reads as a single population with the
// balance of the vote visible in the colour mix rather than as two charts to compare.
// Deterministic spiral placement — no randomness, so the same referendum always
// renders identically.
export function packVoters(voters: ReferendumVoter[]): Bubble[] {
  // Withdrawn votes back nothing, so they are not plotted — the tally excludes them too.
  const live = voters.filter(voter => !voter.removed && Number(voter.weighted) > 0)
  if (!live.length) return []
  const weightOf = (voter: ReferendumVoter) => Number(voter.weighted)
  const weights = live.map(weightOf)
  const maxWeight = Math.max(...weights)
  const maxR = radiusScale(weights, maxWeight, WIDTH)
  // Largest first: heavy circles claim the centre, small ones fill in around them.
  const ordered = [...live].sort((a, b) => weightOf(b) - weightOf(a))

  const placed: Bubble[] = []
  for (const voter of ordered) {
    const weight = weightOf(voter)
    // sqrt so AREA is proportional to power.
    const r = Math.max(MIN_R, Math.sqrt(weight / maxWeight) * maxR)
    let best: { x: number; y: number } | null = null
    for (let step = 0; step < 30_000; step++) {
      const angle = step * 0.35
      const radius = Math.sqrt(step) * 1.9
      const x = WIDTH / 2 + Math.cos(angle) * radius
      const y = HEIGHT / 2 + Math.sin(angle) * radius
      if (x - r < 2 || x + r > WIDTH - 2 || y - r < 2 || y + r > HEIGHT - 2) continue
      if (placed.every(other => Math.hypot(other.x - x, other.y - y) >= other.r + r + 0.6)) { best = { x, y }; break }
      // Remember the first in-bounds spot in case nothing ever clears.
      if (!best) best = { x, y }
    }
    placed.push({
      voter,
      x: best?.x ?? WIDTH / 2,
      y: best?.y ?? HEIGHT / 2,
      r,
      side: bubbleSide(voter),
      weight,
      label: r >= LABEL_FULL_R ? 'full' : r >= LABEL_EMOJI_R ? 'emoji' : 'none',
    })
  }
  return placed
}
