import { F, AreaChart } from './ui'
import { blockRangeForWindow } from '../utils/chartRefine'
import { balanceChartSeries } from '../utils/balanceHistory'
import type { AccountHistoryResponse, AssetBalanceHistory } from '../types'

// The balance-history graph for a single selected asset (the asset selector lives
// in BalancesTreemap). A line chart of the asset's balance over the indexed
// window, with a crosshair tooltip showing the balance + date at the hovered
// point. The series is projected onto the account-wide shared time axis (see
// balanceChartSeries) so switching assets compares the same window.
export function AssetBalanceChart({ selected, all, refineWindow }: {
  selected: AssetBalanceHistory; all: AssetBalanceHistory[]
  /** Chart-zoom refinement: the owner's windowed history loader (block space). */
  refineWindow?: (fromBlock: number, toBlock: number) => Promise<AccountHistoryResponse | null>
}) {
  const cur = selected
  const { series, dates, blocks } = balanceChartSeries(selected, all)
  // Refined zoom window: re-fetch the history over the window's block span and
  // project THIS asset onto the refined shared axis, exactly as the base view does.
  const refine = refineWindow && blocks.length === series.length
    ? async (fromSec: number, toSec: number) => {
      const range = blockRangeForWindow(dates, blocks, fromSec, toSec)
      if (!range) return null
      const w = await refineWindow(range.fromBlock, range.toBlock)
      const row = w?.balanceHistory.find(h => h.asset.assetId === cur.asset.assetId)
      if (!w || !row || row.points.length < 2) return null
      const proj = balanceChartSeries(row, w.balanceHistory)
      return proj.series.length > 1 ? { data: proj.series, dates: proj.dates } : null
    }
    : undefined
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
      <AreaChart key={cur.asset.assetId} data={series} h={200} color="var(--sky)" floor={0} dates={dates} valueFmt={fmtBal} refine={refine} zoomKey="zb" />
    </div>
  )
}
