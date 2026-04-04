import { useEffect, useRef, useState } from 'react'
import Chart from './components/Chart'
import Topbar from './components/Topbar'
import MarketDataModal from './components/MarketDataModal'
import { useAssets } from './hooks/useAssets'
import { useMarketStats } from './hooks/useMarketStats'
import { INTERVALS, INTERVAL_LABELS } from './types'
import type { OHLCVInterval } from './types'
import { parseUrlPair, pairDisplay } from './utils/pairs'
import type { PairResult } from './utils/pairs'
import { exportVisibleCSV } from './utils/export'

const DEFAULT_BASE_ID = 0   // HDX
const DEFAULT_QUOTE_ID = 10  // USDT

export default function App() {
  const [baseId, setBaseId] = useState(DEFAULT_BASE_ID)
  const [quoteId, setQuoteId] = useState(DEFAULT_QUOTE_ID)
  const [interval, setInterval] = useState<OHLCVInterval>('1h')
  const [modalOpen, setModalOpen] = useState(false)
  const [chartData, setChartData] = useState<import('./types').ApiCandle[]>([])

  const assetsQuery = useAssets()
  const assets = assetsQuery.data ?? []
  // Pre-fetch market stats so data is warm before modal opens; data passed to MarketDataModal
  const marketStatsQuery = useMarketStats({ refetchInterval: modalOpen ? 60_000 : false })

  const [toast, setToast] = useState<string | null>(null)
  const isPopStateRef = useRef(false)
  const urlParsedRef = useRef(false)
  const getVisibleRangeRef = useRef<(() => { from: number; to: number } | null) | null>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)

  const baseAsset = assets.find(a => a.assetId === baseId)
  const quoteAsset = assets.find(a => a.assetId === quoteId)

  const display = baseAsset && quoteAsset
    ? pairDisplay(baseAsset, quoteAsset)
    : 'HDXUSD'

  useEffect(() => {
    if (chartData && chartData.length > 0) {
      const price = chartData[chartData.length - 1].close
      const fmt = price >= 1000 ? price.toFixed(2)
        : price >= 1 ? price.toFixed(4)
        : price >= 0.01 ? price.toFixed(6)
        : price.toFixed(8)
      document.title = `${display} ${fmt}`
    } else {
      document.title = display
    }
  }, [display, chartData])

  // Track orientation to force chart remount (lightweight-charts pane layout breaks)
  const [orientationKey, setOrientationKey] = useState(0)
  useEffect(() => {
    const handler = () => setOrientationKey(k => k + 1)
    screen.orientation?.addEventListener('change', handler)
    return () => screen.orientation?.removeEventListener('change', handler)
  }, [])

  // Effect 1: Parse URL on mount (gated on assets loading)
  useEffect(() => {
    if (assets.length === 0) return
    const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
    const parsed = pairSlug ? parseUrlPair(pairSlug) : null
    if (parsed && assets.some(a => a.assetId === parsed.baseId) && assets.some(a => a.assetId === parsed.quoteId)) {
      setBaseId(parsed.baseId)
      setQuoteId(parsed.quoteId)
      setInterval(INTERVALS.includes(intervalSlug as OHLCVInterval) ? (intervalSlug as OHLCVInterval) : '1h')
    } else {
      window.history.replaceState(null, '', `/${DEFAULT_BASE_ID}-${DEFAULT_QUOTE_ID}/1h`)
      setBaseId(DEFAULT_BASE_ID)
      setQuoteId(DEFAULT_QUOTE_ID)
      setInterval('1h')
    }
    urlParsedRef.current = true
  }, [assets.length])

  // Effect 2: Push URL on state change
  useEffect(() => {
    if (!urlParsedRef.current) return
    if (isPopStateRef.current) {
      isPopStateRef.current = false
      return
    }
    const newPath = `/${baseId}-${quoteId}/${interval}`
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath)
    }
  }, [baseId, quoteId, interval])

  // Effect 3: Handle popstate
  useEffect(() => {
    if (assets.length === 0) return
    const handler = () => {
      const [, pairSlug, intervalSlug] = window.location.pathname.split('/')
      const parsed = pairSlug ? parseUrlPair(pairSlug) : null
      isPopStateRef.current = true
      if (parsed) {
        setBaseId(parsed.baseId)
        setQuoteId(parsed.quoteId)
      } else {
        setBaseId(DEFAULT_BASE_ID)
        setQuoteId(DEFAULT_QUOTE_ID)
      }
      setInterval(INTERVALS.includes(intervalSlug as OHLCVInterval) ? (intervalSlug as OHLCVInterval) : '1h')
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [assets])

  // Global keydown: buffer keystrokes and open pair modal
  const keyBuffer = useRef('')
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
        // If modal is open but input not focused, buffer the key
        if (modalOpen) {
          const active = document.activeElement
          if (active?.tagName !== 'INPUT') {
            keyBuffer.current += e.key
          }
          return
        }
        keyBuffer.current = e.key
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

      ctx.fillStyle = '#030816'
      ctx.fillRect(0, 0, w, h)

      // Draw all canvases at their position within the container
      const canvases = container.querySelectorAll('canvas')
      for (const canvas of canvases) {
        const cRect = canvas.getBoundingClientRect()
        const x = Math.round((cRect.left - rect.left) * dpr)
        const y = Math.round((cRect.top - rect.top) * dpr)
        ctx.drawImage(canvas, x, y)
      }

      const displayQ = quoteAsset?.isStablecoin ? 'USD' : quoteSymbol
      const line1 = `${baseSymbol}${displayQ}, ${INTERVAL_LABELS[interval]}`
      const nameParts = [baseAsset?.name ?? baseSymbol, quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.name ?? quoteSymbol)]
      const line2 = nameParts.join(' / ')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(94, 118, 148, 0.22)'
      ctx.font = `bold ${Math.round(28 * dpr)}px sans-serif`
      ctx.fillText(line1, w / 2, h / 2 - 12 * dpr)
      ctx.fillStyle = 'rgba(94, 118, 148, 0.15)'
      ctx.font = `${Math.round(16 * dpr)}px sans-serif`
      ctx.fillText(line2, w / 2, h / 2 + 14 * dpr)

      const blob = await new Promise<Blob | null>(resolve => composite.toBlob(resolve, 'image/png'))
      if (!blob) return

      const utcNow = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z'
      const filename = `hydration_preis_${baseSymbol}${displayQ}_${INTERVAL_LABELS[interval]}_${utcNow}.png`

      // Try clipboard copy, fall back to download
      let copied = false
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
          copied = true
        } catch {}
      }

      if (copied) {
        setToast('Screenshot copied')
      } else {
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
      // Silent fail
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100svh' }}>
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
      />
      <div ref={chartContainerRef} style={{ flex: 1, position: 'relative' }}>
        <Chart
          key={`${baseId}-${quoteId}-${orientationKey}`}
          baseId={baseId}
          quoteId={quoteId}
          interval={interval}
          base={baseSymbol}
          quote={quoteSymbol}
          baseName={baseAsset?.name ?? null}
          quoteName={quoteAsset?.name ?? null}
          isQuoteStablecoin={quoteAsset?.isStablecoin ?? false}
          onVisibleRangeReady={(getter) => { getVisibleRangeRef.current = getter }}
          onDataChange={setChartData}
        />
      </div>
      <MarketDataModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleSelect}
        assets={assets}
        currentBaseId={baseId}
        currentQuoteId={quoteId}
        keyBuffer={keyBuffer}
        marketStats={marketStatsQuery.data}
      />
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1e293b',
          color: '#e2e8f0',
          padding: '8px 16px',
          borderRadius: '6px',
          fontSize: '13px',
          zIndex: 200,
          border: '1px solid #334155',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
