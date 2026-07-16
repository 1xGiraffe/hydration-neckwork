import { describe, it, expect } from 'vitest'
import { vibrantColor } from '../src/utils/iconColor'

// Build an RGBA buffer from a list of [r,g,b,a] pixels.
function rgba(pixels: [number, number, number, number][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b, a], i) => { out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a })
  return out
}
function rep(px: [number, number, number, number], n: number): [number, number, number, number][] {
  return Array.from({ length: n }, () => px)
}
function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

describe('vibrantColor — dominant saturated color from icon pixels', () => {
  it('returns null when every pixel is transparent', () => {
    expect(vibrantColor(rgba(rep([255, 0, 0, 0], 20)))).toBeNull()
  })

  it('returns null for a flat opaque neutral (white) field — nothing vibrant', () => {
    expect(vibrantColor(rgba(rep([255, 255, 255, 255], 40)))).toBeNull()
  })

  it('picks the saturated colour out of a mostly-white icon', () => {
    // 90% white background, 10% pure red mark → red wins.
    const [r, g, b] = channels(vibrantColor(rgba([...rep([255, 255, 255, 255], 90), ...rep([220, 20, 20, 255], 10)]))!)
    expect(r).toBeGreaterThan(150)
    expect(r).toBeGreaterThan(g + 60)
    expect(r).toBeGreaterThan(b + 60)
  })

  it('recovers the hue of a solid blue field', () => {
    const [r, g, b] = channels(vibrantColor(rgba(rep([30, 90, 230, 255], 30)))!)
    expect(b).toBeGreaterThan(r + 60)
    expect(b).toBeGreaterThan(g + 40)
  })

  it('ignores transparent padding and near-black outlines', () => {
    const [r, g, b] = channels(vibrantColor(rgba([
      ...rep([0, 0, 0, 0], 50),      // transparent padding
      ...rep([10, 10, 10, 255], 20), // black outline
      ...rep([40, 200, 90, 255], 30) // green brand mark
    ]))!)
    expect(g).toBeGreaterThan(r + 60)
    expect(g).toBeGreaterThan(b + 60)
  })
})
