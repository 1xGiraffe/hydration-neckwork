import { F, AreaChart } from './ui'
import { balanceChartSeries } from '../utils/balanceHistory'
import type { AssetBalanceHistory } from '../types'

// The balance-history graph for a single selected asset (the asset selector lives
// in BalancesTreemap). A line chart of the asset's balance over the indexed
// window, with a crosshair tooltip showing the balance + date at the hovered
// point. The series is projected onto the account-wide shared time axis (see
// balanceChartSeries) so switching assets compares the same window.
export function AssetBalanceChart({ selected, all }: { selected: AssetBalanceHistory; all: AssetBalanceHistory[] }) {
  const cur = selected
  const { series, dates } = balanceChartSeries(selected, all)
  // Hover/x-axis value: token balance with the asset's symbol (e.g. "12.3456 HDX").
  const fmtBal = (v: number) => `${F.amount(String(Math.round(v * 10 ** cur.asset.decimals)), cur.asset.decimals)} ${cur.asset.symbol}`
  return (
    <div className="tm-hist">
      <div className="tm-hist-head">
        <span className="tm-metric-label">Balance history</span>
        {cur.availableFrom && <span className="muted mono" style={{ fontSize: 11, marginLeft: 'auto' }}>Indexed from {cur.availableFrom.slice(0, 10)}</span>}
      </div>
      {/* Key by asset so switching assets remounts the chart — clearing any
          crosshair/tooltip left over from hovering the previous asset's chart. */}
      <AreaChart key={cur.asset.assetId} data={series} h={200} color="var(--sky)" floor={0} dates={dates} valueFmt={fmtBal} />
    </div>
  )
}
