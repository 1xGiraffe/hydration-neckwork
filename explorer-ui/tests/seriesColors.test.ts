import { describe, expect, it } from 'vitest'
import { colorDistance, separateSeriesColors } from '../src/utils/seriesColors'

// Pool 690 stacks vDOT against aDOT. Both are Polkadot-family icons, so both
// sample to the same pink and the 100% area chart read as one blob with a line
// through it. The palette validator puts the pair at ΔE 3.3 for NORMAL vision
// against a floor of 15 — not a colour-vision edge case, two colours nobody can
// separate.
const VDOT = '#e6007a'
const ADOT = '#e43583'

describe('colorDistance', () => {
  it('measures on the same scale the palette validator reports', () => {
    // The validator called this pair 3.3; agreeing to a whole number is enough
    // to trust the floor comparison.
    expect(colorDistance(VDOT, ADOT)).toBeLessThan(5)
    expect(colorDistance('#e6007a', '#95caff')).toBeGreaterThan(15)
    expect(colorDistance(VDOT, VDOT)).toBe(0)
  })

  it('never calls an unparseable colour a collision', () => {
    // The "Other" band is a CSS variable; it has no colour to compare here and
    // must not drag a real one off its icon hue.
    expect(colorDistance('var(--text-low)', VDOT)).toBe(Infinity)
  })
})

describe('separateSeriesColors', () => {
  it('leaves colours alone when they are already tellable apart', () => {
    const palette = ['#e6007a', '#95caff', '#74C742']
    expect(separateSeriesColors(palette)).toEqual(palette)
  })

  it('pulls a colliding band far enough away to be seen', () => {
    const [first, second] = separateSeriesColors([VDOT, ADOT])
    expect(first).toBe(VDOT)                       // the first series keeps its own colour
    expect(second).not.toBe(ADOT)
    expect(colorDistance(first, second)).toBeGreaterThanOrEqual(15)
  })

  it('separates every pair, not just neighbours in the list', () => {
    const out = separateSeriesColors([VDOT, ADOT, '#e30d7e', '#e11b80'])
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(colorDistance(out[i], out[j]), `${out[i]} vs ${out[j]}`).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('is deterministic, so a chart does not repaint between renders', () => {
    expect(separateSeriesColors([VDOT, ADOT])).toEqual(separateSeriesColors([VDOT, ADOT]))
  })

  it('passes a CSS variable through untouched', () => {
    expect(separateSeriesColors([VDOT, 'var(--text-low)'])).toEqual([VDOT, 'var(--text-low)'])
  })

  it('keeps a nudged band on the same lightness, so it stays legible on the surface', () => {
    const [, second] = separateSeriesColors([VDOT, ADOT])
    const before = hexL(ADOT), after = hexL(second)
    expect(Math.abs(before - after)).toBeLessThan(0.02)
  })
})

function hexL(hex: string): number {
  const srgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  const [r, g, b] = srgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
}
