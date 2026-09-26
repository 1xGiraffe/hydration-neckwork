import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetIcon, F } from '../ui'
import type { ChartMarker } from '../ui'
import { paths } from '../../router'
import { positionsApi } from '../../api/explorer'
import { blockRangeForWindow } from '../../utils/chartRefine'
import { ChartLegend, MultiLineChart } from '../HdxCharts'
import type { ChartZone, RefinedGrid } from '../HdxCharts'
import type { AssetRef, MoneyMarketHistory, MoneyMarketHistoryMarket, MoneyMarketLiquidation } from '../../types'
import { HF_CAP, exposureLines, healthFactorLines, marketSeries, windowedMarketSeries } from './borrowMath'
import type { BorrowChartColours, BorrowSeries } from './borrowMath'

// Series colours: the supply and the debt side keep one hue each. Tokens live on
// .bw-card with a light and a dark step each (validated for CVD separation
// against both surfaces); the status hues (green/amber/red) stay reserved for
// the health-factor zones.
const COLOURS: BorrowChartColours = { supplied: 'var(--bw-sup)', borrowed: 'var(--bw-debt)', healthFactor: 'var(--text-medium)' }

// Aave's own reading of a health factor: below 1 is liquidatable, and the
// Hydration UI turns amber under 1.5.
const HF_ZONES: ChartZone[] = [
  { from: 0, to: 1, label: 'liquidation', color: 'var(--red)' },
  { from: 1, to: 1.5, color: 'var(--amber)' },
]

// The charts draw on an 860-unit viewBox that scales with the card; a phone
// shrinks it ~2.5×, so the narrow layout asks for a taller box and larger axis
// type (see the .bw-hist rules) to land at a readable size.
function useNarrow(): boolean {
  const q = '(max-width: 720px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(q)
    if (!mq) return
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

function LegLine({ label, asset, amount }: { label: string; asset: AssetRef | null; amount: string | null }) {
  if (!asset || amount == null) return null
  return (
    <div className="apx-mark-row">
      <span className="t-k">{label}</span>
      <span className="trade-leg">
        <AssetIcon assetId={asset.assetId} iconAssetId={asset.iconAssetId} iconAssetIds={asset.iconAssetIds} symbol={asset.symbol} size={14} parachainId={asset.parachainId} origin={asset.origin} />
        {' '}<span className="mono">{F.amount(amount, asset.decimals)} {asset.symbol}</span>
      </span>
    </div>
  )
}

// A liquidation as a chart marker (the value chart's liquidation flag): dated at
// its block, sized by the debt the liquidator repaid (else the collateral seized),
// linking to the liquidation's activity page.
function liquidationMarker(l: MoneyMarketLiquidation): ChartMarker {
  const valueUsd = l.debt.valueUsd ?? l.collateral.valueUsd ?? 0
  return {
    ts: l.timestamp,
    kind: 'liquidation',
    label: 'Liquidation',
    valueUsd,
    href: paths.activityDetail('liquidate', `${l.blockHeight}-e${l.eventIndex}`),
    detail: l.collateral.asset ? <span className="mono">{F.amount(l.collateral.amount, l.collateral.asset.decimals)} {l.collateral.asset.symbol} seized</span> : undefined,
    tip: <>
      <div className="apx-mark-row">
        <span className="t-d">{l.timestamp.slice(0, 16)}</span>
        <span className="t-k" style={{ color: 'var(--mk)' }}>Liquidation</span>
        <span className="t-p">{F.usd(valueUsd)}</span>
      </div>
      <LegLine label="Debt repaid" asset={l.debt.asset} amount={l.debt.amount} />
      <LegLine label="Collateral seized" asset={l.collateral.asset} amount={l.collateral.amount} />
    </>,
  }
}

const hfFmt = (v: number) => (v >= HF_CAP - 1e-9 ? `≥${HF_CAP}` : v.toFixed(2))

/** How many zoom windows a card keeps fetched series for. */
const WINDOW_CACHE = 16

/**
 * One market's history inside its card: supplied vs borrowed and the lowest
 * health factor per bucket, with its liquidations flagged — each on the history's
 * own dates, starting where this market's first point does. Before the reserve
 * coverage floor the exposure chart draws the market's own collateral and debt
 * totals as separate dashed lines. Hovering one chart draws a line at the same
 * time on the other, and both share one zoom window (`zoomKey`): a drag, pinch or
 * reset on either lands the other on the same window, which the URL carries.
 */
export function BorrowHistoryCharts({ history, market, address, zoomKey }: { history: MoneyMarketHistory; market: MoneyMarketHistoryMarket; address: string; zoomKey: string }) {
  const s = useMemo(() => marketSeries(history, market), [history, market])
  // Stable identity: the chart's marker clustering memoizes on it.
  const markers = useMemo(() => (market.liquidations ?? []).map(liquidationMarker), [market.liquidations])
  const [syncTime, setSyncTime] = useState<number | null>(null)
  const narrow = useNarrow()
  const h = narrow ? 300 : 100
  const hasHf = s.hf.some(v => v != null)
  const hasChain = s.collateralChain.some(v => v != null) || s.debtChain.some(v => v != null)
  const from = history.reserveHistoryFrom
  const floorIdx = from ? s.dates.findIndex((_, k) => s.supplied[k] != null) : -1
  const floorText = from ? (from.time ? from.time.slice(0, 10) : `block ${F.int(from.blockHeight)}`) : ''
  // Chart-zoom refinement: the same history re-bucketed over the window's block
  // span, on the API's ladder — a week-stepped history refines to days, then to
  // hours, as the window narrows. Both charts share ONE windowed read per window
  // (each takes its own lines from the same fetched series), so a zoom costs one
  // request rather than two and the two grids can never disagree. The cache is a
  // ref touched only from the charts' refine effects, never during render.
  const windows = useRef(new Map<string, Promise<BorrowSeries | null>>())
  const loadWindow = useCallback((fromSec: number, toSec: number): Promise<BorrowSeries | null> => {
    const cache = windows.current
    const key = `${fromSec}:${toSec}`
    const pending = cache.get(key)
    if (pending) return pending
    const range = blockRangeForWindow(history.dates, history.blocks, fromSec, toSec)
    const read: Promise<BorrowSeries | null> = range
      ? positionsApi.moneyMarketHistoryWindow(address, range.fromBlock, range.toBlock).then(w => windowedMarketSeries(w, market.marketKey))
      : Promise.resolve(null)
    cache.set(key, read)
    // A failed read is forgotten, so the next zoom to this window retries it.
    read.catch(() => cache.delete(key))
    if (cache.size > WINDOW_CACHE) cache.delete(cache.keys().next().value as string)
    return read
  }, [history, market.marketKey, address])
  const refineExposure = async (fromSec: number, toSec: number): Promise<RefinedGrid | null> => {
    const w = await loadWindow(fromSec, toSec)
    return w && { buckets: w.dates, series: exposureLines(w, hasChain, COLOURS) }
  }
  const refineHf = async (fromSec: number, toSec: number): Promise<RefinedGrid | null> => {
    const w = await loadWindow(fromSec, toSec)
    return w && { buckets: w.dates, series: healthFactorLines(w, COLOURS) }
  }
  const exposure = exposureLines(s, hasChain, COLOURS)
  return (
    <div className="bw-hist">
      <figure className="bw-chart" data-chart="exposure">
        <figcaption className="bw-chart-head">
          <span className="bw-chart-title">Supplied vs borrowed</span>
          <ChartLegend items={exposure.map(x => ({ label: x.label, color: x.color, dashed: x.dashed }))} />
        </figcaption>
        <MultiLineChart buckets={s.dates} h={h} floorZero yFmt={v => F.usd(v)} markLast markers={markers} series={exposure}
          zoomKey={zoomKey} refine={refineExposure} syncTime={syncTime} onSyncTime={setSyncTime} />
        {hasChain
          ? <p className="bw-chart-note">Before {floorText} the chart shows the market&apos;s own collateral and debt totals (getUserAccountData) as dashed lines; supply not enabled as collateral is not included.</p>
          : floorIdx > 0 && <p className="bw-chart-note">Reserve amounts start {from?.time ? `on ${floorText}` : `at ${floorText}`}; earlier buckets are unknown, not zero.</p>}
      </figure>
      {hasHf && (
        <figure className="bw-chart" data-chart="hf">
          <figcaption className="bw-chart-head">
            <span className="bw-chart-title">Health factor</span>
            <span className="bw-chart-sub">lowest in each bucket{s.hfCapped ? ` · no debt or above ${HF_CAP} drawn at ${HF_CAP}` : ''}{markers.length ? ` · ${markers.length} liquidation${markers.length === 1 ? '' : 's'} flagged` : ''}</span>
          </figcaption>
          <MultiLineChart buckets={s.dates} h={h} floorZero yFmt={hfFmt} zones={HF_ZONES} markLast markers={markers}
            series={healthFactorLines(s, COLOURS)}
            zoomKey={zoomKey} refine={refineHf} syncTime={syncTime} onSyncTime={setSyncTime} />
        </figure>
      )}
    </div>
  )
}
