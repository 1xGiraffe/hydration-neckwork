import { describe, expect, it } from 'vitest'
import { colorDistance, resolveAssetChartColors, separateSeriesColors } from '../src/utils/seriesColors'

// Pool 690 stacks vDOT against aDOT. Both are Polkadot-family icons, so both
// sample to the same pink and the 100% area chart read as one blob with a line
// through it. The palette validator puts the pair at ΔE 3.3 for NORMAL vision —
// two colours nobody can separate. The contract for fixing that is IDENTITY BY
// DEFAULT: icon colours never move unless two are near-duplicates, and then
// they separate into SHADES — same hue and chroma, small lightness steps.
const VDOT = '#e6007a'
const ADOT = '#e43583'
const FLOOR = 8 // near-duplicate threshold (OKLab ΔE ×100), mirrors the module

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

  it('moves only true near-duplicates — related colours are NOT a collision', () => {
    // USDT green vs HOLLAR green: same neighbourhood (ΔE ~15) but perfectly
    // tellable apart. Both keep their exact icon colours.
    const palette = ['#50af95', '#b3cf92']
    expect(separateSeriesColors(palette)).toEqual(palette)
  })

  it('pulls a colliding band far enough away to be seen', () => {
    const [first, second] = separateSeriesColors([VDOT, ADOT])
    expect(first).toBe(VDOT)                       // the first series keeps its own colour
    expect(second).not.toBe(ADOT)
    expect(colorDistance(first, second)).toBeGreaterThanOrEqual(FLOOR)
  })

  it('separates every pair, not just neighbours in the list', () => {
    const out = separateSeriesColors([VDOT, ADOT, '#e30d7e', '#e11b80'])
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(colorDistance(out[i], out[j]), `${out[i]} vs ${out[j]}`).toBeGreaterThanOrEqual(FLOOR)
      }
    }
  })

  it('is deterministic, so a chart does not repaint between renders', () => {
    expect(separateSeriesColors([VDOT, ADOT])).toEqual(separateSeriesColors([VDOT, ADOT]))
  })

  it('passes a CSS variable through untouched', () => {
    expect(separateSeriesColors([VDOT, 'var(--text-low)'])).toEqual([VDOT, 'var(--text-low)'])
  })

  it('separates by SHADE: hue and chroma stay, only lightness moves — and only a little', () => {
    // "Shades" is what the reader means by related-but-distinct: aDOT stays a
    // pink, darker or lighter than vDOT's, never another colour family.
    const [, second] = separateSeriesColors([VDOT, ADOT])
    expect(Math.abs(hueDelta(ADOT, second))).toBeLessThan(20)         // still the same pink
    expect(Math.abs(hexL(ADOT) - hexL(second))).toBeGreaterThan(0.05) // a shade apart…
    expect(Math.abs(hexL(ADOT) - hexL(second))).toBeLessThanOrEqual(0.25) // …but only slightly
  })

  it('separates two greys into shades of grey — never an invented hue', () => {
    // GETH (#686868) vs GSOL (#6f7174) sample to near-identical greys (ΔE 3.1).
    const [first, second] = separateSeriesColors(['#686868', '#6f7174'])
    expect(first).toBe('#686868')
    expect(colorDistance(first, second)).toBeGreaterThanOrEqual(FLOOR)
    const [r, g, b] = [1, 3, 5].map(i => parseInt(second.slice(i, i + 2), 16))
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24) // still a grey
  })
})

describe('resolveAssetChartColors', () => {
  const entries = [
    { key: 'hdx', assetId: 0, base: '#f6297c' },   // Hydration pink
    { key: 'dot', assetId: 5, base: ADOT },        // Polkadot pink family…
    { key: 'vdot', assetId: 15, base: VDOT },      // …all within ΔE 5 of each other
    { key: 'usdt', assetId: 10, base: '#74c742' },
  ]

  it('assigns every colliding asset a colour clear of every other, app-wide', () => {
    const out = resolveAssetChartColors(entries)
    const colors = [...out.values()]
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(colorDistance(colors[i], colors[j]), `${colors[i]} vs ${colors[j]}`).toBeGreaterThanOrEqual(FLOOR)
      }
    }
  })

  it('lets the established listing keep its exact icon colour (canonical order is assetId)', () => {
    const out = resolveAssetChartColors(entries)
    expect(out.get('hdx')).toBe('#f6297c') // lowest id wins the contested pink, untouched
    expect(out.get('dot')).not.toBe(ADOT)
    expect(out.get('vdot')).not.toBe(VDOT)
  })

  it('is independent of the order pages happened to register in', () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]]
    expect(resolveAssetChartColors(shuffled)).toEqual(resolveAssetChartColors(entries))
  })

  it('resolves duplicate keys once, so re-registering an asset cannot shift its colour', () => {
    const out = resolveAssetChartColors([
      { key: 'weth', assetId: 20, base: '#6e7588' },
      { key: 'weth', assetId: 20, base: '#6e7588' },
    ])
    expect([...out.keys()]).toEqual(['weth'])
    expect(out.get('weth')).toBe('#6e7588')
  })

  it('separates two assets that share one icon (an aToken borrowing its underlying)', () => {
    // DOT and aDOT sample to the same pink; distinct keys must come out apart.
    const out = resolveAssetChartColors([
      { key: '5', assetId: 5, base: ADOT },
      { key: '1001', assetId: 1001, base: ADOT },
    ])
    expect(out.get('5')).toBe(ADOT)
    expect(colorDistance(out.get('5')!, out.get('1001')!)).toBeGreaterThanOrEqual(FLOOR)
  })

  it('gives aDOT a shade of DOT — only lightness apart, same pink family', () => {
    const out = resolveAssetChartColors([
      { key: '5', assetId: 5, base: ADOT },
      { key: '1001', assetId: 1001, base: ADOT },
    ])
    const adot = out.get('1001')!
    expect(Math.abs(hueDelta(ADOT, adot))).toBeLessThan(20)          // still a pink
    expect(Math.abs(hexL(ADOT) - hexL(adot))).toBeGreaterThan(0.05)  // a darker/lighter one
    expect(Math.abs(hexL(ADOT) - hexL(adot))).toBeLessThanOrEqual(0.25)
  })

  it('never drifts a non-colliding asset: AAVE keeps its exact icon purple beside the pinks', () => {
    const AAVE = '#9391f7'
    const out = resolveAssetChartColors([
      ...entries,
      { key: 'adot', assetId: 1001, base: ADOT },
      { key: 'aave', assetId: 100624, base: AAVE },
    ])
    expect(out.get('aave')).toBe(AAVE) // byte-identical — identity is the default
    // And the whole DOT family stayed in family: every resolved pink is a pink.
    for (const k of ['dot', 'vdot', 'adot']) {
      expect(Math.abs(hueDelta(ADOT, out.get(k)!)), `${k} left the pink family`).toBeLessThan(20)
    }
  })

  it('passes a CSS variable through untouched and never treats it as a collision', () => {
    const out = resolveAssetChartColors([
      { key: 'other', assetId: -1, base: 'var(--text-low)' },
      { key: 'vdot', assetId: 15, base: VDOT },
    ])
    expect(out.get('other')).toBe('var(--text-low)')
    expect(out.get('vdot')).toBe(VDOT)
  })
})

function hexLab(hex: string): [number, number, number] {
  const srgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  const [r, g, b] = srgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}
function hexL(hex: string): number { return hexLab(hex)[0] }
// Signed OKLab hue difference in degrees, wrapped to (-180, 180].
function hueDelta(from: string, to: string): number {
  const h = (hex: string) => { const [, a, b] = hexLab(hex); return Math.atan2(b, a) * 180 / Math.PI }
  return ((h(to) - h(from) + 540) % 360) - 180
}
