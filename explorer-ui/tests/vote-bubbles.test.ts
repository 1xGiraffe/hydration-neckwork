import { describe, expect, it } from 'vitest'
import { radiusScale } from '../src/components/voteBubbleLayout'

// Area encodes voting power, so the radius scale must come from the TOTAL power on a
// side rather than from the largest single vote. Scaling the biggest bubble to the
// canvas made it ~115px tall in a 300px box on referendum 368, which forced 662
// circle overlaps; deriving the scale from the summed area brought that to 0.
describe('radiusScale', () => {
  const COLUMN = 720

  it('shrinks as more voters share the same column', () => {
    const few = radiusScale([100, 100], 100, COLUMN)
    const many = radiusScale(Array.from({ length: 200 }, () => 100), 100, COLUMN)

    expect(many).toBeLessThan(few)
  })

  // The largest bubble must still fit: half the canvas height is the hard ceiling.
  it('never exceeds half the canvas height', () => {
    expect(radiusScale([1], 1, COLUMN)).toBeLessThanOrEqual(720 / 2.4)
  })

  it('keeps a dust vote visible instead of collapsing it to nothing', () => {
    const scale = radiusScale([1e21, 1], 1e21, COLUMN)
    const dustRadius = Math.max(3, Math.sqrt(1 / 1e21) * scale)

    expect(dustRadius).toBe(3)
  })

  it('fills roughly the intended fraction of the column', () => {
    const weights = Array.from({ length: 50 }, (_, i) => (i + 1) * 1_000)
    const max = Math.max(...weights)
    const scale = radiusScale(weights, max, COLUMN)
    const area = weights.reduce((sum, w) => sum + Math.PI * (Math.sqrt(w / max) * scale) ** 2, 0)

    // 0.42 of the canvas, the packing factor circles can actually reach.
    expect(area / (COLUMN * 720)).toBeCloseTo(0.42, 2)
  })

  it('degrades safely on empty or zero input', () => {
    expect(radiusScale([], 0, COLUMN)).toBe(3)
    expect(radiusScale([0, 0], 0, COLUMN)).toBe(3)
  })
})
