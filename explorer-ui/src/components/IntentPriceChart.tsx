import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/explorer'
import { AssetIcon } from './ui'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { limitBinding } from '../utils/limitBinding'
import {
  CHART_INTERVALS, INTERVAL_COUNT, INTERVAL_LABEL, INTERVAL_SECONDS, chartOrientation, chartTimeframe, feeAdjustedLimit, fillPoints, measuredFee, placementRead, priceRange,
  type ChartInterval,
} from '../utils/intentChart'
import type { IntentOrderDetail } from '../types'

// A limit order (or a DCA intent's per-trade limit) drawn against its market: the
// pair's candles, quoted the way a reader would say the price, with the order's
// line across them and its fills where they happened. The grid starts as fine as
// the limit is close to market, so the line sits inside the candles around it.

// Drawn in viewBox units that track the screen: a phone gets a narrower, taller box
// rather than the desktop one shrunk to 45 %, which would take the text with it.
const WIDE = { W: 820, H: 280, PAD_R: 76, PAD_T: 30, xTicks: [0, 0.25, 0.5, 0.75] }
// A phone's legend can wrap to two lines, so it gets more room above the plot.
const NARROW = { W: 400, H: 320, PAD_R: 64, PAD_T: 50, xTicks: [0, 0.5] }
// The top pad (per layout) keeps the OHLC legend row clear of the tallest candle.
const PAD_L = 8, PAD_B = 24

function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return v.toLocaleString('en-US', { maximumSignificantDigits: 5 })
}
function fmtTime(sec: number, interval: ChartInterval): string {
  const iso = new Date(sec * 1000).toISOString()
  return interval === '1d' || interval === '1w' ? iso.slice(0, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

export function IntentPriceChart({ data }: { data: IntentOrderDetail }) {
  const o = useMemo(() => chartOrientation(data), [data])
  const auto = useMemo(() => chartTimeframe(data.limitMarketRatio), [data.limitMarketRatio])
  const [picked, setPicked] = useState<ChartInterval | null>(null)
  const interval = picked ?? auto.interval
  const count = picked ? INTERVAL_COUNT[picked] : auto.count
  const chart = useQuery({
    queryKey: ['pair-chart', o.base.assetId, o.quote.assetId, interval, count],
    queryFn: ({ signal }) => api.pairChart(o.base.assetId, o.quote.assetId, interval, count, signal),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const narrow = useMediaQuery('(max-width: 720px)')
  const { W, H, PAD_R, PAD_T, xTicks: X_TICKS } = narrow ? NARROW : WIDE
  const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B
  const binding = limitBinding(data.limitMarketRatio)

  const candles = chart.data?.candles ?? []
  const fills = useMemo(() => fillPoints(data.fills, o), [data.fills, o])
  // The candles are the price before fees; the limit and the fills are after them. So
  // the line is drawn where the MARKET must be for the order to fill — the limit less
  // the fee its own fills paid over the candles — and the stated limit stays a faint
  // rule beside it (the fills sit on that one).
  // An order with fills is measured by them; one without by its pair's recent trades
  // (the same measure, served with the candles).
  const fillFee = useMemo(() => measuredFee(o, fills, candles, INTERVAL_SECONDS[interval]), [o, fills, candles, interval])
  const pairFee = chart.data?.tradeFee ?? null
  const fee = fillFee ?? pairFee?.fee ?? null
  const feeSource = fillFee != null ? 'its fills paid' : pairFee ? `recent ${o.base.symbol}/${o.quote.symbol} trades paid` : ''
  // A limit the market already met when the order was placed is a minimum received
  // (the app's slippage guard), not a price waiting to be reached. The first fill is
  // only known when every fill is on the page.
  const placement = useMemo(() => {
    const placedSec = Date.parse(`${data.order.timestamp.replace(' ', 'T')}Z`) / 1000
    const firstFill = data.fills.length === data.fillsTotal && fills.length ? Math.min(...fills.map(f => f.t)) : null
    // Judged on the limit NET of the fee: a limit a fee's width from market is a
    // resting order at market, not a minimum received.
    return placementRead({ ...o, limit: feeAdjustedLimit(o, fee) }, candles, INTERVAL_SECONDS[interval], placedSec, firstFill)
  }, [o, fee, candles, interval, data.order.timestamp, data.fills.length, data.fillsTotal, fills])
  // A minimum received (the market already met it at placement) is a guard, not a
  // price the market must reach — its fills ran at market, so a fee gap to the candles
  // says nothing and the guard is drawn as stated.
  const lineFee = placement.marketable ? null : fee
  const ol = useMemo(() => ({ ...o, limit: feeAdjustedLimit(o, lineFee) }), [o, lineFee])
  const geo = useMemo(() => {
    if (!candles.length) return null
    const step = INTERVAL_SECONDS[interval]
    const t0 = candles[0].t, t1 = candles[candles.length - 1].t + step
    // A minimum received never stretches the scale: the candles keep their detail and
    // a guard outside their range is marked on the plot's edge instead.
    // Fills are real traded prices (fee included), so they belong on the scale too.
    const fillPrices = fills.filter(f => f.t >= t0 && f.t <= t1).map(f => f.price)
    const range = priceRange([...candles.map(c => c.l), ...fillPrices], [...candles.map(c => c.h), ...fillPrices], placement.marketable ? null : ol.limit)
    if (placement.marketable && ol.limit != null && (ol.limit < range.lo || ol.limit > range.hi)) {
      range.limitOffscale = ol.limit > range.hi ? 'above' : 'below'
    }
    const x = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * PLOT_W
    const y = (p: number) => PAD_T + (1 - (p - range.lo) / (range.hi - range.lo)) * PLOT_H
    const slot = PLOT_W / ((t1 - t0) / step)
    const ticks = Array.from({ length: 5 }, (_, i) => range.lo + ((range.hi - range.lo) * (i + 0.5)) / 5)
    const xTicks = X_TICKS.map(f => candles[Math.min(candles.length - 1, Math.floor(f * candles.length))].t)
    return { step, t0, t1, range, x, y, slot, ticks, xTicks }
  }, [candles, fills, interval, ol.limit, placement.marketable, PLOT_W, PLOT_H, PAD_T, X_TICKS])

  const last = candles.at(-1)
  const distance = ol.limit != null && last ? (ol.limit / last.c - 1) * 100 : null
  const legendCandle = (hover != null ? candles[hover] : null) ?? last ?? null
  const pair = `${o.quote.symbol} per ${o.base.symbol}`
  const fillSide = o.fillsWhen === 'above' ? 'at or above' : 'at or below'

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo || !svgRef.current) return
    const r = svgRef.current.getBoundingClientRect()
    const vx = ((e.clientX - r.left) / r.width) * W
    const i = Math.floor(((vx - PAD_L) / PLOT_W) * ((geo.t1 - geo.t0) / geo.step))
    setHover(i >= 0 && i < candles.length ? i : null)
  }

  return (
    <div className="detail-card ipc">
      <div className="ipc-head">
        <div className="ipc-pair">
          <AssetIcon {...o.base} size={18} /><AssetIcon {...o.quote} size={18} />
          <span className="ipc-title">{o.base.symbol} / {o.quote.symbol}</span>
          {last && <span className="mono ipc-last">{fmtPrice(last.c)} <span className="muted">{pair}</span></span>}
        </div>
        <div className="seg-bar ipc-seg" role="group" aria-label="Candle size">
          {CHART_INTERVALS.map(iv => (
            <button key={iv} type="button" aria-pressed={interval === iv} className={`seg-btn${interval === iv ? ' active' : ''}`}
              onClick={() => setPicked(iv === auto.interval ? null : iv)} title={iv === auto.interval ? 'Picked for how far the limit is from the price' : undefined}>
              {INTERVAL_LABEL[iv]}{iv === auto.interval && <span className="ipc-auto" aria-hidden="true">•</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="ipc-sub muted">
        {ol.limit != null && placement.marketable
          ? <>{o.fillsWhen === 'above' ? 'Minimum received' : 'Maximum paid'} <span className="mono ipc-limit-v">{fmtPrice(ol.limit)}</span> {pair}
            {placement.distancePct != null && <> · <span className="mono">{Math.abs(placement.distancePct).toFixed(2)}%</span> {placement.distancePct < 0 ? 'under' : 'over'} the price when placed</>}
            {' · '}{data.fillsTotal > 0 ? 'filled at market' : 'fills at market'}
</>
          : ol.limit != null
          ? <>Fills {fillSide} <span className="mono ipc-limit-v">{fmtPrice(ol.limit)}</span> {pair}
            {lineFee != null && o.limit != null && <span> (limit {fmtPrice(o.limit)}, less the <span className="mono">{(lineFee * 100).toFixed(lineFee < 0.001 ? 3 : 2)}%</span> fee {feeSource})</span>}
            {distance != null && <> · <span className="mono">{distance >= 0 ? '+' : ''}{distance.toFixed(Math.abs(distance) < 10 ? 2 : 0)}%</span> from the price</>}
            {binding && <> · <span className={`limit-flag limit-flag-${binding.kind}`} title={binding.title}>{binding.label}</span></>}
            {data.order.kind === 'dca' && !binding && <> · the limit binds each period’s trade</>}</>
          : <>This order states no price limit.</>}
      </div>
      <div className="ipc-plot">
        {chart.isLoading ? <div className="ipc-empty muted">Loading candles…</div>
          : chart.isError ? <div className="ipc-empty muted">Candles are unavailable right now.</div>
            : !geo ? <div className="ipc-empty muted">No price history for {o.base.symbol} in {o.quote.symbol} over this span.</div>
              : (
                <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="ipc-svg" role="img"
                  aria-label={`${o.base.symbol} in ${o.quote.symbol}, ${INTERVAL_LABEL[interval]} candles, with the order's limit`}
                  onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
                  {geo.ticks.map(p => {
                    // An axis label the limit's or the price's own tag would sit on is dropped.
                    const taken = [ol.limit != null && !geo.range.limitOffscale ? ol.limit : null, last?.c ?? null, geo.range.limitOffscale && placement.marketable ? (geo.range.limitOffscale === 'above' ? geo.range.hi : geo.range.lo) : null]
                      .some(v => v != null && Math.abs(geo.y(v) - geo.y(p)) < 16)
                    return (
                      <g key={p}>
                        <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={geo.y(p)} y2={geo.y(p)} className="ipc-grid" />
                        {!taken && <text x={W - PAD_R + 6} y={geo.y(p) + 3.5} className="ipc-axis">{fmtPrice(p)}</text>}
                      </g>
                    )
                  })}
                  {ol.limit != null && !geo.range.limitOffscale && (() => {
                    // The side of the line the order fills on, shaded: a buy's maximum paid
                    // fills anywhere below it, a sale's minimum received anywhere above.
                    const ly = geo.y(ol.limit), below = o.fillsWhen === 'below'
                    const y0 = below ? ly : PAD_T, y1 = below ? PAD_T + PLOT_H : ly
                    return (
                      <g className="ipc-zone">
                        {y1 > y0 && <rect x={PAD_L} y={y0} width={PLOT_W} height={y1 - y0} />}
                        <text x={PAD_L + 4} y={below ? ly + 13 : ly - 6}>{below ? 'fills below ↓' : 'fills above ↑'}</text>
                      </g>
                    )
                  })()}
                  {geo.xTicks.map(t => <text key={t} x={geo.x(t)} y={H - 7} className="ipc-axis">{fmtTime(t, interval)}</text>)}
                  {candles.map((c, i) => {
                    const up = c.c >= c.o
                    const cx = geo.x(c.t) + geo.slot / 2
                    const bw = Math.max(1, geo.slot * 0.62)
                    const top = geo.y(Math.max(c.o, c.c)), bot = geo.y(Math.min(c.o, c.c))
                    return (
                      <g key={c.t} className={up ? 'ipc-up' : 'ipc-down'} opacity={hover == null || hover === i ? 1 : 0.55}>
                        <line x1={cx} x2={cx} y1={geo.y(c.h)} y2={geo.y(c.l)} className="ipc-wick" />
                        <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} className="ipc-body" />
                      </g>
                    )
                  })}
                  {hover != null && candles[hover] && (
                    <line className="ipc-cross" x1={geo.x(candles[hover].t) + geo.slot / 2} x2={geo.x(candles[hover].t) + geo.slot / 2} y1={PAD_T} y2={PAD_T + PLOT_H} />
                  )}
                  {fills.filter(f => f.t >= geo.t0 && f.t <= geo.t1 && f.price >= geo.range.lo && f.price <= geo.range.hi).map((f, i) => (
                    <circle key={`${f.t}-${i}`} cx={geo.x(f.t)} cy={geo.y(f.price)} r={4} className="ipc-fill">
                      <title>Fill at {fmtPrice(f.price)} {pair}</title>
                    </circle>
                  ))}
                  {lineFee != null && o.limit != null && o.limit >= geo.range.lo && o.limit <= geo.range.hi && (
                    <line className="ipc-limit-stated" x1={PAD_L} x2={PAD_L + PLOT_W} y1={geo.y(o.limit)} y2={geo.y(o.limit)}>
                      <title>Stated limit {fmtPrice(o.limit)} {pair} (fee included)</title>
                    </line>
                  )}
                  {ol.limit != null && !geo.range.limitOffscale && (
                    <g className="ipc-limit">
                      <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={geo.y(ol.limit)} y2={geo.y(ol.limit)} />
                      <rect x={W - PAD_R + 2} y={geo.y(ol.limit) - 9} width={PAD_R - 4} height={18} rx={4} />
                      <text x={W - PAD_R + 6} y={geo.y(ol.limit) + 3.5}>{fmtPrice(ol.limit)}</text>
                    </g>
                  )}
                  {ol.limit != null && geo.range.limitOffscale && placement.marketable && (() => {
                    // The guard on the plot's edge, on the side it lies: a dashed rule
                    // along the edge and its tag, pointing out to where it sits.
                    const edgeY = geo.range.limitOffscale === 'above' ? PAD_T : PAD_T + PLOT_H
                    const arrow = geo.range.limitOffscale === 'above' ? '↑' : '↓'
                    return (
                      <g className="ipc-limit ipc-limit-edge">
                        <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={edgeY} y2={edgeY} />
                        <rect x={W - PAD_R + 2} y={edgeY - 9} width={PAD_R - 4} height={18} rx={4} />
                        <text x={W - PAD_R + 6} y={edgeY + 3.5}>{arrow} {fmtPrice(ol.limit!)}</text>
                        <text className="ipc-edge-note" x={PAD_L + PLOT_W - 4} y={geo.range.limitOffscale === 'above' ? edgeY + 13 : edgeY - 6} textAnchor="end">
                          {o.fillsWhen === 'above' ? 'minimum received' : 'maximum paid'} {arrow} {geo.range.limitOffscale} this scale
                        </text>
                      </g>
                    )
                  })()}
                  {ol.limit != null && geo.range.limitOffscale && !placement.marketable && (
                    <g className="ipc-limit ipc-limit-off">
                      <text x={PAD_L + PLOT_W - 4} y={geo.range.limitOffscale === 'above' ? PAD_T + 12 : PAD_T + PLOT_H - 6} textAnchor="end">
                        {geo.range.limitOffscale === 'above' ? '↑' : '↓'} limit {fmtPrice(ol.limit)} — off this scale
                      </text>
                    </g>
                  )}
                  {last && (
                    <g className="ipc-now">
                      <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={geo.y(last.c)} y2={geo.y(last.c)} />
                      <rect x={W - PAD_R + 2} y={geo.y(last.c) - 9} width={PAD_R - 4} height={18} rx={4} />
                      <text x={W - PAD_R + 6} y={geo.y(last.c) + 3.5}>{fmtPrice(last.c)}</text>
                    </g>
                  )}
                </svg>
              )}
        {/* The preis chart's legend: the hovered candle, else the latest — a plain row
            over the plot, never a floating box that the edge of the chart can clip. */}
        {geo && legendCandle && (
          <div className="ipc-ohlc mono" aria-live="off">
            <span className="muted">{fmtTime(legendCandle.t, interval)}</span>
            <span><span className="k">O</span>{fmtPrice(legendCandle.o)}</span>
            <span><span className="k">H</span>{fmtPrice(legendCandle.h)}</span>
            <span><span className="k">L</span>{fmtPrice(legendCandle.l)}</span>
            <span className={legendCandle.c >= legendCandle.o ? 'ipc-c-up' : 'ipc-c-down'}><span className="k">C</span>{fmtPrice(legendCandle.c)}
              {' '}({legendCandle.c >= legendCandle.o ? '+' : ''}{((legendCandle.c / legendCandle.o - 1) * 100).toFixed(2)}%)</span>
          </div>
        )}
      </div>
      <div className="ipc-legend muted">
        <span><i className="ipc-key ipc-key-limit" />{lineFee != null ? 'Fills at (net of fees)' : placement.marketable ? (o.fillsWhen === 'above' ? 'Minimum received' : 'Maximum paid') : 'Limit'}</span>
        {ol.limit != null && <span><i className="ipc-key ipc-key-zone" />Fills {o.fillsWhen === 'above' ? 'above' : 'below'} the line</span>}
        {lineFee != null && <span><i className="ipc-key ipc-key-stated" />Stated limit (fees included)</span>}
        <span><i className="ipc-key ipc-key-now" />Price now</span>
        {fills.length > 0 && <span><i className="ipc-key ipc-key-fill" />Fills</span>}
        {(chart.data?.baseSeries !== o.base.assetId || chart.data?.quoteSeries !== o.quote.assetId) && chart.data && (
          <span title="An aToken or pool share is priced through the asset it is 1:1 with">priced through its underlying</span>
        )}
      </div>
    </div>
  )
}
