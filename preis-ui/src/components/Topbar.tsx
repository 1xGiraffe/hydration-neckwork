import { useEffect, useRef, useState } from 'react'
import IntervalSelector from './IntervalSelector'
import PairIcons from './PairIcons'
import { INTERVALS, INTERVAL_LABELS } from '../types'
import type { OHLCVInterval, Asset } from '../types'
import type { Theme } from '../hooks/useTheme'
import { pairDisplay as formatPairDisplay } from '../utils/pairs'
import FavoriteStar from './FavoriteStar'
import { CameraIcon, DownloadIcon, HydrationLogo, MoonIcon, SunIcon } from './icons'

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
  theme: Theme
  onThemeToggle: () => void
  showDesktopSidebarButton: boolean
  desktopSidebarOpen: boolean
  onToggleDesktopSidebar: () => void
  showMobileSidebarButton: boolean
  onOpenMobileSidebar: () => void
  isFavorite: boolean
  onToggleFavorite: () => void
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
  theme,
  onThemeToggle,
  showDesktopSidebarButton,
  desktopSidebarOpen,
  onToggleDesktopSidebar,
  showMobileSidebarButton,
  onOpenMobileSidebar,
  isFavorite,
  onToggleFavorite,
}: TopbarProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null)
  // One slashless label everywhere — "HDX" for a USD pair, "HDXEURC" for a
  // cross one. `pairDisplay` is the App-supplied fallback for the first paint,
  // before the asset registry has resolved both legs.
  const isUsdPair = quoteAsset?.isUsdPegged ?? false
  const label = baseAsset && quoteAsset ? formatPairDisplay(baseAsset, quoteAsset) : pairDisplay

  useEffect(() => {
    if (!mobileMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMobileMenuOpen(false)
      mobileMenuTriggerRef.current?.focus()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobileMenuOpen])

  return (
    <>
      <style>{`
        .topbar {
          display: flex; align-items: center; gap: 12px;
          padding: 0 16px;
          height: 56px;
          min-height: 56px;
          border-bottom: 1px solid var(--separator);
          background: var(--bg);
        }
        .brand { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; line-height: 1; }
        .brand .logo { color: var(--accent); }
        .brand .wordmark { font-family: 'Gazpacho', serif; font-weight: 500; font-size: 18px; letter-spacing: 0; color: var(--text-high); line-height: 1; }
        .brand .product { font-family: 'Gazpacho', serif; font-style: italic; font-weight: 400; font-size: 18px; color: var(--accent); line-height: 1; }

        .vdiv { width: 1px; height: 24px; background: var(--separator); flex-shrink: 0; }

        .pair-pill {
          display: inline-flex; align-items: center; gap: 10px;
          height: 36px; padding: 0 12px 0 8px;
          border-radius: 9999px;
          background: var(--panel); border: 1px solid var(--border);
          color: var(--text-high);
          transition: background 160ms, border-color 160ms, transform 140ms var(--ease-out-soft);
          flex-shrink: 0;
        }
        .pair-pill:hover { background: var(--panel-hover); border-color: var(--accent); transform: translateY(-1px); }
        .pair-pill:active { transform: translateY(0) scale(0.99); }
        .pair-pill .name { font-size: 13px; font-weight: 600; letter-spacing: 0; white-space: nowrap; }
        .pair-pill .caret { color: var(--text-low); font-size: 10px; }

        /* Mobile-only favorite button — sits beside the pair pill so the
           current-pair star is reachable when the hero is collapsed. */
        .fav-btn-mobile {
          display: none;
          width: 36px; height: 36px; border-radius: 9999px;
          align-items: center; justify-content: center;
          color: var(--text-medium); flex-shrink: 0;
          transition: color 140ms, background 140ms, transform 140ms var(--ease-out-soft);
        }
        .fav-btn-mobile:active { transform: scale(0.94); }
        .fav-btn-mobile:hover { color: var(--amber); background: var(--panel-hover); }
        .fav-btn-mobile.on { color: var(--amber); }
        .fav-btn-mobile svg { width: 18px; height: 18px; transition: transform 160ms var(--ease-out-soft); }
        .fav-btn-mobile.on svg { animation: preis-favorite-pop 220ms var(--ease-out-soft); }


        .topbar-right { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .icon-btn {
          width: 36px; height: 36px; border-radius: 9999px;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-medium);
          transition: color 160ms, background 160ms, transform 140ms var(--ease-out-soft);
        }
        .icon-btn:hover { color: var(--text-high); background: var(--panel-hover); transform: translateY(-1px); }
        .icon-btn:active { transform: translateY(0) scale(0.94); }
        .icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .icon-btn svg { width: 16px; height: 16px; }
        .theme-toggle {
          width: 36px; height: 36px; border-radius: 9999px;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-medium); margin-left: 2px;
          transition: color 140ms, background 140ms, transform 140ms var(--ease-out-soft);
        }
        .theme-toggle:hover { color: var(--text-high); background: var(--panel-hover); transform: translateY(-1px); }
        .theme-toggle:active { transform: translateY(0) scale(0.94); }
        .theme-toggle svg { width: 16px; height: 16px; transition: transform 180ms var(--ease-out-soft); }
        .theme-toggle:hover svg { transform: rotate(8deg); }

        .interval-mobile { display: none; position: relative; }
        .interval-mobile-trigger {
          padding: 0 12px; height: 32px;
          font-family: 'GeistMono', monospace; font-size: 11px; font-weight: 500;
          text-transform: uppercase; letter-spacing: 0.04em;
          background: var(--panel); color: var(--text-high); border: 1px solid var(--border);
          border-radius: 9999px;
          display: inline-flex; align-items: center; gap: 6px;
          transition: background 140ms, transform 140ms var(--ease-out-soft);
        }
        .interval-mobile-trigger:hover { background: var(--panel-hover); transform: translateY(-1px); }
        .interval-mobile-trigger:active { transform: translateY(0) scale(0.98); }
        .interval-mobile-menu {
          position: absolute; right: 0; top: 36px; z-index: 50;
          background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px;
          min-width: 160px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); overflow: hidden;
          animation: preis-list-row-in 160ms var(--ease-out-soft);
        }
        .interval-mobile-menu button {
          display: block; width: 100%; padding: 12px 16px;
          font-family: 'Geist', sans-serif; font-size: 14px;
          color: var(--text-high); background: transparent; text-align: left;
        }
        .interval-mobile-menu button:hover { background: var(--panel-hover); }
        .interval-mobile-menu button.active { color: var(--accent); }

        @media (max-width: 880px) {
          .topbar-desktop-intervals { display: none !important; }
          .topbar-vdiv-intervals { display: none !important; }
          .interval-mobile { display: inline-flex !important; }
          /* The brand block (Hydration logo + wordmark + "preis") is dropped on
             mobile — the pair pill carries enough identity. Padding matches the
             hero/sidebar's 14px so columns line up vertically. */
          .brand, .vdiv { display: none !important; }
          .topbar { gap: 8px; padding: 0 14px; }
          .pair-pill .kbd { display: none; }
          /* Download, screenshot, and theme controls move into the mobile dropdown */
          .topbar-export-btn, .topbar-screenshot-btn, .theme-toggle { display: none !important; }
          .fav-btn-mobile { display: inline-flex !important; }
          /* Push the interval picker to the right edge so it sits next to the
             burger. Both .interval-mobile and .topbar-right would otherwise
             have margin-left:auto and split the free space — kill the auto on
             topbar-right on mobile so the interval picker owns the push. */
          .interval-mobile { margin-left: auto; }
          .topbar-right { margin-left: 0; }
        }
        @media (max-width: 520px) {
          .pair-pill { padding: 0 10px 0 6px; height: 32px; }
        }
      `}</style>
      <div className="topbar">
        <span className="brand">
          <HydrationLogo />
          <span className="wordmark">Hydration</span>
          <span className="product">preis</span>
        </span>

        <span className="vdiv" />

        <button
          type="button"
          className="pair-pill"
          onClick={onPairClick}
          aria-haspopup="dialog"
          aria-label={`Select trading pair. Current pair: ${label}`}
          title="Change pair (or just start typing)"
        >
          {baseAsset && quoteAsset && (
            <PairIcons base={baseAsset} quote={quoteAsset} isUsdPair={isUsdPair} size={22} />
          )}
          <span className="name">{label}</span>
          <span className="caret">▾</span>
          <span className="kbd">/</span>
        </button>

        <button
          type="button"
          className={'fav-btn-mobile' + (isFavorite ? ' on' : '')}
          onClick={onToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <FavoriteStar selected={isFavorite} />
        </button>

        <span className="vdiv topbar-vdiv-intervals" />

        <div className="topbar-desktop-intervals" style={{ display: 'flex' }}>
          <IntervalSelector value={interval} onChange={onIntervalChange} />
        </div>

        <div className="interval-mobile">
          <button
            ref={mobileMenuTriggerRef}
            type="button"
            className="interval-mobile-trigger"
            onClick={() => setMobileMenuOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuOpen ? 'mobile-interval-menu' : undefined}
          >
            {INTERVAL_LABELS[interval]}<span className="caret" style={{ color: 'var(--text-low)' }}>▾</span>
          </button>
          {mobileMenuOpen && (
            <>
              <div onClick={() => setMobileMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
              <div id="mobile-interval-menu" role="menu" className="interval-mobile-menu" aria-label="Chart interval">
                {INTERVALS.map(iv => (
                  <button
                    key={iv}
                    type="button"
                    role="menuitemradio"
                    aria-checked={iv === interval}
                    className={iv === interval ? 'active' : ''}
                    onClick={() => { onIntervalChange(iv); setMobileMenuOpen(false) }}
                  >
                    {INTERVAL_LABELS[iv]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="topbar-right">
          <button
            type="button"
            className="icon-btn topbar-export-btn"
            onClick={onExport}
            aria-label="Download visible candles as CSV"
            disabled={!canExport}
            title="Download CSV"
          >
            <DownloadIcon />
          </button>
          <button
            type="button"
            className="icon-btn topbar-screenshot-btn"
            onClick={onScreenshot}
            aria-label="Copy chart screenshot to clipboard"
            title="Screenshot"
          >
            <CameraIcon />
          </button>
          {showMobileSidebarButton && (
            <button
              type="button"
              className="icon-btn"
              onClick={onOpenMobileSidebar}
              aria-label="Open markets and favorites"
              title="Markets"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
          )}
          <button
            type="button"
            className="theme-toggle"
            onClick={onThemeToggle}
            aria-label={theme === 'dark' ? 'Lights on' : 'Lights off'}
            title={theme === 'dark' ? 'Lights on' : 'Lights off'}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          {showDesktopSidebarButton && (
            <button
              type="button"
              className="icon-btn"
              onClick={onToggleDesktopSidebar}
              aria-pressed={desktopSidebarOpen}
              aria-label={desktopSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              title={desktopSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              {desktopSidebarOpen
                ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M7 9l3 3-3 3"/></svg>
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M10 9l-3 3 3 3"/></svg>}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
