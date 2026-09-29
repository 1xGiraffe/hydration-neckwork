import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MirroredBarChart, MultiLineChart, StackedAreaChart, StackedBarChart } from '../src/components/HdxCharts'

// The zoom window rides the URL (`?zstk=from-to`). The page tests render on the
// router's server snapshot, where every query value is empty, so a window can
// only reach the hook through a mocked router.
const urlWindows = new Map<string, string>()
vi.mock('../src/router', () => ({
  useQueryValue: (key: string, fallback = '') => urlWindows.get(key) ?? fallback,
  setQuery: () => {},
}))

const utc = (s: string) => Date.parse(s) / 1000
// The live /hdx shape: monthly buckets keyed by their start, the current month
// last; /hollar's weekly trend, the current (Monday-anchored) week last. Late on
// the 28th both last buckets are open.
const NOW = utc('2026-09-28T19:30:00Z')
const months = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']
const weeks = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']
const series = (values: number[]) => [{ key: 'a', label: 'A', color: 'red', values }]
const zoomed = (html: string) => html.includes('aria-label="Reset zoom"')
const lastTickX = (html: string) => {
  const ticks = [...html.matchAll(/<text class="hdx-ax" x="([\d.]+)" y="\d+" text-anchor="(start|middle|end)">/g)]
  return ticks.length ? Number(ticks[ticks.length - 1][1]) : Number.NaN
}

// A series' points are bucket STARTS. Before the extent rule the hook's domain
// ended at the last point — the 1st of this month on a monthly chart, this
// Monday on a weekly one — so a window inside the current bucket was "past the
// data" and dropped, and no drag could commit past it either: the recent period,
// the one a zoom refines to days and hours, was the one part of the chart that
// could not be zoomed.
describe('chart zoom — the domain reaches the end of the open last bucket', () => {
  it('honours a URL window inside the current month on a monthly area chart', () => {
    urlWindows.set('zstk', `${utc('2026-09-10T00:00:00Z')}-${utc('2026-09-20T00:00:00Z')}`)
    const html = renderToStaticMarkup(<StackedAreaChart buckets={months} series={series([1, 2, 3, 4])} zoomKey="zstk" />)
    expect(zoomed(html)).toBe(true)
  })

  it('honours a window running from last month into the present', () => {
    urlWindows.set('zstk', `${utc('2026-08-15T00:00:00Z')}-${NOW}`)
    expect(zoomed(renderToStaticMarkup(<StackedAreaChart buckets={months} series={series([1, 2, 3, 4])} zoomKey="zstk" />))).toBe(true)
  })

  it('honours a window inside the current week on the weekly charts, bars included', () => {
    const w = `${utc('2026-09-28T06:00:00Z')}-${utc('2026-09-28T18:00:00Z')}`
    urlWindows.set('zrev', w)
    urlWindows.set('zdebt', w)
    urlWindows.set('zshare', w)
    urlWindows.set('zflow', w)
    expect(zoomed(renderToStaticMarkup(<StackedAreaChart buckets={weeks} series={series([1, 2, 3, 4])} zoomKey="zrev" />))).toBe(true)
    expect(zoomed(renderToStaticMarkup(<StackedBarChart buckets={weeks} series={series([1, 2, 3, 4])} zoomKey="zdebt" />))).toBe(true)
    expect(zoomed(renderToStaticMarkup(<MultiLineChart buckets={weeks} series={series([1, 2, 3, 4])} zoomKey="zshare" />))).toBe(true)
    const bars = weeks.map((key, i) => ({ key, up: i + 1, down: 1, tip: <span>t</span> }))
    expect(zoomed(renderToStaticMarkup(<MirroredBarChart data={bars} zoomKey="zflow" refine={async () => null} />))).toBe(true)
  })

  it('still drops a window past the last bucket\'s end, and one before the data', () => {
    urlWindows.set('zstk', `${utc('2026-10-02T00:00:00Z')}-${utc('2026-10-03T00:00:00Z')}`)
    expect(zoomed(renderToStaticMarkup(<StackedAreaChart buckets={months} series={series([1, 2, 3, 4])} zoomKey="zstk" />))).toBe(false)
    urlWindows.set('zstk', `${utc('2026-01-01T00:00:00Z')}-${utc('2026-02-01T00:00:00Z')}`)
    expect(zoomed(renderToStaticMarkup(<StackedAreaChart buckets={months} series={series([1, 2, 3, 4])} zoomKey="zstk" />))).toBe(false)
  })

  it('draws an unzoomed chart exactly as before: the last point on the plot\'s right edge', () => {
    urlWindows.delete('zstk')
    const html = renderToStaticMarkup(<StackedAreaChart buckets={months} series={series([1, 2, 3, 4])} zoomKey="zstk" />)
    expect(zoomed(html)).toBe(false)
    // AREA_W 860 − AREA_PAD_R 6: no blank plot after the last point.
    expect(lastTickX(html)).toBe(854)
    // The band's edge path ends on the same x.
    expect(html).toMatch(/L 854\.0 [\d.]+" fill="none"/)
  })
})
