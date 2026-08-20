import type { ActivityRevenue } from '../types'
import { F } from './ui'

// The <dt>/<dd> pair for protocol revenue, shared by every activity detail surface.
//
// The field is absent — not zero — for an extrinsic the revenue derivation has not
// reached yet (it trails the chain head by ~1k blocks), so the caller renders
// nothing at all rather than claiming $0.00. `lpUsd` rides along because on a
// routed trade the LP half is often the larger one, and the per-stream line shows
// where the protocol's share actually came from.
export function RevenueRow({ revenue }: { revenue: ActivityRevenue | undefined }) {
  if (!revenue) return null
  return <>
    <div className="dt" title="Protocol revenue this extrinsic generated">Protocol revenue</div>
    <div className="dd mono">
      {F.usd(revenue.protocolUsd)}
      {revenue.lpUsd > 0 && <span className="muted"> · {F.usd(revenue.lpUsd)} to LPs</span>}
      {revenue.streams.length > 0 && (
        <div className="muted revenue-streams">
          {revenue.streams.map(s => `${s.stream} ${F.usd(s.usd)}`).join(' · ')}
        </div>
      )}
    </div>
  </>
}
