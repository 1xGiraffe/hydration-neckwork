import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultiLineChart } from '../src/components/HdxCharts'
import type { ChartMarker } from '../src/components/ui'

// MultiLineChart's opt-ins for the Borrow tab's merged history chart: a second,
// unlabelled scale (the health factor beside USD) anchored on the axis floor, a
// floor zone under $0 holding the markers, and no date labels. Without them a
// chart draws exactly as before.
const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
const usd = { key: 'sup', label: 'Supplied', color: 'blue', values: [1000, 2000, 4000, 3000, 5000] }
const hfFmt = (v: number) => (v >= 3 ? '≥3' : v.toFixed(2))
const pathOf = (html: string, key: string) => html.match(new RegExp(`data-series="${key}"[^>]*><path d="([^"]+)"`))?.[1] ?? ''
const ys = (d: string) => [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map(m => Number(m[1]))
const liq: ChartMarker = { ts: '2026-09-03T12:00:00Z', kind: 'liquidation', label: 'Liquidation', valueUsd: 100, tip: <span>t</span> }
const ZONE = { frac: 0.13, color: 'var(--red)', label: 'Liquidation' }
// h 150, padT 12, padB 18: 120 units of plot, of which the zone takes frac/(1+frac).
const zoneH = 120 * 0.13 / 1.13, plotH = 120 - zoneH, floorY = 12 + plotH

describe('MultiLineChart second scale anchored on the axis floor, with a floor zone', () => {
  const chart = (hf: (number | null)[], extra: object = {}) => renderToStaticMarkup(
    <MultiLineChart buckets={days} h={150} floorZero yFmt={v => `$${v}`} markLast markers={[liq]}
      series={[usd, { key: 'hf', label: 'Health factor', color: 'grey', values: hf }]}
      secondary={{ keys: ['hf'], fmt: hfFmt, anchor: 1, max: 3 }} floorZone={ZONE} {...extra} />)
  const html = chart([1.2, 1, 3, 2, 0.5])

  it('puts the anchor (HF 1) exactly on the $0 floor line and the ceiling at the top', () => {
    const h = ys(pathOf(html, 'hf'))
    expect(h[1]).toBeCloseTo(floorY, 1)
    expect(h[2]).toBeCloseTo(12, 1)
    expect(h[0]).toBeCloseTo(12 + 0.9 * plotH, 1)
    // The USD floor is exactly $0 on the same line, and no axis label sits below it.
    expect(html).toContain(`y1="${floorY.toFixed(1)}"`)
    const labels = [...html.matchAll(/text-anchor="end">([^<]+)</g)].map(m => m[1]).filter(t => t !== 'Sep 5' && t !== 'Liquidation')
    expect(labels).toEqual(['$0', expect.any(String), expect.any(String)])
    expect(Math.max(...ys(pathOf(html, 'sup')))).toBeLessThanOrEqual(floorY + 0.05)
  })

  it('continues the scale below the anchor into the zone, clamped at its floor', () => {
    // HF 0.5 would land 25 % of the plot below $0; the zone floor holds it.
    expect(ys(pathOf(html, 'hf'))[4]).toBeCloseTo(floorY + zoneH, 1)
    const mild = ys(pathOf(chart([1.2, 1, 3, 2, 0.9]), 'hf'))[4]
    expect(mild).toBeCloseTo(floorY + 0.05 * plotH, 1)
    expect(mild).toBeLessThan(floorY + zoneH)
  })

  it('tops the scale at the data when it stays under the ceiling', () => {
    const h = ys(pathOf(chart([1.2, 1.5, 2, 1.8, 1.1]), 'hf'))
    // Top = 2 + 8 % of the 0.9 range; 2 sits just under the top gridline.
    const top = 2 + 0.9 * 0.08
    expect(h[2]).toBeCloseTo(12 + (1 - 1 / (top - 1)) * plotH, 1)
  })

  it('tints the zone, names it, and seats the markers in it', () => {
    expect(html).toMatch(new RegExp(`class="mlc-floor-zone" x="56" y="${floorY.toFixed(1)}" width="798" height="${zoneH.toFixed(1)}" fill="var\\(--red\\)" fill-opacity="0.1"`))
    // Right-aligned, centred in the strip; here stepped left of the HF line's
    // newest dot, which ends inside the zone at the plot's right edge (854 − 11 − 2).
    expect(html).toMatch(new RegExp(`class="hdx-ax mlc-floor-label" x="841.0" y="${(floorY + zoneH / 2).toFixed(1)}" text-anchor="end" dominant-baseline="central"[^>]*>Liquidation<`))
    expect(html).toContain('class="apx-marks lane"')
    expect(html).toContain(`top:${(floorY / 150 * 100).toFixed(3)}%`)
    expect(html).toContain(`bottom:${(18 / 150 * 100).toFixed(3)}%`)
  })

  it('keeps the label at the right edge when nothing is there, and lets a marker win', () => {
    const clear = chart([1.2, 1, 3, 2, 1.5])
    expect(clear).toMatch(/class="hdx-ax mlc-floor-label" x="846.0"/)
    // A liquidation on the last day: the label steps left of its cap (854 − 8.5 − 2).
    const atEdge = chart([1.2, 1, 3, 2, 1.5], { markers: [{ ...liq, ts: '2026-09-05T00:00:00Z' }] })
    expect(atEdge).toMatch(/class="hdx-ax mlc-floor-label" x="843.5"/)
  })

  it('draws the second-scale line thinner, marks both newest points, and drops the unit line', () => {
    expect(html).toMatch(/data-series="hf"[^>]*><path [^>]*stroke-width="1.5"/)
    expect(html).toMatch(/data-series="sup"[^>]*><path [^>]*stroke-width="2"/)
    expect(html.match(/r="3.5"/g)).toHaveLength(2)
    expect(html).not.toContain('stroke-dasharray="3 4"')
  })
})

describe('MultiLineChart without the opt-ins', () => {
  it('keeps markers as flags over the plot and no zone', () => {
    const html = renderToStaticMarkup(<MultiLineChart buckets={days} h={150} series={[usd]} markers={[liq]} />)
    expect(html).toContain('class="apx-marks"')
    expect(html).not.toContain('top:')
    expect(html).not.toContain('mlc-floor')
  })

  it('hides the date labels and their gutter on request only', () => {
    const plain = renderToStaticMarkup(<MultiLineChart buckets={days} h={150} series={[usd]} />)
    expect(plain).toMatch(/>Sep 5</)
    const bare = renderToStaticMarkup(<MultiLineChart buckets={days} h={150} series={[usd]} hideDates />)
    expect(bare).not.toMatch(/>Sep \d</)
    // The floor gridline moves down into the freed gutter (150 − 4).
    expect(bare).toContain('y1="146.0"')
  })
})
