import { useCallback, useEffect, useRef, useState } from 'react'
import Chart from './components/Chart'
import Topbar from './components/Topbar'
import HeroStats from './components/HeroStats'
import AssetPickerDialog from './components/AssetPickerDialog'
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

const DEFAULT_BASE_ID = 0   // HDX
const DEFAULT_QUOTE_ID = 10  // USDT
const EMPTY_ASSETS: Asset[] = []

function parseIntervalSlug(slug: string | undefined): OHLCVInterval {
  return INTERVALS.includes(slug as OHLCVInterval) ? (slug as OHLCVInterval) : '1h'
}

function buildPath(baseId: number, quoteId: number, interval: OHLCVInterval) {
  return `/${baseId}-${quoteId}/${interval}`
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
  const windowWidth = useWindowWidth()
  const isMobile = windowWidth <= 980

  const [baseId, setBaseId] = useState(() => readInitialRoute().baseId)
  const [quoteId, setQuoteId] = useState(() => readInitialRoute().quoteId)
  const [interval, setInterval] = useState<OHLCVInterval>(() => readInitialRoute().interval)
  const [modalOpen, setModalOpen] = useState(false)
  const [chartData, setChartData] = useState<import('./types').ApiCandle[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
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
  const cyclePeriod = () => setPeriod(p => PERIODS[(PERIODS.indexOf(p) + 1) % PERIODS.length])

  const assetsQuery = useAssets()
  const assets = assetsQuery.data ?? EMPTY_ASSETS
  const marketStatsQuery = useMarketStats({ refetchInterval: 60_000 })
  const indexerQuery = useIndexerStatus()
  const favorites = useFavorites()

  const [toast, setToast] = useState<string | null>(null)
  const isPopStateRef = useRef(false)
  const urlParsedRef = useRef(false)
  const getVisibleRangeRef = useRef<(() => { from: number; to: number } | null) | null>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const handleVisibleRangeReady = useCallback((getter: () => { from: number; to: number } | null) => {
    getVisibleRangeRef.current = getter
  }, [])

  const baseAsset = assets.find(a => a.assetId === baseId)
  const quoteAsset = assets.find(a => a.assetId === quoteId)

  const display = baseAsset && quoteAsset ? pairDisplay(baseAsset, quoteAsset) : 'HDXUSD'

  useEffect(() => {
    if (chartData && chartData.length > 0) {
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
    if (parsed && assets.some(a => a.assetId === parsed.baseId) && assets.some(a => a.assetId === parsed.quoteId)) {
      const cleanPath = buildPath(parsed.baseId, parsed.quoteId, nextInterval)
      if (window.location.pathname !== cleanPath) window.history.replaceState(null, '', cleanPath)
    } else {
      const defaultPath = buildPath(DEFAULT_BASE_ID, DEFAULT_QUOTE_ID, '1h')
      if (window.location.pathname !== defaultPath) window.history.replaceState(null, '', defaultPath)
      queueMicrotask(() => {
        setBaseId(DEFAULT_BASE_ID)
        setQuoteId(DEFAULT_QUOTE_ID)
        setInterval('1h')
      })
    }
    urlParsedRef.current = true
  }, [assets])

  useEffect(() => {
    if (!urlParsedRef.current) return
    if (isPopStateRef.current) { isPopStateRef.current = false; return }
    const newPath = buildPath(baseId, quoteId, interval)
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath)
    }
  }, [baseId, quoteId, interval])

  useEffect(() => {
    if (assets.length === 0) return
    const handler = () => {
      const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
      const parsed = pairSlug ? parseUrlPair(pairSlug) : null
      isPopStateRef.current = true
      if (parsed && assets.some(a => a.assetId === parsed.baseId) && assets.some(a => a.assetId === parsed.quoteId)) {
        setBaseId(parsed.baseId)
        setQuoteId(parsed.quoteId)
      } else {
        setBaseId(DEFAULT_BASE_ID)
        setQuoteId(DEFAULT_QUOTE_ID)
      }
      setInterval(parseIntervalSlug(intervalSlug))
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [assets])

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
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.round(rect.width * dpr)
      const h = Math.round(rect.height * dpr)
      const composite = document.createElement('canvas')
      composite.width = w
      composite.height = h
      const ctx = composite.getContext('2d')
      if (!ctx) return

      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#030816'
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)

      const displayQ = quoteAsset?.isStablecoin ? 'USD' : quoteSymbol
      const isLight = document.documentElement.getAttribute('data-theme') === 'light'

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
      const pairLine = `${baseSymbol}${displayQ}, ${INTERVAL_LABELS[interval]}`
      const nameParts = [baseAsset?.name ?? baseSymbol, quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.name ?? quoteSymbol)]
      const subLine = nameParts.join(' / ')
      await drawBrandWatermark(ctx, dpr, isLight, { pairLine, subLine })

      const utcNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
      const filename = `hydration_preis_${baseSymbol}${displayQ}_${INTERVAL_LABELS[interval]}_${utcNow}.png`
      const blobPromise = new Promise<Blob>((resolve, reject) => {
        composite.toBlob((blob) => blob ? resolve(blob) : reject(new Error('render failed')), 'image/png')
      })
      let copied = false
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
          copied = true
        } catch {
          copied = false
        }
      }
      if (copied) setToast('Screenshot copied')
      else {
        const blob = await blobPromise.catch(() => null)
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
        setToast('Screenshot saved')
      }
      setTimeout(() => setToast(null), 2000)
    } catch {
      setToast('Screenshot failed')
      setTimeout(() => setToast(null), 2000)
    }
  }

  return (
    <div className="app">
      <style>{`
        .app {
          height: 100svh;
          display: grid;
          grid-template-rows: 56px 1fr;
          background: var(--bg);
        }
        /* overflow:hidden + min-width:0 at every level keeps the chart canvas
           contained when the window shrinks. Without it the lightweight-charts canvas
           hangs onto its previous width for a frame and visually overlaps the sidebar. */
        .main { display: grid; grid-template-columns: 1fr 320px; overflow: hidden; min-height: 0; min-width: 0; }
        .chart-col { display: grid; grid-template-rows: auto 1fr; min-width: 0; min-height: 0; overflow: hidden; }
        .chart-wrap { position: relative; min-height: 0; min-width: 0; overflow: hidden; }
        .sidebar-host { min-width: 0; overflow: hidden; }
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
        showMobileSidebarButton={isMobile}
        onOpenMobileSidebar={() => setDrawerOpen(true)}
        isFavorite={favorites.isFavorite(baseId, quoteId)}
        onToggleFavorite={() => favorites.toggle(baseId, quoteId)}
      />
      <section className="main">
        <div className="chart-col">
          <HeroStats
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
              theme={theme}
            />
          </div>
        </div>
        {!isMobile && (
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
              onToggleFavorite={favorites.toggle}
            />
          </div>
        )}
      </section>
      {isMobile && drawerOpen && (
        <div className="mobile-drawer-scrim" onClick={() => setDrawerOpen(false)}>
          <style>{`
            .mobile-drawer-scrim { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,0.6); backdrop-filter: blur(2px); display: flex; justify-content: flex-end; }
            .mobile-drawer-panel { width: min(360px, 92vw); height: 100%; background: var(--bg); border-left: 1px solid var(--separator); display: flex; flex-direction: column; overflow: hidden; box-shadow: -12px 0 32px rgba(0,0,0,0.4); }
            .mobile-drawer-close { align-self: flex-end; margin: 8px; width: 36px; height: 36px; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-medium); }
            .mobile-drawer-close:hover { background: var(--panel-hover); color: var(--text-high); }
            .mobile-drawer-actions { display: flex; flex-direction: column; border-top: 1px solid var(--separator); padding: 8px 0; background: var(--bg); }
            .mobile-drawer-actions button { display: flex; align-items: center; gap: 12px; padding: 14px 20px; font-family: 'Geist', sans-serif; font-size: 14px; color: var(--text-high); background: transparent; text-align: left; }
            .mobile-drawer-actions button:hover { background: var(--panel-hover); }
            .mobile-drawer-actions button:disabled { color: var(--text-lowest); cursor: not-allowed; }
            .mobile-drawer-actions svg { width: 16px; height: 16px; color: var(--text-medium); flex-shrink: 0; }
            .mobile-drawer-indexer { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--separator); font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-medium); }
            .mobile-drawer-indexer .lbl { text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-low); }
            .mobile-drawer-indexer .val { margin-left: auto; color: var(--text-high); }
          `}</style>
          <div className="mobile-drawer-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Markets and favorites">
            <button
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
              onToggleFavorite={favorites.toggle}
              hideIndexer
            />
            <div className="mobile-drawer-actions">
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
                onClick={() => { handleScreenshot(); setDrawerOpen(false) }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                Screenshot
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
      <AssetPickerDialog
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleSelect}
        assets={assets}
        currentBaseId={baseId}
        currentQuoteId={quoteId}
        keyBufferRef={keyBuffer}
        marketStats={marketStatsQuery.data}
      />
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elev)', color: 'var(--text-high)',
          padding: '8px 16px', borderRadius: 999, fontSize: 13,
          zIndex: 200, border: '1px solid var(--border)',
          fontFamily: "'GeistMono', monospace",
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
