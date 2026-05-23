import type { Asset, ApiCandle, AssetMarketStats, Period } from '../types'
import { formatPrice, formatChange, formatCompactUsd } from '../utils/format'
import PairIcons from './PairIcons'

interface HeroStatsProps {
  baseAsset: Asset | undefined
  quoteAsset: Asset | undefined
  candles: ApiCandle[]
  marketStats: AssetMarketStats[] | undefined
  period: Period
  onCyclePeriod: () => void
  isFavorite: boolean
  onToggleFavorite: () => void
}

interface Derived {
  price: number | null
  changeForPeriod: number | null
  high24h: number | null
  low24h: number | null
  volume24h: number
}

function deriveFromCandles(candles: ApiCandle[]): { price: number | null; high24h: number | null; low24h: number | null; volume24h: number; change24h: number | null } {
  if (candles.length === 0) return { price: null, high24h: null, low24h: null, volume24h: 0, change24h: null }
  const last = candles[candles.length - 1]
  const lastTs = last.intervalStart
  const cutoff = lastTs - 86_400  // 24h window ending at last candle
  const window = candles.filter(c => c.intervalStart >= cutoff)
  let high = -Infinity, low = Infinity, vol = 0
  for (const c of window) {
    if (c.high > high) high = c.high
    if (c.low < low) low = c.low
    vol += c.volumeTotal
  }
  // 24h change: compare last close to the earliest open within the 24h window.
  // If we have <2 buckets, fall back to (close-open) of the last candle.
  let change24h: number | null = null
  if (window.length >= 1) {
    const refOpen = window[0].open
    if (refOpen > 0) change24h = (last.close - refOpen) / refOpen
  }
  return {
    price: last.close,
    high24h: isFinite(high) ? high : null,
    low24h: isFinite(low) ? low : null,
    volume24h: vol,
    change24h,
  }
}

export default function HeroStats({ baseAsset, quoteAsset, candles, marketStats, period, onCyclePeriod, isFavorite, onToggleFavorite }: HeroStatsProps) {
  const fromCandles = deriveFromCandles(candles)

  const baseStats = marketStats?.find(s => s.assetId === baseAsset?.assetId)
  const quoteStats = marketStats?.find(s => s.assetId === quoteAsset?.assetId)
  const isUsdQuote = quoteAsset?.isStablecoin ?? false

  // Derive a cross-pair % change from the base/quote per-asset USD changes by
  // reconstructing each side's price at t-1h/24h/7d (price_then = price_now / (1 + change)).
  // For USD pairs the quote side is treated as constant.
  function changeFor(window: '1h' | '24h' | '7d'): number | null {
    if (!baseStats || !baseStats.price) return null
    const baseChange = window === '1h' ? baseStats.change1h : window === '7d' ? baseStats.change7d : baseStats.change24h
    if (baseChange == null) return null
    if (isUsdQuote) return baseChange
    if (!quoteStats || !quoteStats.price) return null
    const quoteChange = window === '1h' ? quoteStats.change1h : window === '7d' ? quoteStats.change7d : quoteStats.change24h
    if (quoteChange == null) return null
    const ratioNow = baseStats.price / quoteStats.price
    const baseThen = baseStats.price / (1 + baseChange)
    const quoteThen = quoteStats.price / (1 + quoteChange)
    if (quoteThen === 0) return null
    const ratioThen = baseThen / quoteThen
    if (ratioThen === 0) return null
    return ratioNow / ratioThen - 1
  }

  // Period-specific change for the chip. Prefer derived market-stats; fall back
  // to candle-derived 24h change if market-stats is still loading.
  let changeForPeriod: number | null = changeFor(period)
  if (changeForPeriod == null && period === '24h') {
    changeForPeriod = fromCandles.change24h
  }

  const derived: Derived = {
    price: fromCandles.price,
    changeForPeriod,
    high24h: fromCandles.high24h,
    low24h: fromCandles.low24h,
    volume24h: fromCandles.volume24h,
  }
  const change7dForStat = changeFor('7d')

  const quoteSymbol = quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.symbol ?? '')
  const baseSymbol = baseAsset?.symbol ?? '—'
  const baseName = baseAsset?.name ?? null
  const quoteName = quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.name ?? quoteSymbol)
  const subLine = baseName ? `${baseName} · ${quoteName}` : `${baseSymbol} · ${quoteName}`
  // Single concatenated label, matching the sidebar/picker convention.
  const pairLabel = quoteAsset?.isStablecoin ? baseSymbol : (baseSymbol + quoteSymbol)

  const changeCls = derived.changeForPeriod == null ? 'flat' : derived.changeForPeriod >= 0 ? 'up' : 'down'

  return (
    <>
      <style>{`
        .hero {
          display: grid;
          grid-template-columns: auto auto 1fr auto;
          align-items: center;
          gap: 18px;
          padding: 16px 20px 14px;
          border-bottom: 1px solid var(--separator);
        }
        .hero-fav-btn {
          width: 36px; height: 36px; border-radius: 9999px;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-medium); flex-shrink: 0;
          transition: color 120ms, background 120ms;
        }
        .hero-fav-btn:hover { color: var(--amber); background: var(--panel-hover); }
        .hero-fav-btn.on { color: var(--amber); }
        .hero-fav-btn svg { width: 18px; height: 18px; }
        .hero-pair-wrap { display: flex; align-items: center; gap: 14px; min-width: 0; }
        .hero-pair { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .hero-pair .label { font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-low); }
        .hero-pair .name { font-family: 'Gazpacho', serif; font-weight: 500; font-size: 32px; line-height: 1; letter-spacing: -0.02em; color: var(--text-high); }
        .hero-pair .sub { font-size: 12px; color: var(--text-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .hero-price { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
        .hero-price .num { font-family: 'GeistMono', monospace; font-weight: 500; font-size: 30px; line-height: 1; letter-spacing: -0.02em; color: var(--text-high); white-space: nowrap; }
        .hero-price .num .ccy { font-family: 'GeistMono', monospace; font-size: 16px; color: var(--text-medium); margin-left: 8px; }
        .change-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 9999px; font-family: 'GeistMono', monospace; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; user-select: none; transition: filter 120ms; border: 1px solid transparent; }
        .change-chip:hover { filter: brightness(1.1); }
        .change-chip.up { color: var(--green); background: var(--green-soft); }
        .change-chip.down { color: var(--red); background: var(--red-soft); }
        .change-chip.flat { color: var(--text-low); background: var(--panel); }

        .hero-stats { display: grid; grid-auto-flow: column; column-gap: 22px; align-items: end; }
        .stat { display: flex; flex-direction: column; gap: 3px; }
        .stat .k { font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-low); }
        .stat .v { font-family: 'GeistMono', monospace; font-size: 13px; font-weight: 500; color: var(--text-high); }
        .stat .v.up { color: var(--green); }
        .stat .v.down { color: var(--red); }
        .stat .v.flat { color: var(--text-low); }

        @media (max-width: 980px) {
          .hero { grid-template-columns: 1fr; gap: 10px; padding: 12px 14px; }
          /* All four stat tiles (24h H / 24h L / 24h Vol / 7d) in a single row on mobile */
          .hero-stats { grid-auto-flow: row; grid-template-columns: repeat(4, 1fr); column-gap: 12px; row-gap: 10px; }
          /* The pair name + icons + favorite are surfaced in the topbar on mobile;
             hide them in the hero so the price gets all the room. */
          .hero-pair-wrap, .hero-fav-btn { display: none !important; }
          .hero-price { gap: 10px; }
          .hero-price .num { font-size: 26px; }
          .hero-price .num .ccy { font-size: 13px; margin-left: 6px; }
        }
        @media (max-width: 520px) {
          .stat .v { font-size: 12px; }
          .stat .k { font-size: 9px; letter-spacing: 0.1em; }
          .hero-stats { column-gap: 8px; }
          .hero-price .num { font-size: 22px; }
        }
      `}</style>
      <div className="hero">
        <div className="hero-pair-wrap">
          {baseAsset && quoteAsset && <PairIcons base={baseAsset} quote={quoteAsset} isUsdPair={isUsdQuote} size={36} />}
          <div className="hero-pair">
            <span className="label">Trading pair</span>
            <h1 className="name">{pairLabel}</h1>
            <span className="sub">{subLine}</span>
          </div>
        </div>

        <button
          type="button"
          className={'hero-fav-btn' + (isFavorite ? ' on' : '')}
          onClick={onToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Remove ${baseSymbol}/${quoteSymbol} from favorites` : `Add ${baseSymbol}/${quoteSymbol} to favorites`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          {isFavorite
            ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z"/></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z"/></svg>}
        </button>

        <div className="hero-price">
          <span className="num">
            {derived.price != null ? formatPrice(derived.price, false) : '—'}
            <span className="ccy">{quoteSymbol}</span>
          </span>
          <button
            type="button"
            className={`change-chip ${changeCls}`}
            onClick={onCyclePeriod}
            aria-label={`Toggle change period (current: ${period})`}
            title="Click to cycle 1h / 24h / 7d"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              {derived.changeForPeriod !== null && derived.changeForPeriod >= 0
                ? <polyline points="6 15 12 9 18 15"/>
                : <polyline points="6 9 12 15 18 9"/>}
            </svg>
            {formatChange(derived.changeForPeriod)} · {period.toUpperCase()}
          </button>
        </div>

        <div className="hero-stats">
          <div className="stat"><span className="k">24h High</span><span className="v">{derived.high24h != null ? formatPrice(derived.high24h, false) : '—'}</span></div>
          <div className="stat"><span className="k">24h Low</span><span className="v">{derived.low24h != null ? formatPrice(derived.low24h, false) : '—'}</span></div>
          <div className="stat"><span className="k">24h Vol</span><span className="v">{derived.volume24h > 0 ? formatCompactUsd(derived.volume24h) : '—'}</span></div>
          <div className="stat">
            <span className="k">7d</span>
            <span className={`v ${change7dForStat == null ? 'flat' : change7dForStat >= 0 ? 'up' : 'down'}`}>
              {change7dForStat != null ? formatChange(change7dForStat) : '—'}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
