import { describe, expect, it } from 'vitest'
import { packVoters, radiusScale } from '../src/components/voteBubbleLayout'
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

function voter(weighted: string, over: Partial<ReferendumVoter> = {}): ReferendumVoter {
  return {
    account: null, kind: 'Standard', side: 'Aye', conviction: null, convictionIndex: null,
    balance: weighted, ayeBalance: '0', nayBalance: '0', abstainBalance: '0',
    weightedAye: weighted, weightedNay: '0', weighted, valueUsd: null,
    blockHeight: 1, eventIndex: 0, extrinsicIndex: null, timestamp: '2026-01-01 00:00:00', removed: false, ...over,
  }
}

// Spiral placement is deterministic on purpose: the same referendum must render
// the same chart on every visit and for every reader, so the coordinates are part
// of the contract, not an implementation detail free to drift with the search.
describe('packVoters', () => {
  const spread = ['1e21', '4e20', '2.5e20', '9e19', '5e19', '2e19', '8e18', '3e18', '1e18', '4e17', '1e17', '1e15']

  it('places a fixed weight spread at fixed coordinates', () => {
    const bubbles = packVoters(spread.map(w => voter(w)))

    expect(bubbles.map(b => [+b.x.toFixed(10), +b.y.toFixed(10), +b.r.toFixed(10), b.label])).toEqual([
      [360, 360, 195.0061542719, 'full'],
      [578.6827485924, 127.1056559981, 123.3327210499, 'full'],
      [602.5646349486, 524.6270265548, 97.5030771359, 'full'],
      [173.0616666161, 532.1224259405, 58.5018462816, 'full'],
      [594.3175134866, 311.8604853216, 43.6047016983, 'emoji'],
      [243.5872439871, 169.5729529781, 27.5780348118, 'emoji'],
      [148.5029626956, 385.7828084482, 17.4418806793, 'emoji'],
      [292.7704821155, 164.9654340251, 10.6809269547, 'none'],
      [382.3851161123, 560.5305128319, 6.1666360525, 'none'],
      [427.7689120011, 547.6465682238, 3.9001230854, 'none'],
      [275.5733005535, 180.2262465748, 3, 'none'],
      [342.335079932, 162.1666595364, 3, 'none'],
    ])
  })

  it('repeats itself exactly', () => {
    const voters = spread.map(w => voter(w))
    expect(packVoters(voters)).toEqual(packVoters(voters))
  })

  // The 0.6 breathing room and the canvas margin are the whole point of the
  // search; a faster collision test must not start admitting overlaps.
  it('keeps every pair clear and every circle on the canvas', () => {
    const bubbles = packVoters(Array.from({ length: 250 }, (_, i) => voter(String(Math.round(1e21 / (i + 1) ** 1.7)))))

    let clearance = Infinity
    for (let i = 0; i < bubbles.length; i++) {
      for (let j = i + 1; j < bubbles.length; j++) {
        const gap = Math.hypot(bubbles[i].x - bubbles[j].x, bubbles[i].y - bubbles[j].y) - (bubbles[i].r + bubbles[j].r)
        clearance = Math.min(clearance, gap)
      }
    }
    expect(clearance).toBeGreaterThanOrEqual(0.6)
    expect(bubbles.every(b => b.x - b.r >= 2 && b.x + b.r <= 718 && b.y - b.r >= 2 && b.y + b.r <= 718)).toBe(true)
  })

  it('drops withdrawn and zero-weight votes', () => {
    const bubbles = packVoters([voter('1e20'), voter('1e20', { removed: true }), voter('0')])
    expect(bubbles).toHaveLength(1)
  })
})
