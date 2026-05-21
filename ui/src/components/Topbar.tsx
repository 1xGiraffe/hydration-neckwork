import { useState } from 'react'
import IntervalSelector from './IntervalSelector'
import PairIcons from './PairIcons'
import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval, Asset } from '../types'

interface TopbarProps {
  pairDisplay: string
  baseAsset: Asset | undefined
  quoteAsset: Asset | undefined
  interval: OHLCVInterval
  onIntervalChange: (interval: OHLCVInterval) => void
  onPairClick: () => void
  onExport: () => void
  canExport: boolean
  onScreenshot: () => void
}

function pairLabel(baseAsset: Asset | undefined, quoteAsset: Asset | undefined, fallback: string): { base: string; quote: string } {
  if (!baseAsset || !quoteAsset) return { base: fallback, quote: '' }
  const quote = quoteAsset.isStablecoin ? 'USD' : quoteAsset.symbol
  return { base: baseAsset.symbol, quote }
}

export default function Topbar({
  pairDisplay,
  baseAsset,
  quoteAsset,
  interval,
  onIntervalChange,
  onPairClick,
  onExport,
  canExport,
  onScreenshot,
}: TopbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [pairHovered, setPairHovered] = useState(false)
  const [screenshotHovered, setScreenshotHovered] = useState(false)
  const [exportHovered, setExportHovered] = useState(false)
  const { base: baseLabel, quote: quoteLabel } = pairLabel(baseAsset, quoteAsset, pairDisplay)

  return (
    <>
      <style>{`
        @media (max-width: 768px) {
          .topbar-desktop-intervals { display: none !important; }
          .topbar-desktop-separator { display: none !important; }
          .topbar-interval-mobile { display: flex !important; }
          .topbar-export-desktop { display: none !important; }
          .topbar-screenshot-btn { display: flex !important; }
        }
        @media (min-width: 769px) {
          .topbar-desktop-intervals { display: flex !important; }
          .topbar-desktop-separator { display: block !important; }
          .topbar-interval-mobile { display: none !important; }
          .topbar-export-desktop { display: flex !important; }
          .topbar-screenshot-btn { display: flex !important; }
        }
      `}</style>
      <div style={{
        height: '48px',
        minHeight: '48px',
        padding: '0 16px',
        borderBottom: '1px solid #0d1b2a',
        display: 'flex',
        alignItems: 'center',
      }}>
        {/* Left group: pair + separator + intervals (desktop) */}
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
          <button
            onClick={onPairClick}
            onMouseEnter={() => setPairHovered(true)}
            onMouseLeave={() => setPairHovered(false)}
            aria-label={`Select trading pair. Current pair: ${baseLabel} ${quoteLabel}`}
            aria-haspopup="dialog"
            title="Change pair (or just start typing)"
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: '#e2e8f0',
              background: pairHovered ? '#0d1b2a' : 'transparent',
              border: `1px solid ${pairHovered ? '#1e293b' : 'transparent'}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 10px 4px 6px',
              borderRadius: '6px',
              transition: 'background 0.15s ease, border-color 0.15s ease',
            }}
          >
            {baseAsset && quoteAsset && (
              <PairIcons
                base={baseAsset}
                quote={quoteAsset}
                isUsdPair={quoteAsset.isStablecoin}
              />
            )}
            <span>{baseLabel}</span>
            {quoteLabel && (
              <>
                <span style={{ color: '#576B80', fontWeight: 400 }}>/</span>
                <span style={{ color: '#94a3b8', fontWeight: 500 }}>{quoteLabel}</span>
              </>
            )}
            <span style={{ fontSize: '10px', color: pairHovered ? '#4FFFDF' : '#576B80', marginLeft: '2px', transition: 'color 0.15s ease' }}>▾</span>
          </button>

          <div
            className="topbar-desktop-separator"
            style={{
              width: '1px',
              height: '24px',
              background: '#0d1b2a',
              margin: '0 16px',
              flexShrink: 0,
            }}
          />

          <div className="topbar-desktop-intervals" style={{ display: 'flex' }}>
            <IntervalSelector value={interval} onChange={onIntervalChange} />
          </div>
        </div>

        {/* Right group: mobile interval + export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <div className="topbar-interval-mobile" style={{ display: 'none', position: 'relative' }}>
            <button
              onClick={() => setMobileMenuOpen(prev => !prev)}
              aria-label={`Current interval: ${INTERVAL_LABELS[interval]}. Tap to change interval`}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                fontWeight: 500,
                background: '#1e293b',
                color: '#4FFFDF',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              {INTERVAL_LABELS[interval]} ▾
            </button>
            {mobileMenuOpen && (
              <>
                <div
                  onClick={() => setMobileMenuOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                />
                <div style={{
                  position: 'absolute',
                  right: 0,
                  top: '36px',
                  background: '#030816',
                  border: '1px solid #1e293b',
                  borderRadius: '6px',
                  zIndex: 50,
                  minWidth: '160px',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                  overflow: 'hidden',
                }}>
                  {INTERVALS.map((iv) => (
                    <button
                      key={iv}
                      onClick={() => { onIntervalChange(iv); setMobileMenuOpen(false) }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '12px 16px',
                        fontSize: '14px',
                        minHeight: '44px',
                        background: 'transparent',
                        color: iv === interval ? '#4FFFDF' : '#e2e8f0',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {INTERVAL_LABELS[iv]}
                    </button>
                  ))}
                  <button
                    onClick={() => { if (canExport) { onExport(); } setMobileMenuOpen(false) }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '12px 16px',
                      fontSize: '14px',
                      minHeight: '44px',
                      background: 'transparent',
                      color: canExport ? '#e2e8f0' : '#334155',
                      border: 'none',
                      borderTop: '1px solid #0d1b2a',
                      cursor: canExport ? 'pointer' : 'not-allowed',
                      textAlign: 'left',
                    }}
                  >
                    Export CSV
                  </button>
                </div>
              </>
            )}
          </div>

          <button
            className="topbar-export-desktop"
            onClick={() => { if (canExport) onExport() }}
            onMouseEnter={() => setExportHovered(true)}
            onMouseLeave={() => setExportHovered(false)}
            aria-label="Export visible candles as CSV"
            aria-disabled={!canExport}
            title="Download visible candles as CSV"
            style={{
              padding: '6px',
              background: canExport && exportHovered ? '#0d1b2a' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              cursor: canExport ? 'pointer' : 'not-allowed',
              color: canExport ? (exportHovered ? '#4FFFDF' : '#576B80') : '#334155',
              display: 'flex',
              alignItems: 'center',
              transition: 'color 0.15s ease, background 0.15s ease',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <polyline points="4,6 8,10 12,6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="8" y1="1" x2="8" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          <button
            className="topbar-screenshot-btn"
            onClick={onScreenshot}
            onMouseEnter={() => setScreenshotHovered(true)}
            onMouseLeave={() => setScreenshotHovered(false)}
            aria-label="Copy chart screenshot to clipboard"
            title="Copy screenshot to clipboard"
            style={{
              padding: '6px',
              background: screenshotHovered ? '#0d1b2a' : 'transparent',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              color: screenshotHovered ? '#4FFFDF' : '#576B80',
              display: 'flex',
              alignItems: 'center',
              transition: 'color 0.15s ease, background 0.15s ease',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}
