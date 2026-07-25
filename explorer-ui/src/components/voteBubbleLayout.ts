import type { ReferendumVoter } from '../types'

// Layout maths for the vote bubble map, kept out of the component file so the
// component module exports only components (and so the scaling is unit-testable).
//
// AREA encodes power, not radius: a 6x-conviction whale outweighs a small voter by
// orders of magnitude, and a linear radius would render everyone else as a dot.
export interface Bubble {
  voter: ReferendumVoter
  x: number
  y: number
  r: number
  side: 'aye' | 'nay'
}

export const WIDTH = 720
export const HEIGHT = 300
export const MIN_R = 2.5

// Deterministic spiral placement inside a half-width column. No randomness, so the
// same referendum always renders identically (and snapshots stay stable).
//
// The radius scale comes from the TOTAL power on the side, not from the largest
// single vote: scaling the biggest bubble to the canvas made it ~115px in a 300px
// box, so every other voter had to overlap it (662 collisions on referendum 368).
// Solving pi*R^2*(sum w / max w) = area*fill for R makes the circles collectively
// fill the column, whatever the spread between the whale and the dust.
export function radiusScale(weights: number[], maxWeight: number, columnWidth: number): number {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (!(total > 0) || !(maxWeight > 0)) return MIN_R
  const usable = columnWidth * HEIGHT * 0.42
  const scale = Math.sqrt((usable * maxWeight) / (Math.PI * total))
  return Math.max(MIN_R, Math.min(scale, HEIGHT / 2.6))
}

export function pack(voters: ReferendumVoter[], side: 'aye' | 'nay', maxWeight: number, cx: number): Bubble[] {
  const placed: Bubble[] = []
  const weights = voters
    .map(voter => Number(side === 'aye' ? voter.weightedAye : voter.weightedNay))
    .filter(weight => weight > 0)
  const maxR = radiusScale(weights, maxWeight, WIDTH / 2)
  for (const voter of voters) {
    const weight = Number(side === 'aye' ? voter.weightedAye : voter.weightedNay)
    if (!(weight > 0)) continue
    // sqrt so AREA is proportional to power.
    const r = Math.max(MIN_R, Math.sqrt(weight / maxWeight) * maxR)
    let x = cx, y = HEIGHT / 2, step = 0, best: { x: number; y: number } | null = null
    // Walk outward until the circle clears the ones already placed.
    while (step < 20_000) {
      const angle = step * 0.35
      const radius = Math.sqrt(step) * 2.1
      x = cx + Math.cos(angle) * radius
      y = HEIGHT / 2 + Math.sin(angle) * radius * 0.62
      const inside = x - r > 2 && x + r < WIDTH - 2 && y - r > 2 && y + r < HEIGHT - 2
      if (inside) {
        if (placed.every(other => Math.hypot(other.x - x, other.y - y) >= other.r + r + 0.6)) { best = { x, y }; break }
        // Remember the first in-bounds spot in case nothing ever clears.
        if (!best) best = { x, y }
      }
      step++
    }
    placed.push({ voter, x: best?.x ?? cx, y: best?.y ?? HEIGHT / 2, r, side })
  }
  return placed
}

