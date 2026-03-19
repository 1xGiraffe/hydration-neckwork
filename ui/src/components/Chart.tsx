import { useEffect, useRef, useState, useCallback } from 'react'
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
import { INTERVAL_LABELS } from '../types'
import { fetchCandles } from '../api/candles'

const INTERVAL_SECONDS: Record<OHLCVInterval, number> = {
  '5min': 300, '15min': 900, '30min': 1800, '1h': 3600,
  '4h': 14400, '1d': 86400, '1w': 604800, '1M': 2592000,
}

const INITIAL_CANDLES = 300
const LOAD_MORE_THRESHOLD = 50
const LOAD_MORE_COUNT = 500
const POLL_INTERVAL_MS = 10_000

interface ChartProps {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  base: string
  quote: string
  baseName: string | null
  quoteName: string | null
  isQuoteStablecoin: boolean
  onVisibleRangeReady?: (getter: () => { from: number; to: number } | null) => void
  onDataChange?: (data: ApiCandle[]) => void
}

interface Legend {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function formatPrice(value: number): string {
  if (value >= 1000) return value.toFixed(2)
  if (value >= 1) return value.toFixed(4)
  return value.toFixed(6)
}

function formatVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(2)
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

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function Chart({ baseId, quoteId, interval, base, quote, baseName, quoteName, isQuoteStablecoin, onVisibleRangeReady, onDataChange }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const countdownLineRef = useRef<IPriceLine | null>(null)

  // Data state managed by Chart — accumulates as user scrolls left
  const allDataRef = useRef<ApiCandle[]>([])
  const oldestTimestampRef = useRef<number>(Infinity)
  const isLoadingMoreRef = useRef(false)
  const reachedBeginningRef = useRef(false)
  const isFirstLoadRef = useRef(true)

  const [legend, setLegend] = useState<Legend | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async (from: number, to: number) => {
    return fetchCandles({ baseId, quoteId, interval, from, to })
  }, [baseId, quoteId, interval])

  const applyData = useCallback((data: ApiCandle[]) => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return
    const candleData = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    const volumeData = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      value: c.volumeTotal,
      color: 'rgba(87, 107, 128, 0.5)',
    }))
    candleSeriesRef.current.applyOptions({ priceFormat: getPriceFormat(data) })
    candleSeriesRef.current.setData(candleData)
    volumeSeriesRef.current.setData(volumeData)
    onDataChange?.(data)
  }, [onDataChange])

  // Chart creation — runs once
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#030816' },
        textColor: '#94a3b8',
        panes: { separatorColor: 'rgba(13, 27, 42, 0.5)' },
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: window.innerWidth < 768 ? 70 : 30 },
      crosshair: {
        vertLine: { color: '#576B80', width: 1, style: 1 },
        horzLine: { color: '#576B80', width: 1, style: 1 },
      },
      width: container.clientWidth,
      height: container.clientHeight,
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#4FFFDF',
      downColor: '#576B80',
      borderVisible: false,
      wickUpColor: '#4FFFDF',
      wickDownColor: '#576B80',
      lastValueVisible: false,
      priceLineVisible: true,
      priceLineColor: '#576B80',
      priceLineStyle: 2,
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: 'rgba(87, 107, 128, 0.5)',
      priceFormat: { type: 'volume' },
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

    // Crosshair legend
    const crosshairHandler = (param: MouseEventParams) => {
      if (!param.time) { setLegend(null); return }
      const candle = param.seriesData.get(candleSeries) as CandlestickData | undefined
      const volume = param.seriesData.get(volumeSeries) as HistogramData | undefined
      if (candle) {
        setLegend({
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: volume?.value ?? 0,
        })
      }
    }
    chart.subscribeCrosshairMove(crosshairHandler)

    // Resize
    const handleResize = () => {
      if (!containerRef.current) return
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      })
      chart.panes()[1].setHeight(Math.floor(containerRef.current.clientHeight * 0.15))
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.unsubscribeCrosshairMove(crosshairHandler)
      if (onVisibleRangeReady) onVisibleRangeReady(() => null)
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      countdownLineRef.current = null
      chart.remove()
    }
  }, [])

  // Endless scroll: subscribe to visible range changes
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
          // Prepend and deduplicate
          const existing = new Set(allDataRef.current.map(c => c.intervalStart))
          const newCandles = older.filter(c => !existing.has(c.intervalStart))
          if (newCandles.length > 0) {
            allDataRef.current = [...newCandles, ...allDataRef.current]
              .sort((a, b) => a.intervalStart - b.intervalStart)
            oldestTimestampRef.current = allDataRef.current[0].intervalStart
            applyData(allDataRef.current)
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
  }, [interval, fetchData, applyData])

  // Initial load + reset on pair/interval change
  useEffect(() => {
    allDataRef.current = []
    oldestTimestampRef.current = Infinity
    reachedBeginningRef.current = false
    isFirstLoadRef.current = true
    setLoading(true)

    const now = Math.floor(Date.now() / 1000)
    const from = now - INTERVAL_SECONDS[interval] * INITIAL_CANDLES

    fetchData(from, now).then(data => {
      allDataRef.current = data
      if (data.length > 0) {
        oldestTimestampRef.current = data[0].intervalStart
      }
      applyData(data)
      if (isFirstLoadRef.current) {
        chartRef.current?.timeScale().fitContent()
        isFirstLoadRef.current = false
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [baseId, quoteId, interval, fetchData, applyData])

  // Auto-update: poll for new candles
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (allDataRef.current.length === 0) return
      const lastTime = allDataRef.current[allDataRef.current.length - 1].intervalStart
      // Fetch from last candle time to now (captures updates to current candle + new candle)
      const now = Math.floor(Date.now() / 1000)
      try {
        const recent = await fetchData(lastTime, now)
        if (recent.length === 0 || !candleSeriesRef.current || !volumeSeriesRef.current) return

        for (const c of recent) {
          candleSeriesRef.current.update({
            time: c.intervalStart as UTCTimestamp,
            open: c.open, high: c.high, low: c.low, close: c.close,
          })
          volumeSeriesRef.current.update({
            time: c.intervalStart as UTCTimestamp,
            value: c.volumeTotal,
            color: 'rgba(87, 107, 128, 0.5)',
          })

          const idx = allDataRef.current.findIndex(x => x.intervalStart === c.intervalStart)
          if (idx >= 0) {
            allDataRef.current[idx] = c
          } else {
            allDataRef.current.push(c)
          }
        }
        onDataChange?.(allDataRef.current)
      } catch {
        // Silent fail — will retry on next interval
      }
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [fetchData, onDataChange])

  // Countdown timer on the price axis
  useEffect(() => {
    if (!candleSeriesRef.current) return
    const series = candleSeriesRef.current
    const intervalSec = INTERVAL_SECONDS[interval]

    // Create the price line once
    const line = series.createPriceLine({
      price: 0,
      color: 'transparent',
      lineWidth: 1,
      lineStyle: 2,
      lineVisible: false,
      axisLabelVisible: true,
      title: '',
      axisLabelColor: '#1e293b',
      axisLabelTextColor: '#94a3b8',
    })
    countdownLineRef.current = line

    const tick = () => {
      const data = allDataRef.current
      if (data.length === 0) {
        line.applyOptions({ axisLabelVisible: false })
        return
      }
      const lastCandle = data[data.length - 1]
      const candleEnd = lastCandle.intervalStart + intervalSec
      const remaining = Math.max(0, candleEnd - Math.floor(Date.now() / 1000))
      line.applyOptions({
        price: lastCandle.close,
        axisLabelVisible: true,
        axisLabelColor: '#576B80',
        axisLabelTextColor: '#e2e8f0',
        title: formatCountdown(remaining),
      })
    }

    tick()
    const timer = window.setInterval(tick, 1000)

    return () => {
      window.clearInterval(timer)
      try { series.removePriceLine(line) } catch {}
      countdownLineRef.current = null
    }
  }, [interval, baseId, quoteId])

  // Legend fallback to last candle
  const data = allDataRef.current
  const displayLegend = legend ?? (data.length > 0 ? {
    open: data[data.length - 1].open,
    high: data[data.length - 1].high,
    low: data[data.length - 1].low,
    close: data[data.length - 1].close,
    volume: data[data.length - 1].volumeTotal,
  } : null)

  const displayQuote = isQuoteStablecoin ? 'USD' : quote
  const watermarkLine1 = `${base}${displayQuote}, ${INTERVAL_LABELS[interval]}`
  const nameParts = [baseName ?? base, isQuoteStablecoin ? 'USD' : (quoteName ?? quote)]
  const watermarkLine2 = nameParts.join(' / ')

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {/* Watermark — above canvas, below legend, non-interactive */}
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', zIndex: 5,
      }}>
        <div style={{ fontSize: '28px', fontWeight: 700, color: 'rgba(94, 118, 148, 0.22)', letterSpacing: '1px' }}>
          {watermarkLine1}
        </div>
        <div style={{ fontSize: '16px', fontWeight: 400, color: 'rgba(94, 118, 148, 0.15)', marginTop: '2px' }}>
          {watermarkLine2}
        </div>
      </div>
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#576B80', fontSize: '13px',
        }}>
          Loading...
        </div>
      )}
      {displayLegend && (
        <div style={{
          position: 'absolute', top: '8px', left: '12px', zIndex: 10,
          pointerEvents: 'none', fontSize: '12px', color: '#94a3b8',
          display: 'flex', gap: '10px',
        }}>
          <span>O {formatPrice(displayLegend.open)}</span>
          <span>H {formatPrice(displayLegend.high)}</span>
          <span>L {formatPrice(displayLegend.low)}</span>
          <span style={{ color: displayLegend.close >= displayLegend.open ? '#4FFFDF' : '#576B80' }}>
            C {formatPrice(displayLegend.close)}
          </span>
          <span>V {formatVolume(displayLegend.volume)} {base}</span>
        </div>
      )}
    </div>
  )
}
