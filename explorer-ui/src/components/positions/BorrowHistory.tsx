import { useEffect, useMemo, useState } from 'react'
import { AssetIcon, F } from '../ui'
import type { ChartMarker } from '../ui'
import { paths } from '../../router'
import { ChartLegend, MultiLineChart } from '../HdxCharts'
import type { ChartZone } from '../HdxCharts'
import type { AssetRef, MoneyMarketHistory, MoneyMarketHistoryMarket, MoneyMarketLiquidation } from '../../types'
import { HF_CAP, marketSeries } from './borrowMath'

// Series colours: the supply and the debt side keep one hue each. Tokens live on
// .bw-card with a light and a dark step each (validated for CVD separation
// against both surfaces); the status hues (green/amber/red) stay reserved for
// the health-factor zones.
const SUP = 'var(--bw-sup)', DEBT = 'var(--bw-debt)', HF = 'var(--text-medium)'

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

/**
 * One market's history inside its card: supplied vs borrowed and the lowest
 * health factor per bucket, with its liquidations flagged — each on the history's
 * own dates, starting where this market's first point does. Before the reserve
 * coverage floor the exposure chart draws the market's own collateral and debt
 * totals as separate dashed lines. Hovering one chart draws a line at the same
 * time on the other.
 */
export function BorrowHistoryCharts({ history, market }: { history: MoneyMarketHistory; market: MoneyMarketHistoryMarket }) {
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
  const exposure = [
    { key: 'sup', label: 'Supplied', color: SUP, values: s.supplied },
    { key: 'debt', label: 'Borrowed', color: DEBT, values: s.borrowed },
    ...(hasChain ? [
      { key: 'colChain', label: 'Collateral (chain)', color: SUP, values: s.collateralChain, dashed: true },
      { key: 'debtChain', label: 'Debt (chain)', color: DEBT, values: s.debtChain, dashed: true },
    ] : []),
  ]
  return (
    <div className="bw-hist">
      <figure className="bw-chart" data-chart="exposure">
        <figcaption className="bw-chart-head">
          <span className="bw-chart-title">Supplied vs borrowed</span>
          <ChartLegend items={exposure.map(x => ({ label: x.label, color: x.color, dashed: x.dashed }))} />
        </figcaption>
        <MultiLineChart buckets={s.dates} h={h} floorZero yFmt={v => F.usd(v)} markLast markers={markers} series={exposure}
          syncTime={syncTime} onSyncTime={setSyncTime} />
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
            series={[{ key: 'hf', label: 'Lowest health factor', color: HF, values: s.hf }]}
            syncTime={syncTime} onSyncTime={setSyncTime} />
        </figure>
      )}
    </div>
  )
}
