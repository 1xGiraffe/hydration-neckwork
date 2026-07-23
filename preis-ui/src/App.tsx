import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Chart from './components/Chart'
import Topbar from './components/Topbar'
import ChartHeader from './components/ChartHeader'
import Sidebar from './components/Sidebar'
import { useAssets } from './hooks/useAssets'
import { useMarketStats } from './hooks/useMarketStats'
import { useIndexerStatus } from './hooks/useIndexerStatus'
import { useTheme } from './hooks/useTheme'
import { useWindowWidth } from './hooks/useWindowWidth'
import { useFavorites } from './hooks/useFavorites'
import { INTERVALS, INTERVAL_LABELS, PERIODS } from './types'
import type { Asset, OHLCVInterval, Period } from './types'
import { parseUrlPair, pairDisplay } from './utils/pairs'
import type { PairResult } from './utils/pairs'
import { exportVisibleCSV } from './utils/export'
import { drawBrandWatermark } from './utils/brandWatermark'
import { keepTabFocusInside } from './utils/focus'

const DEFAULT_BASE_ID = 0   // HDX
const DEFAULT_QUOTE_ID = 10  // USDT
const EMPTY_ASSETS: Asset[] = []
const DESKTOP_SIDEBAR_STORAGE_KEY = 'preis-desktop-sidebar-open'
const INSPECTION_QUERY_PARAM = 'inspect'

const AssetPickerDialog = lazy(() => import('./components/AssetPickerDialog'))

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

function readInitialDesktopSidebarOpen() {
  if (typeof window === 'undefined') return true
  try {
    return localStorage.getItem(DESKTOP_SIDEBAR_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

export default function App() {
  const { theme, toggle: toggleTheme } = useTheme()
  const windowWidth = useWindowWidth()
  const isMobile = windowWidth <= 980

  const [baseId, setBaseId] = useState(() => readInitialRoute().baseId)
  const [quoteId, setQuoteId] = useState(() => readInitialRoute().quoteId)
  const [interval, setInterval] = useState<OHLCVInterval>(() => readInitialRoute().interval)
  const [inspectionTime, setInspectionTime] = useState<number | null>(() => readInspectionTime())
  const [modalOpen, setModalOpen] = useState(false)
  const [chartData, setChartData] = useState<import('./types').ApiCandle[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(readInitialDesktopSidebarOpen)
  const [period, setPeriod] = useState<Period>(() => {
    try {
      const saved = localStorage.getItem('preis-period')
      if (saved && (PERIODS as readonly string[]).includes(saved)) return saved as Period
    } catch {
      // localStorage can be unavailable in private or hardened contexts.
    }
    return '24h'
  })
  useEffect(() => {
    try {
      localStorage.setItem('preis-period', period)
    } catch {
      // Ignore persistence failures; the in-memory selection still works.
    }
  }, [period])
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('preis-tools') !== 'off'
    } catch {
      // localStorage can be unavailable in private or hardened contexts.
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('preis-tools', toolsEnabled ? 'on' : 'off')
    } catch {
      // Ignore persistence failures; the in-memory preference still works.
    }
  }, [toolsEnabled])
  useEffect(() => {
    try {
      localStorage.setItem(DESKTOP_SIDEBAR_STORAGE_KEY, desktopSidebarOpen ? 'true' : 'false')
    } catch {
      // Ignore persistence failures; the in-memory sidebar state still works.
    }
  }, [desktopSidebarOpen])
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

  useEffect(() => {
    const closeOnDesktopResize = () => {
      if (window.innerWidth > 980) setDrawerOpen(false)
    }
    window.addEventListener('resize', closeOnDesktopResize)
    return () => window.removeEventListener('resize', closeOnDesktopResize)
  }, [])

  useEffect(() => {
    if (!mobileDrawerOpen) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const focusFrame = window.requestAnimationFrame(() => mobileDrawerCloseRef.current?.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawerOpen(false)
        return
      }
      keepTabFocusInside(event, mobileDrawerRef.current)
    }
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [mobileDrawerOpen])

  useEffect(() => {
    if (chartData.length > 0) {
      const price = chartData[chartData.length - 1].close
      const opts: Intl.NumberFormatOptions =
        price >= 1000 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
          : price >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
          : price >= 0.01 ? { minimumFractionDigits: 4, maximumFractionDigits: 6 }
          : { minimumFractionDigits: 6, maximumFractionDigits: 8 }
      const fmt = price.toLocaleString('en-US', opts)
      document.title = `${display} ${fmt}`
    } else {
      document.title = display
    }
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

  const handleScreenshot = async () => {
    const container = chartContainerRef.current
    if (!container) return
    try {
      const displayQ = quoteAsset?.isStablecoin ? 'USD' : quoteSymbol
      const isLight = document.documentElement.getAttribute('data-theme') === 'light'
      const pairLine = `${baseSymbol}${displayQ}, ${INTERVAL_LABELS[interval]}`
      const nameParts = [baseAsset?.name ?? baseSymbol, quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.name ?? quoteSymbol)]
      const subLine = nameParts.join(' / ')
      const utcNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
      const filename = `hydration_neckwork_${baseSymbol}${displayQ}_${INTERVAL_LABELS[interval]}_${utcNow}.png`

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
        .sidebar-host { min-width: 0; overflow: hidden; animation: preis-list-row-in 180ms var(--ease-out-soft); }
        .toast {
          position: fixed; bottom: 24px; left: 50%;
          background: var(--bg-elev); color: var(--text-high);
          padding: 8px 16px; border-radius: 999px; font-size: 13px;
          z-index: 200; border: 1px solid var(--border);
          font-family: 'GeistMono', monospace;
          box-shadow: 0 12px 32px rgba(0,0,0,0.28);
          animation: preis-toast-life 2000ms var(--ease-out-soft) both;
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
          exportVisibleCSV(chartData, baseSymbol, quoteSymbol, INTERVAL_LABELS[interval], range?.from ?? null, range?.to ?? null)
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
            marketStats={marketStatsQuery.data}
            period={period}
            onCyclePeriod={cyclePeriod}
            isFavorite={favorites.isFavorite(baseId, quoteId)}
            onToggleFavorite={() => favorites.toggle(baseId, quoteId)}
          />
          <div ref={chartContainerRef} className="chart-wrap">
            <Chart
              key={`${baseId}-${quoteId}-${orientationKey}`}
              baseId={baseId}
              quoteId={quoteId}
              interval={interval}
              base={baseSymbol}
              showVolumeSource={quoteAsset ? !quoteAsset.isStablecoin : false}
              onVisibleRangeReady={handleVisibleRangeReady}
              onDataChange={setChartData}
              inspectionTime={inspectionTime}
              onInspectionTimeChange={handleInspectionTimeChange}
              theme={theme}
              toolsEnabled={toolsEnabled}
            />
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
              indexerLive={(indexerQuery.data?.blocksBehindHead ?? 9999) <= 2}
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
            </button>
            <Sidebar
              assets={assets}
              marketStats={marketStatsQuery.data}
              currentBaseId={baseId}
              currentQuoteId={quoteId}
              onSelect={(b, q) => { setBaseId(b); setQuoteId(q); setDrawerOpen(false) }}
              blockHeight={indexerQuery.data?.blockHeight ?? null}
              indexerLive={(indexerQuery.data?.blocksBehindHead ?? 9999) <= 2}
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
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Screenshot
              </button>
              <button
                type="button"
                disabled={chartData.length === 0}
                onClick={() => {
                  if (chartData.length === 0) return
                  const range = getVisibleRangeRef.current?.()
                  exportVisibleCSV(chartData, baseSymbol, quoteSymbol, INTERVAL_LABELS[interval], range?.from ?? null, range?.to ?? null)
                  setDrawerOpen(false)
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download CSV
              </button>
              <button
                type="button"
                aria-pressed={toolsEnabled}
                onClick={() => { setToolsEnabled(enabled => !enabled); setDrawerOpen(false) }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><line x1="7.5" y1="16.5" x2="16.5" y2="7.5"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="5.5" r="2"/></svg>
                {toolsEnabled ? 'Hide toolbar' : 'Show toolbar'}
              </button>
              <button
                type="button"
                onClick={() => { toggleTheme(); setDrawerOpen(false) }}
              >
                {theme === 'dark'
                  ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
                  : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
                {theme === 'dark' ? 'Lights on' : 'Lights off'}
              </button>
            </div>
            <div className="mobile-drawer-indexer">
              <span className="live-dot" style={{
                background: (indexerQuery.data?.blocksBehindHead ?? 9999) <= 2 ? 'var(--green)' : 'var(--amber)',
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
