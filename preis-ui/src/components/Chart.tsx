import { memo, useEffect, useId, useRef, useState, useCallback, useSyncExternalStore, type SyntheticEvent, type UIEvent } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  PriceScaleMode,
} from 'lightweight-charts'
import type {
  UTCTimestamp,
  Time,
  MouseEventParams,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
} from 'lightweight-charts'
import { INTERVAL_LABELS } from '../types'
import type { ApiCandle, OHLCVInterval, OmniwatchTrader, OmniwatchVolumeDetails } from '../types'
import { fetchCandles, fetchVolumeDetails } from '../api/candles'
import {
  compactAmount,
  compactCount,
  formatChange,
  formatCount,
  formatCountdown,
  formatPrice,
  formatSignedPrice,
  formatSignedUsd,
  formatUsd,
  tokenAmountFromRaw,
} from '../utils/format'
import { withAlpha } from '../utils/color'
import { candleEndTimestamp, previousCandleRange, recentCandleRange } from '../utils/candleTime'
import { headStreamHealthy, subscribeHead } from '../live'
import { useModalShell } from '../hooks/useModalShell'
import { ToolController } from '../chart-tools/ToolController'
import type { ToolState } from '../chart-tools/ToolController'
import ChartToolbar from './ChartToolbar'
import ScaleControl from './ScaleControl'

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
  // Decimals of the base asset, used to scale the raw-unit trade amounts the
  // omniwatch payload carries. Token amounts stay hidden until it is known.
  baseDecimals?: number | null
  showVolumeSource?: boolean
  onVisibleRangeReady?: (getter: () => { from: number; to: number } | null) => void
  onDataChange?: (data: ApiCandle[]) => void
  inspectionTime?: number | null
  onInspectionTimeChange?: (time: number | null) => void
  theme: 'dark' | 'light'
  toolsEnabled?: boolean
  logScale?: boolean
  onLogScaleChange?: (logarithmic: boolean) => void
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

// One frozen empty list for every path that produces no markers: a fresh `[]`
// per call never compares equal, so `Object.is` could not bail out of the state
// update and the whole chart shell re-rendered on each pan frame.
const NO_MARKERS: OmniwatchMarker[] = []

function sameMarkers(a: OmniwatchMarker[], b: OmniwatchMarker[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const prev = a[i]
    const next = b[i]
    if (
      prev.candle !== next.candle || prev.x !== next.x ||
      prev.y !== next.y || prev.showAccount !== next.showAccount
    ) return false
  }
  return true
}

interface VolumeModalState {
  candle: ApiCandle
  details: OmniwatchVolumeDetails | null
  loading: boolean
  loadingMore: boolean
  error: string | null
}

interface LegendStore {
  subscribe: (listener: () => void) => () => void
  get: () => Legend | null
  set: (value: Legend | null) => void
}

/**
 * The crosshair reports a new O/H/L/C/V on every pointer sample. Holding those
 * five numbers in Chart's own state would re-render the whole chart shell — the
 * marker list, the modal subtree and the style block — once per mouse move, so
 * they live in this store and only the legend row subscribes to it.
 */
function createLegendStore(): LegendStore {
  let value: Legend | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
  }
}

/** O/H/L/C/V for the hovered candle, falling back to the newest one. */
const ChartLegend = memo(function ChartLegend({ store, tail, base, showVolumeSource, upColor }: {
  store: LegendStore
  tail: ApiCandle | null
  base: string
  showVolumeSource: boolean
  upColor: string
}) {
  const hovered = useSyncExternalStore(store.subscribe, store.get, store.get)
  const legend: Legend | null = hovered ?? (tail
    ? { open: tail.open, high: tail.high, low: tail.low, close: tail.close, volume: tail.volumeTotal }
    : null)
  if (!legend) return null
  return (
    <div className="chart-legend">
      <span><span className="k">O</span>{formatPrice(legend.open, false)}</span>
      <span><span className="k">H</span>{formatPrice(legend.high, false)}</span>
      <span><span className="k">L</span>{formatPrice(legend.low, false)}</span>
      <span style={{ color: legend.close >= legend.open ? upColor : 'var(--red)' }}>
        <span className="k">C</span>{formatPrice(legend.close, false)}
      </span>
      <span><span className="k">V</span>{formatUsd(legend.volume)}{showVolumeSource ? ` (${base})` : ''}</span>
    </div>
  )
})

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

// The price axis and the crosshair label are drawn by the chart library, which
// wants a decimal count and a tick size rather than a formatted string. They are
// the one place a real precision is needed instead of the rough display scale —
// a tick ladder has to stay aligned with the prices it labels — so the tier is
// chosen from the history's median close.
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

interface ChartPalette {
  bg: string
  textHigh: string
  textMedium: string
  textLow: string
  separator: string
  green: string
  red: string
  accent: string
  light: boolean
}

// Lightweight Charts draws on a canvas and cannot resolve a CSS variable, so the
// chart's colors are read out of the design tokens once per theme and handed
// over as concrete values — `global.css` stays the only place they are defined.
// `useTheme` writes `data-theme` before React re-renders, so the tokens on the
// document element are always the ones for the theme being painted.
let paletteCache: { theme: string; palette: ChartPalette } | null = null

function readPalette(): ChartPalette {
  const theme = document.documentElement.getAttribute('data-theme') ?? 'dark'
  if (paletteCache?.theme === theme) return paletteCache.palette
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  const palette: ChartPalette = {
    bg: read('--bg', '#030816'),
    textHigh: read('--text-high', '#f5f1f8'),
    textMedium: read('--text-medium', '#a59cab'),
    textLow: read('--text-low', '#6e6776'),
    separator: read('--separator', 'rgba(255, 255, 255, 0.05)'),
    green: read('--green', '#74C742'),
    red: read('--red', '#ff6868'),
    accent: read('--accent', '#e53e76'),
    light: theme === 'light',
  }
  paletteCache = { theme, palette }
  return palette
}

/** Volume bars are the candle colors at 0.32 alpha, matching the design tokens. */
function volumeBarColors(): { up: string; down: string } {
  const palette = readPalette()
  return { up: withAlpha(palette.green, 0.32), down: withAlpha(palette.red, 0.32) }
}

export default function Chart({
  baseId, quoteId, interval, base, baseDecimals = null, showVolumeSource = false,
  onVisibleRangeReady, onDataChange,
  inspectionTime = null, onInspectionTimeChange, theme, toolsEnabled = true,
  logScale = false, onLogScaleChange,
}: ChartProps) {
  const dataScopeKey = `${baseId}:${quoteId}:${interval}`
  const containerRef = useRef<HTMLDivElement>(null)
  const chartAreaRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const volumePaneTopRef = useRef(0)
  const markerFrameRef = useRef<number | null>(null)
  const writtenAxisMetricsRef = useRef({ priceAxisWidth: -1, timeAxisHeight: -1 })
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

  // Drawing tools (trendline, channel, measure). The controller lives for the
  // chart instance; the pair key is mirrored into a ref so the chart-creation
  // effect does not need baseId/quoteId deps (App remounts this per pair).
  const toolsRef = useRef<ToolController | null>(null)
  const pairKeyRef = useRef(`${baseId}-${quoteId}`)
  useEffect(() => { pairKeyRef.current = `${baseId}-${quoteId}` }, [baseId, quoteId])
  const [toolState, setToolState] = useState<ToolState>({ tool: 'cursor', hasSelection: false })
  // Hiding the toolbar (menu toggle) must never strand a drawing tool.
  useEffect(() => {
    if (!toolsEnabled) toolsRef.current?.setTool('cursor')
  }, [toolsEnabled])

  const legendStoreRef = useRef<LegendStore | null>(null)
  if (!legendStoreRef.current) legendStoreRef.current = createLegendStore()
  const legendStore = legendStoreRef.current

  // The rendered tail of the loaded candles. `allDataRef` is mutated outside
  // React, so the legend fallback and the empty state have to read a value that
  // re-renders when the data changes rather than the ref itself.
  const [tail, setTail] = useState<ApiCandle | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingVisible, setLoadingVisible] = useState(true)
  const [omniwatchMarkers, setOmniwatchMarkers] = useState<OmniwatchMarker[]>([])
  const [volumeModal, setVolumeModal] = useState<VolumeModalState | null>(null)
  const volumeModalTitleId = useId()
  const isVolumeModalOpen = volumeModal != null
  const currentVolumeModalTime = volumeModal?.candle.intervalStart ?? null

  // App remounts this component per pair, so the chart-creation effect reads
  // the scale from a ref to seed the new price scale; later toggles are applied
  // to the live scale by the effect below. Only the candle series' scale
  // switches — the volume histogram shares no scale with it and stays linear.
  const logScaleRef = useRef(logScale)
  useEffect(() => { logScaleRef.current = logScale }, [logScale])
  useEffect(() => {
    candleSeriesRef.current?.priceScale().applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    })
  }, [logScale])

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

  // Both axes are canvas-drawn inside the chart, so only the chart can measure
  // them; mirror the two measurements DOM overlays need into CSS variables.
  // Width: the price axis follows its label text (an 8-decimal price needs far
  // more room than "$1,961"), and the legend reserves it as a right gutter so it
  // never runs underneath the labels. Height: below 980px, where the sidebar and
  // its indexer footer are gone, the scale switch takes the time-axis row
  // instead of the app's bottom strip.
  const syncAxisMetrics = useCallback(() => {
    const chart = chartRef.current
    const area = chartAreaRef.current
    if (!chart || !area) return
    // Both properties feed layout-affecting rules, so re-writing an unchanged
    // value is a wasted style invalidation — and most frames change neither.
    const written = writtenAxisMetricsRef.current
    const priceAxisWidth = Math.round(chart.priceScale('right').width())
    if (priceAxisWidth !== written.priceAxisWidth) {
      written.priceAxisWidth = priceAxisWidth
      area.style.setProperty('--price-axis-w', `${priceAxisWidth}px`)
    }
    // Reads 0 until the chart lays out. Publishing that zero would beat the CSS
    // fallback rather than defer to it, and a 0px-tall switch is invisible.
    const timeAxisHeight = Math.round(chart.timeScale().height())
    if (timeAxisHeight > 0 && timeAxisHeight !== written.timeAxisHeight) {
      written.timeAxisHeight = timeAxisHeight
      area.style.setProperty('--time-axis-h', `${timeAxisHeight}px`)
    }
  }, [])

  const updateOmniwatchMarkers = useCallback(() => {
    const chart = chartRef.current
    const container = containerRef.current
    if (!chart || !container) {
      setOmniwatchMarkers(NO_MARKERS)
      return
    }

    const data = allDataRef.current
    if (data.length === 0) {
      setOmniwatchMarkers(NO_MARKERS)
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
      setOmniwatchMarkers(NO_MARKERS)
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
    if (next.length === 0) {
      setOmniwatchMarkers(NO_MARKERS)
      return
    }
    // Panning moves the markers, but zooming past a threshold or crossing a
    // candle without omniwatch data reproduces the same list — keep the old
    // array so the shell does not re-render for an identical result.
    setOmniwatchMarkers(current => (sameMarkers(current, next) ? current : next))
  }, [])

  // Both overlays the chart drives from outside the canvas — the marker list and
  // the two axis measurements — land in one frame. Writing the axis custom
  // properties straight from the range handler put a layout-affecting style
  // write on every pan frame, which `handleResize` then read back the next one.
  const scheduleOverlaySync = useCallback(() => {
    if (markerFrameRef.current != null) {
      window.cancelAnimationFrame(markerFrameRef.current)
    }
    markerFrameRef.current = window.requestAnimationFrame(() => {
      markerFrameRef.current = null
      updateOmniwatchMarkers()
      syncAxisMetrics()
    })
  }, [syncAxisMetrics, updateOmniwatchMarkers])

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

  useModalShell(isVolumeModalOpen, volumeModalRef, volumeModalCloseRef, closeVolumeModal)

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
    setTail(data.length > 0 ? data[data.length - 1] : null)
    if (!candleSeries || !volumeSeries) {
      onDataChange?.(data)
      return
    }

    const volColors = volumeBarColors()
    const candleData: CandlestickData[] = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    const volumeData: HistogramData[] = data.map(c => ({
      time: c.intervalStart as UTCTimestamp,
      value: c.volumeTotal,
      color: c.close >= c.open ? volColors.up : volColors.down,
    }))

    candleSeries.applyOptions({ priceFormat: getPriceFormat(data) })
    candleSeries.setData(candleData)
    volumeSeries.setData(volumeData)
    onDataChange?.(data)
    scheduleOverlaySync()
  }, [onDataChange, scheduleOverlaySync])

  const replaceAllData = useCallback((data: ApiCandle[]) => {
    const normalized = normalizeCandles(data)
    allDataRef.current = normalized
    oldestTimestampRef.current = normalized[0]?.intervalStart ?? Infinity
    applyData(normalized)
    return normalized
  }, [applyData])

  /**
   * Merge a live poll that only touches the tail: the newest candle re-closing
   * plus any that opened since. Both series take a point `update()` instead of
   * a full `setData()`, so a refresh — one per pushed head, or per
   * POLL_INTERVAL_MS while the stream is down — costs the changed bars rather
   * than a re-sort and a reset of the entire loaded history.
   *
   * Returns false — and the caller falls back to a full replace — whenever the
   * poll reaches below the newest known candle, which is the only case where
   * rows other than the tail can change.
   */
  const applyLiveTail = useCallback((recent: ApiCandle[]): boolean => {
    const candleSeries = candleSeriesRef.current
    const volumeSeries = volumeSeriesRef.current
    const all = allDataRef.current
    if (!candleSeries || !volumeSeries || all.length === 0) return false

    const normalized = normalizeCandles(recent)
    if (normalized.length === 0) return false
    const lastKnown = all[all.length - 1].intervalStart
    if (normalized[0].intervalStart < lastKnown) return false

    const volColors = volumeBarColors()
    const next = all.slice()
    for (const candle of normalized) {
      if (candle.intervalStart === lastKnown) next[next.length - 1] = candle
      else next.push(candle)
      candleSeries.update({
        time: candle.intervalStart as UTCTimestamp,
        open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      })
      volumeSeries.update({
        time: candle.intervalStart as UTCTimestamp,
        value: candle.volumeTotal,
        color: candle.close >= candle.open ? volColors.up : volColors.down,
      })
    }

    // The axis precision follows the median close of the whole history, which
    // a handful of tail bars cannot move.
    allDataRef.current = next
    setTail(next[next.length - 1])
    onDataChange?.(next)
    scheduleOverlaySync()
    return true
  }, [onDataChange, scheduleOverlaySync])

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
    const palette = readPalette()
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
    candleSeries.priceScale().applyOptions({
      mode: logScaleRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    })

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: txtLow,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: formatUsd },
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

    toolsRef.current = new ToolController({
      chart,
      series: candleSeries,
      pairKey: pairKeyRef.current,
      onStateChange: setToolState,
    })

    if (onVisibleRangeReady) {
      onVisibleRangeReady(() => {
        const range = chartRef.current?.timeScale().getVisibleLogicalRange()
        if (!range) return null
        return { from: range.from, to: range.to }
      })
    }

    const crosshairHandler = (param: MouseEventParams) => {
      if (!param.time) { legendStore.set(null); return }
      const candle = param.seriesData.get(candleSeries) as CandlestickData | undefined
      const volume = param.seriesData.get(volumeSeries) as HistogramData | undefined
      if (candle) {
        legendStore.set({ open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: volume?.value ?? 0 })
      }
    }
    chart.subscribeCrosshairMove(crosshairHandler)

    const clickHandler = (param: MouseEventParams) => {
      if (toolsRef.current?.isCapturing()) return
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

    // Panning/zooming moves the markers and re-autoscales the price axis, which
    // can change how wide its labels are.
    const markerRangeHandler = () => scheduleOverlaySync()
    chart.timeScale().subscribeVisibleLogicalRangeChange(markerRangeHandler)

    const handleResize = () => {
      if (!containerRef.current) return
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight })
      const volumePaneHeight = Math.floor(containerRef.current.clientHeight * 0.15)
      volumePaneTopRef.current = containerRef.current.clientHeight - volumePaneHeight
      chart.panes()[1].setHeight(volumePaneHeight)
      scheduleOverlaySync()
    }
    // The container resizes with the window, so the observer already covers
    // every case a window listener would — a second one only doubles the work.
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)
    const settleTimer = setTimeout(handleResize, 300)

    return () => {
      resizeObserver.disconnect()
      clearTimeout(settleTimer)
      chart.unsubscribeCrosshairMove(crosshairHandler)
      chart.unsubscribeClick(clickHandler)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(markerRangeHandler)
      if (markerFrameRef.current != null) {
        window.cancelAnimationFrame(markerFrameRef.current)
        markerFrameRef.current = null
      }
      if (onVisibleRangeReady) onVisibleRangeReady(() => null)
      toolsRef.current?.dispose()
      toolsRef.current = null
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      chart.remove()
    }
  }, [legendStore, onVisibleRangeReady, scheduleOverlaySync]) // create once; theme changes are handled by applyOptions below

  // Theme changes: re-apply colors on the existing chart instance so the
  // canvas isn't torn down and re-mounted — a remount blanks the chart for a
  // beat and occasionally for good.
  useEffect(() => {
    const chart = chartRef.current
    const candle = candleSeriesRef.current
    if (!chart || !candle) return
    const palette = readPalette()
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
    legendStore.set(null)
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
  }, [dataScopeKey, interval, fetchData, legendStore, replaceAllData, showLatestCandles])

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
        if (!applyLiveTail(recent)) replaceAllData([...allDataRef.current, ...recent])
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

    // A pushed head means new candles may exist RIGHT NOW; the interval keeps
    // running as the fallback but skips its tick while the stream is healthy —
    // with a live stream, requests happen only when a block actually lands.
    const unsubscribeHead = subscribeHead(() => { void poll() })
    const timer = window.setInterval(() => { if (!headStreamHealthy()) void poll() }, POLL_INTERVAL_MS)
    return () => {
      unsubscribeHead()
      window.clearInterval(timer)
      livePollAbortRef.current?.abort()
      livePollAbortRef.current = null
    }
  }, [applyLiveTail, dataScopeKey, fetchData, interval, replaceAllData, restoreVisibleRange, showLatestCandles])

  // Countdown line on the price axis
  useEffect(() => {
    if (!candleSeriesRef.current) return
    const series = candleSeriesRef.current
    const initial = readPalette()
    const line = series.createPriceLine({
      price: 0,
      color: 'transparent',
      lineWidth: 1,
      lineStyle: 2,
      lineVisible: false,
      axisLabelVisible: true,
      title: '',
      axisLabelColor: initial.textLow,
      axisLabelTextColor: initial.textHigh,
    })

    const tick = () => {
      const data = allDataRef.current
      if (data.length === 0) {
        line.applyOptions({ axisLabelVisible: false })
        return
      }
      const lastCandle = data[data.length - 1]
      const candleEnd = candleEndTimestamp(lastCandle.intervalStart, interval)
      const remaining = Math.max(0, candleEnd - Math.floor(Date.now() / 1000))
      const pal = readPalette()
      line.applyOptions({
        price: lastCandle.close,
        axisLabelVisible: true,
        axisLabelColor: pal.textLow,
        axisLabelTextColor: pal.textHigh,
        title: formatCountdown(remaining),
      })
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
    }
  }, [interval, baseId, quoteId])

  // The legend's up-tick color has to be a concrete value (it sits in an inline
  // style beside a `var(--red)`), and `readPalette` memoizes per theme, so this
  // is a map lookup on every render but the first of each theme.
  const upColor = readPalette().green
  const modalCandle = volumeModal?.candle ?? null
  const modalDetails = volumeModal?.details ?? null
  const modalPriceChange = modalCandle ? modalCandle.close - modalCandle.open : 0
  const modalChange = modalCandle && modalCandle.open !== 0
    ? modalPriceChange / modalCandle.open
    : 0
  const modalTotalVolume = modalDetails
    ? Math.max(1, modalDetails.volumeTotal)
    : 1

  // Raw-unit trade amounts become token figures only once the base asset's
  // decimals are known — an unscaled amount would be wrong by orders of magnitude.
  const tokenLabel = useCallback((raw: string, signed = false): string | null => {
    if (typeof baseDecimals !== 'number') return null
    const amount = tokenAmountFromRaw(raw, baseDecimals)
    const sign = signed && amount >= 0 ? '+' : ''
    return `${sign}${compactAmount(amount)} ${base}`
  }, [base, baseDecimals])
  const modalNetToken = modalDetails ? tokenLabel(modalDetails.nativeNetVolume, true) : null
  const modalVolumeToken = modalDetails ? tokenLabel(modalDetails.nativeVolumeTotal) : null

  return (
    <>
      <style>{`
        .chart-area { position: relative; background: var(--bg); overflow: hidden; width: 100%; height: 100%; }
        .chart-legend {
          position: absolute; top: 12px; left: 16px; right: 200px; z-index: 4; pointer-events: none;
          display: flex; flex-wrap: wrap; column-gap: 10px; row-gap: 2px;
          font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-medium);
        }
        .chart-legend > span { white-space: nowrap; }
        /* ---- Price-scale switch --------------------------------------------
           Docked flush into the chart's bottom-right corner: the corner cell
           below the price axis, which the chart leaves empty, so no tick label
           is covered. One rounded corner; the other two edges are the chart's
           own. Its height matches the sidebar's indexer footer, its neighbour
           along the bottom edge, so the two top edges line up across the seam —
           below 980px that neighbour is gone and it takes the time-axis row
           instead (see the media query below). */
        .sc-segmented {
          position: absolute; bottom: 0; right: 0; z-index: 6;
          filter: drop-shadow(-4px -4px 10px rgba(0, 0, 0, 0.20));
        }
        .sc-segmented button {
          --sc-cell-w: 34px;
          position: relative;
          display: grid; grid-template-columns: repeat(2, var(--sc-cell-w));
          height: var(--status-strip-h);
          background: var(--bg-elev);
          border: 1px solid var(--border); border-right: 0; border-bottom: 0;
          border-radius: 8px 0 0 0;
          /* Clips the sliding highlight into the rounded corner, so the
             highlight needs no radius of its own at either stop. */
          overflow: hidden;
          /* The chart area clips its children, so the default outward focus
             ring would be cut off on the flush edges. */
          outline-offset: -2px;
          transition: border-color 160ms;
        }
        /* Same moving highlight as the interval picker: one indicator that
           travels, rather than two backgrounds crossfading. */
        .sc-indicator {
          position: absolute; top: 0; bottom: 0; left: 0; width: var(--sc-cell-w);
          background: var(--accent);
          transform: translateX(calc(var(--active-index) * var(--sc-cell-w)));
          transition: transform 180ms var(--ease-out-soft), background 160ms;
          pointer-events: none;
        }
        .sc-cell {
          position: relative; z-index: 1;
          display: inline-flex; align-items: center; justify-content: center;
          font-family: 'GeistMono', monospace; font-size: 9.5px; font-weight: 500;
          letter-spacing: 0.08em;
          color: var(--text-medium);
          transition: color 180ms;
        }
        .sc-cell.on { color: var(--accent-on); }
        /* Hover brightens the idle label only. The frame stays neutral: the
           travelling highlight already reports the state, and an accent border
           on top of it read as a stuck focus ring. */
        .sc-segmented button:hover .sc-cell:not(.on) { color: var(--text-high); }
        /* No transform on press — it would lift the switch off the edges it is
           fitted to. */
        .sc-segmented button:active { filter: brightness(0.94); }

        /* No sidebar below 980px, so there is no indexer footer to line up with.
           The switch drops to the height of the time-axis row — the strip
           carrying the month and hour labels — and sits within it exactly. */
        @media (max-width: 980px) {
          .sc-segmented button { height: var(--time-axis-h, 28px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .sc-indicator { transition-duration: 0ms; }
        }
        /* The O/H/L/C/V keys sit right against their value, dimmed so the row
           scans as numbers first. */
        .chart-legend .k { color: var(--text-low); }
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
        .omniwatch-marker.net-buy { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 55%, transparent); }
        .omniwatch-marker.net-sell { background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 55%, transparent); }
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
        .omniwatch-stat .sub {
          display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-family: 'GeistMono', monospace; font-size: 12px; color: var(--text-low);
        }
        .omniwatch-summary {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 18px 28px 10px; font-family: 'GeistMono', monospace; font-size: 12px;
          text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-medium);
        }
        .omniwatch-summary .price-change.up { color: var(--green); }
        .omniwatch-summary .price-change.down { color: var(--red); }
        .omniwatch-summary .net.up { color: var(--green); }
        .omniwatch-summary .net.down { color: var(--red); }
        .omniwatch-summary .net .token { color: var(--text-medium); }
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
        .omniwatch-flow-nums .token { margin-left: 6px; color: var(--text-low); }
        .omniwatch-net { display: flex; flex-direction: column; gap: 4px; text-align: right; min-width: 0; }
        .omniwatch-net .value { font-family: 'GeistMono', monospace; font-size: 18px; font-weight: 700; line-height: 1.2; }
        .omniwatch-net .token {
          font-family: 'GeistMono', monospace; font-size: 12px; line-height: 1.2; color: var(--text-medium);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
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
        @media (max-width: 768px) {
          /* Narrow viewports have no room to clear the price-axis labels
             sideways, so reserve exactly the measured axis width as a gutter and
             keep the legend at the top of the chart. */
          .chart-legend { left: 12px; right: calc(var(--price-axis-w, 88px) + 8px); top: 10px; }
          .omniwatch-marker {
            height: 24px; min-width: 24px; padding: 0 4px; justify-content: center; gap: 0;
          }
          .omniwatch-marker .emoji { font-size: 16px; }
          .omniwatch-marker .emoji-img { width: 18px; height: 18px; }
          .omniwatch-marker .id, .omniwatch-marker .more { display: none; }
          .omniwatch-scrim {
            /* Float the card inside the safe area: clear the status bar / Dynamic
               Island up top and the home indicator at the bottom. */
            align-items: flex-start; padding: 8px;
            padding-top: max(8px, env(safe-area-inset-top));
            padding-bottom: max(8px, env(safe-area-inset-bottom));
          }
          .omniwatch-modal {
            /* Cap at the padded (safe) scrim height. 100% resolves against the
               fixed full-screen scrim — avoids iOS standalone's under-reported dvh,
               which capped the card short and left a dead strip below it. */
            width: 100%; max-height: 100%;
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
            align-self: center; justify-self: end; align-items: flex-end; justify-content: center;
            gap: 2px; text-align: right; min-width: 72px;
          }
          .omniwatch-net .value { font-size: 14px; }
          .omniwatch-net .token { font-size: 11px; }
          .omniwatch-net .label { display: none; }
          .omniwatch-empty { padding: 28px 16px 32px; font-size: 14px; }
        }
        @media (max-width: 420px) {
          .omniwatch-scrim { padding: 0; }
          .omniwatch-modal {
            /* Full-bleed sheet: 100% of the fixed full-screen scrim (not dvh, which
               iOS standalone under-reports), with its own top safe-area padding so
               the header clears the status bar. */
            width: 100%; height: 100%; max-height: 100%;
            border-radius: 0; border-left: 0; border-right: 0;
            padding-top: env(safe-area-inset-top);
          }
          .omniwatch-rows { padding-bottom: max(16px, env(safe-area-inset-bottom)); }
          .omniwatch-row { grid-template-columns: 72px minmax(96px, 1fr) max-content; column-gap: 9px; }
          .omniwatch-pill { flex-basis: 66px; width: 66px; max-width: 66px; padding: 0 6px 0 5px; }
          .omniwatch-net { min-width: 66px; }
          .omniwatch-net .value { font-size: 13px; }
          .omniwatch-net .token { font-size: 10px; }
        }
      `}</style>
      <div ref={chartAreaRef} className="chart-area">
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {toolsEnabled && (
          <ChartToolbar
            tool={toolState.tool}
            onTool={t => toolsRef.current?.setTool(t)}
            hasSelection={toolState.hasSelection}
            onDelete={() => toolsRef.current?.deleteSelection()}
          />
        )}

        {onLogScaleChange && (
          <ScaleControl logarithmic={logScale} onToggle={() => onLogScaleChange(!logScale)} />
        )}

        {omniwatchMarkers.map(marker => {
          const summary = marker.candle.omniwatch
          if (!summary) return null
          const more = Math.max(0, summary.accountCount - 1)
          const direction = summary.netVolume >= 0 ? 'net-buy' : 'net-sell'
          const netToken = tokenLabel(summary.nativeNetVolume, true)
          return (
            <button
              key={marker.candle.intervalStart}
              type="button"
              className={`omniwatch-marker ${direction}`}
              style={{ left: marker.x, top: marker.y }}
              onClick={() => openVolumeModal(marker.candle)}
              aria-label={`Volume contributors for ${formatCandleDate(marker.candle.intervalStart)}`}
              title={`${summary.topTrader.shortAccount} ${formatSignedUsd(summary.netVolume)}${netToken ? ` · ${netToken}` : ''}`}
            >
              <OmniwatchIcon trader={summary.topTrader} />
              {marker.showAccount && more === 0 && <span className="id">{summary.topTrader.shortAccount}</span>}
              {more > 0 && <span className="more">+{compactCount(more)}</span>}
            </button>
          )
        })}

        {loadingVisible && (
          <div className={'chart-loading' + (!loading ? ' out' : '')}>
            Loading…
          </div>
        )}

        {!loading && !tail && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-low)', fontSize: 13, pointerEvents: 'none', zIndex: 6, textAlign: 'center',
          }}>
            <div style={{ maxWidth: 320 }}>
              {loadError ?? 'No candles available for this pair and interval yet. Try a different interval or check back later.'}
            </div>
          </div>
        )}

        <ChartLegend
          store={legendStore}
          tail={tail}
          base={base}
          showVolumeSource={showVolumeSource}
          upColor={upColor}
        />
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
              <div className="omniwatch-stat"><span className="k">Open</span><span className="v">{formatPrice(modalCandle.open, false)}</span></div>
              <div className="omniwatch-stat"><span className="k">High</span><span className="v">{formatPrice(modalCandle.high, false)}</span></div>
              <div className="omniwatch-stat"><span className="k">Low</span><span className="v">{formatPrice(modalCandle.low, false)}</span></div>
              <div className="omniwatch-stat"><span className="k">Close</span><span className={`v ${modalCandle.close >= modalCandle.open ? 'up' : 'down'}`}>{formatPrice(modalCandle.close, false)}</span></div>
              <div className="omniwatch-stat"><span className="k">Change</span><span className={`v ${modalChange >= 0 ? 'up' : 'down'}`}>{formatChange(modalChange)}</span></div>
              <div className="omniwatch-stat">
                <span className="k">Volume</span>
                <span className="v">{formatUsd(modalCandle.volumeTotal)}</span>
                {modalVolumeToken && <span className="sub">{modalVolumeToken}</span>}
              </div>
            </div>

            <div className="omniwatch-summary">
              <span className={`price-change ${modalPriceChange >= 0 ? 'up' : 'down'}`}>
                Price {formatSignedPrice(modalPriceChange)} ({formatChange(modalChange)})
              </span>
              {volumeModal.loading && <span>Loading accounts</span>}
              {volumeModal.error && <span>{volumeModal.error}</span>}
              {modalDetails && (
                <>
                  <span>{formatCount(modalDetails.tradeCount)} trades · {formatCount(modalDetails.accountCount)} accounts</span>
                  <span className={`net ${modalDetails.netVolume >= 0 ? 'up' : 'down'}`}>
                    Net {formatSignedUsd(modalDetails.netVolume)}
                    {modalNetToken && <span className="token"> · {modalNetToken}</span>}
                  </span>
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
                  const buyToken = tokenLabel(account.nativeVolumeBuy)
                  const sellToken = tokenLabel(account.nativeVolumeSell)
                  const netToken = tokenLabel(account.nativeNetVolume, true)
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
                          {hasBuy && (
                            <span className="buy">
                              +{formatUsd(account.volumeBuy)} bought
                              {buyToken && <span className="token">{buyToken}</span>}
                            </span>
                          )}
                          {hasSell && (
                            <span className="sell">
                              -{formatUsd(account.volumeSell)} sold
                              {sellToken && <span className="token">{sellToken}</span>}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className={`omniwatch-net ${isBuyer ? 'buyer' : 'seller'}`}>
                        <span className="value">{formatSignedUsd(account.netVolume)}</span>
                        {netToken && <span className="token">{netToken}</span>}
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
