import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Topbar from './components/Topbar'
import ChartHeader from './components/ChartHeader'
import Sidebar from './components/Sidebar'
import { useAssets } from './hooks/useAssets'
import { useMarketStats } from './hooks/useMarketStats'
import { useIndexerStatus } from './hooks/useIndexerStatus'
import { indexerLiveDot } from './api/indexer'
import { useTheme } from './hooks/useTheme'
import { useMediaQuery } from './hooks/useMediaQuery'
import { useModalShell } from './hooks/useModalShell'
import { useFavorites } from './hooks/useFavorites'
import { INTERVALS, INTERVAL_LABELS, PERIODS } from './types'
import type { Asset, OHLCVInterval, Period } from './types'
import { parseUrlPair, pairDisplay } from './utils/pairs'
import type { PairResult } from './utils/pairs'
import { exportFilename, exportVisibleCSV } from './utils/export'
import { drawBrandWatermark } from './utils/brandWatermark'
import { formatPrice } from './utils/format'
import { usePersistedState } from './hooks/usePersistedState'
import { CameraIcon, CloseIcon, DownloadIcon, MoonIcon, SunIcon, TrendlineIcon } from './components/icons'

const DEFAULT_BASE_ID = 0   // HDX
const DEFAULT_QUOTE_ID = 10  // USDT
const EMPTY_ASSETS: Asset[] = []
const DESKTOP_SIDEBAR_STORAGE_KEY = 'preis-desktop-sidebar-open'
const INSPECTION_QUERY_PARAM = 'inspect'

// Codecs for the persisted preferences. Module-level so their identity is
// stable — `usePersistedState` writes whenever `encode` changes.
const decodePeriod = (raw: string | null): Period =>
  raw != null && (PERIODS as readonly string[]).includes(raw) ? (raw as Period) : '24h'
const encodePeriod = (period: Period) => period
const decodeToolsEnabled = (raw: string | null) => raw !== 'off'
const encodeToolsEnabled = (enabled: boolean) => (enabled ? 'on' : 'off')
const decodeLogScale = (raw: string | null) => raw === 'log'
const encodeLogScale = (logarithmic: boolean) => (logarithmic ? 'log' : 'linear')
const decodeSidebarOpen = (raw: string | null) => raw !== 'false'
const encodeSidebarOpen = (open: boolean) => (open ? 'true' : 'false')

const AssetPickerDialog = lazy(() => import('./components/AssetPickerDialog'))

// `Chart` pulls in lightweight-charts and the whole chart-tools layer, none of
// which the shell needs to paint: the topbar, header and sidebar render from
// /assets and /market-stats, while the chart cannot draw until /candles answers.
// Splitting it keeps that code out of the entry chunk. `.chart-wrap` already has
// its height from CSS, so the Suspense fallback swaps for the canvas in place.
const Chart = lazy(() => import('./components/Chart'))

function parseIntervalSlug(slug: string | undefined): OHLCVInterval {
  return INTERVALS.includes(slug as OHLCVInterval) ? (slug as OHLCVInterval) : '1h'
}

function buildPath(baseId: number, quoteId: number, interval: OHLCVInterval) {
  return `/${baseId}-${quoteId}/${interval}`
}

function buildUrl(baseId: number, quoteId: number, interval: OHLCVInterval, inspectionTime: number | null) {
  const path = buildPath(baseId, quoteId, interval)
  return inspectionTime == null ? path : `${path}?${INSPECTION_QUERY_PARAM}=${inspectionTime}`
}

function currentUrl() {
  return `${window.location.pathname}${window.location.search}`
}

function readInspectionTime(): number | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get(INSPECTION_QUERY_PARAM)
  if (raw == null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function readInitialRoute() {
  if (typeof window === 'undefined') {
    return { baseId: DEFAULT_BASE_ID, quoteId: DEFAULT_QUOTE_ID, interval: '1h' as OHLCVInterval }
  }

  const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
  const parsed = pairSlug ? parseUrlPair(pairSlug) : null
  return {
    baseId: parsed?.baseId ?? DEFAULT_BASE_ID,
    quoteId: parsed?.quoteId ?? DEFAULT_QUOTE_ID,
    interval: parseIntervalSlug(intervalSlug),
  }
}

export default function App() {
  const { theme, toggle: toggleTheme } = useTheme()
  // Same breakpoint the stylesheet uses for the sidebar/drawer swap.
  const isMobile = useMediaQuery('(max-width: 980px)')

  const [baseId, setBaseId] = useState(() => readInitialRoute().baseId)
  const [quoteId, setQuoteId] = useState(() => readInitialRoute().quoteId)
  const [interval, setInterval] = useState<OHLCVInterval>(() => readInitialRoute().interval)
  const [inspectionTime, setInspectionTime] = useState<number | null>(() => readInspectionTime())
  const [modalOpen, setModalOpen] = useState(false)
  const [chartData, setChartData] = useState<import('./types').ApiCandle[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = usePersistedState(
    DESKTOP_SIDEBAR_STORAGE_KEY, decodeSidebarOpen, encodeSidebarOpen)
  const [period, setPeriod] = usePersistedState('preis-period', decodePeriod, encodePeriod)
  const [toolsEnabled, setToolsEnabled] = usePersistedState('preis-tools', decodeToolsEnabled, encodeToolsEnabled)
  // Price-scale mode is one preference for every pair, so switching pairs keeps
  // the chosen scale. Linear stays the default.
  const [logScale, setLogScale] = usePersistedState('preis-scale', decodeLogScale, encodeLogScale)
  const cyclePeriod = () => setPeriod(p => PERIODS[(PERIODS.indexOf(p) + 1) % PERIODS.length])

  const assetsQuery = useAssets()
  const assets = assetsQuery.data ?? EMPTY_ASSETS
  const marketStatsQuery = useMarketStats({ refetchInterval: 60_000 })
  const indexerQuery = useIndexerStatus()
  const favorites = useFavorites()

  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const suppressRoutePushRef = useRef(false)
  const urlParsedRef = useRef(false)
  const getVisibleRangeRef = useRef<(() => { from: number; to: number } | null) | null>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const mobileDrawerRef = useRef<HTMLDivElement>(null)
  const mobileDrawerCloseRef = useRef<HTMLButtonElement>(null)
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 2000)
  }, [])
  const handleVisibleRangeReady = useCallback((getter: () => { from: number; to: number } | null) => {
    getVisibleRangeRef.current = getter
  }, [])

  const baseAsset = assets.find(a => a.assetId === baseId)
  const quoteAsset = assets.find(a => a.assetId === quoteId)

  const display = baseAsset && quoteAsset ? pairDisplay(baseAsset, quoteAsset) : 'HDXUSD'
  const mobileDrawerOpen = isMobile && drawerOpen

  useEffect(() => () => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current)
  }, [])

  // The drawer only exists below the breakpoint; widening past it closes it, so
  // narrowing back does not bring back a drawer the reader left behind. Adjusted
  // during render rather than in an effect: an effect would paint the stale open
  // state for a frame first, and re-entering render to correct it is the cascade
  // React warns about.
  const [wasMobile, setWasMobile] = useState(isMobile)
  if (wasMobile !== isMobile) {
    setWasMobile(isMobile)
    if (!isMobile && drawerOpen) setDrawerOpen(false)
  }

  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  useModalShell(mobileDrawerOpen, mobileDrawerRef, mobileDrawerCloseRef, closeDrawer)

  useEffect(() => {
    document.title = chartData.length > 0
      ? `${display} ${formatPrice(chartData[chartData.length - 1].close, false)}`
      : display
  }, [display, chartData])

  const [orientationKey, setOrientationKey] = useState(0)
  useEffect(() => {
    const handler = () => setOrientationKey(k => k + 1)
    screen.orientation?.addEventListener('change', handler)
    return () => screen.orientation?.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (assets.length === 0 || urlParsedRef.current) return
    const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
    const parsed = pairSlug ? parseUrlPair(pairSlug) : null
    const nextInterval = parseIntervalSlug(intervalSlug)
    const nextInspectionTime = readInspectionTime()
    if (parsed && assets.some(a => a.assetId === parsed.baseId) && assets.some(a => a.assetId === parsed.quoteId)) {
      const cleanUrl = buildUrl(parsed.baseId, parsed.quoteId, nextInterval, nextInspectionTime)
      if (currentUrl() !== cleanUrl) window.history.replaceState(null, '', cleanUrl)
      queueMicrotask(() => setInspectionTime(nextInspectionTime))
    } else {
      const defaultPath = buildPath(DEFAULT_BASE_ID, DEFAULT_QUOTE_ID, '1h')
      if (window.location.pathname !== defaultPath) window.history.replaceState(null, '', defaultPath)
      queueMicrotask(() => {
        setBaseId(DEFAULT_BASE_ID)
        setQuoteId(DEFAULT_QUOTE_ID)
        setInterval('1h')
        setInspectionTime(null)
      })
    }
    urlParsedRef.current = true
  }, [assets])

  useEffect(() => {
    if (!urlParsedRef.current) return
    if (suppressRoutePushRef.current) { suppressRoutePushRef.current = false; return }
    const newUrl = buildUrl(baseId, quoteId, interval, null)
    if (currentUrl() !== newUrl) {
      window.history.pushState(null, '', newUrl)
    }
    queueMicrotask(() => setInspectionTime(current => current == null ? current : null))
  }, [baseId, quoteId, interval])

  useEffect(() => {
    if (assets.length === 0) return
    const handler = () => {
      const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
      const parsed = pairSlug ? parseUrlPair(pairSlug) : null
      const validPair = parsed && assets.some(a => a.assetId === parsed.baseId) && assets.some(a => a.assetId === parsed.quoteId)
      const nextBaseId = validPair ? parsed.baseId : DEFAULT_BASE_ID
      const nextQuoteId = validPair ? parsed.quoteId : DEFAULT_QUOTE_ID
      const nextInterval = parseIntervalSlug(intervalSlug)
      if (nextBaseId !== baseId || nextQuoteId !== quoteId || nextInterval !== interval) {
        suppressRoutePushRef.current = true
      }
      setBaseId(nextBaseId)
      setQuoteId(nextQuoteId)
      setInterval(nextInterval)
      setInspectionTime(readInspectionTime())
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [assets, baseId, interval, quoteId])

  const handleInspectionTimeChange = useCallback((nextInspectionTime: number | null) => {
    setInspectionTime(nextInspectionTime)
    const nextUrl = buildUrl(baseId, quoteId, interval, nextInspectionTime)
    if (currentUrl() === nextUrl) return

    if (nextInspectionTime == null) {
      window.history.replaceState(null, '', nextUrl)
    } else {
      window.history.pushState(null, '', nextUrl)
    }
  }, [baseId, quoteId, interval])

  const keyBuffer = useRef('')
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Another dialog (markets drawer, volume details) owns the keyboard while it
      // is open — opening the picker on top would stack two focus-trapped surfaces
      // and leave the one underneath visible after a selection.
      if (!modalOpen && document.querySelector('[role="dialog"]')) return
      if (e.key === '/' && !modalOpen) {
        e.preventDefault()
        keyBuffer.current = ''
        setModalOpen(true)
        return
      }
      if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
        if (modalOpen) {
          const active = document.activeElement
          if (active?.tagName !== 'INPUT') keyBuffer.current += e.key
          return
        }
        keyBuffer.current += e.key
        setModalOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [modalOpen])

  const handleSelect = (pair: PairResult) => {
    setBaseId(pair.base.assetId)
    setQuoteId(pair.quote.assetId)
  }

  const baseSymbol = baseAsset?.symbol ?? 'HDX'
  const quoteSymbol = quoteAsset?.symbol ?? 'USDT'
  // A USD-pegged quote reads as "USD" everywhere it is displayed, exports
  // included — the CSV and the screenshot of one chart must not disagree.
  const displayQuote = quoteAsset?.isUsdPegged ? 'USD' : quoteSymbol

  const handleScreenshot = async () => {
    const container = chartContainerRef.current
    if (!container) return
    try {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light'
      const pairLine = `${baseSymbol}${displayQuote}, ${INTERVAL_LABELS[interval]}`
      const nameParts = [baseAsset?.name ?? baseSymbol, quoteAsset?.isUsdPegged ? 'USD' : (quoteAsset?.name ?? quoteSymbol)]
      const subLine = nameParts.join(' / ')
      const filename = exportFilename(baseSymbol, displayQuote, INTERVAL_LABELS[interval], 'png')

      const blobPromise = (async () => {
        const rect = container.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const w = Math.round(rect.width * dpr)
        const h = Math.round(rect.height * dpr)
        const composite = document.createElement('canvas')
        composite.width = w
        composite.height = h
        const ctx = composite.getContext('2d')
        if (!ctx) throw new Error('render failed')

        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#030816'
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, w, h)

        // Composite the chart series first (background area is already filled).
        const canvases = container.querySelectorAll('canvas')
        for (const canvas of canvases) {
          const cRect = canvas.getBoundingClientRect()
          const x = Math.round((cRect.left - rect.left) * dpr)
          const y = Math.round((cRect.top - rect.top) * dpr)
          ctx.drawImage(canvas, x, y)
        }

        // Brand + pair watermark in the TOP-LEFT corner. Brand on the first row,
        // pair + interval beneath it, asset names in a smaller line below.
        await drawBrandWatermark(ctx, dpr, isLight, { pairLine, subLine })

        return new Promise<Blob>((resolve, reject) => {
          composite.toBlob((blob) => blob ? resolve(blob) : reject(new Error('render failed')), 'image/png')
        })
      })()

      let copied = false
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
          copied = true
        } catch {
          copied = false
        }
      }
      if (copied) showToast('Screenshot copied')
      else {
        const blob = await blobPromise.catch(() => null)
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        showToast('Screenshot saved')
      }
    } catch {
      showToast('Screenshot failed')
    }
  }

  return (
    <div className="app">
      <style>{`
        .app {
          /* Fill the full screen off the html>body>#root 100% chain rather than
             a viewport unit: iOS home-screen (standalone) PWAs under-report
             svh/dvh (they exclude the top+bottom safe areas), which left the shell
             ~93px short on a notched iPhone and a ~10% dead strip below the chart.
             100% resolves to the true edge-to-edge viewport. */
          height: 100%;
          display: grid;
          grid-template-rows: 56px 1fr;
          background: var(--bg);
          /* Offset the whole app below the status bar. The padding strip shows the
             app's own --bg (== the topbar's), so the bar reads as a seamless
             extension. 0 on Android/desktop. */
          padding-top: var(--safe-top);
        }
        /* overflow:hidden + min-width:0 at every level keeps the chart canvas
           contained when the window shrinks. Without it the lightweight-charts canvas
           hangs onto its previous width for a frame and visually overlaps the sidebar. */
        .main { display: grid; grid-template-columns: 1fr 320px; overflow: hidden; min-height: 0; min-width: 0; transition: grid-template-columns 180ms var(--ease-standard); }
        .main.sidebar-collapsed { grid-template-columns: 1fr; }
        .chart-col { display: grid; grid-template-rows: auto 1fr; min-width: 0; min-height: 0; overflow: hidden; }
        .chart-wrap { position: relative; min-height: 0; min-width: 0; overflow: hidden; }
        /* Stand-in while the chart chunk arrives. It is absolutely positioned
           inside .chart-wrap, whose height comes from .chart-col's 1fr row and
           so is already settled by CSS before any chart code runs — the swap to
           the real canvas therefore moves nothing. Wording and dimming match
           Chart's own .chart-loading overlay so the two read as one state. */
        .chart-boot {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          color: var(--text-low); font-size: 13px; pointer-events: none;
        }
        .sidebar-host { min-width: 0; overflow: hidden; animation: preis-list-row-in 180ms var(--ease-out-soft); }
        /* Visible on its own, with the animation only easing it in and out —
           its own 2s timer is what removes it. The global reduced-motion rule
           clamps every animation to 1ms, which on an animation-only toast would
           snap it straight to its final (opacity: 0) frame and the message
           would never be seen; reduced motion drops the animation instead, so
           the toast simply appears and disappears without moving. */
        .toast {
          position: fixed; bottom: 24px; left: 50%;
          transform: translateX(-50%);
          background: var(--bg-elev); color: var(--text-high);
          padding: 8px 16px; border-radius: 999px; font-size: 13px;
          z-index: 200; border: 1px solid var(--border);
          font-family: 'GeistMono', monospace;
          box-shadow: 0 12px 32px rgba(0,0,0,0.28);
          opacity: 1;
          animation: preis-toast-life 2000ms var(--ease-out-soft) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .toast { animation: none; }
        }
        @media (max-width: 980px) {
          .main { grid-template-columns: 1fr; }
          .sidebar-host { display: none; }
        }
      `}</style>
      <Topbar
        pairDisplay={display}
        baseAsset={baseAsset}
        quoteAsset={quoteAsset}
        interval={interval}
        onIntervalChange={setInterval}
        onPairClick={() => { keyBuffer.current = ''; setModalOpen(true) }}
        onExport={() => {
          if (chartData.length === 0) return
          const range = getVisibleRangeRef.current?.()
          exportVisibleCSV(chartData, baseSymbol, displayQuote, INTERVAL_LABELS[interval], range?.from ?? null, range?.to ?? null)
        }}
        canExport={chartData.length > 0}
        onScreenshot={handleScreenshot}
        theme={theme}
        onThemeToggle={toggleTheme}
        showDesktopSidebarButton={!isMobile}
        desktopSidebarOpen={desktopSidebarOpen}
        onToggleDesktopSidebar={() => setDesktopSidebarOpen(open => !open)}
        showMobileSidebarButton={isMobile}
        onOpenMobileSidebar={() => setDrawerOpen(true)}
        isFavorite={favorites.isFavorite(baseId, quoteId)}
        onToggleFavorite={() => favorites.toggle(baseId, quoteId)}
      />
      <section className={'main' + (!isMobile && !desktopSidebarOpen ? ' sidebar-collapsed' : '')}>
        <div className="chart-col">
          <ChartHeader
            baseAsset={baseAsset}
            quoteAsset={quoteAsset}
            candles={chartData}
            interval={interval}
            marketStats={marketStatsQuery.data}
            period={period}
            onCyclePeriod={cyclePeriod}
            isFavorite={favorites.isFavorite(baseId, quoteId)}
            onToggleFavorite={() => favorites.toggle(baseId, quoteId)}
          />
          <div ref={chartContainerRef} className="chart-wrap">
            <Suspense fallback={<div className="chart-boot">Loading…</div>}>
              <Chart
                key={`${baseId}-${quoteId}-${orientationKey}`}
                baseId={baseId}
                quoteId={quoteId}
                interval={interval}
                base={baseSymbol}
                baseDecimals={baseAsset?.decimals ?? null}
                showVolumeSource={quoteAsset ? !quoteAsset.isUsdPegged : false}
                onVisibleRangeReady={handleVisibleRangeReady}
                onDataChange={setChartData}
                inspectionTime={inspectionTime}
                onInspectionTimeChange={handleInspectionTimeChange}
                theme={theme}
                toolsEnabled={toolsEnabled}
                logScale={logScale}
                onLogScaleChange={setLogScale}
              />
            </Suspense>
          </div>
        </div>
        {!isMobile && desktopSidebarOpen && (
          <div className="sidebar-host" style={{ minHeight: 0 }}>
            <Sidebar
              assets={assets}
              marketStats={marketStatsQuery.data}
              currentBaseId={baseId}
              currentQuoteId={quoteId}
              onSelect={(b, q) => { setBaseId(b); setQuoteId(q) }}
              blockHeight={indexerQuery.data?.blockHeight ?? null}
              indexerLive={indexerLiveDot(indexerQuery.data)}
              period={period}
              onCyclePeriod={cyclePeriod}
              favorites={favorites.favorites}
            />
          </div>
        )}
      </section>
      {mobileDrawerOpen && (
        <div className="mobile-drawer-scrim" onClick={() => setDrawerOpen(false)}>
          <style>{`
            .mobile-drawer-scrim { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,0.6); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; animation: preis-drawer-scrim-in 160ms ease-out; }
            .mobile-drawer-panel { width: min(360px, 92vw); height: 100%; background: var(--bg); border-left: 1px solid var(--separator); display: flex; flex-direction: column; overflow: hidden; box-shadow: -12px 0 32px rgba(0,0,0,0.4); animation: preis-drawer-panel-in 190ms var(--ease-out-soft); padding-top: var(--safe-top); }
            .mobile-drawer-close { align-self: flex-end; margin: 8px; width: 36px; height: 36px; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-medium); transition: color 140ms, background 140ms, transform 140ms var(--ease-out-soft); }
            .mobile-drawer-close:hover { background: var(--panel-hover); color: var(--text-high); }
            .mobile-drawer-close:active { transform: scale(0.94); }
            .mobile-drawer-actions { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--separator); padding: 8px 12px; gap: 2px; background: var(--bg); }
            .mobile-drawer-actions button { display: flex; align-items: center; gap: 10px; padding: 14px 12px; border-radius: 8px; font-family: 'Geist', sans-serif; font-size: 14px; color: var(--text-high); background: transparent; text-align: left; white-space: nowrap; transition: background 140ms, transform 140ms var(--ease-out-soft); }
            .mobile-drawer-actions button:hover { background: var(--panel-hover); transform: translateX(2px); }
            .mobile-drawer-actions button:active { transform: translateX(1px) scale(0.995); }
            .mobile-drawer-actions button:disabled { color: var(--text-lowest); cursor: not-allowed; }
            .mobile-drawer-actions svg { width: 16px; height: 16px; color: var(--text-medium); flex-shrink: 0; }
            .mobile-drawer-indexer { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--separator); font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-medium); }
            .mobile-drawer-indexer .lbl { text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-low); }
            .mobile-drawer-indexer .val { margin-left: auto; color: var(--text-high); }
          `}</style>
          <div ref={mobileDrawerRef} className="mobile-drawer-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Markets and favorites" tabIndex={-1}>
            <button
              ref={mobileDrawerCloseRef}
              type="button"
              className="mobile-drawer-close"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close markets drawer"
            >
              <CloseIcon />
            </button>
            <Sidebar
              assets={assets}
              marketStats={marketStatsQuery.data}
              currentBaseId={baseId}
              currentQuoteId={quoteId}
              onSelect={(b, q) => { setBaseId(b); setQuoteId(q); setDrawerOpen(false) }}
              blockHeight={indexerQuery.data?.blockHeight ?? null}
              indexerLive={indexerLiveDot(indexerQuery.data)}
              period={period}
              onCyclePeriod={cyclePeriod}
              favorites={favorites.favorites}
              hideIndexer
            />
            <div className="mobile-drawer-actions">
              <button
                type="button"
                onClick={() => { handleScreenshot(); setDrawerOpen(false) }}
              >
                <CameraIcon />
                Screenshot
              </button>
              <button
                type="button"
                disabled={chartData.length === 0}
                onClick={() => {
                  if (chartData.length === 0) return
                  const range = getVisibleRangeRef.current?.()
                  exportVisibleCSV(chartData, baseSymbol, displayQuote, INTERVAL_LABELS[interval], range?.from ?? null, range?.to ?? null)
                  setDrawerOpen(false)
                }}
              >
                <DownloadIcon />
                Download CSV
              </button>
              <button
                type="button"
                aria-pressed={toolsEnabled}
                onClick={() => { setToolsEnabled(enabled => !enabled); setDrawerOpen(false) }}
              >
                <TrendlineIcon />
                {toolsEnabled ? 'Hide toolbar' : 'Show toolbar'}
              </button>
              <button
                type="button"
                onClick={() => { toggleTheme(); setDrawerOpen(false) }}
              >
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                {theme === 'dark' ? 'Lights on' : 'Lights off'}
              </button>
            </div>
            <div className="mobile-drawer-indexer">
              <span className="live-dot" style={{
                background: indexerLiveDot(indexerQuery.data) ? 'var(--green)' : 'var(--amber)',
              }} />
              <span className="lbl">Indexer</span>
              <span className="val">
                #{indexerQuery.data?.blockHeight != null ? indexerQuery.data.blockHeight.toLocaleString() : '—'}
              </span>
            </div>
          </div>
        </div>
      )}
      <Suspense fallback={null}>
        {modalOpen && <AssetPickerDialog
          isOpen
          onClose={() => setModalOpen(false)}
          onSelect={handleSelect}
          assets={assets}
          currentBaseId={baseId}
          currentQuoteId={quoteId}
          keyBufferRef={keyBuffer}
          marketStats={marketStatsQuery.data}
        />}
      </Suspense>
      {toast && (
        <div key={toast} className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  )
}
