import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MirroredBarChart, StackedBarChart, barFrame, overlapView } from '../src/components/HdxCharts'

// Every <rect x y width> the chart drew, in document order.
const rects = (html: string) =>
  [...html.matchAll(/<rect x="([\d.-]+)" y="[\d.-]+" width="([\d.]+)"/g)].map(m => ({ x: Number(m[1]), w: Number(m[2]) }))

describe('bar charts without a zoomable time axis', () => {
  // The /hdx usage before the zoom was wired: no zoomKey, no refine. The bars
  // must still fill the plot by index — one slot each — not collapse into a
  // single full-width bar with the rest drawn past the canvas.
  it('MirroredBarChart lays n bars out side by side', () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ key: `2026-09-${String(i + 1).padStart(2, '0')}`, up: 10 + i, down: 5, tip: <span>t</span> }))
    // The transparent hover target is the one full-height rect per bar.
    const hit = rects(renderToStaticMarkup(<MirroredBarChart data={data} h={190} />)).filter((_, i) => i % 3 === 2)
    const xs = [...new Set(hit.map(r => r.x))]
    expect(xs).toHaveLength(12)
    expect(Math.max(...xs)).toBeLessThan(860)
    expect(hit[0].w).toBeCloseTo((860 - 4) / 12, 0)
  })

  it('StackedBarChart on non-time keys lays one column per bucket', () => {
    const html = renderToStaticMarkup(<StackedBarChart buckets={['a', 'b', 'c', 'd']} series={[{ key: 'x', label: 'x', color: 'red', values: [1, 2, 3, 4] }]} />)
    const xs = rects(html).map(r => r.x)
    expect(new Set(xs).size).toBe(4)
    expect(Math.max(...xs)).toBeLessThan(860)
  })
})

describe('zoomed bar windows', () => {
  const day = 86_400
  const t0 = Date.parse('2026-09-01T00:00:00Z') / 1000
  const keys = Array.from({ length: 5 }, (_, i) => new Date((t0 + i * day) * 1000).toISOString().slice(0, 10))

  it('keeps the coarse bar a window narrower than one bucket falls in', () => {
    const view = { from: t0 + 2 * day + 3_600, to: t0 + 2 * day + 7_200 }
    expect(overlapView(keys, k => k, view, day)).toEqual(['2026-09-03'])
    // Without a grain only instants inside the view qualify.
    expect(overlapView(keys, k => k, view, 0)).toEqual([])
  })

  it('pins a bar that opens before the view to the plot edge', () => {
    const frame = barFrame([t0], { from: t0 + 3_600, to: t0 + 7_200 }, 856, day)
    expect(frame.left(0)).toBe(0)
    expect(frame.slot).toBeGreaterThan(800)
  })
})
