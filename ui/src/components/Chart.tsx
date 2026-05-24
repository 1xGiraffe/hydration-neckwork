import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
} from 'lightweight-charts'
import type {
  UTCTimestamp,
  MouseEventParams,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  IPriceLine,
} from 'lightweight-charts'
import type { ApiCandle, OHLCVInterval } from '../types'
import { fetchCandles } from '../api/candles'
import { formatCountdown } from '../utils/format'

const INTERVAL_SECONDS: Record<OHLCVInterval, number> = {
  '5min': 300, '15min': 900, '30min': 1800, '1h': 3600,
  '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592000,
}

const INITIAL_CANDLES = 300
const LOAD_MORE_THRESHOLD = 50
const LOAD_MORE_COUNT = 500
const POLL_INTERVAL_MS = 10_000
const PINNED_SCROLL_THRESHOLD = 5

interface ChartProps {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  base: string
  showVolumeSource?: boolean
  onVisibleRangeReady?: (getter: () => { from: number; to: number } | null) => void
  onDataChange?: (data: ApiCandle[]) => void
  onCountdownChange?: (label: string) => void
  theme: 'dark' | 'light'
}

interface Legend {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function formatPriceFixed(value: number): string {
  if (value >= 1000) return value.toFixed(2)
  if (value >= 1) return value.toFixed(4)
  return value.toFixed(6)
}

function formatUsdVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(2)
}

function formatUsdVolumeAxis(value: number): string {
  return `$${formatUsdVolume(value)}`
}

function getPriceFormat(data: ApiCandle[]) {
  if (data.length === 0) return { type: 'price' as const, precision: 2, minMove: 0.01 }
  const closes = data.map(c => c.close).sort((a, b) => a - b)
  const median = closes[Math.floor(closes.length / 2)]
  if (median >= 1000) return { type: 'price' as const, precision: 2, minMove: 0.01 }
  if (median >= 1) return { type: 'price' as const, precision: 4, minMove: 0.0001 }
  if (median >= 0.01) return { type: 'price' as const, precision: 6, minMove: 0.000001 }
  return { type: 'price' as const, precision: 8, minMove: 0.00000001 }
}

function normalizeCandles(data: ApiCandle[]): ApiCandle[] {
  const byTime = new Map<number, ApiCandle>()
  for (const candle of data) byTime.set(candle.intervalStart, candle)
  return [...byTime.values()].sort((a, b) => a.intervalStart - b.intervalStart)
}

function trailingBarsForViewport(): number {
  return window.innerWidth < 768 ? 8 : 3
}

function latestVisibleRange(dataLength: number) {
  const isNarrow = window.innerWidth < 768
  const visibleBars = Math.min(isNarrow ? 32 : 40, dataLength)
  return {
    from: Math.max(0, dataLength - visibleBars),
    to: dataLength - 1 + trailingBarsForViewport(),
  }
}

// Chart colors per theme. Lightweight-charts is strict about color formats — keep these
// as concrete hex/rgba values instead of reading CSS variables (some headless renderers
// also miss CSS-var resolution before the first paint).
const CHART_PALETTES = {
  dark: {
    bg: 'rgb(3, 8, 22)',
    textMedium: 'rgb(165, 156, 171)',
    textLow: 'rgb(110, 103, 118)',
    separator: 'rgba(255, 255, 255, 0.05)',
    green: 'rgb(116, 199, 66)',
    red: 'rgb(255, 104, 104)',
    accent: 'rgb(229, 62, 118)',
  },
  light: {
    bg: 'rgb(239, 237, 234)',
    textMedium: 'rgb(107, 103, 112)',
    textLow: 'rgb(141, 137, 149)',
    separator: 'rgba(36, 14, 50, 0.08)',
    green: 'rgb(69, 172, 31)',
    red: 'rgb(216, 59, 59)',
    accent: 'rgb(229, 62, 118)',
  },
} as const

interface ChartPalette {
  bg: string
  textMedium: string
  textLow: string
  separator: string
  green: string
  red: string
  accent: string
}

function paletteForTheme(theme?: 'dark' | 'light' | string | null): ChartPalette {
  // Prefer the explicit theme argument so callers stay independent of the order
  // in which React applies side-effects to `data-theme` vs. paints the chart.
  const t = theme ?? (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : 'dark')
  return (t === 'light' ? CHART_PALETTES.light : CHART_PALETTES.dark) as ChartPalette
}

function isLight(p: ChartPalette): boolean { return p.bg === CHART_PALETTES.light.bg }

export default function Chart({
  baseId, quoteId, interval, base, showVolumeSource = false,
  onVisibleRangeReady, onDataChange, onCountdownChange, theme,
}: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const countdownLineRef = useRef<IPriceLine | null>(null)

  const allDataRef = useRef<ApiCandle[]>([])
  const oldestTimestampRef = useRef<number>(Infinity)
  const isLoadingMoreRef = useRef(false)
  const reachedBeginningRef = useRef(false)
  const initialLoadRequestIdRef = useRef(0)

  const [legend, setLegend] = useState<Legend | null>(null)
  const [loading, setLoading] = useState(true)
  // Mirror the latest theme into a ref so callbacks/intervals read the live
  // value without needing to be rebuilt (and without depending on document
  // attribute order-of-application).
  const themeRef = useRef(theme)
  useEffect(() => { themeRef.current = theme }, [theme])

  const themeKey = theme

  const fetchData = useCallback(async (from: number, to: number) => {
    return fetchCandles({ baseId, quoteId, interval, from, to })
  }, [baseId, quoteId, interval])

  const applyData = useCallback((data: ApiCandle[]) => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!candleSeries || !volumeSeries) return

    const pal = paletteForTheme(themeRef.current)
    // Volume bars use the candle colors at 0.32 opacity, matching the design tokens.
    const greenVol = pal.green.replace('rgb(', 'rgba(').replace(')', ', 0.32)')
    const redVol = pal.red.replace('rgb(', 'rgba(').replace(')', ', 0.32)')

    const candleData: CandlestickData[] = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    const volumeData: HistogramData[] = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      value: c.volumeTotal,
      color: c.close >= c.open ? greenVol : redVol,
    }))

    candleSeries.applyOptions({ priceFormat: getPriceFormat(data) })
    candleSeries.setData(candleData)
    volumeSeries.setData(volumeData)
    onDataChange?.(data)
  }, [onDataChange])

  const replaceAllData = useCallback((data: ApiCandle[]) => {
    const normalized = normalizeCandles(data)
    allDataRef.current = normalized
    oldestTimestampRef.current = normalized[0]?.intervalStart ?? Infinity
    applyData(normalized)
    return normalized
  }, [applyData])

  const showLatestCandles = useCallback(() => {
    const ts = chartRef.current?.timeScale()
    const dataLength = allDataRef.current.length
    if (!ts || dataLength === 0) return
    ts.setVisibleLogicalRange(latestVisibleRange(dataLength))
  }, [])

  const restoreVisibleRange = useCallback((range: { from: number; to: number }, shift = 0) => {
    window.requestAnimationFrame(() => {
      const ts = chartRef.current?.timeScale()
      if (!ts) return
      ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift })
    })
  }, [])

  // Chart creation
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    const palette = paletteForTheme(themeRef.current)
    const bg = palette.bg
    const txtMed = palette.textMedium
    const txtLow = palette.textLow
    const sep = palette.separator
    const green = palette.green
    const red = palette.red

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: txtMed,
        panes: { separatorColor: sep },
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: window.innerWidth < 768 ? 70 : 30 },
      crosshair: {
        mode: 0,
        vertLine: { color: txtLow, width: 2, style: 1, labelBackgroundColor: txtLow },
        horzLine: { color: txtLow, width: 2, style: 1, labelBackgroundColor: txtLow },
      },
      width: container.clientWidth,
      height: container.clientHeight,
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: green,
      downColor: red,
      borderVisible: false,
      wickUpColor: green,
      wickDownColor: red,
      lastValueVisible: false,
      priceLineVisible: true,
      priceLineColor: txtLow,
      priceLineWidth: 1,
      priceLineStyle: 2,
      crosshairMarkerVisible: false,
    } as never)

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: txtLow,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: formatUsdVolumeAxis },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    }, 1)
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
      borderVisible: false,
      visible: false,
    })
    chart.panes()[1].setHeight(Math.floor(container.clientHeight * 0.15))

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    if (onVisibleRangeReady) {
      onVisibleRangeReady(() => {
        const range = chartRef.current?.timeScale().getVisibleLogicalRange()
        if (!range) return null
        return { from: range.from, to: range.to }
      })
    }

    const crosshairHandler = (param: MouseEventParams) => {
      if (!param.time) { setLegend(null); return }
      const candle = param.seriesData.get(candleSeries) as CandlestickData | undefined
      const volume = param.seriesData.get(volumeSeries) as HistogramData | undefined
      if (candle) {
        setLegend({ open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: volume?.value ?? 0 })
      }
    }
    chart.subscribeCrosshairMove(crosshairHandler)

    const handleResize = () => {
      if (!containerRef.current) return
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      chart.panes()[1].setHeight(Math.floor(containerRef.current.clientHeight * 0.15))
    }
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)
    window.addEventListener('resize', handleResize)
    const settleTimer = setTimeout(handleResize, 300)

    return () => {
      resizeObserver.disconnect()
      clearTimeout(settleTimer)
      window.removeEventListener('resize', handleResize)
      chart.unsubscribeCrosshairMove(crosshairHandler)
      if (onVisibleRangeReady) onVisibleRangeReady(() => null)
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      countdownLineRef.current = null
      chart.remove()
    }
  }, [onVisibleRangeReady]) // create once; theme changes are handled by applyOptions below

  // Theme changes: re-apply colors on the existing chart instance so the
  // canvas doesn't get torn down and re-mounted (which used to blank out
  // the chart for a beat and occasionally for good).
  useEffect(() => {
    const chart = chartRef.current
    const candle = candleSeriesRef.current
    if (!chart || !candle) return
    const palette = paletteForTheme(themeKey)
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: palette.bg },
        textColor: palette.textMedium,
        panes: { separatorColor: palette.separator },
      },
      crosshair: {
        vertLine: { color: palette.textLow, labelBackgroundColor: palette.textLow },
        horzLine: { color: palette.textLow, labelBackgroundColor: palette.textLow },
      },
    })
    candle.applyOptions({
      upColor: palette.green,
      downColor: palette.red,
      wickUpColor: palette.green,
      wickDownColor: palette.red,
      priceLineColor: palette.textLow,
    } as never)
    if (allDataRef.current.length > 0) applyData(allDataRef.current)
  }, [themeKey, applyData])

  // Endless scroll
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return
    const chart = chartRef.current
    const series = candleSeriesRef.current

    const handler = async (logicalRange: { from: number; to: number } | null) => {
      if (!logicalRange || isLoadingMoreRef.current || reachedBeginningRef.current) return
      const barsInfo = series.barsInLogicalRange(logicalRange)
      if (!barsInfo || barsInfo.barsBefore > LOAD_MORE_THRESHOLD) return

      isLoadingMoreRef.current = true
      try {
        const oldest = oldestTimestampRef.current
        const from = oldest - INTERVAL_SECONDS[interval] * LOAD_MORE_COUNT
        const to = oldest - 1
        const older = await fetchData(from, to)
        if (older.length === 0) {
          reachedBeginningRef.current = true
        } else {
          const existing = new Set(allDataRef.current.map(c => c.intervalStart))
          const newCandles = older.filter(c => !existing.has(c.intervalStart))
          if (newCandles.length > 0) {
            const visibleRange = chart.timeScale().getVisibleLogicalRange()
            const previousLength = allDataRef.current.length
            const nextData = replaceAllData([...newCandles, ...allDataRef.current])
            const prependedCount = nextData.length - previousLength
            if (visibleRange && prependedCount > 0) restoreVisibleRange(visibleRange, prependedCount)
          } else {
            reachedBeginningRef.current = true
          }
        }
      } finally {
        isLoadingMoreRef.current = false
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler)
  }, [interval, fetchData, replaceAllData, restoreVisibleRange])

  // Initial load
  useEffect(() => {
    allDataRef.current = []
    oldestTimestampRef.current = Infinity
    reachedBeginningRef.current = false
    setLoading(true)

    const requestId = initialLoadRequestIdRef.current + 1
    initialLoadRequestIdRef.current = requestId
    const now = Math.floor(Date.now() / 1000)
    const from = now - INTERVAL_SECONDS[interval] * INITIAL_CANDLES

    fetchData(from, now).then(data => {
      if (initialLoadRequestIdRef.current !== requestId) return
      const normalized = replaceAllData(data)
      candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true })
      if (normalized.length > 0) {
        // Show only the most recent slice so candles render at a comfortable width.
        showLatestCandles()
        window.requestAnimationFrame(showLatestCandles)
      }
      setLoading(false)
    }).catch(() => {
      if (initialLoadRequestIdRef.current === requestId) setLoading(false)
    })

    return () => {
      if (initialLoadRequestIdRef.current === requestId) initialLoadRequestIdRef.current += 1
    }
  }, [baseId, quoteId, interval, fetchData, replaceAllData, showLatestCandles])

  // Live polling
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (allDataRef.current.length === 0) return
      const lastTime = allDataRef.current[allDataRef.current.length - 1].intervalStart
      const now = Math.floor(Date.now() / 1000)
      try {
        const recent = await fetchData(lastTime, now)
        if (recent.length === 0 || !candleSeriesRef.current || !volumeSeriesRef.current) return
        const ts = chartRef.current?.timeScale()
        const visibleRange = ts?.getVisibleLogicalRange() ?? null
        const wasPinnedToLatest = (ts?.scrollPosition() ?? Infinity) <= PINNED_SCROLL_THRESHOLD
        replaceAllData([...allDataRef.current, ...recent])
        if (wasPinnedToLatest) {
          ts?.scrollToPosition(-trailingBarsForViewport(), false)
        } else if (visibleRange) {
          restoreVisibleRange(visibleRange)
        }
      } catch {
        // Keep the current chart data if a live poll fails.
      }
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [fetchData, replaceAllData, restoreVisibleRange])

  // Countdown line on the price axis
  useEffect(() => {
    if (!candleSeriesRef.current) return
    const series = candleSeriesRef.current
    const intervalSec = INTERVAL_SECONDS[interval]
    const line = series.createPriceLine({
      price: 0,
      color: 'transparent',
      lineWidth: 1,
      lineStyle: 2,
      lineVisible: false,
      axisLabelVisible: true,
      title: '',
      axisLabelColor: paletteForTheme(themeRef.current).textLow,
      axisLabelTextColor: isLight(paletteForTheme(themeRef.current)) ? 'rgb(35, 34, 38)' : 'rgb(245, 241, 248)',
    })
    countdownLineRef.current = line

    const tick = () => {
      const data = allDataRef.current
      if (data.length === 0) {
        line.applyOptions({ axisLabelVisible: false })
        onCountdownChange?.('')
        return
      }
      const lastCandle = data[data.length - 1]
      const candleEnd = lastCandle.intervalStart + intervalSec
      const remaining = Math.max(0, candleEnd - Math.floor(Date.now() / 1000))
      const label = formatCountdown(remaining)
      const pal = paletteForTheme(themeRef.current)
      line.applyOptions({
        price: lastCandle.close,
        axisLabelVisible: true,
        axisLabelColor: pal.textLow,
        axisLabelTextColor: isLight(pal) ? 'rgb(35, 34, 38)' : 'rgb(245, 241, 248)',
        title: label,
      })
      onCountdownChange?.(label)
    }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => {
      window.clearInterval(timer)
      try {
        series.removePriceLine(line)
      } catch {
        // The chart may have already disposed the price line during teardown.
      }
      countdownLineRef.current = null
    }
  }, [interval, baseId, quoteId, onCountdownChange])

  const data = allDataRef.current
  const displayLegend = legend ?? (data.length > 0 ? {
    open: data[data.length - 1].open,
    high: data[data.length - 1].high,
    low: data[data.length - 1].low,
    close: data[data.length - 1].close,
    volume: data[data.length - 1].volumeTotal,
  } : null)

  const upColor = useMemo(() => paletteForTheme(themeKey).green, [themeKey])

  return (
    <>
      <style>{`
        .chart-area { position: relative; background: var(--bg); overflow: hidden; width: 100%; height: 100%; }
        .chart-legend {
          position: absolute; top: 12px; left: 16px; right: 200px; z-index: 4; pointer-events: none;
          display: flex; flex-wrap: wrap; column-gap: 10px; row-gap: 2px;
          font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-medium);
        }
        /* On narrow viewports the price-axis labels crowd the top-right corner.
           Push the legend down so it does not overlap axis labels. */
        @media (max-width: 768px) {
          .chart-legend { left: 12px; right: 12px; top: 48px; }
        }
      `}</style>
      <div className="chart-area">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {loading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-low)', fontSize: 13, pointerEvents: 'none', zIndex: 6,
          }}>
            Loading…
          </div>
        )}

        {!loading && data.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-low)', fontSize: 13, pointerEvents: 'none', zIndex: 6, textAlign: 'center',
          }}>
            <div style={{ maxWidth: 320 }}>
              No candles available for this pair and interval yet. Try a different interval or check back later.
            </div>
          </div>
        )}

        {displayLegend && (
          <div className="chart-legend">
            <span style={{ whiteSpace: 'nowrap' }}>O {formatPriceFixed(displayLegend.open)}</span>
            <span style={{ whiteSpace: 'nowrap' }}>H {formatPriceFixed(displayLegend.high)}</span>
            <span style={{ whiteSpace: 'nowrap' }}>L {formatPriceFixed(displayLegend.low)}</span>
            <span style={{ whiteSpace: 'nowrap', color: displayLegend.close >= displayLegend.open ? upColor : 'var(--red)' }}>
              C {formatPriceFixed(displayLegend.close)}
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>V ${formatUsdVolume(displayLegend.volume)}{showVolumeSource ? ` (${base})` : ''}</span>
          </div>
        )}
      </div>
    </>
  )
}
