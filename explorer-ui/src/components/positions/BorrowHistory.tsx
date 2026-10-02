import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssetIcon, F } from '../ui'
import type { ChartMarker } from '../ui'
import { paths } from '../../router'
import { positionsApi } from '../../api/explorer'
import { blockRangeForWindow } from '../../utils/chartRefine'
import { ChartLegend, MultiLineChart } from '../HdxCharts'
import type { FloorZone, RefinedGrid, SecondaryScale } from '../HdxCharts'
import type { AssetRef, MoneyMarketHistory, MoneyMarketHistoryMarket, MoneyMarketLiquidation } from '../../types'
import { HF_CAP, exposureLines, healthFactorLines, marketSeries, windowedMarketSeries } from './borrowMath'
import type { BorrowChartColours, BorrowSeries } from './borrowMath'

// Series colours: the supply and the debt side keep one hue each. Tokens live on
// .bw-card with a light and a dark step each (validated for CVD separation
// against both surfaces); the HF line stays a neutral grey beside them.
const COLOURS: BorrowChartColours = { supplied: 'var(--bw-sup)', borrowed: 'var(--bw-debt)', healthFactor: 'var(--text-medium)' }

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

/**
 * The health factor on its own unlabelled scale beside the USD axis, with 1 — the
 * liquidation threshold — ON the $0 line and HF_CAP (or the data's top) at the
 * plot's top. Read from the tooltip and the newest-point dot.
 */
const HF_SCALE: SecondaryScale = { keys: ['hf'], fmt: hfFmt, anchor: 1, max: HF_CAP }

// Under $0: the liquidation zone. An HF below 1 dips into it on the same scale,
// and the liquidations sit in it rather than over the lines.
const LIQ_ZONE: FloorZone = { frac: 0.13, color: 'var(--red)', label: 'Liquidation' }

/** How many zoom windows a card keeps fetched series for. */
const WINDOW_CACHE = 16

/**
 * One market's history inside its card, as ONE chart: supplied and borrowed USD on
 * the axis and the lowest health factor per bucket on an unlabelled scale of its
 * own (read from the tooltip) whose 1 sits on the $0 line; under it a red strip is
 * the liquidation zone, which an HF below 1 dips into and the liquidations sit in
 * — on the history's own dates (named in the tooltip, not under the plot), starting
 * where this market's first point does. Before the reserve coverage floor the
 * chart draws the market's own collateral and debt totals as separate dashed
 * lines. A position that never owed has no health factor and gets the exposure
 * lines alone, with no zone. The zoom window (`zoomKey`) rides the URL.
 */
export function BorrowHistoryCharts({ history, market, address, zoomKey }: { history: MoneyMarketHistory; market: MoneyMarketHistoryMarket; address: string; zoomKey: string }) {
  const s = useMemo(() => marketSeries(history, market), [history, market])
  // Stable identity: the chart's marker clustering memoizes on it.
  const markers = useMemo(() => (market.liquidations ?? []).map(liquidationMarker), [market.liquidations])
  const narrow = useNarrow()
  const h = narrow ? 420 : 165
  const hasHf = s.hf.some(v => v != null)
  const hasChain = s.collateralChain.some(v => v != null) || s.debtChain.some(v => v != null)
  const from = history.reserveHistoryFrom
  const floorIdx = from ? s.dates.findIndex((_, k) => s.supplied[k] != null) : -1
  const floorText = from ? (from.time ? from.time.slice(0, 10) : `block ${F.int(from.blockHeight)}`) : ''
  // The line set is decided on the BASE series, so a zoom window's grid carries
  // the same keys as the view it refines and the legend stays true of both.
  const lines = (w: BorrowSeries) => [...exposureLines(w, hasChain, COLOURS), ...(hasHf ? healthFactorLines(w, COLOURS) : [])]
  // Chart-zoom refinement: the same history re-bucketed over the window's block
  // span, on the API's ladder — a week-stepped history refines to days, then to
  // hours, as the window narrows. One windowed read per window carries both the
  // USD and the health-factor lines, so the two can never sit on different grids.
  // The cache is a ref touched only from the chart's refine effect, never during
  // render; it keeps a return to a recent window from refetching.
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
  const refine = async (fromSec: number, toSec: number): Promise<RefinedGrid | null> => {
    const w = await loadWindow(fromSec, toSec)
    return w && { buckets: w.dates, series: lines(w) }
  }
  const series = lines(s)
  const notes = [
    hasHf && `Health factor: lowest in each bucket${s.hfCapped ? `, ≥${HF_CAP} or no debt drawn at ${HF_CAP}` : ''}`,
    hasHf && markers.length > 0 && `${markers.length} liquidation${markers.length === 1 ? '' : 's'} flagged`,
    hasChain
      ? `dashed before ${floorText}: the market's own collateral and debt (getUserAccountData; non-collateral supply excluded)`
      : floorIdx > 0 && `reserve amounts start ${from?.time ? `on ${floorText}` : `at ${floorText}`}; earlier buckets are unknown, not zero`,
  ].filter((x): x is string => !!x)
  const note = notes.join(' · ')
  return (
    <div className="bw-hist">
      <figure className="bw-chart" data-chart="history">
        <figcaption className="bw-chart-head">
          <span className="bw-chart-title">{hasHf ? 'Supplied, borrowed & health factor' : 'Supplied vs borrowed'}</span>
          <ChartLegend items={series.map(x => ({ label: x.label, color: x.color, dashed: x.dashed }))} />
        </figcaption>
        <MultiLineChart buckets={s.dates} h={h} floorZero yFmt={v => F.usd(v)} markLast markers={markers} series={series}
          secondary={hasHf ? HF_SCALE : undefined} floorZone={hasHf ? LIQ_ZONE : undefined} hideDates zoomKey={zoomKey} refine={refine} />
        {note && <p className="bw-chart-note">{note.charAt(0).toUpperCase() + note.slice(1)}.</p>}
      </figure>
    </div>
  )
}
