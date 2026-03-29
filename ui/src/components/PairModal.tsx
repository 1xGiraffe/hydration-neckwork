import { useState, useEffect, useRef, useCallback } from 'react'
import type { Asset } from '../types'
import { getDefaultPairs, searchPairs, displayLabel } from '../utils/pairs'
import type { PairResult } from '../utils/pairs'
import PairIcons from './PairIcons'

interface PairModalProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (pair: PairResult) => void
  assets: Asset[]
  currentBaseId: number
  currentQuoteId: number
  initialChar?: string
}

export default function PairModal({
  isOpen,
  onClose,
  onSelect,
  assets,
  currentBaseId,
  currentQuoteId,
  initialChar,
}: PairModalProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      setQuery(initialChar ?? '')
      setActiveIndex(-1)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen, initialChar])

  const results = query.trim() === ''
    ? getDefaultPairs(assets)
    : searchPairs(query, assets)

  useEffect(() => {
    setActiveIndex(results.length > 0 && query.trim() ? 0 : -1)
  }, [query])

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[role="option"]')
    items[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min(prev + 1, results.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max(prev - 1, -1))
      return
    }
    if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < results.length) {
      e.preventDefault()
      onSelect(results[activeIndex])
      onClose()
      return
    }
  }, [results, activeIndex, onClose, onSelect])

  useEffect(() => {
    if (!isOpen) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = 'auto' }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: '#030816', zIndex: 100 }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select pair"
        onKeyDown={handleKeyDown}
        style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', zIndex: 101 }}
      >
        <div style={{
          height: '48px', minHeight: '48px', padding: '0 16px',
          borderBottom: '1px solid #0d1b2a', display: 'flex', alignItems: 'center', gap: '12px', background: '#030816',
        }}>
          <button onClick={onClose} aria-label="Close pair selector"
            style={{ fontSize: '14px', color: '#576B80', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px', flexShrink: 0 }}>
            ✕
          </button>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search pairs..."
            aria-label="Search pairs"
            style={{
              flex: 1, fontSize: '14px', background: '#1e293b', color: '#e2e8f0',
              border: `1px solid ${query ? '#4FFFDF' : '#334155'}`, borderRadius: '6px', padding: '8px 12px', outline: 'none',
            }}
            onFocus={e => { e.currentTarget.style.border = '1px solid #4FFFDF' }}
            onBlur={e => { e.currentTarget.style.border = query ? '1px solid #4FFFDF' : '1px solid #334155' }}
          />
        </div>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', background: '#030816' }}>
          {results.length === 0 && query.trim() !== '' ? (
            <div style={{ padding: '24px 16px', color: '#576B80', fontSize: '13px' }}>
              <div>No pairs found for &ldquo;{query}&rdquo;. Try a different symbol, e.g. HDX, SOL, ETH</div>
            </div>
          ) : (
            results.map((result, i) => {
              const isCurrent = result.base.assetId === currentBaseId && result.quote.assetId === currentQuoteId
              return (
                <button
                  key={`${result.base.assetId}-${result.quote.assetId}`}
                  onClick={() => { onSelect(result); onClose() }}
                  role="option"
                  aria-selected={isCurrent}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '12px 16px',
                    minHeight: '56px',
                    fontSize: '14px',
                    color: isCurrent ? '#4FFFDF' : '#e2e8f0',
                    background: i === activeIndex ? '#1e293b' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={e => { setActiveIndex(i); e.currentTarget.style.background = '#1e293b' }}
                  onMouseLeave={e => { if (i !== activeIndex) e.currentTarget.style.background = 'transparent' }}
                >
                  <PairIcons
                    base={result.base}
                    quote={result.quote}
                    isUsdPair={result.quote.isStablecoin}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{displayLabel(result.display)}</span>
                    {result.nameHint && (
                      <span style={{ fontSize: '12px', color: '#576B80' }}>{result.nameHint}</span>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}
