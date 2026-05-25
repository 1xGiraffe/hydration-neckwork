import { useEffect, useRef, useState } from 'react'
import type { Asset, ApiCandle, AssetMarketStats, Period } from '../types'
import { formatPrice, formatChange } from '../utils/format'
import PairIcons from './PairIcons'

interface ChartHeaderProps {
  baseAsset: Asset | undefined
  quoteAsset: Asset | undefined
  candles: ApiCandle[]
  marketStats: AssetMarketStats[] | undefined
  period: Period
  onCyclePeriod: () => void
  isFavorite: boolean
  onToggleFavorite: () => void
}

function deriveFromCandles(candles: ApiCandle[]): { price: number | null; change24h: number | null } {
  if (candles.length === 0) return { price: null, change24h: null }
  const last = candles[candles.length - 1]
  const cutoff = last.intervalStart - 86_400
  const window = candles.filter(c => c.intervalStart >= cutoff)
  const refOpen = window[0]?.open ?? last.open
  return {
    price: last.close,
    change24h: refOpen > 0 ? (last.close - refOpen) / refOpen : null,
  }
}

function useValueFlash(value: number | null): string {
  const previousRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const [flash, setFlash] = useState('')

  useEffect(() => {
    if (value == null) {
      previousRef.current = value
      return
    }
    const previous = previousRef.current
    previousRef.current = value
    if (previous == null || previous === value) return

    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
    const nextFlash = value > previous ? 'flash-up' : value < previous ? 'flash-down' : 'flash-flat'
    frameRef.current = window.requestAnimationFrame(() => {
      setFlash(nextFlash)
      frameRef.current = null
      timerRef.current = window.setTimeout(() => {
        setFlash('')
        timerRef.current = null
      }, 650)
    })

    return () => {
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [value])

  useEffect(() => {
    return () => {
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  return flash
}

export default function ChartHeader({ baseAsset, quoteAsset, candles, marketStats, period, onCyclePeriod, isFavorite, onToggleFavorite }: ChartHeaderProps) {
  const fromCandles = deriveFromCandles(candles)

  const baseStats = marketStats?.find(s => s.assetId === baseAsset?.assetId)
  const quoteStats = marketStats?.find(s => s.assetId === quoteAsset?.assetId)
  const isUsdQuote = quoteAsset?.isStablecoin ?? false

  function changeFor(window: '1h' | '24h' | '7d'): number | null {
    if (!baseStats || !baseStats.price) return null
    const baseChange = window === '1h' ? baseStats.change1h : window === '7d' ? baseStats.change7d : baseStats.change24h
    if (baseChange == null) return null
    if (isUsdQuote) return baseChange
    if (!quoteStats || !quoteStats.price) return null
    const quoteChange = window === '1h' ? quoteStats.change1h : window === '7d' ? quoteStats.change7d : quoteStats.change24h
    if (quoteChange == null) return null
    const baseThen = baseStats.price / (1 + baseChange)
    const quoteThen = quoteStats.price / (1 + quoteChange)
    if (quoteThen === 0) return null
    const ratioNow = baseStats.price / quoteStats.price
    const ratioThen = baseThen / quoteThen
    return ratioThen === 0 ? null : ratioNow / ratioThen - 1
  }

  let changeForPeriod = changeFor(period)
  if (changeForPeriod == null && period === '24h') {
    changeForPeriod = fromCandles.change24h
  }

  const priceFlash = useValueFlash(fromCandles.price)
  const changeFlash = useValueFlash(changeForPeriod)

  const quoteSymbol = quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.symbol ?? '')
  const baseSymbol = baseAsset?.symbol ?? '-'
  const baseName = baseAsset?.name ?? null
  const quoteName = quoteAsset?.isStablecoin ? 'USD' : (quoteAsset?.name ?? quoteSymbol)
  const subLine = baseName ? `${baseName} / ${quoteName}` : `${baseSymbol} / ${quoteName}`
  const pairLabel = quoteAsset?.isStablecoin ? baseSymbol : (baseSymbol + quoteSymbol)
  const changeCls = changeForPeriod == null ? 'flat' : changeForPeriod >= 0 ? 'up' : 'down'

  return (
    <>
      <style>{`
        .chart-head {
          display: grid;
          grid-template-columns: auto auto 1fr;
          align-items: center;
          gap: 18px;
          padding: 16px 20px 14px;
          border-bottom: 1px solid var(--separator);
        }
        .chart-head-fav {
          width: 36px; height: 36px; border-radius: 9999px;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--text-medium); flex-shrink: 0;
          transition: color 140ms, background 140ms, transform 140ms var(--ease-out-soft);
        }
        .chart-head-fav:active { transform: scale(0.94); }
        .chart-head-fav:hover { color: var(--amber); background: var(--panel-hover); }
        .chart-head-fav.on { color: var(--amber); }
        .chart-head-fav svg { width: 18px; height: 18px; transition: transform 160ms var(--ease-out-soft); }
        .chart-head-fav.on svg { animation: preis-favorite-pop 220ms var(--ease-out-soft); }
        .chart-head-pair-wrap { display: flex; align-items: center; gap: 14px; min-width: 0; }
        .chart-head-pair { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .chart-head-pair .label { font-family: 'GeistMono', monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; color: var(--text-low); }
        .chart-head-pair .name { font-family: 'Gazpacho', serif; font-weight: 500; font-size: 32px; line-height: 1; color: var(--text-high); }
        .chart-head-pair .sub { font-size: 12px; color: var(--text-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .chart-head-price { display: flex; align-items: baseline; justify-self: start; gap: 12px; min-width: 0; }
        .chart-head-price .num { font-family: 'GeistMono', monospace; font-weight: 500; font-size: 30px; line-height: 1; color: var(--text-high); white-space: nowrap; }
        .chart-head-price .num .ccy { font-family: 'GeistMono', monospace; font-size: 16px; color: var(--text-medium); margin-left: 8px; }
        .value-flash { display: inline-block; border-radius: 6px; padding: 2px 4px; margin: -2px -4px; }
        .value-flash.flash-up { animation: preis-value-up 650ms ease-out; }
        .value-flash.flash-down { animation: preis-value-down 650ms ease-out; }
        .value-flash.flash-flat { animation: preis-value-flat 650ms ease-out; }
        .change-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 9999px; font-family: 'GeistMono', monospace; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; user-select: none; transition: filter 140ms, transform 140ms var(--ease-out-soft); border: 1px solid transparent; }
        .change-chip:hover { filter: brightness(1.1); transform: translateY(-1px); }
        .change-chip:active { transform: translateY(0) scale(0.98); }
        .change-chip.flash-up { animation: preis-value-up 650ms ease-out; }
        .change-chip.flash-down { animation: preis-value-down 650ms ease-out; }
        .change-chip.flash-flat { animation: preis-value-flat 650ms ease-out; }
        .change-chip.up { color: var(--green); background: var(--green-soft); }
        .change-chip.down { color: var(--red); background: var(--red-soft); }
        .change-chip.flat { color: var(--text-low); background: var(--panel); }

        @media (max-width: 980px) {
          .chart-head { grid-template-columns: 1fr; gap: 10px; padding: 12px 14px; }
          .chart-head-pair-wrap, .chart-head-fav { display: none !important; }
          .chart-head-price { gap: 10px; }
          .chart-head-price .num { font-size: 26px; }
          .chart-head-price .num .ccy { font-size: 13px; margin-left: 6px; }
        }
        @media (max-width: 520px) {
          .chart-head-price .num { font-size: 22px; }
        }
      `}</style>
      <div className="chart-head">
        <div className="chart-head-pair-wrap">
          {baseAsset && quoteAsset && <PairIcons base={baseAsset} quote={quoteAsset} isUsdPair={isUsdQuote} size={36} />}
          <div className="chart-head-pair">
            <span className="label">Trading pair</span>
            <h1 className="name">{pairLabel}</h1>
            <span className="sub">{subLine}</span>
          </div>
        </div>

        <button
          type="button"
          className={'chart-head-fav' + (isFavorite ? ' on' : '')}
          onClick={onToggleFavorite}
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Remove ${baseSymbol}/${quoteSymbol} from favorites` : `Add ${baseSymbol}/${quoteSymbol} to favorites`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          {isFavorite
            ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z"/></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 2.5l2.96 6.36 7.04.71-5.2 4.75 1.42 6.93L12 17.77l-6.22 3.48 1.42-6.93L2 9.57l7.04-.71L12 2.5z"/></svg>}
        </button>

        <div className="chart-head-price">
          <span className={`num value-flash ${priceFlash}`}>
            {fromCandles.price != null ? formatPrice(fromCandles.price, false) : '-'}
            <span className="ccy">{quoteSymbol}</span>
          </span>
          <button
            type="button"
            className={`change-chip ${changeCls} ${changeFlash}`}
            onClick={onCyclePeriod}
            aria-label={`Toggle change period (current: ${period})`}
            title="Click to cycle 1h / 24h / 7d"
          >
            {formatChange(changeForPeriod)} / {period.toUpperCase()}
          </button>
        </div>
      </div>
    </>
  )
}
