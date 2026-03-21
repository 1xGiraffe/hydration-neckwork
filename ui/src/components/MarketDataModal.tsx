import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Asset, AssetMarketStats } from '../types'
import { getDefaultPairs, searchPairs } from '../utils/pairs'
import type { PairResult } from '../utils/pairs'
import { useWindowWidth } from '../hooks/useWindowWidth'
import MarketTable from './MarketTable'
import type { MarketRow } from './MarketTable'

interface MarketDataModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (pair: PairResult) => void
  assets: Asset[]
  currentBaseId: number
  currentQuoteId: number
  initialChar?: string
  marketStats: AssetMarketStats[] | undefined
}

function buildRows(
  results: PairResult[],
  marketStats: AssetMarketStats[] | undefined,
  currentBaseId: number,
  currentQuoteId: number
): MarketRow[] {
  const statsMap = new Map<number, AssetMarketStats>()
  if (marketStats) {
    for (const s of marketStats) {
      statsMap.set(s.assetId, s)
    }
  }

  return results.map(result => {
    const isUsdPair = result.quote.isStablecoin
    let price: number | null = null
    let change1h: number | null = null
    let change24h: number | null = null
    let change7d: number | null = null
    let sparkline: number[] = []

    if (isUsdPair) {
      const baseStats = statsMap.get(result.base.assetId)
      if (baseStats) {
        price = baseStats.price
        change1h = baseStats.change1h
        change24h = baseStats.change24h
        change7d = baseStats.change7d
        sparkline = baseStats.sparkline
      }
    } else {
      // Cross-pair: derive stats client-side
      const baseStats = statsMap.get(result.base.assetId)
      const quoteStats = statsMap.get(result.quote.assetId)

      if (baseStats?.price != null && quoteStats?.price != null && quoteStats.price !== 0) {
        price = baseStats.price / quoteStats.price
      }

      // Derive cross-pair sparkline element-wise
      if (baseStats && quoteStats && baseStats.sparkline.length > 0 && quoteStats.sparkline.length > 0) {
        const len = Math.min(baseStats.sparkline.length, quoteStats.sparkline.length)
        const crossPoints: number[] = []
        for (let i = 0; i < len; i++) {
          const quoteVal = quoteStats.sparkline[i]
          if (quoteVal !== 0) {
            crossPoints.push(baseStats.sparkline[i] / quoteVal)
          }
        }
        sparkline = crossPoints

        if (sparkline.length >= 2) {
          const first = sparkline[0]
          const last = sparkline[sparkline.length - 1]
          // Return as ratio (matching API format) — formatChange handles conversion
          change7d = first !== 0 ? (last / first) - 1 : null

          if (sparkline.length >= 24) {
            const ref24 = sparkline[sparkline.length - 24]
            change24h = ref24 !== 0 ? (last / ref24) - 1 : null
          }

          if (sparkline.length >= 2) {
            const ref1h = sparkline[sparkline.length - 2]
            change1h = ref1h !== 0 ? (last / ref1h) - 1 : null
          }
        }
      }
    }

    return {
      assetId: result.base.assetId,
      symbol: result.base.symbol,
      name: result.base.name,
      parachainId: result.base.parachainId,
      price,
      change1h,
      change24h,
      change7d,
      sparkline,
      isCurrent: result.base.assetId === currentBaseId && result.quote.assetId === currentQuoteId,
      pairResult: result,
      display: isUsdPair ? result.base.symbol : result.display,
      nameHint: result.nameHint,
    }
  })
}

export default function MarketDataModal({
  isOpen,
  onClose,
  onSelect,
  assets,
  currentBaseId,
  currentQuoteId,
  initialChar,
  marketStats,
}: MarketDataModalProps) {
  const isMobile = useWindowWidth() <= 768
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Seed query and focus on open
  useEffect(() => {
    if (isOpen) {
      setQuery(initialChar ?? '')
      setActiveIndex(-1)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen, initialChar])

  // Memoize results to prevent unnecessary re-renders of table rows
  const results = useMemo(
    () => query.trim() === '' ? getDefaultPairs(assets) : searchPairs(query, assets),
    [query, assets]
  )

  // Auto-select exact match or single result
  useEffect(() => {
    if (results.length === 1) {
      setActiveIndex(0)
      return
    }
    const q = query.trim().toUpperCase()
    if (q) {
      const exactIdx = results.findIndex(r => r.base.symbol.toUpperCase() === q)
      setActiveIndex(exactIdx >= 0 ? exactIdx : -1)
    } else {
      setActiveIndex(-1)
    }
  }, [results, query])

  // Scroll active row into view
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[role="option"]')
    items[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const rows = useMemo(
    () => buildRows(results, marketStats, currentBaseId, currentQuoteId),
    [results, marketStats, currentBaseId, currentQuoteId]
  )

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min(prev + 1, rows.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max(prev - 1, -1))
      return
    }
    if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < rows.length) {
      e.preventDefault()
      onSelect(rows[activeIndex].pairResult)
      onClose()
      return
    }
  }, [rows, activeIndex, onClose, onSelect])

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'rgba(3, 8, 22, 0.85)', zIndex: 100 }} />
        <Dialog.Content
          aria-label="Select asset"
          style={isMobile ? {
            position: 'fixed',
            inset: 0,
            zIndex: 101,
            display: 'flex',
            flexDirection: 'column',
            background: '#030816',
            outline: 'none',
          } : {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '90vw',
            maxWidth: '680px',
            height: '80vh',
            maxHeight: '700px',
            zIndex: 101,
            display: 'flex',
            flexDirection: 'column',
            background: '#030816',
            outline: 'none',
            borderRadius: '12px',
            border: '1px solid #1e293b',
            overflow: 'hidden',
          }}
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Search header */}
          <div style={{
            padding: '16px',
            background: '#030816',
          }}>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search assets and pairs..."
              aria-label="Search assets"
              style={{
                width: '100%',
                fontSize: '14px',
                background: '#1e293b',
                color: '#e2e8f0',
                border: `1px solid ${query ? '#576B80' : '#334155'}`,
                borderRadius: '6px',
                padding: '12px 16px',
                outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.border = '1px solid #576B80' }}
              onBlur={e => { e.currentTarget.style.border = query ? '1px solid #576B80' : '1px solid #334155' }}
            />
          </div>

          {/* Table area or empty state */}
          {rows.length === 0 && query.trim() !== '' ? (
            <div style={{ padding: '24px 16px', color: '#576B80', fontSize: '13px' }}>
              <div>No assets found</div>
              <div style={{ marginTop: '8px' }}>
                No assets match &ldquo;{query}&rdquo;. Try a different symbol, e.g. DOT, HDX, ETH
              </div>
            </div>
          ) : (
            <MarketTable
              rows={rows}
              activeIndex={activeIndex}
              onRowClick={(row) => { onSelect(row.pairResult); onClose() }}
              onRowMouseEnter={setActiveIndex}
              listRef={listRef}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
