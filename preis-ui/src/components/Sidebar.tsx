import { useMemo, type KeyboardEvent } from 'react'
import type { Asset, AssetMarketStats, Period } from '../types'
import PairIcons from './PairIcons'
import { formatPrice, formatChange } from '../utils/format'
import { changeForPeriod, changeTone, crossChange } from '../utils/change'
import { useStatsById } from '../hooks/useStatsById'
import { displayLabel, pairDisplay } from '../utils/pairs'
import FavoriteStar from './FavoriteStar'

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

interface Row {
  asset: Asset
  stats: AssetMarketStats
}

function activateOnKeyboard(event: KeyboardEvent<HTMLElement>, activate: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate()
}

function RankedMarketsSection({ title, rows, quote, currentBaseId, currentQuoteId, period, onCyclePeriod, onSelect }: {
  title: string
  rows: Row[]
  quote: Asset | undefined
  currentBaseId: number
  currentQuoteId: number
  period: Period
  onCyclePeriod: () => void
  onSelect: (baseId: number, quoteId: number) => void
}) {
  return (
    <div className="sb-section scroll">
      <div className="sb-head">
        <button
          type="button"
          className="sb-title"
          onClick={onCyclePeriod}
          title="Click to cycle 1h / 24h / 7d"
          aria-label={`${title} period: ${period}. Click to cycle.`}
        >
          {title} · <span className="period-tag">{period}</span>
        </button>
      </div>
      <div>
        {rows.length === 0 && <div style={{ fontFamily: "'GeistMono', monospace", fontSize: 11, color: 'var(--text-low)' }}>—</div>}
        {rows.map(({ asset, stats }) => {
          const isActive = asset.assetId === currentBaseId && quote != null && currentQuoteId === quote.assetId
          const label = displayLabel(quote ? pairDisplay(asset, quote) : asset.symbol)
          const change = changeForPeriod(stats, period)
          const select = () => { if (quote) onSelect(asset.assetId, quote.assetId) }
          return (
            <div
              key={asset.assetId}
              role="button"
              tabIndex={0}
              aria-label={`Select ${label}`}
              className={'market-row' + (isActive ? ' active' : '')}
              onClick={select}
              onKeyDown={event => activateOnKeyboard(event, select)}
            >
              {quote && <PairIcons base={asset} quote={quote} isUsdPair size={22} />}
              <div className="m-sym">{label}<small>{asset.name ?? ''}</small></div>
              <div className="m-price">{stats.price != null ? formatPrice(stats.price, false) : '—'}</div>
              <div className={'m-meta ' + changeTone(change)}>{formatChange(change)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
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
  const statsById = useStatsById(marketStats)

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
      // A stablecoin quote is not automatically a dollar one: EURC tracks the
      // euro, so a EURC-quoted favorite is a real cross pair and shows the
      // base/quote ratio, not the base's USD price.
      const isUsdPair = quote.isUsdPegged ?? false
      let price: number | null = null
      if (isUsdPair) price = bs?.price ?? null
      else if (bs?.price && qs?.price) price = bs.price / qs.price
      // A pair's change is the change of its ratio, derived from both legs'
      // USD change; the base's change alone is not the pair's change.
      const change = crossChange(bs, qs, period, isUsdPair)
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
        .sb-section.sb-indexer { height: var(--status-strip-h); padding: 12px 20px; border-bottom: none; border-top: 1px solid var(--separator); margin-top: auto; }
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
        .market-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        .market-row:active { transform: translateX(1px) scale(0.995); }
        /* The tinted row already marks the selection — the symbol keeps the
           full-contrast text color so it stays the most readable row. */
        .market-row.active { background: var(--accent-soft); }
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
                <FavoriteStar selected={false} size={11} />
              </span> on any pair to add it here.
            </div>
          ) : (
            <div>
              {favoriteRows.map(({ pair, base, quote, price, change }) => {
                const isActive = base.assetId === currentBaseId && quote.assetId === currentQuoteId
                const isUsdPair = quote.isUsdPegged ?? false
                const label = displayLabel(pairDisplay(base, quote))
                return (
                  <div
                    key={`${pair.baseId}-${pair.quoteId}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${label}`}
                    className={'market-row' + (isActive ? ' active' : '')}
                    onClick={() => onSelect(base.assetId, quote.assetId)}
                    onKeyDown={event => activateOnKeyboard(event, () => onSelect(base.assetId, quote.assetId))}
                  >
                    <PairIcons base={base} quote={quote} isUsdPair={isUsdPair} size={22} />
                    <div className="m-sym">
                      {label}<small>{base.name ?? base.symbol}</small>
                    </div>
                    <div className="m-price">{price != null ? formatPrice(price, isUsdPair) : '—'}</div>
                    <div className={'m-meta ' + changeTone(change)}>{formatChange(change)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <RankedMarketsSection title="Top markets" rows={topMarkets} quote={usdt} currentBaseId={currentBaseId} currentQuoteId={currentQuoteId} period={period} onCyclePeriod={onCyclePeriod} onSelect={onSelect} />
        <RankedMarketsSection title="Top movers" rows={topMovers} quote={usdt} currentBaseId={currentBaseId} currentQuoteId={currentQuoteId} period={period} onCyclePeriod={onCyclePeriod} onSelect={onSelect} />

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
