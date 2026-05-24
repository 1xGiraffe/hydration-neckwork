import { useMemo } from 'react'
import type { Asset, AssetMarketStats, Period } from '../types'
import PairIcons from './PairIcons'
import { formatPrice, formatChange, formatCompactUsd } from '../utils/format'
import { displayLabel, pairDisplay } from '../utils/pairs'

const TOP_N = 8
const MIN_MOVER_VOLUME_USD = 1_000

interface FavoritePair { baseId: number; quoteId: number }

interface SidebarProps {
  assets: Asset[]
  marketStats: AssetMarketStats[] | undefined
  currentBaseId: number
  currentQuoteId: number
  onSelect: (baseId: number, quoteId: number) => void
  blockHeight: number | null
  indexerLive: boolean
  period: Period
  onCyclePeriod: () => void
  favorites: FavoritePair[]
  /** Hide the inline indexer footer (the mobile drawer renders it itself, below the actions). */
  hideIndexer?: boolean
}

function changeForPeriod(s: AssetMarketStats, p: Period): number | null {
  return p === '1h' ? s.change1h : p === '7d' ? s.change7d : s.change24h
}

interface Row {
  asset: Asset
  stats: AssetMarketStats
}

function changeClass(c: number | null): 'up' | 'down' | 'flat' {
  if (c === null) return 'flat'
  if (c > 0) return 'up'
  if (c < 0) return 'down'
  return 'flat'
}

export default function Sidebar({
  assets,
  marketStats,
  currentBaseId,
  currentQuoteId,
  onSelect,
  blockHeight,
  indexerLive,
  period,
  onCyclePeriod,
  favorites,
  hideIndexer = false,
}: SidebarProps) {
  const usdt = useMemo(() => assets.find(a => a.assetId === 10), [assets])
  const assetsById = useMemo(() => new Map(assets.map(a => [a.assetId, a])), [assets])
  const statsById = useMemo(() => {
    const m = new Map<number, AssetMarketStats>()
    if (marketStats) for (const s of marketStats) m.set(s.assetId, s)
    return m
  }, [marketStats])

  const rows: Row[] = useMemo(() => {
    if (!marketStats || !usdt) return []
    const result: Row[] = []
    for (const s of marketStats) {
      const a = assetsById.get(s.assetId)
      if (!a || a.isStablecoin) continue
      if (!s.price || s.price <= 0) continue
      result.push({ asset: a, stats: s })
    }
    return result
  }, [marketStats, assetsById, usdt])

  const topMarkets = useMemo(
    () => [...rows].sort((a, b) => b.stats.volumeUsd24h - a.stats.volumeUsd24h).slice(0, TOP_N),
    [rows]
  )

  const topMovers = useMemo(() => {
    // Volume gate always uses 24h volume (we want assets with meaningful liquidity),
    // but ranking uses the currently-selected period's change.
    const eligible = rows.filter(r => r.stats.volumeUsd24h >= MIN_MOVER_VOLUME_USD && changeForPeriod(r.stats, period) !== null)
    return [...eligible].sort((a, b) => Math.abs(changeForPeriod(b.stats, period)!) - Math.abs(changeForPeriod(a.stats, period)!)).slice(0, TOP_N)
  }, [rows, period])

  // Resolve favorites against the current asset registry + market stats. Skips
  // entries whose assets are no longer in the registry.
  const favoriteRows = useMemo(() => {
    const result: Array<{
      pair: FavoritePair
      base: Asset
      quote: Asset
      price: number | null
      change: number | null
    }> = []
    for (const f of favorites) {
      const base = assetsById.get(f.baseId)
      const quote = assetsById.get(f.quoteId)
      if (!base || !quote) continue
      const bs = statsById.get(base.assetId)
      const qs = statsById.get(quote.assetId)
      let price: number | null = null
      let change: number | null = null
      if (quote.isStablecoin) {
        price = bs?.price ?? null
        change = bs ? changeForPeriod(bs, period) : null
      } else if (bs?.price && qs?.price && qs.price !== 0) {
        price = bs.price / qs.price
        // Cross-pair change: derive from both sides' per-asset USD change
        // (price_then = price_now / (1 + change)). Falling back to the base's
        // change alone produced wrong signs / wrong magnitudes when the quote
        // moved meaningfully — e.g. HDXDOT showing +0.89% while the badge
        // showed -1.82% because the badge derived properly but favorites used
        // base.change24h alone.
        const baseChange = changeForPeriod(bs, period)
        const quoteChange = changeForPeriod(qs, period)
        if (baseChange != null && quoteChange != null) {
          const baseThen = bs.price / (1 + baseChange)
          const quoteThen = qs.price / (1 + quoteChange)
          if (quoteThen !== 0) {
            const ratioThen = baseThen / quoteThen
            if (ratioThen !== 0) change = price / ratioThen - 1
          }
        }
      }
      result.push({ pair: f, base, quote, price, change })
    }
    // Alphabetical by displayed label (e.g. "DOT" < "HDXDOT" < "vDOT") so
    // adding/removing favorites doesn't reorder the list.
    result.sort((a, b) => {
      const la = displayLabel(pairDisplay(a.base, a.quote))
      const lb = displayLabel(pairDisplay(b.base, b.quote))
      return la.localeCompare(lb, undefined, { sensitivity: 'base' })
    })
    return result
  }, [favorites, assetsById, statsById, period])

  return (
    <>
      <style>{`
        .sidebar { border-left: 1px solid var(--separator); background: var(--bg); display: flex; flex-direction: column; overflow: hidden; height: 100%; }
        .sb-section { padding: 16px 20px; border-bottom: 1px solid var(--separator); }
        /* Top markets and Top movers both share the available vertical space
           equally and scroll independently — same height, both scrollable. */
        .sb-section.scroll { overflow-y: auto; flex: 1 1 0; min-height: 0; }
        /* Indexer footer: status-line at the bottom of the sidebar, no border below. */
        .sb-section.sb-indexer { padding: 12px 20px; border-bottom: none; border-top: 1px solid var(--separator); margin-top: auto; }
        .sb-section.sb-indexer .sb-head { margin-bottom: 0; }
        .sb-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .sb-title { font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-medium); }
        button.sb-title { cursor: pointer; transition: color 140ms, transform 140ms var(--ease-out-soft); }
        button.sb-title:hover { color: var(--text-high); transform: translateY(-1px); }
        button.sb-title:active { transform: translateY(0); }
        button.sb-title .period-tag { color: var(--accent); }
        .sb-tip { font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-high); display: inline-flex; align-items: center; gap: 8px; }

        .market-row {
          display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 10px;
          padding: 7px 8px; margin: 0 -8px; border-radius: 10px; cursor: pointer;
          transition: background 140ms ease, transform 140ms var(--ease-out-soft);
        }
        .market-row:hover { background: var(--panel-hover); transform: translateX(2px); }
        .market-row:active { transform: translateX(1px) scale(0.995); }
        .market-row.active { background: var(--accent-soft); }
        .market-row.active .m-sym { color: var(--accent); }
        .m-sym { font-size: 13px; font-weight: 600; color: var(--text-high); display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .m-sym small { font-family: 'GeistMono', monospace; font-size: 10px; font-weight: 400; color: var(--text-low); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .m-price { font-family: 'GeistMono', monospace; font-size: 12px; font-weight: 500; color: var(--text-high); text-align: right; }
        .m-meta { font-family: 'GeistMono', monospace; font-size: 11px; text-align: right; min-width: 50px; }
        .m-meta.up { color: var(--green); }
        .m-meta.down { color: var(--red); }
        .m-meta.flat { color: var(--text-low); }

        .fav-empty { font-family: 'GeistMono', monospace; font-size: 11px; color: var(--text-low); padding: 4px 0; }
      `}</style>
      <aside className="sidebar">
        <div className="sb-section">
          <div className="sb-head">
            <button
              type="button"
              className="sb-title"
              onClick={onCyclePeriod}
              title="Click to cycle 1h / 24h / 7d"
              aria-label={`Favorites period: ${period}. Click to cycle.`}
            >
              Favorites · <span className="period-tag">{period}</span>
            </button>
          </div>
          {favoriteRows.length === 0 ? (
            <div className="fav-empty">
              Tap the <span aria-hidden="true" style={{ verticalAlign: '-2px', display: 'inline-block', margin: '0 4px' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z"/></svg>
              </span> on any pair to add it here.
            </div>
          ) : (
            <div>
              {favoriteRows.map(({ pair, base, quote, price, change }) => {
                const isActive = base.assetId === currentBaseId && quote.assetId === currentQuoteId
                const isUsdPair = quote.isStablecoin
                const label = displayLabel(pairDisplay(base, quote))
                return (
                  <div
                    key={`${pair.baseId}-${pair.quoteId}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${label}`}
                    className={'market-row' + (isActive ? ' active' : '')}
                    onClick={() => onSelect(base.assetId, quote.assetId)}
                  >
                    <PairIcons base={base} quote={quote} isUsdPair={isUsdPair} size={22} />
                    <div className="m-sym">
                      {label}<small>{base.name ?? base.symbol}</small>
                    </div>
                    <div className="m-price">{price != null ? formatPrice(price, isUsdPair) : '—'}</div>
                    <div className={'m-meta ' + changeClass(change)}>{formatChange(change)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="sb-section scroll">
          <div className="sb-head">
            <button
              type="button"
              className="sb-title"
              onClick={onCyclePeriod}
              title="Click to cycle 1h / 24h / 7d"
              aria-label={`Top markets period: ${period}. Click to cycle.`}
            >
              Top markets · <span className="period-tag">{period}</span>
            </button>
          </div>
          <div>
            {topMarkets.length === 0 && <div style={{ fontFamily: "'GeistMono', monospace", fontSize: 11, color: 'var(--text-low)' }}>—</div>}
            {topMarkets.map(({ asset, stats }) => {
              const isActive = asset.assetId === currentBaseId && usdt && currentQuoteId === usdt.assetId
              const label = displayLabel(usdt ? pairDisplay(asset, usdt) : asset.symbol)
              return (
                <div
                  key={asset.assetId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${label}`}
                  className={'market-row' + (isActive ? ' active' : '')}
                  onClick={() => usdt && onSelect(asset.assetId, usdt.assetId)}
                >
                  {usdt && <PairIcons base={asset} quote={usdt} isUsdPair={true} size={22} />}
                  <div className="m-sym">
                    {label}<small>{asset.name ?? ''}</small>
                  </div>
                  <div className="m-price">{stats.price != null ? formatPrice(stats.price, false) : '—'}</div>
                  <div className={'m-meta ' + changeClass(changeForPeriod(stats, period))}>{formatChange(changeForPeriod(stats, period))}</div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="sb-section scroll">
          <div className="sb-head">
            <button
              type="button"
              className="sb-title"
              onClick={onCyclePeriod}
              title="Click to cycle 1h / 24h / 7d"
              aria-label={`Top movers period: ${period}. Click to cycle.`}
            >
              Top movers · <span className="period-tag">{period}</span>
            </button>
          </div>
          <div>
            {topMovers.length === 0 && <div style={{ fontFamily: "'GeistMono', monospace", fontSize: 11, color: 'var(--text-low)' }}>—</div>}
            {topMovers.map(({ asset, stats }) => {
              const isActive = asset.assetId === currentBaseId && usdt && currentQuoteId === usdt.assetId
              const label = displayLabel(usdt ? pairDisplay(asset, usdt) : asset.symbol)
              return (
                <div
                  key={asset.assetId}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${label}`}
                  className={'market-row' + (isActive ? ' active' : '')}
                  onClick={() => usdt && onSelect(asset.assetId, usdt.assetId)}
                >
                  {usdt && <PairIcons base={asset} quote={usdt} isUsdPair={true} size={22} />}
                  <div className="m-sym">
                    {label}<small>vol {formatCompactUsd(stats.volumeUsd24h)}</small>
                  </div>
                  <div></div>
                  <div className={'m-meta ' + changeClass(changeForPeriod(stats, period))}>{formatChange(changeForPeriod(stats, period))}</div>
                </div>
              )
            })}
          </div>
        </div>

        {!hideIndexer && (
          <div className="sb-section sb-indexer">
            <div className="sb-head">
              <span className="sb-title">Indexer</span>
              <span className="sb-tip">
                <span className="live-dot" style={{
                  background: indexerLive ? 'var(--green)' : 'var(--amber)',
                  boxShadow: `0 0 8px ${indexerLive ? 'var(--green)' : 'var(--amber)'}`,
                }} />
                #{blockHeight !== null ? blockHeight.toLocaleString() : '—'}
              </span>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
