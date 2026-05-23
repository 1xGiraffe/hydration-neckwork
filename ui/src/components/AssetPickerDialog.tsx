import { useState, useEffect, useRef, useCallback, useMemo, type MutableRefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { Asset, AssetMarketStats } from '../types'
import { getDefaultPairs, searchPairs, displayLabel } from '../utils/pairs'
import type { PairResult } from '../utils/pairs'
import { useWindowWidth } from '../hooks/useWindowWidth'
import PairIcons from './PairIcons'
import Sparkline from './Sparkline'
import { formatPrice, formatChange } from '../utils/format'

interface AssetPickerDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (pair: PairResult) => void
  assets: Asset[]
  currentBaseId: number
  currentQuoteId: number
  keyBufferRef: MutableRefObject<string>
  marketStats: AssetMarketStats[] | undefined
}

interface ResolvedRow {
  pairResult: PairResult
  isCurrent: boolean
  price: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  sparkline: number[]
}

function buildRows(
  pairs: PairResult[],
  statsById: Map<number, AssetMarketStats>,
  currentBaseId: number,
  currentQuoteId: number
): ResolvedRow[] {
  return pairs.map(p => {
    const isUsd = p.quote.isStablecoin
    let price: number | null = null
    let change1h: number | null = null
    let change24h: number | null = null
    let change7d: number | null = null
    let sparkline: number[] = []

    if (isUsd) {
      const s = statsById.get(p.base.assetId)
      if (s) {
        price = s.price
        change1h = s.change1h
        change24h = s.change24h
        change7d = s.change7d
        sparkline = s.sparkline
      }
    } else {
      const bs = statsById.get(p.base.assetId)
      const qs = statsById.get(p.quote.assetId)
      if (bs?.price != null && qs?.price != null && qs.price !== 0) {
        price = bs.price / qs.price
      }
      if (bs && qs && bs.sparkline.length > 0 && qs.sparkline.length > 0) {
        const len = Math.min(bs.sparkline.length, qs.sparkline.length)
        const cross: number[] = []
        for (let i = 0; i < len; i++) {
          const q = qs.sparkline[i]
          if (q !== 0) cross.push(bs.sparkline[i] / q)
        }
        sparkline = cross
        if (sparkline.length >= 2) {
          const first = sparkline[0]
          const last = sparkline[sparkline.length - 1]
          change7d = first !== 0 ? last / first - 1 : null
          if (sparkline.length >= 24) {
            const ref24 = sparkline[sparkline.length - 24]
            change24h = ref24 !== 0 ? last / ref24 - 1 : null
          }
          const ref1h = sparkline[sparkline.length - 2]
          change1h = ref1h !== 0 ? last / ref1h - 1 : null
        }
      }
    }

    return {
      pairResult: p,
      isCurrent: p.base.assetId === currentBaseId && p.quote.assetId === currentQuoteId,
      price,
      change1h,
      change24h,
      change7d,
      sparkline,
    }
  })
}

function changeColor(c: number | null): string {
  if (c === null) return 'var(--text-low)'
  if (c > 0) return 'var(--green)'
  if (c < 0) return 'var(--red)'
  return 'var(--text-low)'
}

function suggestedIndexFor(pairs: PairResult[], query: string): number {
  if (pairs.length === 1) return 0
  const q = query.trim().toUpperCase()
  if (!q) return -1
  const exactIdx = pairs.findIndex(r => r.base.symbol.toUpperCase() === q)
  return exactIdx >= 0 ? exactIdx : -1
}

export default function AssetPickerDialog({
  isOpen,
  onClose,
  onSelect,
  assets,
  currentBaseId,
  currentQuoteId,
  keyBufferRef,
  marketStats,
}: AssetPickerDialogProps) {
  const isMobile = useWindowWidth() <= 768
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const statsById = useMemo(() => {
    const m = new Map<number, AssetMarketStats>()
    if (marketStats) for (const s of marketStats) m.set(s.assetId, s)
    return m
  }, [marketStats])

  const volumeByAssetId = useMemo(() => {
    const m = new Map<number, number>()
    if (marketStats) for (const s of marketStats) m.set(s.assetId, s.volumeUsd24h)
    return m
  }, [marketStats])

  useEffect(() => {
    if (!isOpen) return
    const timer = window.setTimeout(() => {
      setActiveIndex(null)
      const buffered = keyBufferRef.current
      keyBufferRef.current = ''
      setQuery(buffered)
      inputRef.current?.focus()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [isOpen, keyBufferRef])

  useEffect(() => {
    if (!isOpen) keyBufferRef.current = ''
  }, [isOpen, keyBufferRef])

  const pairs = useMemo(() => {
    if (query.trim() === '') return getDefaultPairs(assets, volumeByAssetId)
    return searchPairs(query, assets)
  }, [query, assets, volumeByAssetId])

  const rows = useMemo(
    () => buildRows(pairs, statsById, currentBaseId, currentQuoteId),
    [pairs, statsById, currentBaseId, currentQuoteId]
  )

  const suggestedActiveIndex = useMemo(() => suggestedIndexFor(pairs, query), [pairs, query])
  const effectiveActiveIndex = activeIndex ?? suggestedActiveIndex

  useEffect(() => {
    if (effectiveActiveIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[role="option"]')
    items[effectiveActiveIndex]?.scrollIntoView({ block: 'nearest' })
  }, [effectiveActiveIndex])

  const handleQueryChange = (value: string) => {
    setQuery(value)
    setActiveIndex(null)
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min((prev ?? suggestedActiveIndex) + 1, rows.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max((prev ?? suggestedActiveIndex) - 1, -1))
      return
    }
    if (e.key === 'Enter' && effectiveActiveIndex >= 0 && effectiveActiveIndex < rows.length) {
      e.preventDefault()
      onSelect(rows[effectiveActiveIndex].pairResult)
      onClose()
    }
  }, [rows, effectiveActiveIndex, suggestedActiveIndex, onClose, onSelect])

  const sortLabel = query.trim() === '' ? 'sorted by 24h volume' : 'sorted by match'

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <style>{`
          .picker-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(13, 4, 26, 0.74); backdrop-filter: blur(8px) saturate(140%); -webkit-backdrop-filter: blur(8px) saturate(140%); display: flex; align-items: flex-start; justify-content: center; padding-top: 8vh; }
          [data-theme="light"] .picker-overlay { background: rgba(36, 14, 50, 0.34); }
          .picker-modal { width: 880px; max-width: calc(100vw - 32px); max-height: 78vh; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 24px; box-shadow: 0 24px 72px rgba(0,0,0,0.5); overflow: hidden; display: flex; flex-direction: column; outline: none; }
          [data-theme="light"] .picker-modal { box-shadow: 0 24px 72px rgba(36, 14, 50, 0.22); }
          .picker-modal-mobile { width: 100vw; max-width: 100vw; height: 100svh; max-height: 100svh; border-radius: 0; }
          .picker-head { padding: 12px 12px 0 12px; background: var(--bg-elev); }
          .picker-head-inner {
            display: flex; align-items: center; gap: 12px;
            padding: 14px 18px; border-radius: 12px;
            background: var(--panel); border: 1px solid var(--border);
          }
          .picker-head-inner .search-icon { color: var(--text-medium); flex-shrink: 0; }
          .picker-head-inner input { all: unset; flex: 1; min-width: 0; font-family: 'Geist', sans-serif; font-size: 16px; font-weight: 500; color: var(--text-high); }
          .picker-head-inner input:focus-visible { outline: none; }
          .picker-head-inner input::placeholder { color: var(--text-low); }
          .picker-head-inner .esc { font-family: 'GeistMono', monospace; font-size: 10px; color: var(--text-low); text-transform: uppercase; letter-spacing: 0.1em; white-space: nowrap; }
          .picker-divider { height: 1px; background: var(--separator); margin: 12px 0 0; }
          @media (max-width: 768px) {
            .picker-head { padding: 10px 10px 0 10px; }
            .picker-head-inner { padding: 12px 14px; gap: 10px; }
            .picker-head-inner .esc { display: none; }
          }

          .picker-table-head { display: grid; grid-template-columns: 1fr 100px 70px 70px 70px 110px; gap: 16px; padding: 10px 22px; font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-low); border-bottom: 1px solid var(--separator); }
          .picker-table-head > div:not(:first-child) { text-align: right; }
          .picker-table-head > div.center { text-align: center; }

          .picker-table { overflow-y: auto; flex: 1; }
          .picker-row { display: grid; grid-template-columns: 1fr 100px 70px 70px 70px 110px; gap: 16px; align-items: center; padding: 11px 22px; border-bottom: 1px solid var(--separator); cursor: pointer; border-left: 3px solid transparent; transition: background 140ms ease; }
          .picker-row:hover { background: var(--panel-hover); }
          .picker-row.active { background: var(--panel-hover); border-left-color: var(--text-medium); }
          .picker-row.current { background: var(--accent-soft); border-left-color: var(--accent); }
          .picker-row.current .picker-sym { color: var(--accent); }
          .picker-asset { display: flex; align-items: center; gap: 12px; min-width: 0; }
          .picker-sym { font-size: 14px; font-weight: 600; color: var(--text-high); }
          .picker-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
          .picker-hint { font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-low); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .picker-num { font-family: 'GeistMono', monospace; font-size: 13px; font-weight: 500; color: var(--text-high); text-align: right; }
          .picker-chg { font-family: 'GeistMono', monospace; font-size: 12px; text-align: right; }
          .picker-spark { display: flex; align-items: center; justify-content: center; }
          .picker-foot { display: flex; align-items: center; justify-content: space-between; padding: 12px 22px; border-top: 1px solid var(--separator); background: var(--bg); font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-low); }
          .picker-foot .hints { display: flex; gap: 16px; flex-wrap: wrap; }
          .picker-foot .hint { display: inline-flex; gap: 6px; align-items: center; }

          .picker-close-btn {
            display: none; width: 32px; height: 32px; border-radius: 9999px;
            align-items: center; justify-content: center;
            color: var(--text-medium); background: transparent; border: none;
            flex-shrink: 0;
          }
          .picker-close-btn:hover { color: var(--text-high); background: var(--panel-hover); }
          @media (max-width: 768px) {
            .picker-close-btn { display: inline-flex; }
            .picker-foot .hints { display: none; }
          }

          @media (max-width: 768px) {
            .picker-table-head { grid-template-columns: 1fr 90px 64px 90px; }
            .picker-table-head .col-1h, .picker-table-head .col-7d { display: none; }
            .picker-row { grid-template-columns: 1fr 90px 64px 90px; padding: 11px 16px; }
            .picker-row .col-1h, .picker-row .col-7d { display: none; }
            .picker-foot { flex-direction: column; align-items: flex-start; gap: 6px; }
          }
        `}</style>
        <Dialog.Overlay className="picker-overlay" />
        <Dialog.Content
          aria-label="Select asset"
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={'picker-modal' + (isMobile ? ' picker-modal-mobile' : '')}
          style={{ position: 'fixed', top: isMobile ? 0 : '8vh', left: isMobile ? 0 : '50%', transform: isMobile ? undefined : 'translateX(-50%)', zIndex: 101 }}
        >
          <div className="picker-head">
            <div className="picker-head-inner">
              <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                placeholder="Type a symbol — e.g. DOT, vDOT, USDT, HDX…"
                autoComplete="off"
                aria-label="Search assets and pairs"
              />
              <span className="esc">ESC to close</span>
              <button
                type="button"
                className="picker-close-btn"
                onClick={onClose}
                aria-label="Close pair picker"
                title="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
              </button>
            </div>
            <div className="picker-divider" />
          </div>

          <div className="picker-table-head">
            <div>Asset</div>
            <div>Price</div>
            <div className="col-1h">1H</div>
            <div>24H</div>
            <div className="col-7d">7D</div>
            <div className="center">Last 7 days</div>
          </div>

          <div ref={listRef} className="picker-table">
            {rows.length === 0 ? (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
                padding: '48px 24px', color: 'var(--text-low)', fontSize: 14, textAlign: 'center', gap: 8,
              }}>
                <div style={{ color: 'var(--text-medium)', fontWeight: 500 }}>No matches for &ldquo;{query}&rdquo;</div>
                <div>Try a different symbol — e.g. HDX, DOT, ETH</div>
              </div>
            ) : rows.map((r, i) => {
              const isUsd = r.pairResult.quote.isStablecoin
              const label = displayLabel(r.pairResult.display)
              const className = 'picker-row' + (r.isCurrent ? ' current' : (i === effectiveActiveIndex ? ' active' : ''))
              return (
                <div
                  key={`${r.pairResult.base.assetId}-${r.pairResult.quote.assetId}`}
                  role="option"
                  aria-selected={r.isCurrent}
                  className={className}
                  onClick={() => { onSelect(r.pairResult); onClose() }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <div className="picker-asset">
                    <PairIcons base={r.pairResult.base} quote={r.pairResult.quote} isUsdPair={isUsd} size={24} />
                    <div className="picker-name">
                      <span className="picker-sym">{label}</span>
                      {r.pairResult.nameHint && <span className="picker-hint">{r.pairResult.nameHint}</span>}
                    </div>
                  </div>
                  <div className="picker-num">{r.price != null ? formatPrice(r.price, isUsd) : '—'}</div>
                  <div className="picker-chg col-1h" style={{ color: changeColor(r.change1h) }}>{formatChange(r.change1h)}</div>
                  <div className="picker-chg" style={{ color: changeColor(r.change24h) }}>{formatChange(r.change24h)}</div>
                  <div className="picker-chg col-7d" style={{ color: changeColor(r.change7d) }}>{formatChange(r.change7d)}</div>
                  <div className="picker-spark"><Sparkline data={r.sparkline} change7d={r.change7d} width={isMobile ? 80 : 100} height={28} /></div>
                </div>
              )
            })}
          </div>

          <div className="picker-foot">
            <div className="hints">
              <span className="hint"><span className="kbd">↑</span><span className="kbd">↓</span> Navigate</span>
              <span className="hint"><span className="kbd">↵</span> Open</span>
              <span className="hint"><span className="kbd">/</span> Search</span>
              <span className="hint"><span className="kbd">Esc</span> Close</span>
            </div>
            <span>{rows.length} {rows.length === 1 ? 'pair' : 'pairs'} · {sortLabel}</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
