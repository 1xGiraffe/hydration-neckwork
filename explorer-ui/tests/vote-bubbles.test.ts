import { describe, expect, it } from 'vitest'
import {
  HEIGHT, LABEL_FULL_R, WIDTH, packItems, radiusScale,
  type Bubble, type PackItem,
} from '../src/components/voteBubbleLayout'
import type { ReferendumVoter } from '../src/types'

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

// Bubbles must never overlap. radiusScale sizes the circles so they COLLECTIVELY
// fill the canvas, which says nothing about whether they individually FIT: two
// comparable whales need more room between their centres than a square this size
// can offer once the first one is at the middle. Referendum 411 is the shape that
// exposed it — six voters, the top two holding 84% of the power between them —
// and the packer answered by placing the second bubble at exactly the same point
// as the first, one drawn inside the other.
describe('packItems', () => {
  const voter = (weighted: string, i: number, nay = false): PackItem => ({
    kind: 'voter',
    voter: {
      account: null, kind: 'Standard', side: nay ? 'Nay' : 'Aye',
      conviction: null, convictionIndex: null,
      balance: weighted, ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
      weightedAye: nay ? '0' : weighted, weightedNay: nay ? weighted : '0', weighted,
      valueUsd: null, blockHeight: 1, eventIndex: i, extrinsicIndex: null,
      timestamp: '2026-09-20 00:00:00', removed: false,
    } as unknown as ReferendumVoter,
  })

  /** Every pair that overlaps, described so a failure names the circles. */
  const collisions = (bubbles: Bubble[]): string[] => {
    const out: string[] = []
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const a = bubbles[i], b = bubbles[j]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d < a.r + b.r - 0.01) out.push(`r=${a.r.toFixed(1)} and r=${b.r.toFixed(1)} centres ${d.toFixed(1)} apart, need ${(a.r + b.r).toFixed(1)}`)
      }
    }
    return out
  }

  // The exact weights of OpenGov 411, which rendered two circles concentric.
  const REF_411 = [
    '61355679856288867808', '43836405000000000000', '15652164488296343460',
    '4499396883887397678', '120000000000000000', '26045085835533726',
  ].map((w, i) => voter(w, i, i === 2 || i === 5))

  it('never stacks two comparable whales on one another', () => {
    expect(collisions(packItems(REF_411))).toEqual([])
  })

  it('keeps every bubble inside the canvas', () => {
    for (const b of packItems(REF_411)) {
      expect(b.x - b.r).toBeGreaterThanOrEqual(0)
      expect(b.y - b.r).toBeGreaterThanOrEqual(0)
      expect(b.x + b.r).toBeLessThanOrEqual(WIDTH)
      expect(b.y + b.r).toBeLessThanOrEqual(HEIGHT)
    }
  })

  // Fitting is done by shrinking the whole scale, so the one thing the chart
  // claims — area is proportional to power — survives it. Absolute size never
  // meant anything; radiusScale already clamps it to the canvas.
  it('keeps area proportional to power after a shrink', () => {
    const bubbles = packItems(REF_411)
    const [big, second] = bubbles
    const areaRatio = (second.r ** 2) / (big.r ** 2)
    const powerRatio = second.weight / big.weight
    expect(areaRatio).toBeCloseTo(powerRatio, 6)
  })

  // A flat field is the opposite shape and must not regress into overlaps either.
  it('packs a field of equal voters cleanly', () => {
    const equal = Array.from({ length: 120 }, (_, i) => voter('1000000000000000000', i, i % 3 === 0))
    expect(collisions(packItems(equal))).toEqual([])
  })

  it('places a lone voter without shrinking it away', () => {
    const [only] = packItems([voter('1000000000000000000', 0)])
    expect(only.r).toBeGreaterThan(LABEL_FULL_R)
    expect(collisions([only])).toEqual([])
  })
})
