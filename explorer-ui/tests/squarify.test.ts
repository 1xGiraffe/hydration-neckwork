import { describe, it, expect } from 'vitest'
import { squarify, type Rect } from '../src/utils/squarify'

const W = 800
const H = 450
const EPS = 1e-6

function area(r: Rect): number { return r.w * r.h }
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS &&
         a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
}

describe('squarify — pure treemap layout', () => {
  it('returns nothing for an empty input', () => {
    expect(squarify([], W, H)).toEqual([])
  })

  it('gives a single value the whole container', () => {
    const [r] = squarify([42], W, H)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.w).toBeCloseTo(W, 6)
    expect(r.h).toBeCloseTo(H, 6)
  })

  it('returns one rect per input value, in input order', () => {
    const values = [10, 6, 3, 1]
    const rects = squarify(values, W, H)
    expect(rects).toHaveLength(values.length)
    // Area of each rect is proportional to its value's share of the total.
    const total = values.reduce((s, v) => s + v, 0)
    const container = W * H
    values.forEach((v, i) => {
      expect(area(rects[i]) / container).toBeCloseTo(v / total, 4)
    })
  })

  it('keeps every rect within the container bounds', () => {
    const rects = squarify([9, 5, 5, 4, 2, 1, 1], W, H)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-EPS)
      expect(r.y).toBeGreaterThanOrEqual(-EPS)
      expect(r.w).toBeGreaterThan(0)
      expect(r.h).toBeGreaterThan(0)
      expect(r.x + r.w).toBeLessThanOrEqual(W + EPS)
      expect(r.y + r.h).toBeLessThanOrEqual(H + EPS)
    }
  })

  it('tiles the container without gaps or overlaps', () => {
    const values = [12, 7, 5, 3, 2, 1]
    const rects = squarify(values, W, H)
    // Full coverage: tile areas sum to the container area.
    const sum = rects.reduce((s, r) => s + area(r), 0)
    expect(sum).toBeCloseTo(W * H, 2)
    // No two tiles overlap.
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(overlaps(rects[i], rects[j]), `rect ${i} overlaps rect ${j}`).toBe(false)
  })

  it('splits two equal values into two equal tiles', () => {
    const rects = squarify([5, 5], W, H)
    expect(area(rects[0])).toBeCloseTo(area(rects[1]), 2)
    expect(area(rects[0]) + area(rects[1])).toBeCloseTo(W * H, 2)
  })

  it('keeps tile aspect ratios reasonable for skewed values (squarified, not sliced)', () => {
    // A dominant value plus many tiny ones should not produce extreme slivers.
    const rects = squarify([100, 3, 3, 3, 3, 3, 3], W, H)
    for (const r of rects) {
      const ar = Math.max(r.w / r.h, r.h / r.w)
      expect(ar).toBeLessThan(12)
    }
  })
})
