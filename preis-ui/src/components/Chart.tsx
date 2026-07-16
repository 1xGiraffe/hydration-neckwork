import { useEffect, useId, useMemo, useRef, useState, useCallback, type SyntheticEvent, type UIEvent } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
} from 'lightweight-charts'
import type {
  UTCTimestamp,
  Time,
  MouseEventParams,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  IPriceLine,
} from 'lightweight-charts'
import { INTERVAL_LABELS } from '../types'
import type { ApiCandle, OHLCVInterval, OmniwatchTrader, OmniwatchVolumeDetails } from '../types'
import { fetchCandles, fetchVolumeDetails } from '../api/candles'
import { formatCountdown } from '../utils/format'
import { candleEndTimestamp, previousCandleRange, recentCandleRange } from '../utils/candleTime'
import { keepTabFocusInside } from '../utils/focus'

// Account pills link into the sibling explorer app (mirrors the explorer's
// VITE_PREIS_URL wiring). Build-time env; falls back to the local docker UI.
const EXPLORER_URL = (import.meta.env.VITE_EXPLORER_URL as string | undefined) || 'http://localhost:5174'
function explorerAccountUrl(address: string): string {
  return `${EXPLORER_URL.replace(/\/+$/, '')}/account/${encodeURIComponent(address)}`
}

const INITIAL_CANDLES = 300
const LOAD_MORE_THRESHOLD = 50
const LOAD_MORE_COUNT = 500
const POLL_INTERVAL_MS = 10_000
const PINNED_SCROLL_TOLERANCE = 2
const OMNIWATCH_MARKER_MIN_BAR_WIDTH = 48
const OMNIWATCH_MARKER_MOBILE_MIN_BAR_WIDTH = 18
const OMNIWATCH_MARKER_ACCOUNT_MIN_BAR_WIDTH = 60
const VOLUME_DETAILS_PAGE_SIZE = 200

interface ChartProps {
  baseId: number
  quoteId: number
  interval: OHLCVInterval
  base: string
  showVolumeSource?: boolean
  onVisibleRangeReady?: (getter: () => { from: number; to: number } | null) => void
  onDataChange?: (data: ApiCandle[]) => void
  onCountdownChange?: (label: string) => void
  inspectionTime?: number | null
  onInspectionTimeChange?: (time: number | null) => void
  theme: 'dark' | 'light'
}

interface Legend {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface OmniwatchMarker {
  candle: ApiCandle
  x: number
  y: number
  showAccount: boolean
}

interface VolumeModalState {
  candle: ApiCandle
  details: OmniwatchVolumeDetails | null
  loading: boolean
  loadingMore: boolean
  error: string | null
}

function formatPriceFixed(value: number): string {
  const digits = value >= 1000 ? 2 : value >= 1 ? 4 : 6
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatUsdVolume(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(2)
}

function formatUsdVolumeAxis(value: number): string {
  return `$${formatUsdVolume(value)}`
}

function formatSignedUsdVolume(value: number): string {
  const sign = value >= 0 ? '+' : '-'
  return `${sign}$${formatUsdVolume(Math.abs(value))}`
}

function formatSignedPriceChange(value: number): string {
  const sign = value >= 0 ? '+' : '-'
  return `${sign}${formatPriceFixed(Math.abs(value))}`
}

function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatShortCount(value: number): string {
  if (value >= 999_500_000) return `${Math.round(value / 1_000_000_000)}b`
  if (value >= 999_500) return `${Math.round(value / 1_000_000)}m`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return formatCount(value)
}

function formatCandleDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(ts * 1000))
}

function showIconFallback(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = 'none'
  const fallback = event.currentTarget.nextElementSibling
  if (fallback instanceof HTMLElement) fallback.style.display = 'inline'
}

function OmniwatchIcon({ trader }: { trader: OmniwatchTrader }) {
  if (!trader.emojiUrl) return <span className="emoji">{trader.emoji}</span>

  return (
    <>
      <img
        className="emoji-img"
        src={trader.emojiUrl}
        alt={trader.emojiName ?? trader.emoji}
        title={trader.emojiName}
        onError={showIconFallback}
      />
      <span className="emoji icon-fallback">{trader.emoji}</span>
    </>
  )
}

function timeToSeconds(time: Time | undefined): number | null {
  return typeof time === 'number' ? time : null
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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

// Lightweight Charts requires concrete color values, so palettes are kept in code
// instead of being read from CSS variables at render time.
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
  onVisibleRangeReady, onDataChange, onCountdownChange,
  inspectionTime = null, onInspectionTimeChange, theme,
}: ChartProps) {
  const dataScopeKey = `${baseId}:${quoteId}:${interval}`
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const countdownLineRef = useRef<IPriceLine | null>(null)
  const volumePaneTopRef = useRef(0)
  const markerFrameRef = useRef<number | null>(null)
  const openVolumeModalRef = useRef<(candle: ApiCandle) => void>(() => undefined)
  const volumeRowsRef = useRef<HTMLDivElement>(null)
  const volumeModalRef = useRef<HTMLDivElement>(null)
  const volumeModalCloseRef = useRef<HTMLButtonElement>(null)
  const volumeDetailsPageRequestRef = useRef<string | null>(null)
  const initialLoadAbortRef = useRef<AbortController | null>(null)
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  const livePollAbortRef = useRef<AbortController | null>(null)
  const inspectionAbortRef = useRef<AbortController | null>(null)
  const volumeDetailsAbortRef = useRef<AbortController | null>(null)
  const activeDataScopeRef = useRef<string | null>(dataScopeKey)
  const inspectionRequestIdRef = useRef(0)

  const allDataRef = useRef<ApiCandle[]>([])
  const oldestTimestampRef = useRef<number>(Infinity)
  const isLoadingMoreRef = useRef(false)
  const reachedBeginningRef = useRef(false)

  const [legend, setLegend] = useState<Legend | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingVisible, setLoadingVisible] = useState(true)
  const [omniwatchMarkers, setOmniwatchMarkers] = useState<OmniwatchMarker[]>([])
  const [volumeModal, setVolumeModal] = useState<VolumeModalState | null>(null)
  const volumeModalTitleId = useId()
  const isVolumeModalOpen = volumeModal != null
  const currentVolumeModalTime = volumeModal?.candle.intervalStart ?? null
  // Mirror the latest theme into a ref so callbacks/intervals read the live
  // value without needing to be rebuilt (and without depending on document
  // attribute order-of-application).
  const themeRef = useRef(theme)
  useEffect(() => { themeRef.current = theme }, [theme])

  useEffect(() => {
    if (loading) {
      setLoadingVisible(true)
      return
    }
    const timer = window.setTimeout(() => setLoadingVisible(false), 180)
    return () => window.clearTimeout(timer)
  }, [loading])

  const themeKey = theme

  const abortCandleRequests = useCallback(() => {
    for (const requestRef of [
      initialLoadAbortRef,
      loadMoreAbortRef,
      livePollAbortRef,
      inspectionAbortRef,
      volumeDetailsAbortRef,
    ]) {
      requestRef.current?.abort()
      requestRef.current = null
    }
    isLoadingMoreRef.current = false
    volumeDetailsPageRequestRef.current = null
  }, [])

  useEffect(() => {
    activeDataScopeRef.current = dataScopeKey
    return () => {
      abortCandleRequests()
      if (activeDataScopeRef.current === dataScopeKey) {
        activeDataScopeRef.current = null
      }
    }
  }, [abortCandleRequests, dataScopeKey])

  const fetchData = useCallback(async (from: number, to: number, signal?: AbortSignal) => {
    return fetchCandles({ baseId, quoteId, interval, from, to }, signal)
  }, [baseId, quoteId, interval])

  const updateOmniwatchMarkers = useCallback(() => {
    const chart = chartRef.current
    const container = containerRef.current
    if (!chart || !container) {
      setOmniwatchMarkers([])
      return
    }

    const data = allDataRef.current
    if (data.length === 0) {
      setOmniwatchMarkers([])
      return
    }

    const range = chart.timeScale().getVisibleLogicalRange()
    const visibleBars = range ? Math.max(1, range.to - range.from) : 40
    const xStep = container.clientWidth / visibleBars
    const barWidth = xStep * 0.62
    const isMobile = container.clientWidth <= 768
    const minBarWidth = isMobile ? OMNIWATCH_MARKER_MOBILE_MIN_BAR_WIDTH : OMNIWATCH_MARKER_MIN_BAR_WIDTH
    const volumePaneHeight = Math.floor(container.clientHeight * 0.15)
    volumePaneTopRef.current = container.clientHeight - volumePaneHeight
    if (barWidth < minBarWidth) {
      setOmniwatchMarkers([])
      return
    }

    const y = volumePaneTopRef.current + 7
    const showAccount = barWidth >= OMNIWATCH_MARKER_ACCOUNT_MIN_BAR_WIDTH

    const next: OmniwatchMarker[] = []
    for (const candle of data) {
      if (!candle.omniwatch) continue
      const x = chart.timeScale().timeToCoordinate(candle.intervalStart as UTCTimestamp)
      if (x == null || x < -20 || x > container.clientWidth + 20) continue
      next.push({ candle, x, y, showAccount })
    }
    setOmniwatchMarkers(next)
  }, [])

  const scheduleOmniwatchMarkers = useCallback(() => {
    if (markerFrameRef.current != null) {
      window.cancelAnimationFrame(markerFrameRef.current)
    }
    markerFrameRef.current = window.requestAnimationFrame(() => {
      markerFrameRef.current = null
      updateOmniwatchMarkers()
    })
  }, [updateOmniwatchMarkers])

  const loadVolumeDetailsPage = useCallback((candle: ApiCandle, offset: number) => {
    const requestKey = `${baseId}:${quoteId}:${interval}:${candle.intervalStart}:${offset}`
    if (volumeDetailsPageRequestRef.current === requestKey) return
    volumeDetailsAbortRef.current?.abort()
    const controller = new AbortController()
    const requestScope = dataScopeKey
    volumeDetailsAbortRef.current = controller
    volumeDetailsPageRequestRef.current = requestKey

    setVolumeModal(current => (
      current?.candle.intervalStart === candle.intervalStart
        ? { ...current, loading: offset === 0, loadingMore: offset > 0, error: null }
        : current
    ))

    fetchVolumeDetails({
      baseId,
      quoteId,
      interval,
      time: candle.intervalStart,
      limit: VOLUME_DETAILS_PAGE_SIZE,
      offset,
    }, controller.signal)
      .then(details => {
        if (controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
        setVolumeModal(current => (
          current?.candle.intervalStart === candle.intervalStart
            ? {
                ...current,
                details: offset === 0 || !current.details
                  ? details
                  : { ...details, accounts: [...current.details.accounts, ...details.accounts] },
                loading: false,
                loadingMore: false,
                error: null,
              }
            : current
        ))
      })
      .catch(error => {
        if (isAbortError(error) || controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
        setVolumeModal(current => (
          current?.candle.intervalStart === candle.intervalStart
            ? {
                ...current,
                details: offset === 0 ? null : current.details,
                loading: false,
                loadingMore: false,
                error: error instanceof Error ? error.message : 'Failed to load volume details',
            }
            : current
        ))
      })
      .finally(() => {
        if (volumeDetailsAbortRef.current === controller) {
          volumeDetailsAbortRef.current = null
          volumeDetailsPageRequestRef.current = null
        }
      })
  }, [baseId, dataScopeKey, interval, quoteId])

  const openVolumeModal = useCallback((candle: ApiCandle, options: { syncUrl?: boolean } = {}) => {
    setVolumeModal({ candle, details: null, loading: true, loadingMore: false, error: null })
    loadVolumeDetailsPage(candle, 0)
    if (options.syncUrl !== false) onInspectionTimeChange?.(candle.intervalStart)
  }, [loadVolumeDetailsPage, onInspectionTimeChange])

  const closeVolumeModal = useCallback(() => {
    volumeDetailsAbortRef.current?.abort()
    volumeDetailsAbortRef.current = null
    volumeDetailsPageRequestRef.current = null
    setVolumeModal(null)
    onInspectionTimeChange?.(null)
  }, [onInspectionTimeChange])

  useEffect(() => {
    inspectionRequestIdRef.current += 1
    inspectionAbortRef.current?.abort()
    inspectionAbortRef.current = null
    volumeDetailsAbortRef.current?.abort()
    volumeDetailsAbortRef.current = null
    setVolumeModal(null)
    volumeDetailsPageRequestRef.current = null
  }, [baseId, quoteId, interval])

  const loadMoreVolumeDetails = useCallback(() => {
    if (
      !volumeModal?.details ||
      volumeModal.loading ||
      volumeModal.loadingMore ||
      !volumeModal.details.hasMore ||
      volumeModal.details.nextOffset == null
    ) {
      return
    }
    loadVolumeDetailsPage(volumeModal.candle, volumeModal.details.nextOffset)
  }, [loadVolumeDetailsPage, volumeModal])

  const handleVolumeRowsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      loadMoreVolumeDetails()
    }
  }, [loadMoreVolumeDetails])

  useEffect(() => {
    openVolumeModalRef.current = openVolumeModal
  }, [openVolumeModal])

  useEffect(() => {
    if (inspectionTime == null) {
      inspectionRequestIdRef.current += 1
      inspectionAbortRef.current?.abort()
      inspectionAbortRef.current = null
      volumeDetailsAbortRef.current?.abort()
      volumeDetailsAbortRef.current = null
      setVolumeModal(null)
      volumeDetailsPageRequestRef.current = null
      return
    }

    if (currentVolumeModalTime === inspectionTime) return

    const existing = allDataRef.current.find(candle => candle.intervalStart === inspectionTime)
    if (existing) {
      inspectionAbortRef.current?.abort()
      inspectionAbortRef.current = null
      openVolumeModal(existing, { syncUrl: false })
      return
    }

    const requestId = inspectionRequestIdRef.current + 1
    inspectionRequestIdRef.current = requestId
    setVolumeModal(current => (
      current?.candle.intervalStart === inspectionTime ? current : null
    ))
    volumeDetailsPageRequestRef.current = null
    inspectionAbortRef.current?.abort()
    const controller = new AbortController()
    const requestScope = dataScopeKey
    inspectionAbortRef.current = controller

    fetchData(inspectionTime, candleEndTimestamp(inspectionTime, interval), controller.signal)
      .then(candles => {
        if (
          controller.signal.aborted ||
          activeDataScopeRef.current !== requestScope ||
          inspectionRequestIdRef.current !== requestId
        ) return
        const candle = normalizeCandles(candles).find(item => item.intervalStart === inspectionTime)
        if (candle) openVolumeModal(candle, { syncUrl: false })
      })
      .catch(error => {
        if (isAbortError(error)) return
        // Keep the chart usable if a stale or unavailable inspection link fails.
      })
      .finally(() => {
        if (inspectionAbortRef.current === controller) {
          inspectionAbortRef.current = null
        }
      })

    return () => {
      controller.abort()
      if (inspectionAbortRef.current === controller) {
        inspectionAbortRef.current = null
      }
    }
  }, [currentVolumeModalTime, dataScopeKey, fetchData, inspectionTime, interval, openVolumeModal])

  useEffect(() => {
    if (!isVolumeModalOpen) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const focusFrame = window.requestAnimationFrame(() => volumeModalCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeVolumeModal()
        return
      }
      keepTabFocusInside(event, volumeModalRef.current)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [closeVolumeModal, isVolumeModalOpen])

  useEffect(() => {
    const el = volumeRowsRef.current
    if (
      !el ||
      !volumeModal?.details?.hasMore ||
      volumeModal.loading ||
      volumeModal.loadingMore
    ) {
      return
    }
    if (el.scrollHeight <= el.clientHeight + 24) {
      loadMoreVolumeDetails()
    }
  }, [
    volumeModal?.details?.accounts.length,
    volumeModal?.details?.hasMore,
    volumeModal?.loading,
    volumeModal?.loadingMore,
    loadMoreVolumeDetails,
  ])

  const applyData = useCallback((data: ApiCandle[]) => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    if (!candleSeries || !volumeSeries) {
      onDataChange?.(data)
      return
    }

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
    scheduleOmniwatchMarkers()
  }, [onDataChange, scheduleOmniwatchMarkers])

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
    const initialVolumePaneHeight = Math.floor(container.clientHeight * 0.15)
    volumePaneTopRef.current = container.clientHeight - initialVolumePaneHeight
    chart.panes()[1].setHeight(initialVolumePaneHeight)

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

    const clickHandler = (param: MouseEventParams) => {
      if (!param.point) return

      const data = allDataRef.current
      const time = timeToSeconds(param.time ?? chart.timeScale().coordinateToTime(param.point.x) ?? undefined)
      let candle = time == null ? undefined : data.find(item => item.intervalStart === time)

      if (!candle) {
        const logical = param.logical ?? chart.timeScale().coordinateToLogical(param.point.x)
        if (logical == null) return
        const index = Math.round(logical)
        if (Math.abs(logical - index) <= 0.5) candle = data[index]
      }

      if (candle) openVolumeModalRef.current(candle)
    }
    chart.subscribeClick(clickHandler)

    const markerRangeHandler = () => scheduleOmniwatchMarkers()
    chart.timeScale().subscribeVisibleLogicalRangeChange(markerRangeHandler)

    const handleResize = () => {
      if (!containerRef.current) return
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      const volumePaneHeight = Math.floor(containerRef.current.clientHeight * 0.15)
      volumePaneTopRef.current = containerRef.current.clientHeight - volumePaneHeight
      chart.panes()[1].setHeight(volumePaneHeight)
      scheduleOmniwatchMarkers()
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
      chart.unsubscribeClick(clickHandler)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(markerRangeHandler)
      if (markerFrameRef.current != null) {
        window.cancelAnimationFrame(markerFrameRef.current)
        markerFrameRef.current = null
      }
      if (onVisibleRangeReady) onVisibleRangeReady(() => null)
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      countdownLineRef.current = null
      chart.remove()
    }
  }, [onVisibleRangeReady, scheduleOmniwatchMarkers]) // create once; theme changes are handled by applyOptions below

  // Theme changes: re-apply colors on the existing chart instance so the
  // canvas isn't torn down and re-mounted — a remount blanks the chart for a
  // beat and occasionally for good.
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
      const controller = new AbortController()
      const requestScope = dataScopeKey
      loadMoreAbortRef.current = controller
      try {
        const oldest = oldestTimestampRef.current
        if (!Number.isFinite(oldest)) return
        const range = previousCandleRange(interval, oldest, LOAD_MORE_COUNT)
        const older = await fetchData(range.from, range.to, controller.signal)
        if (controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
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
      } catch (error) {
        if (!isAbortError(error) && activeDataScopeRef.current === requestScope) {
          // Leave the beginning open so a later scroll can retry a transient failure.
        }
      } finally {
        if (loadMoreAbortRef.current === controller) {
          loadMoreAbortRef.current = null
          isLoadingMoreRef.current = false
        }
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler)
      loadMoreAbortRef.current?.abort()
      loadMoreAbortRef.current = null
      isLoadingMoreRef.current = false
    }
  }, [dataScopeKey, interval, fetchData, replaceAllData, restoreVisibleRange])

  // Initial load
  useEffect(() => {
    initialLoadAbortRef.current?.abort()
    const controller = new AbortController()
    const requestScope = dataScopeKey
    initialLoadAbortRef.current = controller

    replaceAllData([])
    reachedBeginningRef.current = false
    setLegend(null)
    setLoadError(null)
    setLoading(true)

    const now = Math.floor(Date.now() / 1000)
    const range = recentCandleRange(interval, now, INITIAL_CANDLES)

    fetchData(range.from, range.to, controller.signal).then(data => {
      if (controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
      const normalized = replaceAllData(data)
      candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true })
      if (normalized.length > 0) {
        // Show only the most recent slice so candles render at a comfortable width.
        showLatestCandles()
        window.requestAnimationFrame(showLatestCandles)
      }
      setLoadError(null)
      setLoading(false)
    }).catch(error => {
      if (isAbortError(error) || controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
      setLoadError('Unable to load candles. Retrying…')
      setLoading(false)
    }).finally(() => {
      if (initialLoadAbortRef.current === controller) {
        initialLoadAbortRef.current = null
      }
    })

    return () => {
      controller.abort()
      if (initialLoadAbortRef.current === controller) {
        initialLoadAbortRef.current = null
      }
    }
  }, [dataScopeKey, interval, fetchData, replaceAllData, showLatestCandles])

  // Live polling
  useEffect(() => {
    const poll = async () => {
      if (initialLoadAbortRef.current != null || livePollAbortRef.current != null) return

      const now = Math.floor(Date.now() / 1000)
      const currentData = allDataRef.current
      const range = currentData.length === 0
        ? recentCandleRange(interval, now, INITIAL_CANDLES)
        : { from: currentData[currentData.length - 1].intervalStart, to: now }
      const controller = new AbortController()
      const requestScope = dataScopeKey
      livePollAbortRef.current = controller

      try {
        const recent = await fetchData(range.from, range.to, controller.signal)
        if (controller.signal.aborted || activeDataScopeRef.current !== requestScope) return
        if (recent.length === 0) {
          if (allDataRef.current.length === 0) setLoadError(null)
          return
        }
        if (!candleSeriesRef.current || !volumeSeriesRef.current) return

        const wasEmpty = allDataRef.current.length === 0
        const ts = chartRef.current?.timeScale()
        const visibleRange = ts?.getVisibleLogicalRange() ?? null
        const trailingBars = trailingBarsForViewport()
        const scrollPosition = ts?.scrollPosition() ?? Infinity
        const wasPinnedToLatest = Math.abs(scrollPosition - trailingBars) <= PINNED_SCROLL_TOLERANCE
        replaceAllData([...allDataRef.current, ...recent])
        setLoadError(null)
        if (wasEmpty) {
          candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true })
          showLatestCandles()
          window.requestAnimationFrame(showLatestCandles)
        } else if (wasPinnedToLatest) {
          ts?.scrollToPosition(trailingBars, false)
        } else if (visibleRange) {
          restoreVisibleRange(visibleRange)
        }
      } catch (error) {
        if (!isAbortError(error) && activeDataScopeRef.current === requestScope && allDataRef.current.length === 0) {
          setLoadError('Unable to load candles. Retrying…')
        }
        // Keep the current chart data if a live poll fails.
      } finally {
        if (livePollAbortRef.current === controller) {
          livePollAbortRef.current = null
        }
      }
    }

    const timer = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      livePollAbortRef.current?.abort()
      livePollAbortRef.current = null
    }
  }, [dataScopeKey, fetchData, interval, replaceAllData, restoreVisibleRange, showLatestCandles])

  // Countdown line on the price axis
  useEffect(() => {
    if (!candleSeriesRef.current) return
    const series = candleSeriesRef.current
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
      const candleEnd = candleEndTimestamp(lastCandle.intervalStart, interval)
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
  const modalCandle = volumeModal?.candle ?? null
  const modalDetails = volumeModal?.details ?? null
  const modalPriceChange = modalCandle ? modalCandle.close - modalCandle.open : 0
  const modalChangePct = modalCandle && modalCandle.open !== 0
    ? (modalPriceChange / modalCandle.open) * 100
    : 0
  const modalTotalVolume = modalDetails
    ? Math.max(1, modalDetails.volumeTotal)
    : 1

  return (
    <>
      <style>{`
        .chart-area { position: relative; background: var(--bg); overflow: hidden; width: 100%; height: 100%; }
        .chart-legend {
          position: absolute; top: 12px; left: 16px; right: 200px; z-index: 4; pointer-events: none;
          display: flex; flex-wrap: wrap; column-gap: 10px; row-gap: 2px;
          font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-medium);
        }
        .chart-loading {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          color: var(--text-low); font-size: 13px; pointer-events: none; z-index: 6;
          opacity: 1; transition: opacity 180ms ease;
        }
        .chart-loading.out { opacity: 0; }
        .omniwatch-marker {
          position: absolute; z-index: 5; transform: translate(-50%, 0);
          display: inline-flex; align-items: center; gap: 4px;
          height: 28px; padding: 0 9px 0 6px; border-radius: 9999px;
          border: 1px solid var(--border); background: var(--bg-elev);
          box-shadow: 0 6px 18px rgba(0,0,0,0.22);
          font-family: 'GeistMono', monospace; font-size: 12px; font-weight: 700; line-height: 1;
          cursor: pointer; color: var(--text-high);
        }
        .omniwatch-marker.net-buy { background: var(--green-soft); border-color: rgba(116, 199, 66, 0.55); }
        .omniwatch-marker.net-sell { background: var(--red-soft); border-color: rgba(255, 104, 104, 0.55); }
        .omniwatch-marker .emoji { font-size: 18px; line-height: 1; }
        .omniwatch-marker .emoji-img {
          width: 20px; height: 20px; object-fit: contain; border-radius: 4px; flex: 0 0 auto;
        }
        .omniwatch-marker .id { color: var(--text-high); margin-left: 1px; }
        .omniwatch-marker .more { margin-left: 2px; color: var(--text-medium); }
        .omniwatch-marker.net-buy .more, .omniwatch-marker.net-buy .id { color: var(--green); }
        .omniwatch-marker.net-sell .more, .omniwatch-marker.net-sell .id { color: var(--red); }
        .omniwatch-scrim {
          position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-start; justify-content: center;
          padding: 8vh 16px 24px; background: rgba(3, 8, 22, 0.78);
          backdrop-filter: blur(8px) saturate(140%); -webkit-backdrop-filter: blur(8px) saturate(140%);
        }
        [data-theme="light"] .omniwatch-scrim { background: rgba(36, 14, 50, 0.34); }
        .omniwatch-modal {
          width: min(860px, calc(100vw - 32px)); max-height: min(820px, calc(100vh - 64px));
          background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px;
          box-shadow: 0 24px 72px rgba(0,0,0,0.42); overflow: hidden;
          display: flex; flex-direction: column;
        }
        .omniwatch-modal-head {
          display: flex; align-items: flex-start; gap: 18px; padding: 22px 28px 18px;
          border-bottom: 1px solid var(--separator);
        }
        .omniwatch-modal-title { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .omniwatch-modal-title .pair {
          font-family: 'Gazpacho', serif; font-weight: 500; font-size: 30px; line-height: 1; color: var(--text-high);
        }
        .omniwatch-modal-title .sub { font-family: 'GeistMono', monospace; font-size: 13px; color: var(--text-medium); }
        .omniwatch-close {
          margin-left: auto; width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center;
          border-radius: 9999px; color: var(--text-medium); font-size: 24px; line-height: 1;
        }
        .omniwatch-close:hover { background: var(--panel-hover); color: var(--text-high); }
        .omniwatch-stats {
          display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--separator);
          border-bottom: 1px solid var(--separator); padding: 0;
        }
        .omniwatch-stat { background: var(--bg-elev); padding: 15px 16px; min-width: 0; }
        .omniwatch-stat:first-child { padding-left: 28px; }
        .omniwatch-stat .k {
          display: block; margin-bottom: 6px; font-family: 'GeistMono', monospace; font-size: 11px;
          text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-low);
        }
        .omniwatch-stat .v {
          display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-family: 'GeistMono', monospace; font-size: 16px; font-weight: 600; color: var(--text-high);
        }
        .omniwatch-stat .v.up { color: var(--green); }
        .omniwatch-stat .v.down { color: var(--red); }
        .omniwatch-summary {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 18px 28px 10px; font-family: 'GeistMono', monospace; font-size: 12px;
          text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-medium);
        }
        .omniwatch-summary .price-change.up { color: var(--green); }
        .omniwatch-summary .price-change.down { color: var(--red); }
        .omniwatch-summary .net.up { color: var(--green); }
        .omniwatch-summary .net.down { color: var(--red); }
        .omniwatch-rows {
          flex: 1; min-height: 0; padding: 0 28px 22px; overflow-y: auto;
          overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
        }
        .omniwatch-row {
          display: grid; grid-template-columns: 240px 1fr 150px; gap: 22px; align-items: center;
          padding: 18px 0; border-bottom: 1px solid var(--separator);
        }
        .omniwatch-row:last-child { border-bottom: 0; }
        .omniwatch-account { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .omniwatch-pill {
          display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px 0 8px;
          border-radius: 6px; border: 1px solid var(--border); background: var(--panel);
          font-family: 'GeistMono', monospace; font-size: 13px; font-weight: 700; color: var(--text-high);
          text-decoration: none;
        }
        .omniwatch-pill:hover { border-color: var(--accent); color: var(--accent); }
        .omniwatch-pill .emoji { font-size: 22px; line-height: 1; }
        .omniwatch-pill .emoji-img {
          width: 24px; height: 24px; object-fit: contain; border-radius: 5px; flex: 0 0 auto;
        }
        .icon-fallback { display: none; }
        .omniwatch-count { font-family: 'GeistMono', monospace; font-size: 13px; color: var(--text-low); }
        .omniwatch-flow { min-width: 0; display: flex; flex-direction: column; gap: 9px; }
        .omniwatch-flow-track { width: 100%; height: 9px; border-radius: 5px; background: var(--panel); overflow: hidden; }
        .omniwatch-flow-bar { display: flex; height: 100%; min-width: 20px; }
        .omniwatch-flow-bar .buy { background: var(--green); }
        .omniwatch-flow-bar .sell { background: var(--red); }
        .omniwatch-flow-nums { display: flex; flex-wrap: wrap; gap: 16px; font-family: 'GeistMono', monospace; font-size: 12px; }
        .omniwatch-flow-nums .buy { color: var(--green); }
        .omniwatch-flow-nums .sell { color: var(--red); }
        .omniwatch-net { display: flex; flex-direction: column; gap: 4px; text-align: right; min-width: 0; }
        .omniwatch-net .value { font-family: 'GeistMono', monospace; font-size: 18px; font-weight: 700; line-height: 1.2; }
        .omniwatch-net .label {
          font-family: 'GeistMono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-low);
        }
        .omniwatch-net.buyer .value { color: var(--green); }
        .omniwatch-net.seller .value { color: var(--red); }
        .omniwatch-more {
          padding: 18px 0 2px; font-family: 'GeistMono', monospace; font-size: 12px;
          text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-low); text-align: center;
        }
        .omniwatch-empty { padding: 32px 28px 36px; color: var(--text-low); font-size: 15px; text-align: center; }
        /* On narrow viewports the price-axis labels crowd the top-right corner.
           Push the legend down so it does not overlap axis labels. */
        @media (max-width: 768px) {
          .chart-legend { left: 12px; right: 12px; top: 48px; }
          .omniwatch-marker {
            height: 24px; min-width: 24px; padding: 0 4px; justify-content: center; gap: 0;
          }
          .omniwatch-marker .emoji { font-size: 16px; }
          .omniwatch-marker .emoji-img { width: 18px; height: 18px; }
          .omniwatch-marker .id, .omniwatch-marker .more { display: none; }
          .omniwatch-scrim {
            align-items: stretch; padding: 8px; padding-bottom: max(8px, env(safe-area-inset-bottom));
          }
          .omniwatch-modal {
            width: 100%; max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px);
          }
          .omniwatch-modal-head { align-items: center; gap: 12px; padding: 16px 16px 14px; }
          .omniwatch-modal-title { gap: 5px; }
          .omniwatch-modal-title .pair { font-size: 24px; }
          .omniwatch-modal-title .sub { font-size: 12px; line-height: 1.3; }
          .omniwatch-close { width: 40px; height: 40px; flex: 0 0 auto; font-size: 24px; }
          .omniwatch-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .omniwatch-stat { padding: 12px; }
          .omniwatch-stat:first-child,
          .omniwatch-stat:nth-child(2n + 1) { padding-left: 16px; }
          .omniwatch-stat .k { margin-bottom: 4px; font-size: 9px; letter-spacing: 0.1em; }
          .omniwatch-stat .v { font-size: 14px; }
          .omniwatch-summary {
            flex-direction: column; align-items: flex-start; gap: 6px;
            padding: 14px 16px 8px; font-size: 11px; line-height: 1.35; letter-spacing: 0.08em;
          }
          .omniwatch-rows { padding: 0 16px 16px; }
          .omniwatch-row {
            grid-template-columns: 78px minmax(120px, 1fr) max-content;
            column-gap: 12px; row-gap: 0; align-items: center; padding: 12px 0;
          }
          .omniwatch-account {
            grid-column: auto; min-width: 0; justify-content: flex-start; align-items: center; gap: 6px; flex-wrap: nowrap;
          }
          .omniwatch-pill {
            flex: 0 0 72px; width: 72px; min-width: 0; max-width: 72px; height: 30px; padding: 0 8px 0 5px;
            gap: 5px; overflow: hidden; font-size: 12px;
          }
          .omniwatch-pill .emoji { font-size: 18px; }
          .omniwatch-pill .emoji-img { width: 20px; height: 20px; }
          .omniwatch-count { display: none; }
          .omniwatch-flow { width: 100%; min-width: 0; gap: 0; }
          .omniwatch-flow-track { height: 10px; }
          .omniwatch-flow-nums { display: none; }
          .omniwatch-net {
            align-self: center; justify-self: end; flex-direction: row; align-items: center; justify-content: flex-end;
            gap: 0; text-align: right; min-width: 72px;
          }
          .omniwatch-net .value { font-size: 14px; }
          .omniwatch-net .label { display: none; }
          .omniwatch-empty { padding: 28px 16px 32px; font-size: 14px; }
        }
        @media (max-width: 420px) {
          .omniwatch-scrim { padding: 0; }
          .omniwatch-modal {
            width: 100%; height: 100vh; height: 100dvh; max-height: 100vh; max-height: 100dvh;
            border-radius: 0; border-left: 0; border-right: 0;
          }
          .omniwatch-row { grid-template-columns: 72px minmax(96px, 1fr) max-content; column-gap: 9px; }
          .omniwatch-pill { flex-basis: 66px; width: 66px; max-width: 66px; padding: 0 6px 0 5px; }
          .omniwatch-net { min-width: 66px; }
          .omniwatch-net .value { font-size: 13px; }
        }
      `}</style>
      <div className="chart-area">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {omniwatchMarkers.map(marker => {
          const summary = marker.candle.omniwatch
          if (!summary) return null
          const more = Math.max(0, summary.accountCount - 1)
          const direction = summary.netVolume >= 0 ? 'net-buy' : 'net-sell'
          return (
            <button
              key={marker.candle.intervalStart}
              type="button"
              className={`omniwatch-marker ${direction}`}
              style={{ left: marker.x, top: marker.y }}
              onClick={() => openVolumeModal(marker.candle)}
              aria-label={`Volume contributors for ${formatCandleDate(marker.candle.intervalStart)}`}
              title={`${summary.topTrader.shortAccount} ${formatSignedUsdVolume(summary.netVolume)}`}
            >
              <OmniwatchIcon trader={summary.topTrader} />
              {marker.showAccount && more === 0 && <span className="id">{summary.topTrader.shortAccount}</span>}
              {more > 0 && <span className="more">+{formatShortCount(more)}</span>}
            </button>
          )
        })}

        {loadingVisible && (
          <div className={'chart-loading' + (!loading ? ' out' : '')}>
            Loading…
          </div>
        )}

        {!loading && data.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-low)', fontSize: 13, pointerEvents: 'none', zIndex: 6, textAlign: 'center',
          }}>
            <div style={{ maxWidth: 320 }}>
              {loadError ?? 'No candles available for this pair and interval yet. Try a different interval or check back later.'}
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

      {volumeModal && modalCandle && (
        <div className="omniwatch-scrim" onClick={(event) => { if (event.target === event.currentTarget) closeVolumeModal() }}>
          <div ref={volumeModalRef} className="omniwatch-modal" role="dialog" aria-modal="true" aria-labelledby={volumeModalTitleId} tabIndex={-1}>
            <div className="omniwatch-modal-head">
              <div className="omniwatch-modal-title">
                <span id={volumeModalTitleId} className="pair">{base}</span>
                <span className="sub">{INTERVAL_LABELS[interval]} candle · {formatCandleDate(modalCandle.intervalStart)}</span>
              </div>
              <button ref={volumeModalCloseRef} type="button" className="omniwatch-close" onClick={closeVolumeModal} aria-label="Close">×</button>
            </div>

            <div className="omniwatch-stats">
              <div className="omniwatch-stat"><span className="k">Open</span><span className="v">{formatPriceFixed(modalCandle.open)}</span></div>
              <div className="omniwatch-stat"><span className="k">High</span><span className="v">{formatPriceFixed(modalCandle.high)}</span></div>
              <div className="omniwatch-stat"><span className="k">Low</span><span className="v">{formatPriceFixed(modalCandle.low)}</span></div>
              <div className="omniwatch-stat"><span className="k">Close</span><span className={`v ${modalCandle.close >= modalCandle.open ? 'up' : 'down'}`}>{formatPriceFixed(modalCandle.close)}</span></div>
              <div className="omniwatch-stat"><span className="k">Change</span><span className={`v ${modalChangePct >= 0 ? 'up' : 'down'}`}>{formatPercent(modalChangePct)}</span></div>
              <div className="omniwatch-stat"><span className="k">Volume</span><span className="v">${formatUsdVolume(modalCandle.volumeTotal)}</span></div>
            </div>

            <div className="omniwatch-summary">
              <span className={`price-change ${modalPriceChange >= 0 ? 'up' : 'down'}`}>
                Price {formatSignedPriceChange(modalPriceChange)} ({formatPercent(modalChangePct)})
              </span>
              {volumeModal.loading && <span>Loading accounts</span>}
              {volumeModal.error && <span>{volumeModal.error}</span>}
              {modalDetails && (
                <>
                  <span>{formatCount(modalDetails.tradeCount)} trades · {formatCount(modalDetails.accountCount)} accounts</span>
                  <span className={`net ${modalDetails.netVolume >= 0 ? 'up' : 'down'}`}>Net {formatSignedUsdVolume(modalDetails.netVolume)}</span>
                </>
              )}
            </div>

            {modalDetails && modalDetails.accounts.length > 0 && (
              <div className="omniwatch-rows" ref={volumeRowsRef} onScroll={handleVolumeRowsScroll}>
                {modalDetails.accounts.map(account => {
                  const denom = account.volumeBuy + account.volumeSell || 1
                  const buyPct = (account.volumeBuy / denom) * 100
                  const sellPct = 100 - buyPct
                  const rowWidth = Math.max(4, (account.volumeTotal / modalTotalVolume) * 100)
                  const isBuyer = account.netVolume >= 0
                  const hasBuy = account.volumeBuy > 0
                  const hasSell = account.volumeSell > 0
                  return (
                    <div className="omniwatch-row" key={account.account}>
                      <div className="omniwatch-account">
                        <a
                          className="omniwatch-pill"
                          href={explorerAccountUrl(account.account)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={account.account}
                        >
                          <OmniwatchIcon trader={account} />{account.shortAccount}
                        </a>
                        <span className="omniwatch-count">×{formatCount(account.tradeCount)}</span>
                      </div>
                      <div className="omniwatch-flow">
                        <div className="omniwatch-flow-track">
                          <div className="omniwatch-flow-bar" style={{ width: `${rowWidth}%` }}>
                            {hasBuy && <span className="buy" style={{ width: hasSell ? `${buyPct}%` : '100%' }} />}
                            {hasSell && <span className="sell" style={{ width: hasBuy ? `${sellPct}%` : '100%' }} />}
                          </div>
                        </div>
                        <div className="omniwatch-flow-nums">
                          {hasBuy && <span className="buy">+${formatUsdVolume(account.volumeBuy)} bought</span>}
                          {hasSell && <span className="sell">-${formatUsdVolume(account.volumeSell)} sold</span>}
                        </div>
                      </div>
                      <div className={`omniwatch-net ${isBuyer ? 'buyer' : 'seller'}`}>
                        <span className="value">{formatSignedUsdVolume(account.netVolume)}</span>
                        <span className="label">{isBuyer ? 'Net buyer' : 'Net seller'}</span>
                      </div>
                    </div>
                  )
                })}
                {volumeModal.loadingMore && (
                  <div className="omniwatch-more">Loading more accounts</div>
                )}
              </div>
            )}

            {modalDetails && modalDetails.accounts.length === 0 && (
              <div className="omniwatch-empty">No account-level volume for this candle.</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
