import { lockColor } from './lockColors'
import type { RevenueStream, StakerPot } from '../types'

// One color and one label per revenue stream, shared by the river, the
// history chart, the breakdown and the legend so a stream reads as the same
// thing everywhere. Colors are theme tokens (they carry their own light/dark
// variants), assigned by BRAND semantics: Omnipool blues for the two Omnipool
// fees (the deep blue is the hub/H2O fee), HOLLAR sage (--hollar, the brand pair from ui.tsx) for HOLLAR interest,
// borrow amber for the reserve factor, red/orange for the liquidation pair,
// HDX pink for network fees (paid to the treasury in HDX terms), lavender for
// the HSM. The palette was validated for adjacent-pair CVD separation in BOTH
// themes in the stack order below.
export const REVENUE_STREAM_COLOR: Record<RevenueStream, string> = {
  omnipool_asset_fee: 'var(--cat-liquidity)',
  omnipool_protocol_fee: 'var(--cat-liquidity-remove)',
  liquidation_penalty: 'var(--red)',
  pepl_liquidation_profit: 'var(--cat-trade)',
  asset_reserve: 'var(--amber)',
  hollar_borrow: 'var(--hollar)',
  hsm_revenue: 'var(--lavender)',
  network_fee: 'var(--accent)',
}

export const REVENUE_STREAM_LABEL: Record<RevenueStream, string> = {
  omnipool_asset_fee: 'Omnipool trade fees',
  omnipool_protocol_fee: 'H2O protocol fee',
  liquidation_penalty: 'Liquidation penalty',
  pepl_liquidation_profit: 'Liquidator profit',
  // The reserve-factor cut of non-HOLLAR borrow interest (the rest pays suppliers).
  asset_reserve: 'Borrow interest share',
  hollar_borrow: 'HOLLAR interest',
  hsm_revenue: 'HSM revenue',
  network_fee: 'Network fees',
}

/**
 * Stacking/legend order, fixed and never cycled. This exact adjacency was
 * validated for colorblind separation (deutan/protan/tritan) against both
 * theme surfaces — reordering it re-opens that check.
 */
export const REVENUE_STREAMS_ORDERED: RevenueStream[] = [
  'network_fee', 'hollar_borrow', 'omnipool_asset_fee', 'pepl_liquidation_profit',
  'omnipool_protocol_fee', 'asset_reserve', 'hsm_revenue', 'liquidation_penalty',
]

// The staker-distribution stack wears the /hdx lock palette (lockColors.ts) —
// the SAME entity keeps the SAME hue on every chart: legacy staking is stake
// violet, the GIGAHDX yield pot wears the GIGAHDX brand black, and voting
// rewards wear vote lavender (they are earned by voting).
export const STAKER_POT_COLOR: Record<StakerPot, string> = {
  staking: lockColor('staking'),
  gigahdx: lockColor('gigahdx'),
  gigarwd: lockColor('vote'),
}

export const STAKER_POT_LABEL: Record<StakerPot, string> = {
  staking: 'Legacy staking',
  gigahdx: 'GIGAHDX yield',
  gigarwd: 'GIGAHDX voting rewards',
}

/** Stacking/legend order: the pots in the order they historically appeared. */
export const STAKER_POTS_ORDERED: StakerPot[] = ['staking', 'gigahdx', 'gigarwd']
